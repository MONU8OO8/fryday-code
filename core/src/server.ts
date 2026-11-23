/**
 * FryDay Code — the local server: API, live events and the UI.
 *
 * Security (see api/auth.ts):
 *   - Listens on 127.0.0.1 only; Host and Origin must match this server exactly.
 *   - API routes need the install's secret (`x-fryday-core-token`) or the owner's UI
 *     session cookie.
 *   - The UI session is granted only for a one-time launch code (POST /api/session).
 *     Serving the page does not grant it.
 *   - Public: /health, the UI's static files, and the session endpoints.
 */

import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';

import { loadConfig } from './config.js';
import { initDb } from './db/db.js';
import { reconcileRunsOnStartup } from './runner/supervisor.js';
import { registerPipeline, recoverInterruptedTasks } from './pipeline/pipeline.js';
import { registerLead } from './pipeline/lead.js';
import { reconcileReleasesOnStartup } from './pipeline/releaseFlow.js';
import { registerDeploy, reconcileDeploysOnStartup } from './deploy/deployFlow.js';
import { sseHandler } from './api/events.js';
import { tasksRouter } from './api/tasks.js';
import { agentsRouter } from './api/agents.js';
import { graphRouter } from './api/graph.js';
import { lessonsRouter } from './api/lessons.js';
import { refreshAll } from './knowledge/graph.js';
import { registryRouter } from './api/registry.js';
import { approvalsRouter } from './api/approvals.js';
import { chatRouter } from './api/chat.js';
import { usageRouter } from './api/usage.js';
import { settingsRouter } from './api/settings.js';
import { connectionsRouter } from './api/connections.js';
import { notificationsRouter } from './api/notifications.js';
import { deployRouter } from './api/deploy.js';
import { runnersRouter } from './api/runners.js';
import { systemRouter } from './api/system.js';
import { startScheduler } from './pipeline/scheduler.js';
import { registerInitiatives } from './pipeline/initiative.js';
import { admission, startHealthSampler } from './system/health.js';
import { chatInboundRouter, oauthCallback } from './api/chatInbound.js';
import { startInbound } from './chatin/inbound.js';
import { registerOwnerNotifications } from './notify/owner.js';
import { authorize, checkLocal, hasUiSession, uiSessionCookie, LaunchCodes, CORE_TOKEN_HEADER } from './api/auth.js';
import { importSeedIfEmpty } from './registry/registry.js';
import { registerLearning } from './learning/retro.js';
import { browserHost } from './platform.js';

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const cfg = loadConfig();
initDb(cfg.dbPath);
const seeded = importSeedIfEmpty(cfg.seedPath);
if (seeded > 0) console.log(`[fryday-core] Imported ${seeded} project${seeded === 1 ? '' : 's'} from ${cfg.seedPath}`);
const launchCodes = new LaunchCodes();
registerPipeline(); // before runs are picked up again, so their endings are handled
registerLead(); // the Lead's answers are handled the same way
registerLearning(); // retros after tasks end, and the scoring of lessons they were given
registerOwnerNotifications();
registerDeploy();
registerInitiatives(); // an initiative's state follows its sub-tasks
reconcileRunsOnStartup();
recoverInterruptedTasks();
reconcileDeploysOnStartup();
startHealthSampler();
startScheduler(admission); // after recovery, so a recovered task is not started twice
startInbound();
void reconcileReleasesOnStartup().catch((err) => console.error('[fryday-core] could not reconcile releases:', err));

const app = express();
/** The installed version, from core/package.json (always in the npm package). */
const VERSION = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// Local-only guard for every route: exact Host and Origin match (stops DNS rebinding
// and requests made by pages on other origins).
app.use((req: Request, res: Response, next: NextFunction) => {
  const denied = checkLocal({ host: header(req, 'host'), origin: header(req, 'origin') }, cfg.port);
  if (denied && !denied.ok) {
    res.status(denied.status).json({ error: 'Forbidden', reason: denied.reason });
    return;
  }
  next();
});

// ─── Session: how a browser becomes the owner ────────────────────────────────
// Public on purpose (there is no session yet), but each needs something only the owner has.
app.get('/api/session', (req: Request, res: Response) => {
  res.status(hasUiSession(header(req, 'cookie'), cfg.coreSecret, cfg.port) ? 200 : 401).json({ ok: hasUiSession(header(req, 'cookie'), cfg.coreSecret, cfg.port) });
});

app.post('/api/session', (req: Request, res: Response) => {
  // A browser always sends Origin on a POST; the local guard above already checked it is ours.
  if (!header(req, 'origin')) { res.status(403).json({ error: 'Open FryDay Code in a browser' }); return; }
  if (!launchCodes.redeem(req.body?.code)) {
    res.status(401).json({ error: 'That launch code is not valid any more. Run `npx fryday-code open` (or `npm run open` in a clone) for a new one.' });
    return;
  }
  res.setHeader('Set-Cookie', uiSessionCookie(cfg.coreSecret, cfg.port));
  res.json({ ok: true });
});

// A new launch code, for a caller that already holds the install's secret (`npm run open`).
app.post('/api/session/launch-code', (req: Request, res: Response) => {
  const result = authorize(
    { method: req.method, host: header(req, 'host'), origin: header(req, 'origin'), headerToken: header(req, CORE_TOKEN_HEADER), cookieHeader: undefined },
    cfg.coreSecret,
    cfg.port
  );
  if (!result.ok || result.via !== 'token') { res.status(401).json({ error: 'Unauthorized' }); return; }
  const code = launchCodes.issue();
  res.json({ code, url: launchUrl(code) });
});

function launchUrl(code: string): string {
  // In the fragment: it is never sent to a server and does not end up in logs.
  // In Docker core listens on every address; the link is for the browser on this machine.
  return `http://${browserHost(cfg.host)}:${cfg.port}/ui/#launch=${code}`;
}

// Google sends the browser back here after the owner signs in. There is no session on that
// request (it comes from Google's page), so it is public; it completes only a sign-in this
// install started, identified by a one-time state value, and shows nothing it was given.
app.get('/oauth/google/callback', (req: Request, res: Response) => { void oauthCallback(req, res); });

// Credential guard for the API. Public: /health, the UI's static files, the root redirect and the session endpoints above.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/' || req.path === '/health' || req.path === '/ui' || req.path.startsWith('/ui/')) {
    next();
    return;
  }
  const result = authorize(
    {
      method: req.method,
      host: header(req, 'host'),
      origin: header(req, 'origin'),
      headerToken: header(req, CORE_TOKEN_HEADER),
      cookieHeader: header(req, 'cookie'),
    },
    cfg.coreSecret,
    cfg.port
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.status === 401 ? 'Unauthorized' : 'Forbidden', reason: result.reason });
    return;
  }
  // Some actions treat the owner at the UI differently from a caller holding the token.
  res.locals['authVia'] = result.via;
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    version: VERSION,
    pid: process.pid,
    // How agents authenticate: ANTHROPIC_API_KEY if set, else the claude CLI's own login.
    agentAuth: cfg.apiKey ? 'api_key' : 'cli_login',
  });
});

// What this install is running with (shown on the Settings page).
app.get('/api/system', (_req: Request, res: Response) => {
  res.json({
    version: VERSION,
    home: cfg.home,
    platform: `${process.platform} ${process.arch}`,
    claudeBin: cfg.claudeBin,
    agentAuth: cfg.apiKey ? 'api_key' : 'cli_login',
    modelOverride: process.env.FRYDAY_MODEL ?? null,
    checkTimeoutMinutes: Math.round(cfg.checkTimeoutMs / 60_000),
    // `fryday-code demo`: stand-in agents on a sample project; the UI says so.
    demo: process.env.FRYDAY_DEMO === '1',
  });
});

app.get('/api/events', sseHandler);
app.use('/api/tasks', tasksRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/projects', registryRouter);
app.use('/api/registry', registryRouter); // earlier name, kept for the UI
app.use('/api/approvals', approvalsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/usage', usageRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/deploy', deployRouter);
app.use('/api/runners', runnersRouter);
app.use('/api/system', systemRouter);
app.use('/api/chat-inbound', chatInboundRouter);
app.use('/api/graph', graphRouter);
app.use('/api/lessons', lessonsRouter);

// ─── UI static files (built by ui/vite.config.ts → core/public) ──────────────
const uiDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(uiDir)) {
  // Serving the page grants nothing; the page asks for a session with a launch code.
  const sendUi = (_req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(uiDir, 'index.html'));
  };
  app.get('/ui', sendUi);
  app.get('/ui/', sendUi);
  app.use('/ui', express.static(uiDir, { index: false }));
  // SPA fallback for client-side routes such as /ui/tasks/T-1. A request for a file that is not
  // there (a browser asking for the bundle of an older build) must say so rather than answer with
  // the page: a script tag served HTML fails silently, and the tab keeps showing the old build.
  app.get('/ui/*splat', (req: Request, res: Response): void => {
    if (/\.[a-z0-9]+$/i.test(req.path)) { res.status(404).type('text/plain').send('Not found'); return; }
    sendUi(req, res);
  });
}

// Root redirect to UI
app.get('/', (_req: Request, res: Response) => {
  res.redirect('/ui/');
});

// ─── Errors ───────────────────────────────────────────────────────────────────
// Unexpected failures are logged here and answered without internals.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error(`[fryday-core] ${req.method} ${req.path} failed:`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(cfg.port, cfg.host, () => {
  console.log(`[fryday-core] Listening on ${cfg.host}:${cfg.port}`);
  console.log(`[fryday-core] State: ${cfg.home}`);
  console.log(`[fryday-core] Open (one-time link, valid 15 minutes): ${launchUrl(launchCodes.issue())}`);
  console.log('[fryday-core] Later, or in another browser: npx fryday-code open (or npm run open in a clone)');
  // The service graph catches up with production commits that moved while core was off.
  void refreshAll();
});

export { app };
