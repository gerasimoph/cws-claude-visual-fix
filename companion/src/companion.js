// Review state machine shared by the native host (extension side) and the MCP
// processes (agent side). Transport-agnostic: both sides are RpcPeers, which
// keeps this testable without Chrome or a real agent.
import { randomBytes } from 'node:crypto';
import './redact.js';
import { STATUS, FINAL_STATUSES, VERSION } from './constants.js';
import {
  loadProjects, saveProjects, findProjectByOrigin, findProjectByDirectory, normalizeOrigin,
  loadReviews, saveReview, saveScreenshot, readScreenshot, recordMetric, ensureDataDir,
} from './store.js';
import { runChecks, decideStatus, explainStatus, compareSignatures } from './verify.js';
import { describeProject } from './detect.js';
import { devServerFor, foldersRelated } from './devserver.js';
import { formatReviewForAgent, formatAnnotationFull, formatInspection, formatReportResult, ringText, CLAIM_MARKER } from './format.js';
import { log } from './log.js';

const { redactDeep, redactText } = globalThis.BFRedact;

const MAX_ANNOTATIONS = 50;
const MAX_INSTRUCTION = 4000;
const CAPTURE_TIMEOUT_MS = 20_000;
const AGENT_REPORT_STATUSES = new Set(['fixed', 'no_change', 'failed']);
const BUSY_STALE_MS = 15 * 60_000; // a missed Stop hook must not block rings forever
const CHAT_FORGET_MS = 24 * 3600_000;
const MAX_RINGS = 3;

export function newId(prefix) {
  return `${prefix}${randomBytes(4).toString('hex')}`;
}

export class Companion {
  constructor({ persist = true } = {}) {
    this.persist = persist;
    if (persist) ensureDataDir();
    this.projects = loadProjects();
    this.reviews = new Map(loadReviews().map((r) => [r.id, r]));
    this.extension = null; // RpcPeer
    this.sessions = new Map(); // agent session id -> session
    this.waiters = []; // { session, resolve, timer }
    this.chats = new Map(); // Claude Code session id -> chat known via doorbell hooks
    this.devServers = {}; // projectId -> { origin, dir } | null
  }

  // ---------------------------------------------------------------- extension

  attachExtension(peer) {
    this.extension = peer;
    peer
      .handle('hello', () => this.helloPayload())
      .handle('projects.list', () => ({ projects: this.reloadProjects() }))
      .handle('project.addOrigin', (p) => this.addOrigin(p))
      .handle('project.connect', (p) => this.connectProject(p))
      .handle('review.submit', (p) => this.submitReview(p))
      .handle('review.cancel', (p) => this.cancelReview(p))
      .handle('annotation.accept', (p) => this.acceptAnnotation(p))
      .handle('review.ringNow', (p) => this.ringNow(p))
      .onNotification('metric.observedChange', (p) => this.observedChange(p));
  }

  helloPayload() {
    return {
      version: VERSION,
      projects: this.reloadProjects(),
      reviews: [...this.reviews.values()].map((r) => this.compactReview(r)),
      agents: this.agentStatus(),
      candidates: this.candidates(),
      chats: this.chatList(),
      devServers: this.devServers,
      mcp: this.mcpPresence(),
    };
  }

  reloadProjects() {
    this.projects = loadProjects();
    return this.projects;
  }

  notifyProjectsChanged() {
    this.extension?.notify('projects.changed', { projects: this.reloadProjects() });
    this.placeAll();
  }

  addOrigin({ projectId, origin }) {
    const o = normalizeOrigin(origin);
    if (!o) throw new Error('Invalid origin');
    const projects = this.reloadProjects();
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new Error('Unknown project');
    for (const p of projects) p.origins = (p.origins || []).filter((x) => x !== o);
    project.origins.push(o);
    if (this.persist) saveProjects(projects);
    this.projects = projects;
    this.placeAll();
    this.moveReviews(o, project.id);
    this.notifyProjectsChanged();
    this.pushChats();
    this.dispatch(project.id);
    return { project };
  }

  // An agent running in a folder that is not a known project yet: the browser
  // confirms which page belongs to it (PRD §14.3 — confirmation is required).
  // `candidateId` names a folder where a Claude Code session runs (see candidates()).
  connectProject({ candidateId, origin }) {
    const o = normalizeOrigin(origin);
    if (!o) throw new Error('Invalid origin');
    const holder = this.allSessions().find((s) => s.folder?.id === candidateId);
    if (!holder) throw new Error('That Claude Code session is gone — open it again in the project folder');
    const { defaultPort, ...facts } = holder.folder;
    const projects = this.reloadProjects();
    for (const p of projects) p.origins = (p.origins || []).filter((x) => x !== o);
    const existing = projects.find((p) => p.id === facts.id) || projects.find((p) => p.workingDirectory === facts.workingDirectory);
    if (existing) facts.id = existing.id;
    const project = {
      ...(existing || {}),
      ...facts,
      origins: [...new Set([o, ...(existing?.origins || [])])],
      agentMode: 'attach',
      connectedAt: existing?.connectedAt || new Date().toISOString(),
    };
    const next = [...projects.filter((p) => p.id !== project.id), project];
    if (this.persist) saveProjects(next);
    this.projects = next;
    this.placeAll();
    this.moveReviews(o, project.id);
    recordMetric('project_connected', { framework: project.framework || null, via: 'browser' });
    this.notifyProjectsChanged();
    this.pushAgents();
    this.pushChats();
    this.dispatch(project.id);
    return { project };
  }

  // A page moved to another project: its waiting reviews follow it.
  moveReviews(origin, projectId) {
    for (const r of this.reviews.values()) {
      if (r.origin !== origin || r.status !== 'pending' || r.projectId === projectId) continue;
      Object.assign(r, { projectId, chatId: null, targetChatId: null, waitingFor: null, rings: 0, ringedAt: null });
      this.save(r);
      this.pushReview(r);
    }
  }

  ringNow({ reviewId }) {
    const review = this.reviews.get(reviewId);
    if (!review || review.status !== 'pending') return { ok: false };
    review.force = true;
    this.dispatch(review.projectId);
    return { ok: true };
  }

  submitReview({ origin, annotations, targetChatId }) {
    const o = normalizeOrigin(origin);
    const project = findProjectByOrigin(this.reloadProjects(), o);
    if (!project) {
      const err = new Error(`${o} isn't connected to a project`);
      err.code = 'project_not_connected';
      throw err;
    }
    if (!Array.isArray(annotations) || annotations.length === 0) throw new Error('Review has no comments');
    if (annotations.length > MAX_ANNOTATIONS) throw new Error(`A review can hold at most ${MAX_ANNOTATIONS} comments`);

    const review = {
      id: newId('r_'),
      projectId: project.id,
      origin: o,
      status: 'pending',
      createdAt: Date.now(),
      targetChatId: typeof targetChatId === 'string' ? targetChatId : null,
      annotations: annotations.map((a, i) => this.importAnnotation(a, i)),
    };
    for (const a of review.annotations) {
      if (a.beforeShotData) a.beforeShot = this.storeShot(`${review.id}-${a.id}-before`, a.beforeShotData);
      delete a.beforeShotData;
    }
    this.reviews.set(review.id, review);
    this.save(review);
    recordMetric('review_submitted', { annotations_in_review: review.annotations.length, framework: project.framework || null, agent_mode: 'attach' });

    this.pushReview(review);
    this.dispatch(project.id);
    const agentWaiting = review.status === 'running' || !!review.ringedAt || this.waiters.some((w) => this.waiterMatches(w, project.id));
    return { reviewId: review.id, agentWaiting, chatId: review.chatId || null, review: this.compactReview(review) };
  }

  importAnnotation(a, index) {
    if (!a || typeof a.id !== 'string' || !/^[\w-]{1,64}$/.test(a.id)) throw new Error('Invalid annotation id');
    const instruction = String(a.instruction || '').trim().slice(0, MAX_INSTRUCTION);
    if (!instruction) throw new Error('Comment text is empty');
    return {
      id: a.id,
      n: Number.isInteger(a.n) ? a.n : index + 1,
      instruction,
      url: typeof a.url === 'string' ? a.url : '',
      path: typeof a.path === 'string' ? a.path : '',
      anchor: redactDeep(a.anchor || null),
      referenceAnchor: a.referenceAnchor ? redactDeep(a.referenceAnchor) : null,
      context: redactDeep(a.context || null),
      referenceContext: a.referenceContext ? redactDeep(a.referenceContext) : null,
      beforeShotData: typeof a.screenshot === 'string' ? a.screenshot : null,
      beforeShot: null,
      afterShot: null,
      status: STATUS.QUEUED,
      agentStatus: null,
      summary: '',
      statusDetail: '',
      checks: [],
      diffs: [],
      baseline: null,
      agentObservedChange: false,
      times: { queuedAt: Date.now() },
    };
  }

  cancelReview({ reviewId }) {
    const review = this.reviews.get(reviewId);
    if (!review || review.status === 'done') return { ok: true };
    for (const a of review.annotations) {
      if (!FINAL_STATUSES.has(a.status)) { a.status = STATUS.FAILED; a.statusDetail = 'Cancelled in the browser'; }
    }
    this.closeReview(review);
    return { ok: true };
  }

  acceptAnnotation({ annotationId }) {
    const found = this.findAnnotation(annotationId);
    if (!found) return { ok: false };
    const { review, annotation } = found;
    if (![STATUS.FIXED, STATUS.CHANGED_CHECK, STATUS.NO_CHANGE].includes(annotation.status)) {
      throw new Error(`Can't accept a comment in status ${annotation.status}`);
    }
    annotation.status = STATUS.ACCEPTED;
    annotation.times.acceptedAt = Date.now();
    this.save(review);
    this.pushReview(review);
    recordMetric('annotation_accepted', { verification_result: annotation.checks?.every((c) => c.pass) ? 'pass' : 'fail' });
    return { ok: true };
  }

  observedChange({ annotationId, at }) {
    const found = this.findAnnotation(annotationId);
    if (!found) return;
    const { review, annotation } = found;
    const t = Number(at) || Date.now();
    if (!annotation.times.firstChangeAt) annotation.times.firstChangeAt = t;
    if (!review.firstChangeAt) {
      review.firstChangeAt = t;
      recordMetric('first_visible_change', { time_to_first_change: t - review.createdAt, annotations_in_review: review.annotations.length });
    }
    this.save(review);
  }

  // -------------------------------------------------------------------- agent

  attachAgent(peer) {
    const session = { id: newId('s_'), peer, projectId: null, cwd: null, client: null, reviewId: null };
    this.sessions.set(session.id, session);
    peer
      .handle('hello', (p) => this.agentHello(session, p))
      .handle('waitForReview', (p) => this.waitForReview(session, p))
      .handle('listAnnotations', () => this.listAnnotations(session))
      .handle('getAnnotation', (p) => this.getAnnotation(session, p))
      .handle('inspectElement', (p) => this.inspectElement(session, p))
      .handle('screenshot', (p) => this.screenshot(session, p))
      .handle('reportAnnotation', (p) => this.reportAnnotation(session, p))
      .onNotification('cancelWait', () => this.cancelWait(session));
    return session;
  }

  cancelWait(session) {
    this.waiters = this.waiters.filter((w) => {
      if (w.session !== session) return true;
      clearTimeout(w.timer);
      w.resolve({ review: null, text: 'Cancelled' });
      return false;
    });
    this.pushAgents();
  }

  detachAgent(session) {
    if (!this.sessions.delete(session.id)) return;
    if (session.cwd) this.pushChats();
    this.waiters = this.waiters.filter((w) => {
      if (w.session !== session) return true;
      clearTimeout(w.timer);
      return false;
    });
    this.pushAgents();
  }

  agentHello(session, { cwd, client }) {
    session.client = typeof client === 'string' ? client.slice(0, 80) : null;
    this.place(session, typeof cwd === 'string' ? cwd : null, this.reloadProjects());
    this.pushAgents();
    this.pushChats();
    const project = this.projects.find((p) => p.id === session.projectId);
    return { version: VERSION, project: project ? { id: project.id, name: project.name } : null, browserConnected: !!this.extension };
  }

  allSessions() {
    return [...this.sessions.values(), ...this.chats.values()];
  }

  // Maps a session or chat folder to its project; `folder` is what the panel
  // offers to connect when the page isn't linked to a project yet.
  place(s, cwd, projects = this.projects) {
    if (cwd !== undefined && cwd !== s.cwd) { s.cwd = cwd; s.folder = cwd ? describeProject(cwd) : null; }
    const project = s.cwd ? findProjectByDirectory(projects, s.cwd) : null;
    s.projectId = project?.id || null;
  }

  placeAll() {
    for (const s of this.allSessions()) this.place(s);
  }

  waiterMatches(w, projectId) {
    return w.session.projectId === projectId;
  }

  async waitForReview(session, { timeoutMs = 300_000, reviewId } = {}) {
    // A chat woken by the doorbell asks for the review it was rung for.
    if (reviewId) {
      const rung = this.reviews.get(reviewId);
      if (!rung) throw new Error(`Unknown review ${reviewId}`);
      if (rung.status === 'pending') { rung.deliveredVia = 'ring'; return this.assign(rung, session); }
      if (rung.status === 'running') return this.assign(rung, session, { resumed: true });
      return { review: null, text: `Review ${reviewId} is already finished.` };
    }
    const current = this.sessionReview(session);
    if (current && current.status === 'running') {
      // A review the agent never touched was probably lost (cancelled or timed-out
      // tool call): deliver it again instead of failing its comments.
      const untouched = current.annotations.every((a) => FINAL_STATUSES.has(a.status) || !a.times.touchedAt);
      if (untouched) return this.assign(current, session, { resumed: true });
      await this.finishReview(current, 'Not reported by the agent');
    }

    const resumable = this.findOrphanedReview(session);
    if (resumable) return this.assign(resumable, session, { resumed: true });

    const bellChat = this.doorbellChatFor(session);
    const pending = this.nextPendingReview(session);
    if (pending) {
      pending.deliveredVia = bellChat ? 'ring' : 'wait';
      return this.assign(pending, session);
    }

    // /ui-review in a Claude Code session whose doorbell hook works: no need to
    // block — pin the session and let Fix all wake it. Without a working
    // doorbell, fall through and wait here, so a review can't get stuck.
    if (bellChat) {
      this.claimChat(bellChat);
      this.pushChats();
      const linked = session.projectId
        ? ''
        : ' This folder is not linked to a page yet: ask the user to open the app in Chrome and click "Connect to …" in the review panel.';
      return {
        review: null,
        ready: true,
        text: `This session is set up: when the user presses "Fix all" in the browser, a Browser Feedback notice arrives here with a review_id. Nothing else to do now — tell the user it's ready.${linked}`,
      };
    }

    return new Promise((resolve) => {
      const waiter = { session, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        this.pushAgents();
        const hint = session.projectId ? '' : ' This folder is not connected to a page yet: ask the user to open the app in Chrome and click "Connect" in the review panel.';
        resolve({ review: null, text: `No review yet.${hint} Call wait_for_review again to keep waiting for the user to press "Fix all" in the browser.` });
      }, Math.max(1000, Math.min(Number(timeoutMs) || 300_000, 3_600_000)));
      this.waiters.push(waiter);
      this.pushAgents();
    });
  }

  findOrphanedReview(session) {
    const liveOwners = new Set([...this.sessions.values()].map((s) => s.reviewId).filter(Boolean));
    return [...this.reviews.values()].find((r) => r.status === 'running' && !liveOwners.has(r.id)
      && r.projectId === session.projectId) || null;
  }

  nextPendingReview(session) {
    const busyProjects = new Set([...this.reviews.values()].filter((r) => r.status === 'running').map((r) => r.projectId));
    return [...this.reviews.values()]
      .filter((r) => r.status === 'pending' && !busyProjects.has(r.projectId) && r.projectId === session.projectId)
      .sort((a, b) => a.createdAt - b.createdAt)[0] || null;
  }

  dispatch(projectId) {
    if ([...this.reviews.values()].some((r) => r.status === 'running' && r.projectId === projectId)) return;
    const review = [...this.reviews.values()]
      .filter((r) => r.status === 'pending' && r.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!review) return;
    // 1. An agent blocked in wait_for_review (/ui-review loop, or agents without hooks).
    const waiter = this.waiters.find((w) => this.waiterMatches(w, projectId));
    if (waiter && !review.targetChatId) {
      this.waiters = this.waiters.filter((w) => w !== waiter);
      clearTimeout(waiter.timer);
      review.deliveredVia = 'wait';
      this.assign(review, waiter.session).then(waiter.resolve, (err) => waiter.resolve({ review: null, text: `Error: ${err.message}` }));
      return;
    }
    // 2. Ring the chosen Claude Code chat.
    this.ringChat(review);
  }

  // ------------------------------------------------------------------- chats
  // Claude Code chats announce themselves through the doorbell hook. Fix all
  // goes to one chat: the one picked in the panel, else the one that ran
  // /ui-review, else one working in the dev server's folder, else the most
  // recently active one in the project.

  attachDoorbell(peer) {
    peer
      .handle('bell.register', (p) => this.registerBell(peer, p))
      .handle('bell.end', (p) => this.endChat(p))
      .handle('debug.state', () => this.debugState());
  }

  registerBell(peer, { sessionId, cwd, title, event, prompt }) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId required');
    const now = Date.now();
    let chat = this.chats.get(sessionId);
    if (!chat) {
      chat = { id: sessionId, cwd: null, folder: null, title: null, projectId: null, busy: false, busySince: 0, claimed: false, bell: null, startedAt: now, rings: 0 };
      this.chats.set(sessionId, chat);
    }
    if (typeof cwd === 'string' && cwd !== chat.cwd) this.place(chat, cwd, this.reloadProjects());
    if (title) chat.title = String(title).slice(0, 80);
    chat.lastActiveAt = now;
    if (event === 'UserPromptSubmit') {
      chat.busy = true;
      chat.busySince = now;
      if (prompt && (/^\s*\/ui-review\b/.test(prompt) || prompt.includes(CLAIM_MARKER))) this.claimChat(chat);
    } else {
      chat.busy = false;
    }
    if (chat.bell) chat.bell.resolve({ action: 'stop' }); // a newer doorbell replaces it
    const result = new Promise((resolve) => { chat.bell = { resolve, peer }; });
    peer.onClose = () => { if (chat.bell?.peer === peer) { chat.bell = null; this.pushChats(); } };
    if (chat.projectId) this.dispatch(chat.projectId);
    this.pushChats();
    return result;
  }

  endChat({ sessionId }) {
    const chat = this.chats.get(sessionId);
    if (chat) {
      chat.bell?.resolve({ action: 'stop' });
      this.chats.delete(sessionId);
      this.pushChats();
    }
    return { ok: true };
  }

  // The doorbell chat running in the same folder as this MCP connection.
  doorbellChatFor(session) {
    if (!session.cwd) return null;
    return [...this.chats.values()]
      .filter((c) => c.bell && c.cwd === session.cwd)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0] || null;
  }

  claimChat(chat) {
    for (const c of this.chats.values()) if (c.projectId === chat.projectId) c.claimed = false;
    chat.claimed = true;
  }

  isBusy(chat) {
    return chat.busy && Date.now() - chat.busySince < BUSY_STALE_MS;
  }

  chatsFor(projectId) {
    const now = Date.now();
    for (const [id, c] of this.chats) if (!c.bell && now - c.lastActiveAt > CHAT_FORGET_MS) this.chats.delete(id);
    return [...this.chats.values()].filter((c) => c.projectId === projectId);
  }

  pickChat(projectId, targetChatId) {
    const chats = this.chatsFor(projectId);
    if (!chats.length) return null;
    if (targetChatId) {
      const target = chats.find((c) => c.id === targetChatId);
      if (target) return target;
    }
    const claimed = chats.find((c) => c.claimed);
    if (claimed) return claimed;
    const dev = this.devServers[projectId]?.dir;
    const pool = dev ? chats.filter((c) => foldersRelated(c.cwd, dev)) : [];
    return (pool.length ? pool : chats).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
  }

  ringChat(review) {
    const chat = (review.chatId && this.chats.get(review.chatId)) || this.pickChat(review.projectId, review.targetChatId);
    if (!chat) { review.waitingFor = 'no_chat'; this.pushReview(review); return; }
    review.chatId = chat.id;
    if (!chat.bell) { review.waitingFor = 'chat_offline'; this.pushReview(review); return; }
    if (this.isBusy(chat) && !review.force) { review.waitingFor = 'chat_busy'; this.pushReview(review); return; }
    if ((review.rings || 0) >= MAX_RINGS) { review.waitingFor = 'not_picked_up'; this.pushReview(review); return; }
    const project = this.projects.find((p) => p.id === review.projectId);
    chat.bell.resolve({ action: 'ring', text: ringText(review, project) });
    chat.bell = null;
    review.rings = (review.rings || 0) + 1;
    review.ringedAt = Date.now();
    review.waitingFor = 'pickup';
    recordMetric('review_rung', { busy_forced: !!review.force });
    this.save(review);
    this.pushReview(review);
    this.pushChats();
  }

  mcpPresence() {
    const out = {};
    for (const s of this.sessions.values()) if (s.projectId) out[s.projectId] = (out[s.projectId] || 0) + 1;
    return out;
  }

  chatList() {
    return [...this.chats.values()].map((c) => ({
      id: c.id,
      title: c.title,
      cwd: c.cwd,
      projectId: c.projectId,
      folderId: c.folder?.id || null,
      lastActiveAt: c.lastActiveAt,
      busy: this.isBusy(c),
      online: !!c.bell,
      claimed: c.claimed,
    }));
  }

  async refreshDevServers() {
    const next = {};
    for (const p of this.projects) {
      for (const origin of p.origins || []) {
        const found = await devServerFor(origin);
        if (found) { next[p.id] = { origin, dir: found.dir }; break; }
      }
      next[p.id] ||= null;
    }
    this.devServers = next;
    return next;
  }

  pushChats() {
    if (!this.extension) return;
    this.extension.notify('chats.update', { chats: this.chatList(), devServers: this.devServers, candidates: this.candidates(), mcp: this.mcpPresence() });
    clearTimeout(this._devTimer);
    this._devTimer = setTimeout(async () => {
      const before = JSON.stringify(this.devServers);
      await this.refreshDevServers().catch(() => {});
      if (JSON.stringify(this.devServers) !== before) this.extension?.notify('chats.update', { chats: this.chatList(), devServers: this.devServers, candidates: this.candidates(), mcp: this.mcpPresence() });
    }, 50);
  }

  async assign(review, session, { resumed = false } = {}) {
    review.status = 'running';
    review.assignedAt ||= Date.now();
    review.waitingFor = null;
    session.reviewId = review.id;
    const missing = review.annotations.filter((a) => !a.baseline && !FINAL_STATUSES.has(a.status));
    if (missing.length) await this.captureBaselines(review, missing);
    const first = review.annotations.find((a) => !FINAL_STATUSES.has(a.status));
    if (first && first.status === STATUS.QUEUED) this.setStatus(first, STATUS.WORKING);
    this.save(review);
    this.pushReview(review);
    this.pushAgents();
    const project = this.projects.find((p) => p.id === review.projectId);
    const open = { ...review, annotations: review.annotations.filter((a) => !FINAL_STATUSES.has(a.status)) };
    const header = resumed ? 'Resuming an unfinished review. Comments already reported are not listed.\n\n' : '';
    return { review: { id: review.id, count: open.annotations.length }, text: header + formatReviewForAgent(open, project, { via: review.deliveredVia }) };
  }

  sessionReview(session) {
    return session.reviewId ? this.reviews.get(session.reviewId) : null;
  }

  requireAnnotation(id) {
    const found = this.findAnnotation(id);
    if (!found) throw new Error(`Unknown comment id ${id}. Use list_annotations to see the current ids.`);
    found.annotation.times.touchedAt ||= Date.now();
    return found;
  }

  listAnnotations(session) {
    const review = this.sessionReview(session);
    if (!review) return { text: 'No active review. Call wait_for_review to get one.' };
    const lines = [`Review ${review.id} — ${review.origin}`];
    for (const a of review.annotations) {
      lines.push(`- ${a.n}. \`${a.id}\` [${a.status}] ${a.instruction}`);
    }
    return { text: lines.join('\n') };
  }

  async getAnnotation(session, { id }) {
    const { review, annotation } = this.requireAnnotation(id);
    if (annotation.status === STATUS.QUEUED) {
      this.setStatus(annotation, STATUS.WORKING);
      await this.captureBaselines(review, [annotation]);
      this.save(review);
      this.pushReview(review);
    }
    const image = readScreenshot(annotation.beforeShot);
    return { text: formatAnnotationFull(annotation), image, imageCaption: image ? 'Screenshot of the element when the comment was created (before):' : null };
  }

  async inspectElement(session, { id }) {
    const { review, annotation } = this.requireAnnotation(id);
    const res = await this.capture(review, [annotation], { mode: 'inspect' });
    const sig = res.get(annotation.id)?.signature || null;
    const cmp = annotation.baseline && sig ? compareSignatures(annotation.baseline, sig) : null;
    if (cmp?.changed) this.markObserved(review, annotation);
    return { text: formatInspection(annotation, sig, cmp) };
  }

  async screenshot(session, { id } = {}) {
    if (id) {
      const { review, annotation } = this.requireAnnotation(id);
      const res = await this.capture(review, [annotation], { mode: 'inspect', screenshot: true });
      const item = res.get(annotation.id);
      if (!item?.screenshot) throw new Error(screenshotFailure(item?.screenshotError));
      const cmp = annotation.baseline && item.signature ? compareSignatures(annotation.baseline, item.signature) : null;
      if (cmp?.changed) this.markObserved(review, annotation);
      return { text: `Current screenshot of comment ${annotation.n} (\`${annotation.id}\`): ${annotation.instruction}`, image: dataUrlToImage(item.screenshot) };
    }
    const review = this.sessionReview(session);
    const project = this.projects.find((p) => p.id === (review?.projectId || session.projectId));
    const origin = review?.origin || project?.origins?.[0];
    if (!origin) throw new Error('No page to screenshot — no active review and no project origin.');
    const url = review?.annotations?.find((a) => !FINAL_STATUSES.has(a.status))?.url || review?.annotations?.[0]?.url || origin;
    const res = await this.requestExtension('page.screenshot', { origin, url });
    if (!res?.screenshot) throw new Error(screenshotFailure(res?.error));
    return { text: `Current viewport of ${res.url || url}`, image: dataUrlToImage(res.screenshot) };
  }

  async reportAnnotation(session, { id, status, summary }) {
    if (!AGENT_REPORT_STATUSES.has(status)) throw new Error('status must be one of: fixed, no_change, failed');
    const { review, annotation } = this.requireAnnotation(id);
    if (annotation.status === STATUS.ACCEPTED) throw new Error('This comment was already accepted by the user.');
    const reportedAt = Date.now();
    annotation.agentStatus = status;
    annotation.summary = redactText(String(summary || '')).slice(0, 1000);
    annotation.times.reportedAt = reportedAt;

    let result;
    if (status === 'fixed') {
      this.setStatus(annotation, STATUS.VERIFYING);
      this.pushReview(review);
      result = await this.verify(review, annotation);
    } else {
      result = { checks: [], diffs: [] };
    }
    annotation.checks = result.checks;
    annotation.diffs = result.diffs;
    const final = decideStatus({ agentStatus: status, checks: result.checks, agentObservedChange: annotation.agentObservedChange });
    this.setStatus(annotation, final);
    annotation.statusDetail = explainStatus({ status: final, checks: result.checks, agentObservedChange: annotation.agentObservedChange });
    annotation.times.verifiedAt = Date.now();
    recordMetric('annotation_reported', { status: final, time_to_report: reportedAt - (annotation.times.workingAt || annotation.times.queuedAt) });

    const next = review.annotations.find((a) => !FINAL_STATUSES.has(a.status) && a.status !== STATUS.VERIFYING);
    if (next && next.status === STATUS.QUEUED) {
      this.setStatus(next, STATUS.WORKING);
      await this.captureBaselines(review, [next]);
    }
    if (review.annotations.every((a) => FINAL_STATUSES.has(a.status))) this.closeReview(review);
    else { this.save(review); this.pushReview(review); }

    return {
      status: final,
      text: formatReportResult(annotation, { status: final, checks: result.checks, diffs: result.diffs, agentObservedChange: annotation.agentObservedChange, next, via: review.deliveredVia }),
    };
  }

  async verify(review, annotation) {
    const res = await this.capture(review, [annotation], { mode: 'verify', screenshot: true });
    const item = res.get(annotation.id);
    if (item?.screenshot) annotation.afterShot = this.storeShot(`${review.id}-${annotation.id}-after`, item.screenshot);
    const { checks, diffs } = runChecks({ instruction: annotation.instruction, baseline: annotation.baseline, after: item?.signature || null });
    recordMetric('annotation_verified', { verification_result: checks.every((c) => c.pass) ? 'pass' : 'fail' });
    return { checks, diffs };
  }

  async finishReview(review, reason) {
    if (!review || review.status === 'done') return;
    for (const a of review.annotations) {
      if (FINAL_STATUSES.has(a.status)) continue;
      const { checks, diffs } = await this.verify(review, a);
      const changed = checks.find((c) => c.name === 'changed')?.pass;
      a.checks = checks;
      a.diffs = diffs;
      this.setStatus(a, changed ? STATUS.CHANGED_CHECK : STATUS.FAILED);
      a.statusDetail = reason;
    }
    this.closeReview(review);
  }

  closeReview(review) {
    review.status = 'done';
    review.doneAt = Date.now();
    for (const s of this.sessions.values()) if (s.reviewId === review.id) s.reviewId = null;
    this.save(review);
    this.pushReview(review);
    this.pushAgents();
    this.dispatch(review.projectId);
  }

  // ------------------------------------------------------------ page capture

  async captureBaselines(review, annotations) {
    const res = await this.capture(review, annotations, { mode: 'baseline' });
    for (const a of annotations) {
      const sig = res.get(a.id)?.signature;
      if (sig) { a.baseline = sig; a.times.baselineAt = Date.now(); }
    }
  }

  // Asks the extension to capture element signatures, grouped by page URL.
  async capture(review, annotations, { mode, screenshot = false }) {
    const out = new Map();
    const byUrl = new Map();
    for (const a of annotations) {
      const key = a.url || review.origin;
      if (!byUrl.has(key)) byUrl.set(key, []);
      byUrl.get(key).push(a);
    }
    for (const [url, group] of byUrl) {
      let res = null;
      try {
        res = await this.requestExtension('page.capture', {
          origin: review.origin,
          url,
          mode,
          screenshot,
          items: group.map((a) => ({
            annotationId: a.id,
            anchor: a.anchor,
            referenceAnchor: a.referenceAnchor,
            baseline: mode === 'verify' ? a.baseline : undefined,
          })),
        });
      } catch (err) {
        log('host', `capture ${mode} failed`, err.message);
      }
      for (const item of res?.items || []) {
        const a = group.find((x) => x.id === item.annotationId);
        if (!a) continue;
        if (item.anchor) a.anchor = redactDeep(item.anchor);
        out.set(a.id, { signature: item.signature ? redactDeep(item.signature) : null, screenshot: item.screenshot || null, screenshotError: item.screenshotError || null });
      }
    }
    return out;
  }

  async requestExtension(method, params) {
    if (!this.extension || this.extension.closed) throw new Error('The browser is not connected to the companion');
    return this.extension.request(method, params, CAPTURE_TIMEOUT_MS);
  }

  // ------------------------------------------------------------------ helpers

  storeShot(name, dataUrl) {
    if (!this.persist) return null;
    try { return saveScreenshot(name, dataUrl); } catch (err) { log('host', 'screenshot not saved', err.message); return null; }
  }

  markObserved(review, annotation) {
    if (annotation.agentObservedChange) return;
    annotation.agentObservedChange = true;
    annotation.times.observedAt = Date.now();
    this.save(review);
  }

  setStatus(annotation, status) {
    annotation.status = status;
    annotation.times[`${status}At`] = Date.now();
  }

  findAnnotation(id) {
    for (const review of [...this.reviews.values()].reverse()) {
      const annotation = review.annotations.find((a) => a.id === id);
      if (annotation) return { review, annotation };
    }
    return null;
  }

  save(review) {
    if (this.persist) {
      try { saveReview(review); } catch (err) { log('host', 'save failed', err); }
    }
  }

  compactReview(review) {
    return {
      id: review.id,
      projectId: review.projectId,
      origin: review.origin,
      status: review.status,
      chatId: review.chatId || null,
      waitingFor: review.waitingFor || null,
      deliveredVia: review.deliveredVia || null,
      annotations: review.annotations.map((a) => ({
        id: a.id,
        status: a.status,
        summary: a.summary,
        statusDetail: a.statusDetail,
        checks: a.checks,
        diffs: (a.diffs || []).slice(0, 8),
      })),
    };
  }

  pushReview(review) {
    this.extension?.notify('review.update', { review: this.compactReview(review) });
  }

  agentStatus() {
    const status = {};
    for (const s of this.sessions.values()) {
      if (s.reviewId) {
        const r = this.reviews.get(s.reviewId);
        if (r) status[r.projectId] = 'working';
      }
    }
    for (const w of this.waiters) {
      if (w.session.projectId) status[w.session.projectId] ||= 'waiting';
    }
    return status;
  }

  // Folders with a live Claude Code session or MCP connection — what the panel
  // offers when a page isn't linked to a project yet.
  candidates() {
    const out = new Map();
    for (const s of this.allSessions()) {
      if (!s.folder) continue;
      const waiting = this.waiters.some((w) => w.session === s) || !!s.bell;
      const prev = out.get(s.folder.id);
      out.set(s.folder.id, { ...s.folder, projectId: s.projectId, waiting: waiting || !!prev?.waiting, doorbell: !!s.bell || !!prev?.doorbell });
    }
    return [...out.values()];
  }

  // For `browser-feedback status`: what the companion currently knows.
  debugState() {
    return {
      version: VERSION,
      browserConnected: !!this.extension,
      projects: this.projects.map((p) => ({ name: p.name, workingDirectory: p.workingDirectory, origins: p.origins })),
      chats: [...this.chats.values()].map((c) => ({ id: c.id, title: c.title, cwd: c.cwd, project: this.projects.find((p) => p.id === c.projectId)?.name || null, online: !!c.bell, busy: this.isBusy(c), lastActiveAt: c.lastActiveAt })),
      mcpSessions: [...this.sessions.values()].filter((s) => s.cwd).map((s) => ({ cwd: s.cwd, client: s.client, project: this.projects.find((p) => p.id === s.projectId)?.name || null, waiting: this.waiters.some((w) => w.session === s) })),
      pendingReviews: [...this.reviews.values()].filter((r) => r.status !== 'done').map((r) => ({ id: r.id, origin: r.origin, status: r.status, waitingFor: r.waitingFor || null })),
    };
  }

  pushAgents() {
    this.extension?.notify('agents.update', { agents: this.agentStatus(), candidates: this.candidates() });
  }
}

function screenshotFailure(reason) {
  if (/activeTab|all_urls/.test(reason || '')) {
    return 'Screenshots are not enabled for this tab yet. Ask the user to click the Browser Feedback toolbar icon once on the page. Use inspect_element meanwhile — it does not need screenshots.';
  }
  return `Could not capture a screenshot (${reason || 'page not open in Chrome'}). Use inspect_element instead.`;
}

export function dataUrlToImage(dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl || '');
  return m ? { mimeType: m[1], data: m[2] } : null;
}
