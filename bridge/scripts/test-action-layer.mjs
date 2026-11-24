// 共享动作层（桥接侧集成）：真跑 bridge.js（审计脚手架 VM）。
// 钉住的链路：
//   1. GET /v1/actions/manifest 逐条输出 enabled（实现覆盖 + configFlag 现算），
//      UI 与网关据此注册工具面，不再出现「清单有、必失败」的条目；
//   2. POST /v1/actions 的清单动作走进程内合成请求复用 /api/socialV2/*，
//      读写动作都能拿到真实结果（不是 200 + 空壳）；
//   3. 未实现的动作（get_history/list_groups）如实回 E_UNSUPPORTED。
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const SECRET = 'action-layer-secret-0123456789';
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

function request(port, method, path, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method, headers: signedHeaders(body),
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`${method} ${path} hung`)));
    req.end(body || undefined);
  });
}

const envelope = (type, payload = {}) => ({
  v: 1,
  actionId: `${type}-${Math.random().toString(36).slice(2)}`,
  turnId: 'turn_layer',
  type,
  target: { platform: 'qq', conversationId: '456', kind: 'group' },
  payload,
  idempotencyKey: `${type}-${Math.random().toString(36).slice(2)}`,
});

async function fixture(run) {
  const h = await bridgeHarness({
    config: {
      gateway: {
        mode: 'on', url: 'http://gateway.invalid', adapterId: 'qq-main',
        secret: SECRET, conversations: [`qq:${KEY}`],
      },
      socialV2: { enabled: true, wake: { batchWindowMs: 1000 }, wait: { minMs: 100, maxMs: 600000 } },
    },
  });
  const st = h.getSocialV2State(KEY);
  st.bootstrapSent = true;
  st.wakeConfig.triggers = {};
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run({ h, st, port: server.address().port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

test('manifest：enabled 现算（已实现为 true，未实现为 false）', async () => {
  await fixture(async ({ port }) => {
    const res = await request(port, 'GET', '/v1/actions/manifest');
    assert.equal(res.status, 200);
    const byType = new Map(res.body.actions.map((entry) => [entry.type, entry]));
    for (const type of ['send_message', 'send_text', 'reply', 'mark_read', 'poke',
      'get_unread', 'get_prompt', 'social_state', 'set_wake']) {
      assert.equal(byType.get(type)?.enabled, true, `${type} 必须可用`);
    }
    // send_sticker 等 sticker 工具族已物理删除（2026-11-24）：清单中不应再有条目
    assert.equal(byType.get('send_sticker'), undefined, 'send_sticker 已从清单物理删除');
    for (const type of ['get_history', 'list_groups']) {
      assert.equal(byType.get(type)?.enabled, false, `${type} 未实现，必须 enabled:false`);
    }
  });
});

test('动作：清单动作走内部路由拿到真实结果（读 + 写）', async () => {
  await fixture(async ({ port }) => {

    const promptRes = await request(port, 'POST', '/v1/actions', envelope('get_prompt'));
    assert.equal(promptRes.body.ok, true, JSON.stringify(promptRes.body));

    const stateRes = await request(port, 'POST', '/v1/actions', envelope('social_state'));
    assert.equal(stateRes.body.ok, true, JSON.stringify(stateRes.body));

    const unreadRes = await request(port, 'POST', '/v1/actions', envelope('get_unread', { limit: 5 }));
    assert.equal(unreadRes.body.ok, true, JSON.stringify(unreadRes.body));

    const sendRes = await request(port, 'POST', '/v1/actions', envelope('send_text', { text: '你好' }));
    assert.equal(sendRes.body.ok, true, JSON.stringify(sendRes.body));
    assert.equal(sendRes.body.actionId, sendRes.body.actionId);
  });
});

test('动作：未实现的条目如实回 E_UNSUPPORTED，不静默成功', async () => {
  await fixture(async ({ port }) => {
    const res = await request(port, 'POST', '/v1/actions', envelope('get_history', { limit: 1 }));
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'E_UNSUPPORTED');
    assert.match(res.body.error.message, /not enabled/);
  });
});
