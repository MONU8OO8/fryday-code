/**
 * The machine and the scheduler, for the Health page and the header strip.
 * GET /api/system/health — the latest sample, the last 15 minutes, whether more work may start, and the scheduler's state
 */

import { Router } from 'express';
import { admission, latestSample, sampleHistory } from '../system/health.js';
import { schedulerStatus } from '../pipeline/scheduler.js';

export const systemRouter = Router();

systemRouter.get('/health', (_req, res) => {
  res.json({ latest: latestSample(), history: sampleHistory(), admission: admission(), scheduler: schedulerStatus() });
});
