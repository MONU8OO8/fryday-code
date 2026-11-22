/**
 * The proxy the UI tester's browser is pointed at. It refuses everything.
 *
 * The browser is started so that only the service under test is reached directly and
 * every other request goes "through the proxy" — this one — where it ends. That makes
 * the limit hold for whatever the page itself does (scripts, images, redirects), not
 * only for where the agent navigates. What was refused is remembered, because a page
 * under test that tries to reach somewhere else is worth showing to the owner.
 */

import http from 'http';
import type { AddressInfo } from 'net';

export interface Refused {
  at: number;
  /** host:port the browser asked for. */
  target: string;
}

const MAX_REMEMBERED = 500;
const refused: Refused[] = [];
let server: http.Server | null = null;
let starting: Promise<number> | null = null;

function remember(target: string): void {
  refused.push({ at: Date.now(), target: target.slice(0, 200) });
  if (refused.length > MAX_REMEMBERED) refused.splice(0, refused.length - MAX_REMEMBERED);
}

/** Start the proxy if it is not running and return its port. */
export function denyProxyPort(): Promise<number> {
  if (server?.listening) return Promise.resolve((server.address() as AddressInfo).port);
  starting ??= new Promise<number>((resolve, reject) => {
    const s = http.createServer((req, res) => {
      let target = req.headers.host ?? '';
      try {
        target = new URL(req.url ?? '').host || target;
      } catch {
        /* not an absolute address: the Host header is the best there is */
      }
      remember(target);
      // No answer at all, so the browser reports a failed request. An error page from
      // here would look, to the page and to the tester, like an answer from the target.
      res.socket?.destroy();
    });
    // HTTPS and WebSocket traffic asks for a tunnel; it gets none.
    s.on('connect', (req, socket) => {
      remember(req.url ?? '');
      socket.on('error', () => undefined);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    });
    s.on('clientError', (_err, socket) => socket.destroy());
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      s.unref();
      server = s;
      resolve((s.address() as AddressInfo).port);
    });
  }).finally(() => { starting = null; });
  return starting;
}

/**
 * Hosts the browser itself calls in the background (updates, sign-in, safe browsing),
 * whatever page is open. They are refused like everything else, but they say nothing
 * about the page under test, so they are left out of what is reported.
 */
const BROWSER_OWN = /^(clients\d*\.google\.com|android\.clients\.google\.com|accounts\.google\.com|www\.google\.com|www\.gstatic\.com|update\.googleapis\.com|optimizationguide-pa\.googleapis\.com|safebrowsing\.googleapis\.com|content-autofill\.googleapis\.com|chrome\.google\.com|chromewebstore\.googleapis\.com|[a-z0-9-]+\.gvt[12]\.com|redirector\.gvt1\.com)(:\d+)?$/i;

/** What the proxy refused since `sinceMs`, without repeats, oldest first. `all` includes the browser's own calls. */
export function refusedSince(sinceMs: number, all = false): string[] {
  const targets = [...new Set(refused.filter((r) => r.at >= sinceMs).map((r) => r.target))];
  return all ? targets : targets.filter((t) => !BROWSER_OWN.test(t));
}

/** For tests. */
export function stopDenyProxy(): void {
  server?.close();
  server = null;
  refused.length = 0;
}
