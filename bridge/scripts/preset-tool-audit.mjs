#!/usr/bin/env node
/**
 * preset-tool-audit —— 用**运行时诊断**对账「全局工具 vs restrict 名单」。
 *
 * 为什么不去扫 node_modules：那既慢又脆（实测会让 shell 卡死十几分钟），而且静态扫描
 * 根本拿不到运行时注入的 `dev_*`。DSH 的 restrict 报错里本来就会回显权威清单：
 *     tools.restrict() names unknown global tool "x"; known global tools: a, b, c
 * 守卫把这份清单原样写进 `<DSH_HOME>/state/tool-restrict.log`，本脚本只读它。
 *
 * 用法：
 *   node scripts/preset-tool-audit.mjs                  # 读默认诊断文件
 *   node scripts/preset-tool-audit.mjs --log <path>      # 指定诊断文件
 *   node scripts/preset-tool-audit.mjs --names "a,b,c"   # 直接给清单（CI / 无 DSH）
 *   node scripts/preset-tool-audit.mjs --json            # 机器可读
 *
 * 退出码：
 *   0 = 没有 uncovered（或压根没有权威清单可对账，例如还没跑过会话）
 *   1 = 有 uncovered（全局层出现了名单没覆盖的工具，需要人工判定「挡还是放」）
 *
 * 边界：只读文件，不写任何东西，也不遍历 node_modules。
 */
import fs from 'node:fs';
import process from 'node:process';

const {
  RESTRICTED_TOOL_NAMES,
  CRITICAL_GLOBAL_TOOL_NAMES,
  isExplicitlyAllowed,
} = await import(new URL('../dsh/qq/bundle/qq-tool-restrict.mjs', import.meta.url).href);
const { resolveDshHome } = await import(new URL('./lib/dsh-bundle.mjs', import.meta.url).href);

/** @returns {{log?: string, names?: string, json: boolean, help: boolean}} */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') { args.json = true; continue; }
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (token === '--log' || token === '--names') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--') || value.trim() === '') {
        throw new Error(`missing value for ${token}`);
      }
      args[token.slice(2)] = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

/**
 * 从诊断文本里取**最近一次**的权威全局工具清单。
 *
 * 支持两种行（新版汇总行 + 旧版失败行）：
 *   `… known global tools(4): a, b, c`
 *   `… known global tools: a, b, c`
 * @returns {{names: string[], source: string|null}}
 */
export function parseKnownGlobalToolsFromLog(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const matched = /known global tools(?:\(\d+\))?:\s*(.+)$/i.exec(line);
    if (!matched) continue;
    const names = matched[1]
      .split(',')
      .map((name) => name.trim())
      .filter((name) => /^[A-Za-z0-9_.:-]+$/.test(name));
    if (names.length > 0) return { names, source: line.trim() };
  }
  return { names: [], source: null };
}

/** 取最近一次汇总行（`restrict hidden=… skipped=… missing=… failed=…`）。 */
export function parseLatestSummary(text) {
  const matched = [...String(text ?? '').matchAll(
    /restrict hidden=(\d+) skipped=(\d+) missing=(\d+) failed=(\d+)/g,
  )].pop();
  if (!matched) return null;
  return {
    hidden: Number(matched[1]),
    skipped: Number(matched[2]),
    missing: Number(matched[3]),
    failed: Number(matched[4]),
  };
}

/**
 * 对账核心（纯函数）。
 *
 * 分类：
 *   - covered：在 restrict 名单里（会被隐藏）
 *   - explicitlyAllowed：被守卫白名单**刻意**放行的（如 `mcp__agent-gateway__*`）——
 *     它们出现在全局层是设计如此，不算 uncovered，但要列出来让人看见
 *   - uncovered：既没挡也没放行 ⇒ 唯一需要人工判定的类别
 *
 * @param {{
 *   knownNames: string[],
 *   restricted?: readonly string[],
 *   critical?: readonly string[],
 *   allow?: (name: string) => boolean,
 * }} input
 */
export function auditNames({
  knownNames,
  restricted = RESTRICTED_TOOL_NAMES,
  critical = CRITICAL_GLOBAL_TOOL_NAMES,
  allow = isExplicitlyAllowed,
}) {
  const known = [...new Set(knownNames.map((name) => String(name).trim()).filter(Boolean))].sort();
  const limit = new Set(restricted);
  const covered = known.filter((name) => limit.has(name));
  const explicitlyAllowed = known.filter((name) => !limit.has(name) && allow(name));
  const uncovered = known.filter((name) => !limit.has(name) && !allow(name));
  const missingCritical = [...critical].filter((name) => !known.includes(name));
  return { known, covered, explicitlyAllowed, uncovered, missingCritical };
}

function printHelp() {
  console.log([
    'preset-tool-audit —— 用运行时诊断对账全局工具与 restrict 名单（不扫 node_modules）',
    '',
    '用法：',
    '  node scripts/preset-tool-audit.mjs [--log <path>] [--names "a,b,c"] [--json]',
    '',
    '默认日志：<DSH_HOME>/state/tool-restrict.log（可用 DSH_HOME 覆盖）',
    '退出码：0 = 无 uncovered；1 = 有 uncovered；无权威清单时也算 0。',
  ].join('\n'));
}

function main() {
  let args;
  try {
    args = parseArgs();
  } catch (error) {
    console.error(`[tool-audit] 参数错误：${error?.message ?? error}`);
    return 2;
  }
  if (args.help) { printHelp(); return 0; }

  const logFile = args.log ?? `${resolveDshHome()}/state/tool-restrict.log`;
  let text = '';
  let summary = null;
  let known = [];
  let source = null;

  if (args.names) {
    known = args.names.split(',').map((name) => name.trim()).filter(Boolean);
    source = '--names';
  } else {
    try {
      text = fs.readFileSync(logFile, 'utf8');
    } catch {
      if (args.json) {
        console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no-diagnostics', logFile }, null, 2));
      } else {
        console.log(`[tool-audit] 没有诊断文件：${logFile}`);
        console.log('[tool-audit] 先让 DSH 跑一次会话（restrict 会把权威清单写进去），或用 --names 直接给清单。');
      }
      return 0;
    }
    const parsed = parseKnownGlobalToolsFromLog(text);
    known = parsed.names;
    source = parsed.source;
    summary = parseLatestSummary(text);
  }

  if (known.length === 0) {
    if (args.json) {
      console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no-known-global-tools', logFile }, null, 2));
    } else {
      console.log(`[tool-audit] 诊断里没有权威全局工具清单（${logFile}）——说明还没有一次「未知名字」的 restrict 失败。`);
      console.log('[tool-audit] 这通常意味着名单里的名字全部命中或全部不存在，无需处理。');
    }
    return 0;
  }

  const result = auditNames({ knownNames: known });
  const ok = result.uncovered.length === 0;

  if (args.json) {
    console.log(JSON.stringify({
      ok, logFile, source, summary: summary ?? null, ...result,
    }, null, 2));
  } else {
    console.log(`[tool-audit] 清单来源：${source}`);
    if (summary) {
      console.log(`[tool-audit] 最近一次守卫汇总：hidden=${summary.hidden} skipped=${summary.skipped}`
        + ` missing=${summary.missing} failed=${summary.failed}`);
    }
    console.log(`[tool-audit] 全局层 ${result.known.length} 个：${result.known.join(', ')}`);
    console.log(`[tool-audit] 已被名单覆盖 ${result.covered.length} 个`);
    if (result.explicitlyAllowed.length > 0) {
      console.log(`[tool-audit] 白名单放行（有意可见）${result.explicitlyAllowed.length} 个：`
        + result.explicitlyAllowed.join(', '));
    }
    if (result.missingCritical.length > 0) {
      console.log(`[tool-audit] ⚠️ 关键工具缺失（可能已改名）：${result.missingCritical.join(', ')}`);
    }
    if (result.uncovered.length > 0) {
      console.log(`[tool-audit] ✖ 未覆盖 ${result.uncovered.length} 个：${result.uncovered.join(', ')}`);
      console.log('[tool-audit] 请在 dsh/qq/bundle/qq-tool-restrict.mjs 里判定：');
      console.log('           - 危险（本地执行/装载/跨会话读取）→ 加进 REGRESSION_NET_TOOL_NAMES');
      console.log('           - 无害（纯模型侧）→ 加进 SAFE_EXACT 或保持放行（当前 guard 会拒绝，需确认）');
    } else {
      console.log('[tool-audit] ✔ 无 uncovered');
    }
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('preset-tool-audit.mjs')) {
  process.exitCode = main();
}
