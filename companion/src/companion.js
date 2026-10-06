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
import { formatReviewForAgent, formatAnnotationFull, formatInspection, formatReportResult } from './format.js';
import { log } from './log.js';

const { redactDeep, redactText } = globalThis.BFRedact;

const MAX_ANNOTATIONS = 50;
const MAX_INSTRUCTION = 4000;
const CAPTURE_TIMEOUT_MS = 20_000;
const AGENT_REPORT_STATUSES = new Set(['fixed', 'no_change', 'failed']);

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
      .onNotification('metric.observedChange', (p) => this.observedChange(p));
  }

  helloPayload() {
    return {
      version: VERSION,
      projects: this.reloadProjects(),
      reviews: [...this.reviews.values()].map((r) => this.compactReview(r)),
      agents: this.agentStatus(),
      candidates: this.candidates(),
    };
  }

  reloadProjects() {
    this.projects = loadProjects();
    return this.projects;
  }

  notifyProjectsChanged() {
    this.extension?.notify('projects.changed', { projects: this.reloadProjects() });
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
    this.notifyProjectsChanged();
    return { project };
  }

  // An agent running in a folder that is not a known project yet: the browser
  // confirms which page belongs to it (PRD §14.3 — confirmation is required).
  connectProject({ candidateId, origin }) {
    const o = normalizeOrigin(origin);
    if (!o) throw new Error('Invalid origin');
    const sessions = [...this.sessions.values()].filter((s) => s.candidate?.id === candidateId);
    if (!sessions.length) throw new Error('That agent session is gone — restart it in the project folder');
    const { defaultPort, ...facts } = sessions[0].candidate;
    const projects = this.reloadProjects();
    for (const p of projects) p.origins = (p.origins || []).filter((x) => x !== o);
    const existing = projects.find((p) => p.id === facts.id);
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
    for (const s of sessions) { s.projectId = project.id; s.candidate = null; }
    recordMetric('project_connected', { framework: project.framework || null, via: 'browser' });
    this.notifyProjectsChanged();
    this.pushAgents();
    this.dispatch(project.id);
    return { project };
  }

  submitReview({ origin, annotations }) {
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
      annotations: annotations.map((a, i) => this.importAnnotation(a, i)),
    };
    for (const a of review.annotations) {
      if (a.beforeShotData) a.beforeShot = this.storeShot(`${review.id}-${a.id}-before`, a.beforeShotData);
      delete a.beforeShotData;
    }
    this.reviews.set(review.id, review);
    this.save(review);
    recordMetric('review_submitted', { annotations_in_review: review.annotations.length, framework: project.framework || null, agent_mode: 'attach' });

    const agentWaiting = this.waiters.some((w) => this.waiterMatches(w, project.id));
    this.pushReview(review);
    this.dispatch(project.id);
    return { reviewId: review.id, agentWaiting, review: this.compactReview(review) };
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
    this.sessions.delete(session.id);
    this.waiters = this.waiters.filter((w) => {
      if (w.session !== session) return true;
      clearTimeout(w.timer);
      return false;
    });
    this.pushAgents();
  }

  agentHello(session, { cwd, client }) {
    session.cwd = typeof cwd === 'string' ? cwd : null;
    session.client = typeof client === 'string' ? client.slice(0, 80) : null;
    const project = findProjectByDirectory(this.reloadProjects(), session.cwd);
    session.projectId = project?.id || null;
    session.candidate = !project && session.cwd ? describeProject(session.cwd) : null;
    this.pushAgents();
    return { version: VERSION, project: project ? { id: project.id, name: project.name } : null, browserConnected: !!this.extension };
  }

  waiterMatches(w, projectId) {
    return w.session.projectId === projectId;
  }

  async waitForReview(session, { timeoutMs = 300_000 } = {}) {
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

    const pending = this.nextPendingReview(session);
    if (pending) return this.assign(pending, session);

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
    const waiter = this.waiters.find((w) => this.waiterMatches(w, projectId));
    if (!waiter) return;
    const review = this.nextPendingReview(waiter.session);
    if (!review) return;
    this.waiters = this.waiters.filter((w) => w !== waiter);
    clearTimeout(waiter.timer);
    this.assign(review, waiter.session).then(waiter.resolve, (err) => waiter.resolve({ review: null, text: `Error: ${err.message}` }));
  }

  async assign(review, session, { resumed = false } = {}) {
    review.status = 'running';
    review.assignedAt ||= Date.now();
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
    return { review: { id: review.id, count: open.annotations.length }, text: header + formatReviewForAgent(open, project) };
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
      text: formatReportResult(annotation, { status: final, checks: result.checks, diffs: result.diffs, agentObservedChange: annotation.agentObservedChange, next }),
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

  candidates() {
    const out = new Map();
    for (const s of this.sessions.values()) {
      if (!s.candidate) continue;
      const waiting = this.waiters.some((w) => w.session === s);
      const prev = out.get(s.candidate.id);
      out.set(s.candidate.id, { ...s.candidate, waiting: waiting || !!prev?.waiting });
    }
    return [...out.values()];
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
