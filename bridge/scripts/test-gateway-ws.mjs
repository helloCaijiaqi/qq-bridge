// 网关 WS 传输层测试（真 WS 服务端，握手用网关侧同一公式验签——跨仓互认在这里钉住）。
//
// 覆盖：
//   - 握手签名（空 body）+ inbound/ack 全字段映射（含 deduped）
//   - transport=ws 强制语义：失败如实失败、HTTP 绝不被调用（真 WS 链路可验证）
//   - transport=auto：断线回落 HTTP 重投、熔断、E_DISABLED 不重投
//   - action 下行帧（帧级签名）→ 执行 → action/result 回执
//   - ping/pong、断线重连、信封体积断言
//
// 全离线：服务端是本进程起的 loopback WS。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createGatewayClient } from '../src/gateway/gateway-client.js';
import { createGatewayActionsHandler } from '../src/gateway/gateway-actions.js';

const SECRET = 'gateway-ws-test-secret-0123456789';
const ADAPTER = 'qq-main';

/** 网关侧握手验签（与 agent-gateway core/ws-hub.mjs verifyHandshake 同公式）。 */
function verifyHandshake(url) {
  const id = url.searchParams.get('adapterId');
  const tsRaw = url.searchParams.get('ts');
  const nonce = url.searchParams.get('nonce');
  const sign = url.searchParams.get('sign');
  if (!id || !tsRaw || !nonce || !sign) return false;
  if (id !== ADAPTER) return false;
  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) return false;
  const bodyHash = crypto.createHash('sha256').update('').digest('hex');
  const expected = crypto.createHmac('sha256', SECRET).update(`${ts}\n${nonce}\n${bodyHash}`).digest('hex');
  return sign === `v1=${expected}`;
}

/** 网关侧动作帧签名（与 executors/adapter-tools/common/crypto.mjs signActionFrame 同公式）。 */
function signAction(envelope) {
  const ts = Date.now();
  const nonce = crypto.randomBytes(9).toString('hex');
  const digest = crypto.createHash('sha256').update(JSON.stringify(envelope), 'utf8').digest('hex');
  const signature = crypto.createHmac('sha256', SECRET).update(`${ts}\n${nonce}\n${digest}`).digest('hex');
  return { ts, nonce, signature: `v1=${signature}` };
}

/** 新版帧签名：附带 bodyHash（验签方不再重新序列化）。 */
function signActionWithHash(envelope) {
  const ts = Date.now();
  const nonce = crypto.randomBytes(9).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(envelope), 'utf8').digest('hex');
  const signature = crypto.createHmac('sha256', SECRET).update(`${ts}\n${nonce}\n${bodyHash}`).digest('hex');
  return { ts, nonce, signature: `v1=${signature}`, bodyHash };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeEnvelope(overrides = {}) {
  return {
    v: 1,
    actionId: 'act-1',
    type: 'send_text',
    target: { platform: 'qq', kind: 'group', conversationId: '123' },
    payload: { text: 'hi' },
    idempotencyKey: 'idem-1',
    ...overrides,
  };
}

function makeActions(overrides = {}) {
  const calls = [];
  const handler = createGatewayActionsHandler({
    secret: SECRET,
    platform: 'qq',
    sendText: async ({ text }) => {
      calls.push(text);
      await sleep(60);
      return { ok: true, messageId: 'm-1' };
    },
    logger: () => {},
    ...overrides,
  });
  return { handler, calls };
}

function waitFor(predicate, ms = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = setInterval(() => {
      if (predicate()) {
        clearInterval(tick);
        resolve(true);
      } else if (Date.now() - started > ms) {
        clearInterval(tick);
        reject(new Error('waitFor timeout'));
      }
    }, 15);
  });
}

/** 起一个最小 ws-hub：验签握手 + 可编程帧处理。 */
async function startHub({ onFrame } = {}) {
  const server = http.createServer((req, res) => res.end('ok'));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const sockets = new Set();
  const received = [];
  let handshakes = 0;
  let rejected = 0;

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/v1/ws') return;
    if (!verifyHandshake(url)) {
      rejected += 1;
      socket.on('error', () => {});
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      return;
    }
    handshakes += 1;
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (data) => {
        const message = JSON.parse(String(data));
        received.push(message);
        onFrame?.(message, ws);
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    received,
    get handshakes() { return handshakes; },
    get rejected() { return rejected; },
    get connections() { return sockets.size; },
    send(payload) {
      for (const ws of sockets) ws.send(JSON.stringify(payload));
    },
    closeConnections() {
      for (const ws of sockets) ws.close();
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 记录型 fetch：默认永远失败（用于断言 HTTP 未被调用/被调用几次）。 */
function makeFetch({ status = 200, body = { ok: true } } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const text = JSON.stringify(body);
    return { status, text: async () => text };
  };
  return { calls, impl };
}

test('WS：握手签名正确 + inbound/ack 全字段映射（含 deduped）', async () => {
  const hub = await startHub({
    onFrame(message) {
      if (message.type === 'inbound') {
        hub.send({
          v: 1, type: 'inbound/ack', ok: true,
          turnId: 'turn-1', status: 'accepted', deduped: true, routed: true,
        });
      }
    },
  });
  const fetchStub = makeFetch();
  const client = createGatewayClient({
    baseUrl: hub.baseUrl, adapterId: ADAPTER, platform: 'qq', secret: SECRET,
    transport: 'ws', timeoutMs: 800, fetchImpl: fetchStub.impl,
  });
  try {
    assert.equal(hub.handshakes, 0, '构造时还没完成握手（异步）');
    await waitFor(() => client.connected);
    assert.equal(hub.handshakes, 1);
    assert.equal(hub.rejected, 0);

    const result = await client.inbound({ v: 1, platform: 'qq', seq: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.body, { turnId: 'turn-1', status: 'accepted', deduped: true, routed: true });
    assert.equal(fetchStub.calls.length, 0, 'ws 模式绝不走 HTTP');
  } finally {
    client.close();
    await hub.close();
  }
});

test('WS：E_DISABLED 视为网关拒绝——不回落 HTTP、不计熔断', async () => {
  const hub = await startHub({
    onFrame(message) {
      if (message.type === 'inbound') {
        hub.send({ v: 1, type: 'inbound/ack', ok: false, error: { code: 'E_DISABLED', message: 'gateway mode is off' } });
      }
    },
  });
  const fetchStub = makeFetch();
  const client = createGatewayClient({
    baseUrl: hub.baseUrl, adapterId: ADAPTER, platform: 'qq', secret: SECRET,
    transport: 'auto', timeoutMs: 500, fetchImpl: fetchStub.impl,
  });
  try {
    await waitFor(() => client.connected);
    const result = await client.inbound({ v: 1, platform: 'qq', seq: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_DISABLED');
    assert.equal(result.status, 503);
    assert.equal(fetchStub.calls.length, 0, '网关拒绝不触发 HTTP 重投');
    assert.equal(client.transportState.breakerOpen, false, 'E_DISABLED 不计熔断');
  } finally {
    client.close();
    await hub.close();
  }
});

test('WS 强制模式：断线即如实失败，绝不回落 HTTP', async () => {
  const hub = await startHub();
  const fetchStub = makeFetch();
  const client = createGatewayClient({
    baseUrl: hub.baseUrl, adapterId: ADAPTER, platform: 'qq', secret: SECRET,
    transport: 'ws', timeoutMs: 200, fetchImpl: fetchStub.impl,
  });
  try {
    await waitFor(() => client.connected);
    hub.closeConnections();
    await waitFor(() => !client.connected);
    const result = await client.inbound({ v: 1, platform: 'qq', seq: 2 });
    assert.equal(result.ok, false);
    assert.equal(fetchStub.calls.length, 0, 'ws 模式没有 HTTP 兜底');
  } finally {
    client.close();
    await hub.close();
  }
});

test('auto：WS 断开时回落 HTTP 重投（幂等键兜底）', async () => {
  const hub = await startHub();
  const fetchStub = makeFetch({ status: 200, body: { turnId: 'http-turn', status: 'accepted', deduped: false } });
  const client = createGatewayClient({
    baseUrl: hub.baseUrl, adapterId: ADAPTER, platform: 'qq', secret: SECRET,
    transport: 'auto', timeoutMs: 200, fetchImpl: fetchStub.impl,
  });
  try {
    await waitFor(() => client.connected);
    hub.closeConnections();
    await waitFor(() => !client.connected);
    const result = await client.inbound({ v: 1, platform: 'qq', seq: 3, idempotencyKey: 'k-3' });
    assert.equal(result.ok, true);
    assert.equal(result.body.turnId, 'http-turn');
    assert.equal(fetchStub.calls.length, 1, 'WS 失败后恰好重投一次 HTTP');
  } finally {
    client.close();
    await hub.close();
  }
});

test('auto：连续失败触发熔断，熔断期内直接走 HTTP', async () => {
  const hub = await startHub();
  const fetchStub = makeFetch({ status: 500, body: { error: { code: 'E_INTERNAL', message: 'down' } } });
  const client = createGatewayClient({
    baseUrl: hub.baseUrl, adapterId: ADAPTER, platform: 'qq', secret: SECRET,
    transport: 'auto', timeoutMs: 120, fetchImpl: fetchStub.impl,
  });
  try {
    await waitFor(() => client.connected);
    hub.closeConnections();
    await waitFor(() => !client.connected);
    for (let i = 0; i < 3; i += 1) await client.inbound({ v: 1, platform: 'qq', seq: 10 + i });
    assert.equal(client.transportState.breakerOpen, true, '连续 3 次 WS 失败后熔断');
    const before = fetchStub.calls.length;
    await client.inbound({ v: 1, platform: 'qq', seq: 20 });
    assert.equal(fetchStub.calls.length, before + 1, '熔断期内直接走 HTTP（不再等 WS）');
  } finally {
    client.close();
    await hub.close();
  }
});

test('动作下行：action 帧（帧级签名）→ onAction 执行 → action/result 回执', async () => {
  const hub = await startHub();
  const envelope = {
    v: 1, actionId: 'act-1', type: 'send_text', idempotencyKey: 'idem-1',
    target: { platform: 'qq', kind: 'group', conversationId: '123' }, payload: { text: 'hi' },
  };
  const seen = [];
  const client = createGatewayClient({
    baseUrl: hub.baseUrl, adapterId: ADAPTER, platform: 'qq', secret: SECRET,
    transport: 'ws', timeoutMs: 800,
    onAction: async (received, sign) => {
      seen.push({ received, sign });
      return { v: 1, actionId: received.actionId, ok: true, at: Date.now() };
    },
  });
  try {
    await waitFor(() => client.connected);
    hub.send({ v: 1, type: 'action', callId: 'call-1', envelope, sign: signAction(envelope) });
    await waitFor(() => hub.received.some((m) => m.type === 'action/result'));
    const reply = hub.received.find((m) => m.type === 'action/result');
    assert.equal(reply.callId, 'call-1');
    assert.equal(reply.actionId, 'act-1');
    assert.equal(reply.ok, true);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].received, envelope);
    assert.ok(seen[0].sign?.signature?.startsWith('v1='), '帧签名透传给 onAction（供 gateway-actions 验签）');
  } finally {
    client.close();
    await hub.close();
  }
});

test('心跳：网关 ping → 客户端 pong', async () => {
  const hub = await startHub();
  const client = createGatewayClient({
    baseUrl: hub.baseUrl, adapterId: ADAPTER, platform: 'qq', secret: SECRET, transport: 'ws', timeoutMs: 500,
  });
  try {
    await waitFor(() => client.connected);
    hub.send({ v: 1, type: 'ping', at: Date.now() });
    await waitFor(() => hub.received.some((m) => m.type === 'pong'));
    assert.ok(typeof hub.received.find((m) => m.type === 'pong').at === 'number');
  } finally {
    client.close();
    await hub.close();
  }
});

test('信封体积：超 64KB 拒绝出帧（媒体必须是 ref，不允许 base64）', async () => {
  const hub = await startHub();
  const client = createGatewayClient({
    baseUrl: hub.baseUrl, adapterId: ADAPTER, platform: 'qq', secret: SECRET, transport: 'ws', timeoutMs: 300,
  });
  try {
    await waitFor(() => client.connected);
    const before = hub.received.filter((m) => m.type === 'inbound').length;
    const result = await client.inbound({ v: 1, platform: 'qq', blob: 'x'.repeat(70 * 1024) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_SCHEMA');
    assert.equal(hub.received.filter((m) => m.type === 'inbound').length, before, '超大信封没有发出');
  } finally {
    client.close();
    await hub.close();
  }
});

test('callId 关联：乱序/迟到 ack 不会结算到别的在途请求', async () => {
  const seen = [];
  const hub = await startHub({
    onFrame(message) {
      if (message.type !== 'inbound') return;
      seen.push(message);
      // seq=1 永不回 ack；seq=2 延迟回；用于制造「A 超时、B 正常、A 迟到 ack」。
      if (message.envelope?.seq === 2) {
        setTimeout(() => {
          hub.send({
            v: 1, type: 'inbound/ack', callId: message.callId, adapterId: ADAPTER,
            ok: true, turnId: 'turn-2', status: 'accepted',
          });
        }, 40);
      }
    },
  });
  const client = createGatewayClient({
    baseUrl: hub.baseUrl, adapterId: ADAPTER, platform: 'qq', secret: SECRET,
    transport: 'ws', timeoutMs: 160, fetchImpl: makeFetch().impl,
  });
  try {
    await waitFor(() => client.connected);
    const first = client.inbound({ v: 1, platform: 'qq', seq: 1 });
    const second = client.inbound({ v: 1, platform: 'qq', seq: 2 });
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r2.ok, true, 'B 应拿到自己的 ack');
    assert.equal(r2.body.turnId, 'turn-2');
    assert.equal(r1.ok, false, 'A 无 ack 应超时');
    assert.equal(r1.code, 'E_TIMEOUT');

    // A 的迟到 ack：此时已无对应条目，必须被丢弃（旧 FIFO 会结算到下一个请求）。
    const late = seen.find((m) => m.envelope?.seq === 1);
    assert.ok(late?.callId, 'inbound 帧必须带 callId');
    const before = client.transportState.pendingInbound;
    hub.send({ v: 1, type: 'inbound/ack', callId: late.callId, ok: true, turnId: 'turn-1', status: 'accepted' });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(client.transportState.pendingInbound, before, '迟到 ack 不影响在途请求');
  } finally {
    client.close();
    await hub.close();
  }
});

test('ack 归属校验：来自别的 adapterId 的 ack 判 E_AUTH', async () => {
  const hub = await startHub({
    onFrame(message) {
      if (message.type !== 'inbound') return;
      hub.send({
        v: 1, type: 'inbound/ack', callId: message.callId, adapterId: 'not-me',
        ok: true, turnId: 'turn-x', status: 'accepted',
      });
    },
  });
  const client = createGatewayClient({
    baseUrl: hub.baseUrl, adapterId: ADAPTER, platform: 'qq', secret: SECRET,
    transport: 'ws', timeoutMs: 500,
  });
  try {
    await waitFor(() => client.connected);
    const result = await client.inbound({ v: 1, platform: 'qq', seq: 7 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_AUTH');
  } finally {
    client.close();
    await hub.close();
  }
});

test('旧网关兼容：ack 不带 callId 时仍按 FIFO 结算', async () => {
  const hub = await startHub({
    onFrame(message) {
      if (message.type !== 'inbound') return;
      hub.send({ v: 1, type: 'inbound/ack', ok: true, turnId: 'legacy-turn', status: 'accepted' });
    },
  });
  const client = createGatewayClient({
    baseUrl: hub.baseUrl, adapterId: ADAPTER, platform: 'qq', secret: SECRET,
    transport: 'ws', timeoutMs: 500,
  });
  try {
    await waitFor(() => client.connected);
    const result = await client.inbound({ v: 1, platform: 'qq', seq: 8 });
    assert.equal(result.ok, true);
    assert.equal(result.body.turnId, 'legacy-turn');
  } finally {
    client.close();
    await hub.close();
  }
});

test('握手挂起：看门狗收口并恢复可重连状态', async () => {
  const sockets = [];
  class SilentSocket {
    constructor() { this.handlers = {}; sockets.push(this); }
    on(event, handler) { (this.handlers[event] ??= []).push(handler); }
    send() {}
    close() {}
    terminate() { this.terminated = true; }
  }
  const client = createGatewayClient({
    baseUrl: 'http://127.0.0.1:1', adapterId: ADAPTER, platform: 'qq', secret: SECRET,
    transport: 'auto', timeoutMs: 80, handshakeTimeoutMs: 60, wsImpl: SilentSocket,
  });
  try {
    await waitFor(() => sockets.length === 1);
    await waitFor(() => sockets[0].terminated === true, 500);
    await waitFor(() => client.transportState.ws === 'closed', 500);
  } finally {
    client.close();
  }
});

test('建连失败计入熔断：连续 3 次后不再先等 WS', async () => {
  const hub = await startHub();
  const fetchStub = makeFetch({ status: 200, body: { turnId: 'http-turn', status: 'accepted' } });
  const client = createGatewayClient({
    baseUrl: hub.baseUrl, adapterId: ADAPTER, platform: 'qq', secret: SECRET,
    transport: 'auto', timeoutMs: 60, fetchImpl: fetchStub.impl,
  });
  await hub.close();
  try {
    for (let i = 0; i < 3; i += 1) await client.inbound({ v: 1, platform: 'qq', seq: 30 + i });
    assert.equal(client.transportState.breakerOpen, true, '建连失败也应计入熔断');
  } finally {
    client.close();
  }
});

test('断线重连：退避后自动恢复连接', async () => {
  const hub = await startHub();
  const client = createGatewayClient({
    baseUrl: hub.baseUrl, adapterId: ADAPTER, platform: 'qq', secret: SECRET, transport: 'auto', timeoutMs: 300,
  });
  try {
    await waitFor(() => client.connected);
    hub.closeConnections();
    await waitFor(() => !client.connected);
    await waitFor(() => client.connected, 5000);
    assert.equal(hub.handshakes, 2, '重连重新走了一次握手（nonce 不复用）');
  } finally {
    client.close();
    await hub.close();
  }
});

test('动作幂等：并发同 key 只执行一次（在途登记 promise）', async () => {
  const { handler, calls } = makeActions();
  const envelope = makeEnvelope();
  const [r1, r2] = await Promise.all([
    handler.handleFrame({ envelope: { ...envelope }, sign: signActionWithHash(envelope) }),
    handler.handleFrame({ envelope: { ...envelope }, sign: signActionWithHash(envelope) }),
  ]);
  assert.equal(calls.length, 1, '并发重投只真正执行一次');
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r1.actionId, 'act-1');
  assert.equal(r2.actionId, 'act-1');

  // 执行完成后再次重投：命中缓存，不再执行。
  const r3 = await handler.handleFrame({ envelope: { ...envelope }, sign: signActionWithHash(envelope) });
  assert.equal(r3.ok, true);
  assert.equal(calls.length, 1);
});

test('动作幂等：业务失败短 TTL 缓存，传输失败不缓存', async () => {
  // 业务失败（E_RATE_LIMITED）：第二次重投命中缓存，不重复执行。
  let rateCalls = 0;
  const rate = makeActions({
    sendText: async () => {
      rateCalls += 1;
      return { ok: false, error: { code: 'E_RATE_LIMITED', message: 'slow down' } };
    },
  });
  const envelope = makeEnvelope({ idempotencyKey: 'idem-fail' });
  const a = await rate.handler.handleFrame({ envelope: { ...envelope }, sign: signActionWithHash(envelope) });
  const b = await rate.handler.handleFrame({ envelope: { ...envelope }, sign: signActionWithHash(envelope) });
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(rateCalls, 1, '业务失败在短 TTL 内复用回执');

  // 传输/未知失败（抛错 → E_PLATFORM）：不缓存，重试必须重新执行。
  let attempts = 0;
  const flaky = makeActions({
    sendText: async () => {
      attempts += 1;
      throw new Error('network down');
    },
  });
  const env2 = makeEnvelope({ idempotencyKey: 'idem-transport' });
  const c = await flaky.handler.handleFrame({ envelope: { ...env2 }, sign: signActionWithHash(env2) });
  const d = await flaky.handler.handleFrame({ envelope: { ...env2 }, sign: signActionWithHash(env2) });
  assert.equal(c.ok, false);
  assert.equal(d.ok, false);
  assert.equal(attempts, 2, '传输失败不缓存，重试会重新执行');
});

test('幂等键含 type/target：同 key 不同目标不共享回执', async () => {
  const { handler, calls } = makeActions();
  const base = makeEnvelope({ idempotencyKey: 'same-key' });
  const other = makeEnvelope({
    actionId: 'act-2',
    idempotencyKey: 'same-key',
    target: { platform: 'qq', kind: 'group', conversationId: '456' },
  });
  const r1 = await handler.handleFrame({ envelope: { ...base }, sign: signActionWithHash(base) });
  const r2 = await handler.handleFrame({ envelope: { ...other }, sign: signActionWithHash(other) });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r2.actionId, 'act-2');
  assert.equal(calls.length, 2, '不同目标必须各自执行');
});

test('帧验签：bodyHash 新路径、无 bodyHash 旧路径、篡改摘要被拒', async () => {
  const { handler } = makeActions();
  const envelope = makeEnvelope({ idempotencyKey: 'idem-sign' });

  const modern = await handler.handleFrame({ envelope: { ...envelope }, sign: signActionWithHash(envelope) });
  assert.equal(modern.ok, true);

  // 旧网关：不带 bodyHash，验签方重新序列化（灰度兼容）。
  const legacySign = signAction(envelope);
  const legacy = await handler.handleFrame({ envelope: { ...envelope }, sign: legacySign });
  assert.equal(legacy.ok, true, '旧帧仍应通过（幂等命中同一 key）');

  // 篡改 bodyHash：签名对不上。
  const tampered = { ...signActionWithHash(envelope), bodyHash: 'f'.repeat(64) };
  const rejected = await handler.handleFrame({ envelope: { ...envelope }, sign: tampered });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'E_AUTH');
});

test('边界：清单模式 send_text 超长被拒、回执 data 超 512KB 被拒', async () => {
  const manifest = {
    v: 1,
    platform: 'qq',
    actions: [{ type: 'send_text', summary: 'send', kind: 'send', wired: true }],
  };
  const { handler, calls } = makeActions({ manifest });
  const long = makeEnvelope({ idempotencyKey: 'idem-long', payload: { text: 'x'.repeat(4001) } });
  const longResult = await handler.handleFrame({ envelope: { ...long }, sign: signActionWithHash(long) });
  assert.equal(longResult.ok, false);
  assert.equal(longResult.error.code, 'E_SCHEMA');
  assert.equal(calls.length, 0, '超长文本不得进入发送回调');

  // 回执 data 体积上限（媒体应回 ref，而不是 base64 内联）。
  const bigManifest = {
    v: 1,
    platform: 'qq',
    actions: [{ type: 'get_blob', summary: 'blob', kind: 'read', wired: true }],
  };
  const big = createGatewayActionsHandler({
    secret: SECRET,
    platform: 'qq',
    manifest: bigManifest,
    sendText: async () => ({ ok: true }),
    handlers: { get_blob: async () => ({ ok: true, data: { blob: 'y'.repeat(600 * 1024) } }) },
    logger: () => {},
  });
  const bigEnvelope = makeEnvelope({ type: 'get_blob', idempotencyKey: 'idem-big', payload: {} });
  const bigResult = await big.handleFrame({ envelope: { ...bigEnvelope }, sign: signActionWithHash(bigEnvelope) });
  assert.equal(bigResult.ok, false);
  assert.equal(bigResult.error.code, 'E_TOO_LARGE');
});

// ── gateway.json 热轮换（rotate）──────────────────────────────────────────────
// 消费端凭据运行中变更：旧连接被断开，重连循环用新身份重新握手（与 agent-gateway
// 登记目录换 id/重注册的运维流程对应），全程无需重启。
test('rotate：运行中换密钥 → 旧连接断开、新握手用新身份；非法新值拒收', async () => {
  const NEW = 'rotated-gateway-secret-0123456789';
  const ALT = 'svc-alt';
  // hub 接受两套身份（新旧并存），并记录每次握手的 adapterId。
  const identities = { [ADAPTER]: SECRET, [ALT]: NEW };
  const handshakes = [];
  const server = http.createServer(() => {});
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/v1/ws') return;
    const id = url.searchParams.get('adapterId');
    const ts = Number(url.searchParams.get('ts'));
    const nonce = url.searchParams.get('nonce');
    const sign = url.searchParams.get('sign');
    const secret = identities[id];
    const bodyHash = crypto.createHash('sha256').update('').digest('hex');
    const expected = secret
      ? crypto.createHmac('sha256', secret).update(`${ts}\n${nonce}\n${bodyHash}`).digest('hex')
      : null;
    if (!secret || sign !== `v1=${expected}`) {
      socket.on('error', () => {});
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      return;
    }
    handshakes.push(id);
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = createGatewayClient({
    baseUrl,
    adapterId: ADAPTER,
    platform: 'qq',
    secret: SECRET,
    transport: 'ws',
  });
  try {
    // 首连：旧身份握手成功。
    for (let i = 0; i < 100 && !client.connected; i++) await sleep(20);
    assert.equal(client.connected, true, '首连成功');
    assert.equal(handshakes.at(-1), ADAPTER);

    // 非法 rotate（过短密钥）：整体拒收，旧身份与连接原样保留。
    assert.throws(
      () => client.rotate({ baseUrl, adapterId: ALT, platform: 'qq', secret: 'short' }),
      /at least 16 characters/,
    );
    assert.equal(client.identity.adapterId, ADAPTER, '拒收后旧身份保留');
    assert.equal(client.connected, true, '拒收不断开现有连接');

    // 合法 rotate：新身份立即生效，旧连接被断开，重连循环用新凭据重新握手。
    client.rotate({ baseUrl, adapterId: ALT, platform: 'qq', secret: NEW });
    assert.equal(client.identity.adapterId, ALT);
    for (let i = 0; i < 100 && !(client.connected && handshakes.at(-1) === ALT); i++) await sleep(20);
    assert.equal(handshakes.at(-1), ALT, '重连握手用了新 adapterId');
    assert.equal(client.connected, true, '新身份握手成功');
    assert.ok(handshakes.includes(ADAPTER) && handshakes.includes(ALT), '新旧两次握手都发生过');
  } finally {
    client.close();
    for (const ws of sockets) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
