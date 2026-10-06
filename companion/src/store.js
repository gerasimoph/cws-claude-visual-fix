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

export function findProjectByDirectory(projects, dir) {
  if (!dir) return null;
  const resolved = path.resolve(dir);
  // Most specific match wins (monorepo apps inside a repo).
  const matches = projects
    .map((p) => {
      const roots = [p.workingDirectory, p.localPath].filter(Boolean).map((r) => path.resolve(r));
      const hit = roots.filter((r) => resolved === r || resolved.startsWith(r + path.sep));
      return hit.length ? { p, len: Math.max(...hit.map((r) => r.length)) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.len - a.len);
  return matches[0]?.p || null;
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
