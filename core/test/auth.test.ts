import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorize,
  checkLocal,
  isAllowedHost,
  isAllowedOrigin,
  readCookie,
  uiSessionCookie,
  uiSessionToken,
  uiCookieName,
  type AuthRequest,
} from '../src/api/auth';

const PORT = 7475;
const SECRET = 'test-secret-not-a-real-credential';
const UI_COOKIE_NAME = uiCookieName(PORT);
const cookie = `${UI_COOKIE_NAME}=${uiSessionToken(SECRET)}`;

function req(over: Partial<AuthRequest>): AuthRequest {
  return {
    method: 'GET',
    host: `127.0.0.1:${PORT}`,
    origin: undefined,
    headerToken: undefined,
    cookieHeader: undefined,
    ...over,
  };
}

test('host must match this server exactly', () => {
  assert.equal(isAllowedHost(`127.0.0.1:${PORT}`, PORT), true);
  assert.equal(isAllowedHost(`localhost:${PORT}`, PORT), true);
  assert.equal(isAllowedHost(`LOCALHOST:${PORT}`, PORT), true);
  assert.equal(isAllowedHost(`localhost.evil.com:${PORT}`, PORT), false);
  assert.equal(isAllowedHost('127.0.0.1:9999', PORT), false);
  assert.equal(isAllowedHost('rebind.example.com', PORT), false);
  assert.equal(isAllowedHost(undefined, PORT), false);
});

test('origin may be absent but, when present, must be this server', () => {
  assert.equal(isAllowedOrigin(undefined, PORT), true);
  assert.equal(isAllowedOrigin(`http://127.0.0.1:${PORT}`, PORT), true);
  assert.equal(isAllowedOrigin(`http://localhost:${PORT}`, PORT), true);
  assert.equal(isAllowedOrigin('http://localhost:3000', PORT), false);
  assert.equal(isAllowedOrigin(`http://localhost.evil.com:${PORT}`, PORT), false);
  assert.equal(isAllowedOrigin('https://evil.example', PORT), false);
  assert.equal(isAllowedOrigin('null', PORT), false);
});

test('checkLocal rejects a foreign host or origin', () => {
  assert.equal(checkLocal({ host: `127.0.0.1:${PORT}`, origin: undefined }, PORT), null);
  assert.deepEqual(checkLocal({ host: 'evil.example', origin: undefined }, PORT), {
    ok: false, status: 403, reason: 'host not allowed',
  });
  assert.deepEqual(checkLocal({ host: `127.0.0.1:${PORT}`, origin: 'https://evil.example' }, PORT), {
    ok: false, status: 403, reason: 'origin not allowed',
  });
});

test('header token authorizes; a wrong or missing one does not', () => {
  assert.deepEqual(authorize(req({ headerToken: SECRET, method: 'POST' }), SECRET, PORT), { ok: true, via: 'token' });
  assert.equal(authorize(req({ headerToken: 'wrong' }), SECRET, PORT).ok, false);
  assert.equal(authorize(req({ headerToken: '' }), SECRET, PORT).ok, false);
  assert.deepEqual(authorize(req({}), SECRET, PORT), {
    ok: false, status: 401, reason: 'missing or wrong credentials',
  });
});

test('UI cookie authorizes reads, and writes only with an Origin', () => {
  assert.deepEqual(authorize(req({ cookieHeader: cookie }), SECRET, PORT), { ok: true, via: 'cookie' });
  assert.deepEqual(
    authorize(req({ cookieHeader: cookie, method: 'POST', origin: `http://127.0.0.1:${PORT}` }), SECRET, PORT),
    { ok: true, via: 'cookie' }
  );
  const noOrigin = authorize(req({ cookieHeader: cookie, method: 'DELETE' }), SECRET, PORT);
  assert.equal(noOrigin.ok, false);
  assert.equal(noOrigin.ok === false && noOrigin.status, 403);
});

test('the cookie is not the shared secret and is bound to it', () => {
  assert.notEqual(uiSessionToken(SECRET), SECRET);
  assert.notEqual(uiSessionToken(SECRET), uiSessionToken('another-secret'));
  assert.equal(authorize(req({ cookieHeader: `${UI_COOKIE_NAME}=${uiSessionToken('another-secret')}` }), SECRET, PORT).ok, false);
  assert.equal(authorize(req({ cookieHeader: `${UI_COOKIE_NAME}=${SECRET}` }), SECRET, PORT).ok, false);
});

test('cookie is HttpOnly and SameSite=Strict; readCookie finds it among others', () => {
  const set = uiSessionCookie(SECRET, PORT);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.equal(readCookie(`a=1; ${cookie}; b=2`, UI_COOKIE_NAME), uiSessionToken(SECRET));
  assert.equal(readCookie('a=1; b=2', UI_COOKIE_NAME), undefined);
  assert.equal(readCookie(undefined, UI_COOKIE_NAME), undefined);
  assert.ok(set.startsWith(`fryday_ui_${PORT}=`));
});

test('each install has its own cookie, so signing in to one does not sign the browser out of another', () => {
  assert.equal(uiCookieName(7475), 'fryday_ui_7475');
  assert.notEqual(uiCookieName(7475), uiCookieName(7477));
  // The demo's cookie (another port) is not this install's session, even with the same value.
  const other = `${uiCookieName(7477)}=${uiSessionToken(SECRET)}`;
  assert.equal(authorize(req({ cookieHeader: other }), SECRET, PORT).ok, false);
  // Both cookies side by side: this install reads its own.
  assert.deepEqual(authorize(req({ cookieHeader: `${other}; ${cookie}` }), SECRET, PORT), { ok: true, via: 'cookie' });
});
