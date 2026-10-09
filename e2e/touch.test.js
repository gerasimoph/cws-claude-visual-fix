// DevTools device mode / touch screens: selection must not let the tap reach
// the app, and "↑ Parent" must re-target the comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

test('touch: tap in selection mode comments instead of pressing; ↑ Parent re-targets', { timeout: 60_000 }, async (t) => {
  const html = readFileSync(new URL('./fixture/index.html', import.meta.url));
  const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const context = await chromium.launchPersistentContext(mkdtempSync(path.join(os.tmpdir(), 'bf-touch-')), {
    executablePath: CHROMIUM,
    headless: true,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 420, height: 800 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  t.after(() => context.close());
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('browser-feedback-root', { state: 'attached' });

  // Selection mode, as the shortcut or the popup button would start it.
  for (let i = 0; i < 20; i++) {
    const ok = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
      return chrome.tabs.sendMessage(tab.id, { type: 'bf.command', name: 'start-selecting' }).then(() => true, () => false);
    }).catch(() => false);
    if (ok) break;
    await page.waitForTimeout(200);
  }

  await page.tap('.card.pro button.cta');
  const target = page.locator('browser-feedback-root .composer .target span');
  await target.waitFor();
  assert.match(await target.textContent(), /^button\.cta/);
  assert.equal(await page.evaluate(() => window.__clicked), undefined, 'the tap must not reach the app');
  assert.equal(await page.evaluate(() => window.__touched), undefined, 'touch handlers (React Native Web Pressables) must not fire either');

  await page.locator('browser-feedback-root button[data-act="composer-parent"]').tap();
  assert.match(await target.textContent(), /^div\.card\.pro/);
  const ta = page.locator('browser-feedback-root .composer textarea');
  await ta.fill('Make the whole card taller');
  await ta.press('Enter');
  await page.locator('browser-feedback-root .pin').waitFor();
  const anns = await sw.evaluate(() => chrome.storage.local.get(null).then((s) => Object.entries(s).find(([k]) => k.startsWith('ann:'))?.[1]));
  assert.equal(anns[0].context.element.label, 'div.card.pro');
});
