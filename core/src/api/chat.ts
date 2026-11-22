/**
 * Chat API — the owner talking to Fryday.
 * POST /api/chat   { message, sessionId? }  → 202 { runId }
 *
 * The reply arrives over SSE as `run_event` messages for that runId. Pass the
 * `sessionId` from a run's result event to continue the same conversation.
 */

import { Router } from 'express';
import { z } from 'zod';
import { askFryday, UnknownSessionError } from '../agents/concierge.js';
import { CapacityError } from '../runner/supervisor.js';

export const chatRouter = Router();

const ChatBody = z.object({
  message: z.string().trim().min(1).max(20_000),
  sessionId: z.string().uuid().optional(),
});

chatRouter.post('/', (req, res) => {
  const parsed = ChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues.map((i) => i.message) });
    return;
  }
  try {
    const run = askFryday(parsed.data.message, parsed.data.sessionId);
    res.status(202).json({ runId: run.runId });
  } catch (err) {
    if (err instanceof CapacityError) {
      res.status(429).json({ error: err.message, active: err.active, max: err.max });
      return;
    }
    if (err instanceof UnknownSessionError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});
