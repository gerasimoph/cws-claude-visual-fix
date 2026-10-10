// Copy mode, no companion: comment → Copy for Claude → instructions with
// component/file hints in the clipboard → "Sent" → page update → "Changed — check".
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

test('copy mode: Copy for Claude with preamble and code hints, then Sent → Changed — check → Accept', { timeout: 90_000 }, async (t) => {
  const html = readFileSync(new URL('./fixture/index.html', import.meta.url));
  const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await chromium.launchPersistentContext(mkdtempSync(path.join(os.tmpdir(), 'bf-copy-')), {
    executablePath: CHROMIUM,
    headless: true,
    locale: 'ru-RU',
    viewport: { width: 1100, height: 700 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  t.after(() => context.close());
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const storage = async () => {
    for (let i = 0; ; i++) {
      try { return await sw.evaluate((k) => chrome.storage.local.get(k).then((s) => s[k]), `ann:${origin}`); }
      catch (err) { if (i > 20) throw err; await new Promise((r) => setTimeout(r, 150)); }
    }
  };
  const waitFor = async (fn, what, ms = 15_000) => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 150)); }
  };

  const page = await context.newPage();
  await page.goto(`${origin}/`);
  await page.waitForSelector('browser-feedback-root', { state: 'attached' });
  const composer = page.locator('browser-feedback-root .composer textarea');

  // Two comments; "↑ Parent" lifts each from the heading to its card.
  const pairs = [['.card.pro h2', 'Сделай карточку такой же высоты, как Monthly'], ['.card.monthly h2', 'Убери рамку']];
  for (const [i, [sel, text]] of pairs.entries()) {
    await page.click(sel, { modifiers: ['Alt'] });
    await composer.waitFor();
    await page.locator('browser-feedback-root button[data-act="composer-parent"]').click();
    await composer.fill(text);
    await composer.press('Enter');
    await waitFor(async () => (await storage())?.length === i + 1, `comment ${i + 1} saved`);
  }

  // Copy mode: no setup banners, no Fix all — Copy for Claude is the action.
  assert.equal(await page.locator('browser-feedback-root .conn').count(), 0);
  assert.equal(await page.locator('browser-feedback-root button[data-act="fix-all"]').count(), 0);
  const copyBtn = page.locator('browser-feedback-root button[data-act="copy-md"]');
  assert.match(await copyBtn.textContent(), /Copy for Claude \(2\)/);
  await copyBtn.click();
  await waitFor(async () => (await storage())?.every((a) => a.status === 'sent'), 'sent status');

  const md = await page.evaluate(() => navigator.clipboard.readText());
  // Russian browser, Russian comments — the instructions for Claude are still English.
  assert.match(md, /^# UI fixes: Pricing — fixture/);
  assert.match(md, /Go through them one by one and change the code/);
  assert.match(md, /Reply in the language the comments are written in/);
  assert.match(md, /## 1\. «Сделай карточку такой же высоты, как Monthly»/);
  assert.match(md, /Component: `PricingCard` \(inside `PricingGrid` → `App`\)/);
  assert.match(md, /Source: `\/src\/components\/PricingCard\.tsx:12`/);
  assert.match(md, /Test id: `pro-card`/);
  assert.doesNotMatch(md, /Under heading: «Monthly»/, "a neighbouring card's title is not this card's heading");
  assert.match(md, /Now: \d+×\d+ px; padding 24px/);
  assert.match(md, /## 2\. «Убери рамку»/);
  assert.match(md, /Element: `div\.card\.monthly`/);
  assert.doesNotMatch(md, /css-146c3p1|r-color-1grp8yp/, 'generated class hashes are useless to Claude');
  t.diagnostic(`\n${md}`);

  // Claude edits the code, HMR updates the page: the first pin notices.
  await page.evaluate(() => { document.querySelector('.card.pro').style.height = '300px'; });
  await waitFor(async () => (await storage())?.[0].status === 'changed_check', 'changed after send');
  const anns = await storage();
  assert.equal(anns[1].status, 'sent', 'untouched comment stays Sent');
  assert.ok(anns[0].diffs.some((d) => d.prop === 'height'));
  if (process.env.E2E_SHOT) { await page.waitForTimeout(500); await page.screenshot({ path: process.env.E2E_SHOT }); }

  await page.locator(`browser-feedback-root .item[data-id="${anns[0].id}"] button[data-act="accept"]`).click();
  await waitFor(async () => (await storage())?.[0].status === 'accepted', 'accepted');
});
