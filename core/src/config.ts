/**
 * Configuration. Everything has a default that works on a fresh install; each value
 * can be overridden with an environment variable.
 *
 * State lives in one folder, FRYDAY_HOME (default ~/.fryday-code): the database, agent
 * run logs, task worktrees, temp folders, and the secret that protects the local API.
 * Sandboxed agents cannot read that folder.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

export interface Config {
  /** State folder for this install. */
  home: string;
  port: number;
  host: string;
  /** The `claude` CLI that agents run as. */
  claudeBin: string;
  dbPath: string;
  /** Per-run prompt, log, guard policy and settings files. */
  runsDir: string;
  /** One git worktree per task and repo. */
  workspaceDir: string;
  /** Temp folders for sandboxed commands. */
  scratchDir: string;
  /** Neutral working directory for chat runs. */
  conciergeDir: string;
  /** Optional list of projects loaded once into an empty install. */
  seedPath: string;
  /** Where repositories cloned by FryDay Code itself are kept. */
  reposDir: string;
  /** Dependency installs kept for reuse, per project. */
  depsDir: string;
  /** Documents attached to tasks (a PRD, notes). */
  attachmentsDir: string;
  /** What testers leave for the owner to look at (screenshots), per task and round. */
  evidenceDir: string;
  /** Claude Code's own settings file for this user, where its MCP servers are defined. Only read. */
  claudeSettingsPath: string;
  /** Time limit for a dependency install. */
  installTimeoutMs: number;
  /** Time limit per check command. */
  checkTimeoutMs: number;
  /** How long a check waits for memory pressure to ease. */
  memoryWaitMs: number;
  /** ANTHROPIC_API_KEY if set; empty means agents use the claude CLI's own login. */
  apiKey: string;
  /** Protects the local API. Generated on first run and kept in <home>/secret. */
  coreSecret: string;
}

function text(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (isNaN(n)) throw new Error(`${key} must be a whole number, got: ${v}`);
  return n;
}

/** The first `name` found on PATH, or null. */
export function findOnPath(name: string, pathVar = process.env.PATH ?? ''): string | null {
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * The secret for this install: FRYDAY_CORE_SECRET if set, otherwise the one stored in
 * `secretPath`, created on first use and readable only by the developer.
 */
export function loadOrCreateSecret(secretPath: string, fromEnv = process.env.FRYDAY_CORE_SECRET): string {
  if (fromEnv) return fromEnv;
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  try {
    // 'wx': never overwrite. If two processes start at once, one creates it and the other reads it.
    fs.writeFileSync(secretPath, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const secret = fs.readFileSync(secretPath, 'utf8').trim();
  if (secret.length < 32) throw new Error(`${secretPath} does not hold a usable secret; delete it and start again`);
  return secret;
}

export function loadConfig(): Config {
  const home = text('FRYDAY_HOME', path.join(os.homedir(), '.fryday-code'));
  return {
    home,
    port: int('FRYDAY_PORT', 7475),
    host: text('FRYDAY_HOST', '127.0.0.1'),
    claudeBin: text('CLAUDE_BIN', findOnPath('claude') ?? 'claude'),
    dbPath: text('FRYDAY_DB', path.join(home, 'fryday.db')),
    runsDir: text('FRYDAY_RUNS', path.join(home, 'runs')),
    workspaceDir: text('FRYDAY_WORKTREES', path.join(home, 'worktrees')),
    scratchDir: text('FRYDAY_SCRATCH', path.join(home, 'tmp')),
    conciergeDir: text('FRYDAY_CONCIERGE_DIR', path.join(home, 'concierge')),
    seedPath: text('FRYDAY_SEED', path.join(home, 'projects.seed.json')),
    reposDir: text('FRYDAY_REPOS', path.join(home, 'repos')),
    depsDir: text('FRYDAY_DEPS', path.join(home, 'deps')),
    attachmentsDir: text('FRYDAY_ATTACHMENTS', path.join(home, 'attachments')),
    evidenceDir: text('FRYDAY_EVIDENCE', path.join(home, 'evidence')),
    claudeSettingsPath: text('FRYDAY_CLAUDE_SETTINGS', path.join(os.homedir(), '.claude.json')),
    installTimeoutMs: int('FRYDAY_INSTALL_TIMEOUT_MS', 15 * 60_000),
    checkTimeoutMs: int('FRYDAY_CHECK_TIMEOUT_MS', 10 * 60_000),
    memoryWaitMs: int('FRYDAY_MEMORY_WAIT_MS', 10 * 60_000),
    apiKey: text('ANTHROPIC_API_KEY', ''),
    coreSecret: loadOrCreateSecret(path.join(home, 'secret')),
  };
}

// Loaded once per process.
let _config: Config | null = null;
export function getConfig(): Config {
  if (!_config) _config = loadConfig();
  return _config;
}
