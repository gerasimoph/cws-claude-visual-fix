// Spawns the real native host and MCP server processes and drives them the way
// Chrome and an MCP client would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempHome, signature, annotationInput } from './helpers.js';
import { saveProjects } from '../src/store.js';
import { encodeMessage, createDecoder } from '../src/native.js';
import { RpcPeer } from '../src/rpc.js';

const BIN = fileURLToPath(new URL('../bin/browser-feedback.js', import.meta.url));

function startHost(env) {
  const proc = spawn(process.execPath, [BIN, 'host', 'chrome-extension://test/'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const peer = new RpcPeer((m) => proc.stdin.write(encodeMessage(m)), { name: 'chrome' });
  proc.stdout.on('data', createDecoder((m) => peer.receive(m)));
  return { proc, peer };
}

function startMcp(env, cwd) {
  const proc = spawn(process.execPath, [BIN, 'mcp'], { env, cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  const notifications = [];
  let buf = '';
  let nextId = 1;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else notifications.push(msg);
    }
  });
  const call = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { proc, call, notifications };
}

const text = (res) => res.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

test('extension → host → MCP → agent round trip over real processes', { timeout: 20_000 }, async (t) => {
  const home = tempHome();
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  saveProjects([{ id: 'p1', name: 'Demo', localPath: projectDir, workingDirectory: projectDir, origins: ['http://localhost:3000'] }]);
  const env = { ...process.env, BROWSER_FEEDBACK_HOME: home };

  const host = startHost(env);
  t.after(() => host.proc.kill());
  const pageState = new Map([['a1', signature()]]);
  host.peer.handle('page.capture', ({ items }) => ({ items: items.map((i) => ({ annotationId: i.annotationId, signature: pageState.get(i.annotationId), screenshot: 'data:image/jpeg;base64,/9j/AA==' })) }));
  const updates = [];
  host.peer.onNotification('review.update', ({ review }) => updates.push(review));
  const hello = await host.peer.request('hello', {});
  assert.equal(hello.projects[0].name, 'Demo');

  const mcp = startMcp(env, projectDir);
  t.after(() => mcp.proc.kill());
  const init = await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'browser-feedback');
  const tools = await mcp.call('tools/list', {});
  assert.deepEqual(tools.result.tools.map((x) => x.name), ['wait_for_review', 'list_annotations', 'get_annotation', 'inspect_element', 'screenshot', 'report_annotation']);

  const waiting = mcp.call('tools/call', { name: 'wait_for_review', arguments: { timeout_seconds: 15 } });
  await new Promise((r) => setTimeout(r, 300));
  const sub = await host.peer.request('review.submit', { origin: 'http://localhost:3000', annotations: [annotationInput('a1', 'Make the card taller')] });
  assert.equal(sub.agentWaiting, true);
  const review = await waiting;
  assert.match(text(review), /INSTRUCTION: Make the card taller/);

  pageState.set('a1', signature({ rect: { x: 10, y: 20, width: 300, height: 500 } }));
  const insp = await mcp.call('tools/call', { name: 'inspect_element', arguments: { id: 'a1' } });
  assert.match(text(insp), /height: 440px → 500px/);
  const shot = await mcp.call('tools/call', { name: 'screenshot', arguments: { id: 'a1' } });
  assert.equal(shot.result.content.find((c) => c.type === 'image').mimeType, 'image/jpeg');
  const rep = await mcp.call('tools/call', { name: 'report_annotation', arguments: { id: 'a1', status: 'fixed', summary: 'Card.tsx: min-h-[500px]' } });
  assert.match(text(rep), /status fixed/);
  assert.equal(updates.at(-1).annotations[0].status, 'fixed');

  const bad = await mcp.call('tools/call', { name: 'report_annotation', arguments: { id: 'nope', status: 'fixed', summary: '' } });
  assert.equal(bad.result.isError, true);
});

test('MCP wait_for_review without a browser returns a helpful message', { timeout: 20_000 }, async (t) => {
  const home = tempHome();
  const mcp = startMcp({ ...process.env, BROWSER_FEEDBACK_HOME: home }, home);
  t.after(() => mcp.proc.kill());
  await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x' } });
  const res = await mcp.call('tools/call', { name: 'wait_for_review', arguments: { timeout_seconds: 5 } });
  assert.match(text(res), /browser is not connected/i);
});

test('doorbell hook process: started before the companion, exits 2 with the ring on Fix all', { timeout: 30_000 }, async (t) => {
  const home = tempHome();
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  saveProjects([{ id: 'p1', name: 'Demo', localPath: projectDir, workingDirectory: projectDir, origins: ['http://localhost:3000'] }]);
  const env = { ...process.env, BROWSER_FEEDBACK_HOME: home };

  // Claude Code starts the hook; Chrome (and so the companion) isn't up yet.
  const bell = spawn(process.execPath, [BIN, 'doorbell'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => bell.kill());
  bell.stdin.end(JSON.stringify({ session_id: 'sess-1', cwd: projectDir, hook_event_name: 'Stop', session_title: 'UI fixes' }));
  let stderr = '';
  let stdout = '';
  bell.stderr.on('data', (c) => { stderr += c; });
  bell.stdout.on('data', (c) => { stdout += c; });
  const exited = new Promise((resolve) => bell.on('exit', resolve));
  await new Promise((r) => setTimeout(r, 500));

  const host = startHost(env);
  t.after(() => host.proc.kill());
  host.peer.handle('page.capture', ({ items }) => ({ items: items.map((i) => ({ annotationId: i.annotationId, signature: signature() })) }));
  const chats = [];
  host.peer.onNotification('chats.update', (p) => chats.push(p.chats));
  await host.peer.request('hello', {});
  const end = Date.now() + 10_000;
  while (!chats.at(-1)?.some((c) => c.id === 'sess-1' && c.online) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  assert.equal(chats.at(-1)?.find((c) => c.id === 'sess-1')?.title, 'UI fixes');

  const sub = await host.peer.request('review.submit', { origin: 'http://localhost:3000', annotations: [annotationInput('a1', 'Bigger')] });
  assert.equal(await exited, 2, 'exit code 2 wakes Claude');
  assert.match(stderr, new RegExp(`review_id "${sub.reviewId}"`));
  assert.equal(stdout, '', 'nothing on stdout');
});
