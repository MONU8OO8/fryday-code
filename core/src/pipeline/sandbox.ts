/**
 * Running a command inside the OS sandbox, for commands core itself starts on code an
 * agent has edited (tests, lint, typecheck). Uses Anthropic's sandbox runtime — the
 * same sandbox the agents' own shells run in — with the same limits:
 *   - writes only inside the workspace and a private temp folder;
 *   - the home folder unreadable, apart from the workspace and the Node install;
 *   - no network at all, unless the caller names the hosts a command may reach
 *     (dependency installs name the package registries).
 *
 * The command gets a throwaway HOME, so tools that keep caches or read rc files in the
 * home folder work without seeing the owner's.
 */

import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { nestedSandbox } from '../platform.js';

export interface SandboxedOptions {
  /** The only directory the command may write to (besides its temp folder). */
  workspacePath: string;
  /** Where per-command settings and temp folders are created. Must not be inside the workspace. */
  scratchRoot: string;
  timeoutMs: number;
  /** Extra environment. Core's own environment is never passed through. */
  env?: Record<string, string>;
  /** Extra folders the command may read (they stay read-only). */
  extraReadPaths?: string[];
  /** Hosts the command may reach. Default: none. */
  allowedDomains?: string[];
  /**
   * Let the command listen on a port and talk to other ports on this machine. For a
   * service under test only: it still cannot reach any other machine.
   */
  localNetwork?: boolean;
}

export interface SandboxedResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Combined stdout and stderr; only the last part is kept when it is long. */
  output: string;
  /** The same output with far more kept (up to a few MB), for reading results out of it. */
  fullOutput: string;
  /**
   * Whether the command actually began inside the sandbox. False means the sandbox (or
   * the process) could not start, so the exit code says nothing about the code under test.
   */
  started: boolean;
}

const MAX_OUTPUT_CHARS = 12_000;
const MAX_FULL_OUTPUT_CHARS = 4_000_000;
const KILL_GRACE_MS = 3000;
const INHERITED_ENV = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'];

/**
 * Every process below `rootPid`, found before anything is killed (a child whose parent
 * has died is re-parented and can no longer be found from the root).
 */
export function processTree(rootPid: number): number[] {
  let table: string;
  try {
    // -A -o: every process, on macOS and on Linux (procps) alike.
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [rootPid];
  }
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const all: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    all.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return all;
}

/** Stop a command and everything it started, whatever process group those ended up in. */
export function killTree(rootPid: number): void {
  const pids = processTree(rootPid);
  try { process.kill(-rootPid, 'SIGKILL'); } catch { /* no such group */ }
  for (const pid of pids.reverse()) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function srtCli(): string {
  const pkg = require.resolve('@anthropic-ai/sandbox-runtime/package.json');
  return path.join(path.dirname(pkg), 'dist', 'cli.js');
}

function srtPkgDir(): string {
  return path.dirname(require.resolve('@anthropic-ai/sandbox-runtime/package.json'));
}

function nodeInstallDir(): string {
  return path.dirname(path.dirname(fs.realpathSync(process.execPath)));
}

export function sandboxSettings(workspacePath: string, tmpDir: string, extraReadPaths: string[] = [], allowedDomains: string[] = [], localNetwork = false): Record<string, unknown> {
  return {
    network: { allowedDomains, deniedDomains: [], ...(localNetwork ? { allowLocalBinding: true } : {}) },
    filesystem: {
      // An absolute path: this runtime does not expand a bare "~/" (verified by test).
      denyRead: [os.homedir()],
      // The srt package directory must be readable so the apply-seccomp binary (vendor/seccomp/)
      // is accessible from inside the bubblewrap sandbox on Linux. Without this, when the project
      // lives under the home directory (e.g. on GitHub Actions where HOME=/home/runner), the
      // denyRead on the home directory hides the binary and bwrap cannot execute it.
      allowRead: [workspacePath, tmpDir, nodeInstallDir(), srtPkgDir(), ...extraReadPaths],
      allowWrite: [workspacePath, tmpDir],
      denyWrite: [],
    },
    // On Linux CI, apply-seccomp's nested user+PID namespace setup fails even with
    // kernel.apparmor_restrict_unprivileged_userns=0. Skip the seccomp layer; bwrap
    // still enforces all filesystem and network restrictions. Unix-socket blocking
    // (the only thing the seccomp layer adds) is not tested by npm test.
    ...(process.platform === 'linux' && process.env['CI'] === '1' ? { allowAllUnixSockets: true } : {}),
    // Docker only: see platform.ts.
    ...nestedSandbox(),
  };
}

export interface SandboxedProcess {
  /** The sandbox runtime's process; the command and everything it starts are below it. */
  pid: number;
  /** Resolves when the process has ended, with its exit code (null when it was killed). */
  exited: Promise<number | null>;
  /** Stop the command and everything it started, and remove its temp folder. */
  stop(): Promise<void>;
}

/**
 * Start a long-running command in the sandbox and return at once. Core copies its
 * output to `logPath`. Used for a service under test, which does not outlive core.
 */
export function startSandboxed(command: string, opts: Omit<SandboxedOptions, 'timeoutMs'> & { logPath: string }): SandboxedProcess {
  const id = randomBytes(6).toString('hex');
  const tmpDir = path.join(opts.scratchRoot, `svc-${id}`);
  const fakeHome = path.join(tmpDir, 'home');
  const settingsPath = path.join(opts.scratchRoot, `svc-${id}.json`);
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(sandboxSettings(opts.workspacePath, tmpDir, opts.extraReadPaths, opts.allowedDomains, opts.localNetwork)), { mode: 0o600 });

  const env: Record<string, string> = { HOME: fakeHome, ...opts.env };
  if (process.env.TMPDIR) env['TMPDIR'] = process.env.TMPDIR;
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined && env[key] === undefined) env[key] = value;
  }

  // The output comes to core through pipes and core writes the file. Handing the command
  // the file itself does not work: the log lives where the sandbox forbids reading, and a
  // program that inspects its own output (Node does, at startup) is refused and aborts.
  fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
  const log = fs.createWriteStream(opts.logPath, { flags: 'a', mode: 0o600 });
  log.on('error', () => undefined);
  const child = spawn(process.execPath, [srtCli(), '--settings', settingsPath, '-c', `export TMPDIR=${shellQuote(tmpDir)}; ${command}`], {
    cwd: opts.workspacePath,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', (chunk: Buffer) => log.write(chunk));
  child.stderr.on('data', (chunk: Buffer) => log.write(chunk));
  const cleanup = () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(settingsPath, { force: true });
  };
  let ended = false;
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (err) => {
      log.write(`\ncould not start the sandbox: ${err.message}\n`);
      ended = true;
      resolve(null);
    });
    // 'close' rather than 'exit': by then everything it printed has been read.
    child.on('close', (code) => { ended = true; log.end(() => resolve(code)); });
  });
  const pid = child.pid ?? -1;
  return {
    pid,
    exited,
    async stop() {
      if (!ended && pid > 0) {
        killTree(pid);
        await Promise.race([exited, new Promise((r) => setTimeout(r, KILL_GRACE_MS))]);
        // A survivor could still hold the pipes open; do not wait for it.
        child.stdout.destroy();
        child.stderr.destroy();
      }
      cleanup();
    },
  };
}

/** Run `command` (a shell command line) in `workspacePath`, sandboxed. Never throws for a failing command. */
export function runSandboxed(command: string, opts: SandboxedOptions): Promise<SandboxedResult> {
  // Short names: this path ends up inside the sandboxed command's TMPDIR, where tools
  // create sockets, and a socket path may be at most about 100 characters.
  const id = randomBytes(6).toString('hex');
  const tmpDir = path.join(opts.scratchRoot, `sbx-${id}`);
  const startMarker = `__sandbox_started_${randomBytes(8).toString('hex')}__`;
  const fakeHome = path.join(tmpDir, 'home');
  const settingsPath = path.join(opts.scratchRoot, `sbx-${id}.json`);
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(sandboxSettings(opts.workspacePath, tmpDir, opts.extraReadPaths, opts.allowedDomains)), { mode: 0o600 });

  // The sandbox runtime keeps its own control socket in TMPDIR. That stays the system
  // temp folder (short path); only the command inside gets our per-run folder, below.
  const env: Record<string, string> = { HOME: fakeHome, CI: '1', ...opts.env };
  if (process.env.TMPDIR) env['TMPDIR'] = process.env.TMPDIR;
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined && env[key] === undefined) env[key] = value;
  }

  const started = Date.now();
  return new Promise((resolve) => {
    // The runtime points TMPDIR at a shared /tmp/claude; point it back at this command's
    // own temp folder so runs do not share temp files.
    // The marker is printed by the shell inside the sandbox: seeing it proves the command began.
    const wrapped = `export TMPDIR=${shellQuote(tmpDir)}; echo ${startMarker}; ${command}`;
    const child = spawn(process.execPath, [srtCli(), '--settings', settingsPath, '-c', wrapped], {
      cwd: opts.workspacePath,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so a timeout can stop everything it started
    });

    let output = '';
    let sawStart = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      // Remember it now: a very long output is trimmed from the front later.
      if (!sawStart && output.includes(startMarker)) sawStart = true;
      if (output.length > MAX_FULL_OUTPUT_CHARS * 2) output = output.slice(-MAX_FULL_OUTPUT_CHARS);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let timedOut = false;
    let finished = false;
    let grace: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid!);
      // A survivor could still hold the output pipe open; do not wait for it.
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null);
      }, KILL_GRACE_MS);
    }, opts.timeoutMs);

    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(settingsPath, { force: true });
      const began = sawStart || output.includes(startMarker);
      output = output.split(`${startMarker}\n`).join('');
      const tail = output.length > MAX_OUTPUT_CHARS ? `[earlier output cut]\n${output.slice(-MAX_OUTPUT_CHARS)}` : output;
      resolve({ exitCode, timedOut, durationMs: Date.now() - started, output: tail, fullOutput: output.slice(-MAX_FULL_OUTPUT_CHARS), started: began });
    };
    child.on('error', (err) => { output += `\ncould not start the sandbox: ${err.message}`; finish(null); });
    child.on('close', (code) => finish(timedOut ? null : code));
  });
}
