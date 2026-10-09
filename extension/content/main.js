// Content-script controller: element selection (PRD §16), comments and pins
// (§17), Review panel state, and page capture for the companion (§27).
// The background service worker is the single writer of annotation storage.
(() => {
  'use strict';
  const BF = (globalThis.BF ||= {});
  if (BF.main) return;
  BF.main = true;

  const ORIGIN = location.origin;
  const ANN_KEY = `ann:${ORIGIN}`;
  const INSTALL_PROMPT = globalThis.BFOnboarding.installPrompt(chrome.runtime.id);
  const STATUS_CMD = 'node ~/.browser-feedback/app/bin/browser-feedback.js status';
  const IN_FLIGHT = new Set(['queued', 'working', 'verifying']);
  const CAN_ACCEPT = new Set(['fixed', 'changed_check', 'no_change']);
  const { redactUrl } = globalThis.BFRedact;

  let annotations = [];
  let companion = { state: 'unknown', projects: [], agents: {} };
  let prefs = { panelOpen: false, collapsed: false };
  let screenshots = { ok: true };
  let mode = null; // null | 'peek' (Alt held) | 'select' | 'reference'
  let hoverEl = null;
  let upStack = [];
  let composer = null; // { el, reference, draft }
  let openCardId = null;
  const resolved = new Map(); // annotation id -> { el, method, at }
  const changeWatch = new Map(); // annotation id -> baseline fingerprint (first-visible-change metric)

  const ui = new BF.UI(onUiEvent);

  // ---------------------------------------------------------------- storage

  const send = (msg) => chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: err.message }));

  chrome.storage.local.get([ANN_KEY, 'companion', 'prefs', 'screenshots']).then((s) => {
    screenshots = s.screenshots || screenshots;
    annotations = s[ANN_KEY] || [];
    companion = s.companion || companion;
    prefs = { ...prefs, ...(s.prefs || {}) };
    render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[ANN_KEY]) {
      annotations = changes[ANN_KEY].newValue || [];
      for (const id of resolved.keys()) if (!annotations.some((a) => a.id === id)) resolved.delete(id);
    }
    if (changes.companion) companion = changes.companion.newValue || companion;
    if (changes.prefs) prefs = { ...prefs, ...(changes.prefs.newValue || {}) };
    if (changes.screenshots) screenshots = changes.screenshots.newValue || screenshots;
    render();
  });

  function setPrefs(patch) {
    prefs = { ...prefs, ...patch };
    chrome.storage.local.set({ prefs });
    render();
  }

  // ---------------------------------------------------------------- picking

  function pageTarget(e) {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (!(t instanceof Element) || ui.contains(t) || t === document.documentElement) return null;
    return t;
  }

  function setMode(next) {
    mode = next;
    upStack = [];
    if (!mode) { hoverEl = null; ui.hideHighlight(); }
    ui.setSelecting(mode === 'select' || mode === 'reference', mode === 'reference' ? 'Click the reference element · Esc cancel' : undefined);
    document.documentElement.style.cursor = mode && mode !== 'peek' ? 'crosshair' : '';
  }

  function highlight(el) {
    hoverEl = el;
    ui.showHighlight(el, { kind: mode === 'reference' ? 'ref' : 'select' });
  }

  const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };

  function interceptPointer(e) {
    const active = mode === 'select' || mode === 'reference' || e.altKey;
    if (!active) return;
    const target = pageTarget(e);
    if (!target) return;
    swallow(e);
    if (e.type === 'click') pick(hoverEl && hoverEl.contains(target) ? hoverEl : target);
  }
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) {
    window.addEventListener(type, (e) => { if (type !== 'contextmenu' || mode) interceptPointer(e); }, true);
  }

  // DevTools device mode and touch screens send touch events. Without this, a
  // tap in selection mode reaches the app (buttons, React Native Pressables)
  // and the selection is lost. There is no hover on touch: the tapped element
  // is highlighted on touchstart and picked on touchend.
  const touchSelecting = (e) => mode === 'select' || mode === 'reference' || e.altKey;
  const touchTarget = (e) => {
    const t = e.changedTouches?.[0];
    const el = t ? document.elementFromPoint(t.clientX, t.clientY) : null;
    return el && !ui.contains(el) && el !== document.documentElement ? el : null;
  };
  window.addEventListener('touchstart', (e) => {
    if (!touchSelecting(e) || !pageTarget(e)) return;
    swallow(e);
    if (!mode) setMode('select');
    const el = touchTarget(e);
    if (el) highlight(el);
  }, { capture: true, passive: false });
  window.addEventListener('touchmove', (e) => {
    if (!touchSelecting(e) || !pageTarget(e)) return;
    swallow(e);
    const el = touchTarget(e);
    if (el && el !== hoverEl) { upStack = []; highlight(el); }
  }, { capture: true, passive: false });
  window.addEventListener('touchend', (e) => {
    if (!touchSelecting(e) || !pageTarget(e)) return;
    swallow(e); // also stops the synthetic mouse events and click
    pick(hoverEl || touchTarget(e));
  }, { capture: true, passive: false });
  window.addEventListener('touchcancel', (e) => { if (touchSelecting(e) && pageTarget(e)) swallow(e); }, { capture: true, passive: false });

  window.addEventListener('pointermove', (e) => {
    if (!mode && e.altKey && !composer) setMode('peek');
    if (!mode) return;
    if (mode === 'peek' && !e.altKey) { setMode(null); return; }
    const t = pageTarget(e);
    if (!t || t === hoverEl) return;
    // After ↑/↓ keep the keyboard choice while the pointer stays inside it.
    if (upStack.length && hoverEl?.contains(t)) return;
    upStack = [];
    highlight(t);
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Alt' && !mode && !composer) { setMode('peek'); return; }
    if (!mode) {
      if (e.key === 'Escape' && (composer || ui.hasCard())) { closeComposer(); closeCard(); }
      return;
    }
    if (e.key === 'Escape') { swallow(e); setMode(null); if (composer) reopenComposer(); return; }
    // ↑/↓ also work while Alt is held, so Alt+hover, ↑, click selects the parent.
    if (!hoverEl) return;
    if (e.key === 'ArrowUp') {
      swallow(e);
      const p = hoverEl.parentElement;
      if (p && p !== document.documentElement && p !== document.body) { upStack.push(hoverEl); highlight(p); }
    } else if (e.key === 'ArrowDown') {
      swallow(e);
      const c = upStack.pop() || hoverEl.firstElementChild;
      if (c) highlight(c);
    } else if (e.key === 'Enter' && mode !== 'peek') {
      swallow(e);
      pick(hoverEl);
    }
  }, true);

  window.addEventListener('keyup', (e) => { if (e.key === 'Alt' && mode === 'peek') setMode(null); }, true);
  window.addEventListener('blur', () => { if (mode === 'peek') setMode(null); });

  function pick(el) {
    if (!el) return;
    if (mode === 'reference' && composer) {
      composer.reference = el;
      setMode(null);
      ui.showReferenceBox(el);
      reopenComposer();
      return;
    }
    setMode(null);
    closeCard();
    composer = { el, reference: null, draft: '' };
    ui.showReferenceBox(null);
    ui.showHighlight(el, { kind: 'select' });
    ui.openComposer(el);
  }

  function reopenComposer() {
    if (!composer) return;
    if (!composer.el.isConnected) { closeComposer(); return; }
    ui.showHighlight(composer.el, { kind: 'select' });
    ui.openComposer(composer.el, { reference: composer.reference, draft: composer.draft });
  }

  function closeComposer() {
    composer = null;
    ui.closeCard();
    ui.hideHighlight();
    ui.showReferenceBox(null);
  }

  function closeCard() {
    openCardId = null;
    if (ui.cardIs('pin-card')) ui.closeCard();
  }

  // ---------------------------------------------------------------- create

  function newId() {
    const b = crypto.getRandomValues(new Uint8Array(5));
    return `a${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }

  async function createAnnotation(text, sendNow) {
    const { el, reference } = composer;
    closeComposer();
    const n = annotations.reduce((m, a) => Math.max(m, a.n || 0), 0) + 1;
    const annotation = {
      id: newId(),
      n,
      origin: ORIGIN,
      url: redactUrl(location.href),
      path: location.pathname,
      instruction: text,
      createdAt: Date.now(),
      status: 'open',
      anchor: BF.anchor.create(el),
      context: BF.capture.context(el),
      referenceAnchor: reference ? BF.anchor.create(reference) : null,
      referenceContext: reference ? BF.capture.context(reference) : null,
      screenshot: await screenshotOf(el, { maxWidth: 800 }),
    };
    resolved.set(annotation.id, { el, method: 'picked', at: Date.now() });
    const res = await send({ type: 'ann.create', annotation });
    if (!res?.ok) { ui.toast(`Couldn't save the comment: ${res?.error || 'unknown error'}`); return; }
    if (!prefs.panelOpen) setPrefs({ panelOpen: true });
    if (sendNow) await fixAll([annotation.id]);
  }

  // ---------------------------------------------------------------- actions

  async function fixAll(ids) {
    const targets = ids || annotations.filter((a) => a.status === 'open').map((a) => a.id);
    if (!targets.length) return;
    const res = await send({ type: 'review.submit', origin: ORIGIN, ids: targets, targetChatId: (prefs.targets || {})[ORIGIN] || null });
    if (!res?.ok) {
      ui.toast(res?.code === 'project_not_connected' ? 'This localhost isn\'t connected to a project yet.' : `Couldn't send the review: ${res?.error || 'companion not connected'}. You can Copy as Markdown instead.`, 5000);
      return;
    }
    const chat = (companion.chats || []).find((c) => c.id === res.chatId);
    const n = `${targets.length} comment${targets.length === 1 ? '' : 's'}`;
    ui.toast(res.agentWaiting ? `Sent ${n} to ${chat ? `«${chatName(chat)}»` : 'your agent'}.` : chat ? `Queued for «${chatName(chat)}».` : 'Queued — open Claude Code in the project folder to start.', res.agentWaiting ? 2600 : 5000);
  }

  async function copyMarkdown() {
    const open = annotations.filter((a) => a.status === 'open');
    const list = open.length ? open : annotations;
    const md = BF.capture.markdown(list, ORIGIN);
    try {
      await navigator.clipboard.writeText(md);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = md;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    ui.toast(`Copied ${list.length} comment${list.length === 1 ? '' : 's'} as Markdown.`);
  }

  function focusAnnotation(id) {
    const a = annotations.find((x) => x.id === id);
    if (!a) return;
    if (a.path !== location.pathname) { ui.toast(`This comment is on ${a.path}`); return; }
    const el = elementFor(a, { force: true });
    if (!el) { ui.toast('Element not found on the page.'); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => ui.flash(el), 350);
  }

  function onUiEvent(type, data = {}) {
    switch (type) {
      case 'composer:submit': return createAnnotation(data.text, data.send);
      case 'composer:draft': if (composer) composer.draft = data.text; return;
      case 'composer:cancel': return closeComposer();
      case 'composer:parent': {
        const p = composer?.el?.parentElement;
        if (!p || p === document.body || p === document.documentElement) return;
        composer.el = p;
        return reopenComposer();
      }
      case 'composer:pickReference': ui.closeCard(); return setMode('reference');
      case 'composer:clearReference': if (composer) composer.reference = null; ui.showReferenceBox(null); return reopenComposer();
      case 'card:close': return closeCard();
      case 'pin:click': {
        const a = annotations.find((x) => x.id === data.id);
        if (!a) return;
        if (openCardId === a.id) return closeCard();
        closeComposer();
        openCardId = a.id;
        return ui.openPinCard(itemView(a), data.rect);
      }
      case 'item:focus': return focusAnnotation(data.id);
      case 'item:accept': return send({ type: 'ann.accept', origin: ORIGIN, id: data.id });
      case 'item:delete': closeCard(); return send({ type: 'ann.delete', origin: ORIGIN, id: data.id });
      case 'item:retry': return send({ type: 'ann.update', origin: ORIGIN, id: data.id, patch: { status: 'open', reviewId: null, summary: '', statusDetail: '', diffs: [], checks: [] } });
      case 'panel:fixall': return fixAll();
      case 'panel:copy': return copyMarkdown();
      case 'panel:clearDone': return send({ type: 'ann.clearDone', origin: ORIGIN });
      case 'panel:close': return setPrefs({ panelOpen: false });
      case 'panel:collapse': return setPrefs({ collapsed: !prefs.collapsed });
      case 'conn:action': return connAction(data.id);
      case 'target:change': return setPrefs({ targets: { ...(prefs.targets || {}), [ORIGIN]: data.id || null } });
      default:
    }
  }

  async function connAction(id) {
    if (id === 'reconnect') { await send({ type: 'companion.reconnect' }); return; }
    if (id === 'ring-now') {
      const reviewIds = [...new Set(annotations.filter((a) => IN_FLIGHT.has(a.status)).map((a) => a.reviewId))];
      await send({ type: 'review.ringNow', origin: ORIGIN, reviewIds });
      return;
    }
    if (id === 'cancel-review') {
      const reviewIds = [...new Set(annotations.filter((a) => IN_FLIGHT.has(a.status)).map((a) => a.reviewId))];
      await send({ type: 'review.cancel', origin: ORIGIN, reviewIds });
      return;
    }
    if (id === 'copy-install') { await navigator.clipboard.writeText(INSTALL_PROMPT).catch(() => {}); ui.toast('Copied — paste it into Claude Code.'); return; }
    if (id.startsWith('connect:')) {
      const res = await send({ type: 'project.connect', candidateId: id.slice(8), origin: ORIGIN });
      ui.toast(res?.ok ? `Connected ${location.host} to ${res.project.name}.` : `Couldn't connect: ${res?.error}`);
      return;
    }
    if (id.startsWith('add:')) {
      const res = await send({ type: 'project.addOrigin', projectId: id.slice(4), origin: ORIGIN });
      ui.toast(res?.ok ? 'Origin added to the project.' : `Couldn't add origin: ${res?.error}`);
    }
  }

  // ---------------------------------------------------------------- render

  function project() {
    return (companion.projects || []).find((p) => (p.origins || []).includes(ORIGIN)) || null;
  }

  function elementFor(a, { force = false } = {}) {
    const cached = resolved.get(a.id);
    if (cached?.el?.isConnected && !force) return cached.el;
    if (cached && !cached.el && !force && Date.now() - cached.at < 2000) return null;
    const r = BF.anchor.resolve(a.anchor);
    resolved.set(a.id, { el: r?.el || null, method: r?.method || null, at: Date.now() });
    return r?.el || null;
  }

  function itemView(a) {
    const onPage = a.path === location.pathname;
    const missing = onPage && !elementFor(a);
    return {
      id: a.id,
      n: a.n,
      instruction: a.instruction,
      status: a.status,
      summary: a.summary,
      statusDetail: a.statusDetail,
      diffs: a.diffs,
      meta: !onPage ? `on ${a.path}` : missing ? 'element not found' : '',
      canAccept: CAN_ACCEPT.has(a.status),
      canRetry: ['failed', 'changed_check', 'no_change'].includes(a.status) || (IN_FLIGHT.has(a.status) && companion.state !== 'connected'),
      canDelete: !IN_FLIGHT.has(a.status),
    };
  }

  // captureVisibleTab needs activeTab (granted when the user clicks the toolbar
  // icon or uses the shortcut on this tab) — localhost host permissions are not enough.
  const SCREENSHOT_NOTE = 'Screenshots are off for this tab: click the Browser Feedback toolbar icon once to turn them on.';

  function connectionView() {
    const view = baseConnectionView();
    if (screenshots.ok === false && /activeTab|all_urls/.test(screenshots.error || '')) view.note = SCREENSHOT_NOTE;
    if (view.note && !view.text) view.text = ' ';
    return view;
  }

  // Where an in-flight review is and what the user can do about it.
  function reviewStateView(a, agent) {
    const info = a.reviewInfo || {};
    const chat = (companion.chats || []).find((c) => c.id === info.chatId);
    const name = chat ? `«${chatName(chat)}»` : 'the session';
    const cancel = { id: 'cancel-review', label: 'Cancel review' };
    if (info.status === 'running' || agent === 'working') return { kind: 'ok', text: chat ? `Claude is working in ${name}` : 'Your agent is working on it' };
    switch (info.waitingFor) {
      case 'chat_busy': return { kind: 'warn', text: `Queued: ${name} is busy — Claude takes the review when it finishes the current task.`, actions: [{ id: 'ring-now', label: 'Send now' }, cancel] };
      case 'pickup': return { kind: 'ok', text: `Sent to ${name} — waiting for Claude to pick it up.`, actions: [cancel] };
      case 'chat_offline': return { kind: 'warn', text: `${name} isn't reachable right now. Send any message in it, or cancel and pick another session.`, actions: [cancel] };
      case 'not_picked_up': return { kind: 'error', text: `Claude didn't pick up the review in ${name}. Check the session, or cancel.`, actions: [cancel] };
      case 'no_chat': return { kind: 'warn', text: 'Waiting for a Claude Code session in this project — it starts as soon as you open one.', actions: [cancel] };
      default: return { kind: 'warn', text: 'Waiting for Claude Code to pick up the review.', actions: [cancel] };
    }
  }

  function projectChats() {
    const p = project();
    return p ? (companion.chats || []).filter((c) => c.projectId === p.id) : [];
  }

  function chatName(c) {
    return c.title || `${shortPath(c.cwd)} · ${c.id.slice(0, 6)}`;
  }

  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  }

  // Same rule as the companion: claimed, else in the dev server folder, else most recent.
  function autoChat(chats) {
    const claimed = chats.find((c) => c.claimed);
    if (claimed) return claimed;
    const dev = companion.devServers?.[project()?.id]?.dir;
    const pool = dev ? chats.filter((c) => related(c.cwd, dev)) : [];
    return [...(pool.length ? pool : chats)].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0] || null;
  }

  function related(a, b) {
    if (!a || !b) return false;
    const x = a.replace(/\/+$/, '');
    const y = b.replace(/\/+$/, '');
    return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  }

  // The "Fix all → session" row above the button.
  function targetView() {
    const p = project();
    if (!p || companion.state !== 'connected') return null;
    const chats = projectChats();
    if (!chats.length) return null;
    const chosenId = (prefs.targets || {})[ORIGIN];
    const chosen = chats.find((c) => c.id === chosenId) || null;
    const auto = autoChat(chats);
    const target = chosen || auto;
    const label = (c) => `${chatName(c)} · ${ago(c.lastActiveAt)}${c.busy ? ' · busy' : ''}${c.online ? '' : ' · offline'}${c.claimed ? ' · pinned' : ''}`;
    const dev = companion.devServers?.[p.id]?.dir;
    const warning = target && dev && target.cwd && !related(target.cwd, dev)
      ? `Dev server runs from ${shortPath(dev)}, this session works in ${shortPath(target.cwd)} — its changes won't show on this page.`
      : '';
    return {
      selected: chosen ? chosen.id : '',
      options: [{ id: '', label: `Auto → ${auto ? chatName(auto) : '—'}` }, ...chats.map((c) => ({ id: c.id, label: label(c) }))],
      warning,
    };
  }

  function shortPath(p) {
    const parts = String(p || '').split(/[\\/]/).filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
  }

  function baseConnectionView() {
    const p = project();
    const state = companion.state;
    if (state === 'not_installed') {
      return { kind: 'warn', text: 'One step left: paste this into Claude Code to let your agent fix comments. Until then, Copy as Markdown works.', command: INSTALL_PROMPT, actions: [{ id: 'copy-install', label: 'Copy' }, { id: 'reconnect', label: 'Retry' }] };
    }
    if (state !== 'connected') {
      return { kind: 'error', text: 'Local companion isn\'t connected. Comments still work — copy them as Markdown.', actions: [{ id: 'reconnect', label: 'Reconnect' }] };
    }
    if (!p) {
      // Folders where a Claude Code session runs right now: the user picks the one this page belongs to.
      const candidates = (companion.candidates || []).map((c) => ({ id: `connect:${c.id}`, label: `Connect to ${c.name} (${shortPath(c.workingDirectory)})` }));
      if (candidates.length) return { kind: 'warn', text: `Helper connected. Which project is ${location.host}? Pick the folder where Claude Code works on it:`, actions: candidates };
      return {
        kind: 'warn',
        text: `Helper connected, but ${location.host} isn't linked to a project, and no Claude Code session has checked in yet. Start or restart Claude Code in the project folder — it will show up here. Still nothing? Run in a terminal:`,
        command: STATUS_CMD,
      };
    }
    const agent = companion.agents?.[p.id];
    const flying = annotations.find((a) => IN_FLIGHT.has(a.status));
    // Claude Code runs in other folders but not in this page's project: the
    // page is probably linked to the wrong project. Offer to move it.
    const elsewhere = (companion.candidates || []).filter((c) => c.projectId !== p.id);
    if (agent !== 'working' && !projectChats().length && !companion.mcp?.[p.id] && elsewhere.length) {
      return {
        kind: 'warn',
        text: `This page is linked to ${p.name}, but Claude Code isn't open there — it's open in ${elsewhere.map((c) => c.name).join(', ')}. Is this page part of that project?`,
        actions: [
          ...elsewhere.map((c) => ({ id: `connect:${c.id}`, label: `Move page to ${c.name} (${shortPath(c.workingDirectory)})` })),
          ...(flying ? [{ id: 'cancel-review', label: 'Cancel review' }] : []),
        ],
      };
    }
    if (flying) return reviewStateView(flying, agent);
    if (agent === 'waiting') return { kind: 'ok', text: `Connected · ${p.name} · an agent is waiting for Fix all` };
    if (projectChats().length) return { kind: 'ok', text: `Connected · ${p.name}` };
    if (companion.mcp?.[p.id]) {
      return { kind: 'warn', text: `Claude Code is open in ${p.name}, but it can't be woken automatically (its hooks didn't check in). Restart that session, or type /ui-review in it — then Fix all goes there.` };
    }
    return { kind: 'warn', text: `No Claude Code session is open in ${p.name}. Open one in ${shortPath(p.workingDirectory)} — Fix all will go there. Or copy as Markdown.` };
  }

  // Offer the connection once per page when an agent is waiting in a folder
  // that isn't a project yet — otherwise the closed panel would hide it.
  function maybeOfferConnect() {
    if (prefs.panelOpen || project() || companion.state !== 'connected') return;
    if (!(companion.candidates || []).some((c) => c.waiting)) return;
    const offered = prefs.connectOffered || {};
    if (offered[ORIGIN]) return;
    setPrefs({ panelOpen: true, connectOffered: { ...offered, [ORIGIN]: Date.now() } });
  }

  function render() {
    maybeOfferConnect();
    renderPins();
    const items = annotations.map(itemView);
    const inFlight = annotations.filter((a) => IN_FLIGHT.has(a.status));
    let running = null;
    if (inFlight.length) {
      const reviewIds = new Set(inFlight.map((a) => a.reviewId));
      const inReview = annotations.filter((a) => reviewIds.has(a.reviewId));
      running = { done: inReview.length - inFlight.length, total: inReview.length };
    }
    const open = annotations.filter((a) => a.status === 'open').length;
    ui.renderPanel({
      open: prefs.panelOpen,
      collapsed: prefs.collapsed,
      title: project()?.name || location.host,
      countText: running ? `${inFlight.length} running` : `${open} open`,
      connection: connectionView(),
      items,
      running,
      fixAllCount: companion.state === 'connected' && project() ? open : 0,
      target: targetView(),
      hasDone: annotations.some((a) => a.status === 'accepted' || a.status === 'no_change'),
    });
    if (openCardId) {
      const a = annotations.find((x) => x.id === openCardId);
      if (a && ui.cardIs('pin-card')) {
        const el = elementFor(a);
        ui.openPinCard(itemView(a), el?.getBoundingClientRect());
      } else if (!a) closeCard();
    }
  }

  function renderPins() {
    ui.mount();
    const pins = [];
    for (const a of annotations) {
      if (a.path !== location.pathname) continue;
      const el = elementFor(a);
      pins.push({ id: a.id, n: a.n, status: a.status, instruction: a.instruction, rect: el ? el.getBoundingClientRect() : null });
    }
    ui.renderPins(pins);
    if (composer?.el?.isConnected) ui.showHighlight(composer.el, { kind: 'select' });
    if (composer?.reference?.isConnected) ui.showReferenceBox(composer.reference);
  }

  let rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderPins(); });
  }
  window.addEventListener('scroll', scheduleRender, { capture: true, passive: true });
  window.addEventListener('resize', scheduleRender, { passive: true });

  let mutationTimer = null;
  new MutationObserver((records) => {
    if (records.every((r) => ui.contains(r.target))) return;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      for (const [id, r] of resolved) if (r.el && !r.el.isConnected) resolved.delete(id);
      render();
    }, 200);
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

  // SPA navigation and layout drift; also records the first visible change of
  // queued comments for the "Fix all → first visible change" metric (K1).
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; resolved.clear(); render(); }
    else scheduleRender();
    watchForChanges();
  }, 1000);

  function fingerprint(el) {
    if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    return `${BF.capture.hash(el.outerHTML)}:${Math.round(r.width)}x${Math.round(r.height)}`;
  }

  function watchForChanges() {
    for (const a of annotations) {
      if (a.path !== location.pathname) continue;
      if (a.status === 'queued' || a.status === 'working') {
        const fp = fingerprint(elementFor(a));
        if (!changeWatch.has(a.id)) changeWatch.set(a.id, fp);
        else if (changeWatch.get(a.id) !== fp && changeWatch.get(a.id) !== 'reported') {
          changeWatch.set(a.id, 'reported');
          send({ type: 'metric.observedChange', annotationId: a.id, at: Date.now() });
        }
      } else changeWatch.delete(a.id);
    }
  }

  // ---------------------------------------------------------------- capture

  function waitForStable({ quietMs, maxMs, until }) {
    return new Promise((resolve) => {
      const start = Date.now();
      let quiet = null;
      const done = () => { obs.disconnect(); clearTimeout(quiet); clearTimeout(hard); resolve(); };
      const arm = () => { clearTimeout(quiet); quiet = setTimeout(() => (until && !until() && Date.now() - start < maxMs ? arm() : done()), quietMs); };
      const obs = new MutationObserver((records) => { if (!records.every((r) => ui.contains(r.target))) arm(); });
      obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const hard = setTimeout(done, maxMs);
      arm();
    });
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  let lastShotError = null;

  // Screenshot cropped around an element (or the viewport), without our UI.
  async function screenshotOf(el, { maxWidth = 800, pad = 40, scroll = false } = {}) {
    if (document.visibilityState !== 'visible') { lastShotError = 'tab is not visible'; return null; }
    if (el && scroll) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) { el.scrollIntoView({ block: 'center' }); await nextFrame(); }
    }
    let crop = null;
    if (el) {
      const r = el.getBoundingClientRect();
      const x = Math.max(0, r.left - pad);
      const y = Math.max(0, r.top - pad);
      const w = Math.min(innerWidth, r.right + pad) - x;
      const h = Math.min(innerHeight, r.bottom + pad) - y;
      if (w <= 0 || h <= 0) return null;
      crop = { x, y, width: w, height: h };
    }
    ui.setHidden(true);
    try {
      await nextFrame();
      await nextFrame();
      const res = await send({ type: 'tab.capture', crop, viewport: { width: innerWidth, height: innerHeight }, maxWidth });
      lastShotError = res?.dataUrl ? null : res?.error || 'capture failed';
      return res?.dataUrl || null;
    } finally {
      ui.setHidden(false);
    }
  }

  function sameAsBaseline(sig, base) {
    if (!base || !sig.found || !base.found) return false;
    return sig.subtreeHash === base.subtreeHash && sig.rect?.width === base.rect?.width && sig.rect?.height === base.rect?.height
      && JSON.stringify(sig.styles) === JSON.stringify(base.styles);
  }

  async function capturePage({ mode: captureMode, items, screenshot }) {
    if (captureMode === 'verify') {
      // HMR may still be compiling when the agent reports: settle, and if the
      // element looks untouched, keep waiting a little for a change to land.
      const untouched = () => items.every((i) => {
        const r = BF.anchor.resolve(i.anchor);
        return sameAsBaseline(BF.capture.signature(r?.el, r?.method), i.baseline);
      });
      await waitForStable({ quietMs: 600, maxMs: 8000, until: () => !untouched() });
    } else if (captureMode === 'inspect') {
      await waitForStable({ quietMs: 300, maxMs: 3000 });
    }
    const out = [];
    for (const item of items) {
      const r = BF.anchor.resolve(item.anchor);
      const el = r?.el || null;
      const signature = BF.capture.signature(el, r?.method);
      if (el && item.referenceAnchor) {
        const ref = BF.anchor.resolve(item.referenceAnchor);
        signature.reference = ref ? { found: true, rect: BF.capture.signature(ref.el).rect } : { found: false };
      }
      // Refresh the anchor so later re-anchoring survives class/text changes.
      const anchor = el && captureMode !== 'baseline' && r.method !== 'path-weak' ? BF.anchor.create(el) : null;
      if (el) resolved.set(item.annotationId, { el, method: r.method, at: Date.now() });
      const shot = screenshot && el ? await screenshotOf(el, { maxWidth: 800, scroll: captureMode === 'inspect' }) : null;
      out.push({ annotationId: item.annotationId, signature, anchor, screenshot: shot, screenshotError: screenshot && !shot ? lastShotError || 'element not found' : null });
    }
    scheduleRender();
    return { url: redactUrl(location.href), items: out };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg?.type) {
      case 'bf.ping': reply({ ok: true }); return false;
      case 'bf.capture': capturePage(msg).then(reply, (err) => reply({ error: err.message })); return true;
      case 'bf.screenshot':
        screenshotOf(null, { maxWidth: 1280 }).then((s) => reply({ url: redactUrl(location.href), screenshot: s, error: s ? null : lastShotError }), (err) => reply({ error: err.message }));
        return true;
      case 'bf.command':
        if (msg.name === 'start-selecting') { closeComposer(); setMode('select'); }
        if (msg.name === 'toggle-panel') setPrefs({ panelOpen: !prefs.panelOpen });
        if (msg.name === 'show-panel') setPrefs({ panelOpen: true });
        reply({ ok: true });
        return false;
      default:
        return false;
    }
  });

  render();
  send({ type: 'companion.ensure' });
})();
