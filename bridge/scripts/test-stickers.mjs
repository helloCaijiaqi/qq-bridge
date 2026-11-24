// 表情库（只读镜像）自检——sticker 工具族已随多媒体迁移物理删除（2026-11-24）：
// 1) sticker-lib 存活纯函数（归一化/合并/格式化/语境提示/策略提示）
// 2) 退役面断言：清单/bridge 中不再有 sticker 工具与路由
// 3) 可选 live 模式：QQ_BRIDGE_TEST_LIVE=1 时调用 SnowLuma 拉取收藏表情并验证 safeFetchBuffer 可抓图
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeStickerEntry,
  mergeStickerLibrary,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint
} from '../src/chat/sticker-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

console.log('## sticker-lib 纯函数');
{
  const raw = normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'abc', desc: '笑死', localNote: '嘲讽', tags: ['怼人'] });
  ok(raw && raw.id === 'a' && raw.desc === '笑死' && raw.localNote === '嘲讽', 'normalizeStickerEntry 基本字段');
  ok(normalizeStickerEntry({}) === null, '空记录返回 null');
}

{
  const base = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '' }
  ]);
  ok(base.length === 2, 'merge 新增两条');
  const merged = mergeStickerLibrary(base, [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a2', md5: 'ABC', desc: '笑哭' }
  ]);
  ok(merged.length === 1, 'merge 会移除 QQ 端已删除的表情');
  ok(merged[0].id === 'a' && merged[0].url === 'https://x/a2' && merged[0].desc === '笑哭', 'merge 更新 QQ 字段');
}

{
  const list = [
    normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }),
    normalizeStickerEntry({ emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }),
    normalizeStickerEntry({ emoji_id: 'c', resId: 'c', url: 'https://x/c', md5: 'GHI', desc: '', localNote: '无语' })
  ];
  const all = formatStickerList(list, '', 10);
  ok(all.total === 3 && all.stickers.length === 3, 'formatStickerList 总数');
  const q = formatStickerList(list, '生气', 10);
  ok(q.matched === 1 && q.stickers[0].id === 'b', 'formatStickerList 按备注搜索');
  const q2 = formatStickerList(list, '无语', 10);
  ok(q2.matched === 1 && q2.stickers[0].id === 'c', 'formatStickerList 按本地笔记搜索');
  const ctx = buildStickerContext(list, 8);
  ok(ctx.includes('笑死') && ctx.includes('生气'), 'buildStickerContext 包含备注');
  ok(ctx.includes('chat_media_search'), '语境提示指向媒体记忆层检索（chat_media_search）');
}

console.log('## 策略提示（媒体记忆层语义）');
{
  const hint = buildStickerStrategyHint();
  ok(hint.includes('chat_media_send'), '策略提示包含统一发送工具 chat_media_send');
  ok(!hint.includes('chat_qq_send_sticker'), '策略提示不再引用已退役的 chat_qq_send_sticker');
  ok(!hint.includes('chat_media_favorite'), '策略提示不再引用已退役的 chat_media_favorite');
  ok(hint.includes('文字和表情混在同一个气泡里'), '策略提示禁止同气泡混文字');
  ok(!hint.includes('先发一句话再发一张'), '策略提示不再引导“先发一句话再发一张”');
}

console.log('## 配置文件');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const tools = cfg.socialV2?.tools ?? {};
  for (const flag of ['listStickers', 'getStickerImage', 'sendSticker', 'stickerNote', 'collectSticker', 'getSelfImage', 'getImages']) {
    ok(!(flag in tools), `config tools 不再包含已退役 flag ${flag}`);
  }
  ok(cfg.socialV2?.sticker?.enabled === true, 'config sticker.enabled=true');
  ok(!('collect' in (cfg.socialV2?.sticker ?? {})), 'config sticker 不再包含 collect 子块');
  ok(!('sendCaptionMaxChars' in (cfg.socialV2?.sticker ?? {})), 'config sticker 不再包含 sendCaptionMaxChars');
}

console.log('## bridge 退役面（路由/函数不得存在）');
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'gateway', 'actions-manifest.json'), 'utf8'));
  const types = new Set(manifest.actions.map((a) => a.type));
  for (const t of ['send_sticker', 'list_stickers', 'get_sticker_image', 'get_self_image', 'collect_sticker', 'sticker_note', 'set_sticker_remark', 'get_message_images']) {
    ok(!types.has(t), `清单不再包含 ${t}`);
  }
  // 函数定义（不是注释里的提及）：`function X` / `async function X`
  for (const f of ['sendStickerV2', 'collectStickerV2', 'applyStickerNoteV2', 'setStickerRemarkV2', 'listStickersForV2', 'getStickerImageData']) {
    ok(!new RegExp(`(async\\s+)?function\\s+${f}\\b`).test(bridge), `bridge 不再定义 ${f}`);
  }
  // 路由注册（注释里的迁移说明允许保留提及）
  for (const r of ['/api/socialV2/sticker-list', '/api/socialV2/sticker-image', '/api/socialV2/sticker-note', '/api/socialV2/send-sticker', '/api/socialV2/sticker-remark', '/api/socialV2/collect-sticker', '/api/socialV2/forward-media', '/api/images/message']) {
    ok(!bridge.includes(`url.pathname === '${r}'`), `bridge 不再注册 ${r}`);
  }
  // 存活面：只读控制台视图与同步函数仍在
  for (const s of ['function syncStickerLibrary', 'buildStickerContext']) {
    ok(bridge.includes(s), `bridge 保留存活链路 ${s}`);
  }
}

if (process.env.QQ_BRIDGE_TEST_LIVE === '1') {
  console.log('## live：SnowLuma 收藏表情链路');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) };
    const res = await fetch(`${base}/fetch_custom_face_detail`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ count: 5 }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json();
    ok(res.ok && body.status === 'ok' && body.retcode === 0, 'fetch_custom_face_detail 调用成功');
    const items = Array.isArray(body.data) ? body.data : [];
    ok(items.length > 0, `返回 ${items.length} 个收藏表情`);
    if (items.length > 0) {
      const { safeFetchBuffer } = await import('../src/media/safe-fetch.js');
      try {
        const img = await safeFetchBuffer(items[0].url, 4 * 1024 * 1024);
        ok(img.buffer.length > 0, `可抓取表情图片字节（${img.buffer.length} bytes）`);
      } catch (e) {
        ok(false, `safeFetchBuffer 抓取表情失败: ${e.message}`);
      }
    }
  } catch (e) {
    ok(false, `live 链路异常: ${e.message}`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
