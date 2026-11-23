/**
 * The viewport sweep: after the Page tester has used the pages, core itself opens each page it
 * visited at phone, tablet and desktop size, takes a screenshot of each, and runs fixed layout
 * checks. No model, no tokens: the same checks every time.
 *
 *   phone    390×844, touch, a mobile browser    page wider than the screen, content cut off at
 *   tablet   768×1024, touch                     the right edge, tap targets under 44 px, text
 *   desktop  1280×800                            under 12 px, console errors, failed requests
 *
 * A page wider than a phone's screen is a broken mobile layout: blocking, so it goes back to
 * the Builder with the screenshot. Everything else is reported for the owner and the Builder
 * to see, without stopping the round.
 *
 * The browser is core's, held like the tester's: a fresh profile in memory, and a proxy that
 * refuses everything except the service under test (tools.ts lockedBrowserArgs).
 */

import fs from 'fs';
import path from 'path';
import { chromium, type Browser, type BrowserContextOptions } from 'playwright-core';
import { lockedBrowserArgs } from './tools.js';

export type Device = 'phone' | 'tablet' | 'desktop';

export const DEVICES: Record<Device, BrowserContextOptions & { label: string }> = {
  phone: {
    label: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
  tablet: { label: 'tablet', viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { label: 'desktop', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
};
export const DEVICE_ORDER: Device[] = ['phone', 'tablet', 'desktop'];

export interface SweepIssue {
  device: Device;
  kind: 'overflow' | 'cut_off' | 'small_target' | 'small_text' | 'no_viewport' | 'console_error' | 'failed_request' | 'load_failed';
  severity: 'blocking' | 'minor';
  detail: string;
}

export interface SweepPage {
  /** The path on the service, e.g. "/cart". */
  path: string;
  /** Screenshot file names in the round's evidence folder, by device. */
  shots: Partial<Record<Device, string>>;
  issues: SweepIssue[];
}

export interface SweepResult {
  pages: SweepPage[];
  /** Set when the sweep could not run at all. */
  error?: string;
}

const MAX_PAGES = 6;
const LOAD_TIMEOUT_MS = 15_000;
const OVERFLOW_TOLERANCE_PX = 8;

/** The service paths the tester opened, from its browser_navigate calls, the start page first. */
export function visitedPaths(runLog: string, origin: string, startPath: string): string[] {
  const out = [startPath || '/'];
  for (const line of runLog.split('\n')) {
    if (!line.includes('browser_navigate')) continue;
    let event: { type?: string; message?: { content?: Array<{ type?: string; name?: string; input?: { url?: unknown } }> } };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant') continue;
    for (const c of event.message?.content ?? []) {
      if (c.type !== 'tool_use' || !c.name?.endsWith('browser_navigate') || typeof c.input?.url !== 'string') continue;
      try {
        const u = new URL(c.input.url, origin);
        if (u.origin !== new URL(origin).origin) continue; // only the service under test
        const p = `${u.pathname}${u.search}`;
        if (!out.includes(p)) out.push(p);
      } catch { /* not a URL */ }
    }
  }
  return out.slice(0, MAX_PAGES);
}

/**
 * What the page can tell about its own layout. Plain JavaScript sent as text: a compiled
 * TypeScript function would carry helper names (`__name`) that do not exist in the page.
 * Measured against the screen's own width, not innerWidth: a mobile browser widens its layout to
 * fit content that overflows, which would hide exactly what is checked here.
 */
const LAYOUT_PROBE = `(arg) => {
  const device = arg.device;
  const width = arg.screen;
  const doc = document.documentElement;
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '';
    return tag + id + cls + (text ? ' "' + text + '"' : '');
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0 && r.width > 0 && r.height > 0;
  };
  const cutOff = [], smallTargets = [], smallText = [];
  const all = Array.from(document.body ? document.body.querySelectorAll('*') : []).slice(0, 4000);
  for (const el of all) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > width + 8 && r.left < width && cutOff.length < 5 && getComputedStyle(el).position !== 'fixed') {
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ov = getComputedStyle(p).overflowX;
        if (ov === 'hidden' || ov === 'auto' || ov === 'scroll' || ov === 'clip') { clipped = true; break; }
      }
      if (!clipped) cutOff.push(describe(el));
    }
    if (device === 'phone' && el.matches('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [onclick]') && (r.width < 44 || r.height < 44) && smallTargets.length < 5) {
      smallTargets.push(describe(el) + ' (' + Math.round(r.width) + '×' + Math.round(r.height) + ' px)');
    }
    if (Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 2)) {
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size > 0 && size < 12 && smallText.length < 5) smallText.push(describe(el) + ' (' + size + 'px)');
    }
  }
  const meta = document.querySelector('meta[name=viewport]');
  const mobileLayout = !!meta && /width\\s*=\\s*device-width/i.test(meta.getAttribute('content') || '');
  return { scrollWidth: Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0), width, cutOff, smallTargets, smallText, mobileLayout };
}`;

interface Probe { scrollWidth: number; width: number; cutOff: string[]; smallTargets: string[]; smallText: string[]; mobileLayout: boolean }

const safeName = (p: string) => (p.replace(/^\/+/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'home').slice(0, 40);

export interface SweepOptions {
  origin: string;
  paths: string[];
  chromePath: string;
  denyProxyPort: number;
  servicePort: number;
  key: string;
  evidenceDir: string;
  /** For tests: another way to get a browser. */
  launch?: () => Promise<Browser>;
}

/** Open each path at each device size; screenshots go to evidenceDir. Never throws. */
export async function sweep(opts: SweepOptions): Promise<SweepResult> {
  let browser: Browser | null = null;
  try {
    browser = opts.launch
      ? await opts.launch()
      : await chromium.launch({ executablePath: opts.chromePath, headless: true, args: lockedBrowserArgs(opts.denyProxyPort, opts.servicePort, `${opts.key}-sweep`) });
    fs.mkdirSync(opts.evidenceDir, { recursive: true });
    const pages: SweepPage[] = [];
    for (const [i, p] of opts.paths.entries()) {
      const page: SweepPage = { path: p, shots: {}, issues: [] };
      for (const device of DEVICE_ORDER) {
        const { label: _label, ...options } = DEVICES[device];
        const context = await browser.newContext(options);
        const tab = await context.newPage();
        const consoleErrors: string[] = [];
        const failed: string[] = [];
        tab.on('console', (m) => { if (m.type() === 'error' && consoleErrors.length < 5) consoleErrors.push(m.text().slice(0, 200)); });
        tab.on('response', (r) => {
          if (r.status() >= 400 && failed.length < 5 && r.url().startsWith(opts.origin)) failed.push(`${r.status()} ${new URL(r.url()).pathname}`);
        });
        try {
          await tab.goto(new URL(p, opts.origin).href, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
          await tab.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
          const name = `sweep-${i + 1}-${safeName(p)}-${device}.jpg`;
          await tab.screenshot({ path: path.join(opts.evidenceDir, name), type: 'jpeg', quality: 70 });
          page.shots[device] = name;
          const probe = await tab.evaluate(`(${LAYOUT_PROBE})(${JSON.stringify({ device, screen: DEVICES[device].viewport!.width })})`) as Probe;
          // A page that does not declare a mobile layout is shown zoomed out on a phone, not scrolled
          // sideways: worth saying, not a broken page. Overflow is only measured where it means one.
          const mobile = device !== 'desktop';
          if (mobile && !probe.mobileLayout) {
            if (device === 'phone') page.issues.push({ device, kind: 'no_viewport', severity: 'minor', detail: 'The page has no <meta name="viewport" content="width=device-width">, so phones show it zoomed out like a desktop page.' });
          } else if (probe.scrollWidth > probe.width + OVERFLOW_TOLERANCE_PX) {
            page.issues.push({ device, kind: 'overflow', severity: mobile ? 'blocking' : 'minor', detail: `The page is ${probe.scrollWidth}px wide on a ${probe.width}px ${device} screen, so it scrolls sideways.` });
          }
          if (probe.cutOff.length && (!mobile || probe.mobileLayout)) page.issues.push({ device, kind: 'cut_off', severity: 'minor', detail: `Reaches past the right edge: ${probe.cutOff.join('; ')}` });
          if (probe.smallTargets.length) page.issues.push({ device, kind: 'small_target', severity: 'minor', detail: `Smaller than 44 px to tap: ${probe.smallTargets.join('; ')}` });
          if (probe.smallText.length) page.issues.push({ device, kind: 'small_text', severity: 'minor', detail: `Text under 12 px: ${probe.smallText.join('; ')}` });
          // The same console errors and failed requests show at every size: said once, at the phone size.
          if (device === 'phone' && consoleErrors.length) page.issues.push({ device, kind: 'console_error', severity: 'minor', detail: consoleErrors.join(' | ') });
          if (device === 'phone' && failed.length) page.issues.push({ device, kind: 'failed_request', severity: 'minor', detail: `Requests that failed: ${failed.join(', ')}` });
        } catch (err) {
          page.issues.push({ device, kind: 'load_failed', severity: 'minor', detail: `Could not open it: ${err instanceof Error ? err.message.split('\n')[0]!.slice(0, 200) : String(err)}` });
        } finally {
          await context.close().catch(() => undefined);
        }
      }
      pages.push(page);
    }
    return { pages };
  } catch (err) {
    return { pages: [], error: err instanceof Error ? err.message.split('\n')[0]!.slice(0, 300) : String(err) };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export const sweepBlocking = (s: SweepResult | undefined): SweepIssue[] => (s?.pages ?? []).flatMap((p) => p.issues.filter((i) => i.severity === 'blocking'));

/** The sweep's findings as feedback lines for the Builder. */
export function sweepFeedback(s: SweepResult): string {
  const lines = s.pages.flatMap((p) => p.issues.map((i) => `- [${i.severity}] ${p.path} on ${i.device}: ${i.detail}`));
  return lines.length ? `Checked at phone, tablet and desktop size (by FryDay, the same checks every time):\n${lines.join('\n')}` : '';
}
