/**
 * The service graph (knowledge/graph.ts). Reading and rescanning are open to any caller
 * with access; changing what the graph says is the owner's, from the FryDay UI.
 */

import { Router, type Response } from 'express';
import { z } from 'zod';
import { getRepo } from '../registry/registry.js';
import { addEdge, addService, confirmEdge, deleteEdge, graphView, GraphEditError, projectPanel, refreshProject, renameNode } from '../knowledge/graph.js';

export const graphRouter = Router();

const Edge = z.object({ from: z.string().min(1).max(400), to: z.string().min(1).max(400), kind: z.enum(['calls', 'exposes', 'served_by']) });

function ownerOnly(res: Response): boolean {
  if (res.locals['authVia'] === 'cookie') return true;
  res.status(403).json({ error: 'Change the service graph from the FryDay UI' });
  return false;
}

function edit(res: Response, fn: () => unknown): void {
  try {
    res.json(fn() ?? { ok: true });
  } catch (err) {
    if (!(err instanceof GraphEditError)) throw err;
    res.status(400).json({ error: err.message });
  }
}

graphRouter.get('/', (_req, res) => {
  res.json(graphView());
});

graphRouter.get('/projects/:id', (req, res) => {
  if (!getRepo(req.params['id'])) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json(projectPanel(req.params['id']));
});

graphRouter.post('/projects/:id/rescan', async (req, res) => {
  if (!getRepo(req.params['id'])) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json(await refreshProject(req.params['id'], { force: true }));
});

graphRouter.post('/edges', (req, res) => {
  if (!ownerOnly(res)) return;
  const e = Edge.safeParse(req.body);
  if (!e.success) { res.status(400).json({ error: 'Invalid link' }); return; }
  edit(res, () => addEdge(e.data.from, e.data.to, e.data.kind));
});

graphRouter.post('/edges/confirm', (req, res) => {
  if (!ownerOnly(res)) return;
  const e = Edge.safeParse(req.body);
  if (!e.success) { res.status(400).json({ error: 'Invalid link' }); return; }
  edit(res, () => confirmEdge(e.data.from, e.data.to, e.data.kind));
});

graphRouter.post('/edges/delete', (req, res) => {
  if (!ownerOnly(res)) return;
  const e = Edge.safeParse(req.body);
  if (!e.success) { res.status(400).json({ error: 'Invalid link' }); return; }
  edit(res, () => deleteEdge(e.data.from, e.data.to, e.data.kind));
});

graphRouter.post('/services', (req, res) => {
  if (!ownerOnly(res)) return;
  const b = z.object({ label: z.string().min(1).max(120) }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: 'A name is needed' }); return; }
  edit(res, () => addService(b.data.label));
});

graphRouter.patch('/nodes', (req, res) => {
  if (!ownerOnly(res)) return;
  const b = z.object({ id: z.string().min(1).max(400), label: z.string().min(1).max(120) }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: 'Invalid name' }); return; }
  edit(res, () => renameNode(b.data.id, b.data.label));
});
