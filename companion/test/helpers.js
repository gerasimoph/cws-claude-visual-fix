import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RpcPeer } from '../src/rpc.js';

export function tempHome() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bf-test-'));
  process.env.BROWSER_FEEDBACK_HOME = dir;
  return dir;
}

export function peerPair() {
  let a = null;
  let b = null;
  a = new RpcPeer((m) => setImmediate(() => b.receive(m)), { name: 'a', defaultTimeoutMs: 0 });
  b = new RpcPeer((m) => setImmediate(() => a.receive(m)), { name: 'b', defaultTimeoutMs: 0 });
  return [a, b];
}

export function signature(overrides = {}) {
  return {
    found: true,
    method: 'id',
    tag: 'div',
    text: 'Pro plan',
    classes: 'card pro',
    attrs: {},
    rect: { x: 10, y: 20, width: 300, height: 440 },
    styles: { height: '440px', padding: '24px', display: 'flex' },
    subtreeHash: 'abc',
    childCount: 3,
    visible: true,
    ...overrides,
  };
}

// Fake extension: answers page.capture from a mutable "page" map of signatures.
export function fakeExtension(peer, page) {
  const calls = [];
  peer.handle('page.capture', ({ mode, items, screenshot }) => {
    calls.push({ mode, ids: items.map((i) => i.annotationId) });
    return {
      items: items.map((i) => ({
        annotationId: i.annotationId,
        signature: page.get(i.annotationId) || { found: false },
        screenshot: screenshot ? 'data:image/jpeg;base64,/9j/AA==' : null,
      })),
    };
  });
  peer.handle('page.screenshot', () => ({ url: 'http://localhost:3000/', screenshot: 'data:image/jpeg;base64,/9j/AA==' }));
  const updates = [];
  peer.onNotification('review.update', ({ review }) => updates.push(review));
  const agents = [];
  peer.onNotification('agents.update', ({ agents: a }) => agents.push(a));
  return { calls, updates, agents };
}

export function annotationInput(id, instruction, extra = {}) {
  return {
    id,
    instruction,
    url: 'http://localhost:3000/pricing',
    path: '/pricing',
    anchor: { selectors: [{ kind: 'id', selector: `#${id}` }], tag: 'div', text: 'Pro plan' },
    context: { element: { tag: 'div', label: 'div.card.pro', text: 'Pro plan', classes: 'card pro' }, geometry: { x: 10, y: 20, width: 300, height: 440 }, styles: { height: '440px' } },
    ...extra,
  };
}

export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
