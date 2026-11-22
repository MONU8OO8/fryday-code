/**
 * Posting to a Google Chat space through an incoming webhook: questions, approvals that
 * are waiting, and results. One thread per task.
 *
 * The webhook address is a secret (anyone who has it can post to the space). It is kept
 * in a file in the state folder that only the developer can read and no agent can; it
 * is never returned by the API, written to a log, or put in an error message.
 *
 * Posting never holds up or fails a task: a message that cannot be sent is recorded as
 * the last error and dropped.
 */

import fs from 'fs';
import path from 'path';
import { getConfig } from '../config.js';

export class ChatConfigError extends Error {}

export interface ChatStatus {
  configured: boolean;
  /** The space the webhook posts to (its id, not the address). */
  space: string | null;
  lastSentAt: number | null;
  /** Why the last message was not delivered; null when it was. */
  lastError: string | null;
}

export interface Outgoing {
  url: string;
  body: { text: string; thread?: { threadKey?: string; name?: string } };
}
/** `body` is Google's answer, when there is one: it says which thread the message went into. */
export type Transport = (message: Outgoing) => Promise<{ ok: boolean; status: number; body?: string }>;

const WEBHOOK = /^https:\/\/chat\.googleapis\.com\/v1\/(spaces\/[A-Za-z0-9_-]+)\/messages\?[^\s#]*$/;
const MAX_TEXT_CHARS = 3500;
const SEND_TIMEOUT_MS = 10_000;

const webhookFile = () => path.join(getConfig().home, 'chat-webhook');

/** The space id inside a webhook address, or a ChatConfigError saying what is wrong with it. */
export function parseWebhook(url: string): { url: string; space: string } {
  const trimmed = url.trim();
  const match = WEBHOOK.exec(trimmed);
  if (!match) {
    throw new ChatConfigError('That is not a Google Chat webhook address. It starts with https://chat.googleapis.com/v1/spaces/ and comes from the space\'s "Apps & integrations → Webhooks".');
  }
  const query = new URL(trimmed).searchParams;
  if (!query.get('key') || !query.get('token')) {
    throw new ChatConfigError('The webhook address is incomplete: its key or token part is missing. Copy the whole address.');
  }
  return { url: trimmed, space: match[1]! };
}

function storedWebhook(): { url: string; space: string } | null {
  try {
    return parseWebhook(fs.readFileSync(webhookFile(), 'utf8'));
  } catch {
    return null;
  }
}

let lastSentAt: number | null = null;
let lastError: string | null = null;

export function chatStatus(): ChatStatus {
  const stored = storedWebhook();
  return { configured: stored !== null, space: stored?.space ?? null, lastSentAt, lastError };
}

export function saveWebhook(url: string): ChatStatus {
  const parsed = parseWebhook(url);
  fs.mkdirSync(path.dirname(webhookFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(webhookFile(), `${parsed.url}\n`, { mode: 0o600 });
  fs.chmodSync(webhookFile(), 0o600); // also when the file was already there with other permissions
  lastError = null;
  return chatStatus();
}

export function removeWebhook(): ChatStatus {
  fs.rmSync(webhookFile(), { force: true });
  lastError = null;
  lastSentAt = null;
  return chatStatus();
}

const httpTransport: Transport = async ({ url, body }) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  return { ok: res.ok, status: res.status, body: await res.text().catch(() => '') };
};
let transport: Transport = httpTransport;

/** Tests replace the network call; null puts the real one back. */
export function setChatTransport(next: Transport | null): void {
  transport = next ?? httpTransport;
}

// One message at a time, so they arrive in the order things happened.
let queue: Promise<unknown> = Promise.resolve();

export interface Delivery {
  delivered: boolean;
  /** spaces/X/threads/Y the message went into, when Google said. */
  thread: string | null;
}

const THREAD = /^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+$/;

/**
 * Post `text` to the space: into an existing thread (`threadName`, spaces/X/threads/Y),
 * or the thread named by `threadKey`. Resolves to whether it was delivered and where;
 * never rejects. Does nothing when no webhook is set.
 */
export function postToChatIn(text: string, where: { threadKey?: string; threadName?: string } = {}): Promise<Delivery> {
  const stored = storedWebhook();
  if (!stored) return Promise.resolve({ delivered: false, thread: null });
  const url = new URL(stored.url);
  const threadName = where.threadName && THREAD.test(where.threadName) && where.threadName.startsWith(`${stored.space}/`) ? where.threadName : undefined;
  if (threadName || where.threadKey) url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
  const body: Outgoing['body'] = {
    text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text,
    ...(threadName ? { thread: { name: threadName } } : where.threadKey ? { thread: { threadKey: where.threadKey } } : {}),
  };

  const send = async (): Promise<Delivery> => {
    try {
      const res = await transport({ url: url.toString(), body });
      if (res.ok) {
        lastSentAt = Date.now();
        lastError = null;
        let thread: string | null = threadName ?? null;
        try {
          const name = (JSON.parse(res.body ?? '') as { thread?: { name?: unknown } }).thread?.name;
          if (typeof name === 'string' && THREAD.test(name)) thread = name;
        } catch {
          /* no body: the thread is not known */
        }
        return { delivered: true, thread };
      }
      lastError = res.status === 401 || res.status === 403 || res.status === 404
        ? `The space refused the message (${res.status}). The webhook may have been removed; add it again.`
        : `The space answered with an error (${res.status}).`;
    } catch (err) {
      // The address must not end up in an error: say what kind of failure it was, nothing more.
      lastError = err instanceof Error && err.name === 'TimeoutError' ? 'Google Chat did not answer in time.' : 'Google Chat could not be reached.';
    }
    return { delivered: false, thread: null };
  };
  const sent = queue.then(send, send);
  queue = sent;
  return sent;
}

/** Post `text` to the space, in the thread named by `threadKey`. Resolves to whether it was delivered. */
export function postToChat(text: string, threadKey?: string): Promise<boolean> {
  return postToChatIn(text, { threadKey }).then((d) => d.delivered);
}
