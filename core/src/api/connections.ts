/**
 * Connections API.
 * GET  /api/connections                      — run the checks now; what works on this machine, and the data connections
 * GET  /api/connections/data                 — the data connections only (no checks are run)
 * POST /api/connections/data/:name/discover  — start that MCP server once and list its tools
 * PUT  /api/connections/data/:name           — { envKind, access, enabled, tools, projects }: what tester agents may use
 *
 * Deciding what an agent may reach is for the owner at the UI only.
 */

import { Router, type Response } from 'express';
import { z } from 'zod';
import { checkConnections, type ConnectionsReport } from '../connections/doctor.js';
import { ConnectionError, configureConnection, discoverConnection, listDataConnections } from '../connections/store.js';

export const connectionsRouter = Router();

// The checks start programs; two pages asking at once share one run.
let running: Promise<ConnectionsReport> | null = null;

connectionsRouter.get('/', async (_req, res) => {
  running ??= checkConnections().finally(() => { running = null; });
  res.json({ ...(await running), dataConnections: listDataConnections() });
});

connectionsRouter.get('/data', (_req, res) => {
  res.json({ dataConnections: listDataConnections() });
});

function ownerOnly(res: Response): boolean {
  if (res.locals['authVia'] === 'cookie') return true;
  res.status(403).json({ error: 'Decide what agents may use in the FryDay Code UI' });
  return false;
}

function fail(res: Response, err: unknown): void {
  if (!(err instanceof ConnectionError)) throw err;
  res.status(err.status).json({ error: err.message });
}

// Starting a server more than once at a time helps nobody.
const discovering = new Set<string>();

connectionsRouter.post('/data/:name/discover', async (req, res) => {
  if (!ownerOnly(res)) return;
  const name = req.params['name'];
  if (discovering.has(name)) { res.status(409).json({ error: 'Its tools are being listed right now' }); return; }
  discovering.add(name);
  try {
    res.json({ connection: await discoverConnection(name) });
  } catch (err) {
    fail(res, err);
  } finally {
    discovering.delete(name);
  }
});

const Change = z.object({
  envKind: z.enum(['local', 'staging', 'production', 'unknown']).optional(),
  access: z.enum(['read_only', 'read_write', 'unknown']).optional(),
  enabled: z.boolean().optional(),
  tools: z.array(z.object({ tool: z.string().min(1).max(200), check: z.enum(['sql', 'mongo', 'plain']) }).strict()).max(200).optional(),
  projects: z.array(z.string().min(1).max(64)).max(200).optional(),
}).strict();

connectionsRouter.put('/data/:name', (req, res) => {
  if (!ownerOnly(res)) return;
  const parsed = Change.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }); return; }
  try {
    res.json({ connection: configureConnection(req.params['name'], parsed.data) });
  } catch (err) {
    fail(res, err);
  }
});
