import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempHome, peerPair, signature, fakeExtension, annotationInput, tick } from './helpers.js';
import { saveProjects } from '../src/store.js';
import { Companion } from '../src/companion.js';
import { foldersRelated, linuxListener } from '../src/devserver.js';
import { installHooks, uninstallHooks } from '../src/claude-config.js';

let companion, ext, page, fx;

beforeEach(() => {
  tempHome();
  saveProjects([{ id: 'p1', name: 'acme', localPath: '/proj', workingDirectory: '/proj', origins: ['http://localhost:3000'] }]);
  companion = new Companion();
  const [extSide, hostSide] = peerPair();
  companion.attachExtension(hostSide);
  ext = extSide;
  page = new Map();
  fx = fakeExtension(ext, page);
});

// A chat's doorbell: resolves when the companion rings it (or replaces it).
function bell(sessionId, cwd, extra = {}) {
  const [b, h] = peerPair();
  companion.attachDoorbell(h);
  return b.request('bell.register', { sessionId, cwd, title: extra.title || sessionId, event: extra.event || 'Stop', prompt: extra.prompt });
}

function agent(cwd = '/proj') {
  const [a, h] = peerPair();
  companion.attachAgent(h);
  return a.request('hello', { cwd }).then(() => a);
}

async function submit(id, extra = {}) {
  page.set(id, signature());
  return ext.request('review.submit', { origin: 'http://localhost:3000', annotations: [annotationInput(id, 'Make it taller')], ...extra });
}

test('Fix all rings the chat in the project folder; the chat fetches the review by id', async () => {
  const ring = bell('chat-a', '/proj/src');
  await tick();
  const sub = await submit('a1');
  assert.equal(sub.chatId, 'chat-a');
  assert.equal(sub.agentWaiting, true);
  const r = await ring;
  assert.equal(r.action, 'ring');
  assert.match(r.text, new RegExp(`review_id "${sub.reviewId}"`));
  assert.doesNotMatch(r.text, /Pro plan/, 'no page data in the wake-up notice');

  const a = await agent();
  const got = await a.request('waitForReview', { reviewId: sub.reviewId });
  assert.match(got.text, /the next "Fix all" will notify this session by itself/);
  page.set('a1', signature({ rect: { x: 10, y: 20, width: 300, height: 500 } }));
  await a.request('inspectElement', { id: 'a1' });
  const rep = await a.request('reportAnnotation', { id: 'a1', status: 'fixed', summary: 'ok' });
  assert.equal(rep.status, 'fixed');
  assert.match(rep.text, /You are done/);
  assert.doesNotMatch(rep.text, /Call wait_for_review/);
});

test('most recently active chat wins; the panel choice and /ui-review override it', async () => {
  const older = bell('old', '/proj');
  await tick(5);
  const newer = bell('new', '/proj');
  await tick();
  const s1 = await submit('a1');
  assert.equal(s1.chatId, 'new');
  await newer;
  await ext.request('review.cancel', { reviewId: s1.reviewId });

  const s2 = await submit('a2', { targetChatId: 'old' });
  assert.equal(s2.chatId, 'old');
  await older;
  await ext.request('review.cancel', { reviewId: s2.reviewId });

  // /ui-review typed in "old" pins it, even though "new" is more recent.
  bell('old', '/proj', { event: 'UserPromptSubmit', prompt: '/ui-review' });
  const oldAgain = bell('old', '/proj', { event: 'Stop' });
  bell('new', '/proj', { event: 'Stop' });
  await tick();
  const s3 = await submit('a3');
  assert.equal(s3.chatId, 'old');
  await oldAgain;
  assert.ok(companion.chatList().find((c) => c.id === 'old').claimed);
});

test('a busy chat is not interrupted: the review waits until Claude finishes the turn', async () => {
  bell('c', '/proj', { event: 'UserPromptSubmit', prompt: 'refactor the API' });
  await tick();
  const sub = await submit('a1');
  assert.equal(fx.updates.at(-1).waitingFor, 'chat_busy');
  const ring = bell('c', '/proj', { event: 'Stop' });
  const r = await ring;
  assert.equal(r.action, 'ring');
  assert.match(r.text, new RegExp(sub.reviewId));
});

test('"Send now" rings a busy chat', async () => {
  const busyBell = bell('c', '/proj', { event: 'UserPromptSubmit', prompt: 'x' });
  await tick();
  const sub = await submit('a1');
  await ext.request('review.ringNow', { reviewId: sub.reviewId });
  assert.equal((await busyBell).action, 'ring');
});

test('a newer doorbell for the same chat replaces the old one', async () => {
  const first = bell('c', '/proj');
  await tick();
  bell('c', '/proj');
  assert.deepEqual(await first, { action: 'stop' });
});

test('no chat yet: the review waits and goes to the first chat that shows up', async () => {
  const sub = await submit('a1');
  assert.equal(fx.updates.at(-1).waitingFor, 'no_chat');
  const r = await bell('late', '/proj');
  assert.match(r.text, new RegExp(sub.reviewId));
});

test('a chat in an unknown folder becomes a candidate and gets the review after Connect', async () => {
  const ring = bell('x', '/code/shop');
  await tick();
  const hello = await ext.request('hello', {});
  const cand = hello.candidates.find((c) => c.workingDirectory === '/code/shop');
  assert.ok(cand?.waiting);
  const chatsSeen = [];
  ext.onNotification('chats.update', ({ chats }) => chatsSeen.push(chats));
  await ext.request('project.connect', { candidateId: cand.id, origin: 'http://localhost:5173' });
  await tick();
  assert.ok(chatsSeen.at(-1)?.find((c) => c.id === 'x')?.projectId, 'browser learns the chat now belongs to the project');
  page.set('s1', signature());
  await ext.request('review.submit', { origin: 'http://localhost:5173', annotations: [annotationInput('s1', 'x')] });
  assert.equal((await ring).action, 'ring');
});

test('SessionEnd removes the chat', async () => {
  const ring = bell('gone', '/proj');
  await tick();
  const [b, h] = peerPair();
  companion.attachDoorbell(h);
  await b.request('bell.end', { sessionId: 'gone' });
  assert.deepEqual(await ring, { action: 'stop' });
  assert.equal(companion.chatList().length, 0);
});

test('chat in the dev server folder is preferred over a more recent one elsewhere', async () => {
  const wt = bell('worktree', '/proj-wt');
  saveProjects([{ id: 'p1', name: 'acme', localPath: '/proj', workingDirectory: '/proj', origins: ['http://localhost:3000'] }]);
  const main = bell('main', '/proj/app');
  await tick(5);
  bell('other', '/proj/docs');
  await tick();
  companion.devServers = { p1: { origin: 'http://localhost:3000', dir: '/proj/app' } };
  const sub = await submit('a1');
  assert.equal(sub.chatId, 'main');
  await main;
  void wt;
});

test('foldersRelated', () => {
  assert.ok(foldersRelated('/a/b', '/a/b/'));
  assert.ok(foldersRelated('/repo', '/repo/apps/web'));
  assert.ok(!foldersRelated('/repo', '/repo-wt'));
  assert.ok(!foldersRelated(null, '/x'));
});

test('dev server folder is found from the listening port (Linux)', { skip: process.platform !== 'linux' }, async () => {
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const found = linuxListener(server.address().port);
    assert.equal(found?.pid, process.pid);
    assert.equal(found?.dir, process.cwd());
  } finally { server.close(); }
});

test('hooks are merged into settings.json, idempotently, with a backup', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bf-claude-'));
  const file = path.join(dir, 'settings.json');
  const mine = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }, model: 'x' };
  writeFileSync(file, JSON.stringify(mine));
  installHooks({ nodePath: '/usr/bin/node', entry: "/home/o'neil/.browser-feedback/app/bin/browser-feedback.js", settingsPath: file });
  installHooks({ nodePath: '/usr/bin/node', entry: "/home/o'neil/.browser-feedback/app/bin/browser-feedback.js", settingsPath: file });
  const s = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(s.model, 'x');
  assert.equal(s.hooks.Stop.length, 2, 'user hook kept, ours added once');
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'say done');
  const ours = s.hooks.Stop[1].hooks[0];
  assert.equal(ours.asyncRewake, true);
  assert.match(ours.command, /'\/home\/o'\\''neil\/.browser-feedback\/app\/bin\/browser-feedback.js' doorbell$/);
  assert.match(s.hooks.SessionEnd[0].hooks[0].command, /doorbell --end$/);
  assert.ok(existsSync(`${file}.bak-browser-feedback`));
  uninstallHooks({ settingsPath: file });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), mine);
});

test('invalid settings.json is left untouched', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bf-claude-'));
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, '{ // comment\n}');
  assert.throws(() => installHooks({ nodePath: 'n', entry: 'e', settingsPath: file }), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ // comment\n}');
});
