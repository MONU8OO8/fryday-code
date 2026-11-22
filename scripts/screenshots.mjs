#!/usr/bin/env node
// Takes the README screenshots from the static demo site (ui/dist-demo), with no server of
// FryDay Code's own and no AI calls: the demo replays a recorded task in the browser.
//
//   npm run build:demo && node scripts/screenshots.mjs
//
// Uses the `playwright` package that core already has (a dependency of @playwright/mcp), so
// nothing new is installed. If Playwright's own browser is not downloaded, the system Google
// Chrome is used instead. Writes PNGs to docs/images/.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'ui', 'dist-demo');
const OUT = path.join(ROOT, 'docs', 'images');
const VIEWPORT = { width: 1280, height: 800 };

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function loadPlaywright() {
  try {
    return createRequire(path.join(ROOT, 'core', 'package.json'))('playwright');
  } catch {
    console.error('Playwright was not found under core/node_modules. Run `npm run setup` first.');
    process.exit(1);
  }
}

/** A static server for the demo site, on a free port of 127.0.0.1. */
function serve(dir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = path.normalize(path.join(dir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404).end('Not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch(chromium) {
  try {
    return await chromium.launch();
  } catch (err) {
    console.log(`Playwright's Chromium is not available (${String(err.message).split('\n')[0]}); using Google Chrome.`);
    return chromium.launch({ channel: 'chrome' });
  }
}

async function shot(page, name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log(`  ${path.relative(ROOT, file)}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}

/**
 * Waits for text on the page. The replay keeps playing in memory; if the screen has not
 * caught up for a while, it is re-read by going to History and back (no reload, so the
 * replay is not restarted).
 */
async function waitForText(page, text, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let quietSince = Date.now();
  while (Date.now() < until) {
    if (await page.getByText(text, { exact: false }).count()) return;
    if (Date.now() - quietSince > 15_000) {
      await reread(page);
      quietSince = Date.now();
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`Timed out waiting for "${text}"`);
}

/** Re-reads the screen by going to History and back (no reload: the replay keeps its place). */
async function reread(page) {
  const back = await page.evaluate(() => location.hash);
  await page.evaluate(() => { location.hash = '#/history'; });
  await page.waitForTimeout(400);
  await page.evaluate((h) => { location.hash = h; }, back);
}

async function main() {
  if (!fs.existsSync(path.join(SITE, 'app', 'index.html'))) {
    console.error('ui/dist-demo is missing. Build it first: npm run build:demo');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = loadPlaywright();
  const server = await serve(SITE);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launch(chromium);
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light' });
    const page = await context.newPage();
    page.on('pageerror', (err) => console.error(`  page error: ${err.message}`));

    console.log('Landing page');
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await shot(page, 'landing.png');

    console.log('Demo: start the recorded task');
    await page.goto(`${base}/app/#/home`, { waitUntil: 'networkidle' });
    const start = page.getByRole('button', { name: 'Start', exact: true });
    await start.waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Start' && !b.disabled), null, { timeout: 15_000 });
    await start.click();
    await page.waitForURL(/#\/home\/T-/, { timeout: 15_000 });

    // The Understander asks which columns the CSV should have; answer as the recording did.
    const answer = page.getByRole('button', { name: 'Order id, customer, total and date' });
    await answer.first().waitFor({ timeout: 90_000 });
    await answer.first().click();
    await waitForText(page, "Here's the plan", 120_000);

    // The first build fails the tests and goes back to the Builder: the team at work.
    await waitForText(page, 'The tests did not pass. Back to you.', 120_000);
    await page.waitForTimeout(2000);
    await shot(page, 'home-in-progress.png');

    // The approval card: what will happen, in plain words, with Approve and Not yet.
    await waitForText(page, 'Releaser needs your OK', 120_000);
    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    await approve.waitFor({ timeout: 10_000 });
    await approve.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);
    await shot(page, 'approval.png');

    // The same screen in dark mode (the UI follows prefers-color-scheme).
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(600);
    await shot(page, 'dark-mode.png');
    await context.close();
  } catch (err) {
    const pages = browser.contexts().flatMap((c) => c.pages());
    if (pages[0]) {
      const file = path.join(os.tmpdir(), 'fryday-screenshots-failure.png');
      await pages[0].screenshot({ path: file }).catch(() => {});
      console.error(`Failed; the page as it was: ${file}`);
    }
    throw err;
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
