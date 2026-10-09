// `browser-feedback status`: what is installed and what the companion sees
// right now, with a one-line diagnosis for the common failures.
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { RpcPeer, attachJsonLines } from './rpc.js';
import { socketPath, dataDir } from './paths.js';
import { loadProjects } from './store.js';
import { VERSION, MCP_SERVER_NAME } from './constants.js';
import { claudeDir } from './claude-config.js';
import { findExecutable } from './detect.js';

function queryHost() {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath());
    const done = (v) => { clearTimeout(t); socket.destroy(); resolve(v); };
    const t = setTimeout(() => done(null), 3000);
    socket.once('error', () => done(null));
    socket.once('connect', () => {
      const peer = new RpcPeer(attachJsonLines(socket, (m) => peer.receive(m)), { name: 'status', defaultTimeoutMs: 3000 });
      peer.request('debug.state', {}).then(done, () => done(null));
    });
  });
}

function hookCount() {
  try {
    const s = JSON.parse(readFileSync(path.join(claudeDir(), 'settings.json'), 'utf8'));
    return Object.values(s.hooks || {}).flat().filter((g) => (g.hooks || []).some((h) => String(h.command || '').includes('browser-feedback.js'))).length;
  } catch { return 0; }
}

function mcpRegistered() {
  const claude = findExecutable('claude');
  if (!claude) return null;
  try { execFileSync(claude, ['mcp', 'get', MCP_SERVER_NAME], { stdio: 'ignore', timeout: 15_000 }); return true; } catch { return false; }
}

const ago = (t) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 60000))} min ago` : '');

export async function status(print = console.log) {
  print(`browser-feedback ${VERSION} · data ${dataDir()}`);
  const hooks = hookCount();
  const mcp = mcpRegistered();
  const command = existsSync(path.join(claudeDir(), 'commands', 'ui-review.md'));
  print(`Claude Code: MCP server ${mcp === null ? '? (claude not on PATH)' : mcp ? 'registered' : 'NOT registered'} · doorbell hooks ${hooks ? `installed (${hooks})` : 'NOT installed'} · /ui-review ${command ? 'installed' : 'missing'}`);

  const state = await queryHost();
  if (!state) {
    print('Browser: NOT connected — open Chrome with the extension (click its icon or open a localhost page).');
    for (const p of loadProjects()) print(`  project ${p.name}  ${p.origins.join(', ')}  ${p.workingDirectory}`);
    return;
  }
  print(`Browser: connected (companion ${state.version})`);
  print('Projects:');
  if (!state.projects.length) print('  none yet — open the app in Chrome and click Connect in the review panel');
  for (const p of state.projects) print(`  ${p.name}  ${p.origins.join(', ')}  ${p.workingDirectory}`);
  print('Claude Code sessions (via hooks):');
  if (!state.chats.length) print('  none');
  for (const c of state.chats) print(`  ${c.title || c.id}  ${c.cwd}  → ${c.project || 'no project'}  ${c.online ? 'online' : 'offline'}${c.busy ? ', busy' : ''}  ${ago(c.lastActiveAt)}`);
  print('MCP connections (one per Claude Code session with the server loaded):');
  if (!state.mcpSessions.length) print('  none');
  for (const s of state.mcpSessions) print(`  ${s.cwd}  → ${s.project || 'no project'}${s.waiting ? '  (waiting in wait_for_review)' : ''}`);
  for (const r of state.pendingReviews) print(`Review ${r.id} ${r.origin}: ${r.status}${r.waitingFor ? ` (${r.waitingFor})` : ''}`);

  print('');
  if (!hooks) print('Diagnosis: doorbell hooks are not installed — run setup again.');
  else if (!state.chats.length && state.mcpSessions.length) print('Diagnosis: Claude Code is running with the MCP server, but its hooks never checked in. Restart that session (hooks load at start). If they still don\'t, type /ui-review in it — that works without hooks.');
  else if (!state.chats.length) print('Diagnosis: no Claude Code session is visible. Start (or restart) Claude Code in the project folder.');
  else if (state.chats.every((c) => !c.project)) print('Diagnosis: sessions are visible but not linked to a page. Open the app in Chrome and click "Connect to …" in the review panel.');
  else print('Diagnosis: looks good. Comment on the page and press Fix all.');
}
