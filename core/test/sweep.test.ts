// The viewport sweep: core opens the pages the tester visited at phone, tablet and desktop size,
// keeps a screenshot of each and runs fixed layout checks. A local page with a known overflow;
// the installed Chrome (skipped where there is none). No model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';

import { sweep, sweepBlocking, sweepFeedback, visitedPaths } from '../src/verify/sweep';
import { findChrome } from '../src/verify/tools';

const chrome = findChrome();
const skip = !chrome;
const tmp = path.join(os.tmpdir(), `fryday-sweep-${randomBytes(4).toString('hex')}`);
let server: http.Server;
let origin = '';

const PAGES: Record<string, string> = {
  '/': '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;font:16px sans-serif"><h1>Shop</h1><p>Fits every screen.</p><a href="/cart" style="display:inline-block;padding:14px 20px">Cart</a></body>',
  '/old': '<!doctype html><body style="margin:0"><div style="width:900px">A desktop-only page</div></body>',
  '/wide': '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;font:16px sans-serif"><div class="table" style="width:900px;background:#eee">A table that is 900px wide</div><a href="/x" style="font-size:10px">tiny link</a><script>console.error("boom")</script><img src="/missing.png"></body>',
};

before(async () => {
  fs.mkdirSync(tmp, { recursive: true });
  server = http.createServer((req, res) => {
    const page = PAGES[req.url ?? ''];
    if (page) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); return; }
    res.writeHead(404); res.end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); fs.rmSync(tmp, { recursive: true, force: true }); });

test('the pages to sweep are the ones the tester opened on the service, the start page first, nothing elsewhere', () => {
  const step = (url: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__fryday_browser__browser_navigate', input: { url } }] } });
  const log = [step('http://127.0.0.1:4000/cart'), step('http://127.0.0.1:4000/cart'), step('https://evil.example/steal'), step('/orders?status=paid'), 'not json browser_navigate'].join('\n');
  assert.deepEqual(visitedPaths(log, 'http://127.0.0.1:4000', '/'), ['/', '/cart', '/orders?status=paid']);
  assert.equal(visitedPaths(Array.from({ length: 20 }, (_, i) => step(`/p${i}`)).join('\n'), 'http://127.0.0.1:4000', '/').length, 6, 'at most six pages');
});

test('a page wider than a phone is blocking, with a screenshot per size; small targets, small text and errors are reported', { skip }, async () => {
  const dir = path.join(tmp, 'evidence');
  const result = await sweep({
    origin, paths: ['/', '/wide'], chromePath: chrome!, denyProxyPort: 0, servicePort: 0, key: 'T-1', evidenceDir: dir,
    launch: () => chromium.launch({ executablePath: chrome!, headless: true }),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.pages.length, 2);
  const [home, wide] = result.pages;
  assert.deepEqual(Object.keys(home!.shots), ['phone', 'tablet', 'desktop']);
  for (const name of [...Object.values(home!.shots), ...Object.values(wide!.shots)]) assert.ok(fs.statSync(path.join(dir, name!)).size > 1000, `${name} was written`);
  assert.equal(home!.issues.filter((i) => i.severity === 'blocking').length, 0, 'a page that fits has nothing blocking');

  const blocking = sweepBlocking(result);
  assert.deepEqual(blocking.map((i) => `${i.kind}:${i.device}`), ['overflow:phone', 'overflow:tablet']);
  assert.match(blocking[0]!.detail, /The page is 9\d\dpx wide on a 390px phone screen/);
  assert.ok(wide!.issues.some((i) => i.kind === 'overflow' && i.device === 'desktop' && i.severity === 'minor') === false, 'it fits a desktop');
  assert.ok(wide!.issues.some((i) => i.kind === 'small_target' && /tiny link/.test(i.detail)));
  assert.ok(wide!.issues.some((i) => i.kind === 'small_text' && /10px/.test(i.detail)));
  assert.ok(wide!.issues.some((i) => i.kind === 'console_error' && /boom/.test(i.detail)));
  assert.ok(wide!.issues.some((i) => i.kind === 'failed_request' && /404 \/missing\.png/.test(i.detail)));
  assert.match(sweepFeedback(result), /- \[blocking\] \/wide on phone: The page is/);

  const old = await sweep({
    origin, paths: ['/old'], chromePath: chrome!, denyProxyPort: 0, servicePort: 0, key: 'T-3', evidenceDir: dir,
    launch: () => chromium.launch({ executablePath: chrome!, headless: true }),
  });
  assert.equal(sweepBlocking(old).length, 0, 'a page with no mobile layout is shown zoomed out on a phone, not scrolled: not blocking');
  assert.deepEqual(old.pages[0]!.issues.filter((i) => i.kind === 'no_viewport').map((i) => i.device), ['phone']);
});

test('a sweep that cannot start a browser says why and never throws', async () => {
  const result = await sweep({ origin, paths: ['/'], chromePath: '/nonexistent/chrome', denyProxyPort: 1, servicePort: 1, key: 'T-2', evidenceDir: path.join(tmp, 'none') });
  assert.equal(result.pages.length, 0);
  assert.ok(result.error && result.error.length > 0);
});
