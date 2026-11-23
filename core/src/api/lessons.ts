/**
 * Lessons (learning/). Reading is open to any caller with access. Approving, rewording,
 * rejecting and retiring are the owner's alone, from the FryDay UI: an agent or a script
 * holding the core token cannot make a lesson reach other agents.
 */

import { Router, type Response } from 'express';
import { z } from 'zod';
import { listRepos } from '../registry/registry.js';
import { decide, editLesson, LESSON_ROLES, LessonError, lessonsUsedOn, listLessons, type Lesson } from '../learning/lessons.js';

export const lessonsRouter = Router();

function ownerOnly(res: Response): boolean {
  if (res.locals['authVia'] === 'cookie') return true;
  res.status(403).json({ error: 'Approve or change lessons from the FryDay UI' });
  return false;
}

function act(res: Response, fn: () => Lesson): void {
  try {
    res.json(fn());
  } catch (err) {
    if (!(err instanceof LessonError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
}

const idOf = (raw: string | undefined) => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

lessonsRouter.get('/', (_req, res) => {
  const names = Object.fromEntries(listRepos().map((r) => [r.id, r.name]));
  const all = listLessons();
  const by = (state: Lesson['state']) => all.filter((l) => l.state === state);
  res.json({ proposed: by('proposed'), active: by('active'), retired: by('retired'), projects: names });
});

lessonsRouter.get('/tasks/:id', (req, res) => {
  res.json({ used: lessonsUsedOn(req.params['id']) });
});

const Decision = z.object({ to: z.enum(['active', 'rejected', 'retired']) }).strict();

lessonsRouter.post('/:id/decide', (req, res) => {
  if (!ownerOnly(res)) return;
  const id = idOf(req.params['id']);
  const body = Decision.safeParse(req.body);
  if (!id || !body.success) { res.status(400).json({ error: 'Say approve, reject or retire' }); return; }
  act(res, () => decide(id, body.data.to));
});

const Edit = z.object({
  text: z.string().min(1).max(2000).optional(),
  role: z.enum(LESSON_ROLES).optional(),
  global: z.boolean().optional(),
}).strict();

lessonsRouter.patch('/:id', (req, res) => {
  if (!ownerOnly(res)) return;
  const id = idOf(req.params['id']);
  const body = Edit.safeParse(req.body);
  if (!id || !body.success) { res.status(400).json({ error: 'Nothing to change' }); return; }
  act(res, () => editLesson(id, body.data));
});
