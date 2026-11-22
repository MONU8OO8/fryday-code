/**
 * Usage API.
 * GET /api/usage/today — tokens for runs started since local midnight (the cost field is kept for the record, never shown).
 * GET /api/usage/by-role?days=7 — the same per agent role, for the last N days (1–90).
 */

import { Router } from 'express';
import { getUsageByRole, getUsageSince } from '../runner/usage.js';

export const usageRouter = Router();

usageRouter.get('/today', (_req, res) => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  res.json({ since: midnight.getTime(), usage: getUsageSince(midnight.getTime()) });
});

usageRouter.get('/by-role', (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.query['days'] ?? '7'), 10) || 7, 1), 90);
  const since = Date.now() - days * 86_400_000;
  res.json({ since, days, roles: getUsageByRole(since) });
});
