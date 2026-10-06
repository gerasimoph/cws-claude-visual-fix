import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome, peerPair, signature, fakeExtension, annotationInput, tick } from './helpers.js';
import { saveProjects } from '../src/store.js';
import { Companion } from '../src/companion.js';

let companion, ext, agent, page, fx;

beforeEach(() => {
  tempHome();
  saveProjects([{ id: 'p1', name: 'AudioMoo', localPath: '/proj', workingDirectory: '/proj', origins: ['http://localhost:3000'], framework: 'Next.js' }]);
  companion = new Companion();
  const [extSide, hostSide] = peerPair();
  companion.attachExtension(hostSide);
  ext = extSide;
  page = new Map();
  fx = fakeExtension(ext, page);
  const [agentSide, hostAgentSide] = peerPair();
  companion.attachAgent(hostAgentSide);
  agent = agentSide;
});

async function submit(items) {
  for (const a of items) page.set(a.id, signature());
  return ext.request('review.submit', { origin: 'http://localhost:3000', annotations: items });
}

test('rejects reviews for origins without a project', async () => {
  await assert.rejects(ext.request('review.submit', { origin: 'http://localhost:9999', annotations: [annotationInput('a1', 'x')] }), /isn't connected/);
});

test('full loop: wait → work → inspect → report → Fixed → Accept', async () => {
  await agent.request('hello', { cwd: '/proj/src', client: 'test' });
  const waiting = agent.request('waitForReview', { timeoutMs: 5000 });
  await tick();
  assert.equal(fx.agents.at(-1).p1, 'waiting');

  const sub = await submit([annotationInput('a1', 'Make this the same height as the Monthly card'), annotationInput('a2', 'Remove this icon')]);
  assert.equal(sub.agentWaiting, true);

  const got = await waiting;
  assert.equal(got.review.count, 2);
  assert.match(got.text, /INSTRUCTION: Make this the same height/);
  assert.match(got.text, /<page-data>/);
  assert.deepEqual(fx.calls[0], { mode: 'baseline', ids: ['a1', 'a2'] });

  // Agent edits code → HMR changes the element.
  page.set('a1', signature({ rect: { x: 10, y: 20, width: 300, height: 480 }, styles: { height: '480px', padding: '24px', display: 'flex' } }));
  const insp = await agent.request('inspectElement', { id: 'a1' });
  assert.match(insp.text, /height: 440px → 480px/);

  const rep = await agent.request('reportAnnotation', { id: 'a1', status: 'fixed', summary: 'PricingCard.tsx: h-full' });
  assert.equal(rep.status, 'fixed');
  assert.match(rep.text, /Next: comment 2/);

  // Second comment: reported without inspecting → only "Changed — check".
  page.set('a2', { found: false });
  const rep2 = await agent.request('reportAnnotation', { id: 'a2', status: 'fixed', summary: 'Removed icon' });
  assert.equal(rep2.status, 'changed_check');
  assert.match(rep2.text, /call inspect_element/);

  const last = fx.updates.at(-1);
  assert.equal(last.status, 'done');
  assert.deepEqual(last.annotations.map((a) => a.status), ['fixed', 'changed_check']);

  await ext.request('annotation.accept', { annotationId: 'a1' });
  assert.equal(fx.updates.at(-1).annotations[0].status, 'accepted');
});

test('agent claiming a fix without a visible change gets Changed — check', async () => {
  await submit([annotationInput('a1', 'Make it blue')]);
  await agent.request('waitForReview', { timeoutMs: 1000 });
  await agent.request('inspectElement', { id: 'a1' });
  const rep = await agent.request('reportAnnotation', { id: 'a1', status: 'fixed', summary: 'done' });
  assert.equal(rep.status, 'changed_check');
  assert.match(rep.text, /FAIL changed/);
});

test('review submitted before the agent attaches is delivered on wait', async () => {
  const sub = await submit([annotationInput('a1', 'x')]);
  assert.equal(sub.agentWaiting, false);
  const got = await agent.request('waitForReview', { timeoutMs: 1000 });
  assert.equal(got.review.id, sub.reviewId);
});

test('wait times out with an explicit "call again" message', async () => {
  const got = await agent.request('waitForReview', { timeoutMs: 1000 });
  assert.equal(got.review, null);
  assert.match(got.text, /call wait_for_review again/i);
});

test('untouched review is re-delivered; touched-but-unreported comments are finalized', async () => {
  await submit([annotationInput('a1', 'x'), annotationInput('a2', 'y')]);
  const first = await agent.request('waitForReview', { timeoutMs: 1000 });
  const again = await agent.request('waitForReview', { timeoutMs: 1000 });
  assert.equal(again.review.id, first.review.id);

  await agent.request('getAnnotation', { id: 'a1' });
  page.set('a1', signature({ text: 'changed' }));
  const next = await agent.request('waitForReview', { timeoutMs: 1000 });
  assert.equal(next.review, null);
  assert.deepEqual(fx.updates.at(-1).annotations.map((a) => a.status), ['changed_check', 'failed']);
});

test('one running review per project; next one waits', async () => {
  const r1 = await submit([annotationInput('a1', 'x')]);
  await agent.request('waitForReview', { timeoutMs: 1000 });
  const r2 = await submit([annotationInput('b1', 'y')]);
  const [agent2Side, host2Side] = peerPair();
  companion.attachAgent(host2Side);
  const res = await agent2Side.request('waitForReview', { timeoutMs: 1000 });
  assert.equal(res.review, null, 'second agent must not get a review while one is running');
  page.set('a1', signature({ text: 'new' }));
  await agent.request('reportAnnotation', { id: 'a1', status: 'no_change', summary: 'already ok' });
  const next = await agent.request('waitForReview', { timeoutMs: 1000 });
  assert.equal(next.review.id, r2.reviewId);
  assert.notEqual(r1.reviewId, r2.reviewId);
});

test('captured context is redacted before reaching the agent', async () => {
  const a = annotationInput('a1', 'Fix this');
  a.context.element.attributes = { 'data-api-key': 'secret123', title: 'ok' };
  a.context.element.text = 'token=abcd1234efgh';
  await submit([a]);
  await agent.request('waitForReview', { timeoutMs: 1000 });
  const full = await agent.request('getAnnotation', { id: 'a1' });
  assert.doesNotMatch(full.text, /secret123|abcd1234efgh/);
  assert.match(full.text, /data-api-key="\[REDACTED\]"/);
});

test('agent disconnect leaves the review resumable by the next agent', async () => {
  await submit([annotationInput('a1', 'x')]);
  const [a1Side, h1Side] = peerPair();
  const s1 = companion.attachAgent(h1Side);
  await a1Side.request('waitForReview', { timeoutMs: 1000 });
  await a1Side.request('getAnnotation', { id: 'a1' });
  companion.detachAgent(s1);
  const res = await agent.request('waitForReview', { timeoutMs: 1000 });
  assert.match(res.text, /Resuming/);
});
