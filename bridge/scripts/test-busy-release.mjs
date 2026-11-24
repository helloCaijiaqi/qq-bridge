// 「回合结束释放 busy 标记」接线测试（2026-11-17 busy-flag-release-on-turn-end）。
//
// 验证两端源码级接线（与 test-snowluma-conn 同一形态——bridge.js 是 443KB 单文件
// 闭包，行为级单测成本过高；接线完整性 + 关键防御分支用源码断言锁定）：
// 1. bridge：onNotify 收 turn/status → 映射本地 key → releasePendingWake；
// 2. releasePendingWake：删标志 + 解租约 + 调回放（replay 不再是死代码）；
// 3. running 状态不触发释放；租约缩到 2 分钟并留兜底日志；
// 4. gateway-client：turn/status 分支存在且透传 onNotify（缺省 null 安全）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const client = fs.readFileSync(path.join(ROOT, 'src', 'gateway', 'gateway-client.js'), 'utf8');

let failed = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { console.error(`❌ ${label}`); failed = 1; }
}

// 1. gateway-client 分发接线
ok(client.includes("case 'turn/status':"), 'gateway-client：turn/status 分支已接线');
ok(client.includes('onNotify?.(message)'), 'gateway-client：透传 onNotify（缺省 null 安全）');
ok(client.includes('onNotify = null,'), 'gateway-client：onNotify 是可选工厂参数（旧调用方兼容）');

// 2. bridge：onNotify 处理与 key 映射
ok(bridge.includes('onNotify: (message) => {'), 'bridge：gatewayClient 挂了 onNotify');
ok(bridge.includes("if (message?.type !== 'turn/status') return;"), 'bridge：非 turn/status 帧直接忽略');
ok(bridge.includes("if (status === 'running') return;"), 'bridge：running 状态不触发释放');
ok(bridge.includes('parts.slice(-2).join(\':\')'), 'bridge：网关 sessionKey → 本地 key 映射（qq:[svc:]kind:id → kind:id）');

// 3. releasePendingWake 三件事
ok(bridge.includes('function releasePendingWake(key) {'), 'bridge：releasePendingWake 已定义');
ok(/function releasePendingWake\(key\) \{[\s\S]{0,600}pendingWakeKeys\.delete\(key\);[\s\S]{0,400}disarmPendingWakeLease\(key\);/.test(bridge),
  'releasePendingWake：删标志 + 解除租约');
const replayCalls = (bridge.match(/replayPendingWakeReasonsV2\(/g) ?? []).length;
ok(replayCalls >= 2, `回放函数不再是死代码（调用点 ${replayCalls} 处，含定义）`);
ok(bridge.includes('releasePendingWake(localKey);'), 'onNotify 调用 releasePendingWake');

// 4. 租约兜底：2 分钟 + 到期日志
ok(/armPendingWakeLease[\s\S]{0,600}2 \* 60 \* 1000/.test(bridge), '租约缩到 2 分钟');
ok(bridge.includes('busy 租约到期（无 turn/status），兜底释放'), '租约到期有兜底日志（楔死可观测）');
ok(!/pendingWakeLeaseTimers[\s\S]{0,400}30 \* 60 \* 1000/.test(bridge.replace(/ACTIVE_WAIT_LEASE[\s\S]{0,200}/g, '')),
  '唤醒租约不再有 30 分钟超长兜底');

// 5. 唤醒类别分流（2026-11-18 fix-wake-kind-mislabel）：用户消息唤醒标 user
ok(bridge.includes("isUserWake ? { kind: 'user' } : { kind: 'proactive' }".replace('{ kind: \'user\' } ', '')) || /wake: waitPending \? waitPending\.marker : \{ kind: isUserWake \? 'user' : 'proactive', status: 'arrived' \}/.test(bridge),
  'bridge：wake 标记按 isUserWake 分流（user/proactive）');
ok(/const isUserWake = !waitPending && reasonBase !== 'wait' && !isTimerWakeReason\(reasonBase\);/.test(bridge),
  'bridge：分流判定复用 TIMER_WAKE_REASONS（定时器类维持 proactive）');
ok(/private: '私聊新消息'/.test(bridge), 'bridge：WAKE_REASON_LABELS 补 private（不再回退「社交主动发言」）');
ok(/private: '私聊新消息'[\s\S]{0,300}atMention: '有人@你'/.test(bridge), 'bridge：群聊触发键标签已补齐');
ok(bridge.includes('（新消息唤醒：'), 'bridge：user 类合成文本用「新消息唤醒」基调');

// 6. 自动已读推进（2026-11-18 reduce-turn-tool-ritual）：投递成功即 ack 快照消息
ok(/const ackedCount = acknowledgeMessagesV2\(wakeState, wakeSnapshot\.readThroughSeq \?\? null\);/.test(bridge),
  'bridge：投递成功后自动 acknowledgeMessagesV2（throughSeq 取自快照）');
ok(bridge.includes('已读水位自动推进'), 'bridge：自动推进有可观测日志');
ok(/ackedCount > 0[\s\S]{0,120}saveSocialV2State\(\)/.test(bridge), 'bridge：ack 有变更才持久化（配套 saveSocialV2State）');
ok(/不要调任何收尾工具/.test(bridge) === false || bridge.includes('persona') === false, 'bridge：源码断言不涉及人设');

process.exit(failed);
