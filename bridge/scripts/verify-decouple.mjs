// 平台解耦（dsh-decouple）验证：桥接是纯 QQ 适配器，唯一上游是 agent-gateway。
//
// 与 `verify:adaptation` 的分工：
//   · verify:adaptation 验「DSH 本身 + preset/守卫」，需要运行中的 DSH（已随 DSH 直连退役）；
//   · 本脚本验「桥接链路」，**默认离线可跑**（静态契约 + 文件系统断言），
//     只有 config.json 里 gateway 段齐全时才追加活体探测。
//
// 用法：
//   node scripts/verify-decouple.mjs            # 静态 + （能连上就）活体
//   GATEWAY_URL=... node scripts/verify-decouple.mjs
//
// 退出码：0 = 全部通过（跳过不算失败）；1 = 有失败项。
// 2026-11-23 monorepo 整合（M5）：① ROOT 由 cwd 改 import.meta.url 推导（脚本可在任意 cwd 执行）；
// ② 网关平级路径 GATEWAY_REPO env 可配 + 缺失时显式告警；③ dsh/ 断言改为内容形状（dsh/ 现为 preset 源码）；
// ④ 新增 R1 断言：bridge/src 全量无 driver/ 引用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // bridge/
const results = [];
let pass = 0;
let fail = 0;

function check(label, cond, extra = '') {
  if (cond) { pass += 1; results.push(`✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; results.push(`❌ ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
}
function skip(label, why) {
  results.push(`⏭ ${label} — ${why}`);
  return false;
}

function read(relPath) {
  const file = path.join(ROOT, relPath);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

// ── 1. 桥接侧静态契约（不依赖任何进程） ─────────────────────────────────────
const bridgeSrc = read('src/bridge.js') ?? '';
const consoleHtml = read('public/console.html') ?? '';

check('bridge.js 存在', bridgeSrc.length > 0);
check('网关配置必填并 fail-fast（缺 url/secret/adapterId 即退出）',
  bridgeSrc.includes('assertGatewayConfig') && /url.*secret.*adapterId|adapterId.*secret|secret[\s\S]{0,120}adapterId/.test(bridgeSrc));
check('无 DSH 直连（桥接零引用 dsh-client）', !bridgeSrc.includes('dsh-client'));
check('无模式概念（chat/closed-agent/reserved/reserved2 已退役）',
  !bridgeSrc.includes('currentMode') && !bridgeSrc.includes('modeAllowed') && !fs.existsSync(path.join(ROOT, 'state', 'mode.json')));
check('真实消息走网关入站（POST /v1/inbound）',
  bridgeSrc.includes('deliverInboundViaGateway') && bridgeSrc.includes('/v1/inbound'));
check('唤醒走网关信封（deliverViaGateway + wakeSnapshot）',
  bridgeSrc.includes('deliverViaGateway') && bridgeSrc.includes('buildWakeSnapshotV2'));
check('无本地 DSH 会话/prompt 提交（ensureSession / selectModel 调用零引用）',
  !/\bensureSession\(/.test(bridgeSrc) && !/\bselectModel\(/.test(bridgeSrc));
check('白名单由网关裁决（routed:false → 失败）', bridgeSrc.includes('白名单未命中'));
check('动作面只剩 QQ 能力（清单无 memory/搜索/工具执行）',
  !/memory_|web_search|web_fetch|code_search|execute_command/.test(read('src/gateway/actions-manifest.json') ?? '[]'));
check('safe-fetch 已迁入 src/media/（SSRF 校验服务媒体链路）',
  fs.existsSync(path.join(ROOT, 'src', 'media', 'safe-fetch.js')));
check('无自带 MCP（src/mcp 已删除）', !fs.existsSync(path.join(ROOT, 'src', 'mcp')));
check('dsh/ 仅含 preset 源码（bundle/ 工具组放行；bundle 外无可执行实现）', (() => {
  const dshDir = path.join(ROOT, 'dsh');
  if (!fs.existsSync(dshDir)) return true; // 不存在更干净
  const stack = [dshDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'bundle') stack.push(path.join(dir, e.name)); continue; }
      // bundle/ 内的 .mjs 是 preset 工具组（qq-tool-restrict 等），由 DSH 加载——合法
      if (!dir.includes(`${path.sep}bundle`) && /\.(mjs|cjs|node|exe|bat|cmd)$/.test(e.name)) return false;
    }
  }
  return true;
})());
check('无本地 plugins/ 目录（插件化已退役）', !fs.existsSync(path.join(ROOT, 'plugins')));
check('R1：bridge/src 全量无 driver/ 引用（驱动层 vendor 隔离）', (() => {
  const srcDir = path.join(ROOT, 'src');
  const stack = [srcDir];
  const offenders = [];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/\.(mjs|js)$/.test(e.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (/['"\/\\]driver[\/\\]|@snowluma\/runtime/.test(text)) offenders.push(path.relative(ROOT, full));
      }
    }
  }
  if (offenders.length) { console.error('  R1 违规文件: ' + offenders.join(', ')); return false; }
  return true;
})());
check('控制台连接状态改看网关（gateway.ready 为唯一连通信号）',
  consoleHtml.includes('status.gateway && status.gateway.ready') && !consoleHtml.includes('status.dshReady'));

// ── 2. 网关侧静态契约（GATEWAY_REPO env 可配；缺失时显式告警而非静默 skip） ──
const gatewayRoot = process.env.GATEWAY_REPO
  ?? path.join(ROOT, '..', '..', 'agent-gateway'); // monorepo 后：<repo>/bridge → 上两级 = 平级
const gatewayServerPath = path.join(gatewayRoot, 'src', 'core', 'server.mjs');
const gatewayRunnerPath = path.join(gatewayRoot, 'src', 'runtime', 'turn-runner.mjs');
if (fs.existsSync(gatewayServerPath) && fs.existsSync(gatewayRunnerPath)) {
  const runner = fs.readFileSync(gatewayRunnerPath, 'utf8');
  check('网关不再自动投递回合文本（无 GATEWAY_DELIVERY / auto-text）',
    !/GATEWAY_DELIVERY|auto-text|deliveryActions/.test(runner));
  check('platform-actions 执行器已删除',
    !fs.existsSync(path.join(gatewayRoot, 'src', 'executors', 'platform-actions.mjs')));
  check('投递动作归 adapter-tools（catalog 不再过滤）',
    !fs.readFileSync(path.join(gatewayRoot, 'src', 'executors', 'adapter-tools', 'common', 'catalog.mjs'), 'utf8').includes('DELIVERY_ACTIONS'));
} else {
  console.error(`⚠ 显式告警：网关平级仓库未找到（GATEWAY_REPO=${process.env.GATEWAY_REPO ?? '(未设置)'}，推导=${gatewayRoot}）——网关侧解耦契约本次未验证（仅验桥接侧）。如需验证请设置 GATEWAY_REPO 指向 agent-gateway 仓库根。`);
  skip('网关侧解耦契约', `网关仓库不存在（${gatewayRoot}）——显式告警已输出`);
}

// ── 3. 活体探测（可选）：网关可达才跑，连不上记为跳过而不是失败 ─────────────
const cfgPath = path.join(ROOT, 'config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { cfg = {}; }
const g = cfg.gateway ?? {};
const baseUrl = String(process.env.GATEWAY_URL ?? g.url ?? 'http://127.0.0.1:7190');
const secret = String(g.secret ?? '');

if (!g.url || !secret) {
  skip('活体探测（/v1/health）', 'config.gateway 缺 url/secret（桥接启动会直接 fail-fast）');
} else {
  const { createGatewayClient } = await import(pathToFileURL(path.join(ROOT, 'src', 'gateway', 'gateway-client.js')).href);
  const client = createGatewayClient({
    baseUrl,
    adapterId: g.adapterId ?? 'qq-main',
    platform: 'qq',
    secret,
    logger: () => {},
  });
  const health = await client.health();
  if (!health.ok) {
    skip('活体探测', `网关 ${baseUrl} 不可达：${health.error ?? health.code ?? 'unknown'}`);
  } else {
    check('网关健康检查可达', health.ok === true, baseUrl);
  }
}

// ── 输出 ───────────────────────────────────────────────────────────────────
console.log('\n=== verify:decouple（桥接只连网关）===\n');
for (const line of results) console.log(line);
console.log(`\n通过 ${pass}，失败 ${fail}，跳过 ${results.filter((r) => r.startsWith('⏭')).length}`);
console.log(fail === 0
  ? '\n✅ 解耦契约成立：入站/唤醒 → /v1/inbound，发送 → /v1/actions，动作面 = QQ 能力'
  : '\n❌ 解耦契约被破坏，见上方失败项');
process.exit(fail === 0 ? 0 : 1);
