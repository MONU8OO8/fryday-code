/**
 * Approvals API — the owner's yes or no for an action that leaves the Mac.
 * GET  /api/approvals              — pending tickets
 * GET  /api/approvals/:id          — one ticket
 * POST /api/approvals/:id/resolve  — { decision: 'approved' | 'rejected', code? }
 *
 * From the UI (session cookie) the decision is enough. A caller using the core token —
 * an integration relaying a chat message — must also send the ticket's one-time code. The
 * code is never returned by this API.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ApprovalError, getApproval, pendingApprovals, publicApproval, resolveApproval } from '../pipeline/approvals.js';

export const approvalsRouter = Router();

const ResolveBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  code: z.string().max(32).optional(),
});

approvalsRouter.get('/', (_req, res) => {
  res.json({ approvals: pendingApprovals().map(publicApproval) });
});

approvalsRouter.get('/:id', (req, res) => {
  const approval = getApproval(req.params['id']);
  if (!approval) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(publicApproval(approval));
});

approvalsRouter.post('/:id/resolve', (req, res) => {
  const parsed = ResolveBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'decision must be approved or rejected' }); return; }
  try {
    const via = res.locals['authVia'] === 'cookie' ? 'cookie' : 'token';
    const approval = resolveApproval(req.params['id'], parsed.data.decision, { via, code: parsed.data.code });
    // An approved action runs in the background; its outcome appears on the task.
    res.status(parsed.data.decision === 'approved' ? 202 : 200).json(publicApproval(approval));
  } catch (err) {
    if (!(err instanceof ApprovalError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});
