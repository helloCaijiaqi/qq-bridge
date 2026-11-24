#!/usr/bin/env node
/** Offline console preview. No production modules, credentials, state, or network clients are loaded. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manualDirCommand } from '../src/ops/state-acl.mjs';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timestamp = '2026-09-20T08:30:00.000Z';

export function makeFixtureState() {
  return {
    paused: false,
    whitelist: { allow: { groups: [123456789, 100003], private: [100001] }, deny: { groups: [], private: [] }, ownerQQ: '100001' },
    sessions: [
      { key: 'group:123456789', sessionId: 'demo-community-20260920', owner: false },
      { key: 'group:100003', sessionId: 'demo-development-20260920', owner: false },
      { key: 'private:100001', sessionId: 'demo-owner-20260920', owner: true },
    ],
    v2: { enabled: true, provideRecommendations: true, tools: {} },
    // 会话初始提示词（离线示例）：整段内容都是虚构的演示文本。
    initPrompt: '离线示例：这是一个演示用的群聊环境说明，不会写进任何真实配置。',
    security: { interceptNotify: true },
    // state/ 的 ACL 是否已收紧。离线演示默认给「未收紧」，这样告警条在预览里可见
    // （真实场景：Windows 上未以管理员身份运行桥接时就是这个状态）。
    hardenStateDir: false,
    toolLog: [
      { time: timestamp, key: 'group:123456789', tool: 'mcp__agent-gateway__chat_qq_get_recent', type: 'call', args: JSON.stringify({ key: 'group:123456789', limit: 20 }) },
      { time: timestamp, key: 'group:123456789', tool: 'mcp__agent-gateway__chat_qq_get_recent', type: 'result', ok: true },
    ],
    feedback: [{ time: timestamp, level: 'info', message: '这是离线演示反馈。' }],
  };
}

/** Bind only to loopback. Mutations affect this server's disposable in-memory state. */
export async function startConsoleFixture({ port = 0, original = false, htmlPath, logWrites = false } = {}) {
  const file = htmlPath || resolve(projectRoot, original ? 'scripts/fixtures/console.before.html' : 'public/console.html');
  await readFile(file); // Fail early rather than displaying a broken preview.
  const state = makeFixtureState();
  const requests = [];
  const unknownRequests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method || 'GET';
    const json = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (method === 'GET' && ['/', '/console', '/console.html'].includes(path)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'" });
        res.end(await readFile(file));
        return;
      }
      if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (method === 'GET' && path === '/__fixture/requests') return json({ requests, unknownRequests });
      if (method === 'GET' && path === '/__fixture/info') return json({ offline: true, htmlPath: file });
      if (!path.startsWith('/api/')) return json({ ok: false, error: 'Offline fixture route not found' }, 404);

      let body = {};
      if (method !== 'GET') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        requests.push({ method, path, body });
        if (logWrites) console.log(`[mock write] ${method} ${path} ${JSON.stringify(body)}`);
      }
      if (method === 'GET') {
        switch (path) {
          // /api/status 与真实桥接同形：智能体视图只有 gateway + socialV2Paused，
          // 操作者视图再叠加白名单摘要 / SnowLuma 快照 / 活动日志。
          case '/api/status': return json({
            ok: true,
            gateway: { adapterId: 'qq-main', ready: true },
            socialV2Paused: state.paused,
            ownerQQ: state.whitelist.ownerQQ,
            allowGroups: state.whitelist.allow.groups,
            allowPrivate: state.whitelist.allow.private,
            snowluma: { connected: true, good: true, lastPacketAgoMs: 1200, lastPacketKind: 'heartbeat' },
            activity: '[08:30:00] 演示桥接已连接\n[08:30:12] group:123456789 · 已处理一条消息\n[08:30:20] 二代社交助手正在运行\n以上均为离线模拟数据。',
          });
          case '/api/whitelist': return json(state.whitelist);
          case '/api/socialV2/config': return json({ ok: true, config: state.v2 });
          case '/api/socialV2/activity': return json({ ok: true, paused: state.paused });
          case '/api/socialV2/tool-log': return json({ ok: true, entries: state.toolLog });
          case '/api/socialV2/feedback': return json({ ok: true, entries: state.feedback });
          case '/api/socialV2/state': return json({ ok: true, key: url.searchParams.get('key'), wakeConfig: { mode: 'diving', infinite: false, sleepUntil: '2026-09-20T09:00:00.000Z', triggers: { atMention: true, keywords: ['小鲸鱼'] }, wakeCount: 4 }, wakeSafety: { guaranteed: true }, unreadCount: 2, lastWakeReason: 'atMention' });
          case '/api/socialV2/states': return json({ ok: true, conversations: state.sessions.map(x => ({ key: x.key, phase: 'diving', unreadCount: 2 })) });
          case '/api/socialV2/initial-prompt': {
            const key = url.searchParams.get('key') || '';
            if (!key) {
              return json({
                ok: true,
                maxChars: 2000,
                writable: true,
                entries: state.initPrompt
                  ? [{ key: 'group:123456789', chars: String(state.initPrompt).length, updatedAt: Date.now(), preview: String(state.initPrompt).slice(0, 80) }]
                  : []
              });
            }
            return json({
              ok: true, key, exists: !!state.initPrompt, text: state.initPrompt || '',
              createdAt: Date.now(), updatedAt: Date.now(), maxChars: 2000, writable: true
            });
          }
          // 语音库（离线示例：不含任何真实音频路径）
          case '/api/voice/list':
          case '/api/socialV2/voices': return json({
            ok: true,
            key: url.searchParams.get('key') || 'group:123456789',
            count: 2,
            voices: [
              { name: '演示-问候.mp3', ok: true, bytes: 20480, detail: '2秒 · 20.0 KB · mp3 · 24.0kHz · 单声道', seconds: 2 },
              { name: '演示-太长.wav', ok: false, bytes: 99999999, error: '时长 12分00秒 超过上限 5分00秒' },
            ],
            limits: { maxSeconds: 300, maxBytes: 20971520, maxPerMinute: 2, maxPerHour: 10 },
            hint: '用 chat_qq_send_voice 传 name 即可把其中一个当语音发出去',
          });
          // state/ 的 ACL 收紧结果：用离线示例值演示「未收紧」的告警条（Windows 上未提权时的真实情况）
          // 命令本身必须来自 `src/ops/state-acl.mjs`，不能在这里另抄一份：这里曾经抄的是
          // `icacls DIR /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" /T /C` —— 正是那句
          // 会把子文件 DACL 清空、让桥接读不到自己令牌的破坏性命令。示例数据是给人照抄的，
          // 抄错的那一版和真的那一版看起来一模一样。
          case '/api/security': return json({
            ok: true,
            security: state.security,
            stateDir: state.hardenStateDir
              ? { hardened: true, path: 'D:\\demo\\qq-bridge\\state', manualCommand: '' }
              : { hardened: false, path: 'D:\\demo\\qq-bridge\\state', manualCommand: manualDirCommand('D:\\demo\\qq-bridge\\state') }
          });
        }
      }
      if (method === 'POST') {
        switch (path) {
          case '/api/whitelist': state.whitelist = body; return json({ ok: true });
          case '/api/socialV2/config': state.v2 = body; return json({ ok: true });
          case '/api/socialV2/activity': state.paused = body.paused; return json({ ok: true });
          case '/api/socialV2/tool-log/clear': state.toolLog = []; return json({ ok: true });
          case '/api/socialV2/feedback-clear': state.feedback = []; return json({ ok: true });
          case '/api/socialV2/reset': return json({ ok: true });
          case '/api/socialV2/initial-prompt': {
            const text = body.delete === true ? '' : String(body.text ?? '');
            state.initPrompt = text;
            return json({
              ok: true, key: body.key || '', deleted: !text, chars: text.length,
              exists: !!text, updatedAt: Date.now(), maxChars: 2000
            });
          }
          case '/api/security':
            if (body.rehardenStateDir === true) {
              // 离线演示：把「重新检测」当成一次成功的收紧（真实实现要管理员权限）
              state.hardenStateDir = true;
              return json({ ok: true, hardened: true, path: 'D:\\demo\\qq-bridge\\state' });
            }
            state.security = body;
            return json({ ok: true });
          case '/api/console/token': return json({ ok: true, token: body.token || 'offline-demo-token-123456', generated: !body.token });
          case '/api/test-send': return json({ ok: true, message_id: 'mock-message-001' });
          // 语音试发（操作者通道）：离线只回执，不产生任何真实 QQ 消息
          case '/api/voice/send': return json(body.dryRun
            ? { ok: true, dryRun: true, target: body.target, file: body.file, detail: '2秒 · 20.0 KB · mp3 · 24.0kHz · 单声道', verified: false }
            : { ok: true, target: body.target, file: body.file, detail: '2秒 · 20.0 KB · mp3', messageId: 9001, verified: true, limits: { maxSeconds: 300, maxBytes: 20971520, maxPerMinute: 2, maxPerHour: 10 } });
          case '/api/restart': return json({ ok: true, message: '离线预览：已模拟重启，实际服务未改变。' });
          case '/api/workspace/reset': state.sessions = []; return json({ ok: true, archivedCount: 3 });
          case '/api/session/reset': state.sessions = state.sessions.filter(x => x.key !== body.key); return json({ ok: true });
          case '/api/socialV2/wake': return json({ ok: true });
        }
      }
      unknownRequests.push({ method, path });
      return json({ ok: false, error: `Unimplemented fixture route: ${method} ${path}` }, 404);
    } catch (error) {
      json({ ok: false, error: error.message }, 500);
    }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  return { server, state, requests, unknownRequests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolveClose => server.close(resolveClose)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => args.find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
  const fixture = await startConsoleFixture({ port: Number(value('--port') || 4173), original: args.includes('--original'), htmlPath: value('--html') ? resolve(value('--html')) : undefined, logWrites: true });
  console.log(`Offline console preview: ${fixture.url}\nAll data is synthetic; writes stay in memory.\nRecorded requests: ${fixture.url}/__fixture/requests`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await fixture.close(); process.exit(0); });
}
