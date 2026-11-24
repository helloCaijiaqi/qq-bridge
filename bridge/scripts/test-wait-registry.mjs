// wait 挂起登记（纯状态机）单测：基线/阈值/一次性消费/过期/覆盖语义 + 动作回执。
import assert from 'node:assert/strict';
import test from 'node:test';

const { createWaitAction, createWaitRegistry } = await import(new URL('../src/gateway/wait-registry.js', import.meta.url).href);

const START = 1_700_000_000_000;

function clock(start = START) {
  let now = start;
  return {
    now: () => now,
    advance(ms) { now += ms; },
  };
}

test('登记：基线快照 + 新消息阈值，未满足不消费', () => {
  const time = clock();
  const registry = createWaitRegistry({ now: time.now });
  const entry = registry.register({ key: 'group:456', payload: { minNewMessages: 2, timeoutMs: 60_000 }, baselineSeq: 7 });

  assert.equal(entry.baselineSeq, 7);
  assert.equal(entry.minNewMessages, 2);
  assert.equal(entry.purpose, 'messages');
  assert.equal(entry.expiresAt, START + 60_000);

  // 注册前就存在的未读不算：水位没动 = 没满足。
  assert.deepEqual(registry.progress('group:456', 7), { entry, observed: 0, satisfied: false });
  // 一条新消息：还差一条。
  assert.equal(registry.progress('group:456', 8).satisfied, false);
  assert.equal(registry.consume('group:456', 8), null, '未满足的登记不能被投递消费');
  assert.equal(registry.peek('group:456').baselineSeq, 7, '未满足时登记保留');
  // 两条新消息：满足，可消费；消费后即消失（一次性）。
  assert.equal(registry.consume('group:456', 9).satisfiedSeq, 9);
  assert.equal(registry.peek('group:456'), null);
  assert.equal(registry.consume('group:456', 10), null);
});

test('覆盖语义：同会话只保留最新一条登记', () => {
  const time = clock();
  const registry = createWaitRegistry({ now: time.now });
  time.advance(100);
  const first = registry.register({ key: 'group:1', payload: { timeoutMs: 10_000 }, baselineSeq: 1 });
  time.advance(100);
  const second = registry.register({ key: 'group:1', payload: { timeoutMs: 20_000 }, baselineSeq: 5 });

  assert.equal(second.replaced, true);
  assert.equal(first.expiresAt, START + 10_100);
  assert.equal(registry.peek('group:1').baselineSeq, 5, '以最新登记的基线为准');
  assert.equal(registry.size(), 1);
});

test('过期：读取路径惰性清理，过期后既不满足也不消费', () => {
  const time = clock();
  const registry = createWaitRegistry({ now: time.now, defaultTimeoutMs: 30_000 });
  registry.register({ key: 'group:2', payload: {}, baselineSeq: 0 });

  time.advance(29_999);
  assert.equal(registry.progress('group:2', 1).satisfied, true);
  time.advance(1);
  assert.equal(registry.peek('group:2'), null);
  assert.equal(registry.progress('group:2', 5), null);
  assert.equal(registry.consume('group:2', 5), null);
  assert.equal(registry.size(), 0);
});

test('入参夹紧：超时/条数/静默窗与 purpose 枚举', () => {
  const registry = createWaitRegistry({ now: () => START });

  const tiny = registry.register({ key: 'a:1', payload: { timeoutMs: 1, minNewMessages: 0, quietMs: -5, purpose: 'nonsense' } });
  assert.equal(tiny.timeoutMs, 5_000, '低于 minTimeoutMs 夹到下限');
  assert.equal(tiny.minNewMessages, 1);
  assert.equal(tiny.quietMs, 0);
  assert.equal(tiny.purpose, 'messages', '未知 purpose 回落 messages');

  const huge = registry.register({ key: 'a:2', payload: { timeoutMs: 10_000_000, minNewMessages: 999, quietMs: 10_000_000, purpose: 'reply' } });
  assert.equal(huge.timeoutMs, 600_000);
  assert.equal(huge.minNewMessages, 50);
  assert.equal(huge.quietMs, 60_000);
  assert.equal(huge.purpose, 'reply');

  assert.throws(() => registry.register({ key: '' }), /key is required/);
});

test('createWaitAction：登记即返回回执，guard 拒绝时如实报错', async () => {
  const registry = createWaitRegistry({ now: () => START });
  const registered = [];
  const wait = createWaitAction({
    registry,
    guard: () => (registry.size() >= 2 ? 'too many waits' : null),
    baselineOf: () => 40,
    onRegister: (entry) => registered.push(entry),
  });

  const ok = await wait({ key: 'group:456', payload: { purpose: 'reply', minNewMessages: 3, quietMs: 1000 } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.data, {
    registered: true,
    key: 'group:456',
    purpose: 'reply',
    baselineSeq: 40,
    minNewMessages: 3,
    expiresAt: START + 30_000,
  });
  assert.equal(registered.length, 1, '登记后要挂过期定时器（桥接侧副作用）');

  await wait({ key: 'group:457', payload: {} });
  const rejected = await wait({ key: 'group:458', payload: {} });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'E_UNSUPPORTED');
  assert.match(rejected.error.message, /too many waits/);
  assert.equal(registry.size(), 2, '被拒绝的登记不入册');
});
