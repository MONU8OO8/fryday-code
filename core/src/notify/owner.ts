/**
 * Telling the owner what needs them: a question, an approval that is waiting, a task
 * that stopped or finished. It goes three ways: a toast in the app (always), a desktop
 * notification (unless switched off in Settings), and the Chat space when one is set up.
 * The same things are always on the task's page; this is only the nudge.
 */

import { getDb } from '../db/db.js';
import { onTaskStateChange, type TaskRow } from '../pipeline/taskState.js';
import { onTicketRaised } from '../pipeline/approvals.js';
import { openQuestions } from '../pipeline/questions.js';
import { stateLabel, type TaskState } from '../pipeline/stateMachine.js';
import { postToChatIn } from './chat.js';
import { chatApprovalsOn, rememberThread, threadOfTask } from '../chatin/inbound.js';
import type { ApprovalRow } from '../pipeline/approvals.js';
import { notifyDesktop } from './desktop.js';
import { sseEmit } from '../api/events.js';
import { getSettings } from '../settings.js';
import { onLeadSaid } from '../pipeline/lead.js';
import { getTask } from '../pipeline/taskState.js';

/** States the owner hears about when a task enters them. Approvals are announced by their ticket instead. */
const ANNOUNCED = new Set<TaskState>(['waiting_owner', 'needs_owner', 'failed', 'deployed']);

function projectName(taskId: string): string {
  const row = getDb()
    .prepare(`SELECT p.name AS name FROM task_workspaces w JOIN projects p ON p.id = w.repo_id WHERE w.task_id = ? ORDER BY w.created_at DESC LIMIT 1`)
    .get(taskId) as { name: string } | undefined;
  return row?.name ?? '';
}

function heading(task: Pick<TaskRow, 'id' | 'title'>): string {
  const project = projectName(task.id);
  return `*${task.id} · ${task.title}*${project ? ` (${project})` : ''}`;
}

export type AlertKind = 'question' | 'decision' | 'stopped' | 'failed' | 'done';

/** Post in the task's own Chat thread: the one it was asked for in, or one started for it. Never throws. */
function postInThread(task: Pick<TaskRow, 'id' | 'title'>, text: string): void {
  const threadName = threadOfTask(task.id);
  void postToChatIn(text, threadName ? { threadName } : { threadKey: `fryday-${task.id}` })
    .then((d) => { if (d.thread && !threadName) rememberThread(task.id, d.thread); })
    .catch(() => undefined);
}

/** Send one message about a task: toast, desktop notification, and its Chat thread. Never throws. */
export function tellOwner(task: Pick<TaskRow, 'id' | 'title'>, text: string, kind: AlertKind = 'stopped'): void {
  postInThread(task, `${heading(task)}\n${text}`);
  const first = text.split('\n')[0] ?? text;
  sseEmit({ type: 'owner_alert', taskId: task.id, title: `${task.id} · ${task.title}`, text: first.slice(0, 400), kind });
  try {
    if (getSettings().alerts.mac) notifyDesktop(`FryDay · ${task.id}`, `${task.title}: ${first}`);
  } catch {
    /* settings unreadable: no desktop notification */
  }
}

export function announceTicket(task: Pick<TaskRow, 'id' | 'title'>, summary: string, pushes: string[] = [], ticket?: ApprovalRow): void {
  const list = pushes.length ? `\nThis will push:\n${pushes.map((p) => `• ${p}`).join('\n')}` : '';
  // The code is shown only when the owner can answer from Chat; it is what makes an approval there count.
  const how = ticket?.code && chatApprovalsOn()
    ? `\nReply \`approve ${ticket.code}\` or \`decline ${ticket.code}\` in this thread, or decide in FryDay Code.`
    : '\nOpen FryDay Code to approve or decline.';
  tellOwner(task, `Needs your decision: ${summary}${list}${how}`, 'decision');
}

function onStateChange(task: TaskRow, note: string | undefined): void {
  if (!ANNOUNCED.has(task.state)) return;
  if (task.state === 'waiting_owner') {
    const asked = openQuestions(task.id)
      .map((q, i) => `${i + 1}. ${q.question}${q.options.length ? ` (${q.options.map((o) => o.label).join(' / ')})` : ''}`)
      .join('\n');
    tellOwner(task, `${note ?? 'Waiting for your answer.'}\n${asked}\nAnswer on the task in FryDay Code.`, 'question');
    return;
  }
  tellOwner(task, `${stateLabel(task.state)}: ${note ?? ''}`.trim(), task.state === 'deployed' ? 'done' : task.state === 'failed' ? 'failed' : 'stopped');
}

/** Call once at startup. */
export function registerOwnerNotifications(): void {
  onTaskStateChange(onStateChange);
  onTicketRaised(announceTicket);
  // What the Lead answers is said in the task's Chat thread too, so a conversation started
  // there can go on there. In the app it is already in the chat, so no toast.
  onLeadSaid((said) => {
    const task = getTask(said.taskId);
    if (!task) return;
    if (said.kind === 'reply') { postInThread(task, `${heading(task)}\n${said.text}`); return; }
    const how = chatApprovalsOn() ? 'Reply `start` in this thread to start it, or press Start in FryDay Code.' : 'Press Start on the task in FryDay Code to start it.';
    postInThread(task, `${heading(task)}\nA task for ${said.projectName}: ${said.title}\n${how}`);
  });
}
