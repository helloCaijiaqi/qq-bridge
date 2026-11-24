// 视觉/图片链路自检脚本：
// 1. 校验配置（旧 getImages 看图开关已退役，断言其不再存在）
// 2. 校验 safe-fetch 的 SSRF 防护（本机地址应被拒绝）
// 3. 若桥接运行中，校验 /api/socialV2/message-detail 端点可用（用二代 agent token；
//    /api/images/message 看图通道已退役，媒体元数据解析由 message-detail 承接）
// 运行：node scripts/test-vision-media.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetchBuffer } from '../src/media/safe-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

const config = readJson(path.join(ROOT, 'config.json'));
let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// 1. 配置
// 模型选型已上移到网关（桥接不再持有 config.dsh）：图片理解由网关侧的模型配置决定。
// 旧模型面看图工具（getImages/chat_qq_get_message_images）已退役（2026-11-24），
// 看图走 memory-mcp 媒体资产层，桥接只负责把图片按 media 管线交给网关动作。
check('config.socialV2 不再持有已退役的 getImages 开关', !('getImages' in (config.socialV2?.tools ?? {})));

// 2. safe-fetch SSRF
try {
  await safeFetchBuffer('http://127.0.0.1/');
  check('safe-fetch 拒绝本机地址', false, '未抛出异常');
} catch (error) {
  check('safe-fetch 拒绝本机地址', /内网|本机|禁止/.test(String(error?.message ?? error)), error?.message);
}

// 3. 桥接端点（可选）
const consoleTokenFile = path.join(ROOT, 'state', 'console-token');
const socialV2File = path.join(ROOT, 'state', 'social-v2.json');
if (fs.existsSync(consoleTokenFile) && fs.existsSync(socialV2File)) {
  try {
    const consoleToken = fs.readFileSync(consoleTokenFile, 'utf8').trim();
    const social = JSON.parse(fs.readFileSync(socialV2File, 'utf8'));
    const conv = social?.conversations ? Object.entries(social.conversations)[0] : null;
    if (conv) {
      const [key, st] = conv;
      const agentToken = st?.agentToken;
      const messageId = st?.recentMessages?.find((m) => m && !m.isSelf)?.messageId || st?.recentMessages?.[0]?.messageId;
      if (agentToken && messageId) {
        const url = `http://127.0.0.1:${config.consolePort || 3100}/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`;
        const res = await fetch(url, { headers: { 'x-agent-token': agentToken, 'x-console-token': consoleToken }, signal: AbortSignal.timeout(10000) });
        const body = await res.json().catch(() => ({}));
        check('桥接 /api/socialV2/message-detail 端点可访问（媒体元数据解析存活链路）', res.ok === true && body.ok === true, `HTTP ${res.status}`);
        const gone = await fetch(`http://127.0.0.1:${config.consolePort || 3100}/api/images/message?key=${encodeURIComponent(key)}&messageId=1`, { headers: { 'x-agent-token': agentToken, 'x-console-token': consoleToken }, signal: AbortSignal.timeout(10000) }).catch(() => null);
        check('旧看图端点 /api/images/message 已删除（404）', gone ? gone.status === 404 : true);
      } else {
        console.log('⚠️ 跳过桥接端点检查：没有可用 agentToken/messageId');
      }
    }
  } catch (error) {
    console.log(`⚠️ 桥接端点检查跳过：${error?.message ?? error}`);
  }
} else {
  console.log('⚠️ 跳过桥接端点检查：缺少 state/console-token 或 state/social-v2.json');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
