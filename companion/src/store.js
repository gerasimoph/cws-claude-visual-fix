import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, appendFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { dataDir, files } from './paths.js';

export function ensureDataDir() {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  try { chmodSync(dataDir(), 0o700); } catch {}
  for (const dir of [files.reviews(), files.screenshots()]) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// ---- Projects (PRD §13) ----------------------------------------------------

export function loadProjects() {
  const data = readJson(files.projects(), { projects: [] });
  return Array.isArray(data.projects) ? data.projects : [];
}

export function saveProjects(projects) {
  writeJsonAtomic(files.projects(), { version: 1, projects });
}

export function normalizeOrigin(value) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.origin;
  } catch { return null; }
}

export function findProjectByOrigin(projects, origin) {
  const o = normalizeOrigin(origin);
  return projects.find((p) => (p.origins || []).includes(o)) || null;
}

// Which project a session folder belongs to. A folder inside a project's
// working directory belongs to it; so does a parent of it inside the same repo
// (a session at the monorepo root). A sibling app in the same repo does not:
// it is a different project, even though the git root is shared.
export function findProjectByDirectory(projects, dir) {
  if (!dir) return null;
  const d = path.resolve(dir);
  const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
  const scored = [];
  for (const p of projects) {
    if (!p.workingDirectory) continue;
    const wd = path.resolve(p.workingDirectory);
    const repo = path.resolve(p.localPath || p.workingDirectory);
    if (inside(d, wd)) scored.push({ p, score: 1e6 + wd.length });
    else if (inside(wd, d) && inside(d, repo)) scored.push({ p, score: 1e3 - (wd.length - d.length) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.p || null;
}

// ---- Reviews journal -------------------------------------------------------

export function saveReview(review) {
  writeJsonAtomic(path.join(files.reviews(), `${review.id}.json`), review);
}

export function loadReviews({ includeDone = false, maxAgeMs = 7 * 24 * 3600 * 1000 } = {}) {
  let names = [];
  try { names = readdirSync(files.reviews()).filter((n) => n.endsWith('.json')); } catch {}
  const now = Date.now();
  return names
    .map((n) => readJson(path.join(files.reviews(), n), null))
    .filter((r) => r && r.id && (includeDone || r.status !== 'done') && now - (r.createdAt || 0) < maxAgeMs)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function saveScreenshot(name, dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const file = path.join(files.screenshots(), `${name}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
  writeFileSync(file, Buffer.from(m[2], 'base64'), { mode: 0o600 });
  return file;
}

export function readScreenshot(file) {
  if (!file) return null;
  try {
    const data = readFileSync(file).toString('base64');
    const mimeType = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return { data, mimeType };
  } catch { return null; }
}

// ---- Metrics (PRD §32) — event names and numbers only, never content --------

export function recordMetric(event, props = {}) {
  try {
    appendFileSync(files.metrics(), `${JSON.stringify({ t: Date.now(), event, ...props })}\n`, { mode: 0o600 });
  } catch {}
}
