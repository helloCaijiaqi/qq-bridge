// wake-synthetic（桥接侧）：主动唤醒改投合成事件走 /v1/inbound。
//
// 钉住的链路（真跑 bridge.js，审计脚手架 VM）：
//   1. proactive 唤醒信封是 kind=event + wake.kind=proactive，**不带 prompt 终稿**，
//      快照随信封走（prompt 由网关合成），message.id 带时间戳（重启不撞幂等键）；
//   2. 路由会话的唤醒不再本地提交 prompt（calls.prompts 为空）；
//   3. 网关失败 = 如实失败 + 回滚唤醒记账（wakeTimes 回退、有限潜水恢复原状），
//      没有「落回本地」分支；
//   4. 未路由会话（白名单未命中）仍走本地路径——GATEWAY_MODE=off 的回滚形态没被误伤。
import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const SECRET = 'wake-synthetic-secret-0123456789';
const KEY = 'group:456';

const messageEvent = (id, text) => ({
  self_id: 999,
  user_id: 789,
  message_id: id,
  message: [{ type: 'text', data: { text } }],
  raw_message: text,
  sender: { nickname: '群友', card: '群友' },
});

async function fixture(opts, run) {
  if (typeof opts === 'function') {
    run = opts;
    opts = {};
  }
  const { conversations = [`qq:${KEY}`] } = opts ?? {};
  const h = await bridgeHarness({
    config: {
      gateway: {
        mode: 'on', url: 'http://gateway.invalid', adapterId: 'qq-main',
        secret: SECRET, conversations,
      },
      socialV2: { enabled: true, wake: { batchWindowMs: 1000 } },
    },
  });
  const st = h.getSocialV2State(KEY);
  st.bootstrapSent = true;       // 跳过首次引导唤醒
  st.wakeConfig.triggers = {};   // 常规触发全关：唤醒路径只由测试手动触发
  try {
    await run({ h, st });
  } finally {
    await h.close();
  }
}

function inboundPosts(h) {
  return h.calls.http.filter((entry) => entry.url.endsWith('/v1/inbound'));
}

test('proactive：投合成事件（kind=event + wake=proactive），不本地提交 prompt', async () => {
  await fixture(async ({ h, st }) => {
    await h.handleIncoming('group', '456', messageEvent(41, '今天没人说话'), h.cfg);
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }

    await h.sendWakePromptV2(KEY, 'proactiveCheck');

    const posts = inboundPosts(h);
    assert.equal(posts.length, 1, '一次唤醒只投一张事件');
    const envelope = posts[0].body;
    assert.equal(envelope.kind, 'event');
    assert.deepEqual(
      { kind: envelope.wake.kind, status: envelope.wake.status },
      { kind: 'proactive', status: 'arrived' },
    );
    assert.equal(envelope.prompt, undefined, 'prompt 终稿由网关合成，适配器不再送');
    assert.match(envelope.message.id, /^wake-[a-z0-9]+-\d+$/, 'id 带时间戳，重启后不会撞网关幂等键');
    assert.match(envelope.message.text, /主动唤醒：主动机会/);
    assert.equal(envelope.conversation.id, '456');
    assert.ok(Array.isArray(envelope.snapshot) && envelope.snapshot.length >= 1, '快照必须随信封走');
    assert.equal(h.calls.prompts.length, 0, '路由会话不得再走本地 prompt 提交');
  });
});

test('proactive：网关失败 = 如实失败 + 回滚唤醒记账，不落回本地', async () => {
  await fixture(async ({ h, st }) => {
    // 有限潜水形态：失败回滚必须把 sleepUntil 与定时器恢复原状（否则会话停在
    // 「sleepUntil 已过期、没有任何定时器」的静默态）。
    const sleepUntil = new Date(Date.now() + 3600_000).toISOString();
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = sleepUntil;
    const wakeTimesBefore = [...st.wakeTimes];
    const wakeCountBefore = st.wakeConfig.wakeCount;

    h.setHttpFails(true);
    await h.sendWakePromptV2(KEY, 'proactiveCheck');

    assert.equal(inboundPosts(h).length, 0, '网关不可达：不投信封');
    assert.equal(h.calls.prompts.length, 0, '网关失败也不得本地提交（无回退分支）');
    // 状态数组来自 VM realm：展开成本地数组再比（原型不同会让 deepEqual 误判）。
    assert.deepEqual([...st.wakeTimes], wakeTimesBefore, '失败必须回滚 wakeTimes');
    assert.equal(st.wakeConfig.sleepUntil, sleepUntil, '有限潜水必须恢复原状');
    assert.ok(st.sleepTimer, '有限潜水的定时器必须重新挂上');
    assert.notEqual(st.wakeConfig.wakeCount, wakeCountBefore, '这里只验证记账结构，不做次数语义断言');
    h.setHttpFails(false);
  });
});

test('网关白名单未命中（routed:false）：如实失败，不落回本地', async () => {
  await fixture(async ({ h, st }) => {
    const wakeTimesBefore = [...st.wakeTimes];
    h.setInboundRouted(false);
    await h.sendWakePromptV2(KEY, 'proactiveCheck');
    assert.equal(inboundPosts(h).length, 1, '仍然尝试投网关（白名单由网关裁决）');
    assert.equal(h.calls.prompts.length, 0, '未路由也不得本地提交');
    assert.deepEqual([...st.wakeTimes], wakeTimesBefore, '未路由必须回滚唤醒记账');
    h.setInboundRouted(true);
  });
});

test('actions 投递：真实消息走 /v1/inbound（带平台 id/seq/角色），不碰本地会话', async () => {
  await fixture(async ({ h, st }) => {
    st.lastUnreadSeq = 7; // 未读游标：网关 mailbox 用它推进 readThroughSeq
    const result = await h.deliverInboundViaGateway(KEY, {
      kind: 'group',
      event: messageEvent(42, '在吗'),
      text: '群友：在吗',
      isOwner: false,
      media: [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.turnId, 'fixture-turn'); // 假网关回执（见 fakeFetch）
    const posts = inboundPosts(h);
    assert.equal(posts.length, 1);
    const envelope = posts[0].body;
    assert.equal(envelope.kind, undefined, '真实消息不是合成事件');
    assert.equal(envelope.prompt, undefined, 'prompt 由网关合成，桥接不送终稿');
    assert.equal(envelope.message.id, '42');
    assert.equal(envelope.message.seq, 7);
    assert.deepEqual([...envelope.message.sender.roles], ['member']);
    assert.equal(envelope.conversation.kind, 'group');
    assert.equal(envelope.conversation.id, '456');
    assert.match(envelope.message.text, /在吗/);
    assert.equal(h.calls.prompts.length, 0, '不提交本地 prompt');
    assert.equal(h.calls.created.length, 0, '不建本地 DSH 会话');
  });
});

test('actions 投递：网关不可达 = ok:false（如实失败，不落回本地）', async () => {
  await fixture(async ({ h }) => {
    h.setHttpFails(true);
    const result = await h.deliverInboundViaGateway(KEY, {
      kind: 'group',
      event: messageEvent(43, '有人吗'),
      text: '群友：有人吗',
      isOwner: false,
      media: [],
    });
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(h.calls.prompts.length, 0);
    h.setHttpFails(false);
  });
});

test('路由会话 + 媒体：显式失败，不偷偷落回本地', async () => {
  await fixture(async ({ h }) => {
    await assert.rejects(
      () => h.deliverPrompt(KEY, { wakeReason: 'proactiveCheck', media: [{ type: 'image', ref: 'https://public.invalid/a.png' }] }),
      /唤醒投递不支持媒体/,
    );
    assert.equal(h.calls.prompts.length, 0);
  });
});
