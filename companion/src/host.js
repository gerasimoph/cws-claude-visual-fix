// Native messaging host: Chrome starts it when the extension connects and it
// lives as long as that port. It also serves the local socket that MCP
// processes (started by the user's agent) connect to. No TCP ports.
import net from 'node:net';
import { existsSync, unlinkSync, chmodSync, watch } from 'node:fs';
import { RpcPeer, attachJsonLines } from './rpc.js';
import { createNativeChannel } from './native.js';
import { Companion } from './companion.js';
import { socketPath, dataDir } from './paths.js';
import { ensureDataDir } from './store.js';
import { log } from './log.js';

export async function runHost({ input = process.stdin, output = process.stdout } = {}) {
  ensureDataDir();
  const companion = new Companion();

  const channel = createNativeChannel(input, output, (msg) => peer.receive(msg));
  const peer = new RpcPeer(channel.send, { name: 'ext' });
  companion.attachExtension(peer);

  let server = null;
  let socketError = null;
  try {
    server = await listenAgentSocket(companion);
  } catch (err) {
    socketError = err.message;
    log('host', 'agent socket unavailable:', err.message);
  }
  peer.handle('status', () => ({ ...companion.helloPayload(), agentSocket: !!server, socketError, dataDir: dataDir() }));

  const watcher = watchProjects(() => companion.notifyProjectsChanged());

  const shutdown = (why) => {
    log('host', `shutting down: ${why}`);
    peer.close(why);
    watcher?.close();
    server?.close();
    if (server && process.platform !== 'win32') { try { unlinkSync(socketPath()); } catch {} }
    process.exit(0);
  };
  input.on('end', () => shutdown('extension disconnected'));
  input.on('error', () => shutdown('stdin error'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  log('host', `started pid ${process.pid}`);
  return companion;
}

export async function listenAgentSocket(companion, path = socketPath()) {
  if (process.platform !== 'win32' && existsSync(path)) {
    if (await canConnect(path)) throw new Error('Another companion host is already running (another Chrome profile?)');
    unlinkSync(path);
  }
  const server = net.createServer((socket) => {
    const peer = new RpcPeer(attachJsonLines(socket, (msg) => peer.receive(msg)), { name: 'agent', defaultTimeoutMs: 0 });
    // The same local socket serves MCP processes and doorbell hooks.
    const session = companion.attachAgent(peer);
    companion.attachDoorbell(peer);
    // `setup` asks a running host of an older version to exit; the extension
    // reconnects and Chrome starts the freshly installed one.
    peer.handle('host.restart', () => {
      log('host', 'restart requested by setup');
      setTimeout(() => process.emit('SIGTERM'), 100);
      return { ok: true };
    });
    const close = () => { peer.close('disconnected'); companion.detachAgent(session); peer.onClose?.(); };
    socket.on('close', close);
    socket.on('error', close);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
  return server;
}

export function canConnect(path, timeoutMs = 500) {
  return new Promise((resolve) => {
    const s = net.connect(path);
    const done = (ok) => { clearTimeout(t); s.destroy(); resolve(ok); };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function watchProjects(onChange) {
  let timer = null;
  try {
    return watch(dataDir(), (event, name) => {
      if (name !== 'projects.json') return;
      clearTimeout(timer);
      timer = setTimeout(onChange, 150);
    });
  } catch { return null; }
}
