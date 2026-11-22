/**
 * A stand-in for the parts of Google FryDay talks to when it reads the Chat space: the
 * OAuth token endpoint, the Chat messages list, and the space's incoming webhook. It
 * checks what a real Google would (PKCE, the client secret, the bearer token), keeps the
 * space's messages, and records everything FryDay posts.
 */

import { createHash } from 'node:crypto';
import type { HttpTransport } from '../../src/chatin/google';
import type { Transport as WebhookTransport } from '../../src/notify/chat';

export interface StubMessage {
  name: string;
  sender: { name: string; type: 'HUMAN' | 'BOT'; displayName: string };
  text: string;
  thread: string;
  createTime: string;
}

export class StubGoogle {
  readonly clientId = '1234567890-fryday.apps.googleusercontent.com';
  readonly clientSecret = 'stub-client-secret';
  readonly space = 'spaces/AAAAstub';
  messages: StubMessage[] = [];
  posted: Array<{ text: string; thread: string }> = [];
  tokenRequests: Array<Record<string, string>> = [];
  private codes = new Map<string, { challenge: string; redirectUri: string }>();
  private issued = new Set<string>();
  private seq = 0;
  /** Messages are dated with the real time, as Google dates them. */
  private clock = Date.now();
  /** Make the list call fail with this status. */
  failWith: number | null = null;

  /** What Google's sign-in page does: the owner said yes; returns the code the browser brings back. */
  consent(authUrl: string): { code: string; state: string } {
    const u = new URL(authUrl);
    const code = `code-${++this.seq}`;
    this.codes.set(code, { challenge: u.searchParams.get('code_challenge')!, redirectUri: u.searchParams.get('redirect_uri')! });
    return { code, state: u.searchParams.get('state')! };
  }

  /** Someone writes in the space. */
  say(sender: StubMessage['sender'], text: string, thread?: string): StubMessage {
    this.clock = Math.max(this.clock + 1, Date.now());
    const id = ++this.seq;
    const m: StubMessage = { name: `${this.space}/messages/m${id}`, sender, text, thread: thread ?? `${this.space}/threads/t${id}`, createTime: new Date(this.clock).toISOString() };
    this.messages.push(m);
    return m;
  }

  /** The same message delivered again, as an overlapping read would. */
  redeliver(m: StubMessage): void {
    this.clock = Math.max(this.clock + 1, Date.now());
    this.messages.push({ ...m, createTime: new Date(this.clock).toISOString() });
  }

  /** The thread FryDay's posts for a task went into. */
  threadOfKey(key: string): string {
    return `${this.space}/threads/key-${key}`;
  }

  readonly http: HttpTransport = async (url, init) => {
    const u = new URL(url);
    const json = (status: number, value: unknown) => ({ status, text: async () => JSON.stringify(value) });
    if (u.origin === 'https://oauth2.googleapis.com' && u.pathname === '/token') {
      const p = Object.fromEntries(new URLSearchParams(init.body ?? ''));
      this.tokenRequests.push(p);
      if (p['client_id'] !== this.clientId || p['client_secret'] !== this.clientSecret) return json(401, { error: 'invalid_client' });
      if (p['grant_type'] === 'authorization_code') {
        const c = this.codes.get(p['code'] ?? '');
        this.codes.delete(p['code'] ?? '');
        const challenge = createHash('sha256').update(p['code_verifier'] ?? '').digest('base64url');
        if (!c || c.challenge !== challenge || c.redirectUri !== p['redirect_uri']) return json(400, { error: 'invalid_grant' });
        const access = `access-${++this.seq}`;
        this.issued.add(access);
        return json(200, { access_token: access, refresh_token: 'refresh-stub', expires_in: 3600, scope: 'https://www.googleapis.com/auth/chat.messages.readonly' });
      }
      if (p['grant_type'] === 'refresh_token' && p['refresh_token'] === 'refresh-stub') {
        const access = `access-${++this.seq}`;
        this.issued.add(access);
        return json(200, { access_token: access, expires_in: 3600 });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (u.origin === 'https://oauth2.googleapis.com' && u.pathname === '/revoke') return json(200, {});
    if (u.origin === 'https://chat.googleapis.com' && u.pathname === `/v1/${this.space}/messages`) {
      if (this.failWith) return json(this.failWith, { error: { message: 'stub failure' } });
      const token = (init.headers['Authorization'] ?? '').replace(/^Bearer /, '');
      if (!this.issued.has(token)) return json(401, { error: { message: 'bad token' } });
      const since = /createTime > "([^"]+)"/.exec(u.searchParams.get('filter') ?? '')?.[1] ?? '';
      const list = this.messages.filter((m) => m.createTime > since).sort((a, b) => a.createTime.localeCompare(b.createTime));
      return json(200, { messages: list.map((m) => ({ name: m.name, sender: m.sender, text: m.text, argumentText: m.text, thread: { name: m.thread }, createTime: m.createTime })) });
    }
    return json(404, { error: { message: `no stub for ${u.origin}${u.pathname}` } });
  };

  /** FryDay's webhook posts: recorded, and they appear in the space as the app's messages. */
  readonly webhook: WebhookTransport = async ({ body }) => {
    const thread = body.thread?.name ?? (body.thread?.threadKey ? this.threadOfKey(body.thread.threadKey) : `${this.space}/threads/new-${++this.seq}`);
    this.posted.push({ text: body.text, thread });
    this.say({ name: 'users/app-webhook', type: 'BOT', displayName: 'FryDay Code' }, body.text, thread);
    return { ok: true, status: 200, body: JSON.stringify({ name: `${this.space}/messages/w${this.seq}`, thread: { name: thread } }) };
  };
}
