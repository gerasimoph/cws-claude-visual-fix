// End-to-end M0 loop in real Chromium: comment → Fix all → agent (MCP) →
// HMR-like change → inspect → report → verification → Accept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTENSION = path.join(ROOT, 'extension');
const CLI = path.join(ROOT, 'companion', 'bin', 'browser-feedback.js');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

function serveFixture() {
  const html = readFileSync(new URL('./fixture/index.html', import.meta.url));
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function mcpClient(env, cwd) {
  const proc = spawn(process.execPath, [CLI, 'mcp'], { env, cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let buf = '';
  let id = 0;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  const call = (method, params) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method, params })}\n`); });
  const tool = async (name, args = {}) => {
    const res = await call('tools/call', { name, arguments: args });
    return { text: res.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), content: res.result.content, isError: res.result.isError };
  };
  return { proc, call, tool };
}

test('M0 loop: annotate → Fix all → agent → verify → accept', { timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bf-e2e-'));
  const home = path.join(tmp, 'home');
  const config = path.join(tmp, 'config');
  const project = path.join(tmp, 'project');
  for (const d of [home, config, project]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'acme-web', scripts: { dev: 'next dev' }, dependencies: { next: '15' } }));

  const server = await serveFixture();
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, BROWSER_FEEDBACK_HOME: path.join(tmp, 'data') };

  const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    executablePath: CHROMIUM,
    headless: process.env.HEADED ? false : true,
    env,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    viewport: { width: 1100, height: 700 },
  });
  t.after(() => context.close());
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  assert.match(sw.url(), /^chrome-extension:\/\/diidngfppbepogdmihpnfhfekeemedme\//, 'manifest key gives a stable extension id');

  // Playwright can hand out the worker before chrome.* is bound; retry.
  const storage = async (key) => {
    for (let i = 0; ; i++) {
      const worker = context.serviceWorkers().find((w) => w.url().endsWith('/background.js')) || sw;
      try { return await worker.evaluate((k) => chrome.storage.local.get(k).then((s) => s[k]), key); }
      catch (err) { if (i > 20) throw err; await new Promise((r) => setTimeout(r, 150)); }
    }
  };
  const waitFor = async (fn, what, ms = 15_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  // 0. Onboarding: installing the extension opens the welcome page with the
  //    one line for Claude Code; the agent runs `setup` (simulated here) and
  //    the page notices the connection by itself.
  const welcome = await waitFor(() => context.pages().find((p) => p.url().endsWith('/welcome/welcome.html')), 'welcome page');
  const prompt = await welcome.locator('#prompt').textContent();
  assert.match(prompt, /INSTALL\.md/);
  assert.match(prompt, /--extension-id diidngfppbepogdmihpnfhfekeemedme/);
  assert.equal((await storage('companion'))?.state, 'not_installed');

  const { stdout } = await promisify(execFile)(process.execPath, [CLI, 'setup', '--yes', '--skip-agent', '--wait', '20', '--extension-id', 'diidngfppbepogdmihpnfhfekeemedme', '--browser-dir', path.join(tmp, 'profile', 'NativeMessagingHosts')], { cwd: home, env });
  assert.match(stdout, /Browser connected: yes/, stdout);
  await welcome.locator('#status.ok').waitFor({ state: 'attached' }); // inside the collapsed "Optional" block

  const page = await context.newPage();
  await page.goto(`${origin}/`);
  await page.waitForSelector('browser-feedback-root', { state: 'attached' });

  // 1. Hold Alt, hover the heading, ↑ to its card, click. The page's own
  //    click handler must not fire.
  const h2 = await page.locator('.card.pro h2').boundingBox();
  await page.keyboard.down('Alt');
  await page.mouse.move(h2.x + 5, h2.y + 5);
  await page.mouse.move(h2.x + 10, h2.y + 8);
  await page.keyboard.press('ArrowUp');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const composer = page.locator('browser-feedback-root .composer textarea');
  await composer.waitFor();
  assert.match(await page.locator('browser-feedback-root .composer .target').textContent(), /div\.card\.pro/);
  await composer.fill('Make this the same height as the Monthly card');
  await composer.press('Enter');
  await page.locator('browser-feedback-root .pin').waitFor();
  assert.equal(await page.evaluate(() => window.__clicked), undefined);

  const anns = await storage(`ann:${origin}`);
  assert.equal(anns.length, 1);
  assert.equal(anns[0].context.element.label, 'div.card.pro');
  assert.equal(anns[0].anchor.selectors[0].selector, 'div[data-testid="pro-card"]');
  const screenshotState = await storage('screenshots');

  // 2. Plain Alt+click picks the deepest element.
  await page.click('.card.monthly button', { modifiers: ['Alt'] });
  await composer.fill('Remove this button');
  await composer.press('Enter');
  await waitFor(async () => (await storage(`ann:${origin}`))?.length === 2, 'second comment');

  // 3. Pins survive a reload (re-anchoring).
  await page.reload();
  await page.locator('browser-feedback-root .pin').nth(1).waitFor();
  assert.equal(await page.locator('browser-feedback-root .item').count(), 2);

  // 4. A Claude Code chat in the project folder: its doorbell hook (as Claude
  //    Code would start it) announces the chat and waits in the background.
  const bell = spawn(process.execPath, [CLI, 'doorbell'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => bell.kill());
  bell.stdin.end(JSON.stringify({ session_id: 'chat-e2e', cwd: project, hook_event_name: 'SessionStart', session_title: 'UI fixes' }));
  let bellErr = '';
  bell.stderr.on('data', (c) => { bellErr += c; });
  const rung = new Promise((resolve) => bell.on('exit', resolve));

  // The chat's folder isn't a project yet: the panel asks which one this page is.
  const connectBtn = page.locator('browser-feedback-root button[data-act="conn"][data-id^="connect:"]');
  await connectBtn.waitFor();
  assert.match(await connectBtn.textContent(), /Connect to acme-web/);
  await connectBtn.click();

  // The panel shows where Fix all goes.
  const target = page.locator('browser-feedback-root .fix-target select');
  await target.waitFor();
  assert.match(await target.locator('option').first().textContent(), /Auto → UI fixes/);
  if (process.env.E2E_SHOT) { await page.waitForTimeout(1500); await page.screenshot({ path: process.env.E2E_SHOT }); }

  await page.locator('browser-feedback-root button[data-act="fix-all"]').click();
  assert.equal(await rung, 2, 'Fix all wakes the chat (hook exits 2)');
  const [, reviewId] = /review_id "([^"]+)"/.exec(bellErr);

  // Woken Claude fetches exactly that review over MCP.
  const agent = mcpClient(env, project);
  t.after(() => agent.proc.kill());
  await agent.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-agent', version: '1' } });
  const review = await agent.tool('wait_for_review', { review_id: reviewId });
  assert.match(review.text, /next "Fix all" will notify this session by itself/);
  await page.locator('browser-feedback-root .conn', { hasText: 'Claude is working in «UI fixes»' }).waitFor();
  assert.match(review.text, /INSTRUCTION: Make this the same height as the Monthly card/);
  assert.match(review.text, /INSTRUCTION: Remove this button/);
  const [, firstId] = /Comment 1 — id `([^`]+)`/.exec(review.text);
  const [, secondId] = /Comment 2 — id `([^`]+)`/.exec(review.text);

  // 5. "HMR": the agent's edit lands on the page.
  await page.evaluate(() => {
    document.querySelector('.card.pro').style.height = '300px';
  });
  const inspected = await agent.tool('inspect_element', { id: firstId });
  assert.match(inspected.text, /height: 240px → 300px/);
  const report = await agent.tool('report_annotation', { id: firstId, status: 'fixed', summary: 'PricingCard: same height' });
  assert.match(report.text, /status fixed/, report.text);

  await page.evaluate(() => document.querySelector('.card.monthly button').remove());
  const report2 = await agent.tool('report_annotation', { id: secondId, status: 'fixed', summary: 'Removed button' });
  assert.match(report2.text, /status changed_check/, 'not inspected by the agent → Changed — check');

  // 6. Pins and panel show the verified statuses; user accepts the first one.
  await waitFor(async () => (await storage(`ann:${origin}`))?.map((a) => a.status).join() === 'fixed,changed_check', 'statuses in storage');
  await page.locator('browser-feedback-root .badge[data-status="fixed"]').first().waitFor();
  await page.locator(`browser-feedback-root .item[data-id="${firstId}"] button[data-act="accept"]`).click();
  await waitFor(async () => (await storage(`ann:${origin}`))?.[0].status === 'accepted', 'accept');

  // Without a user gesture on the tab Chrome refuses captureVisibleTab
  // (needs activeTab or <all_urls>); the agent gets an actionable message.
  const shot = await agent.tool('screenshot', {});
  if (screenshotState?.ok === false) {
    assert.equal(shot.isError, true);
    assert.match(shot.text, /toolbar icon/);
    assert.match(await page.locator('browser-feedback-root .conn .note').textContent(), /Screenshots are off/);
  }
});
