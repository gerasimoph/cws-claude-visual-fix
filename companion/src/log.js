import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { files } from './paths.js';

// The native host must never write to stdout (it is the Chrome channel),
// so diagnostics go to a log file in the data directory.
export function log(scope, ...args) {
  const line = `${new Date().toISOString()} [${scope}] ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  try {
    mkdirSync(path.dirname(files.log()), { recursive: true, mode: 0o700 });
    appendFileSync(files.log(), line, { mode: 0o600 });
  } catch {}
  if (process.env.BROWSER_FEEDBACK_DEBUG) process.stderr.write(line);
}
