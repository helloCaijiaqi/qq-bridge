/**
 * 多媒体占位符组装（媒体管道 v2，2026-11-24）—— bridge 第一手处理层。
 *
 * 公用占位符规则（与 memory-mcp store-api 的 MEDIA_PLACEHOLDER_RE 同源）：
 *   唯一格式（v3）：[图片|ma_<12hex>] / [语音|…] / [视频|…] / [文件|…] / [表情|…]
 *   不做双格式兼容——历史数据已由一次性迁移脚本（memory-mcp scripts/migrate-placeholder-v3.mjs）
 *   全量改写为新格式，此后全链只认这一种
 * hashId 生成：ma_ + sha1(文件 sha256 hex)[0:12] —— **内容唯一**。
 *   同一张图无论在多少条消息出现多少次，hashId 相同 → 占位符相同 →
 *   记忆层一条资产、use_count 聚合、认知共享；信封指导清单按 id 去重，
 *   网关只取一次源文件。**不基于 url hash**：QQ 多媒体 url 带时效签名参数，
 *   且会过期——统一「下载/读取 → 落盘 → 按内容 hash」，彻底摆脱 url 依赖。
 *
 * 单份共享存储（2026-11-26 分型分目录）：落盘 c:/memory-mcp/state/data/media/qq/
 * {img,audio,file}/（按段类型分子目录；memory-mcp fileRef 白名单根之内），
 * 文件名分段 ma_<id>.in.<ext>（.in=收到媒体生命周期，3 天归档窗口后由 memory
 * 清退管道清理）。bridge 落盘 = memory-mcp 最终持有，无复制、无双份，
 * 记忆层清退任务删的就是唯一那份。
 *
 * 降级纪律：下载/读取失败、落盘失败或超过大小上限 → 该媒体**保持原字样**
 * （[图片]/[语音]…），绝不产生无源占位符（裸占位符是摘要完整性检查的死敌）。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/* 说明：审计脚手架（scripts/audit-bridge-harness.mjs）以 VM 裸标识符方式复用本模块——
 * 上面的 import 在 VM 里被剥掉，createHash/mkdirSync/statSync/path 等由 harness
 * context 注入的同名对象（fs/path/crypto）提供。因此函数体内不得使用
 * 动态 import()，一律直接调用这些裸标识符。 */

/** 公用占位符 id 正则（ma_ + 12 hex）——与 memory-mcp store-api 同源。 */
export const MEDIA_ID_RE = /^ma_[0-9a-f]{12}$/;
/**
 * 公用占位符文本正则（网关/记忆层扫描用）——与 memory-mcp store-api 同源。
 * 唯一格式 [图片|ma_xxx]（v3）；可选第三段容忍 renderPlaceholders 的描述形态
 * [图片|ma_xxx|描述]（提取只取 id）；「媒体」是旧数据迁移时详情表查不到 kind 的兜底词。
 * 中文类型与清单 kind 解耦：由 bridge 段类型决定（mface→表情/image→图片/
 * record→语音/video→视频/file→文件），记忆层只认 id 不认类型词。
 */
export const MEDIA_PLACEHOLDER_RE = /\[(图片|语音|视频|文件|表情|媒体)\|(ma_[0-9a-f]{12})(?:\|[^\]]*)?\]/g;
/** 段类型 → 占位符中文类型说明（v3：防模型把 id 误当消息标识）。 */
const ZH_KIND_BY_SEG_TYPE = { mface: '表情', image: '图片', record: '语音', video: '视频', file: '文件' };

/** 落盘大小上限：超过直接降级（不占位符化），防大媒体拖垮链路。 */
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/** 默认共享目录：与 memory-mcp 的 fileRef 白名单根保持一致（单份存储；2026-11-26 对齐 mediaDir 迁移后的 state/data 布局）。 */
const DEFAULT_SHARED_DIR = 'c:/memory-mcp/state/data/media/qq';

/** sha256 hex → 占位符 id（公用规则：sha1(sha256hex) 前 12 位）。 */
export function mediaIdFromHash(sha256hex) {
  return `ma_${createHash('sha1').update(String(sha256hex)).digest('hex').slice(0, 12)}`;
}

/** 源标识 → 扩展名（落盘命名用；无可靠后缀一律 .bin）。 */
function extFromSource({ url = '', file = '', mime = '' } = {}) {
  const candidates = [url, file];
  for (const c of candidates) {
    const m = /\.(png|jpe?g|gif|webp|bmp|mp4|mp3|wav|amr|silk|pdf|zip|txt|docx?|xlsx?|pptx?)(?=$|[?#])/i.exec(String(c));
    if (m) return `.${m[1].toLowerCase()}`;
  }
  if (/png/i.test(mime)) return '.png';
  if (/jpe?g/i.test(mime)) return '.jpg';
  if (/gif/i.test(mime)) return '.gif';
  if (/mp4/i.test(mime)) return '.mp4';
  if (/mp3|mpeg/i.test(mime)) return '.mp3';
  return '.bin';
}

/**
 * 取源数据 → Buffer。三种源统一处理：
 *   http(s):// 下载（QQ 多媒体 url 带时效签名，拿到就下，不留着过期）；
 *   base64:// 数据；file:// 前缀或本地路径直接读。
 * 返回 { buffer, mime } 或 null（任何失败都不抛——降级原字样）。
 */
async function fetchSourceBuffer(src) {
  try {
    if (src.base64) {
      const buf = Buffer.from(String(src.base64).replace(/^base64:\/\//, ''), 'base64');
      if (!buf.length || buf.length > MAX_MEDIA_BYTES) return null;
      return { buffer: buf, mime: src.mime ?? '' };
    }
    const raw = String(src.file ?? '').trim();
    if (/^https?:\/\//i.test(raw) || /^https?:\/\//i.test(String(src.url ?? ''))) {
      const target = /^https?:\/\//i.test(raw) ? raw : String(src.url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(target, { signal: controller.signal });
        if (!res.ok) return null;
        const mime = res.headers.get('content-type') ?? '';
        const ab = await res.arrayBuffer();
        const buf = Buffer.from(ab);
        if (!buf.length || buf.length > MAX_MEDIA_BYTES) return null;
        return { buffer: buf, mime };
      } finally {
        clearTimeout(timer);
      }
    }
    const local = raw.replace(/^file:\/\//, '').replace(/^file:/, '');
    if (!local || !existsSync(local)) return null;
    const stat = statSync(local);
    if (!stat.isFile() || stat.size > MAX_MEDIA_BYTES) return null;
    const buffer = readFileSync(local);
    if (!buffer.length) return null;
    return { buffer, mime: '' };
  } catch {
    return null;
  }
}

/**
 * 段类型 → 存储子目录（2026-11-26 分型落盘）：共享区 media/qq/{img,audio,file}。
 * 表情(mface)/图片归 img；语音归 audio；视频/文件归 file。
 */
const SUBDIR_BY_SEG_TYPE = { image: 'img', mface: 'img', record: 'audio', video: 'file', file: 'file' };

/**
 * 段数据 → { id, kind, fileRef, url? } 资产项；失败返回 null（降级）。
 * 落盘命名（2026-11-26 分段命名）：qq/<子目录>/ma_<id>.in.<ext>——
 *   内容寻址去重不变（已存在直接复用）；.in 段标记「收到媒体」生命周期
 *   （3 天归档窗口，超龄走 memory 清退管道）；id 与占位符一致。
 */
async function persistSegmentMedia(seg, { sharedDir, kind }) {
  const d = seg?.data ?? {};
  const src = {
    url: String(d.url ?? ''),
    file: String(d.file ?? ''),
    base64: d.base64 ?? '',
    mime: String(d.mime ?? d.content_type ?? ''),
  };
  if (!src.url && !src.file && !src.base64) return null;
  const got = await fetchSourceBuffer(src);
  if (!got) return null;
  const sha256hex = createHash('sha256').update(got.buffer).digest('hex');
  const id = mediaIdFromHash(sha256hex);
  const ext = extFromSource({ url: src.url, file: src.file, mime: got.mime });
  const subdir = SUBDIR_BY_SEG_TYPE[seg?.type] ?? 'file';
  const dir = path.resolve(sharedDir, subdir);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const filePath = path.join(dir, `${id}.in${ext}`);
  try {
    if (!existsSync(filePath)) writeFileSync(filePath, got.buffer);
  } catch {
    return null;
  }
  const item = { id, kind, fileRef: filePath };
  if (/^https?:\/\//i.test(src.url)) item.url = src.url.slice(0, 2048);
  return item;
}

/**
 * 遍历段数组，为每个可占位符化的媒体段（image/mface/record/video/file；face
 * 是文字级小表情不占位符化）下载/读取并落盘到共享目录，产出：
 *   map      段 index → { id, kind, segType, fileRef, url? }（segmentsToText 原位替换用；
 *             segType 供 placeholderFor 出中文类型说明）
 *   manifest 按 id 去重的指导清单（信封 media 字段——网关按它取源数据）
 * 任何单项失败只降级该项，不影响其余。
 */
export async function buildMediaPlaceholderContext(segments, options = {}) {
  const sharedDir = options.sharedDir ?? DEFAULT_SHARED_DIR;
  const logger = options.logger ?? (() => {});
  const map = new Map();
  const manifest = [];
  const seenIds = new Set();
  const segmentsArr = typeof segments === 'string' ? [] : (segments ?? []);
  for (let index = 0; index < segmentsArr.length; index++) {
    const seg = segmentsArr[index];
    const type = seg?.type;
    let kind = null;
    if (type === 'image') kind = 'image';
    else if (type === 'mface') kind = 'image'; // 市场表情在记忆层就是 image（统一 kind，无 sticker）
    else if (type === 'record') kind = 'voice';
    else if (type === 'video') kind = 'video';
    else if (type === 'file') kind = 'file';
    if (!kind) continue;
    try {
      const item = await persistSegmentMedia(seg, { sharedDir, kind });
      item.segType = type; // 中文类型说明来源（v3 占位符 [图片|ma_xxx]）
      if (!item) {
        logger(`[media] 媒体落盘失败（降级原字样）seg#${index} kind=${kind}`);
        continue;
      }
      map.set(index, item);
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        manifest.push(item);
      }
    } catch (error) {
      logger(`[media] 媒体占位符组装异常 seg#${index}: ${error?.message ?? error}`);
    }
  }
  return { map, manifest };
}

/**
 * 段 index → 占位符文本或 null（无对应资产 → 调用方回退原字样）。
 */
/**
 * 段 index → 占位符文本或 null（无对应资产 → 调用方回退原字样）。
 * v3 新格式：[<中文类型>|ma_xxx]——中文说明按段类型（清单 kind 已被
 * buildMediaPlaceholderContext 归一为 image，这里不能用 item.kind）。
 */
export function placeholderFor(mediaCtx, index) {
  const item = mediaCtx?.map?.get(index);
  if (!item || !MEDIA_ID_RE.test(item.id)) return null;
  const zh = ZH_KIND_BY_SEG_TYPE[item.segType] ?? '媒体';
  return `[${zh}|${item.id}]`;
}

export default {
  MEDIA_ID_RE,
  MEDIA_PLACEHOLDER_RE,
  mediaIdFromHash,
  buildMediaPlaceholderContext,
  placeholderFor,
};
