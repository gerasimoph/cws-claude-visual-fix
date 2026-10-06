import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, createDecoder, MAX_HOST_MESSAGE_BYTES } from '../src/native.js';

test('round-trips messages split across chunks', () => {
  const got = [];
  const decode = createDecoder((m) => got.push(m));
  const buf = Buffer.concat([encodeMessage({ a: 1 }), encodeMessage({ b: 'ü' })]);
  for (let i = 0; i < buf.length; i += 3) decode(buf.subarray(i, i + 3));
  assert.deepEqual(got, [{ a: 1 }, { b: 'ü' }]);
});

test('refuses messages over the 1 MB host limit', () => {
  assert.throws(() => encodeMessage({ s: 'x'.repeat(MAX_HOST_MESSAGE_BYTES) }), /too large/);
});
