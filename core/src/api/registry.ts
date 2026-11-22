/**
 * Projects API (also mounted at /api/registry, its earlier name).
 * GET    /api/projects            — list
 * GET    /api/projects/:id        — one project
 * POST   /api/projects            — add a project
 * PATCH  /api/projects/:id        — change some of its facts
 * POST   /api/projects/:id/verify — confirm (or un-confirm) its facts
 * DELETE /api/projects/:id        — forget a project (its clone is not touched)
 * POST   /api/projects/detect     — { path }: suggest a project's facts from its clone
 * POST   /api/projects/clone      — { url }: clone a repository, then suggest its facts
 */

import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/db.js';
import { listRepos, getRepo, overrideRepo, setVerified, saveProject, removeProject, ProjectError } from '../registry/registry.js';
import { detectProject, cloneRepository, DetectError } from '../registry/detect.js';
import { getConfig } from '../config.js';

export const registryRouter = Router();

const text = z.string().trim().min(1).max(500);
const optionalText = text.nullable().optional();
const Facts = z.object({
  name: text,
  localPath: text,
  remoteUrl: optionalText,
  prodBranch: text,
  stgBranch: optionalText,
  testCmd: optionalText,
  lintCmd: optionalText,
  typecheckCmd: optionalText,
  installCmd: optionalText,
  runProfile: z.record(z.unknown()).nullable().optional(),
  deployer: z.enum(['jenkins']).nullable().optional(),
  deployerConfig: z.record(z.unknown()).nullable().optional(),
  verified: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
}).strict();
const NewProjectBody = Facts.extend({ id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/) }).strict();

function respond(res: import('express').Response, work: () => unknown, okStatus = 200): void {
  try {
    res.status(okStatus).json(work());
  } catch (err) {
    if (!(err instanceof ProjectError)) throw err;
    res.status(400).json({ error: err.message });
  }
}

registryRouter.get('/', (_req, res) => {
  res.json({ repos: listRepos() });
});

// Suggestions only: nothing is saved by these two.
registryRouter.post('/detect', (req, res) => {
  const given = typeof req.body?.path === 'string' ? req.body.path : '';
  try {
    res.json(detectProject(given));
  } catch (err) {
    if (!(err instanceof DetectError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

registryRouter.post('/clone', async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  try {
    const clone = await cloneRepository(url, getConfig().reposDir);
    res.status(201).json(detectProject(clone));
  } catch (err) {
    if (!(err instanceof DetectError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

registryRouter.get('/:id', (req, res) => {
  const repo = getRepo(req.params['id']);
  if (!repo) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json(repo);
});

registryRouter.post('/', (req, res) => {
  const parsed = NewProjectBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid project', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }); return; }
  if (getRepo(parsed.data.id)) { res.status(409).json({ error: `A project with the id ${parsed.data.id} already exists` }); return; }
  respond(res, () => saveProject(parsed.data), 201);
});

registryRouter.patch('/:id', (req, res) => {
  const parsed = Facts.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid project facts', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }); return; }
  if (!getRepo(req.params['id'])) { res.status(404).json({ error: 'Project not found' }); return; }
  respond(res, () => overrideRepo(req.params['id'], parsed.data));
});

registryRouter.post('/:id/verify', (req, res) => {
  if (!getRepo(req.params['id'])) { res.status(404).json({ error: 'Project not found' }); return; }
  respond(res, () => setVerified(req.params['id'], req.body?.verified !== false));
});

registryRouter.delete('/:id', (req, res) => {
  const id = req.params['id'];
  const busy = getDb().prepare(`SELECT COUNT(*) AS n FROM task_workspaces WHERE repo_id = ? AND removed_at IS NULL`).get(id) as { n: number };
  if (busy.n > 0) { res.status(409).json({ error: 'This project still has task workspaces; discard them first' }); return; }
  if (!removeProject(id)) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json({ ok: true });
});
