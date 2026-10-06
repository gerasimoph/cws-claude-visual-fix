import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/redact.js';

const { redactText, redactDeep, isSensitiveName, redactUrl } = globalThis.BFRedact;

test('redacts tokens and keys in text', () => {
  assert.equal(redactText('Authorization: Bearer abcdefghijklmnop123'), 'Authorization: Bearer [REDACTED]');
  assert.match(redactText('key sk-ant-api03-abcdefghijklmnopqrstuv'), /\[REDACTED_KEY\]/);
  assert.match(redactText('ghp_abcdefghijklmnopqrstuvwxyz0123'), /\[REDACTED_KEY\]/);
  assert.match(redactText('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijkl'), /\[REDACTED_JWT\]/);
  assert.equal(redactText('password=hunter22'), 'password=[REDACTED]');
});

test('redacts Luhn-valid card numbers only', () => {
  assert.equal(redactText('card 4242 4242 4242 4242 ok'), 'card [REDACTED_CARD] ok');
  assert.equal(redactText('order 1234 5678 9012 3456'), 'order 1234 5678 9012 3456');
});

test('leaves ordinary UI text alone', () => {
  const s = 'Make this the same height as the Monthly card — $20/mo, 3 seats';
  assert.equal(redactText(s), s);
});

test('sensitive names', () => {
  for (const n of ['password', 'api_key', 'data-token', 'csrfToken', 'Authorization', 'set-cookie', 'session_id']) assert.ok(isSensitiveName(n), n);
  for (const n of ['author', 'name', 'styles', 'tokenizer', 'context', 'selectors', 'passage']) assert.ok(!isSensitiveName(n), n);
});

test('redactDeep drops values under sensitive keys and keeps structure', () => {
  const out = redactDeep({ attrs: { 'data-token': 'abc', title: 'Hi' }, text: 'Bearer abcdefghijkl' });
  assert.deepEqual(out, { attrs: { 'data-token': '[REDACTED]', title: 'Hi' }, text: 'Bearer [REDACTED]' });
});

test('redactUrl masks sensitive query params and credentials', () => {
  assert.equal(redactUrl('http://localhost:3000/cb?token=abc&page=2'), 'http://localhost:3000/cb?token=[REDACTED]&page=2');
  assert.equal(redactUrl('http://u:p@localhost/'), 'http://localhost/');
  assert.equal(redactUrl('/a?b=1'), '/a?b=1');
});
