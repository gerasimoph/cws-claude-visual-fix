// `browser-feedback stats`: local K1 numbers from metrics.jsonl (PRD §5.3, §34).
import { readFileSync } from 'node:fs';
import { files } from './paths.js';

export function computeStats(lines) {
  const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const of = (name) => events.filter((e) => e.event === name);
  const reviews = of('review_submitted');
  const reported = of('annotation_reported');
  const firstChange = of('first_visible_change').map((e) => e.time_to_first_change);
  const final = reported.filter((e) => ['fixed', 'changed_check'].includes(e.status));
  return {
    reviews: reviews.length,
    medianCommentsPerReview: median(reviews.map((e) => e.annotations_in_review)),
    medianSecondsToFirstChange: secs(median(firstChange)),
    p90SecondsToFirstChange: secs(percentile(firstChange, 0.9)),
    commentsReported: reported.length,
    fixedShare: final.length ? final.filter((e) => e.status === 'fixed').length / final.length : null,
    accepted: of('annotation_accepted').length,
  };
}

export function readStats() {
  let text = '';
  try { text = readFileSync(files.metrics(), 'utf8'); } catch {}
  return computeStats(text.split('\n').filter(Boolean));
}

function median(xs) { return percentile(xs, 0.5); }
function percentile(xs, q) {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
function secs(ms) { return ms == null ? null : Math.round(ms / 100) / 10; }
