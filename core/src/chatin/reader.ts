/**
 * Reading new messages of one Google Chat space with the owner's sign-in.
 */

import { accessToken, googleFetch, GoogleAuthError } from './google.js';

export interface ChatMessage {
  /** spaces/X/messages/Y — unique; used to handle each message once. */
  name: string;
  sender: { name: string; type: string; displayName: string };
  text: string;
  /** spaces/X/threads/Z */
  thread: string | null;
  createTime: string;
}

export class ChatReadError extends Error {
  constructor(message: string, public readonly status: number | null = null) {
    super(message);
  }
}

const SPACE = /^spaces\/[A-Za-z0-9_-]+$/;
const MAX_PAGES = 10;

/** Messages created after `sinceIso` (RFC 3339), oldest first. At most 10 pages of 100. */
export async function listNewMessages(space: string, sinceIso: string): Promise<ChatMessage[]> {
  if (!SPACE.test(space)) throw new ChatReadError(`"${space}" is not a space`);
  let token: string;
  try {
    token = await accessToken();
  } catch (err) {
    throw new ChatReadError(err instanceof GoogleAuthError ? err.message : String(err));
  }
  const out: ChatMessage[] = [];
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`https://chat.googleapis.com/v1/${space}/messages`);
    url.searchParams.set('filter', `createTime > "${sinceIso}"`);
    url.searchParams.set('orderBy', 'createTime ASC');
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await googleFetch(url.href, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const text = await res.text();
    if (res.status === 401) throw new ChatReadError('Google no longer accepts the sign-in; sign in again on the Connections page', 401);
    if (res.status === 403) throw new ChatReadError('Google refused to show this space: is the signed-in account a member of it, and is the Chat API enabled in your Google Cloud project?', 403);
    if (res.status === 404) throw new ChatReadError('Google has no such space for this account', 404);
    if (res.status !== 200) throw new ChatReadError(`Google Chat answered ${res.status}`, res.status);
    let body: { messages?: Array<Record<string, any>>; nextPageToken?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new ChatReadError('Google Chat did not answer with JSON');
    }
    for (const m of body.messages ?? []) {
      if (typeof m['name'] !== 'string') continue;
      out.push({
        name: m['name'],
        sender: { name: String(m['sender']?.name ?? ''), type: String(m['sender']?.type ?? ''), displayName: String(m['sender']?.displayName ?? '') },
        // argumentText is the text without a leading @mention; fall back to the whole text.
        text: String(m['argumentText'] ?? m['text'] ?? '').trim(),
        thread: typeof m['thread']?.name === 'string' ? m['thread'].name : null,
        createTime: String(m['createTime'] ?? ''),
      });
    }
    if (!body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return out;
}
