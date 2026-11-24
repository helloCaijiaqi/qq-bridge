// 生命周期韧性：bootstrap 投递成功才置真、按会话发送链不互相卡死、
// SnowLuma 配置原子写（tmp+rename，BOM 保留）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { persistSnowLumaEndpoint } from '../src/integrations/snowluma-conn.js';
import { isAclDeniedOutput } from '../src/ops/state-acl.mjs';

test('bootstrap 标记：投递失败保持 false，成功后置真', async () => {
  // sendDelayMs=0：发送链不用等拟人间隔，测试才跑得快。
  const bridge = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    // 用「网关明确未路由」注入投递失败：HTTP 通路本身是健康的（health 缓存不会
    // 干扰下一次调用），只是这一条 inbound 没被受理 → deliverViaGateway 返回 false。
    bridge.setInboundRouted(false);
    await bridge.sendWakePromptV2('group:456', 'bootstrap');
    assert.equal(
      bridge.getSocialV2State('group:456').bootstrapSent,
      false,
      '投递失败不能标记引导已完成（否则永久错过 bootstrap 提示词）',
    );

    bridge.setInboundRouted(true);
    await bridge.sendWakePromptV2('private:123', 'bootstrap');
    assert.equal(bridge.getSocialV2State('private:123').bootstrapSent, true);
  } finally {
    await bridge.close();
  }
});

test('发送链：一条失败不卡死同会话后续消息', async () => {
  const bridge = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    const original = bridge.bot.sendGroupMessage;
    bridge.bot.sendGroupMessage = async () => { throw new Error('onebot down'); };
    await bridge.sendToQQ('group:456', '这条会失败');
    bridge.bot.sendGroupMessage = original;

    await bridge.sendToQQ('group:456', '失败之后仍要发出');
    const texts = bridge.calls.sent.map((item) => item.text);
    assert.ok(texts.includes('失败之后仍要发出'), '链尾吞错后，该会话后续消息仍能发送');
  } finally {
    await bridge.close();
  }
});

test('发送链：同会话保序，不同会话各自独立完成', async () => {
  const bridge = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    await Promise.all([
      bridge.sendToQQ('group:456', '群消息一'),
      bridge.sendToQQ('group:456', '群消息二'),
      bridge.sendToQQ('private:123', '私聊消息一'),
    ]);
    const groupTexts = bridge.calls.sent.filter((i) => i.kind === 'group').map((i) => i.text);
    assert.deepEqual(groupTexts, ['群消息一', '群消息二'], '同会话严格保序');
    assert.ok(bridge.calls.sent.some((i) => i.kind === 'private' && i.text === '私聊消息一'));
  } finally {
    await bridge.close();
  }
});

test('ACL 失败检测：中文/日文 Windows 的 icacls 输出也要识别', () => {
  assert.equal(isAclDeniedOutput('Successfully processed 1 files; Failed processing 0 files'), false);
  assert.equal(isAclDeniedOutput('C:\\x: Access is denied.'), true);
  assert.equal(isAclDeniedOutput('C:\\x: 拒绝访问。'), true);
  assert.equal(isAclDeniedOutput('C:\\x: アクセスが拒否されました。'), true);
  // 只含 "denied" 的其它文本不该被误判（例如被拒绝的 ACE 描述）。
  assert.equal(isAclDeniedOutput('No mapping between account names'), false);
});

test('SnowLuma 配置：tmp+rename 原子写，BOM 与其它字段原样保留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-persist-'));
  const cfgPath = path.join(dir, 'config.json');
  const original = { consolePort: 3100, snowluma: { accessToken: 'old', wsUrl: 'ws://old' }, keep: { a: 1 } };
  fs.writeFileSync(cfgPath, `\uFEFF${JSON.stringify(original, null, 2)}\n`, 'utf8');

  const result = persistSnowLumaEndpoint(cfgPath, { accessToken: 'new-token', httpUrl: 'http://127.0.0.1:3000' });
  assert.equal(result.updated, true);
  assert.equal(result.changed.accessToken.from, 'old');
  assert.equal(result.changed.accessToken.to, 'new-token');

  const raw = fs.readFileSync(cfgPath, 'utf8');
  assert.equal(raw.charCodeAt(0), 0xFEFF, 'BOM 必须保留（否则整文件在 git 里变成重写）');
  const parsed = JSON.parse(raw.slice(1));
  assert.equal(parsed.snowluma.accessToken, 'new-token');
  assert.equal(parsed.snowluma.httpUrl, 'http://127.0.0.1:3000');
  assert.equal(parsed.snowluma.wsUrl, 'ws://old', '未传的字段不动');
  assert.deepEqual(parsed.keep, { a: 1 }, 'snowluma 之外的配置不动');
  // 临时文件不能残留（rename 成功即消失）。
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);

  // 幂等：值一致时不写文件。
  assert.equal(persistSnowLumaEndpoint(cfgPath, { accessToken: 'new-token' }).updated, false);
});
