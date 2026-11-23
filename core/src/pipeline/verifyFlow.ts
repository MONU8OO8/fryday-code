/**
 * Verification: after the checks and the review are clean, core starts the project as a
 * running service and tester agents use it.
 *
 *   start the service (sandboxed, on a throwaway checkout of the reviewed commit)
 *     → API tester  (requests through core's own tool; granted data read-only)
 *     → UI tester   (a browser that can open the service and nothing else)
 *     → stop the service, keep the screenshots
 *
 * A tester that finds a problem sends the round back to the coder with what it saw. A
 * verification that could not be carried out (the service does not start even without
 * the change, no browser on the machine, a tester that never used the service) goes to
 * the owner: nothing is passed on the strength of a test that did not happen.
 *
 * Only projects with a run profile are verified this way. One verification runs at a
 * time: a service under test is heavy, and a fixed port can only be used once.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db/db.js';
import { getConfig } from '../config.js';
import { getRepo, type Project } from '../registry/registry.js';
import { killRun, toolTally, type RunExit, type RunHandle, type RunOptions } from '../runner/supervisor.js';
import { sseEmit } from '../api/events.js';
import { getTask, setTaskState, setTaskNote, type TaskRow } from './taskState.js';
import { createCheckout, removeCheckout, diffPatch } from './worktrees.js';
import { activeWorkspace, baseCheckoutPath, verifyCheckoutPath, type WorkspaceRow } from './workspaces.js';
import { depsForCheckout, depsUsable } from './deps.js';
import { getRound, getRounds } from './rounds.js';
import { retryWhenBusy } from './retry.js';
import { killTree } from './sandbox.js';
import type { Plan } from './review.js';
import { parseRunProfile, type RunProfile } from '../verify/profile.js';
import { machineName } from '../platform.js';
import { startService, serviceUnreachableReason, type RunningService, type ServiceFailure } from '../verify/service.js';
import { apiTesterMcp, uiTesterMcp, removeRunMcp, findChrome, browserMarker, BROWSER_TOOL_PREFIX, SERVICE_REQUEST_TOOL, type RunMcp } from '../verify/tools.js';
import { denyProxyPort, refusedSince } from '../verify/denyProxy.js';
import { sweep, sweepBlocking, visitedPaths } from '../verify/sweep.js';
import { grantsFor } from '../connections/store.js';
import {
  VERIFY_SCHEMA, BROWSER_DIR, TESTER_NAME, TESTER_ROLE, emptyVerification, parseVerifyReport, reportPasses, verifyFeedback, verifySummary,
  writeVerifyBrief, type TesterKind, type Verification,
} from '../verify/report.js';

const prompt = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'agents', 'prompts', `${name}.md`), 'utf8').trim();
const PROMPTS: Record<TesterKind, string> = { api: prompt('api-tester'), ui: prompt('ui-tester') };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const MAX_EVIDENCE_FILES = 30;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

export type TesterRole = (typeof TESTER_ROLE)[TesterKind];
export const isTesterRole = (role: string): role is TesterRole => role === 'api_tester' || role === 'ui_tester';

/** What this module needs from the pipeline. Passed in, so the two files do not import each other. */
export interface VerifyHost {
  handToOwner(taskId: string, reason: string): void;
  /** Start an agent within the task's token limit. Null, with a ticket raised, when its tokens are used up. */
  startTaskAgent(taskId: string, stage: { role: TesterRole; round: number }, opts: RunOptions): Promise<RunHandle | null>;
  askToContinue(taskId: string, stage: { role: TesterRole; round: number }, why: 'agent' | 'task'): void;
  /** Send the round back to the coder (or to the owner at the round limit). */
  sendBack(taskId: string, round: number, feedback: string, summary: string): void;
  /** Everything passed: ask the owner. */
  approve(taskId: string, round: number, verified: string): void;
  planOf(task: TaskRow): Plan | null;
  ownerNotes(taskId: string): string;
  guided(basePrompt: string, repo: Project | undefined, ws: WorkspaceRow): string;
}

/** The project's run profile, when it has a usable one. */
export function runProfileOf(repo: Project | undefined): RunProfile | null {
  return repo ? parseRunProfile(repo.runProfile) : null;
}

export const evidenceDir = (taskId: string, round: number) => path.join(getConfig().evidenceDir, taskId, `r${round}`);

// ─── One at a time ────────────────────────────────────────────────────────────

let slot: Promise<void> = Promise.resolve();
function acquireSlot(): Promise<() => void> {
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const ready = slot.then(() => release);
  slot = slot.then(() => mine);
  return ready;
}

interface Active {
  taskId: string;
  round: number;
  ws: WorkspaceRow;
  repo: Project;
  checkout: string;
  profile: RunProfile;
  service: RunningService;
  queue: TesterKind[];
  current: { kind: TesterKind; runId: string; mcp: RunMcp; startedAt: number } | null;
  verification: Verification;
  release: () => void;
}
const active = new Map<string, Active>();
/** Tasks whose verification is queued behind another one. */
const waiting = new Set<string>();

/** True while a task's service is up. */
export const isVerifying = (taskId: string) => active.has(taskId) || waiting.has(taskId);

function save(taskId: string, round: number, v: Verification): void {
  getDb().prepare('UPDATE task_rounds SET verify_json = ? WHERE task_id = ? AND round = ?').run(JSON.stringify(v), taskId, round);
  sseEmit({ type: 'round_updated', taskId, round });
}

export function verificationOf(taskId: string, round: number): Verification | null {
  const row = getDb().prepare('SELECT verify_json FROM task_rounds WHERE task_id = ? AND round = ?').get(taskId, round) as { verify_json: string | null } | undefined;
  if (!row?.verify_json) return null;
  try {
    return JSON.parse(row.verify_json) as Verification;
  } catch {
    return null;
  }
}

/**
 * Keep the screenshots the UI tester took, where the owner can see them after the checkout is
 * gone. Called while the tester works (each new picture shows in the chat) and once at the end.
 * Only plain image files from the tester's own output folder are copied.
 */
function keepEvidence(a: Pick<Active, 'taskId' | 'round' | 'checkout'>, already: string[] = []): string[] {
  const from = path.join(a.checkout, BROWSER_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(from).filter((n) => /^[\w.-]+\.(png|jpe?g)$/i.test(n) && !n.startsWith('sweep-')).sort();
  } catch {
    return already;
  }
  const to = evidenceDir(a.taskId, a.round);
  const kept = [...already];
  for (const name of names) {
    if (kept.includes(name)) continue;
    if (kept.length >= MAX_EVIDENCE_FILES) break;
    const source = path.join(from, name);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(source); } catch { continue; }
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_EVIDENCE_BYTES) continue;
    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(source, path.join(to, name));
    kept.push(name);
  }
  return kept;
}

// ─── Pictures as they are taken ───────────────────────────────────────────────

const watchers = new Map<string, { watcher: fs.FSWatcher; timer: NodeJS.Timeout | null }>();

/** While the UI tester works, every new screenshot is kept and shown in the chat at once. */
function watchScreenshots(a: Active): void {
  stopWatching(a.taskId);
  const dir = path.join(a.checkout, BROWSER_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const entry = { watcher: null as unknown as fs.FSWatcher, timer: null as NodeJS.Timeout | null };
  const pick = () => {
    entry.timer = null;
    if (active.get(a.taskId) !== a) return;
    const before = a.verification.evidence.length;
    a.verification.evidence = keepEvidence(a, a.verification.evidence);
    if (a.verification.evidence.length > before) {
      save(a.taskId, a.round, a.verification);
      sseEmit({ type: 'verify_shot', taskId: a.taskId, round: a.round, names: a.verification.evidence.slice(before) });
    }
  };
  try {
    // A screenshot is written in pieces: look a moment after the folder last changed.
    entry.watcher = fs.watch(dir, () => { if (entry.timer) clearTimeout(entry.timer); entry.timer = setTimeout(pick, 400); });
    watchers.set(a.taskId, entry);
  } catch {
    /* no live pictures on this machine: they are still kept at the end */
  }
}

function stopWatching(taskId: string): void {
  const w = watchers.get(taskId);
  if (!w) return;
  if (w.timer) clearTimeout(w.timer);
  w.watcher.close();
  watchers.delete(taskId);
}

/** Core's own look at the visited pages at phone, tablet and desktop size, after the UI tester passed. */
async function sizeSweep(a: Active, runId: string): Promise<void> {
  const chrome = findChrome();
  if (!chrome) return;
  const row = getDb().prepare('SELECT log_path FROM runs WHERE id = ?').get(runId) as { log_path: string } | undefined;
  let log = '';
  try { log = row ? fs.readFileSync(row.log_path, 'utf8') : ''; } catch { /* the start page is still swept */ }
  setTaskNote(a.taskId, `Round ${a.round}: checking the pages at phone, tablet and desktop size`);
  a.verification.sweep = await sweep({
    origin: a.service.origin, paths: visitedPaths(log, a.service.origin, a.profile.uiPath), chromePath: chrome,
    denyProxyPort: await denyProxyPort(), servicePort: a.service.port, key: a.taskId, evidenceDir: evidenceDir(a.taskId, a.round),
  });
  save(a.taskId, a.round, a.verification);
}

/** A browser the tester's own process did not take down with it. */
function stopLeftoverBrowser(key: string): void {
  let pids: number[] = [];
  try {
    pids = execFileSync('pgrep', ['-f', '--', browserMarker(key)], { encoding: 'utf8' }).split('\n').map(Number).filter((n) => n > 0);
  } catch {
    return; // nothing matches
  }
  for (const pid of pids) killTree(pid);
}

/** Stop the service and remove everything this verification created. Safe to call twice. */
async function finish(a: Active, status: Verification['status'], note?: string): Promise<Verification> {
  if (!active.delete(a.taskId)) return a.verification;
  stopWatching(a.taskId);
  removeRunMcp(a.current?.mcp);
  a.current = null;
  try {
    await a.service.stop();
  } catch (err) {
    console.error(`[fryday-core] ${a.taskId}: could not stop the service under test:`, err);
  }
  stopLeftoverBrowser(a.taskId);
  a.verification.evidence = keepEvidence(a, a.verification.evidence);
  a.verification.status = status;
  if (note) a.verification.note = note;
  removeCheckout(a.ws.repo_path, a.checkout);
  a.release();
  save(a.taskId, a.round, a.verification);
  return a.verification;
}

/** Stop a task's verification from outside (the task was stopped or discarded). */
export async function stopVerification(taskId: string): Promise<void> {
  const a = active.get(taskId);
  if (!a) return;
  if (a.current) killRun(a.current.runId);
  await finish(a, 'error', 'Stopped before it finished.');
}

// ─── Start ────────────────────────────────────────────────────────────────────

const ownerOf = (ws: WorkspaceRow) => ({ repoId: ws.repo_id, taskId: ws.task_id, ownerRepoPath: ws.repo_path });

function logPathFor(taskId: string, round: number, what = 'service'): string {
  return path.join(getConfig().runsDir, `${taskId}.r${round}.${what}.log`);
}

/** Does the service come up on the task's base commit? Tells a broken change from a broken run profile. */
async function startsWithoutTheChange(ws: WorkspaceRow, profile: RunProfile, round: number): Promise<boolean | null> {
  const cfg = getConfig();
  const checkout = baseCheckoutPath(ws);
  createCheckout(ws.repo_path, checkout, ws.base_sha);
  try {
    const deps = await depsForCheckout(ownerOf(ws), checkout, false);
    if (!depsUsable(deps)) return null;
    const start = await startService({
      key: `${ws.task_id}-base`, profile, checkoutPath: checkout, ownerRepoPath: ws.repo_path, scratchRoot: cfg.scratchDir,
      logPath: logPathFor(ws.task_id, round, 'service-base'),
    });
    if (start.ok) await start.service.stop();
    return start.ok;
  } finally {
    removeCheckout(ws.repo_path, checkout);
    fs.rmSync(logPathFor(ws.task_id, round, 'service-base'), { force: true });
  }
}

/**
 * Verify the round's commit as a running service. The task must have a workspace, a
 * stored round and a project with a run profile.
 */
export async function verifyRound(host: VerifyHost, taskId: string, round: number): Promise<void> {
  const cfg = getConfig();
  const task = getTask(taskId)!;
  const ws = activeWorkspace(taskId)!;
  const repo = getRepo(ws.repo_id);
  const profile = runProfileOf(repo);
  const stored = getRound(taskId, round);
  if (!repo || !profile || !stored?.headSha) {
    host.handToOwner(taskId, 'The change could not be verified running: its project, run profile or review round is missing');
    return;
  }
  if (active.has(taskId) || waiting.has(taskId)) return; // already under way, or waiting for its turn
  if (task.state !== 'verifying') setTaskState(taskId, 'verifying', `Round ${round}: waiting to start the service`);

  waiting.add(taskId);
  let release: () => void;
  try {
    release = await acquireSlot();
  } finally {
    waiting.delete(taskId);
  }
  const v = emptyVerification();
  // Pictures from an earlier try of this round are not this try's.
  fs.rmSync(evidenceDir(taskId, round), { recursive: true, force: true });
  const stopEarly = (status: Verification['status'], note: string): Verification => {
    removeCheckout(ws.repo_path, checkout);
    v.status = status;
    v.note = note;
    save(taskId, round, v);
    release();
    return v;
  };
  const checkout = verifyCheckoutPath(ws);
  let service: RunningService;
  try {
    if (getTask(taskId)?.state !== 'verifying') { release(); return; } // stopped while waiting for its turn
    setTaskNote(taskId, `Round ${round}: starting the service (${profile.command})`);
    const unreachable = serviceUnreachableReason();
    if (unreachable) {
      stopEarly('error', unreachable);
      host.handToOwner(taskId, `${unreachable} Nothing was verified running; look at the change yourself, or turn the testers off in the run profile on the Projects page.`);
      return;
    }
    if (profile.ui && !findChrome()) {
      stopEarly('error', 'Google Chrome was not found, so the pages could not be opened.');
      host.handToOwner(taskId, `The UI tester needs Google Chrome, and it was not found on ${machineName()}. Install it (or set FRYDAY_CHROME), or turn the UI tester off in the run profile on the Projects page. Nothing was verified.`);
      return;
    }
    createCheckout(ws.repo_path, checkout, stored.headSha);
    const deps = await depsForCheckout(ownerOf(ws), checkout, true);
    if (!depsUsable(deps)) {
      stopEarly('error', `Dependencies are not available: ${deps.detail}`);
      host.handToOwner(taskId, `The service could not be started for verification because its dependencies are not available: ${deps.detail}`);
      return;
    }
    fs.mkdirSync(cfg.scratchDir, { recursive: true });
    const start = await startService({
      key: taskId, profile, checkoutPath: checkout, ownerRepoPath: ws.repo_path, scratchRoot: cfg.scratchDir, logPath: logPathFor(taskId, round),
    });
    if (!start.ok) {
      await serviceDidNotStart(host, taskId, round, ws, profile, start, v, stopEarly);
      return;
    }
    service = start.service;
  } catch (err) {
    stopEarly('error', err instanceof Error ? err.message : String(err));
    throw err;
  }

  v.service = { command: service.command, port: service.port, listen: service.listen, readyAfterMs: service.readyAfterMs };
  const a: Active = {
    taskId, round, ws, repo, checkout, profile, service,
    queue: [...(profile.api ? ['api' as const] : []), ...(profile.ui ? ['ui' as const] : [])],
    current: null, verification: v, release,
  };
  active.set(taskId, a);
  save(taskId, round, v);
  await startNext(host, a);
}

async function serviceDidNotStart(
  host: VerifyHost, taskId: string, round: number, ws: WorkspaceRow, profile: RunProfile, failure: ServiceFailure, v: Verification,
  stopEarly: (status: Verification['status'], note: string) => Verification,
): Promise<void> {
  // A profile that cannot be used, or a busy port, has nothing to do with the change.
  const environmental = failure.reason === 'profile' || failure.reason === 'port_in_use';
  // "Also without the change" means: it fails on the task's base commit too.
  const startsOnBase = environmental ? null : await startsWithoutTheChange(ws, profile, round);
  const alsoWithoutTheChange = startsOnBase === null ? null : !startsOnBase;
  v.startFailure = { reason: failure.reason, detail: failure.detail, logTail: failure.logTail, alsoWithoutTheChange };
  if (!environmental && alsoWithoutTheChange === false) {
    stopEarly('failed', 'The service does not start with this change.');
    host.sendBack(taskId, round, verifyFeedback(round, v), verifySummary(v));
    return;
  }
  stopEarly('error', failure.detail);
  const why = environmental
    ? failure.detail
    : alsoWithoutTheChange === true
      ? `${failure.detail} It does not start without this change either, so the run profile (command, port, ready path, environment) needs your attention on the Projects page.`
      : `${failure.detail} Whether it starts without this change could not be checked.`;
  host.handToOwner(taskId, `The change was not verified running. ${why}\n\nThe service printed:\n${failure.logTail.trim().slice(-1500) || '(nothing)'}`);
}

// ─── Testers ──────────────────────────────────────────────────────────────────

/** What earlier rounds' verification sent back, for the tester to check first. */
function earlierFindings(taskId: string, round: number): string | null {
  const parts: string[] = [];
  for (const r of getRounds(taskId).filter((x) => x.round < round)) {
    const v = verificationOf(taskId, r.round);
    if (v?.status === 'failed') parts.push(`Round ${r.round}: ${verifySummary(v)}\n\n${verifyFeedback(r.round, v).split('\n\n').slice(1).join('\n\n')}`);
  }
  return parts.length ? parts.join('\n\n') : null;
}

async function startNext(host: VerifyHost, a: Active): Promise<void> {
  const kind = a.queue.shift();
  if (!kind) {
    const v = await finish(a, 'passed');
    const did = v.testers.map((t) => `${TESTER_NAME[t.kind]}: ${t.calls} ${t.kind === 'api' ? 'request' : 'browser step'}${t.calls === 1 ? '' : 's'}`).join('; ');
    host.approve(a.taskId, a.round, `verified running (${did})`);
    return;
  }
  const { taskId, round, ws, repo, service } = a;
  const cfg = getConfig();
  if (service.hasExited()) {
    const logTail = fs.existsSync(service.logPath) ? fs.readFileSync(service.logPath, 'utf8').slice(-4000) : '';
    a.verification.startFailure = { reason: 'exited', detail: 'The service stopped by itself while it was being tested.', logTail, alsoWithoutTheChange: false };
    const v = await finish(a, 'failed', 'The service stopped while it was being tested.');
    host.sendBack(taskId, round, verifyFeedback(round, v), verifySummary(v));
    return;
  }
  const task = getTask(taskId)!;
  const role = TESTER_ROLE[kind];
  const key = `${taskId}.r${round}.${kind}`;
  const grants = kind === 'api' ? grantsFor(repo.id) : { granted: [], unavailable: [] };
  if (kind === 'api') {
    a.verification.dataConnections = grants.granted.map((g) => g.name);
    a.verification.unavailable = grants.unavailable;
  }
  const mcp =
    kind === 'api'
      ? apiTesterMcp({ key, runsDir: cfg.runsDir, service, granted: grants.granted })
      : uiTesterMcp({
          key, runsDir: cfg.runsDir, service, outputDir: path.join(a.checkout, BROWSER_DIR),
          chromePath: findChrome()!, denyProxyPort: await denyProxyPort(),
        });
  // The workspace row is re-read: the files it lists are from the commit under review.
  const files = JSON.parse(activeWorkspace(taskId)?.files_json ?? '[]') as Array<{ status: string; path: string }>;
  const previous = a.verification.testers.at(-1);
  writeVerifyBrief(a.checkout, {
    kind, taskId, title: task.title, description: task.description, round, plan: host.planOf(task),
    patch: diffPatch(ws.worktree_path, ws.base_sha), files,
    startUrl: `${service.origin}${a.profile.uiPath}`,
    dataConnections: grants.granted.map((g) => ({ name: g.name, envKind: g.envKind, tools: g.tools.map((t) => t.tool) })),
    unavailable: grants.unavailable,
    earlier: earlierFindings(taskId, round),
    before: previous
      ? `The ${TESTER_NAME[previous.kind]} used this same running service before you and found no problem. It may have created or changed data in it.`
      : null,
    ownerNotes: host.ownerNotes(taskId),
  });

  setTaskNote(taskId, `Round ${round}: the ${TESTER_NAME[kind]} is ${kind === 'api' ? 'using the running service' : 'using the pages in a browser'}`);
  let handle: RunHandle | null;
  try {
    handle = await host.startTaskAgent(taskId, { role, round }, {
      taskId,
      role,
      round,
      prompt: `Verify round ${round} of task ${taskId} on the running ${kind === 'api' ? 'service' : 'application'}. Your brief is in FRYDAY_VERIFY/README.md.`,
      appendSystemPrompt: host.guided(PROMPTS[kind], repo, ws),
      jsonSchema: VERIFY_SCHEMA,
      mcp: { configPath: mcp.configPath, tools: mcp.tools },
      cwd: a.checkout,
      workspacePath: a.checkout,
    });
  } catch (err) {
    removeRunMcp(mcp);
    await finish(a, 'error', `The ${TESTER_NAME[kind]} could not be started.`);
    throw err;
  }
  if (!handle) {
    // The task's tokens are used up; a ticket asks the owner. The service does not wait for the answer.
    removeRunMcp(mcp);
    await finish(a, 'error', 'Paused at the token limit before verification finished.');
    return;
  }
  a.current = { kind, runId: handle.runId, mcp, startedAt: Date.now() };
  if (kind === 'ui') watchScreenshots(a);
  save(taskId, round, a.verification);
}

interface TesterRun {
  round: number;
  output_json: string | null;
  tools_json: string | null;
}

/** A tester run ended. Returns false when the run is not part of a verification under way. */
export function onTesterRunExit(host: VerifyHost, exit: RunExit, run: TesterRun): boolean {
  const taskId = exit.taskId!;
  const a = active.get(taskId);
  if (!a || a.current?.runId !== exit.runId) return false;
  const { kind, mcp, startedAt } = a.current;
  a.current = null;
  removeRunMcp(mcp);
  stopWatching(taskId);
  if (kind === 'ui') a.verification.evidence = keepEvidence(a, a.verification.evidence);
  const name = TESTER_NAME[kind];
  const role = TESTER_ROLE[kind];

  void (async () => {
    if (getTask(taskId)?.state !== 'verifying') { await finish(a, 'error', 'The task left verification before it finished.'); return; }
    if (exit.state === 'budget') {
      await finish(a, 'error', `The ${name} reached its token limit.`);
      host.askToContinue(taskId, { role, round: a.round }, 'agent');
      return;
    }
    if (exit.state !== 'completed') {
      // The AI service was busy for a moment: the same tester tries once more on the same running service.
      const retrying = retryWhenBusy(taskId, { state: exit.state, error: exit.error }, { role, round: a.round }, () => {
        if (active.get(taskId) !== a || getTask(taskId)?.state !== 'verifying') return; // stopped in the meantime
        a.queue.unshift(kind);
        startNext(host, a).catch((err) => {
          console.error(`[fryday-core] ${taskId} verification failed:`, err);
          void finish(a, 'error', message(err)).then(() => host.handToOwner(taskId, `Verification failed: ${message(err)}`));
        });
      });
      if (retrying) return;
      await finish(a, 'error', `The ${name} did not finish.`);
      host.handToOwner(taskId, `The ${name} ${exit.state === 'killed' ? 'was stopped' : exit.state === 'timeout' ? 'ran past its time limit' : 'failed'}${exit.error ? `: ${exit.error}` : ''}. Nothing was judged.`);
      return;
    }
    const report = parseVerifyReport(run.output_json);
    const tally = toolTally(run.tools_json);
    const calls = kind === 'api'
      ? tally[SERVICE_REQUEST_TOOL] ?? 0
      : Object.entries(tally).filter(([tool]) => tool.startsWith(BROWSER_TOOL_PREFIX)).reduce((n, [, count]) => n + count, 0);
    const passed = report !== null && calls > 0 && reportPasses(report);
    a.verification.testers.push({ kind, runId: exit.runId, report, calls, passed });
    if (kind === 'ui') a.verification.refused = refusedSince(startedAt);

    if (!report) {
      await finish(a, 'error', `The ${name} did not return a usable report.`);
      host.handToOwner(taskId, `The ${name} did not return a usable report. Nothing was judged.`);
      return;
    }
    if (calls === 0) {
      // A verdict from a tester that never touched the service is an opinion about the code, not a test.
      await finish(a, 'error', `The ${name} reported without using the ${kind === 'api' ? 'service' : 'browser'}.`);
      host.handToOwner(taskId, `The ${name} wrote a report without once using the ${kind === 'api' ? 'running service' : 'browser'}, so nothing was verified. Its report is kept on the round.`);
      return;
    }
    if (!passed) {
      const v = await finish(a, 'failed');
      host.sendBack(taskId, a.round, verifyFeedback(a.round, v), verifySummary(v));
      return;
    }
    if (kind === 'ui') {
      await sizeSweep(a, exit.runId);
      if (active.get(taskId) !== a) return; // stopped while sweeping
      if (sweepBlocking(a.verification.sweep).length) {
        const v = await finish(a, 'failed', 'A page does not fit a phone or tablet screen.');
        host.sendBack(taskId, a.round, verifyFeedback(a.round, v), verifySummary(v));
        return;
      }
    }
    save(taskId, a.round, a.verification);
    await startNext(host, a);
  })().catch((err) => {
    console.error(`[fryday-core] ${taskId} verification failed:`, err);
    void finish(a, 'error', message(err)).then(() => host.handToOwner(taskId, `Verification failed: ${message(err)}`));
  });
  return true;
}
