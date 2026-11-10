// wait 事件回推（桥接侧集成）：真跑 bridge.js（审计脚手架 VM）。
// 钉住的链路：
//   1. POST /v1/actions type=wait → 立即回执（不阻塞），基线=注册时未读水位；
//   2. 新消息到达 → 即使常规唤醒触发全部关闭，也必须强制唤醒（否则 wait 永远不推）；
//   3. 唤醒投递时信封带 kind=event + wake 标记、不带 prompt.text（prompt 由网关合成）、
//      快照里带等待期间的消息；投递成功后登记一次性作废；
//   4. 未满足阈值（minNewMessages=2 只来一条）不唤醒；模式不对/已暂停时如实拒绝。
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const SECRET = 'wait-pushback-secret-0123456789';
const KEY = 'group:456';

function signedHeaders(body) {
  const timestamp = Date.now();
  const nonce = randomBytes(12).toString('hex');
  const digest = createHash('sha256').update(body, 'utf8').digest('hex');
  const signature = createHmac('sha256', SECRET).update(`${timestamp}\n${nonce}\n${digest}`, 'utf8').digest('hex');
  return {
    'content-type': 'application/json',
    'x-timestamp': String(timestamp),
    'x-nonce': nonce,
    'x-gateway-secret': `v1=${signature}`,
  };
}

function postAction(port, envelope) {
  const body = JSON.stringify(envelope);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/actions', method: 'POST',
      headers: signedHeaders(body),
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('action request hung')));
    req.end(body);
  });
}

function waitEnvelope(payload = {}) {
  return {
    v: 1,
    actionId: `wait-${Math.random().toString(36).slice(2)}`,
    turnId: 'turn_1',
    type: 'wait',
    target: { platform: 'qq', conversationId: '456', kind: 'group' },
    payload,
    idempotencyKey: `wait-${Math.random().toString(36).slice(2)}`,
  };
}

const messageEvent = (id, text) => ({
  self_id: 999,
  user_id: 789,
  message_id: id,
  message: [{ type: 'text', data: { text } }],
  raw_message: text,
  sender: { nickname: '群友', card: '群友' },
});

async function fixture(run) {
  const h = await bridgeHarness({
    config: {
      // 网关模式：投递走 fakeFetch，测试从 calls.http 断言信封。
      gateway: {
        mode: 'on', url: 'http://gateway.invalid', adapterId: 'qq-main',
        secret: SECRET, conversations: [`qq:${KEY}`],
      },
      socialV2: { enabled: true, wake: { batchWindowMs: 1000 }, wait: { minMs: 100, maxMs: 600000 } },
    },
  });
  const st = h.getSocialV2State(KEY);
  st.bootstrapSent = true;          // 跳过首次引导唤醒
  st.wakeConfig.triggers = {};      // 常规触发全部关闭：只有 wait 能叫醒模型
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run({ h, st, port: server.address().port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

function inboundPosts(h) {
  return h.calls.http.filter((entry) => entry.url.endsWith('/v1/inbound'));
}

test('wait：登记即返回；新消息在触发全关时仍强制唤醒，并以合成事件回推', async () => {
  await fixture(async ({ h, st, port }) => {
    const before = Date.now();
    const registered = await postAction(port, waitEnvelope({ minNewMessages: 1, timeoutMs: 60000 }));
    assert.equal(registered.status, 200);
    assert.equal(registered.body.ok, true, JSON.stringify(registered.body));
    assert.equal(registered.body.data.registered, true);
    assert.equal(registered.body.data.baselineSeq, 0, '基线=登记那一刻的未读水位');
    assert.ok(registered.body.data.expiresAt >= before + 59000);

    // 新消息：常规触发为空，但登记满足 → 必须排唤醒。
    await h.handleIncoming('group', '456', messageEvent(11, '我回来了'), h.cfg);
    assert.ok(st.pendingWakeTimer, 'wait 登记应当强制唤醒（即使 @/关键词/概率都不命中）');

    // 让唤醒立即发生（跳过合批窗口），观察投给网关的信封。
    clearTimeout(st.pendingWakeTimer);
    st.pendingWakeTimer = null;
    await h.sendWakePromptV2(KEY, 'wait');

    const posts = inboundPosts(h);
    assert.equal(posts.length, 1, '应当只投一张唤醒事件（不重复开 turn）');
    const envelope = posts[0].body;
    assert.equal(envelope.kind, 'event');
    assert.deepEqual(
      {
        kind: envelope.wake.kind,
        status: envelope.wake.status,
        baselineSeq: envelope.wake.baselineSeq,
        satisfiedSeq: envelope.wake.satisfiedSeq,
      },
      { kind: 'wait', status: 'arrived', baselineSeq: 0, satisfiedSeq: 1 },
    );
    assert.equal(envelope.prompt, undefined, '合成事件的 prompt 由网关拼，适配器不送终稿');
    assert.match(envelope.message.id, /^wait-[a-z0-9]+-\d+$/, 'id 带时间戳，重启后不会撞网关幂等键');
    assert.match(envelope.message.text, /等待回推：登记后新增 1 条消息/);
    assert.equal(envelope.snapshot?.length, 1);
    assert.equal(envelope.snapshot[0].text, '我回来了');
    assert.equal(envelope.conversation.id, '456');

    // 登记一次性作废：下一条消息（触发仍全关）不再唤醒。
    await h.handleIncoming('group', '456', messageEvent(12, '还有吗'), h.cfg);
    assert.equal(st.pendingWakeTimer, null, '已回推的登记不得再次唤醒');
  });
});

test('wait：minNewMessages 未满足时不唤醒；达到阈值才推', async () => {
  await fixture(async ({ h, st, port }) => {
    await postAction(port, waitEnvelope({ minNewMessages: 2, timeoutMs: 60000 }));

    await h.handleIncoming('group', '456', messageEvent(21, '第一条'), h.cfg);
    assert.equal(st.pendingWakeTimer, null, '只来一条时不得唤醒');

    await h.handleIncoming('group', '456', messageEvent(22, '第二条'), h.cfg);
    assert.ok(st.pendingWakeTimer, '达到 minNewMessages 后必须唤醒');

    clearTimeout(st.pendingWakeTimer);
    st.pendingWakeTimer = null;
    await h.sendWakePromptV2(KEY, 'wait');
    const envelope = inboundPosts(h)[0].body;
    assert.equal(envelope.wake.satisfiedSeq, 2);
    assert.equal(envelope.snapshot.length, 2);
  });
});

test('wait：社交已暂停时如实拒绝登记', async () => {
  await fixture(async ({ h, port }) => {
    const { socialV2 } = h;
    socialV2.paused = true;
    const paused = await postAction(port, waitEnvelope());
    assert.equal(paused.body.ok, false);
    assert.equal(paused.body.error.code, 'E_UNSUPPORTED');
    assert.match(paused.body.error.message, /paused/);
    socialV2.paused = false;
  });
});

test('wait：网关投递失败时登记保留（不静默丢失，下次唤醒继续回推）', async () => {
  await fixture(async ({ h, st, port }) => {
    await postAction(port, waitEnvelope({ minNewMessages: 1 }));
    await h.handleIncoming('group', '456', messageEvent(31, '在吗'), h.cfg);
    assert.ok(st.pendingWakeTimer);

    clearTimeout(st.pendingWakeTimer);
    st.pendingWakeTimer = null;
    h.setHttpFails(true);
    await h.sendWakePromptV2(KEY, 'wait');
    assert.equal(inboundPosts(h).length, 0, '网关不可达：不投信封');
    const kept = h.waitRegistry.peek(KEY);
    assert.ok(kept, '投递失败不得消费登记');
    assert.equal(kept.baselineSeq, 0);
    h.setHttpFails(false);
  });
});
