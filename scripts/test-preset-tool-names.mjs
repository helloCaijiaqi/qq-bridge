#!/usr/bin/env node
/**
 * qq-tool-restrict 的名单与探测逻辑单测（**不依赖 DSH 进程、不扫描 node_modules**）。
 *
 * 覆盖三类容易回归的点：
 *   1) 名单结构：三层分组互不相交、并集与导出视图一致、没有拼错的假名；
 *   2) 分类逻辑：`unknown global tool` 必须算「跳过」而不是「失败」——
 *      这是本轮改造的核心，判错就会退回「每会话 78 条报警」的老状态；
 *   3) 对账：日志解析 + uncovered 计算（全局层有、名单没覆盖 ⇒ 需要人工判定）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CRITICAL_GLOBAL_TOOL_NAMES,
  REGRESSION_NET_TOOL_NAMES,
  RESTRICT_TIERS,
  RESTRICTED_TOOL_NAMES,
  RUNTIME_INJECTED_TOOL_NAMES,
  formatRestrictSummary,
  isUnknownToolError,
  parseKnownGlobalTools,
  runRestrictPlan,
} from '../dsh/qq/bundle/qq-tool-restrict.mjs';

import {
  auditNames,
  parseKnownGlobalToolsFromLog,
  parseLatestSummary,
} from './preset-tool-audit.mjs';

/** DSH 真实报错（2026-11-16 从 state/tool-restrict.log 抄的原文）。 */
const DSH_UNKNOWN_SAMPLE = 'tools.restrict() names unknown global tool "pwsh"; '
  + 'known global tools: list_mcp_resource_templates, list_mcp_resources, read_mcp_resource, working_directory';

test('名单：三层非空、两两不相交、无重复', () => {
  const groups = [
    ['critical', CRITICAL_GLOBAL_TOOL_NAMES],
    ['injected', RUNTIME_INJECTED_TOOL_NAMES],
    ['net', REGRESSION_NET_TOOL_NAMES],
  ];
  for (const [label, names] of groups) {
    assert.ok(names.length > 0, `${label} 层不能为空`);
    assert.equal(new Set(names).size, names.length, `${label} 层内部不得重复`);
  }
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      const shared = groups[i][1].filter((name) => groups[j][1].includes(name));
      assert.deepEqual(shared, [], `${groups[i][0]} 与 ${groups[j][0]} 不得重叠：${shared.join(',')}`);
    }
  }
});

test('名单：RESTRICTED_TOOL_NAMES 等于三层并集（顺序也一致，防导出漂移）', () => {
  const union = RESTRICT_TIERS.flatMap(({ names }) => names);
  assert.deepEqual(RESTRICTED_TOOL_NAMES, union);
  assert.equal(new Set(union).size, union.length, '三层并集本身必须无重复');
  assert.equal(RESTRICT_TIERS.length, 3);
  assert.deepEqual(RESTRICT_TIERS.map((t) => t.tier), ['critical', 'injected', 'net']);
});

test('名单：名字必须是合法工具标识符（防手滑写成带空格/横线的假名）', () => {
  for (const name of RESTRICTED_TOOL_NAMES) {
    assert.match(name, /^[A-Za-z0-9_]+$/, `非法工具名：${name}`);
  }
});

test('名单：不含历史拼写假名（这些曾让 DSH 报 unknown global tool）', () => {
  const fakeNames = [
    'pwsh_persistent',
    'bash_persistent',
    'cordis',
    'cordis_define',
    'cordis_undefine',
    'goal_write',
    'goal_read',
    'tool_disable',
  ];
  const present = fakeNames.filter((name) => RESTRICTED_TOOL_NAMES.includes(name));
  assert.deepEqual(present, [], `名单里出现假名：${present.join(', ')}`);
});

test('isUnknownToolError：只认「名字不在全局层」，别的错误必须当失败', () => {
  assert.equal(isUnknownToolError(DSH_UNKNOWN_SAMPLE), true);
  assert.equal(isUnknownToolError('tools.restrict() names unknown global tool "read"'), true);
  // 下面这些是真问题，不能被当成「跳过」静默掉
  assert.equal(isUnknownToolError('tools.restrict() requires a scoped context (agent.ctx)'), false);
  assert.equal(isUnknownToolError('tools.restrict() filter is a no-op (neither allow nor deny given)'), false);
  assert.equal(isUnknownToolError('cannot name reserved PTC transport tool "run_code"'), false);
  assert.equal(isUnknownToolError(undefined), false);
});

test('parseKnownGlobalTools：从 DSH 报错里抠出权威清单', () => {
  assert.deepEqual(parseKnownGlobalTools(DSH_UNKNOWN_SAMPLE), [
    'list_mcp_resource_templates',
    'list_mcp_resources',
    'read_mcp_resource',
    'working_directory',
  ]);
  assert.deepEqual(parseKnownGlobalTools('some other error'), []);
  assert.deepEqual(parseKnownGlobalTools(''), []);
});

test('runRestrictPlan：unknown → skipped；critical 缺失 → missing；其它异常 → failed', () => {
  const plan = {
    tiers: [
      { tier: 'critical', names: ['read_mcp_resource', 'working_directory'] },
      { tier: 'injected', names: ['dev_inject_plugin'] },
      { tier: 'net', names: ['pwsh', 'purge_apply'] },
    ],
    restrict: (name) => {
      if (name === 'read_mcp_resource') return; // 挡成功
      if (name === 'working_directory') throw new Error(DSH_UNKNOWN_SAMPLE); // 关键工具缺失
      if (name === 'purge_apply') throw new Error('tools.restrict() requires a scoped context (agent.ctx)');
      // 其余一律 unknown（注入器没启用、回归网没被触发）
      throw new Error(`tools.restrict() names unknown global tool "${name}"`);
    },
  };
  const result = runRestrictPlan(plan);

  assert.deepEqual(result.hidden, ['read_mcp_resource']);
  assert.deepEqual(result.missingCritical, ['working_directory']);
  assert.deepEqual(result.skipped.map((s) => s.name), ['working_directory', 'dev_inject_plugin', 'pwsh']);
  assert.deepEqual(result.failed.map((f) => f.name), ['purge_apply']);
  assert.equal(result.failed[0].message.includes('scoped context'), true);
  // 报错里带了 known global tools ⇒ 顺带把权威清单带出来（给诊断/审计用）
  assert.deepEqual(result.knownGlobal, [
    'list_mcp_resource_templates',
    'list_mcp_resources',
    'read_mcp_resource',
    'working_directory',
  ]);
});

test('runRestrictPlan：全部命中时 knownGlobal 为空、failed 为空', () => {
  const result = runRestrictPlan({
    tiers: [{ tier: 'critical', names: ['a', 'b'] }],
    restrict: () => {},
  });
  assert.deepEqual(result.hidden, ['a', 'b']);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.missingCritical, []);
  assert.deepEqual(result.knownGlobal, []);
});

test('formatRestrictSummary：格式必须能被审计脚本正则解析', () => {
  const line = formatRestrictSummary({
    hidden: ['a'], skipped: [{ name: 'b' }, { name: 'c' }], missingCritical: [], failed: [],
  });
  assert.equal(line, 'restrict hidden=1 skipped=2 missing=0 failed=0');
  assert.equal(parseLatestSummary(line).skipped, 2);
});

test('审计：uncovered / covered / 白名单放行 三分类', () => {
  const result = auditNames({
    knownNames: ['read_mcp_resource', 'working_directory', 'brand_new_tool', 'read_mcp_resource'],
    restricted: ['read_mcp_resource', 'pwsh'],
    critical: ['read_mcp_resource', 'working_directory'],
  });
  assert.deepEqual(result.known, ['brand_new_tool', 'read_mcp_resource', 'working_directory']);
  assert.deepEqual(result.covered, ['read_mcp_resource']);
  assert.deepEqual(result.explicitlyAllowed, []);
  // working_directory 不在传入的 restricted 里 ⇒ 也是 uncovered（本用例故意的裁剪名单）
  assert.deepEqual(result.uncovered, ['brand_new_tool', 'working_directory']);
  assert.deepEqual(result.missingCritical, []);
});

test('审计：守卫白名单放行的名字不算 uncovered（gateway MCP 工具确实在全局层）', () => {
  const result = auditNames({
    knownNames: [
      'mcp__agent-gateway__chat_qq_approve',
      'read_mcp_resource',
      'ask_user_question',
    ],
  });
  assert.deepEqual(result.explicitlyAllowed, ['ask_user_question', 'mcp__agent-gateway__chat_qq_approve']);
  assert.deepEqual(result.covered, ['read_mcp_resource']);
  assert.deepEqual(result.uncovered, [], '放行项与已挡项之外没有别的名字');
});

test('审计：关键工具缺失会被单独指出（不影响 uncovered 判定）', () => {
  const result = auditNames({ knownNames: ['read_mcp_resource'] });
  assert.deepEqual(result.missingCritical, ['list_mcp_resources', 'list_mcp_resource_templates', 'working_directory']);
});

test('审计：日志解析（新版汇总行 + 旧版失败行）', () => {
  const modern = [
    '2026-11-16T01:00:00.000Z restrict hidden=4 skipped=79 missing=0 failed=0',
    '2026-11-16T01:00:00.000Z known global tools(4): read_mcp_resource, working_directory, purge_apply, purge_revert',
  ].join('\n');
  const parsedModern = parseKnownGlobalToolsFromLog(modern);
  assert.deepEqual(parsedModern.names, ['read_mcp_resource', 'working_directory', 'purge_apply', 'purge_revert']);
  assert.equal(parseLatestSummary(modern).hidden, 4);

  const legacy = '2026-11-16T07:49:46.679Z restrict ok=4 failed=78 原因: '
    + 'tools.restrict() names unknown global tool "pwsh"; known global tools: a, b, c';
  assert.deepEqual(parseKnownGlobalToolsFromLog(legacy).names, ['a', 'b', 'c']);
  assert.equal(parseLatestSummary(legacy), null, '旧格式没有 hidden= 汇总，应为 null');

  assert.deepEqual(parseKnownGlobalToolsFromLog('').names, []);
  assert.deepEqual(parseKnownGlobalToolsFromLog(undefined).names, []);
});

test('审计：真实诊断文件存在时不得有 uncovered（无 DSH 环境则跳过）', (t) => {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const logFile = path.join(home, 'state', 'tool-restrict.log');
  if (!fs.existsSync(logFile)) {
    t.skip('本机没有 tool-restrict.log（无 DSH 运行痕迹）');
    return;
  }
  const { names } = parseKnownGlobalToolsFromLog(fs.readFileSync(logFile, 'utf8'));
  if (names.length === 0) {
    t.skip('诊断里还没有权威全局工具清单');
    return;
  }
  const result = auditNames({ knownNames: names });
  assert.deepEqual(result.uncovered, [], `全局层出现未覆盖工具：${result.uncovered.join(', ')}`);
});
