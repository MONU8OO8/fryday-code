/**
 * The lessons store. A lesson is proposed by the Reflector or by core and stays proposed
 * until the owner approves it from the Lessons page: nothing here makes a lesson active on
 * its own, and only active lessons are ever given to an agent (learning/inject.ts).
 * Once a task that was given lessons ends, each one is scored: hurt when the failure it was
 * drawn from came back, helped when the task passed its first round.
 */

import { getDb, nowMs } from '../db/db.js';
import { redactSecrets } from '../secretPatterns.js';
import { shortenPaths } from '../runner/runEvents.js';
import { sseEmit } from '../api/events.js';

export const LESSON_ROLES = ['analyst', 'planner', 'coder', 'tester'] as const;
export type LessonRole = (typeof LESSON_ROLES)[number];
export type LessonState = 'proposed' | 'active' | 'retired' | 'rejected';
export type LessonSource = 'reflector' | 'core';

export interface Evidence { taskId: string; round: number | null; what: string }

export interface Lesson {
  id: number;
  projectId: string | null;
  role: LessonRole;
  tags: string[];
  text: string;
  evidence: Evidence[];
  signatures: string[];
  source: LessonSource;
  state: LessonState;
  uses: number;
  helped: number;
  hurt: number;
  createdAt: number;
  decidedAt: number | null;
  /** Hurt three times or more: the Lessons page suggests retiring it. */
  suggestRetire: boolean;
}

export interface Proposal {
  projectId: string | null;
  role: LessonRole;
  tags: string[];
  text: string;
  evidence: Evidence[];
  signatures: string[];
  source: LessonSource;
}

export const LESSON_CHARS = 400;
export const RETIRE_AFTER_HURT = 3;
const TAG_LIMIT = 12;
const EVIDENCE_LIMIT = 6;

interface LessonRow {
  id: number; project_id: string | null; role: LessonRole; trigger_tags: string; text: string; evidence_json: string;
  signatures_json: string; source: LessonSource; state: LessonState; uses: number; helped: number; hurt: number;
  created_at: number; decided_at: number | null;
}

const list = <T>(json: string): T[] => {
  try { const v = JSON.parse(json); return Array.isArray(v) ? (v as T[]) : []; } catch { return []; }
};

const fromRow = (r: LessonRow): Lesson => ({
  id: r.id,
  projectId: r.project_id,
  role: r.role,
  tags: list<string>(r.trigger_tags),
  text: r.text,
  evidence: list<Evidence>(r.evidence_json),
  signatures: list<string>(r.signatures_json),
  source: r.source,
  state: r.state,
  uses: r.uses,
  helped: r.helped,
  hurt: r.hurt,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  suggestRetire: r.state === 'active' && r.hurt >= RETIRE_AFTER_HURT,
});

export class LessonError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Lesson text as stored and shown: one paragraph, no control characters, no paths or secrets. */
export function cleanLessonText(text: string, max = LESSON_CHARS): string {
  return redactSecrets(shortenPaths(text.replace(/[\u0000-\u001f\u007f]/g, ' ')))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'when', 'from', 'into', 'are', 'was', 'not', 'any', 'all', 'its', 'has', 'have', 'you', 'your', 'task', 'tasks', 'src', 'lib', 'index', 'test', 'tests']);

/** Words a lesson or a task is about: lower case, three letters or more, path parts split. */
export function tagsOf(...texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const w of t.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  }
  return [...out];
}

const sameText = (a: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Store a proposal. Returns null when the same lesson (same role, project and words) is
 * already known in any state, so a rejected lesson is not proposed again.
 */
export function propose(p: Proposal): Lesson | null {
  const text = cleanLessonText(p.text);
  if (text.length < 12) return null;
  const db = getDb();
  const known = db.prepare(`SELECT text FROM lessons WHERE role = ? AND project_id IS ?`).all(p.role, p.projectId) as Array<{ text: string }>;
  if (known.some((k) => sameText(k.text) === sameText(text))) return null;
  const evidence = p.evidence.slice(0, EVIDENCE_LIMIT).map((e) => ({ taskId: e.taskId, round: e.round, what: cleanLessonText(e.what, 200) }));
  const info = db.prepare(`
    INSERT INTO lessons (project_id, role, trigger_tags, text, evidence_json, signatures_json, source, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
  `).run(p.projectId, p.role, JSON.stringify(p.tags.slice(0, TAG_LIMIT)), text, JSON.stringify(evidence), JSON.stringify([...new Set(p.signatures)].slice(0, 10)), p.source, nowMs());
  sseEmit({ type: 'lessons_updated' });
  return getLesson(Number(info.lastInsertRowid))!;
}

/** Whether a lesson drawn from this signature is already known for the project, in any state. */
export function knownSignature(projectId: string | null, signature: string): boolean {
  return (getDb().prepare(`SELECT signatures_json FROM lessons WHERE project_id IS ? AND source = 'core'`).all(projectId) as Array<{ signatures_json: string }>)
    .some((r) => list<string>(r.signatures_json).includes(signature));
}

export function getLesson(id: number): Lesson | undefined {
  const row = getDb().prepare('SELECT * FROM lessons WHERE id = ?').get(id) as LessonRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function listLessons(state?: LessonState): Lesson[] {
  const rows = state
    ? (getDb().prepare('SELECT * FROM lessons WHERE state = ? ORDER BY created_at DESC').all(state) as LessonRow[])
    : (getDb().prepare('SELECT * FROM lessons ORDER BY created_at DESC').all() as LessonRow[]);
  return rows.map(fromRow);
}

/** Active lessons an agent of this role may be given in this project: its own and the global ones. */
export function activeLessonsFor(role: LessonRole, projectId: string | null): Lesson[] {
  return (getDb().prepare(`SELECT * FROM lessons WHERE state = 'active' AND role = ? AND (project_id IS NULL OR project_id IS ?) ORDER BY id`)
    .all(role, projectId) as LessonRow[]).map(fromRow);
}

// ─── The owner's decisions ────────────────────────────────────────────────────

const ALLOWED: Record<string, LessonState[]> = {
  active: ['proposed', 'retired'],
  rejected: ['proposed'],
  retired: ['active'],
};

/** Approve, reject or retire. Only the API's owner-only routes call this. */
export function decide(id: number, to: 'active' | 'rejected' | 'retired'): Lesson {
  const lesson = getLesson(id);
  if (!lesson) throw new LessonError(404, 'No such lesson');
  if (!ALLOWED[to]!.includes(lesson.state)) throw new LessonError(409, `A ${lesson.state} lesson cannot be made ${to}`);
  getDb().prepare('UPDATE lessons SET state = ?, decided_at = ? WHERE id = ?').run(to, nowMs(), id);
  sseEmit({ type: 'lessons_updated' });
  return getLesson(id)!;
}

/** The owner rewords a lesson before (or after) approving it; scope and role can change too. */
export function editLesson(id: number, change: { text?: string; role?: LessonRole; global?: boolean; projectId?: string | null }): Lesson {
  const lesson = getLesson(id);
  if (!lesson) throw new LessonError(404, 'No such lesson');
  if (lesson.state === 'rejected') throw new LessonError(409, 'A rejected lesson cannot be edited');
  const text = change.text !== undefined ? cleanLessonText(change.text) : lesson.text;
  if (text.length < 12) throw new LessonError(400, 'Say the lesson in a sentence');
  const role = change.role ?? lesson.role;
  if (!LESSON_ROLES.includes(role)) throw new LessonError(400, 'Unknown agent');
  const projectId = change.global === true ? null : change.projectId !== undefined ? change.projectId : lesson.projectId;
  getDb().prepare('UPDATE lessons SET text = ?, role = ?, project_id = ?, trigger_tags = ? WHERE id = ?')
    .run(text, role, projectId, JSON.stringify([...new Set([...lesson.tags, ...tagsOf(text)])].slice(0, TAG_LIMIT)), id);
  sseEmit({ type: 'lessons_updated' });
  return getLesson(id)!;
}

// ─── Use and effect ───────────────────────────────────────────────────────────

/** Record that these lessons were given to an agent of the task. A lesson counts once per task and role. */
export function recordUses(taskId: string, role: LessonRole, ids: number[]): void {
  const db = getDb();
  const insert = db.prepare(`INSERT OR IGNORE INTO lesson_uses (lesson_id, task_id, role, created_at) VALUES (?, ?, ?, ?)`);
  const bump = db.prepare('UPDATE lessons SET uses = uses + 1 WHERE id = ?');
  db.transaction(() => {
    for (const id of ids) if (insert.run(id, taskId, role, nowMs()).changes > 0) bump.run(id);
  })();
}

export interface LessonUse { lessonId: number; role: string; text: string; outcome: 'helped' | 'hurt' | 'neutral' | null; state: LessonState }

export function lessonsUsedOn(taskId: string): LessonUse[] {
  return (getDb().prepare(`
    SELECT u.lesson_id, u.role, u.outcome, l.text, l.state FROM lesson_uses u JOIN lessons l ON l.id = u.lesson_id
    WHERE u.task_id = ? ORDER BY u.created_at, u.lesson_id
  `).all(taskId) as Array<{ lesson_id: number; role: string; outcome: LessonUse['outcome']; text: string; state: LessonState }>)
    .map((r) => ({ lessonId: r.lesson_id, role: r.role, text: r.text, outcome: r.outcome, state: r.state }));
}

/**
 * Score the lessons a finished task was given, once. Hurt: the task still hit a failure the
 * lesson was drawn from. Helped: the task passed its first round. Otherwise neutral.
 */
export function scoreLessons(taskId: string, taskSignatures: string[], passedFirstRound: boolean): void {
  const db = getDb();
  const open = db.prepare(`SELECT DISTINCT u.lesson_id FROM lesson_uses u WHERE u.task_id = ? AND u.outcome IS NULL`).all(taskId) as Array<{ lesson_id: number }>;
  if (open.length === 0) return;
  const hit = new Set(taskSignatures);
  db.transaction(() => {
    for (const { lesson_id } of open) {
      const lesson = getLesson(lesson_id);
      if (!lesson) continue;
      const outcome = lesson.signatures.some((s) => hit.has(s)) ? 'hurt' : passedFirstRound ? 'helped' : 'neutral';
      db.prepare('UPDATE lesson_uses SET outcome = ? WHERE lesson_id = ? AND task_id = ?').run(outcome, lesson_id, taskId);
      if (outcome !== 'neutral') db.prepare(`UPDATE lessons SET ${outcome} = ${outcome} + 1 WHERE id = ?`).run(lesson_id);
    }
  })();
  sseEmit({ type: 'lessons_updated' });
}
