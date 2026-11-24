import assert from 'node:assert/strict';
import { mergeStickerLibrary } from '../src/chat/sticker-lib.js';
import { splitForQQ } from '../src/chat/md-to-plain.js';
import { formatForwardResponse } from '../src/chat/forward.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.message}`); }
}
test('partial sticker refresh preserves learned records outside the fetched page', () => {
  const entries = [{ id: 'a', source: 'qq' }, { id: 'b', source: 'qq', localNote: 'learned', useCount: 7 }];
  const result = mergeStickerLibrary(entries, [{ id: 'a', desc: 'new' }], { complete: false });
  assert.equal(result.length, 2);
  assert.equal(result.find((entry) => entry.id === 'b').localNote, 'learned');
  assert.equal(mergeStickerLibrary(entries, [{ id: 'a' }]).length, 1);
});
test('QQ newline splitting respects the stated per-message limit', () => {
  const text = 'abc\ndef\nghi';
  const parts = splitForQQ(text, 3);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((part) => part.length <= 3));
});
test('single-segment forwarded messages retain media and nested forward metadata', () => {
  const result = formatForwardResponse({ messages: [
    { message: { type: 'image', data: { url: 'https://example.invalid/image.png' } } },
    { content: { type: 'forward', data: { id: 'nested-id' } } },
  ] });
  assert.equal(result.messages[0].media.length, 1);
  assert.deepEqual(result.messages[1].nestedForwardIds, ['nested-id']);
});
process.exitCode = failed ? 1 : 0;
