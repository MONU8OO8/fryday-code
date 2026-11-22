/**
 * Agent engines.
 * GET    /api/runners             — each engine: what it guarantees, which roles may use it, and
 *                                   whether it can run on this Mac now
 * PUT    /api/runners/cursor/key  — { key }: the owner's Cursor API key (owner at the UI only; never returned)
 * DELETE /api/runners/cursor/key  — forget it (owner at the UI only)
 */

import { Router, type Response } from 'express';
import { RUNNERS, RunnerConfigError, cursorBin, cursorKeySet, removeCursorKey, saveCursorKey } from '../runner/runners.js';

export const runnersRouter = Router();

function ownerOnly(res: Response): boolean {
  if (res.locals['authVia'] === 'cookie') return true;
  res.status(403).json({ error: 'Set the Cursor key in the FryDay Code UI' });
  return false;
}

function view() {
  return {
    runners: Object.values(RUNNERS).map((r) => {
      const a = r.available();
      return { id: r.id, label: r.label, caps: r.caps, available: a.ok, why: a.why ?? null };
    }),
    cursor: { installed: cursorBin() !== null, keySet: cursorKeySet() },
  };
}

runnersRouter.get('/', (_req, res) => {
  res.json(view());
});

runnersRouter.put('/cursor/key', (req, res) => {
  if (!ownerOnly(res)) return;
  try {
    saveCursorKey(req.body?.key);
    res.json(view());
  } catch (err) {
    if (!(err instanceof RunnerConfigError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

runnersRouter.delete('/cursor/key', (_req, res) => {
  if (!ownerOnly(res)) return;
  removeCursorKey();
  res.json(view());
});
