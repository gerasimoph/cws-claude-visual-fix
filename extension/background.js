// Background service worker: the only writer of annotation storage, the
// bridge to the local companion (Chrome Native Messaging, PRD §11.1), and
// the router for page captures and screenshots.
const HOST_NAME = 'com.browser_feedback.companion';
const CONTENT_SCRIPTS = ['lib/redact.js', 'lib/onboarding.js', 'content/anchor.js', 'content/capture.js', 'content/ui.js', 'content/main.js'];
const DEFAULT_MATCHES = ['http://localhost/*', 'http://127.0.0.1/*', 'https://localhost/*'];
const MAIN_WORLD_SCRIPT = 'content/probe.js';
const IN_FLIGHT = new Set(['queued', 'working', 'verifying']);

// ------------------------------------------------------------------ RPC peer
// Same wire format as companion/src/rpc.js.
class RpcPeer {
  constructor(send) {
    this.send = send;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.notifications = new Map();
    this.closed = false;
  }
  handle(method, fn) { this.handlers.set(method, fn); return this; }
  on(method, fn) { this.notifications.set(method, fn); return this; }
  request(method, params, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error('Companion is not connected'));
    const id = `bg-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }
  notify(method, params) { if (!this.closed) try { this.send({ method, params }); } catch {} }
  async receive(msg) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined) {
      const fn = this.handlers.get(msg.method);
      try {
        if (!fn) throw new Error(`unknown method ${msg.method}`);
        const result = await fn(msg.params || {});
        if (!this.closed) this.send({ id: msg.id, result: result ?? null });
      } catch (err) {
        if (!this.closed) this.send({ id: msg.id, error: { message: err.message || String(err) } });
      }
    } else {
      try { await this.notifications.get(msg.method)?.(msg.params || {}); } catch (err) { console.warn(err); }
    }
  }
  close() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Companion disconnected')); }
    this.pending.clear();
  }
}

// ------------------------------------------------------------------ storage
// Annotations live in chrome.storage.local under `ann:<origin>`; every write
// goes through this queue so content scripts and companion updates never race.

let writeQueue = Promise.resolve();

function mutate(origin, fn) {
  const key = `ann:${origin}`;
  const run = writeQueue.then(async () => {
    const current = (await chrome.storage.local.get(key))[key] || [];
    const next = fn(current);
    if (next) await chrome.storage.local.set({ [key]: next });
    return next || current;
  });
  writeQueue = run.catch(() => {});
  return run;
}

async function getAnnotations(origin) {
  const key = `ann:${origin}`;
  return (await chrome.storage.local.get(key))[key] || [];
}

// ---------------------------------------------------------------- companion

let port = null;
let peer = null;
let connecting = null;
const submitting = new Set(); // annotation ids with a review.submit in flight
let companion = { state: 'disconnected', error: null, version: null, projects: [], agents: {}, candidates: [], chats: [], devServers: {} };

function setCompanion(patch) {
  companion = { ...companion, ...patch };
  chrome.storage.local.set({ companion });
}

function connectCompanion() {
  if (peer && !peer.closed && companion.state === 'connected') return Promise.resolve(true);
  if (connecting) return connecting;
  connecting = new Promise((resolve) => {
    setCompanion({ state: 'connecting' });
    let p;
    try {
      p = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      setCompanion({ state: 'not_installed', error: err.message });
      connecting = null;
      resolve(false);
      return;
    }
    port = p;
    const rpc = new RpcPeer((msg) => p.postMessage(msg));
    peer = rpc;
    p.onMessage.addListener((msg) => rpc.receive(msg));
    p.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || 'Companion exited';
      const wasConnected = companion.state === 'connected';
      rpc.close();
      if (port === p) { port = null; peer = null; }
      const notInstalled = /not found|forbidden/i.test(error);
      setCompanion({ state: notInstalled ? 'not_installed' : 'disconnected', error, agents: {}, candidates: [], chats: [] });
      if (connecting) { connecting = null; resolve(false); }
      // The companion exits on purpose when `setup` installs a new version:
      // reconnect so Chrome starts the new one (a few tries, not forever).
      if (wasConnected && !notInstalled) scheduleReconnect();
    });
    registerCompanionHandlers(rpc);
    rpc.request('hello', { version: chrome.runtime.getManifest().version }, 5000).then(async (hello) => {
      setCompanion({ state: 'connected', error: null, version: hello.version, projects: hello.projects || [], agents: hello.agents || {}, candidates: hello.candidates || [], chats: hello.chats || [], devServers: hello.devServers || {}, mcp: hello.mcp || {} });
      for (const review of hello.reviews || []) await applyReview(review);
      connecting = null;
      resolve(true);
    }, (err) => {
      // If the port already dropped, onDisconnect recorded the real reason.
      if (peer === rpc) setCompanion({ state: 'disconnected', error: err.message });
      if (connecting) { connecting = null; resolve(false); }
    });
  });
  return connecting;
}

let reconnectTries = [];
function scheduleReconnect() {
  const now = Date.now();
  reconnectTries = reconnectTries.filter((t) => now - t < 60_000);
  if (reconnectTries.length >= 3) return;
  reconnectTries.push(now);
  setTimeout(() => connectCompanion(), 1000 * reconnectTries.length);
}

function registerCompanionHandlers(rpc) {
  rpc
    .handle('page.capture', capturePage)
    .handle('page.screenshot', screenshotPage)
    .on('review.update', ({ review }) => applyReview(review))
    .on('projects.changed', ({ projects }) => setCompanion({ projects }))
    .on('agents.update', ({ agents, candidates }) => setCompanion({ agents, candidates: candidates || [] }))
    .on('chats.update', ({ chats, devServers, candidates, mcp }) => setCompanion({ chats: chats || [], devServers: devServers || {}, candidates: candidates || [], mcp: mcp || {} }));
}

// Statuses from the companion's journal are authoritative for the review
// they belong to; a comment reopened locally no longer follows its old review.
function applyReview(review) {
  if (!review?.origin) return;
  return mutate(review.origin, (list) => {
    let changed = false;
    const next = list.map((a) => {
      const u = review.annotations.find((x) => x.id === a.id);
      if (!u || !(a.reviewId === review.id || submitting.has(a.id))) return a;
      if (a.status === 'accepted' && u.status !== 'accepted') return a;
      changed = true;
      const reviewInfo = { status: review.status, chatId: review.chatId || null, waitingFor: review.waitingFor || null };
      return { ...a, reviewId: review.id, reviewInfo, status: u.status, summary: u.summary || '', statusDetail: u.statusDetail || '', checks: u.checks || [], diffs: u.diffs || [] };
    });
    return changed ? next : null;
  });
}

async function submitReview(origin, ids, targetChatId) {
  if (!(await connectCompanion())) return { ok: false, error: 'local companion is not connected', code: 'companion_unavailable' };
  const list = await getAnnotations(origin);
  const items = ids.map((id) => list.find((a) => a.id === id)).filter((a) => a && a.status === 'open');
  if (!items.length) return { ok: false, error: 'nothing to send' };
  for (const a of items) submitting.add(a.id);
  try {
    const res = await peer.request('review.submit', {
      origin,
      targetChatId: targetChatId || null,
      annotations: items.map((a) => ({
        id: a.id, n: a.n, instruction: a.instruction, url: a.url, path: a.path,
        anchor: a.anchor, referenceAnchor: a.referenceAnchor, context: a.context, referenceContext: a.referenceContext, screenshot: a.screenshot,
      })),
    }, 60_000);
    await mutate(origin, (cur) => cur.map((a) => (items.some((x) => x.id === a.id) && a.status === 'open' ? { ...a, status: 'queued', reviewId: res.reviewId } : a)));
    await applyReview(res.review);
    return { ok: true, reviewId: res.reviewId, agentWaiting: res.agentWaiting, chatId: res.chatId };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  } finally {
    for (const a of items) submitting.delete(a.id);
  }
}

// ----------------------------------------------------------------- tabs

async function findTab(origin, url) {
  let path = '/';
  try { path = new URL(url).pathname; } catch {}
  const tabs = (await chrome.tabs.query({})).filter((t) => {
    try { return t.url && new URL(t.url).origin === origin; } catch { return false; }
  });
  const score = (t) => (new URL(t.url).pathname === path ? 4 : 0) + (t.active ? 2 : 0) + (t.lastAccessed || 0) / 1e15;
  return tabs.sort((a, b) => score(b) - score(a))[0] || null;
}

async function waitForTabComplete(tabId, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === 'complete') return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function ensureInjected(tabId) {
  const alive = await chrome.tabs.sendMessage(tabId, { type: 'bf.ping' }).catch(() => null);
  if (alive?.ok) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
    await chrome.scripting.executeScript({ target: { tabId }, files: [MAIN_WORLD_SCRIPT], world: 'MAIN' }).catch(() => {});
    return true;
  } catch { return false; }
}

// Pages reload under HMR; if the content script went away mid-request, wait
// for the reload to finish and try once more.
async function sendToTab(tabId, msg) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, msg);
    if (res !== undefined) return res;
  } catch {}
  await new Promise((r) => setTimeout(r, 300));
  await waitForTabComplete(tabId);
  await ensureInjected(tabId);
  return chrome.tabs.sendMessage(tabId, msg);
}

async function capturePage({ origin, url, mode, items, screenshot }) {
  const tab = await findTab(origin, url);
  if (!tab) return { items: [], error: 'page not open' };
  const res = await sendToTab(tab.id, { type: 'bf.capture', mode, items, screenshot });
  const refreshed = (res?.items || []).filter((i) => i.anchor);
  if (refreshed.length) {
    await mutate(origin, (list) => list.map((a) => {
      const u = refreshed.find((x) => x.annotationId === a.id);
      return u ? { ...a, anchor: u.anchor } : a;
    }));
  }
  return res;
}

async function screenshotPage({ origin, url }) {
  const tab = await findTab(origin, url);
  if (!tab) return { screenshot: null };
  return sendToTab(tab.id, { type: 'bf.screenshot' });
}

// captureVisibleTab is limited to 2 calls/second and needs activeTab or
// <all_urls>; content scripts treat a null result as "no screenshot".
let lastCapture = 0;
async function captureTab(tab, { crop, viewport, maxWidth = 800 }) {
  if (!tab?.active) return { dataUrl: null, error: 'tab not visible' };
  const wait = lastCapture + 550 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCapture = Date.now();
  let png;
  try {
    png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (err) {
    await chrome.storage.local.set({ screenshots: { ok: false, error: err.message, at: Date.now() } });
    return { dataUrl: null, error: err.message };
  }
  chrome.storage.local.set({ screenshots: { ok: true, at: Date.now() } });
  return { dataUrl: await cropToJpeg(png, crop, viewport, maxWidth) };
}

async function cropToJpeg(dataUrl, crop, viewport, maxWidth) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = viewport?.width ? bitmap.width / viewport.width : 1;
  const c = crop || { x: 0, y: 0, width: bitmap.width / scale, height: bitmap.height / scale };
  const sx = Math.max(0, Math.round(c.x * scale));
  const sy = Math.max(0, Math.round(c.y * scale));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(c.width * scale)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(c.height * scale)));
  const out = Math.min(1, maxWidth / sw);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(sw * out)), Math.max(1, Math.round(sh * out)));
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(bin)}`;
}

// ------------------------------------------------- dynamic content scripts
// Extra origins (*.test, LAN, staging) are opt-in via optional host permissions.

async function syncDynamicScripts() {
  const { origins = [] } = await chrome.permissions.getAll();
  const extra = origins.filter((o) => !DEFAULT_MATCHES.includes(o));
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['bf-dynamic', 'bf-dynamic-main'] }).catch(() => []);
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) }).catch(() => {});
  if (extra.length) {
    await chrome.scripting.registerContentScripts([
      { id: 'bf-dynamic', matches: extra, js: CONTENT_SCRIPTS, runAt: 'document_idle', persistAcrossSessions: true },
      { id: 'bf-dynamic-main', matches: extra, js: [MAIN_WORLD_SCRIPT], runAt: 'document_idle', world: 'MAIN', persistAcrossSessions: true },
    ]).catch((err) => console.warn(err));
  }
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const origin = msg?.origin;
  const handlers = {
    'ann.create': () => mutate(msg.annotation.origin, (list) => [...list, msg.annotation]).then(() => ({ ok: true })),
    'ann.update': () => mutate(origin, (list) => list.map((a) => (a.id === msg.id ? { ...a, ...msg.patch } : a))).then(() => ({ ok: true })),
    'ann.patchMany': () => mutate(origin, (list) => list.map((a) => {
      const p = (msg.patches || []).find((x) => x.id === a.id);
      return p ? { ...a, ...p.patch } : a;
    })).then(() => ({ ok: true })),
    'ann.delete': () => mutate(origin, (list) => list.filter((a) => a.id !== msg.id || IN_FLIGHT.has(a.status))).then(() => ({ ok: true })),
    'ann.clearDone': () => mutate(origin, (list) => list.filter((a) => a.status !== 'accepted' && a.status !== 'no_change')).then(() => ({ ok: true })),
    'ann.accept': async () => {
      await mutate(origin, (list) => list.map((a) => (a.id === msg.id ? { ...a, status: 'accepted' } : a)));
      if (peer && !peer.closed) peer.request('annotation.accept', { annotationId: msg.id }).catch(() => {});
      return { ok: true };
    },
    'review.submit': () => submitReview(origin, msg.ids, msg.targetChatId),
    'review.ringNow': async () => {
      if (!(await connectCompanion())) return { ok: false };
      for (const reviewId of msg.reviewIds || []) await peer.request('review.ringNow', { reviewId }).catch(() => {});
      return { ok: true };
    },
    'project.addOrigin': async () => {
      if (!(await connectCompanion())) return { ok: false, error: 'companion not connected' };
      try { await peer.request('project.addOrigin', { projectId: msg.projectId, origin }); return { ok: true }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    'companion.reconnect': async () => ({ ok: await connectCompanion() }),
    // Pages and the welcome screen call this; after `setup` the host appears
    // and the next attempt connects without the user doing anything.
    'companion.ensure': async () => ({ ok: companion.state === 'connected' || await connectCompanion() }),
    'project.connect': async () => {
      if (!(await connectCompanion())) return { ok: false, error: 'companion not connected' };
      try { return { ok: true, ...(await peer.request('project.connect', { candidateId: msg.candidateId, origin })) }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    'companion.status': async () => companion,
    'metric.observedChange': async () => { peer?.notify('metric.observedChange', { annotationId: msg.annotationId, at: msg.at }); return { ok: true }; },
    'review.cancel': async () => {
      if (!(await connectCompanion())) return { ok: false, error: 'companion not connected' };
      for (const reviewId of msg.reviewIds || []) await peer.request('review.cancel', { reviewId }).catch(() => {});
      return { ok: true };
    },
    'tab.capture': () => captureTab(sender.tab, msg),
    'tab.command': async () => {
      const tab = await chrome.tabs.get(msg.tabId);
      if (!(await ensureInjected(tab.id))) return { ok: false, error: 'This page can\'t be annotated' };
      return chrome.tabs.sendMessage(tab.id, { type: 'bf.command', name: msg.name });
    },
    'site.enable': async () => { await syncDynamicScripts(); return { ok: await ensureInjected(msg.tabId) }; },
  };
  const fn = handlers[msg?.type];
  if (!fn) return false;
  Promise.resolve().then(fn).then(reply, (err) => reply({ ok: false, error: err.message }));
  return true;
});

chrome.commands.onCommand.addListener(async (name, tab) => {
  if (!tab?.id) return;
  if (await ensureInjected(tab.id)) chrome.tabs.sendMessage(tab.id, { type: 'bf.command', name }).catch(() => {});
});

chrome.permissions.onAdded.addListener(syncDynamicScripts);
chrome.permissions.onRemoved.addListener(syncDynamicScripts);

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  await syncDynamicScripts();
  // Inject into localhost tabs that were open before install/update.
  const tabs = await chrome.tabs.query({ url: DEFAULT_MATCHES });
  for (const t of tabs) ensureInjected(t.id);
});

chrome.runtime.onStartup.addListener(() => connectCompanion());
connectCompanion();
