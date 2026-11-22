/**
 * Supervisor — starts `claude -p` agents and follows them to the end.
 *
 * How a run survives a core restart:
 *   - The agent is spawned detached, with its prompt on stdin from a file and its
 *     stdout appended to <state folder>/runs/<id>.jsonl. It holds no pipe to core, so it
 *     keeps running when core stops.
 *   - Core follows the log by byte offset and stores that offset with the run. After a
 *     restart, reconcileRunsOnStartup() continues from the stored offset: nothing is
 *     lost and nothing is processed twice. A run that finished while core was down is
 *     completed from its log.
 *
 * The prompt goes in through stdin, never argv, so text that looks like a CLI flag
 * cannot be read as one.
 */

import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDb, nowMs } from '../db/db.js';
import { getConfig } from '../config.js';
import { ROLE_POLICIES, type AgentRole } from '../guard/policy.js';
import type { McpRule } from '../guard/runGuard.js';
import { runnerFor, type AgentRunner, type NormalizeContext } from './runners.js';
import { countedTokens, getRunUsage, recordAssistantUsage, recordResultUsage } from './usage.js';
import { readFrom, takeCompleteLines, tailText } from './logTail.js';
import { summarizeEvent } from './runEvents.js';
import type { ClaudeAssistantEvent, ClaudeEvent, ClaudeInitEvent, ClaudeResultEvent } from './streamParser.js';
import { sseEmit } from '../api/events.js';
import { keepAwake } from './keepAwake.js';
import { getSettings, runSettingsFor } from '../settings.js';

const POLL_MS = 250;
/** How the claude CLI marks a run that stopped at --max-budget-usd (the hidden safety cap below). */
const BUDGET_STOP = 'error_max_budget_usd';
const TOKEN_STOP_MSG = 'stopped: it reached its token limit';

/**
 * A money cap handed to an engine that can stop itself at one. It is only a backstop far
 * above any token limit: limits are set and shown in tokens, and core enforces them for
 * every engine. Never shown anywhere.
 */
function safetyCapUsd(): number {
  const n = Number(process.env.FRYDAY_RUN_USD_CAP ?? 25);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

export interface RunOptions {
  taskId: string | null;
  role: AgentRole;
  round?: number;
  prompt: string;
  /** Override the model from Settings for this run. */
  model?: string;
  /** Most tokens this run may use (counted tokens). Defaults to the role's limit in Settings; never raised above it. */
  maxTokens?: number;
  /** Stop the run after this long. Defaults to the role's time limit in Settings; never raised above it. */
  timeoutMs?: number;
  /** Text appended to the agent's system prompt. */
  appendSystemPrompt?: string;
  /**
   * MCP servers for this run: a config file core wrote, and the tools from it the agent
   * may call. Without it the agent gets no MCP server at all.
   */
  mcp?: { configPath: string; tools: Record<string, McpRule> };
  /** Continue a previous claude session. */
  resumeSessionId?: string;
  /** Make the agent answer with JSON matching this schema; stored in runs.output_json. */
  jsonSchema?: Record<string, unknown>;
  /** Extra environment for the agent process. */
  extraEnv?: Record<string, string>;
  /** Which program runs the agent. Default: the one Settings names for the role. */
  engine?: string;
  /** Working directory for the agent process. */
  cwd: string;
  /**
   * Confine the agent to this directory (guard hook, file-tool limits, OS sandbox).
   * Required for every role that has tools; such a run is refused without it.
   */
  workspacePath?: string;
}

export interface RunExit {
  runId: string;
  taskId: string | null;
  role: string;
  state: string;
  error: string | null;
}

type RunExitListener = (exit: RunExit) => void;
const exitListeners: RunExitListener[] = [];

/**
 * Be told when a run has ended. Register at startup: runs picked up again after a
 * core restart report here too, so a listener must work from stored state only.
 */
export function onRunExit(listener: RunExitListener): void {
  exitListeners.push(listener);
}

/** The only variables an agent inherits. Everything else in core's environment stays out. */
const INHERITED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR'];

function agentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // With no API key the claude CLI uses its own login, so the variable is simply absent.
  const apiKey = getConfig().apiKey;
  if (apiKey) env['ANTHROPIC_API_KEY'] = apiKey;
  return { ...env, ...extra };
}

export interface RunHandle {
  runId: string;
  logPath: string;
}

/** A run was asked for with no tokens left to give it. */
export class BudgetError extends Error {
  constructor(public readonly role: string) {
    super(`No tokens left for the ${role} agent`);
  }
}

export class CapacityError extends Error {
  constructor(public readonly active: number, public readonly max: number) {
    super(`All ${max} agent slots are in use`);
  }
}

interface FollowedRun {
  id: string;
  taskId: string | null;
  role: string;
  pid: number | null;
  logPath: string;
  offset: number;
  /** When the run is stopped for taking too long. Null: no limit recorded. */
  deadlineAt: number | null;
  /** Most counted tokens the run may use. Null: no limit recorded, or it was already stopped for it. */
  tokenLimit: number | null;
  timer: NodeJS.Timeout;
  /** Lets the Mac sleep again once this run is no longer followed. */
  releaseAwake: () => void;
  runner: AgentRunner;
  ctx: NormalizeContext;
  /** Removes what the runner made for this run (a throwaway home, a sandbox profile). */
  cleanup: () => void;
}

const followed = new Map<string, FollowedRun>();

// ─── Start ────────────────────────────────────────────────────────────────────

/** Start an agent. Returns as soon as the process is spawned. */
export function startRun(opts: RunOptions): RunHandle {
  const cfg = getConfig();
  const maxAgents = getSettings().maxAgents;
  if (followed.size >= maxAgents) throw new CapacityError(followed.size, maxAgents);
  const limits = runSettingsFor(opts.role, opts.round ?? 0);
  const model = opts.model ?? limits.model;
  const tokenLimit = Math.floor(Math.min(limits.tokenLimit, opts.maxTokens ?? limits.tokenLimit));
  if (!(tokenLimit > 0)) throw new BudgetError(opts.role);
  const budgetUsd = safetyCapUsd();
  const timeoutMs = Math.min(limits.timeoutMs, opts.timeoutMs ?? limits.timeoutMs);

  const hasTools = ROLE_POLICIES[opts.role].allowedTools.length > 0;
  if (hasTools && !opts.workspacePath) {
    throw new Error(`A ${opts.role} agent has tools and must be confined to a workspace`);
  }

  const runId = `run-${randomUUID()}`;
  fs.mkdirSync(cfg.runsDir, { recursive: true });
  fs.mkdirSync(opts.cwd, { recursive: true });
  const logPath = path.join(cfg.runsDir, `${runId}.jsonl`);
  const promptPath = path.join(cfg.runsDir, `${runId}.prompt.txt`);
  fs.writeFileSync(promptPath, opts.prompt, { mode: 0o600 });

  // The runner decides how the agent is started; a role it may not run is refused here.
  const runner = runnerFor(opts.engine ?? limits.engine);
  if (!runner.caps.roles.includes(opts.role)) throw new Error(`${runner.label} is not used for the ${opts.role}`);
  const ready = runner.available();
  if (!ready.ok) throw new Error(`${runner.label} cannot run: ${ready.why}`);
  const runModel = runner.id === 'cursor' ? limits.cursorModel : model;
  const prepared = runner.prepare({
    runId, role: opts.role, model: runModel, effort: limits.effort, budgetUsd, prompt: opts.prompt, appendSystemPrompt: opts.appendSystemPrompt,
    jsonSchema: opts.jsonSchema, resumeSessionId: opts.resumeSessionId, workspacePath: opts.workspacePath, mcp: opts.mcp,
    stdioFiles: [promptPath, logPath, stderrPath(logPath)],
  });
  fs.writeFileSync(promptPath, prepared.stdinText, { mode: 0o600 });

  // The core API secret is not in the inherited list, so it never reaches an agent.
  const env = agentEnv({
    FRYDAY_RUN_ID: runId,
    FRYDAY_TASK_ID: opts.taskId ?? '',
    FRYDAY_ROLE: opts.role,
    ...opts.extraEnv,
    ...prepared.env,
  });

  const db = getDb();
  db.prepare(`
    INSERT INTO runs (id, task_id, role, round, state, pid, log_path, log_offset, started_at, deadline_at, token_limit, engine, wants_json)
    VALUES (?, ?, ?, ?, 'running', NULL, ?, 0, ?, ?, ?, ?, ?)
  `).run(runId, opts.taskId, opts.role, opts.round ?? 0, logPath, nowMs(), nowMs() + timeoutMs, tokenLimit, runner.id, opts.jsonSchema ? 1 : 0);

  const stdin = fs.openSync(promptPath, 'r');
  const stdout = fs.openSync(logPath, 'a');
  const stderr = fs.openSync(stderrPath(logPath), 'a');
  let pid: number | undefined;
  try {
    const proc = spawn(prepared.bin, prepared.args, {
      cwd: opts.cwd,
      env,
      stdio: [stdin, stdout, stderr],
      detached: true,
    });
    pid = proc.pid;
    proc.on('error', (err) => finalize(runId, `could not start agent: ${err.message}`));
    proc.on('exit', (code) => {
      db.prepare(`UPDATE runs SET exit_code = ? WHERE id = ?`).run(code, runId);
    });
    proc.unref();
  } finally {
    fs.closeSync(stdin);
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }

  db.prepare(`UPDATE runs SET pid = ? WHERE id = ?`).run(pid ?? null, runId);
  sseEmit({ type: 'run_started', runId, taskId: opts.taskId, role: opts.role });
  follow({ id: runId, taskId: opts.taskId, role: opts.role, pid: pid ?? null, logPath, offset: 0, deadlineAt: nowMs() + timeoutMs, tokenLimit, runner, ctx: { wantsJson: opts.jsonSchema !== undefined, seq: 0 }, cleanup: prepared.cleanup });

  return { runId, logPath };
}

// ─── Follow ───────────────────────────────────────────────────────────────────

function follow(run: Omit<FollowedRun, 'timer' | 'releaseAwake'>): void {
  const entry: FollowedRun = {
    ...run,
    timer: setInterval(() => tick(entry), POLL_MS),
    releaseAwake: keepAwake(),
  };
  followed.set(run.id, entry);
}

function tick(run: FollowedRun): void {
  // Check liveness first, then read: output written just before exit is still picked up.
  const alive = run.pid !== null && isPidAlive(run.pid);
  drain(run);
  if (alive && run.deadlineAt !== null && nowMs() > run.deadlineAt) {
    // A hung agent would otherwise hold its slot forever.
    getDb().prepare(`
      UPDATE runs SET state = 'timeout', ended_at = ?, error_msg = 'stopped: it ran past its time limit'
      WHERE id = ? AND state = 'running'
    `).run(nowMs(), run.id);
    signalRun(run.pid!);
    run.deadlineAt = null; // signal once; the next ticks see the process end
    return;
  }
  if (!alive) {
    drain(run);
    finalize(run.id, null);
  }
}

/** Process every complete line written since the stored offset. */
function drain(run: FollowedRun): void {
  const { lines, consumed } = takeCompleteLines(readFrom(run.logPath, run.offset));
  if (consumed === 0) return;
  for (const line of lines) handleLine(run, line);
  run.offset += consumed;
  getDb().prepare(`UPDATE runs SET log_offset = ? WHERE id = ?`).run(run.offset, run.id);
}

function handleLine(run: FollowedRun, line: string): void {
  for (const event of run.runner.normalize(line, run.ctx)) handleEvent(run, event);
}

function handleEvent(run: FollowedRun, event: ClaudeEvent): void {
  const e = event as Record<string, unknown>;
  const db = getDb();

  if (e['type'] === 'system' && e['subtype'] === 'init') {
    const init = event as ClaudeInitEvent;
    db.prepare(`UPDATE runs SET session_id = ?, model = ? WHERE id = ?`).run(init.session_id, init.model, run.id);
  } else if (e['type'] === 'assistant') {
    recordAssistantUsage(run.id, run.taskId, event as ClaudeAssistantEvent);
    countToolCalls(run.id, event as ClaudeAssistantEvent);
    stopAtTokenLimit(run);
  } else if (e['type'] === 'result') {
    const result = event as ClaudeResultEvent;
    recordResultUsage(run.id, run.taskId, result);
    // A run core already stopped (token or time limit, or the owner) keeps that state and reason.
    db.prepare(`
      UPDATE runs SET error_msg = CASE WHEN state = 'running' THEN ? ELSE error_msg END,
                      state = CASE WHEN state = 'running' THEN ? ELSE state END,
                      ended_at = COALESCE(ended_at, ?), result_text = ?, output_json = ?
      WHERE id = ?
    `).run(
      result.subtype === BUDGET_STOP ? 'stopped: it reached its safety limit'
        : result.is_error ? String(result.result ?? 'agent reported an error').slice(0, 1000) : null,
      // Stopping at a limit is not a failure of the work; the owner decides whether to go on.
      result.subtype === BUDGET_STOP ? 'budget' : result.is_error ? 'failed' : 'completed',
      nowMs(),
      typeof result.result === 'string' ? result.result : null,
      result.structured_output !== undefined ? JSON.stringify(result.structured_output) : null,
      run.id
    );
  }

  const summary = summarizeEvent(event);
  if (summary) sseEmit({ type: 'run_event', runId: run.id, taskId: run.taskId, role: run.role, ...summary });
}

/**
 * Core's own token limit, the same for every engine: once the run has used more counted
 * tokens than it was given, it is marked 'budget' and stopped, once (like the time limit).
 */
function stopAtTokenLimit(run: FollowedRun): void {
  if (run.tokenLimit === null) return;
  if (countedTokens(getRunUsage(run.id)) <= run.tokenLimit) return;
  getDb().prepare(`
    UPDATE runs SET state = 'budget', ended_at = ?, error_msg = ?
    WHERE id = ? AND state = 'running'
  `).run(nowMs(), TOKEN_STOP_MSG, run.id);
  run.tokenLimit = null; // signal once; the next ticks see the process end
  if (run.pid !== null) signalRun(run.pid);
}

/** Keep a tally of which tools the agent called. What a tester claims is checked against it. */
function countToolCalls(runId: string, event: ClaudeAssistantEvent): void {
  const names = (event.message?.content ?? []).flatMap((c) => (c.type === 'tool_use' ? [c.name] : []));
  if (names.length === 0) return;
  const db = getDb();
  const row = db.prepare('SELECT tools_json FROM runs WHERE id = ?').get(runId) as { tools_json: string | null } | undefined;
  const tally = toolTally(row?.tools_json ?? null);
  for (const name of names) tally[name] = (tally[name] ?? 0) + 1;
  db.prepare('UPDATE runs SET tools_json = ? WHERE id = ?').run(JSON.stringify(tally), runId);
}

/** How many times a run called each tool. */
export function toolTally(toolsJson: string | null): Record<string, number> {
  if (!toolsJson) return {};
  try {
    const value = JSON.parse(toolsJson) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** The process is gone. A run still marked running at this point never produced a result. */
function finalize(runId: string, startError: string | null): void {
  const run = followed.get(runId);
  if (!run) return;
  clearInterval(run.timer);
  run.releaseAwake();
  followed.delete(runId);
  try { run.cleanup(); } catch { /* best effort */ }

  const db = getDb();
  const reason =
    startError ?? (tailText(stderrPath(run.logPath), 500) || 'agent exited without a result');
  db.prepare(`
    UPDATE runs SET error_msg = CASE WHEN state = 'running' THEN ? ELSE error_msg END,
                    state = CASE WHEN state = 'running' THEN 'failed' ELSE state END,
                    ended_at = COALESCE(ended_at, ?)
    WHERE id = ?
  `).run(reason, nowMs(), runId);

  const row = db.prepare(`SELECT state, error_msg FROM runs WHERE id = ?`).get(runId) as
    | { state: string; error_msg: string | null }
    | undefined;
  const exit: RunExit = {
    runId,
    taskId: run.taskId,
    role: run.role,
    state: row?.state ?? 'failed',
    error: row?.error_msg ?? null,
  };
  sseEmit({ type: 'run_exit', ...exit });
  for (const listener of exitListeners) {
    try {
      listener(exit);
    } catch (err) {
      console.error(`[fryday-core] run exit listener failed for ${runId}:`, err);
    }
  }
}

// ─── Restart recovery ─────────────────────────────────────────────────────────

/**
 * Called once at startup. Every run still marked running is followed again from its
 * stored offset; if its process is gone, the rest of its log is read and it is closed.
 */
export function reconcileRunsOnStartup(): void {
  const rows = getDb()
    .prepare(`SELECT id, task_id, role, pid, log_path, log_offset, deadline_at, token_limit, engine, wants_json FROM runs WHERE state = 'running'`)
    .all() as Array<{
      id: string; task_id: string | null; role: string; pid: number | null; log_path: string; log_offset: number; deadline_at: number | null;
      token_limit: number | null; engine: string | null; wants_json: number | null;
    }>;

  for (const r of rows) {
    const runner = runnerFor(r.engine);
    // A pid can be reused by an unrelated process after a reboot; only trust it if it is still the agent's program.
    const pid = r.pid !== null && isPidAlive(r.pid) && isAgentProcess(r.pid, runner.processMarker) ? r.pid : null;
    follow({
      id: r.id, taskId: r.task_id, role: r.role, pid, logPath: r.log_path, offset: r.log_offset, deadlineAt: r.deadline_at,
      tokenLimit: r.token_limit, runner, ctx: { wantsJson: r.wants_json === 1, seq: 0 }, cleanup: () => undefined,
    });
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isAgentProcess(pid: number, marker: string): boolean {
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return command.includes(marker) || command.includes('sandbox-runtime');
  } catch {
    return false;
  }
}

function stderrPath(logPath: string): string {
  return logPath.replace(/\.jsonl$/, '.stderr.log');
}

// ─── Control ──────────────────────────────────────────────────────────────────

function signalRun(pid: number): void {
  try {
    // The agent leads its own process group, so this also stops anything it started.
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

/** Stop a run. Returns false if it is not running. */
export function killRun(runId: string): boolean {
  const run = followed.get(runId);
  if (!run || run.pid === null) return false;
  getDb().prepare(`
    UPDATE runs SET state = 'killed', ended_at = ?, error_msg = 'stopped by owner'
    WHERE id = ? AND state = 'running'
  `).run(nowMs(), runId);
  signalRun(run.pid);
  return true;
}

/** Runs core is currently following (running, or just finished and being closed). */
export function activeRunIds(): string[] {
  return Array.from(followed.keys());
}

/** Stop following every run without touching the agents. For tests and shutdown. */
export function stopFollowing(): void {
  for (const run of followed.values()) {
    clearInterval(run.timer);
    run.releaseAwake();
  }
  followed.clear();
}
