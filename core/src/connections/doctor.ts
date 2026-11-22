/**
 * Connections — what FryDay Code can use on this machine, checked for real each time.
 *
 * FryDay Code has no sign-ins of its own. It uses the tools the developer already set
 * up (Claude Code, git, the GitHub CLI) and reports, truthfully, which of them work.
 * Every check runs the tool; nothing is assumed from a file being present.
 *
 * What is reported is deliberately small: whether something works and how to fix it.
 * Account names, e-mail addresses, command lines and environment values never leave
 * this file — a server's command line can hold a secret.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findOnPath, getConfig } from '../config.js';
import { memoryPressureLevel } from '../pipeline/checks.js';
import { runSandboxed } from '../pipeline/sandbox.js';
import { cursorKeySet } from '../runner/runners.js';
import { findChrome } from '../verify/tools.js';
import { serviceUnreachableReason } from '../verify/service.js';
import { inDocker } from '../platform.js';

/**
 * ok       works
 * warn     works in part, or works but the developer should know something
 * problem  needed and not working
 * off      optional and not set up
 */
export type CheckState = 'ok' | 'warn' | 'problem' | 'off';

export interface ConnectionCheck {
  id: string;
  name: string;
  /** What FryDay Code uses it for. */
  usedFor: string;
  required: boolean;
  state: CheckState;
  /** What was found. */
  summary: string;
  /** What the developer can do about it; a command where there is one. */
  fix?: string;
}

export type ServerEnvironment = 'production' | 'staging' | 'local' | 'unknown';

export interface McpServerInfo {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  /** A guess from the name alone. */
  environment: ServerEnvironment;
  looksLikeDatabase: boolean;
  /** Things about how it starts that the developer should know. */
  notes: string[];
}

export interface ConnectionsReport {
  checkedAt: number;
  checks: ConnectionCheck[];
  mcpServers: McpServerInfo[];
  /** Why the server list is empty, when it could not be read. */
  mcpNote: string | null;
}

export interface RunResult {
  /** Null when the program could not be run or did not finish in time. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Everything the doctor learns about the machine goes through this, so tests can stand in for it. */
export interface Probe {
  which(name: string): string | null;
  run(file: string, args: string[]): Promise<RunResult>;
  readFile(file: string): string | null;
  exists(file: string): boolean;
  /** Run a trivial command in the OS sandbox. */
  sandbox(): Promise<{ ok: boolean; detail: string }>;
  platform: string;
  nodeVersion: string;
  totalMemoryBytes: number;
  memoryPressure(): number | null;
  home: string;
  /** Claude Code's settings file, where its MCP servers are defined. Default: ~/.claude.json. */
  claudeSettingsPath?: string;
  /** The claude program agents run as (a path, or a name to look up). */
  claudeBin: string;
  apiKeySet: boolean;
  /** A Cursor API key is kept for Cursor agents. */
  cursorKeySet?: boolean;
  /** Running in the FryDay Code Docker image (FRYDAY_IN_DOCKER=1). */
  inDocker?: boolean;
  /** FRYDAY_CHROME: the browser the UI tester uses, when set. */
  chromeOverride?: string;
}

const RUN_TIMEOUT_MS = 10_000;
/** The sandbox runtime needs Node 22.12 or newer. */
const MIN_NODE: [number, number] = [22, 12];

export function realProbe(): Probe {
  const cfg = getConfig();
  return {
    which: (name) => (path.isAbsolute(name) ? (fs.existsSync(name) ? name : null) : findOnPath(name)),
    run: (file, args) =>
      new Promise((resolve) => {
        execFile(file, args, { timeout: RUN_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
          const code = !err ? 0 : typeof (err as NodeJS.ErrnoException).code === 'number' ? ((err as unknown as { code: number }).code) : null;
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
      }),
    readFile: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    exists: (file) => fs.existsSync(file),
    sandbox: async () => {
      const dir = fs.mkdtempSync(path.join(fs.mkdtempSync(path.join(cfg.home, 'doctor-')), 'ws-'));
      const root = path.dirname(dir);
      try {
        const r = await runSandboxed('echo sandbox-ok', { workspacePath: dir, scratchRoot: root, timeoutMs: RUN_TIMEOUT_MS });
        if (r.started && r.exitCode === 0 && r.output.includes('sandbox-ok')) return { ok: true, detail: '' };
        return { ok: false, detail: (r.output.trim().split('\n').pop() ?? '').slice(0, 300) || 'the sandboxed command did not start' };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    platform: process.platform,
    nodeVersion: process.version,
    totalMemoryBytes: os.totalmem(),
    memoryPressure: memoryPressureLevel,
    home: os.homedir(),
    claudeSettingsPath: cfg.claudeSettingsPath,
    claudeBin: cfg.claudeBin,
    apiKeySet: cfg.apiKey !== '',
    cursorKeySet: cursorKeySet(),
    inDocker: inDocker(),
    chromeOverride: process.env['FRYDAY_CHROME'] ?? '',
  };
}

type Distro = 'debian' | 'fedora' | 'arch' | null;

/** Which family of Linux this is, from /etc/os-release, to give the install command that works here. */
export function linuxDistro(osRelease: string | null): Distro {
  if (!osRelease) return null;
  const field = (key: string) => (osRelease.match(new RegExp(`^${key}=["']?([^"'\n]*)`, 'm'))?.[1] ?? '').toLowerCase();
  const ids = `${field('ID')} ${field('ID_LIKE')}`.split(/\s+/).filter(Boolean);
  if (ids.some((id) => ['debian', 'ubuntu'].includes(id))) return 'debian';
  if (ids.some((id) => ['fedora', 'rhel', 'centos'].includes(id))) return 'fedora';
  if (ids.some((id) => ['arch', 'manjaro'].includes(id))) return 'arch';
  return null;
}

/** Package names where they differ between distributions. */
const PACKAGES: Record<string, Partial<Record<'debian' | 'fedora' | 'arch', string>>> = {
  gh: { arch: 'github-cli' },
};

/** The command that installs `pkg` on this system; every distribution's when it is not known which this is. */
export function installCommand(pkg: string, platform: string, distro: Distro): string {
  if (platform === 'darwin') return `brew install ${pkg}`;
  const name = (d: 'debian' | 'fedora' | 'arch') => PACKAGES[pkg]?.[d] ?? pkg;
  if (distro === 'debian') return `sudo apt-get install -y ${name('debian')}`;
  if (distro === 'fedora') return `sudo dnf install -y ${name('fedora')}`;
  if (distro === 'arch') return `sudo pacman -S ${name('arch')}`;
  return `sudo apt-get install -y ${name('debian')} (Debian, Ubuntu) · sudo dnf install -y ${name('fedora')} (Fedora) · sudo pacman -S ${name('arch')} (Arch)`;
}

const distroOf = (p: Probe): Distro => (p.platform === 'linux' ? linuxDistro(p.readFile('/etc/os-release')) : null);

const firstLine = (text: string) => (text.trim().split('\n')[0] ?? '').trim().slice(0, 120);

async function checkClaude(p: Probe): Promise<ConnectionCheck> {
  const base = { id: 'claude', name: 'Claude Code', usedFor: 'Every agent runs as Claude Code on this machine.', required: true };
  const bin = p.which(p.claudeBin);
  if (!bin) {
    return { ...base, state: 'problem', summary: `The claude program was not found (${p.claudeBin}).`, fix: 'Install Claude Code, then run: claude auth login' };
  }
  const version = await p.run(bin, ['--version']);
  if (version.code !== 0) {
    return { ...base, state: 'problem', summary: `${bin} is there but does not run.`, fix: 'Reinstall Claude Code, or set CLAUDE_BIN to a working claude.' };
  }
  const v = firstLine(version.stdout);
  if (p.apiKeySet) return { ...base, state: 'ok', summary: `${v}. Agents use the API key from ANTHROPIC_API_KEY.` };

  const auth = await p.run(bin, ['auth', 'status']);
  let loggedIn = auth.code === 0;
  let how = '';
  try {
    // Only these fields are read. The status also carries the account's e-mail, which is not passed on.
    const status = JSON.parse(auth.stdout) as { loggedIn?: unknown; authMethod?: unknown; loginExpiresAt?: unknown };
    if (typeof status.loggedIn === 'boolean') loggedIn = status.loggedIn;
    if (typeof status.authMethod === 'string') how = ` (${status.authMethod})`;
    if (loggedIn && typeof status.loginExpiresAt === 'string') {
      const days = Math.floor((Date.parse(status.loginExpiresAt) - Date.now()) / 86_400_000);
      if (Number.isFinite(days) && days <= 3) {
        return { ...base, state: 'warn', summary: `${v}. Signed in${how}, but the sign-in ends in ${Math.max(days, 0)} day${days === 1 ? '' : 's'}.`, fix: 'claude auth login' };
      }
    }
  } catch {
    /* an older claude prints text; the exit code decides */
  }
  return loggedIn
    ? { ...base, state: 'ok', summary: `${v}. Signed in${how}.` }
    : { ...base, state: 'problem', summary: `${v}, but it is not signed in, so no agent can run.`, fix: 'claude auth login' };
}

async function checkGit(p: Probe): Promise<ConnectionCheck> {
  const base = { id: 'git', name: 'git', usedFor: 'Task branches, commits, merges and pushes, with your own access to the remotes.', required: true };
  const bin = p.which('git');
  const install = p.platform === 'darwin' ? 'xcode-select --install' : installCommand('git', p.platform, distroOf(p));
  if (!bin) return { ...base, state: 'problem', summary: 'git was not found.', fix: install };
  const version = await p.run(bin, ['--version']);
  if (version.code !== 0) return { ...base, state: 'problem', summary: 'git is there but does not run.', fix: install };
  const [name, email] = await Promise.all([p.run(bin, ['config', '--global', 'user.name']), p.run(bin, ['config', '--global', 'user.email'])]);
  if (!name.stdout.trim() || !email.stdout.trim()) {
    return { ...base, state: 'warn', summary: `${firstLine(version.stdout)}. No global author name or e-mail is set; commits use whatever each repository sets.`, fix: 'git config --global user.name "Your Name" && git config --global user.email you@example.com' };
  }
  return { ...base, state: 'ok', summary: `${firstLine(version.stdout)}. Author name and e-mail are set.` };
}

async function checkGitHub(p: Probe): Promise<ConnectionCheck> {
  const base = { id: 'github', name: 'GitHub CLI', usedFor: 'Listing your repositories, finding branches and pull requests, opening pull requests. Cloning and pushing work without it.', required: false };
  const bin = p.which('gh');
  if (!bin) return { ...base, state: 'off', summary: 'gh is not installed.', fix: `${installCommand('gh', p.platform, distroOf(p))}, then: gh auth login` };
  const status = await p.run(bin, ['auth', 'status']);
  if (status.code === 0) return { ...base, state: 'ok', summary: 'Installed and signed in.' };
  if (status.code === null) return { ...base, state: 'warn', summary: 'gh is installed but did not answer.', fix: 'gh auth status' };
  return { ...base, state: 'warn', summary: 'Installed, but not signed in to any GitHub host.', fix: 'gh auth login' };
}

/** Whether a Node version ("v22.12.0") is at least major.minor. */
export function nodeAtLeast(version: string, [major, minor]: [number, number]): boolean {
  const [a = NaN, b = 0] = version.replace(/^v/, '').split('.').map((n) => parseInt(n, 10));
  return a > major || (a === major && b >= minor);
}

function checkNode(p: Probe): ConnectionCheck {
  const base = { id: 'node', name: 'Node.js', usedFor: 'FryDay Code itself, its sandbox, and the checks of Node projects.', required: true };
  const need = `${MIN_NODE[0]}.${MIN_NODE[1]}`;
  return nodeAtLeast(p.nodeVersion, MIN_NODE)
    ? { ...base, state: 'ok', summary: `${p.nodeVersion}.` }
    : { ...base, state: 'problem', summary: `${p.nodeVersion} is too old; ${need} or newer is needed (the sandbox needs it).`, fix: `Install Node ${need} or newer (nvm install 22) and start FryDay Code with it.` };
}

async function checkSandbox(p: Probe): Promise<ConnectionCheck> {
  const base = { id: 'sandbox', name: 'Sandbox', usedFor: 'Confines agents, tests and installs: no reading your home folder, no writing outside the task, no network.', required: true };
  // Every system runs the same probe: a sandbox that cannot start is said, never assumed.
  const r = await p.sandbox();
  const fix = p.platform === 'linux'
    ? 'Check the Linux sandbox items below (bubblewrap, socat, ripgrep, user namespaces); if they are all fine, see the error above.'
    : 'Run npm install in the FryDay Code folder; if that does not help, see the error above.';
  return r.ok
    ? { ...base, state: 'ok', summary: 'A sandboxed command ran.' }
    : { ...base, state: 'problem', summary: `A sandboxed command could not run: ${r.detail}. Tasks stop rather than run unconfined.`, fix };
}

/** The programs the sandbox needs on Linux (sandbox-runtime README, "Platform-Specific Dependencies"). */
const LINUX_SANDBOX_TOOLS: Array<{ id: string; name: string; bin: string; pkg: string; usedFor: string }> = [
  { id: 'bwrap', name: 'bubblewrap', bin: 'bwrap', pkg: 'bubblewrap', usedFor: 'The Linux sandbox itself: every agent shell, check and install runs inside it.' },
  { id: 'socat', name: 'socat', bin: 'socat', pkg: 'socat', usedFor: 'Carries the sandbox network traffic to the proxy that decides which hosts may be reached.' },
  { id: 'ripgrep', name: 'ripgrep', bin: 'rg', pkg: 'ripgrep', usedFor: 'Finds the files the sandbox must hide (credentials and the like) before a command starts.' },
];

/** The fix for a kernel setting, made to last across restarts. */
const sysctlFix = (key: string, value: string, docker: boolean) =>
  `${docker ? 'On the Docker host: ' : ''}sudo sysctl -w ${key}=${value} && echo '${key}=${value}' | sudo tee /etc/sysctl.d/60-fryday-userns.conf`;

/** Linux: the sandbox's programs and the kernel setting it depends on, each with the command that fixes it. */
function checkLinuxSandbox(p: Probe): ConnectionCheck[] {
  if (p.platform !== 'linux') return [];
  const distro = distroOf(p);
  const tools = LINUX_SANDBOX_TOOLS.map(({ id, name, bin, pkg, usedFor }): ConnectionCheck => {
    const base = { id, name, usedFor, required: true };
    return p.which(bin)
      ? { ...base, state: 'ok', summary: `${bin} is installed.` }
      : { ...base, state: 'problem', summary: `${bin} was not found, so the sandbox cannot start.`, fix: installCommand(pkg, p.platform, distro) };
  });

  // bubblewrap needs user namespaces that carry capabilities. Three settings can take them away.
  const userns = { id: 'userns', name: 'User namespaces', usedFor: 'bubblewrap builds each sandbox in a user namespace of its own.', required: true };
  const read = (file: string) => (p.readFile(file) ?? '').trim();
  const docker = p.inDocker === true;
  let check: ConnectionCheck = { ...userns, state: 'ok', summary: 'Unprivileged user namespaces are allowed.' };
  if (read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1') {
    check = { ...userns, state: 'problem', summary: 'AppArmor restricts unprivileged user namespaces (the default since Ubuntu 24.04), so bubblewrap cannot build the sandbox.', fix: sysctlFix('kernel.apparmor_restrict_unprivileged_userns', '0', docker) };
  } else if (read('/proc/sys/kernel/unprivileged_userns_clone') === '0') {
    check = { ...userns, state: 'problem', summary: 'Unprivileged user namespaces are switched off in the kernel, so bubblewrap cannot build the sandbox.', fix: sysctlFix('kernel.unprivileged_userns_clone', '1', docker) };
  } else if (read('/proc/sys/user/max_user_namespaces') === '0') {
    check = { ...userns, state: 'problem', summary: 'The kernel allows no user namespaces (user.max_user_namespaces is 0), so bubblewrap cannot build the sandbox.', fix: sysctlFix('user.max_user_namespaces', '15000', docker) };
  }
  return [...tools, check];
}

/** What is weaker on this system than on a Mac, said plainly. Empty on macOS. */
function checkReducedIsolation(p: Probe): ConnectionCheck[] {
  const out: ConnectionCheck[] = [];
  if (p.inDocker) {
    out.push({
      id: 'isolation', name: 'Isolation', required: false, state: 'warn',
      usedFor: 'How strongly agents are kept apart from the rest of the system.',
      summary: 'Reduced isolation (nested sandbox): FryDay Code runs in Docker, where the sandbox cannot mount a /proc of its own, so a sandboxed command can see the container\'s other processes. Files and network stay confined; the container is the outer wall.',
      fix: 'For the strongest isolation, install FryDay Code directly on macOS or Linux.',
    });
  }
  const unreachable = serviceUnreachableReason(p.platform);
  if (unreachable) {
    out.push({
      id: 'testers', name: 'API and UI testers', required: false, state: 'warn',
      usedFor: 'Starting the changed service and trying it, after the review.',
      summary: `${unreachable} A task that asks for them goes to you instead; checks and reviews work as usual.`,
    });
  }
  return out;
}

function checkBrowser(p: Probe): ConnectionCheck {
  const base = { id: 'browser', name: 'Browser', usedFor: 'The UI tester opens the pages of a project in it, in a fresh profile that can reach only the service under test.', required: false };
  const found = findChrome({ platform: p.platform, home: p.home, exists: p.exists, which: p.which, override: p.chromeOverride ?? '' });
  if (found) return { ...base, state: 'ok', summary: p.platform === 'darwin' && !p.chromeOverride ? 'Google Chrome is installed.' : `Found ${path.basename(found)}.` };
  const fix = p.chromeOverride
    ? 'FRYDAY_CHROME is set but does not name a browser that is there; correct it or unset it.'
    : p.platform === 'linux'
      ? 'Install Google Chrome or Chromium if you want pages checked in a browser by the UI tester, or set FRYDAY_CHROME to its path.'
      : 'Install Google Chrome if you want pages checked in a browser by the UI tester.';
  return { ...base, state: 'off', summary: p.chromeOverride ? 'The browser named by FRYDAY_CHROME was not found.' : 'Google Chrome was not found.', fix };
}

async function checkCursor(p: Probe): Promise<ConnectionCheck> {
  const base = {
    id: 'cursor', name: 'Cursor CLI', required: false,
    usedFor: 'An optional engine for the Analyst and the Planner, when you choose it in Settings. Reduced isolation: no FryDay guard on each tool call, so it reads a throwaway copy of the code inside a sandbox around the whole program.',
  };
  const bin = p.which('cursor-agent');
  if (!bin) return { ...base, state: 'off', summary: 'cursor-agent is not installed.', fix: 'Install the Cursor CLI if you want to use it for read-only agents.' };
  const version = await p.run(bin, ['--version']);
  if (version.code !== 0) return { ...base, state: 'warn', summary: 'cursor-agent is installed but did not answer.' };
  return p.cursorKeySet
    ? { ...base, state: 'ok', summary: `cursor-agent ${firstLine(version.stdout)} is installed and a Cursor API key is set.` }
    : { ...base, state: 'warn', summary: `cursor-agent ${firstLine(version.stdout)} is installed, but no Cursor API key is set: add one under "Other agent engines" below.` };
}

function checkMachine(p: Probe): ConnectionCheck {
  const mac = p.platform === 'darwin';
  const base = { id: 'machine', name: mac ? 'This Mac' : 'This machine', usedFor: `Agents and test suites need memory; work waits while ${mac ? 'the Mac' : 'the machine'} is short of it.`, required: true };
  const gb = Math.round(p.totalMemoryBytes / 1024 ** 3);
  const level = p.memoryPressure();
  if (level !== null && level >= 4) return { ...base, state: 'warn', summary: `${gb} GB of memory, under critical pressure right now. Checks wait until it eases.`, fix: 'Close heavy apps.' };
  if (level !== null && level >= 2) return { ...base, state: 'warn', summary: `${gb} GB of memory, under pressure right now. Checks wait until it eases.` };
  if (gb < 8) return { ...base, state: 'warn', summary: `${gb} GB of memory. Keep "agents at the same time" at 1 in Settings.` };
  return { ...base, state: 'ok', summary: `${gb} GB of memory, no pressure.` };
}

const PRODUCTION = /(^|[^a-z])(prod|production|live|prd)([^a-z]|$)/i;
const STAGING = /(^|[^a-z])(stg|stag|staging|stage|dev|test|qa|uat|sandbox|preview)([^a-z]|$)/i;
const LOCAL = /(^|[^a-z])(local|localhost)([^a-z]|$)/i;
const DATABASE = /(db|rds|sql|postgres|mongo|redis|dynamo|clickhouse|bigquery|snowflake)/i;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish']);

/** A guess at what a server points at, from its name only. Production wins a tie: wrongly careful is the safe mistake. */
export function guessEnvironment(name: string): ServerEnvironment {
  if (PRODUCTION.test(name)) return 'production';
  if (STAGING.test(name)) return 'staging';
  if (LOCAL.test(name)) return 'local';
  return 'unknown';
}

/** The MCP servers Claude Code knows for this user. Names and how they start; never their command lines. */
export function readMcpServers(p: Probe): { servers: McpServerInfo[]; note: string | null } {
  const file = p.claudeSettingsPath ?? path.join(p.home, '.claude.json');
  const raw = p.readFile(file);
  if (raw === null) return { servers: [], note: 'Claude Code has no settings file for this user yet (~/.claude.json).' };
  let defined: unknown;
  try {
    defined = (JSON.parse(raw) as { mcpServers?: unknown }).mcpServers;
  } catch {
    return { servers: [], note: '~/.claude.json could not be read as JSON.' };
  }
  if (!defined || typeof defined !== 'object') return { servers: [], note: null };

  const servers = Object.entries(defined as Record<string, unknown>).map(([name, value]): McpServerInfo => {
    const def = (value && typeof value === 'object' ? value : {}) as { type?: unknown; command?: unknown; args?: unknown; url?: unknown; env?: unknown };
    const transport = def.type === 'http' || def.type === 'sse' ? def.type : typeof def.url === 'string' && !def.command ? 'http' : 'stdio';
    const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string') : [];
    const commandLine = args.join(' ');
    const notes: string[] = [];
    if (transport === 'stdio') {
      const program = path.basename(typeof def.command === 'string' ? def.command : '');
      if (SHELLS.has(program)) notes.push('starts through a shell, so whatever that shell loads (rc files, sourced files) runs with it');
      if (/@latest\b/.test(commandLine)) notes.push('downloads the newest version of its package on every start');
      else if (/\b(npx|bunx|uvx)\b/.test(`${program} ${commandLine}`) && !/@\d/.test(commandLine)) notes.push('runs a package without a pinned version');
      if (def.env && typeof def.env === 'object' && Object.keys(def.env).length > 0) notes.push('has values written into the Claude Code settings file');
    }
    return { name, transport, environment: guessEnvironment(name), looksLikeDatabase: DATABASE.test(name), notes };
  });
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { servers, note: null };
}

export async function checkConnections(p: Probe = realProbe()): Promise<ConnectionsReport> {
  const checks = await Promise.all([
    checkClaude(p),
    checkSandbox(p),
    checkGit(p),
    checkGitHub(p),
    Promise.resolve(checkNode(p)),
    Promise.resolve(checkMachine(p)),
    Promise.resolve(checkBrowser(p)),
    checkCursor(p),
  ]);
  checks.splice(2, 0, ...checkLinuxSandbox(p), ...checkReducedIsolation(p));
  const mcp = readMcpServers(p);
  return { checkedAt: Date.now(), checks, mcpServers: mcp.servers, mcpNote: mcp.note };
}
