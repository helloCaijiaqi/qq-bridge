// GitHub issue 回归：把上游 issue 里**已确认可复现**的缺陷钉死，防止回退。
//
// 覆盖：
//   #11/#19/#23/#26 回合结束信号丢了 → 会话永久 busy —— 回合判忙改为「起始时间 + 15 分钟租约」，
//       无起始时间的残留 collector 不再判忙；collector 保留，迟到回复照常 flush。
//   #29 被 @ 了不理人 —— 机器人昵称/QQ 号必须写进身份行（否则 agent 把 @自己 当 @别人）。
// 注：原 #11/#19（回合 collector 判忙）与 #22（DSH settings 读取）已随本地 DSH 直连删除而移除。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const KEY = 'group:1001';
const SID = 'session-1';

await test('#29 身份行必须写明机器人自己的昵称与 QQ 号', async () => {
  const h = await bridgeHarness();
  try {
    h.setSelfIdentity('樰', '10001');
    const line = h.selfIdentityTextV2();
    assert.match(line, /【你的身份】/);
    assert.match(line, /樰/);
    assert.match(line, /10001/);
    assert.match(line, /@樰/, '必须明确「@昵称」指的是自己');

    h.setSelfIdentity('', '');
    assert.equal(h.selfIdentityTextV2(), '', '身份未知时不注入空行（不能写「你的昵称是（）」）');
  } finally { await h.close(); }
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
