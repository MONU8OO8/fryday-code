/**
 * Reading the FryDay Code space: the owner gives tasks, answers questions, adds notes
 * and approves there, and FryDay answers in the same threads.
 *
 * Only messages from the linked owner are acted on. Linking: FryDay shows a one-time
 * code, the owner posts it in the space, and the sender of that message becomes the
 * owner — so it is a person in the space who proves who they are, not a name typed in.
 * Messages from anyone else, and from apps (including FryDay's own webhook), are skipped.
 *
 * Each message is handled once (its name is recorded before anything is done), so a
 * message seen twice makes one task. An approval needs the ticket's one-time code, which
 * only the message announcing that ticket shows.
 *
 * Checked every 20 seconds while a task waits for the owner, every minute otherwise.
 * Reading costs no model tokens: it is plain calls to the Google Chat API.
 */

import { createHash, randomInt } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb, nowMs } from '../db/db.js';
import { getConfig } from '../config.js';
import { sseEmit } from '../api/events.js';
import { chatStatus, postToChatIn } from '../notify/chat.js';
import { googleStatus } from './google.js';
import { listNewMessages, type ChatMessage } from './reader.js';
import { parseCommand, HELP_TEXT, type Command } from './commands.js';
import { createTask, getTask } from '../pipeline/taskState.js';
import { startTask, ownerAnswered, StartError, stopTask, StoppedError } from '../pipeline/pipeline.js';
import { askLead, openProposal, startProposal, LeadError } from '../pipeline/lead.js';
import { answerQuestion, openQuestions, skipOpenQuestions, QuestionError } from '../pipeline/questions.js';
import { addMessage } from '../pipeline/thread.js';
import { ApprovalError, latestApproval, resolveApproval } from '../pipeline/approvals.js';
import { stateLabel, type TaskState } from '../pipeline/stateMachine.js';

// ─── State ────────────────────────────────────────────────────────────────────

interface InboundState {
  enabled: boolean;
  owner: { sender: string; displayName: string } | null;
  /** Messages created after this (RFC 3339) are read next. */
  cursor: string | null;
  link: { code: string; expires: number } | null;
  /** Recent tasks made from Chat, to make one task of the same text sent twice. */
  recent: Array<{ hash: string; taskId: string; at: number }>;
  lastPollAt: number | null;
  lastError: string | null;
  handled: number;
  skippedOthers: number;
}

const stateFile = () => path.join(getConfig().home, 'chat-inbound.json');
const LINK_TTL_MS = 15 * 60_000;
const SAME_TASK_WINDOW_MS = 10 * 60_000;

function load(): InboundState {
  const blank: InboundState = { enabled: false, owner: null, cursor: null, link: null, recent: [], lastPollAt: null, lastError: null, handled: 0, skippedOthers: 0 };
  try {
    return { ...blank, ...(JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Partial<InboundState>) };
  } catch {
    return blank;
  }
}
function save(s: InboundState): void {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true, mode: 0o700 });
  const tmp = `${stateFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, stateFile());
}

export interface InboundStatus {
  enabled: boolean;
  /** Who FryDay takes instructions from: a name to show, not the account id. */
  owner: string | null;
  linking: { code: string; expiresAt: number } | null;
  lastPollAt: number | null;
  lastError: string | null;
  handled: number;
  skippedOthers: number;
  /** What is still missing before reading can work. */
  missing: string[];
}

export function inboundStatus(): InboundStatus {
  const s = load();
  const missing: string[] = [];
  if (!chatStatus().configured) missing.push('the space\'s webhook (FryDay answers through it)');
  const g = googleStatus();
  if (!g.clientSet) missing.push('a Google OAuth client');
  else if (!g.signedIn) missing.push('your Google sign-in');
  return {
    enabled: s.enabled,
    owner: s.owner?.displayName || (s.owner ? 'you' : null),
    linking: s.link && s.link.expires > nowMs() ? { code: s.link.code, expiresAt: s.link.expires } : null,
    lastPollAt: s.lastPollAt,
    lastError: s.lastError,
    handled: s.handled,
    skippedOthers: s.skippedOthers,
    missing,
  };
}

export class InboundError extends Error {}

/** Start linking: a code the owner posts in the space. Reading turns on; the cursor starts now, so old messages are left alone. */
export function startLink(): InboundStatus {
  const missing = inboundStatus().missing;
  if (missing.length) throw new InboundError(`Set up ${missing.join(' and ')} first`);
  const s = load();
  s.link = { code: `fryday-link-${randomInt(100_000, 1_000_000)}`, expires: nowMs() + LINK_TTL_MS };
  s.enabled = true;
  s.cursor ??= new Date().toISOString();
  s.lastError = null;
  save(s);
  schedule(0);
  return inboundStatus();
}

export function setReading(enabled: boolean): InboundStatus {
  const s = load();
  if (enabled && !s.owner) throw new InboundError('Link your Chat account first');
  s.enabled = enabled;
  if (enabled) s.cursor = new Date().toISOString(); // what was said while it was off is not acted on later
  save(s);
  if (enabled) schedule(0);
  else stopReading();
  return inboundStatus();
}

export function unlink(): InboundStatus {
  const s = load();
  s.owner = null;
  s.link = null;
  s.enabled = false;
  save(s);
  stopReading();
  return inboundStatus();
}

/** Whether a ticket's announcement should show its code: only when the owner can answer from Chat. */
export function chatApprovalsOn(): boolean {
  const s = load();
  return s.enabled && s.owner !== null;
}

// ─── Threads ──────────────────────────────────────────────────────────────────

export function threadOfTask(taskId: string): string | null {
  return (getDb().prepare('SELECT thread_name FROM chat_threads WHERE task_id = ?').get(taskId) as { thread_name: string } | undefined)?.thread_name ?? null;
}

export function taskOfThread(thread: string): string | null {
  return (getDb().prepare('SELECT task_id FROM chat_threads WHERE thread_name = ?').get(thread) as { task_id: string } | undefined)?.task_id ?? null;
}

export function rememberThread(taskId: string, thread: string): void {
  getDb().prepare('INSERT INTO chat_threads (task_id, thread_name) VALUES (?, ?) ON CONFLICT(task_id) DO NOTHING').run(taskId, thread);
}

/** Answer in a thread (or start one for a task). */
async function reply(text: string, where: { thread?: string | null; taskId?: string | null }): Promise<void> {
  const threadName = where.thread ?? (where.taskId ? threadOfTask(where.taskId) : null) ?? undefined;
  const d = await postToChatIn(text, threadName ? { threadName } : where.taskId ? { threadKey: `fryday-${where.taskId}` } : {});
  if (where.taskId && d.thread) rememberThread(where.taskId, d.thread);
}

// ─── Handling one message ─────────────────────────────────────────────────────

/** Record a message as handled. False when it was handled before. */
function firstTime(name: string): boolean {
  return getDb().prepare('INSERT OR IGNORE INTO chat_messages (name, processed_at) VALUES (?, ?)').run(name, nowMs()).changes > 0;
}

const OPEN_STATES: TaskState[] = ['queued', 'intake', 'waiting_owner', 'workspace', 'planning', 'coding', 'testing', 'verifying', 'awaiting_approval', 'releasing', 'deploying', 'needs_owner'];

function statusText(): string {
  const rows = getDb().prepare(`SELECT id, title, state FROM tasks WHERE state IN (${OPEN_STATES.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 10`).all(...OPEN_STATES) as Array<{ id: string; title: string; state: TaskState }>;
  if (rows.length === 0) return 'No task is open.';
  return rows.map((r) => `• ${r.id} ${r.title} — ${stateLabel(r.state).toLowerCase()}`).join('\n');
}

function taskStatus(taskId: string): string {
  const task = getTask(taskId)!;
  let note = '';
  try { note = String((JSON.parse(task.metadata_json ?? '{}') as { note?: unknown }).note ?? ''); } catch { /* none */ }
  const open = openQuestions(taskId);
  return `${task.id} is ${stateLabel(task.state as TaskState).toLowerCase()}.${note ? ` ${note.split('\n')[0]}` : ''}${open.length ? `\nWaiting for ${open.length} answer${open.length === 1 ? '' : 's'}.` : ''}`;
}

async function onNewTask(m: ChatMessage, c: Extract<Command, { kind: 'new_task' }>, s: InboundState): Promise<void> {
  const hash = createHash('sha256').update(`${c.title}\n${c.description}\n${c.project ?? ''}`).digest('hex');
  s.recent = s.recent.filter((r) => nowMs() - r.at < SAME_TASK_WINDOW_MS);
  const same = s.recent.find((r) => r.hash === hash);
  if (same) {
    await reply(`That is already ${same.taskId}; no second task was made.`, { thread: m.thread });
    return;
  }
  const task = createTask(c.title, c.description);
  s.recent.push({ hash, taskId: task.id, at: nowMs() });
  save(s);
  // Everything about this task happens in the thread where it was asked for.
  if (m.thread) rememberThread(task.id, m.thread);
  addMessage(task.id, 'owner', 'note', 'Asked for in the Chat space.');
  try {
    startTask(task.id, c.project, {});
    await reply(`Got it: ${task.id} "${task.title}". ${c.project ? `Working in ${c.project}.` : 'FryDay works out which project it is for.'} Questions and decisions will come in this thread.`, { taskId: task.id });
  } catch (err) {
    if (!(err instanceof StartError)) throw err;
    await reply(`Made ${task.id}, but it could not start: ${err.message}. Fix that in FryDay Code and start it there.`, { taskId: task.id });
  }
}

async function onDecision(taskId: string, c: Extract<Command, { kind: 'approve' | 'decline' }>): Promise<void> {
  const ticket = latestApproval(taskId);
  if (!ticket || ticket.state !== 'pending') {
    await reply(`Nothing is waiting for your decision on ${taskId}.`, { taskId });
    return;
  }
  try {
    resolveApproval(ticket.id, c.kind === 'approve' ? 'approved' : 'rejected', { via: 'token', code: c.code, resolvedBy: 'chat' });
    await reply(c.kind === 'approve' ? `Approved. ${(JSON.parse(ticket.payload_json) as { summary?: string }).summary ?? ''}` : 'Declined. Nothing was done.', { taskId });
  } catch (err) {
    if (!(err instanceof ApprovalError)) throw err;
    await reply(err.status === 403 ? 'That code does not match the decision that is waiting. Nothing was approved or declined.' : `Not done: ${err.message}`, { taskId });
  }
}

async function onAnswer(taskId: string, c: Extract<Command, { kind: 'answer' }>): Promise<void> {
  const open = openQuestions(taskId);
  if (open.length === 0 || (c.index === null && open.length > 1)) {
    // Not an answer after all: what the owner said goes to the agents.
    if (open.length > 1) {
      await reply(`There are ${open.length} questions open; start your answer with its number, like \`1: ...\`. I kept your message as a note for the agents.`, { taskId });
    }
    addMessage(taskId, 'owner', 'note', c.text);
    sseEmit({ type: 'task_message', taskId });
    // The Lead reads it and answers in this thread (notify/owner.ts passes its words on).
    if (open.length === 0 && !askLead(taskId)) await reply('Noted on the task; FryDay answers when it has finished reading your last message.', { taskId });
    return;
  }
  const q = c.index === null ? open[0]! : open[c.index - 1];
  if (!q) {
    await reply(`There is no open question ${c.index}.`, { taskId });
    return;
  }
  // A choice question takes one of its options: by number, by label, or by value.
  // A question with options takes one by number or by its words; a clarifying question also takes free text.
  let answer = c.text;
  if (q.options.length) {
    const n = Number(c.text);
    const pick = Number.isInteger(n) && n >= 1 && n <= q.options.length ? q.options[n - 1]
      : q.options.find((o) => o.label.toLowerCase() === c.text.toLowerCase() || o.value.toLowerCase() === c.text.toLowerCase());
    if (pick) answer = pick.value;
    else if (q.kind !== 'clarify') {
      await reply(`"${q.question}" needs one of: ${q.options.map((o, i) => `${i + 1}. ${o.label}`).join('  ')}`, { taskId });
      return;
    }
  }
  try {
    answerQuestion(taskId, q.id, answer);
  } catch (err) {
    if (!(err instanceof QuestionError)) throw err;
    await reply(`Not taken: ${err.message}`, { taskId });
    return;
  }
  const resumed = ownerAnswered(taskId);
  const left = openQuestions(taskId).length;
  await reply(resumed ? 'Thanks — going on.' : `Thanks. ${left} question${left === 1 ? '' : 's'} still open.`, { taskId });
}

async function handle(m: ChatMessage, s: InboundState): Promise<void> {
  if (!firstTime(m.name)) return;
  // Apps (FryDay's own webhook included) never instruct FryDay.
  if (m.sender.type !== 'HUMAN' || !m.sender.name) return;

  if (s.link && s.link.expires > nowMs() && m.text.split(/\s+/).includes(s.link.code)) {
    s.owner = { sender: m.sender.name, displayName: m.sender.displayName };
    s.link = null;
    save(s);
    await reply(`Linked. FryDay takes instructions here from ${m.sender.displayName || 'you'} only.\n\n${HELP_TEXT}`, { thread: m.thread });
    return;
  }
  if (!s.owner || m.sender.name !== s.owner.sender) {
    s.skippedOthers++;
    return;
  }
  s.handled++;
  const taskId = m.thread ? taskOfThread(m.thread) : null;
  const c = parseCommand(m.text, taskId !== null);
  if (c.kind === 'help') return reply(HELP_TEXT, { thread: m.thread });
  if (c.kind === 'status') return reply(taskId ? taskStatus(taskId) : statusText(), { thread: m.thread });
  if (!taskId) {
    if (c.kind === 'new_task') return onNewTask(m, c, s);
    return reply('To give FryDay a task, start the message with `task:`. Say `help` for the rest.', { thread: m.thread });
  }
  if (!getTask(taskId)) return;
  switch (c.kind) {
    case 'approve':
    case 'decline':
      return onDecision(taskId, c);
    case 'missing_code':
      return reply(`To ${c.decision}, add the code from the decision's message, like \`${c.decision} 123456\`.`, { taskId });
    case 'go_ahead': {
      const skipped = skipOpenQuestions(taskId);
      const resumed = ownerAnswered(taskId);
      return reply(skipped ? `Going on without ${skipped === 1 ? 'that answer' : 'those answers'}; the agents state what they assumed.` : resumed ? 'Going on.' : 'There was nothing to skip.', { taskId });
    }
    case 'answer':
      return onAnswer(taskId, c);
    case 'note':
      addMessage(taskId, 'owner', 'note', c.text);
      sseEmit({ type: 'task_message', taskId });
      if (!askLead(taskId)) return reply('Noted on the task; FryDay answers when it has finished reading your last message.', { taskId });
      return;
    case 'start_proposal': {
      const waiting = openProposal(taskId);
      if (!waiting) return reply('There is no proposed task waiting to be started here.', { taskId });
      try {
        const { id } = startProposal(taskId, waiting.messageId);
        return reply(`Started ${id}: ${waiting.proposal.title}. It has a thread of its own.`, { taskId });
      } catch (err) {
        if (!(err instanceof LeadError)) throw err;
        return reply(`Not started: ${err.message}`, { taskId });
      }
    }
    case 'stop':
      try {
        await stopTask(taskId);
        return reply('Stopped. Nothing already done is undone; a build running in Jenkins keeps running there.', { taskId });
      } catch (err) {
        if (!(err instanceof StoppedError)) throw err;
        return reply('There is nothing to stop on this task right now.', { taskId });
      }
    default:
      return reply('Say `help` to see what works here.', { taskId });
  }
}

// ─── Polling ──────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let running = false;
let fastMs = 20_000;
let slowMs = 60_000;

/** For tests: how often to look. */
export function setPollIntervals(fast: number, slow: number): void {
  fastMs = fast;
  slowMs = slow;
}

function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void pollOnce(); }, delay);
  timer.unref?.();
}

export function stopReading(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Look once. Exported for tests and for "check now". */
export async function pollOnce(): Promise<void> {
  if (running) return;
  running = true;
  let next = slowMs;
  try {
    const s = load();
    const space = chatStatus().space;
    if (!s.enabled || !space || !googleStatus().signedIn) return;
    const since = s.cursor ?? new Date().toISOString();
    const messages = await listNewMessages(space, since);
    for (const m of messages) {
      if (m.text.length > 10_000) { firstTime(m.name); continue; }
      try {
        await handle(m, s);
      } catch (err) {
        console.error('[fryday-core] a Chat message could not be handled:', err);
      }
      if (m.createTime > (s.cursor ?? '')) s.cursor = m.createTime;
    }
    const fresh = load();
    save({ ...fresh, owner: s.owner, link: s.link, recent: s.recent, cursor: s.cursor ?? since, handled: s.handled, skippedOthers: s.skippedOthers, lastPollAt: nowMs(), lastError: null });
    const waiting = getDb().prepare(`SELECT COUNT(*) AS n FROM tasks WHERE state IN ('waiting_owner', 'awaiting_approval', 'needs_owner')`).get() as { n: number };
    next = waiting.n > 0 || s.link ? fastMs : slowMs;
    sseEmit({ type: 'chat_inbound_updated' });
  } catch (err) {
    const s = load();
    save({ ...s, lastPollAt: nowMs(), lastError: err instanceof Error ? err.message : String(err) });
    next = Math.min(slowMs * 5, 5 * 60_000);
    sseEmit({ type: 'chat_inbound_updated' });
  } finally {
    running = false;
    if (load().enabled) schedule(next);
  }
}

/** Call once at startup. */
export function startInbound(): void {
  if (load().enabled) schedule(2000);
}
