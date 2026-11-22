/**
 * A task's thread: what the owner said, what agents asked, and what happened, in order.
 * It is the one place the owner follows a task and talks to it.
 */

import { getDb, nowMs } from '../db/db.js';
import { sseEmit } from '../api/events.js';

/** owner, fryday (core itself), or the agent role that spoke. */
export type Author = string;
/**
 * note      something the owner tells the agents
 * question  a question to the owner
 * answer    the owner's answer
 * event     something that happened (a stage began, a check failed, a push was made)
 * reply     the Lead's answer to what the owner wrote (pipeline/lead.ts)
 * proposal  a task the Lead proposes in another project, as JSON; the owner starts it or not
 */
export type MessageKind = 'note' | 'question' | 'answer' | 'event' | 'reply' | 'proposal';

export interface TaskMessage {
  id: number;
  task_id: string;
  author: Author;
  kind: MessageKind;
  body: string;
  created_at: number;
}

const MAX_BODY_CHARS = 8000;

export function addMessage(taskId: string, author: Author, kind: MessageKind, body: string): TaskMessage {
  const text = body.trim().slice(0, MAX_BODY_CHARS);
  const info = getDb()
    .prepare('INSERT INTO task_messages (task_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, author, kind, text, nowMs());
  const message = getDb().prepare('SELECT * FROM task_messages WHERE id = ?').get(info.lastInsertRowid) as TaskMessage;
  sseEmit({ type: 'task_message', taskId, message });
  return message;
}

export function listMessages(taskId: string): TaskMessage[] {
  return getDb().prepare('SELECT * FROM task_messages WHERE task_id = ? ORDER BY id').all(taskId) as TaskMessage[];
}

/** An event, unless it only repeats the last thing in the thread. */
export function addEvent(taskId: string, body: string): void {
  const last = getDb().prepare('SELECT kind, body FROM task_messages WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId) as { kind: string; body: string } | undefined;
  if (last?.kind === 'event' && last.body === body.trim()) return;
  addMessage(taskId, 'fryday', 'event', body);
}

/** What the owner told the agents, oldest first; with `sinceMs`, only what is newer. */
export function ownerNotes(taskId: string, sinceMs = 0): string[] {
  const rows = getDb()
    .prepare(`SELECT body FROM task_messages WHERE task_id = ? AND author = 'owner' AND kind = 'note' AND created_at > ? ORDER BY id`)
    .all(taskId, sinceMs) as Array<{ body: string }>;
  return rows.map((r) => r.body);
}
