/**
 * Which lessons an agent is given. Only active lessons (approved by the owner) for its role,
 * in this project or global; ranked by how many of their tags the task shares (its words,
 * the parts of the code the brief named, the files the plan expects to change); the top
 * few, capped in characters. Each one given is recorded, so its effect can be scored.
 */

import { activeLessonsFor, recordUses, tagsOf, type Lesson, type LessonRole } from './lessons.js';

export const LESSON_HEADING = 'Lessons from earlier tasks, approved by the owner';
export const MAX_LESSONS = 5;
export const LESSONS_CHARS = 1200;

export interface LessonContext {
  /** The task's title and description, or anything else that says what it is about. */
  text: string;
  /** Parts of the code the brief named. */
  areas?: string[];
  /** Files the plan expects to change. */
  files?: string[];
}

/** Rank by shared tags; a lesson about this very project comes before a global one on a tie, then the one that helped more. */
export function rankLessons(lessons: Lesson[], context: LessonContext, projectId: string | null): Lesson[] {
  const want = new Set(tagsOf(context.text, ...(context.areas ?? []), ...(context.files ?? [])));
  const score = (l: Lesson) => l.tags.filter((t) => want.has(t)).length + (l.projectId !== null && l.projectId === projectId ? 0.5 : 0);
  return [...lessons].sort((a, b) => score(b) - score(a) || (b.helped - b.hurt) - (a.helped - a.hurt) || b.id - a.id);
}

/** The lessons that fit the cap: whole lessons only, best first. */
export function pickLessons(ranked: Lesson[]): Lesson[] {
  const out: Lesson[] = [];
  let used = 0;
  for (const l of ranked) {
    if (out.length >= MAX_LESSONS) break;
    if (used + l.text.length + 3 > LESSONS_CHARS) continue;
    out.push(l);
    used += l.text.length + 3;
  }
  return out;
}

export function lessonsText(picked: Lesson[]): string {
  if (picked.length === 0) return '';
  return `## ${LESSON_HEADING}\n\nThey come from what went wrong in earlier work like this. Use them where they fit this task; the task, the plan and the owner's words come first.\n\n${picked.map((l) => `- ${l.text}`).join('\n')}`;
}

/** The lessons block for one agent of a task, recording which lessons it was given. Empty when there are none. */
export function lessonsFor(taskId: string, role: LessonRole, projectId: string | null, context: LessonContext): string {
  const picked = pickLessons(rankLessons(activeLessonsFor(role, projectId), context, projectId));
  if (picked.length > 0) recordUses(taskId, role, picked.map((l) => l.id));
  return lessonsText(picked);
}
