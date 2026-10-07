// MCP server (stdio) started by the user's coding agent — Attach mode (PRD §23.1).
// Talks to the native host over the local socket; the host owns all state.
import net from 'node:net';
import { RpcPeer, attachJsonLines } from './rpc.js';
import { socketPath } from './paths.js';
import { VERSION, MCP_SERVER_NAME } from './constants.js';
import { log } from './log.js';

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_WAIT_SECONDS = Number(process.env.BROWSER_FEEDBACK_WAIT_SECONDS) || 300;
const RETRY_MS = 2000;

const BROWSER_NOT_CONNECTED = 'The browser is not connected. Open Chrome with the Browser Feedback extension on the project page (the extension starts the companion).';

export const TOOLS = [
  {
    name: 'wait_for_review',
    description: 'Get the UI review comments the user left on their running web app in the browser, with browser context (element, selectors, styles, geometry, DOM). With review_id (from a Browser Feedback notice in this session) it returns that review at once. Without it, it waits until the user presses "Fix all"; if it returns without a review, call it again. Process the returned comments in order and call report_annotation for each one.',
    inputSchema: {
      type: 'object',
      properties: {
        review_id: { type: 'string', description: 'The review id from a Browser Feedback notice in this session. Returns that review immediately.' },
        timeout_seconds: { type: 'number', description: `Without review_id: how long to wait before returning empty (default ${DEFAULT_WAIT_SECONDS}).` },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_annotations',
    description: 'List the comments of the current UI review with their ids and statuses.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_annotation',
    description: 'Full browser context for one comment: computed styles, attributes, siblings, children, HTML snippet, plus the screenshot taken when the comment was created.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'inspect_element',
    description: 'Re-find the commented element on the live page (after hot reload) and return its current size, styles and text, plus what changed since the review started. Call this after editing code and before report_annotation to confirm the change.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'screenshot',
    description: 'Screenshot of the live page. With an id: a crop around that comment\'s element in its current state. Without: the visible viewport.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'report_annotation',
    description: 'Report the outcome of one comment once you are done with it. The browser then verifies the element on the live page and shows the result on the comment\'s pin. status: "fixed" (you changed code for it), "no_change" (no change needed — explain why in summary), "failed" (you could not do it — explain why).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['fixed', 'no_change', 'failed'] },
        summary: { type: 'string', description: 'One or two sentences: what you changed (file and what), or why not.' },
      },
      required: ['id', 'status', 'summary'],
      additionalProperties: false,
    },
  },
];

const TOOL_TO_HOST = {
  list_annotations: 'listAnnotations',
  get_annotation: 'getAnnotation',
  inspect_element: 'inspectElement',
  screenshot: 'screenshot',
  report_annotation: 'reportAnnotation',
};

export class HostLink {
  constructor({ cwd = process.cwd(), path = socketPath() } = {}) {
    this.cwd = cwd;
    this.path = path;
    this.peer = null;
    this.client = null;
  }

  async connect() {
    if (this.peer && !this.peer.closed) return this.peer;
    const socket = await new Promise((resolve, reject) => {
      const s = net.connect(this.path);
      s.once('connect', () => { s.off('error', reject); resolve(s); });
      s.once('error', reject);
    });
    const peer = new RpcPeer(attachJsonLines(socket, (msg) => peer.receive(msg)), { name: 'mcp', defaultTimeoutMs: 0 });
    const drop = () => { peer.close('disconnected'); if (this.peer === peer) this.peer = null; };
    socket.on('close', drop);
    socket.on('error', drop);
    this.peer = peer;
    await peer.request('hello', { cwd: this.cwd, client: this.client });
    return peer;
  }

  async connectUntil(deadline) {
    for (;;) {
      try { return await this.connect(); }
      catch (err) {
        if (Date.now() + RETRY_MS > deadline) throw new Error(BROWSER_NOT_CONNECTED);
        await sleep(RETRY_MS);
      }
    }
  }

  async call(method, params, { deadline = Date.now() + 1000 } = {}) {
    const peer = await this.connectUntil(deadline);
    return peer.request(method, params);
  }
}

export async function runMcp({ input = process.stdin, output = process.stdout, link = new HostLink() } = {}) {
  const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);
  const inflight = new Map(); // request id -> { cancel }

  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function onMessage(msg) {
    if (!msg || msg.jsonrpc !== '2.0') return;
    const { id, method, params = {} } = msg;
    if (method === undefined) return; // responses to our (non-existent) requests
    try {
      switch (method) {
        case 'initialize': {
          link.client = params.clientInfo?.name || null;
          const protocolVersion = SUPPORTED_PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_PROTOCOLS[0];
          return reply(id, {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: MCP_SERVER_NAME, version: VERSION },
            instructions: 'Browser tools for UI review comments the user leaves on their running web app. Call wait_for_review to receive comments, then for each: edit code, inspect_element, report_annotation.',
          });
        }
        case 'notifications/initialized':
        case 'notifications/roots/list_changed':
          return;
        case 'notifications/cancelled':
          inflight.get(params.requestId)?.cancel();
          return;
        case 'ping':
          return reply(id, {});
        case 'tools/list':
          return reply(id, { tools: TOOLS });
        case 'tools/call': {
          const result = await callTool(id, params);
          return reply(id, result);
        }
        default:
          if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      log('mcp', err);
      if (id !== undefined) fail(id, -32603, err.message || String(err));
    }
  }

  async function callTool(requestId, { name, arguments: args = {}, _meta }) {
    try {
      if (name === 'wait_for_review') return await waitForReview(requestId, args, _meta?.progressToken);
      const method = TOOL_TO_HOST[name];
      if (!method) return toolError(`Unknown tool ${name}`);
      const res = await link.call(method, args);
      return toolResult(res);
    } catch (err) {
      return toolError(err.message || String(err));
    }
  }

  async function waitForReview(requestId, args, progressToken) {
    const seconds = Math.max(5, Math.min(Number(args.timeout_seconds) || DEFAULT_WAIT_SECONDS, 3600));
    const deadline = Date.now() + seconds * 1000;
    let cancelled = false;
    let ticker = null;
    if (progressToken !== undefined) {
      let n = 0;
      ticker = setInterval(() => send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: ++n, message: 'Waiting for "Fix all" in the browser' } }), 25_000);
    }
    inflight.set(requestId, { cancel: () => { cancelled = true; link.peer?.notify?.('cancelWait'); } });
    try {
      for (;;) {
        const peer = await link.connectUntil(deadline);
        try {
          const res = await peer.request('waitForReview', { timeoutMs: Math.max(1000, deadline - Date.now()), reviewId: typeof args.review_id === 'string' ? args.review_id : undefined });
          if (cancelled) return toolError('Cancelled');
          return toolResult(res);
        } catch (err) {
          // Host went away (Chrome closed / extension reloaded): reconnect and keep waiting.
          if (err.code !== 'closed' || Date.now() + RETRY_MS > deadline) throw err;
          await sleep(RETRY_MS);
        }
      }
    } catch (err) {
      if (err.message === BROWSER_NOT_CONNECTED) {
        return toolResult({ text: `No review yet. ${BROWSER_NOT_CONNECTED} Call wait_for_review again to keep waiting.` });
      }
      throw err;
    } finally {
      clearInterval(ticker);
      inflight.delete(requestId);
    }
  }

  let buf = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); continue; }
      onMessage(msg);
    }
  });
  input.on('end', () => process.exit(0));
}

function toolResult(res) {
  const content = [{ type: 'text', text: res?.text || JSON.stringify(res) }];
  if (res?.image?.data) {
    if (res.imageCaption) content.push({ type: 'text', text: res.imageCaption });
    content.push({ type: 'image', data: res.image.data, mimeType: res.image.mimeType || 'image/jpeg' });
  }
  return { content };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
