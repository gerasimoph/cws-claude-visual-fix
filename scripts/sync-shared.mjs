// Copies shared/*.js into the extension and the companion, which must each be
// self-contained (the extension is loaded unpacked, the companion is copied
// into the data directory by `connect`). Run with --check to verify copies.
import { readFileSync, writeFileSync } from 'node:fs';

const FILES = { 'redact.js': ['extension/lib/redact.js', 'companion/src/redact.js'] };
const root = new URL('../', import.meta.url);
const check = process.argv.includes('--check');
let stale = 0;

for (const [src, targets] of Object.entries(FILES)) {
  const body = readFileSync(new URL(`shared/${src}`, root), 'utf8');
  for (const target of targets) {
    const url = new URL(target, root);
    let current = null;
    try { current = readFileSync(url, 'utf8'); } catch {}
    if (current === body) continue;
    if (check) { console.error(`${target} is out of date — run npm run sync-shared`); stale++; }
    else { writeFileSync(url, body); console.log(`updated ${target}`); }
  }
}
process.exit(stale ? 1 : 0);
