/**
 * Request authentication for the local API.
 *
 * Two kinds of caller:
 *   - scripts and integrations, which send the install's secret in `x-fryday-core-token`;
 *   - the UI, which holds an HttpOnly session cookie.
 *
 * The cookie is only handed out in exchange for a one-time launch code that core prints
 * in its own terminal (or that `npm run open` fetches using the secret file). Serving
 * the UI does not create a session. This matters because code that core runs on the
 * developer's behalf — a service under test, a build script — can reach local ports;
 * it must not be able to become the owner by asking for the page.
 *
 * The cookie value is derived from the secret, so it survives a core restart without
 * putting the secret itself in the browser. Requests from other websites (and DNS
 * rebinding) are stopped by an exact Host match plus an exact Origin match; the cookie
 * is SameSite=Strict.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * The session cookie's name carries the port. Cookies are kept per host, not per port, so
 * with one name for every install, signing in to one (the demo, say) would replace the
 * session of another on the same machine.
 */
export function uiCookieName(port: number): string {
  return `fryday_ui_${port}`;
}
export const CORE_TOKEN_HEADER = 'x-fryday-core-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AuthRequest {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  headerToken: string | undefined;
  cookieHeader: string | undefined;
}

export type AuthResult =
  | { ok: true; via: 'token' | 'cookie' }
  | { ok: false; status: 401 | 403; reason: string };

/** Hosts this server answers to. Anything else is a rebinding or proxy attempt. */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host !== undefined && allowedHosts(port).includes(host.toLowerCase());
}

/** A missing Origin is fine (curl, same-origin GET); a present one must be ours. */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined || origin === '') return true;
  return allowedHosts(port).some((h) => origin === `http://${h}`);
}

export function uiSessionToken(coreSecret: string): string {
  return createHmac('sha256', coreSecret).update('fryday-ui-session-v1').digest('hex');
}

export function uiSessionCookie(coreSecret: string, port: number): string {
  return `${uiCookieName(port)}=${uiSessionToken(coreSecret)}; HttpOnly; SameSite=Strict; Path=/`;
}

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function safeEqual(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Network-level check that applies to every route, public ones included. */
export function checkLocal(req: Pick<AuthRequest, 'host' | 'origin'>, port: number): AuthResult | null {
  if (!isAllowedHost(req.host, port)) return { ok: false, status: 403, reason: 'host not allowed' };
  if (!isAllowedOrigin(req.origin, port)) return { ok: false, status: 403, reason: 'origin not allowed' };
  return null;
}

/** Credential check for the API routes. Assumes checkLocal already passed. */
export function authorize(req: AuthRequest, coreSecret: string, port: number): AuthResult {
  if (safeEqual(req.headerToken, coreSecret)) return { ok: true, via: 'token' };

  const cookie = readCookie(req.cookieHeader, uiCookieName(port));
  if (!safeEqual(cookie, uiSessionToken(coreSecret))) {
    return { ok: false, status: 401, reason: 'missing or wrong credentials' };
  }
  // A browser always sends Origin on state-changing requests. Requiring it here means a
  // cookie alone can never change anything from a context that hides where it came from.
  if (!SAFE_METHODS.has(req.method.toUpperCase()) && !req.origin) {
    return { ok: false, status: 403, reason: 'origin required for cookie-authenticated writes' };
  }
  return { ok: true, via: 'cookie' };
}

// ─── Launch codes ─────────────────────────────────────────────────────────────

const LAUNCH_CODE_TTL_MS = 15 * 60_000;
const MAX_WRONG_ATTEMPTS = 5;

/**
 * One-time codes that turn a browser into the owner's session. A code works once and
 * for a limited time; a handful of wrong guesses voids every outstanding code.
 */
export class LaunchCodes {
  private codes = new Map<string, number>(); // code → expiry
  private wrong = 0;

  constructor(private readonly now: () => number = Date.now) {}

  issue(): string {
    this.prune();
    const code = randomBytes(18).toString('base64url');
    this.codes.set(code, this.now() + LAUNCH_CODE_TTL_MS);
    return code;
  }

  /** True exactly once for a live code. */
  redeem(given: unknown): boolean {
    this.prune();
    if (typeof given !== 'string' || given.length === 0 || given.length > 128) return this.miss();
    for (const code of this.codes.keys()) {
      if (safeEqual(given, code)) {
        this.codes.delete(code);
        this.wrong = 0;
        return true;
      }
    }
    return this.miss();
  }

  outstanding(): number {
    this.prune();
    return this.codes.size;
  }

  private miss(): false {
    if (++this.wrong >= MAX_WRONG_ATTEMPTS) {
      this.codes.clear();
      this.wrong = 0;
    }
    return false;
  }

  private prune(): void {
    const now = this.now();
    for (const [code, expiry] of this.codes) if (expiry <= now) this.codes.delete(code);
  }
}

/** Whether the request carries the owner's UI session. */
export function hasUiSession(cookieHeader: string | undefined, coreSecret: string, port: number): boolean {
  return safeEqual(readCookie(cookieHeader, uiCookieName(port)), uiSessionToken(coreSecret));
}
