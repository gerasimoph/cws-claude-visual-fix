// Minimal bidirectional JSON-RPC-ish peer used on both companion links:
// extension <-> host (native messaging) and host <-> MCP process (local socket).
//   request:      { id, method, params }
//   response:     { id, result } | { id, error: { message, code? } }
//   notification: { method, params }
export class RpcPeer {
  constructor(send, { name = 'peer', defaultTimeoutMs = 30_000 } = {}) {
    this._send = send;
    this.name = name;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this._nextId = 1;
    this._pending = new Map();
    this._handlers = new Map();
    this._notificationHandlers = new Map();
    this.closed = false;
  }

  handle(method, fn) { this._handlers.set(method, fn); return this; }
  onNotification(method, fn) { this._notificationHandlers.set(method, fn); return this; }

  request(method, params, timeoutMs = this.defaultTimeoutMs) {
    if (this.closed) return Promise.reject(new RpcError(`${this.name} is closed`, 'closed'));
    const id = `${this.name}-${this._nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => { this._pending.delete(id); reject(new RpcError(`${method} timed out`, 'timeout')); }, timeoutMs)
        : null;
      this._pending.set(id, { resolve, reject, timer });
      try { this._send({ id, method, params }); }
      catch (err) { clearTimeout(timer); this._pending.delete(id); reject(err); }
    });
  }

  notify(method, params) {
    if (this.closed) return;
    try { this._send({ method, params }); } catch {}
  }

  async receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.id !== undefined && !msg.method) {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.message || 'error', msg.error.code));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined) {
      const fn = this._handlers.get(msg.method);
      if (!fn) { this._reply(msg.id, null, { message: `unknown method ${msg.method}`, code: 'unknown_method' }); return; }
      try { this._reply(msg.id, await fn(msg.params || {}, this)); }
      catch (err) { this._reply(msg.id, null, { message: err?.message || String(err), code: err?.code }); }
      return;
    }
    const fn = this._notificationHandlers.get(msg.method);
    if (fn) { try { await fn(msg.params || {}, this); } catch {} }
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    for (const p of this._pending.values()) { clearTimeout(p.timer); p.reject(new RpcError(`${this.name} ${reason}`, 'closed')); }
    this._pending.clear();
  }

  _reply(id, result, error) {
    if (this.closed) return;
    try { this._send(error ? { id, error } : { id, result: result ?? null }); } catch {}
  }
}

export class RpcError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// Newline-delimited JSON over a net.Socket.
export function attachJsonLines(socket, onMessage) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      onMessage(msg);
    }
  });
  return (msg) => socket.write(`${JSON.stringify(msg)}\n`);
}
