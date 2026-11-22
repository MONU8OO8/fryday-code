/**
 * The service under test: core starts the project from its run profile in a throwaway
 * checkout, waits until it answers, and stops it and everything it started afterwards.
 *
 * The service is code an agent just wrote, so it runs in the sandbox: it can write only
 * inside its checkout, cannot read the home folder, and cannot reach any other machine.
 * It can listen on its port and talk to other ports on this Mac (a local database, say);
 * that is what "runs locally with local dependencies" needs. Core's own API is protected
 * from it by the owner session, not by the sandbox (see scripts/redteam-verify.ts).
 */

import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { killTree, startSandboxed, type SandboxedProcess } from '../pipeline/sandbox.js';
import { tailText } from '../runner/logTail.js';
import { profileEnv, ProfileError, type RunProfile } from './profile.js';
import { machineName } from '../platform.js';

export interface StartServiceOptions {
  /** A name for this start, unique among services running now (the task id). */
  key: string;
  profile: RunProfile;
  /** The checkout the service runs in; the only place it may write. */
  checkoutPath: string;
  /** The developer's own clone, where a relative env file is looked up. */
  ownerRepoPath: string;
  scratchRoot: string;
  /** Where the service's output is kept. Must be outside the checkout. */
  logPath: string;
}

export interface RunningService {
  key: string;
  command: string;
  port: number;
  /** http://127.0.0.1:<port> */
  origin: string;
  logPath: string;
  /** Which addresses the service accepts connections on, as far as it could be told. */
  listen: 'loopback' | 'all' | 'unknown';
  startedAt: number;
  readyAfterMs: number;
  /** True once the service's process has ended on its own. */
  hasExited(): boolean;
  stop(): Promise<void>;
}

export type ServiceFailure = {
  ok: false;
  /** profile: the run profile cannot be used. port_in_use: something else is on the port. exited: it stopped. not_ready: it never answered. */
  reason: 'profile' | 'port_in_use' | 'exited' | 'not_ready';
  detail: string;
  logTail: string;
};
export type ServiceStart = { ok: true; service: RunningService } | ServiceFailure;

const POLL_MS = 300;
const PROBE_TIMEOUT_MS = 2500;
const LOG_TAIL_CHARS = 4000;

/** A port nothing is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port was found'))));
    });
  });
}

/** Whether something accepts connections on this port of this machine. */
export function portInUse(port: number): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host });
      const done = (used: boolean) => { socket.destroy(); resolve(used); };
      socket.setTimeout(1000, () => done(false));
      socket.on('connect', () => done(true));
      socket.on('error', () => done(false));
    });
  return Promise.all([tryHost('127.0.0.1'), tryHost('::1')]).then((r) => r.some(Boolean));
}

/** One GET; the status, or null when nothing answered. */
async function probe(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch {
    return null;
  }
}

/**
 * Why the testers cannot reach a service under test on this system, or null when they
 * can. On Linux the sandbox runtime gives every sandboxed command a network namespace
 * of its own (bubblewrap --unshare-net): a service listening there is on a loopback
 * that is not this machine's, and nothing outside the sandbox can connect to it. The
 * runtime's network bridge carries traffic out of the sandbox only. Opening a way in
 * would mean letting agent-written code create Unix sockets, which the runtime forbids
 * for good reason, so the testers are not offered there.
 */
export function serviceUnreachableReason(platform: string = process.platform): string | null {
  if (platform === 'linux') {
    return 'On Linux the sandbox gives the service under test a network of its own, so FryDay Code cannot reach it: the API and UI testers are not available on Linux yet.';
  }
  return null;
}

/** lsof's LISTEN lines for one port: whether any of them accepts connections on every address. */
export function parseLsofListen(stdout: string): RunningService['listen'] {
  const names = stdout.split('\n').slice(1).map((line) => line.trim().split(/\s+/).at(-2) ?? '').filter(Boolean);
  if (names.length === 0) return 'unknown';
  return names.some((n) => n.startsWith('*:')) ? 'all' : 'loopback';
}

/** `ss -ltnp` output: how `port` is listened on. A specific address that is not loopback counts as all. */
export function parseSsListen(stdout: string, port: number): RunningService['listen'] {
  const locals: string[] = [];
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'LISTEN' || cols.length < 4) continue;
    const local = cols[3]!;
    const cut = local.lastIndexOf(':');
    if (cut < 0 || local.slice(cut + 1) !== String(port)) continue;
    // "[::1]" is bracketed; "%lo" or "%eth0" names the interface the address is bound to.
    locals.push(local.slice(0, cut).replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, ''));
  }
  if (locals.length === 0) return 'unknown';
  const loopback = (a: string) => a.startsWith('127.') || a === '::1' || a === 'localhost' || a.startsWith('::ffff:127.');
  return locals.every(loopback) ? 'loopback' : 'all';
}

/** Which addresses a port is being listened on, read from lsof, or from ss where there is no lsof. */
export function listenAddress(port: number): Promise<RunningService['listen']> {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return resolve(parseLsofListen(String(stdout ?? '')));
      execFile('ss', ['-ltnp'], { encoding: 'utf8', timeout: 5000 }, (_err2, out) => resolve(parseSsListen(String(out ?? ''), port)));
    });
  });
}

// ─── Leftovers ────────────────────────────────────────────────────────────────

const markerDir = (scratchRoot: string) => path.join(scratchRoot, 'services');
const markerPath = (scratchRoot: string, key: string) => path.join(markerDir(scratchRoot), `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

function isSandboxProcess(pid: number): boolean {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes('sandbox-runtime');
  } catch {
    return false;
  }
}

/**
 * Stop services a previous core left running (it was stopped in the middle of a
 * verification). Returns how many were stopped.
 */
export function stopLeftoverServices(scratchRoot: string): number {
  let stopped = 0;
  let files: string[] = [];
  try {
    files = fs.readdirSync(markerDir(scratchRoot));
  } catch {
    return 0;
  }
  for (const file of files) {
    const full = path.join(markerDir(scratchRoot), file);
    try {
      const { pid } = JSON.parse(fs.readFileSync(full, 'utf8')) as { pid?: unknown };
      // A pid can belong to something else by now; only stop it if it is still a sandboxed command.
      if (typeof pid === 'number' && pid > 0 && isSandboxProcess(pid)) {
        killTree(pid);
        stopped++;
      }
    } catch {
      /* unreadable marker: nothing to stop */
    }
    fs.rmSync(full, { force: true });
  }
  return stopped;
}

// ─── Start ────────────────────────────────────────────────────────────────────

/** Start the service and wait until it answers. Never throws for a service that does not come up. */
export async function startService(opts: StartServiceOptions): Promise<ServiceStart> {
  const { profile } = opts;
  const fail = (reason: ServiceFailure['reason'], detail: string): ServiceFailure => ({
    ok: false, reason, detail, logTail: tailText(opts.logPath, LOG_TAIL_CHARS),
  });

  let env: Record<string, string>;
  try {
    env = profileEnv(profile, opts.ownerRepoPath);
  } catch (err) {
    if (!(err instanceof ProfileError)) throw err;
    return fail('profile', err.message);
  }
  if (profile.port !== null && (await portInUse(profile.port))) {
    return fail('port_in_use', `Port ${profile.port} is already in use on ${machineName()} (your own copy of the service, perhaps). Stop that, or let the service take its port from PORT and leave the port empty in the run profile.`);
  }
  const port = profile.port ?? (await freePort());
  const origin = `http://127.0.0.1:${port}`;

  fs.rmSync(opts.logPath, { force: true });
  let proc: SandboxedProcess;
  try {
    proc = startSandboxed(profile.command, {
      workspacePath: opts.checkoutPath,
      scratchRoot: opts.scratchRoot,
      logPath: opts.logPath,
      // HOST asks the service to listen on this machine only; services that honour it do.
      env: { ...env, PORT: String(port), HOST: '127.0.0.1' },
      localNetwork: true,
    });
  } catch (err) {
    return fail('exited', `The service could not be started: ${err instanceof Error ? err.message : String(err)}`);
  }
  fs.mkdirSync(markerDir(opts.scratchRoot), { recursive: true });
  fs.writeFileSync(markerPath(opts.scratchRoot, opts.key), JSON.stringify({ pid: proc.pid, port, startedAt: Date.now() }), { mode: 0o600 });

  let exited = false;
  let exitCode: number | null = null;
  void proc.exited.then((code) => { exited = true; exitCode = code; });
  const stop = async () => {
    await proc.stop();
    fs.rmSync(markerPath(opts.scratchRoot, opts.key), { force: true });
  };

  const started = Date.now();
  const deadline = started + profile.readyTimeoutSec * 1000;
  let lastStatus: number | null = null;
  for (;;) {
    if (exited) {
      await stop();
      return fail('exited', `The service stopped${exitCode === null ? '' : ` with exit code ${exitCode}`} before it answered on port ${port}.`);
    }
    lastStatus = await probe(`${origin}${profile.readyPath}`);
    if (lastStatus !== null && lastStatus < 500) break;
    if (Date.now() > deadline) {
      await stop();
      const what = lastStatus === null ? `nothing answered on port ${port}` : `${profile.readyPath} kept answering ${lastStatus}`;
      const hint = profile.port === null ? ' If the service listens on a fixed port instead of reading PORT, give that port in the run profile.' : '';
      return fail('not_ready', `The service was started but ${what} within ${profile.readyTimeoutSec} seconds.${hint}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  return {
    ok: true,
    service: {
      key: opts.key,
      command: profile.command,
      port,
      origin,
      logPath: opts.logPath,
      listen: await listenAddress(port),
      startedAt: started,
      readyAfterMs: Date.now() - started,
      hasExited: () => exited,
      stop,
    },
  };
}
