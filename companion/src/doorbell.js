// `browser-feedback doorbell`: run by Claude Code as an `asyncRewake` hook on
// SessionStart, UserPromptSubmit and Stop. It tells the companion which chat
// it belongs to (session id, folder, title) and waits in the background. When
// the user presses Fix all and this chat is chosen, it prints a short notice
// and exits with code 2, which wakes Claude in that chat. Page data never goes
// through here — Claude fetches the review over MCP.
import net from 'node:net';
import { RpcPeer, attachJsonLines } from './rpc.js';
import { socketPath } from './paths.js';

const RETRY_MS = 3000;

export async function runDoorbell({ end = false, ttlSeconds = 86_340, input = process.stdin } = {}) {
  const hook = await readHookInput(input);
  if (!hook?.session_id) return 0;
  if (end) {
    try {
      const peer = await connect();
      await peer.request('bell.end', { sessionId: hook.session_id });
    } catch {}
    return 0;
  }
  const params = {
    sessionId: hook.session_id,
    cwd: hook.cwd || process.cwd(),
    title: typeof hook.session_title === 'string' ? hook.session_title : null,
    event: hook.hook_event_name || null,
    prompt: typeof hook.prompt === 'string' ? hook.prompt.slice(0, 2000) : null,
  };
  const deadline = Date.now() + ttlSeconds * 1000;
  while (Date.now() < deadline) {
    let peer;
    try { peer = await connect(); }
    catch { await sleep(Math.min(RETRY_MS * 2, deadline - Date.now())); continue; }
    try {
      const res = await withDeadline(peer.request('bell.register', params), deadline);
      if (res?.action === 'ring') {
        process.stderr.write(`${res.text}\n`);
        return 2;
      }
      return 0; // superseded by a newer doorbell for this chat, or stopped
    } catch (err) {
      if (err.message === 'deadline') return 0;
      await sleep(RETRY_MS); // companion restarted (Chrome closed?) — reconnect
    } finally {
      peer.socket.destroy();
    }
  }
  return 0;
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath());
    socket.once('error', reject);
    socket.once('connect', () => {
      const peer = new RpcPeer(attachJsonLines(socket, (msg) => peer.receive(msg)), { name: 'bell', defaultTimeoutMs: 0 });
      peer.socket = socket;
      socket.on('close', () => peer.close('disconnected'));
      socket.on('error', () => peer.close('disconnected'));
      resolve(peer);
    });
  });
}

function readHookInput(input) {
  return new Promise((resolve) => {
    let buf = '';
    const done = () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } };
    const t = setTimeout(done, 2000);
    input.setEncoding('utf8');
    input.on('data', (c) => { buf += c; });
    input.on('end', () => { clearTimeout(t); done(); });
  });
}

function withDeadline(promise, deadline) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('deadline')), Math.max(0, deadline - Date.now()));
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms))); }
