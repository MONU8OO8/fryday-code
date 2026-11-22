/**
 * Dependencies for a checkout. In order of preference:
 *   1. already there;
 *   2. a copy-on-write clone of the developer's own node_modules, when both sides ask
 *      for the same packages (checks.ts, bootstrapDeps);
 *   3. a copy of an install FryDay Code kept earlier for the same package files;
 *   4. the project's install command, run in the sandbox with only the package
 *      registries reachable. Package scripts run inside that sandbox: they cannot read
 *      the home folder, write outside the checkout, or reach any other host.
 *
 * Kept installs are trusted only as far as the commit they were made from. An install
 * made on a commit that is already on the remote is shared by every task; one made on
 * a commit an agent wrote is kept for that task alone, so nothing an agent's package
 * scripts did can reach another task or the base-commit comparison.
 *
 * Node projects only for now. Known limit: only the root node_modules is kept, so a
 * workspace-style repo with nested node_modules installs afresh in each checkout.
 */

import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { bootstrapDeps, inHeavySlot, waitForMemory, LOCKFILES } from './checks.js';
import { runSandboxed } from './sandbox.js';
import { git } from './worktrees.js';
import { keepAwake } from '../runner/keepAwake.js';
import { getConfig } from '../config.js';
import { getRepo } from '../registry/registry.js';
import { getSettings } from '../settings.js';

/**
 * none       nothing to install
 * present    node_modules was already in the checkout
 * cloned     cloned from the developer's own copy
 * kept       copied from an earlier install by FryDay Code
 * installed  the install command ran
 * missing    dependencies are needed and there was no way to get them
 * failed     the install command ran and did not succeed
 */
export type DepsStatus = 'none' | 'present' | 'cloned' | 'kept' | 'installed' | 'missing' | 'failed';

export interface DepsResult {
  status: DepsStatus;
  detail: string;
}

export interface EnsureDepsOptions {
  /** The developer's clone, whose node_modules is reused when it fits. */
  ownerRepoPath: string;
  checkoutPath: string;
  installCmd: string | null;
  /** Where this project's installs are kept for reuse. */
  keepDir: string;
  /** Set when the checkout holds a commit an agent wrote: its install is kept for this task only. */
  taskId?: string;
  scratchRoot: string;
  /** Hosts the install may reach. */
  allowedDomains: string[];
  timeoutMs: number;
  memoryWaitMs?: number;
}

/** False when checks on this checkout would fail for lack of dependencies rather than because of the code. */
export function depsUsable(result: DepsResult): boolean {
  return result.status !== 'missing' && result.status !== 'failed';
}

const OUTPUT_TAIL_CHARS = 1500;

function declaresDependencies(checkoutPath: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(checkoutPath, 'package.json'), 'utf8')) as Record<string, unknown>;
    return ['dependencies', 'devDependencies', 'optionalDependencies'].some((k) => {
      const list = pkg[k];
      return !!list && typeof list === 'object' && Object.keys(list).length > 0;
    });
  } catch {
    return true; // unreadable package.json: assume it needs its dependencies
  }
}

function isIgnored(checkoutPath: string): boolean {
  try {
    git(checkoutPath, ['check-ignore', '-q', 'node_modules']);
    return true;
  } catch {
    return false;
  }
}

/** Identifies an install: the same command on the same package files with the same Node gives the same result. */
export function installKey(checkoutPath: string, installCmd: string): string {
  const hash = createHash('sha256');
  hash.update(`${installCmd}\0${process.version}\0${process.arch}\0`);
  for (const file of ['package.json', '.npmrc', ...LOCKFILES]) {
    const full = path.join(checkoutPath, file);
    hash.update(`${file}\0`);
    if (fs.existsSync(full)) hash.update(fs.readFileSync(full));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 32);
}

/** Copy a folder, as an APFS clone where the disk supports it. */
function copyTree(source: string, target: string): void {
  try {
    execFileSync('cp', ['-cR', source, target], { stdio: 'ignore' });
  } catch {
    fs.rmSync(target, { recursive: true, force: true });
    execFileSync('cp', ['-R', source, target], { stdio: 'ignore' });
  }
}

/** Keep `nodeModules` under `keptDir`. Another run may have kept the same install first; then this one is dropped. */
function keep(nodeModules: string, keptDir: string): void {
  if (fs.existsSync(path.join(keptDir, 'node_modules'))) return;
  const staging = `${keptDir}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    fs.mkdirSync(staging, { recursive: true });
    copyTree(nodeModules, path.join(staging, 'node_modules'));
    fs.renameSync(staging, keptDir);
  } catch {
    fs.rmSync(staging, { recursive: true, force: true }); // keeping is an optimisation; the install itself stands
  }
}

/** Put back tracked files the install rewrote (a lockfile, say), so they are not mistaken for the task's changes. */
function restoreTrackedFiles(checkoutPath: string): number {
  try {
    const changed = git(checkoutPath, ['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean);
    if (changed.length > 0) git(checkoutPath, ['checkout', '--', '.']);
    return changed.length;
  } catch {
    return 0;
  }
}

async function install(cmd: string, opts: EnsureDepsOptions, keptDir: string): Promise<DepsResult> {
  const target = path.join(opts.checkoutPath, 'node_modules');
  const release = keepAwake();
  let r;
  try {
    if (opts.memoryWaitMs) await waitForMemory(opts.memoryWaitMs);
    r = await runSandboxed(cmd, {
      workspacePath: opts.checkoutPath,
      scratchRoot: opts.scratchRoot,
      timeoutMs: opts.timeoutMs,
      allowedDomains: opts.allowedDomains,
    });
  } finally {
    release();
  }
  const restored = restoreTrackedFiles(opts.checkoutPath);
  const tail = r.output.trim().slice(-OUTPUT_TAIL_CHARS);
  const fail = (why: string): DepsResult => {
    // A half-finished node_modules would pass for "already there" next time.
    fs.rmSync(target, { recursive: true, force: true });
    return { status: 'failed', detail: `\`${cmd}\` ${why}${tail ? `\n${tail}` : ''}` };
  };
  if (!r.started) return fail('could not be started in the sandbox.');
  if (r.timedOut) return fail(`did not finish within ${Math.round(opts.timeoutMs / 60_000)} minutes.`);
  if (r.exitCode !== 0) return fail(`failed (exit ${r.exitCode}). It may only reach ${opts.allowedDomains.join(', ') || 'no host'}; packages from a private registry or another host cannot be installed this way.`);
  if (!fs.existsSync(target)) return fail('finished without creating node_modules.');

  keep(target, keptDir);
  return {
    status: 'installed',
    detail: `installed with \`${cmd}\` in the sandbox (${Math.round(r.durationMs / 1000)}s)${restored ? `; ${restored} tracked file${restored === 1 ? '' : 's'} it rewrote ${restored === 1 ? 'was' : 'were'} put back` : ''}`,
  };
}

/** Make sure `checkoutPath` has its dependencies, or say exactly why it does not. Never throws for a failing install. */
export async function ensureDeps(opts: EnsureDepsOptions): Promise<DepsResult> {
  const fromOwner = bootstrapDeps(opts.ownerRepoPath, opts.checkoutPath);
  if (fromOwner.status !== 'skipped') return { status: fromOwner.status, detail: fromOwner.detail };
  if (!declaresDependencies(opts.checkoutPath)) return { status: 'none', detail: 'package.json lists no dependencies' };

  const why = `your own clone cannot be reused (${fromOwner.detail})`;
  if (!isIgnored(opts.checkoutPath)) {
    return { status: 'missing', detail: `${why}, and node_modules is not git-ignored in this repo, so FryDay Code will not install into it` };
  }
  const cmd = opts.installCmd?.trim();
  if (!cmd) return { status: 'missing', detail: `${why}, and the project has no install command` };

  const key = installKey(opts.checkoutPath, cmd);
  const shared = path.join(opts.keepDir, 'shared', key);
  const own = opts.taskId ? path.join(opts.keepDir, `task-${opts.taskId}`, key) : shared;

  // One install at a time, and never alongside a test suite.
  return inHeavySlot(async () => {
    for (const kept of new Set([shared, own])) {
      const source = path.join(kept, 'node_modules');
      if (!fs.existsSync(source)) continue;
      copyTree(source, path.join(opts.checkoutPath, 'node_modules'));
      return { status: 'kept' as const, detail: `copied from an earlier install of the same package files (${why})` };
    }
    fs.mkdirSync(path.dirname(own), { recursive: true });
    return install(cmd, opts, own);
  });
}

/** Forget the installs kept for one task. */
export function removeTaskDeps(keepDir: string, taskId: string): void {
  fs.rmSync(path.join(keepDir, `task-${taskId}`), { recursive: true, force: true });
}

// ─── For the pipeline ─────────────────────────────────────────────────────────

export interface CheckoutOwner {
  repoId: string;
  taskId: string;
  /** The developer's clone of the repository. */
  ownerRepoPath: string;
}

export const projectKeepDir = (repoId: string) => path.join(getConfig().depsDir, repoId);

/**
 * Dependencies for one of a task's checkouts, with the project's install command and
 * the current settings. `agentCommit` says whether the checkout holds a commit an agent
 * wrote (the task branch, the merged tree) rather than one already on the remote.
 */
export function depsForCheckout(owner: CheckoutOwner, checkoutPath: string, agentCommit: boolean): Promise<DepsResult> {
  const cfg = getConfig();
  fs.mkdirSync(cfg.scratchDir, { recursive: true });
  return ensureDeps({
    ownerRepoPath: owner.ownerRepoPath,
    checkoutPath,
    installCmd: getRepo(owner.repoId)?.installCmd ?? null,
    keepDir: projectKeepDir(owner.repoId),
    taskId: agentCommit ? owner.taskId : undefined,
    scratchRoot: cfg.scratchDir,
    allowedDomains: getSettings().installDomains,
    timeoutMs: cfg.installTimeoutMs,
    memoryWaitMs: cfg.memoryWaitMs,
  });
}
