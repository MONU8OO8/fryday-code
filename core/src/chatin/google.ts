/**
 * The owner's own Google sign-in, used for one thing: reading the messages of the
 * FryDay Code space. FryDay is not a bot and has no public address.
 *
 * The flow is Google's for installed apps: the owner creates an OAuth client ("Desktop
 * app") in their own Google Cloud project, pastes its id and secret here, and signs in in
 * their browser. Google sends the browser back to this computer (127.0.0.1) with a one-time
 * code, which core exchanges for tokens. PKCE and a one-time state value tie the answer to
 * the sign-in that asked for it.
 *
 * The scope is read-only (chat.messages.readonly). Tokens and the client secret are kept
 * in <FRYDAY_HOME>/google-chat.json, readable only by the developer, never returned by the
 * API, and no agent can read the state folder. Requests go to Google's fixed hosts only.
 */

import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config.js';

export const CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.messages.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SIGN_IN_TTL_MS = 10 * 60_000;

export class GoogleAuthError extends Error {}

export interface HttpResponse { status: number; text(): Promise<string> }
export type HttpTransport = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

const realTransport: HttpTransport = (url, init) => fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
let transport: HttpTransport = realTransport;
/** Tests stand in for Google; null puts the real network back. */
export function setGoogleTransport(t: HttpTransport | null): void {
  transport = t ?? realTransport;
}
export const googleFetch: HttpTransport = (url, init) => transport(url, init);

interface Stored {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  scope?: string;
  signedInAt?: number;
}

const file = () => path.join(getConfig().home, 'google-chat.json');

function load(): Stored | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Stored;
    return typeof raw.clientId === 'string' && typeof raw.clientSecret === 'string' ? raw : null;
  } catch {
    return null;
  }
}

function store(s: Stored): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

export interface GoogleStatus {
  /** An OAuth client is saved. */
  clientSet: boolean;
  /** The client id, which is not a secret; shown so the owner knows which one it is. */
  clientId: string | null;
  signedIn: boolean;
  signedInAt: number | null;
}

export function googleStatus(): GoogleStatus {
  const s = load();
  return { clientSet: s !== null, clientId: s?.clientId ?? null, signedIn: Boolean(s?.refreshToken), signedInAt: s?.signedInAt ?? null };
}

const CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

/** Save the owner's OAuth client. Replacing the client signs out. */
export function saveClient(input: { clientId?: unknown; clientSecret?: unknown }): GoogleStatus {
  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
  const clientSecret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : '';
  if (!CLIENT_ID.test(clientId)) throw new GoogleAuthError('The client id looks like 1234567890-abc123.apps.googleusercontent.com (Google Cloud → APIs & Services → Credentials → OAuth client ID → Desktop app)');
  if (!clientSecret || clientSecret.length > 200 || /\s/.test(clientSecret)) throw new GoogleAuthError('The client secret is required');
  const before = load();
  store(before && before.clientId === clientId ? { ...before, clientSecret } : { clientId, clientSecret });
  return googleStatus();
}

/** Forget the sign-in (and ask Google to revoke it), keeping the client. */
export async function signOut(): Promise<GoogleStatus> {
  const s = load();
  if (s?.refreshToken) {
    try {
      await googleFetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: s.refreshToken }).toString() });
    } catch {
      /* forgotten here either way */
    }
    store({ clientId: s.clientId, clientSecret: s.clientSecret });
  }
  return googleStatus();
}

export function forgetClient(): GoogleStatus {
  fs.rmSync(file(), { force: true });
  return googleStatus();
}

// ─── Signing in ───────────────────────────────────────────────────────────────

const pending = new Map<string, { verifier: string; redirectUri: string; expires: number }>();
const b64url = (b: Buffer) => b.toString('base64url');

/** The address the owner opens to sign in. The answer comes back to `redirectUri` on this computer. */
export function startSignIn(redirectUri: string): string {
  const s = load();
  if (!s) throw new GoogleAuthError('Save the OAuth client first');
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname)) throw new GoogleAuthError('The sign-in can only come back to this computer');
  for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  pending.set(state, { verifier, redirectUri, expires: Date.now() + SIGN_IN_TTL_MS });
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: s.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: CHAT_SCOPE,
    state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return url.href;
}

/** Google sent the browser back with `code` for `state`. Exchanges it for tokens. */
export async function finishSignIn(params: { code?: unknown; state?: unknown; error?: unknown }): Promise<GoogleStatus> {
  const state = typeof params.state === 'string' ? params.state : '';
  const entry = pending.get(state);
  // One use only, whatever happens next.
  pending.delete(state);
  if (!entry || entry.expires < Date.now()) throw new GoogleAuthError('This sign-in is not one FryDay started, or it is too old. Start it again from FryDay Code.');
  if (typeof params.error === 'string' && params.error) throw new GoogleAuthError(`Google did not sign you in: ${params.error.slice(0, 100)}`);
  const code = typeof params.code === 'string' ? params.code : '';
  if (!code) throw new GoogleAuthError('Google sent no code back');
  const s = load();
  if (!s) throw new GoogleAuthError('The OAuth client is gone; save it again');
  const res = await googleFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: s.clientId, client_secret: s.clientSecret, redirect_uri: entry.redirectUri, grant_type: 'authorization_code', code_verifier: entry.verifier }).toString(),
  });
  const body = parseToken(res.status, await res.text());
  if (!body.refresh_token) throw new GoogleAuthError('Google signed you in but gave no refresh token; remove FryDay from your Google account\'s third-party access and sign in again');
  if (body.scope && !body.scope.split(' ').includes(CHAT_SCOPE)) throw new GoogleAuthError('You did not allow FryDay to read Chat messages; sign in again and tick that permission');
  store({ ...s, refreshToken: body.refresh_token, accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000, scope: body.scope, signedInAt: Date.now() });
  return googleStatus();
}

function parseToken(status: number, text: string): { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string } {
  let body: ReturnType<typeof parseToken>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new GoogleAuthError(`Google answered ${status} without JSON`);
  }
  if (status !== 200 || !body.access_token) {
    // Only Google's error words; nothing that could carry a token.
    throw new GoogleAuthError(`Google refused (${status}${body.error ? `: ${String(body.error).slice(0, 60)}` : ''})${body.error === 'invalid_grant' ? '. The sign-in has expired or was revoked; sign in again.' : ''}`);
  }
  return body;
}

/** A valid access token, refreshed when needed. */
export async function accessToken(): Promise<string> {
  const s = load();
  if (!s?.refreshToken) throw new GoogleAuthError('Not signed in to Google');
  if (s.accessToken && s.expiresAt && s.expiresAt - 60_000 > Date.now()) return s.accessToken;
  const res = await googleFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken, grant_type: 'refresh_token' }).toString(),
  });
  const body = parseToken(res.status, await res.text());
  store({ ...s, accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token!;
}

/** For tests: forget sign-ins that were started. */
export function clearPendingSignIns(): void {
  pending.clear();
}
