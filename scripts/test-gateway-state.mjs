// P4 会话状态镜像测试（qq-bridge 侧）：
//  - mark-read / wake-config / 新会话 agentToken / 启动回填 → POST /v1/state/update
//    （HMAC 头齐全，sessionKey = qq:<key>，source 区分 model/console/system）；
//  - 控制台 /api/socialV2/state(s) 用网关快照覆盖 unreadCount（gatewayState:true）；
//  - 网关不可达时镜像静默失败，本地路径完全不受影响。
// 网关侧 mailbox 的语义（单调水位/归一化/持久化）由 agent-gateway 的
// scripts/test-state-store.mjs 钉住；这里只验证「桥接确实把该寄的都寄了」。
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createGatewayClient as realCreateGatewayClient } from '../src/gateway/gateway-client.js';

const KEY = 'group:456';
const SECRET = 'adapter-secret-0123456789';

/**
 * 关掉一个监听中的 fixture server。
 *
 * 必须 closeAllConnections()：Node 19+ 的 http client 默认 keep-alive，只要还有
 * 空闲连接挂着，server.close() 的回调就永远不会触发——测试本体全绿、进程却
 * 不退出，`node --test | Select-Object -Last N` 那种带缓冲的管道会一行都不吐。
 */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function waitFor(predicate, { timeoutMs = 3000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** 假网关：捕获 /v1/state/update，快照端点回固定值。 */
async function startFakeGateway({ snapshot, list } = {}) {
  const updates = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/state/update') {
        updates.push({
          headers: req.headers,
          body: body ? JSON.parse(body) : {},
          at: Date.now(),
        });
        res.end(JSON.stringify({ ok: true, state: { sessionKey: 'x', exists: true, unreadCount: 0, readThroughSeq: 0, lastUnreadSeq: 0 } }));
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/state/')) {
        res.end(JSON.stringify({ ok: true, state: snapshot ?? { sessionKey: 'x', exists: false, unreadCount: 0, readThroughSeq: 0, lastUnreadSeq: 0 } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/state') {
        res.end(JSON.stringify({ ok: true, sessions: list ?? [] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: { code: 'E_UNSUPPORTED', message: 'not found' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, updates, port: server.address().port };
}

function consoleRequest(server, route, { body, token = '', key = KEY } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'x-console-token': 'fixture-console-token' };
    if (token) headers['x-agent-token'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port,
      path: `${route.startsWith('/') ? route : `/api/socialV2/${route}`}?key=${encodeURIComponent(key)}`,
      method: body === undefined ? 'GET' : 'POST', headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

test('P4 state mirror: 写路径 / 控制台读路径 / 回填 / 不可达回退', { concurrency: false }, async (t) => {
  const fake = await startFakeGateway({
    snapshot: { sessionKey: `qq:${KEY}`, exists: true, unreadCount: 7, readThroughSeq: 5, lastUnreadSeq: 12 },
    list: [{ sessionKey: `qq:${KEY}`, unreadCount: 7, readThroughSeq: 5 }],
  });
  let server = null;
  let h = null;
  // 清理先注册、且 fake.server 单独兜底：bridgeHarness 构造失败时（VM 缺注入、配置报错）
  // 手里还没有 h，若清理挂在构造之后就会漏掉这个监听的 socket，node --test 一直等
  // 事件循环排空——表现为「测试没输出、命令卡很久」，比失败本身更难查。
  t.after(async () => {
    await closeServer(server);
    try {
      await h?.close();
    } finally {
      await closeServer(fake.server);
    }
  });
  h = await bridgeHarness({
    config: {
      gateway: {
        mode: 'on', url: `http://127.0.0.1:${fake.port}`, adapterId: 'qq-main', platform: 'qq', secret: SECRET, state: 'on',
        conversations: ['qq:group:456'],
      },
      // 沉睡前观察窗口是另一条独立闸门（qq_mark_read 会因此 400）；这里测的是状态镜像。
      socialV2: { wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false } },
    },
    files: {
      // 存量会话：启动回填应把它补到网关（agent_token + inbound + mark_read + set_wake_config）。
      'state/social-v2.json': {
        paused: false,
        conversations: {
          [KEY]: {
            wakeConfig: { mode: 'diving', infinite: true, sleepUntil: null, batchWindowMs: 8000, triggers: { atMention: true }, confirmedBy: 'default' },
            recentMessages: [], unread: [],
            agentToken: 'b'.repeat(32),
            lastUnreadSeq: 12, lastReadThroughSeq: 5,
            lastIncomingAt: 0, preSleepWaitSatisfiedAt: 0, preSleepWaitObservedAt: 0, preSleepWaitAccumMs: 0,
            activeTopics: [], pendingThoughts: [], memberImpressions: {},
          },
        },
      },
    },
    globals: {
      // 桥接 VM 里的全局 fetch 是记录桩；网关客户端必须走真实 HTTP 到假网关。
      createGatewayClient: (opts) => realCreateGatewayClient({ ...opts, fetchImpl: (...args) => fetch(...args) }),
    },
  });
  const st = h.getSocialV2State(KEY);
  server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));

  // 1) 启动回填：存量会话的四类状态都补到了网关。
  await waitFor(() => fake.updates.filter((u) => u.body.sessionKey === `qq:${KEY}`).length >= 4);
  const backfill = fake.updates.filter((u) => u.body.sessionKey === `qq:${KEY}`);
  const actions = new Set(backfill.map((u) => u.body.action));
  for (const action of ['agent_token', 'inbound', 'mark_read', 'set_wake_config']) {
    assert.ok(actions.has(action), `启动回填缺 ${action}`);
  }
  const tokenUpdate = backfill.find((u) => u.body.action === 'agent_token');
  assert.equal(tokenUpdate.body.agentToken, 'b'.repeat(32));
  assert.equal(tokenUpdate.body.source, 'system');
  const inboundUpdate = backfill.find((u) => u.body.action === 'inbound');
  assert.equal(inboundUpdate.body.seq, 12);
  const readUpdate = backfill.find((u) => u.body.action === 'mark_read');
  assert.equal(readUpdate.body.throughSeq, 5);
  // HMAC 头齐全（网关侧的签名校验已由互认测试钉住，这里只确认桥接带上了凭据）。
  assert.match(backfill[0].headers['x-signature'], /^v1=/);
  assert.equal(backfill[0].headers['x-adapter-id'], 'qq-main');

  // 2) mark-read：模型带 agent token 调用 → mirror source=model。
  const marked = await consoleRequest(server, 'mark-read', {
    token: st.agentToken,
    body: { key: KEY, throughSeq: 9 },
  });
  assert.equal(marked.status, 200, `mark-read 应放行，实际 ${marked.status}: ${JSON.stringify(marked.json)}`);
  assert.equal(marked.json.ok, true);
  await waitFor(() => fake.updates.some((u) => u.body.action === 'mark_read' && u.body.source === 'model'));
  const modelRead = fake.updates.filter((u) => u.body.action === 'mark_read' && u.body.source === 'model').at(-1);
  assert.equal(modelRead.body.sessionKey, `qq:${KEY}`);
  assert.ok(Number.isSafeInteger(modelRead.body.throughSeq) && modelRead.body.throughSeq >= 9, `水位镜像应 ≥ 9，实际 ${modelRead.body.throughSeq}`);
  // 收尾同时改了唤醒配置（infinite 拉回 / confirmedBy=mark_read），要一并镜像。
  await waitFor(() => fake.updates.some((u) => u.body.action === 'set_wake_config'
    && u.body.source === 'model' && u.body.confirmedBy === 'mark_read'));

  // 3) wake-config：模型设置唤醒配置 → 全量镜像，confirmedBy=set_wake_config。
  const woken = await consoleRequest(server, 'wake-config', {
    token: st.agentToken,
    body: { key: KEY, config: { mode: 'active' }, throughSeq: 10 },
  });
  assert.equal(woken.status, 200);
  await waitFor(() => fake.updates.some((u) => u.body.action === 'set_wake_config'
    && u.body.source === 'model' && u.body.confirmedBy === 'set_wake_config'));
  const wakeUpdate = fake.updates.filter((u) => u.body.action === 'set_wake_config'
    && u.body.source === 'model' && u.body.confirmedBy === 'set_wake_config').at(-1);
  assert.equal(wakeUpdate.body.wakeConfig.mode, 'active');
  // 跨 realm 对象的原型不同，deepEqual 会误报；比 JSON 形状即可。
  assert.deepEqual(
    JSON.parse(JSON.stringify(wakeUpdate.body.wakeConfig.triggers)),
    JSON.parse(JSON.stringify(st.wakeConfig.triggers)),
    '镜像与本地配置一致',
  );
  assert.ok(wakeUpdate.body.throughSeq === undefined || wakeUpdate.body.throughSeq >= 10);

  // 4) 新会话：getSocialV2State 铸造新 token 时立即镜像 agent_token。
  const fresh = h.getSocialV2State('group:789');
  await waitFor(() => fake.updates.some((u) => u.body.sessionKey === 'qq:group:789' && u.body.action === 'agent_token'));
  const freshUpdate = fake.updates.find((u) => u.body.sessionKey === 'qq:group:789' && u.body.action === 'agent_token');
  assert.equal(freshUpdate.body.agentToken, fresh.agentToken);
  assert.match(fresh.agentToken, /^[0-9a-f]{32}$/);
  // 新会话的出厂唤醒配置也要落到网关，否则 mailbox 里只有令牌没有策略。
  await waitFor(() => fake.updates.some((u) => u.body.sessionKey === 'qq:group:789'
    && u.body.action === 'set_wake_config' && u.body.wakeConfig?.mode === 'diving'));

  // 5) 控制台读路径：state/states 用网关快照覆盖 unreadCount，gatewayState:true。
  const stateView = await consoleRequest(server, 'state');
  assert.equal(stateView.status, 200);
  assert.equal(stateView.json.gatewayState, true);
  assert.equal(stateView.json.unreadCount, 7, 'unreadCount 应来自网关快照');
  assert.ok('recentCount' in stateView.json, '本地字段保留');
  const statesView = await consoleRequest(server, 'states');
  assert.equal(statesView.status, 200);
  const row = statesView.json.conversations.find((r) => r.key === KEY);
  assert.equal(row.gatewayState, true);
  assert.equal(row.unreadCount, 7);

  // 6) 本地镜像写入不丢本地权威：mark-read 后本地 state 的 lastReadThroughSeq 也推进了。
  assert.ok(st.lastReadThroughSeq >= 9, '本地水位与网关镜像并行推进');

  // 7) 控制台重置二代状态 → 网关镜像必须同步删除，否则重建的会话被旧水位覆盖。
  const resetRes = await consoleRequest(server, '/api/socialV2/reset', { body: {} });
  assert.equal(resetRes.status, 200, `reset 应成功，实际 ${resetRes.status}: ${JSON.stringify(resetRes.json)}`);
  await waitFor(() => fake.updates.some((u) => u.body.action === 'reset' && u.body.sessionKey === `qq:${KEY}`));
});

test('P4 state mirror: 网关不可达时本地路径完全不受影响', { concurrency: false }, async (t) => {
  // 先占一个端口再关掉，得到一个确定没人监听的地址。
  const dead = http.createServer();
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const deadPort = dead.address().port;
  await new Promise((resolve) => dead.close(resolve));

  const h = await bridgeHarness({
    config: {
      gateway: {
        mode: 'on', url: `http://127.0.0.1:${deadPort}`, adapterId: 'qq-main', platform: 'qq', secret: SECRET, state: 'on',
        conversations: ['qq:group:456'],
      },
      socialV2: { wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false } },
    },
    files: {
      // 有未读（lastUnreadSeq=3）的存量会话：throughSeq=3 才是一次合法推进。
      'state/social-v2.json': {
        paused: false,
        conversations: {
          [KEY]: {
            wakeConfig: { mode: 'diving', infinite: true, sleepUntil: null, batchWindowMs: 8000, triggers: { atMention: true }, confirmedBy: 'default' },
            recentMessages: [], unread: [],
            agentToken: 'a'.repeat(32),
            lastUnreadSeq: 3, lastReadThroughSeq: 0,
            lastIncomingAt: 0, preSleepWaitSatisfiedAt: 0, preSleepWaitObservedAt: 0, preSleepWaitAccumMs: 0,
            activeTopics: [], pendingThoughts: [], memberImpressions: {},
          },
        },
      },
    },
    globals: {
      createGatewayClient: (opts) => realCreateGatewayClient({ ...opts, fetchImpl: (...args) => fetch(...args) }),
    },
  });
  let server = null;
  t.after(async () => { await closeServer(server); await h.close(); });
  const st = h.getSocialV2State(KEY);
  server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));

  const marked = await consoleRequest(server, 'mark-read', { token: st.agentToken, body: { key: KEY, throughSeq: 3 } });
  assert.equal(marked.status, 200, `网关不可达时 mark-read 必须照常成功，实际 ${marked.status}: ${JSON.stringify(marked.json)}`);
  assert.equal(marked.json.ok, true);
  assert.equal(st.lastReadThroughSeq, 3, '本地水位照常推进（镜像失败不影响本地权威）');
  // 控制台查询回退本地视图：gatewayState:false，本地字段原样。
  const stateView = await consoleRequest(server, 'state');
  assert.equal(stateView.status, 200);
  assert.equal(stateView.json.gatewayState, false);
  assert.equal(stateView.json.key, KEY);
});
