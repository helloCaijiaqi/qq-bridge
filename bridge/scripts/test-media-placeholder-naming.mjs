/**
 * media-placeholder 分段命名+分型子目录回归（2026-11-26）：
 *   落盘 = <sharedDir>/<img|audio|file>/ma_<id>.in.<ext>
 *   内容寻址去重不变；id 与占位符一致。
 * 临时目录真文件，零 mock。跑法：node bridge/scripts/test-media-placeholder-naming.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildMediaPlaceholderContext, mediaIdFromHash, MEDIA_ID_RE } = await import('../src/media-placeholder.js');
const { createHash } = await import('node:crypto');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ph-'));
const sharedDir = path.join(root, 'media', 'qq');
const b64 = (buf) => buf.toString('base64');
const png = Buffer.from('89504e47', 'hex'); // PNG magic
const amr = Buffer.from('#!AMR\n' + 'x'.repeat(32));

const { map, manifest } = await buildMediaPlaceholderContext(
  [
    { type: 'image', data: { base64: b64(png), mime: 'image/png' } },
    { type: 'record', data: { file: 'voice.amr', base64: b64(amr) } },
    { type: 'file', data: { base64: b64(Buffer.from('doc')), mime: 'application/pdf' } },
    { type: 'image', data: { base64: b64(png), mime: 'image/png' } }, // 同内容重复 → 去重
  ],
  { sharedDir, logger: () => {} },
);

assert.equal(map.size, 4, '四个段全部落盘（含重复内容的段）');
assert.equal(manifest.length, 3, '清单按 id 去重为 3');

const expect = [
  ['img', png, '.png'],
  ['audio', amr, '.amr'],
  ['file', Buffer.from('doc'), '.bin'], // 无可靠后缀 → .bin
];
for (const [subdir, buf, ext] of expect) {
  const sha = createHash('sha256').update(buf).digest('hex');
  const id = mediaIdFromHash(sha);
  const file = path.join(sharedDir, subdir, `${id}.in${ext}`);
  assert.ok(fs.existsSync(file), `落盘 ${subdir}/${id}.in${ext}`);
  assert.ok(MEDIA_ID_RE.test(id), 'id 合法');
}

// 占位符文本引用同一 id（重复段同 id 同占位符）
assert.equal(placeholderAt(map, 0), placeholderAt(map, 3), '同内容段占位符一致');

function placeholderAt(idMap, index) {
  const item = idMap.get(index);
  return item ? `[图片|${item.id}]` : null;
}

console.log('test-media-placeholder-naming: all assertions passed');
