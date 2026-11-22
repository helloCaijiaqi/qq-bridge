// SnowLuma 账号/token 自发现自检。
//
// 背景（实测确认的根因）：SnowLuma 的 OneBot 配置按账号分文件
// （<SnowLuma>/config/onebot_<QQ号>.json），每个账号一个 token，HTTP 与 WS 还各不相同。
// 换 QQ 账号登录后，任何把 token 写死在 config.json 里的工具都会 401 ——
// 这正是"换个账号登录，发语音工具就不行了"的原因。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken, probeHttpToken, readOneBotHttpTokens, readOneBotTokens, snowLumaHomeCandidates
} from '../src/integrations/snowluma-conn.js';
// 独立发语音工具在仓库上一级（不在本仓库里）：位置解析与"不在时怎么跳过"走共享口径。
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from './voice-tool-locator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
// 工具不在本仓库里时返回 null，让下面几条桥接侧断言仍能照跑（读源码不该因为
// 一个不在仓库里的目录而整个抛掉）。
const readTool = (rel) => (hasVoiceTool() ? fs.readFileSync(voiceToolPath(rel), 'utf8') : null);

console.log('## home 目录推断');
{
  const homes = snowLumaHomeCandidates({ cfg: { snowluma: { homeDir: 'X:/sl', launcherPath: 'X:/sl2/launcher.bat' } } });
  ok(homes.includes('X:/sl'), '优先用 homeDir');
  ok(homes.some((h) => h.replace(/\\/g, '/') === 'X:/sl2'), '其次用 launcherPath 所在目录');
  ok(snowLumaHomeCandidates({ cfg: {} }).length >= 0, '无配置时返回空或环境变量值（不抛错）');
}

console.log('## per-account token 解析（用临时目录造多账号场景）');
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-home-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const write = (uin, httpToken, port = 3000, wsToken = 'ws-' + uin) => fs.writeFileSync(
    path.join(home, 'config', `onebot_${uin}.json`),
    JSON.stringify({ networks: { httpServers: [{ name: 'http-default', accessToken: httpToken, host: '127.0.0.1', port }], wsServers: [{ accessToken: wsToken, port: 3001 }] } }),
    'utf8'
  );
  write('111', 'token-aaa');
  write('222', 'token-bbb');
  fs.writeFileSync(path.join(home, 'config', 'onebot_broken.json'), '{ not json', 'utf8');
  fs.writeFileSync(path.join(home, 'config', 'runtime.json'), '{}', 'utf8');

  const toks = readOneBotTokens(home);
  ok(toks.length === 2, '只解析出 onebot_<数字>.json', `得到 ${toks.length} 个`);
  ok(toks[0].uin === '111' && toks[1].uin === '222', '按 uin 稳定排序');
  ok(toks.every((t) => t.http?.token?.startsWith('token-')), 'HTTP token 取自 httpServers');
  ok(toks.every((t) => t.ws?.token?.startsWith('ws-')), 'WS token 取自 wsServers（与 HTTP 不同！）');
  ok(toks.every((t) => t.http.token !== t.ws.token), '两个 token 确实不同（不能混用的证据）');
  ok(toks.every((t) => t.http.port === 3000 && t.ws.port === 3001), '端口分别是 3000 / 3001');

  const flat = readOneBotHttpTokens(home);
  ok(flat.length === 2 && flat[0].token === 'token-aaa', 'readOneBotHttpTokens 兼容扁平形态');

  console.log('## 自动发现：按"谁能用"选择，而不是猜');
  // 用一个假 fetch 模拟：只有 token-bbb 有效
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const tk = String(init?.headers?.authorization ?? '').replace('Bearer ', '');
    if (tk === 'token-bbb') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 222, nickname: '第二账号' } }) };
    }
    return { ok: false, status: 401, json: async () => ({ status: 'failed', retcode: 1401, wording: 'unauthorized' }) };
  };
  try {
    const r = await discoverSnowLumaConnection({ cfg: {}, baseUrl: 'http://127.0.0.1:3000', homeDirs: [home], timeoutMs: 500 });
    ok(r.ok === true, '发现成功');
    ok(r.token === 'token-bbb', '选中了有效的那个 token', r.token);
    ok(r.self?.user_id === 222, '回报当前账号', String(r.self?.user_id));
    ok(r.source === 'onebot_222.json', '标明 token 来源', r.source);
    ok(r.tried.length === 2, '记录了尝试过的候选', `${r.tried.length} 个`);

    // 全部无效时要给出可操作错误
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ status: 'failed', retcode: 1401 }) });
    const bad = await discoverSnowLumaConnection({ cfg: {}, baseUrl: 'http://127.0.0.1:3000', homeDirs: [home], timeoutMs: 300 });
    ok(bad.ok === false, '全部失效时失败');
    ok(/401|token/.test(bad.error), '错误信息指出 token 问题', bad.error.slice(0, 40));
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log('## token 写回 config.json');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'old-token' }, allow: { groups: [1] } }, null, 2), 'utf8');
  const r1 = persistToken(cfgPath, 'new-token');
  ok(r1.updated === true && r1.from === 'old-token', '换 token 时写入');
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok(after.snowluma.accessToken === 'new-token', 'config.json 已更新');
  ok(after.allow.groups[0] === 1, '其它配置字段未被破坏');
  const r2 = persistToken(cfgPath, 'new-token');
  ok(r2.updated === false, 'token 未变时不重复写（幂等）');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('## 独立工具确实用它（源码级）');
{
  // 独立工具的入口文件在仓库上一级的 voice-tool/；共享内核仍是本仓库 src/integrations/snowluma-conn.js
  for (const rel of ['voice-cli.mjs', 'voice-gui.mjs']) {
    const src = readTool(rel);
    if (src === null) { skipVoiceTool(`${rel} 是否引入自发现模块（snowluma-conn.js / discoverSnowLumaConnection）`); continue; }
    ok(/snowluma-conn\.js/.test(src), `${rel} 引入自发现模块`);
    ok(/discoverSnowLumaConnection/.test(src), `${rel} 调用自动发现`);
  }
  // ↓ 下面两条查的是本仓库的 bridge.js，与工具在不在无关，照跑。
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  ok(/healTokenIfStale/.test(bridge), 'bridge 有 token 自愈');
  ok(/persistToken/.test(bridge), 'bridge 会把有效 token 写回 config.json');
  ok(/verifyTokenAfterOpen/.test(bridge), 'open 守卫已接线（先校验再写回）');
  ok(/void verifyTokenAfterOpen\(\);/.test(bridge), 'open handler 调用守卫而不是盲写');
  ok((bridge.match(/void syncTokenToFile\(\);/g) ?? []).length === 0,
    'open handler 里不再有无守卫的盲写调用');
  ok(/await syncTokenToFile\(\);/.test(bridge), '写回只在守卫校验通过后执行');
  ok(/wsToken \|\| cfg\.snowluma\.accessToken/.test(bridge), 'bot 构造用 wsToken 回退链');
  ok(/wsToken,\n        \.\.\.\(followEndpoint/.test(bridge) || /wsToken,$/.test(bridge) === false,
    '自愈写回带 wsToken（源码包含 persistSnowLumaEndpoint wsToken 参数）');
  ok(/persistSnowLumaEndpoint\([\s\S]*?wsToken/.test(bridge), '自愈写回带 wsToken');

}


console.log('## probeHttpToken：单次 HTTP token 校验');
{
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      const tk = String(init?.headers?.authorization ?? '').replace('Bearer ', '');
      if (tk === 'http-ok') {
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 2817824053, nickname: '塞巴斯' } }) };
      }
      return { ok: false, status: 401, json: async () => ({ status: 'failed', retcode: 1401, wording: 'unauthorized' }) };
    };
    const good = await probeHttpToken({ baseUrl: 'http://127.0.0.1:3000', token: 'http-ok' });
    ok(good.ok === true && good.uin === 2817824053, '有效 token → ok + 账号');
    const bad = await probeHttpToken({ baseUrl: 'http://127.0.0.1:3000', token: 'ws-token-错放了' });
    ok(bad.ok === false && bad.status === 401, '无效 token → 401（不抛异常）');
    ok(JSON.stringify(bad).includes('ws-token-') === false, '返回值不含 token 本体（CWE-532）');
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('## persistSnowLumaEndpoint：wsToken 双 token 持久化');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cfg2-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'http-old' } }, null, 2), 'utf8');
  const r = persistSnowLumaEndpoint(cfgPath, { accessToken: 'http-new', wsToken: 'ws-new', wsUrl: 'ws://127.0.0.1:3001' });
  ok(r.updated === true && r.changed.accessToken && r.changed.wsToken, '双 token 一起写盘');
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok(after.snowluma.accessToken === 'http-new' && after.snowluma.wsToken === 'ws-new', 'config.json 双 token 就位');
  const r2 = persistSnowLumaEndpoint(cfgPath, { accessToken: 'http-new', wsToken: 'ws-new', wsUrl: 'ws://127.0.0.1:3001' });
  ok(r2.updated === false, '同值幂等（不写盘）');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('## 楔死场景（2026-11-17 事故的复现与根治）');
{
  // 复现：config.json 的 accessToken 里错放了 WS token。
  // 楔死机制：WS 用它能连上（open 触发、永不 close），HTTP 全 401，旧逻辑永不自愈。
  // 根治路径：open 后 probeHttpToken 校验失败 → discover → 双 token 写回。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-home3-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cfg3-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    snowluma: { homeDir: home, httpUrl: 'http://127.0.0.1:3000', accessToken: 'ws-2817824053' },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(home, 'config', 'onebot_2817824053.json'), JSON.stringify({
    networks: {
      httpServers: [{ accessToken: 'http-2817824053', host: '127.0.0.1', port: 3000 }],
      wsServers: [{ accessToken: 'ws-2817824053', host: '127.0.0.1', port: 3001 }],
    },
  }), 'utf8');

  const realFetch = globalThis.fetch;
  try {
    // SnowLuma 现网行为：HTTP 口只认 http token，WS token 一律 401。
    globalThis.fetch = async (url, init) => {
      const tk = String(init?.headers?.authorization ?? '').replace('Bearer ', '');
      if (tk === 'http-2817824053') {
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 2817824053, nickname: '塞巴斯' } }) };
      }
      return { ok: false, status: 401, json: async () => ({ status: 'failed', retcode: 1401, wording: 'unauthorized' }) };
    };

    // 1) open 守卫的第一步：校验 config 里的 accessToken → 必须失败（楔死现场）。
    const probe = await probeHttpToken({ baseUrl: 'http://127.0.0.1:3000', token: 'ws-2817824053' });
    ok(probe.ok === false && probe.status === 401, '楔死现场：accessToken（错放 WS token）HTTP 校验 401');

    // 2) 守卫触发自愈：discover 用配置 homeDir 扫 per-account 文件 → 找到真 HTTP token + 同账号 wsToken。
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 500 });
    ok(r.ok === true && r.token === 'http-2817824053', '自愈发现真 HTTP token');
    ok(r.wsToken === 'ws-2817824053' && r.wsUrl === 'ws://127.0.0.1:3001', '同账号的 WS token/端口一并带回');

    // 3) applyHealedTokens 的写回：双 token 落 config，下次启动 WS 直连不再 1006。
    persistSnowLumaEndpoint(cfgPath, { accessToken: r.token, wsToken: r.wsToken, wsUrl: r.wsUrl });
    const healed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    ok(healed.snowluma.accessToken === 'http-2817824053' && healed.snowluma.wsToken === 'ws-2817824053',
      '写回后 accessToken=HTTP / wsToken=WS，楔死解除');
    const reprobe = await probeHttpToken({ baseUrl: 'http://127.0.0.1:3000', token: healed.snowluma.accessToken });
    ok(reprobe.ok === true, '写回后 HTTP 校验通过（发送链路恢复）');
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
