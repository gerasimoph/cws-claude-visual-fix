// Which folder serves a localhost origin? Finds the process listening on the
// origin's port and returns its working directory. Used to route Fix all to
// the Claude Code chat working in the same folder as the dev server, and to
// warn when they differ (e.g. another git worktree): edits there would never
// show up on the page.
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cache = new Map(); // origin -> { at, value }
const TTL_MS = 20_000;

export async function devServerFor(origin) {
  let port;
  try {
    const u = new URL(origin);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
    port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch { return null; }
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = null;
  try {
    if (process.platform === 'linux') value = linuxListener(port);
    else if (process.platform === 'darwin') value = await macListener(port);
  } catch { value = null; }
  cache.set(origin, { at: Date.now(), value });
  return value;
}

export function linuxListener(port) {
  const inodes = new Set();
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      if (cols[1].split(':')[1] === hexPort && cols[3] === '0A') inodes.add(cols[9]);
    }
  }
  if (!inodes.size) return null;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let fds;
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let target;
      try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m && inodes.has(m[1])) {
        try { return { pid: Number(pid), dir: readlinkSync(`/proc/${pid}/cwd`) }; } catch { return null; }
      }
    }
  }
  return null;
}

async function macListener(port) {
  const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { timeout: 3000 });
  const pid = /^p(\d+)/m.exec(stdout)?.[1];
  if (!pid) return null;
  const { stdout: cwdOut } = await run('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { timeout: 3000 });
  const dir = /^n(.+)$/m.exec(cwdOut)?.[1];
  return dir ? { pid: Number(pid), dir } : null;
}

// Same folder, or one contains the other (monorepo: dev server in apps/web,
// chat at the repo root). Disjoint folders mean edits won't reach the page.
export function foldersRelated(a, b) {
  if (!a || !b) return false;
  const norm = (p) => p.replace(/[\\/]+$/, '');
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}
