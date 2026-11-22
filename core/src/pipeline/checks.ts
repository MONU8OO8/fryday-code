/**
 * Checks — the repo's own test, lint and typecheck commands, run by core in the
 * sandbox. Exit codes decide; no agent's opinion can turn a red check green.
 *
 * Real repos are often already red on their production branch. So a failing check is
 * run on the task's base commit too, and the two are compared by WHICH things fail
 * (test names, type errors): only failures that are new with the task block it. When
 * the output is not one this file can read failures from, the comparison falls back to
 * the exit code, and a check that was already failing cannot block (it is reported).
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { runSandboxed } from './sandbox.js';
import { git } from './worktrees.js';
import { keepAwake } from '../runner/keepAwake.js';

export type CheckName = 'test' | 'lint' | 'typecheck';
/**
 * passed       exit code 0
 * failed       the command ran and failed (and, if it also fails on the base, has new failures)
 * preexisting  it fails, but with nothing the base commit did not already have
 * timeout      it ran past its time limit
 * error        it could not be run at all (the sandbox did not start) — never excused
 */
export type CheckStatus = 'passed' | 'failed' | 'preexisting' | 'timeout' | 'error';

export interface CheckSpec {
  name: CheckName;
  cmd: string;
}

export interface CheckResult extends CheckSpec {
  status: CheckStatus;
  exitCode: number | null;
  durationMs: number;
  output: string;
  /** What failed, as far as it could be read from the output (test names, type errors). */
  failures?: string[];
  /** Failures that the base commit does not have. Set when the check also fails on the base. */
  newFailures?: string[];
  /** How a check that fails on both sides was compared with the base commit. */
  comparedBy?: 'failures' | 'exit-code';
}

export interface RepoCommands {
  testCmd: string | null;
  lintCmd: string | null;
  typecheckCmd: string | null;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

const MAX_FAILURES = 3000;
const MAX_FAILURE_LINE_CHARS = 1000;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const FAILURE_PATTERNS: Array<{ re: RegExp; sig: (m: RegExpMatchArray) => string }> = [
  // jest / vitest: "FAIL  path/to/suite" and "● Suite › test name"
  { re: /^\s*FAIL\s+(\S+)/, sig: (m) => `suite ${m[1]}` },
  { re: /^\s*● (?!Console\b)(.+?)\s*$/, sig: (m) => `test ${m[1]}` },
  // node:test, TAP and spec reporters
  { re: /^\s*not ok \d+ -? ?(.+?)\s*$/, sig: (m) => `test ${m[1]}` },
  { re: /^\s*✖ (.+?)(?: \([\d.]+ ?m?s\))?\s*$/, sig: (m) => `test ${m[1]}` },
  // pytest and go test
  { re: /^(?:FAILED|ERROR) (\S+)/, sig: (m) => `test ${m[1]}` },
  { re: /^\s*--- FAIL: (\S+)/, sig: (m) => `test ${m[1]}` },
  // tsc: "file(line,col): error TS1234: message" — line and column move with edits, so they are left out
  { re: /^(.+?)\(\d+,\d+\): error (TS\d+): (.+?)\s*$/, sig: (m) => `type ${m[1]}: ${m[2]}: ${m[3]}` },
];

/** The distinct failures named in a check's output, in the order first seen. */
export function failureSignatures(output: string): string[] {
  const seen = new Set<string>();
  for (const line of output.replace(ANSI, '').split('\n')) {
    // Failure lines are short. Skipping long ones (dumped JSON, minified code) keeps this fast.
    if (line.length > MAX_FAILURE_LINE_CHARS) continue;
    for (const { re, sig } of FAILURE_PATTERNS) {
      const m = line.match(re);
      if (m) {
        seen.add(sig(m));
        break;
      }
    }
    if (seen.size >= MAX_FAILURES) break;
  }
  return [...seen];
}

/**
 * Decide the status of a check that fails on the task branch, given the same check on
 * the base commit. Pure; `head` is returned with its status and comparison filled in.
 */
export function compareWithBase(head: CheckResult, base: CheckResult): CheckResult {
  // A check that could not be run proves nothing, on either side. "It also fails on the
  // base" is only an excuse when the check really ran there.
  if (head.status === 'error') return head;
  if (base.status === 'error') return { ...head, status: 'error', output: `The same check could not be run on the base commit, so old and new failures cannot be told apart.\n\n${base.output}` };
  if (!isBlocking(base)) return head; // passes on the base: the task broke it
  const headFailures = head.failures ?? [];
  const baseFailures = new Set(base.failures ?? []);
  if (headFailures.length > 0 && baseFailures.size > 0) {
    const newFailures = headFailures.filter((f) => !baseFailures.has(f));
    return { ...head, comparedBy: 'failures', newFailures, status: newFailures.length > 0 ? 'failed' : 'preexisting' };
  }
  return { ...head, comparedBy: 'exit-code', status: 'preexisting' };
}

export function checkSpecs(repo: RepoCommands): CheckSpec[] {
  const specs: Array<[CheckName, string | null]> = [
    ['typecheck', repo.typecheckCmd],
    ['lint', repo.lintCmd],
    ['test', repo.testCmd],
  ];
  return specs.flatMap(([name, cmd]) => (cmd && cmd.trim() ? [{ name, cmd: cmd.trim() }] : []));
}

/** The result of a check that was not run, with the reason. It blocks like any other check that could not run. */
export function cannotRun(spec: CheckSpec, why: string): CheckResult {
  return { ...spec, status: 'error', exitCode: null, durationMs: 0, output: why };
}

/** True when a result should stop the task. */
export function isBlocking(result: CheckResult): boolean {
  return result.status === 'failed' || result.status === 'timeout' || result.status === 'error';
}

// One check command at a time: builds and test suites are the heavy part of a task.
let heavySlot: Promise<unknown> = Promise.resolve();
export function inHeavySlot<T>(work: () => Promise<T>): Promise<T> {
  const next = heavySlot.then(work, work);
  heavySlot = next.catch(() => undefined);
  return next;
}

export interface RunCheckOptions {
  workspacePath: string;
  scratchRoot: string;
  timeoutMs?: number;
  /**
   * How long to hold a check back while the Mac is short of memory. A test suite
   * started on a swapping machine runs many times slower and makes everything else
   * worse. After this long it runs anyway. 0 (the default) never waits.
   */
  memoryWaitMs?: number;
}

const MEMORY_POLL_MS = 10_000;

/**
 * Linux pressure stall information (/proc/pressure/memory) in macOS's levels. "some" is
 * the share of the last 10 seconds in which at least one task waited for memory, "full"
 * the share in which every task did. Null when the text is not PSI.
 */
export function memoryPressureFromPsi(text: string): number | null {
  const avg10 = (kind: 'some' | 'full') => {
    const m = text.match(new RegExp(`^${kind}\\s.*\\bavg10=([0-9.]+)`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const some = avg10('some');
  if (some === null || !Number.isFinite(some)) return null;
  const full = avg10('full') ?? 0;
  if (full >= 10 || some >= 40) return 4;
  if (full >= 2 || some >= 10) return 2;
  return 1;
}

/** Memory pressure: 1 normal, 2 warning, 4 critical (macOS's own levels; mapped from PSI on Linux). Null where it cannot be read. */
export function memoryPressureLevel(platform: string = process.platform, readPsi: () => string = () => fs.readFileSync('/proc/pressure/memory', 'utf8')): number | null {
  try {
    if (platform === 'linux') return memoryPressureFromPsi(readPsi());
    if (platform !== 'darwin') return null;
    const level = Number(execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8' }).trim());
    return Number.isFinite(level) ? level : null;
  } catch {
    return null;
  }
}

/** Wait until memory pressure is normal, or until `maxWaitMs` has passed. Returns how long it waited. */
export async function waitForMemory(maxWaitMs: number, level: () => number | null = memoryPressureLevel, pollMs = MEMORY_POLL_MS): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const now = level();
    if (now === null || now <= 1) break;
    await new Promise((r) => setTimeout(r, Math.min(pollMs, maxWaitMs - (Date.now() - started))));
  }
  return Date.now() - started;
}

export function runCheck(spec: CheckSpec, opts: RunCheckOptions): Promise<CheckResult> {
  return inHeavySlot(async () => {
    const release = keepAwake();
    let r;
    try {
      if (opts.memoryWaitMs) await waitForMemory(opts.memoryWaitMs);
      r = await runSandboxed(spec.cmd, {
        workspacePath: opts.workspacePath,
        scratchRoot: opts.scratchRoot,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } finally {
      release();
    }
    const status: CheckStatus = !r.started ? 'error' : r.timedOut ? 'timeout' : r.exitCode === 0 ? 'passed' : 'failed';
    const failures = status === 'failed' || status === 'timeout' ? failureSignatures(r.fullOutput) : undefined;
    return { ...spec, status, exitCode: r.exitCode, durationMs: r.durationMs, output: r.output, ...(failures ? { failures } : {}) };
  });
}

export interface RunChecksOptions extends RunCheckOptions {
  specs: CheckSpec[];
  /** Runs the same check on the base commit; only called for checks that fail. */
  baseline?: (spec: CheckSpec) => Promise<CheckResult>;
}

export async function runChecks(opts: RunChecksOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const spec of opts.specs) {
    const result = await runCheck(spec, opts);
    results.push(isBlocking(result) && opts.baseline ? compareWithBase(result, await opts.baseline(spec)) : result);
  }
  return results;
}

export interface BootstrapResult {
  status: 'cloned' | 'present' | 'none' | 'skipped';
  detail: string;
}

/**
 * Give a checkout its dependencies by cloning the owner's node_modules (copy-on-write,
 * so the owner's copy cannot be changed through it). Only when the lockfile is the same
 * on both sides; installing from the network would run package scripts unsandboxed.
 */
export function bootstrapDeps(ownerRepoPath: string, checkoutPath: string): BootstrapResult {
  if (!fs.existsSync(path.join(checkoutPath, 'package.json'))) return { status: 'none', detail: 'no package.json' };
  const target = path.join(checkoutPath, 'node_modules');
  if (fs.existsSync(target)) return { status: 'present', detail: 'node_modules already there' };
  const source = path.join(ownerRepoPath, 'node_modules');
  if (!fs.existsSync(source)) return { status: 'skipped', detail: "the owner's copy has no node_modules" };

  // The owner's node_modules fits this checkout only if both sides ask for the same
  // dependencies: the lockfile when the repo tracks one, else package.json's own lists.
  const lockfile = LOCKFILES.find((f) => fs.existsSync(path.join(checkoutPath, f)));
  let basis: string;
  if (lockfile) {
    const ownerLock = path.join(ownerRepoPath, lockfile);
    if (!fs.existsSync(ownerLock) || !fs.readFileSync(ownerLock).equals(fs.readFileSync(path.join(checkoutPath, lockfile)))) {
      return { status: 'skipped', detail: `${lockfile} differs from the owner's copy` };
    }
    basis = `${lockfile} matches`;
  } else {
    const mine = dependencyLists(path.join(checkoutPath, 'package.json'));
    if (mine === null || mine !== dependencyLists(path.join(ownerRepoPath, 'package.json'))) {
      return { status: 'skipped', detail: "package.json dependencies differ from the owner's copy" };
    }
    basis = 'no lockfile; package.json dependencies match';
  }
  try {
    git(checkoutPath, ['check-ignore', '-q', 'node_modules']);
  } catch {
    return { status: 'skipped', detail: 'node_modules is not git-ignored in this repo' };
  }

  try {
    execFileSync('cp', ['-cR', source, target], { stdio: 'ignore' }); // APFS clone
  } catch {
    fs.rmSync(target, { recursive: true, force: true });
    execFileSync('cp', ['-R', source, target], { stdio: 'ignore' });
  }
  return { status: 'cloned', detail: `cloned from the owner's copy (${basis})` };
}

/** The dependency sections of a package.json as one comparable string, or null if unreadable. */
function dependencyLists(packageJsonPath: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
    return JSON.stringify(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].map((k) => pkg[k] ?? null));
  } catch {
    return null;
  }
}
