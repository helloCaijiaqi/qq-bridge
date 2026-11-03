// 外部服务客户端（memory-mcp / rolecard-mcp）的行为覆盖。
//
// 这里钉住的是**降级语义**，比"能连上"更重要：
//   · 取段失败必须返回空串 —— 桥接靠空串判断"回落到本地"，抛错或返回假内容都会出事；
//   · 连续失败后必须熔断 —— 注入点在每条消息的投递热路径上，服务没起时不该每次都等超时；
//   · 删除/清空镜像必须真的落到服务端 —— 否则会出现"本地删了、提示词里还在"的静默不一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createMemoryClient, toSessionId } from '../src/memory-client.js';
import { createRolecardClient } from '../src/rolecard-client.js';

// 起一个记录型回环服务：既当"可用的外部服务"，也用来断言客户端到底发了什么。
async function startServer(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
    seen.push({
      path: new URL(req.url ?? '/', 'http://127.0.0.1').pathname,
      token: req.headers['x-mcp-token'] ?? null,
      args: body ? JSON.parse(body) : {},
    });
    try {
      const result = await handler(seen[seen.length - 1]);
      const payload = JSON.stringify(result ?? {});
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    } catch (error) {
      res.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    seen,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const noLog = () => {};

test('会话 key → 平台中性 sessionId（只认 group / private，其它一律不映射）', () => {
  assert.equal(toSessionId('group:123456'), 'qq:group:123456');
  assert.equal(toSessionId('private:10001'), 'qq:private:10001');
  // 无法识别的 key 必须返回 null：宁可不写外部服务，也不能造出一个错误的 sessionId
  // 把 A 群的记忆串到别的会话上去。
  assert.equal(toSessionId('123456'), null);
  assert.equal(toSessionId(''), null);
  assert.equal(toSessionId('weird:1'), null);
});

test('取段成功：按块名拿到【记忆】与【黑话】', async () => {
  const server = await startServer(() => ({
    blocks: [
      { name: '记忆', text: '【记忆】\n长期记忆：\n- 长期·印象：小明爱熬夜', chars: 20 },
      { name: '黑话', text: '【群聊黑话表】\n- 寄：完蛋了', chars: 12 },
    ],
  }));
  try {
    const client = createMemoryClient({ env: { MEMORY_MCP_URL: server.url }, logger: noLog });
    const got = await client.renderBlocks({ key: 'group:42', maxChars: 1000 });
    assert.equal(got.memory, '【记忆】\n长期记忆：\n- 长期·印象：小明爱熬夜');
    assert.equal(got.slang, '【群聊黑话表】\n- 寄：完蛋了');
    // sessionId 必须是中性格式：服务端不该看到 QQ 内部的 key 写法。
    assert.equal(server.seen[0].args.sessionId, 'qq:group:42');
  } finally {
    await server.close();
  }
});

test('无法映射的 key 直接跳过外部服务（不发请求）', async () => {
  const server = await startServer(() => ({ blocks: [] }));
  try {
    const client = createMemoryClient({ env: { MEMORY_MCP_URL: server.url }, logger: noLog });
    const got = await client.renderBlocks({ key: '123456' });
    assert.deepEqual(got, { memory: '', slang: '' });
    assert.equal(server.seen.length, 0);
  } finally {
    await server.close();
  }
});

test('服务端报错 / 连不上：返回空串而不是抛错，连续失败后熔断', async () => {
  const server = await startServer(() => { const e = new Error('boom'); e.status = 500; throw e; });
  try {
    const client = createMemoryClient({ env: { MEMORY_MCP_URL: server.url }, logger: noLog });
    const got = await client.renderSlang({});
    assert.equal(got, '', '失败必须回落为空串，由桥接判断"用本地实现"');
    assert.equal(await client.renderSlang({}), '');
    assert.equal(await client.renderSlang({}), '');
    assert.equal(client.available(), false, '连续失败 3 次后应打开熔断');
    const before = server.seen.length;
    assert.equal(await client.renderSlang({}), '');
    assert.equal(server.seen.length, before, '熔断期内不应再发请求');
  } finally {
    await server.close();
  }
});

test('本地令牌随请求发出（服务端是带鉴权的回环接口）', async () => {
  const server = await startServer(() => ({ rows: [], blocks: [] }));
  try {
    const client = createMemoryClient({ env: { MEMORY_MCP_URL: server.url, MEMORY_MCP_TOKEN: 'tok-123' }, logger: noLog });
    await client.renderSlang({});
    assert.equal(server.seen[0].token, 'tok-123');
  } finally {
    await server.close();
  }
});

test('显式关掉开关后完全不发请求', async () => {
  const server = await startServer(() => ({ blocks: [] }));
  try {
    const client = createMemoryClient({ env: { MEMORY_MCP_URL: server.url, MEMORY_MCP_ENABLED: '0' }, logger: noLog });
    assert.equal(client.available(), false);
    assert.deepEqual(await client.renderBlocks({ key: 'group:1' }), { memory: '', slang: '' });
    assert.equal(server.seen.length, 0);
  } finally {
    await server.close();
  }
});

test('写入镜像：群友印象进长期、带名字前缀；待说的话带过期时间', async () => {
  const server = await startServer(() => ({ id: 'm1' }));
  try {
    const client = createMemoryClient({ env: { MEMORY_MCP_URL: server.url }, logger: noLog });
    await client.mirrorAppend({ key: 'group:7', category: 'memberImpression', content: '爱熬夜', extra: { target: '小明' } });
    assert.equal(server.seen[0].path, '/api/memory/append');
    assert.equal(server.seen[0].args.tier, 'long');
    assert.equal(server.seen[0].args.content, '小明：爱熬夜');

    await client.mirrorAppend({ key: 'group:7', category: 'pendingThought', content: '想问他周末去哪', extra: { expiresAtMs: 60000 } });
    assert.equal(server.seen[1].args.tier, 'short');
    assert.ok(server.seen[1].args.expiresAt > Date.now(), 'pendingThought 必须带过期时间');
  } finally {
    await server.close();
  }
});

test('删除镜像：只删真正命中的那条（群友印象按「名字：」前缀比对）', async () => {
  const rows = [
    { id: 'a', category: 'activeTopic', content: '在聊新番' },
    { id: 'b', category: 'memberImpression', content: '小明：爱熬夜' },
    { id: 'c', category: 'memberImpression', content: '小红：爱早起' },
  ];
  const forgotten = [];
  const server = await startServer((req) => {
    if (req.path === '/api/memory/query') return { rows };
    if (req.path === '/api/memory/forget') {
      forgotten.push(req.args);
      return { removed: true };
    }
    return {};
  });
  try {
    const client = createMemoryClient({ env: { MEMORY_MCP_URL: server.url }, logger: noLog });
    const removed = await client.mirrorRemove({ key: 'group:7', category: 'memberImpression', target: '小明' });
    assert.equal(removed, 1);
    assert.deepEqual(forgotten, [{ id: 'b', mode: 'hard' }]);

    forgotten.length = 0;
    const removed2 = await client.mirrorRemove({ key: 'group:7', category: 'activeTopic', content: '不在聊的' });
    assert.equal(removed2, 0, '内容不匹配的不能误删');
    assert.equal(forgotten.length, 0);
  } finally {
    await server.close();
  }
});

test('清空镜像：带 category 时只清该类，不带则全清', async () => {
  const rows = [
    { id: 'a', category: 'activeTopic' },
    { id: 'b', category: 'pendingThought' },
  ];
  let forgotten = [];
  const server = await startServer((req) => {
    if (req.path === '/api/memory/query') return { rows };
    if (req.path === '/api/memory/forget') { forgotten.push(req.args.id); return { removed: true }; }
    return {};
  });
  try {
    const client = createMemoryClient({ env: { MEMORY_MCP_URL: server.url }, logger: noLog });
    assert.equal(await client.mirrorClear({ key: 'group:7', category: 'activeTopic' }), 1);
    assert.deepEqual(forgotten, ['a']);
    forgotten = [];
    assert.equal(await client.mirrorClear({ key: 'group:7' }), 2);
    assert.deepEqual(forgotten, ['a', 'b']);
  } finally {
    await server.close();
  }
});

test('人格段：一次取回 v1 / v2，取不到就是空串', async () => {
  const server = await startServer((req) => ({
    blocks: [{ name: '人格', text: `【人格】${req.args.mode}`, chars: 8 }],
  }));
  try {
    const client = createRolecardClient({ env: { ROLECARD_MCP_URL: server.url }, logger: noLog });
    const got = await client.renderBoth({ maxChars: 500 });
    assert.equal(got.v1, '【人格】v1');
    assert.equal(got.v2, '【人格】v2');
  } finally {
    await server.close();
  }
});

test('人格段：服务不可用时回落空串并熔断（桥接据此用本地人格卡）', async () => {
  const client = createRolecardClient({ env: { ROLECARD_MCP_URL: 'http://127.0.0.1:1' }, logger: noLog });
  assert.equal(await client.renderBlock({ mode: 'v1' }), '');
  assert.equal(await client.renderBlock({ mode: 'v1' }), '');
  assert.equal(await client.renderBlock({ mode: 'v1' }), '');
  assert.equal(client.available(), false);
});
