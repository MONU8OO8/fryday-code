/**
 * Questions to the owner. A task with an open question waits; it goes on when the last
 * one is answered. Storage and rules only: what happens next is the pipeline's business.
 */

import { randomUUID } from 'crypto';
import { getDb, nowMs } from '../db/db.js';
import { sseEmit } from '../api/events.js';
import { addMessage } from './thread.js';

/**
 * clarify  the task itself is unclear (free text, or one of the offered options)
 * project  which project the task is for (the answer is a project id)
 * branch   continue on an existing branch or start a new one (the answer is one of the options)
 */
export type QuestionKind = 'clarify' | 'project' | 'branch';

export interface QuestionOption {
  value: string;
  label: string;
}

export interface TaskQuestion {
  id: string;
  taskId: string;
  kind: QuestionKind;
  question: string;
  why: string | null;
  options: QuestionOption[];
  answer: string | null;
  askedBy: string;
  askedAt: number;
  answeredAt: number | null;
}

export interface NewQuestion {
  kind: QuestionKind;
  question: string;
  why?: string;
  options?: QuestionOption[];
}

export class QuestionError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

/** What an unanswered question is recorded as when the owner says "go ahead anyway". */
export const NO_ANSWER = 'No answer given. Use your best judgement and state the assumption you made.';

const MAX_ANSWER_CHARS = 4000;

interface Row {
  id: string; task_id: string; kind: QuestionKind; question: string; why: string | null; options_json: string | null;
  answer: string | null; asked_by: string; asked_at: number; answered_at: number | null;
}
const toQuestion = (r: Row): TaskQuestion => ({
  id: r.id, taskId: r.task_id, kind: r.kind, question: r.question, why: r.why,
  options: r.options_json ? (JSON.parse(r.options_json) as QuestionOption[]) : [],
  answer: r.answer, askedBy: r.asked_by, askedAt: r.asked_at, answeredAt: r.answered_at,
});

export function listQuestions(taskId: string): TaskQuestion[] {
  return (getDb().prepare('SELECT * FROM task_questions WHERE task_id = ? ORDER BY asked_at, rowid').all(taskId) as Row[]).map(toQuestion);
}

export function openQuestions(taskId: string): TaskQuestion[] {
  return listQuestions(taskId).filter((q) => q.answer === null);
}

export function askQuestions(taskId: string, askedBy: string, items: NewQuestion[]): TaskQuestion[] {
  const insert = getDb().prepare(`
    INSERT INTO task_questions (id, task_id, kind, question, why, options_json, asked_by, asked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ids: string[] = [];
  for (const item of items) {
    const id = `q-${randomUUID()}`;
    insert.run(id, taskId, item.kind, item.question.trim(), item.why?.trim() || null, item.options?.length ? JSON.stringify(item.options) : null, askedBy, nowMs());
    ids.push(id);
    const offered = item.options?.length ? `\n${item.options.map((o) => `• ${o.label}`).join('\n')}` : '';
    addMessage(taskId, askedBy, 'question', `${item.question.trim()}${item.why?.trim() ? `\n(${item.why.trim()})` : ''}${offered}`);
  }
  sseEmit({ type: 'questions_updated', taskId });
  return listQuestions(taskId).filter((q) => ids.includes(q.id));
}

/** Record the owner's answer. For a project or branch question it must be one of the options. */
export function answerQuestion(taskId: string, questionId: string, answer: string): TaskQuestion {
  const row = getDb().prepare('SELECT * FROM task_questions WHERE id = ? AND task_id = ?').get(questionId, taskId) as Row | undefined;
  if (!row) throw new QuestionError(404, 'No such question on this task');
  if (row.answer !== null) throw new QuestionError(409, 'That question is already answered');
  const text = answer.trim().slice(0, MAX_ANSWER_CHARS);
  if (!text) throw new QuestionError(400, 'The answer is empty');
  const question = toQuestion(row);
  let shown = text;
  if (question.kind !== 'clarify') {
    const chosen = question.options.find((o) => o.value === text);
    if (!chosen) throw new QuestionError(400, 'Choose one of the options offered');
    shown = chosen.label;
  }
  getDb().prepare('UPDATE task_questions SET answer = ?, answered_at = ? WHERE id = ?').run(text, nowMs(), questionId);
  addMessage(taskId, 'owner', 'answer', `${question.question}\n→ ${shown}`);
  sseEmit({ type: 'questions_updated', taskId });
  return { ...question, answer: text, answeredAt: nowMs() };
}

/** Close every open free-text question without an answer: the owner wants the agents to go on. */
export function skipOpenQuestions(taskId: string): number {
  const open = openQuestions(taskId).filter((q) => q.kind === 'clarify');
  for (const q of open) {
    getDb().prepare('UPDATE task_questions SET answer = ?, answered_at = ? WHERE id = ?').run(NO_ANSWER, nowMs(), q.id);
  }
  if (open.length > 0) {
    addMessage(taskId, 'owner', 'answer', `Go ahead without answers to ${open.length} question${open.length === 1 ? '' : 's'}.`);
    sseEmit({ type: 'questions_updated', taskId });
  }
  return open.length;
}
