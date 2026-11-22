/**
 * Reading the Chat space API.
 * GET    /api/chat-inbound            — sign-in, link and reading status (never a secret)
 * PUT    /api/chat-inbound/client     — { clientId, clientSecret }: the owner's Google OAuth client
 * DELETE /api/chat-inbound/client     — forget the client and the sign-in
 * POST   /api/chat-inbound/signin     — the address to open to sign in with Google
 * POST   /api/chat-inbound/signout    — forget the sign-in (and revoke it at Google)
 * POST   /api/chat-inbound/link       — a one-time code to post in the space
 * POST   /api/chat-inbound/unlink     — stop taking instructions from the linked account
 * POST   /api/chat-inbound/reading    — { enabled }: turn reading on or off
 * POST   /api/chat-inbound/check      — look at the space now
 *
 * Everything that changes who FryDay listens to is for the owner at the UI only.
 * The sign-in callback (GET /oauth/google/callback) is mounted in server.ts, before the
 * session check, because Google sends the browser there; it only completes a sign-in
 * this install started.
 */

import { Router, type Request, type Response } from 'express';
import { forgetClient, finishSignIn, googleStatus, GoogleAuthError, saveClient, signOut, startSignIn } from '../chatin/google.js';
import { inboundStatus, InboundError, pollOnce, setReading, startLink, unlink } from '../chatin/inbound.js';

export const chatInboundRouter = Router();

function ownerOnly(res: Response): boolean {
  if (res.locals['authVia'] === 'cookie') return true;
  res.status(403).json({ error: 'Set up reading the Chat space in the FryDay Code UI' });
  return false;
}

const status = () => ({ google: googleStatus(), inbound: inboundStatus() });

function attempt(res: Response, work: () => unknown | Promise<unknown>): void {
  void Promise.resolve()
    .then(work)
    .then(() => res.json(status()))
    .catch((err) => {
      if (err instanceof GoogleAuthError || err instanceof InboundError) res.status(400).json({ error: err.message });
      else res.status(500).json({ error: 'Something went wrong' });
    });
}

chatInboundRouter.get('/', (_req, res) => { res.json(status()); });
chatInboundRouter.put('/client', (req, res) => { if (ownerOnly(res)) attempt(res, () => saveClient(req.body ?? {})); });
chatInboundRouter.delete('/client', (_req, res) => { if (ownerOnly(res)) attempt(res, () => { unlink(); forgetClient(); }); });
chatInboundRouter.post('/signout', (_req, res) => { if (ownerOnly(res)) attempt(res, async () => { unlink(); await signOut(); }); });
chatInboundRouter.post('/link', (_req, res) => { if (ownerOnly(res)) attempt(res, () => startLink()); });
chatInboundRouter.post('/unlink', (_req, res) => { if (ownerOnly(res)) attempt(res, () => unlink()); });
chatInboundRouter.post('/reading', (req, res) => { if (ownerOnly(res)) attempt(res, () => setReading(req.body?.enabled === true)); });
chatInboundRouter.post('/check', (_req, res) => { if (ownerOnly(res)) attempt(res, () => pollOnce()); });

chatInboundRouter.post('/signin', (req, res) => {
  if (!ownerOnly(res)) return;
  try {
    res.json({ url: startSignIn(callbackUrl(req)) });
  } catch (err) {
    if (!(err instanceof GoogleAuthError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

/** Where Google sends the browser back: this install, on this Mac. */
export function callbackUrl(req: Request): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}/oauth/google/callback`;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const page = (title: string, text: string) => `<!doctype html><meta charset="utf-8"><title>FryDay Code</title>
<body style="font-family:system-ui;background:#050d1a;color:#c8dff0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="max-width:28rem"><h2 style="color:#00d4ff">${escape(title)}</h2><p>${escape(text)}</p></div></body>`;

/** GET /oauth/google/callback — public, see the comment at the top. */
export async function oauthCallback(req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader('Cache-Control', 'no-store');
  try {
    await finishSignIn({ code: req.query['code'], state: req.query['state'], error: req.query['error'] });
    res.send(page('Signed in', 'FryDay Code can now read the Chat space. Close this tab and go back to FryDay Code to link your account.'));
  } catch (err) {
    res.status(400).send(page('Not signed in', err instanceof GoogleAuthError ? err.message : 'Something went wrong. Start the sign-in again from FryDay Code.'));
  }
}
