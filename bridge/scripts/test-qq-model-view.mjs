import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compactModelMessage, compactModelData, serializeModelData } from '../src/chat/qq-model-view.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shortMessage = {
  seq: 21, messageId: '-2026', sender: '小明', userId: '10001',
  text: '刚刚那个梗笑死我了', plain: '刚刚那个梗笑死我了', tail: '刚刚那个梗笑死我了',
  quoteTargetIsSelf: false, isOwner: false, ownerLabel: '', isSelf: false,
  media: [], hasMedia: false, forwardIds: [], hasForward: false, time: 1789680000000
};

test('short messages retain identity and text once, including zero-valued timestamps', () => {
  assert.deepEqual(compactModelMessage({ ...shortMessage, time: 0 }), {
    seq: 21, messageId: '-2026', sender: '小明', userId: '10001',
    text: shortMessage.text, time: 0
  });
});

test('long messages, resolved quotes and whitespace differences are not truncated or deduplicated', () => {
  const message = {
    seq: 22, text: '群友说：' + '很长的正文'.repeat(100),
    plain: '引用[小明]：上一条消息；' + '很长的正文'.repeat(100),
    tail: '最后的约定：明晚八点再聊', replyToMessageId: '-2026',
    quoteTargetIsSelf: true, quote: { sender: '我', text: '等你回复' }
  };
  assert.deepEqual(compactModelMessage(message), message);
  assert.deepEqual(compactModelMessage({ text: '好', plain: '好 ', tail: ' 好' }), {
    text: '好', plain: '好 ', tail: ' 好'
  });
  assert.deepEqual(compactModelMessage({ plain: '只有 plain', tail: '只有 plain' }), { plain: '只有 plain' });
});

test('local media preserve message handles, ordering, face IDs, captions and forward IDs', () => {
  const message = {
    ...shortMessage, text: '[图片][表情#66][转发消息 id=abc]', plain: '', tail: '',
    media: [
      { kind: 'image', file: 'private-image-id', url: 'https://example.invalid/image?signature=long', caption: '比赛结果' },
      { kind: 'face', faceId: '66', url: 'https://example.invalid/face', file: '' }
    ],
    hasMedia: true, forwardIds: ['abc'], hasForward: true
  };
  const compact = compactModelMessage(message);
  assert.equal(compact.seq, 21);
  assert.equal(compact.messageId, '-2026');
  // 2026-11-23：media 项下放消息级 handle（历史看图工具的 messageId 就近可读；该工具
  // 已退役，handle 仍供 message-detail 等定位消息用）
  assert.deepEqual(compact.media, [
    { kind: 'image', caption: '比赛结果', index: 1, messageId: '-2026', seq: 21 },
    { kind: 'face', faceId: '66', index: 2, messageId: '-2026', seq: 21 }
  ]);
  assert.equal(compact.hasMedia, true);
  assert.deepEqual(compact.forwardIds, ['abc']);
  assert.equal(compact.hasForward, true);
});

test('media items carry message-level handles (no cross-field assembly)', () => {
  // deepseek-flash 实测会把 media.index 当 messageId 传 → 查无。
  // handle 下放后模型从 media 项直接取 messageId（get_message_images 退役后仍为
  // message-detail 等定位约定）。
  const message = {
    seq: 27, messageId: '-783924553', sender: '小明', text: '看这张', plain: '', tail: '',
    media: [
      { kind: 'image', file: 'FDC4A9F3.jpg', url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=E' },
      { kind: 'face', faceId: '12', url: 'https://example.invalid/face', file: 'same-as-url' }
    ],
    hasMedia: true
  };
  const compact = compactModelMessage(message);
  assert.equal(compact.media[0].messageId, '-783924553');
  assert.equal(compact.media[0].seq, 27);
  assert.equal(compact.media[1].messageId, '-783924553');
  assert.equal(compact.media[1].seq, 27);
  // 转发节点（seq 非 safe int）不下放 handle，保留传输引用
  const fwd = compactModelMessage({
    messageId: 'forward-node-id', messageSeq: 21, text: '转发', media: [
      { kind: 'image', url: 'https://example.invalid/1', file: 'x1' }
    ]
  });
  assert.equal('messageId' in fwd.media[0], false, '不可本地解析的媒体不下放 handle');
});

test('forwarded and legacy messages retain otherwise unresolvable media references', () => {
  const message = {
    index: 1, messageId: 'forward-node-id', messageSeq: 21,
    text: '转发图片', nestedForwardIds: ['nested-id'],
    media: [
      { kind: 'image', url: 'https://example.invalid/1', file: 'https://example.invalid/1' },
      { kind: 'image', url: 'https://example.invalid/2', file: 'different-file-id' }
    ]
  };
  const compact = compactModelMessage(message);
  assert.deepEqual(compact.nestedForwardIds, ['nested-id']);
  assert.equal(compact.media[0].url, message.media[0].url);
  assert.equal('file' in compact.media[0], false);
  assert.deepEqual(compact.media[1], message.media[1]);
});

test('self/owner flags, poke context and unknown extensions survive; only known empty values disappear', () => {
  const message = {
    messageId: null, userId: null, text: '我来啦', plain: '我来啦',
    isSelf: true, isOwner: true, ownerLabel: '我', kind: 'poke',
    poke: { targetId: '123', targetIsSelf: false, groupId: null },
    extension: { enabled: false, empty: '', list: [] }, futureFlag: false,
    media: [], forwardIds: [], nestedForwardIds: []
  };
  const compact = compactModelMessage(message);
  assert.deepEqual(compact, {
    text: '我来啦', isSelf: true, isOwner: true, ownerLabel: '我', kind: 'poke',
    poke: message.poke, extension: message.extension, futureFlag: false
  });
  for (const item of [null, undefined, 'string', 1, false, []]) {
    assert.equal(compactModelMessage(item), item);
  }
});

test('only messages/newMessages arrays are compacted; envelope fields and input remain intact', () => {
  const original = {
    ok: true, readThroughSeq: 21, timeout: false, note: '',
    config: { disabled: false, names: [] },
    messages: [shortMessage], newMessages: [shortMessage],
    info: shortMessage, recentMessages: [shortMessage],
    nestedPreviews: [{ id: 'nested', messages: [shortMessage], truncated: false }]
  };
  const snapshot = structuredClone(original);
  Object.freeze(shortMessage);
  Object.freeze(shortMessage.media);
  Object.freeze(shortMessage.forwardIds);
  const compact = compactModelData(original);
  assert.deepEqual(original, snapshot);
  assert.equal('plain' in compact.messages[0], false);
  assert.equal('plain' in compact.newMessages[0], false);
  assert.equal('plain' in compact.nestedPreviews[0].messages[0], false);
  assert.deepEqual(compact.info, shortMessage);
  assert.deepEqual(compact.recentMessages, [shortMessage]);
  assert.deepEqual(compact.config, original.config);
  assert.equal(compact.timeout, false);
  assert.equal(compact.note, '');
  assert.equal(compact.readThroughSeq, 21);
  assert.equal(serializeModelData(original), JSON.stringify(compact));
  assert.deepEqual(compactModelData({ messages: ['a', 'b'] }), { messages: ['a', 'b'] });
});

test('synthetic payload size comparison (characters, not measured token usage)', () => {
  const sample = { ok: true, key: 'group:123', readThroughSeq: 40, messages: Array.from({ length: 40 }, (_, i) => ({
    ...shortMessage, seq: i + 1, messageId: String(1000 + i),
    text: `第${i + 1}条：晚上还在群里聊刚刚那个故事`,
    plain: `第${i + 1}条：晚上还在群里聊刚刚那个故事`,
    tail: `第${i + 1}条：晚上还在群里聊刚刚那个故事`
  })) };
  const before = JSON.stringify(sample, null, 2).length;
  const minifiedOnly = JSON.stringify(sample).length;
  const after = serializeModelData(sample).length;
  assert.ok(after < minifiedOnly);
  console.log(`Synthetic 40-message payload: ${before} -> ${after} characters (${(after / before * 100).toFixed(1)}% remaining); minified-only=${minifiedOnly}. This is not a billing/token benchmark.`);
});

