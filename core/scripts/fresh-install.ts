/**
 * A first run on an empty state folder, driven only through the API — the way a new
 * developer's browser would. Uses REAL agents and the real package registry.
 *
 *   npm run fresh          (uses FRYDAY_MODEL if set, else claude-sonnet-5-5)
 *
 * What it proves:
 *   1. Core starts with nothing configured, creates its own secret, and refuses callers without it.
 *   2. Connections reports this machine, and a claude that does not exist is reported as a problem.
 *   3. A repository is added by path alone: branches and commands are worked out, nothing is hand-edited.
 *   4. A task runs to "waiting for approval". The developer's clone has no node_modules, so
 *      the dependencies are installed in the sandbox; the clone itself is left untouched.
 *   5. The cost recorded per agent run equals what that run itself reported.
 *   6. Approving at the UI merges into staging on the scratch remote (a local folder).
 *   7. A run that reaches its spending limit raises a "continue?" ticket instead of failing.
 *
 * Everything lives under ~/.fryday-code/fresh and is removed again unless --keep is given.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';

const root = path.join(os.homedir(), '.fryday-code', 'fresh');
const home = path.join(root, 'state');
const origin = path.join(root, 'origin.git');
const clone = path.join(root, 'parity-kit');
const PORT = 7499;
const base = `http://127.0.0.1:${PORT}`;
const MODEL = process.env.FRYDAY_MODEL ?? 'claude-sonnet-5-5';
const keepFiles = process.argv.includes('--keep');

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Fresh', '-c', 'user.email=fresh@example.invalid', ...args], { encoding: 'utf8' }).trim();

// ─── A scratch repository with one real dependency and no node_modules ────────

const LOCKFILE = JSON.stringify({
  name: 'parity-kit', version: '1.0.0', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'parity-kit', version: '1.0.0', dependencies: { 'is-odd': '3.0.1' } },
    'node_modules/is-number': { version: '6.0.0', resolved: 'https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz', integrity: 'sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==' },
    'node_modules/is-odd': { version: '3.0.1', resolved: 'https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz', integrity: 'sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==', dependencies: { 'is-number': '^6.0.0' } },
  },
}, null, 2);

function makeRepository(): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(clone, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  const files: Record<string, string> = {
    '.gitignore': 'node_modules\n',
    'package.json': `${JSON.stringify({ name: 'parity-kit', version: '1.0.0', scripts: { test: 'node --test' }, dependencies: { 'is-odd': '3.0.1' } }, null, 2)}\n`,
    'package-lock.json': `${LOCKFILE}\n`,
    'parity.js': "const isOdd = require('is-odd');\n\n/** 'odd' or 'even' for a whole number. */\nexports.describe = (n) => (isOdd(n) ? 'odd' : 'even');\n",
    'parity.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { describe } = require('./parity');\n\ntest('describes odd and even numbers', () => {\n  assert.equal(describe(3), 'odd');\n  assert.equal(describe(4), 'even');\n});\n",
    'README.md': '# parity-kit\n\nSmall helpers about odd and even numbers.\n',
  };
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(clone, file), content);
  sh(clone, 'add', '-A');
  sh(clone, 'commit', '-qm', 'parity helpers');
  sh(clone, 'remote', 'add', 'origin', origin);
  sh(clone, 'push', '-q', 'origin', 'main');
  sh(clone, 'push', '-q', 'origin', 'main:stg');
  sh(clone, 'fetch', '-q', 'origin');
  sh(clone, 'remote', 'set-head', 'origin', 'main');
}

// ─── Core as its own process, on an empty state folder ────────────────────────

let core: ChildProcess | null = null;
let coreLog = '';

async function startCore(): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, FRYDAY_HOME: home, FRYDAY_MAC_NOTIFY: 'off', FRYDAY_PORT: String(PORT), FRYDAY_MODEL: MODEL };
  // A fresh install has none of these.
  for (const key of ['FRYDAY_CORE_SECRET', 'FRYDAY_DB', 'FRYDAY_RUNS', 'FRYDAY_WORKTREES', 'FRYDAY_SCRATCH', 'FRYDAY_SEED', 'FRYDAY_DEPS', 'FRYDAY_REPOS']) delete env[key];
  core = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  core.stdout!.on('data', (c: Buffer) => { coreLog += c.toString('utf8'); });
  core.stderr!.on('data', (c: Buffer) => { coreLog += c.toString('utf8'); });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch { /* not up yet */ }
    if (core.exitCode !== null) break;
    await sleep(200);
  }
  throw new Error(`core did not start:\n${coreLog.slice(-2000)}`);
}

let secret = '';
let cookie = '';
interface Reply { status: number; body: any }
async function call(method: string, route: string, body?: unknown, as: 'token' | 'cookie' | 'nobody' = 'token'): Promise<Reply> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (as === 'token') headers['x-fryday-core-token'] = secret;
  if (as === 'cookie') { headers['Cookie'] = cookie; headers['Origin'] = base; }
  const res = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

const SETTLED = new Set(['awaiting_approval', 'needs_owner', 'failed', 'deployed']);
async function waitForTask(id: string, minutes: number, until: (task: any) => boolean = (t) => SETTLED.has(t.state)): Promise<any> {
  const deadline = Date.now() + minutes * 60_000;
  let last = '';
  for (;;) {
    const body = await detail(id);
    const line = `${body.state}: ${String(body.note ?? '').split('\n')[0]}`;
    if (line !== last) { console.log(`      ${id} ${line}`); last = line; }
    if (until(body)) return body;
    if (Date.now() > deadline) throw new Error(`${id} did not settle in ${minutes} minutes (still ${body.state})`);
    await sleep(3000);
  }
}

/** A task with everything the API knows about it, flattened. */
async function detail(id: string): Promise<any> {
  const { body } = await call('GET', `/api/tasks/${id}`);
  let note = '';
  try { note = String(JSON.parse(body.task.metadata_json ?? '{}').note ?? ''); } catch { /* no note */ }
  return { ...body.task, note, runs: body.runs, usage: body.usage, rounds: body.rounds, approval: body.approval, release: body.release };
}

/** What a run's own final message says it cost, read from its log. */
function reportedCost(logPath: string): number | null {
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const event = JSON.parse(line) as { type?: string; total_cost_usd?: number };
      if (event.type === 'result' && typeof event.total_cost_usd === 'number') return event.total_cost_usd;
    } catch { /* partial line */ }
  }
  return null;
}

async function main(): Promise<void> {
  makeRepository();
  await startCore();

  // 1 ─ First run
  const secretFile = path.join(home, 'secret');
  check('first run creates its own secret, readable only by the developer', fs.existsSync(secretFile) && (fs.statSync(secretFile).mode & 0o777) === 0o600);
  secret = fs.readFileSync(secretFile, 'utf8').trim();
  check('a caller without the secret is refused', (await call('GET', '/api/projects', undefined, 'nobody')).status === 401);
  const empty = await call('GET', '/api/projects');
  check('a fresh install has no projects', empty.status === 200 && empty.body.repos.length === 0);

  // 2 ─ Connections
  const connections = (await call('GET', '/api/connections')).body;
  const state = (id: string) => connections.checks.find((c: any) => c.id === id)?.state;
  check('Connections: Claude Code and the sandbox work on this machine', state('claude') === 'ok' && state('sandbox') === 'ok', connections.checks.map((c: any) => `${c.id}=${c.state}`).join(' '));
  const gh = connections.checks.find((c: any) => c.id === 'github');
  let ghSignedIn = false;
  try { execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' }); ghSignedIn = true; } catch { /* not installed or signed out */ }
  check('Connections: the GitHub CLI is reported as it really is', (gh.state === 'ok') === ghSignedIn, `gh auth status says ${ghSignedIn ? 'signed in' : 'not signed in'}; reported "${gh.summary}"`);

  // 3 ─ Add the repository by path alone
  const detected = await call('POST', '/api/projects/detect', { path: clone });
  const facts = detected.body.facts ?? {};
  check('the repository is understood from its path', detected.status === 200 && facts.prodBranch === 'main' && facts.stgBranch === 'stg' && facts.testCmd === 'npm test' && facts.installCmd === 'npm ci',
    `production ${facts.prodBranch}, staging ${facts.stgBranch}, test "${facts.testCmd}", install "${facts.installCmd}"`);
  const { runProfile: _r, deployer: _d, deployerConfig: _c, ...sendable } = facts;
  const added = await call('POST', '/api/projects', { ...sendable, verified: true });
  check('the project is added with the suggested facts', added.status === 201, added.status === 201 ? facts.id : JSON.stringify(added.body));
  const repoId = facts.id as string;

  // 4 ─ A task, with dependencies that have to be installed
  const created = await call('POST', '/api/tasks', {
    title: 'Add isEven',
    description: 'Add and export a function isEven(n) in parity.js that returns true for even whole numbers and false for odd ones, using the existing is-odd dependency. Add tests for it in parity.test.js.',
    repoId,
  });
  check('a task starts with no further setup', created.status === 201 && !created.body.startError, created.body.startError ?? created.body.id);
  const task = await waitForTask(created.body.id, 25);
  check('the task reaches "waiting for approval"', task.state === 'awaiting_approval', `${task.state}: ${task.note ?? ''}`);
  const lastRound = (task.rounds ?? []).at(-1);
  const testCheck = (lastRound?.checks ?? []).find((c: any) => c.name === 'test');
  check('the tests ran and passed (they need the installed dependency)', testCheck?.status === 'passed', testCheck ? `${testCheck.cmd}: ${testCheck.status}` : 'no test check recorded');
  const keptRoot = path.join(home, 'deps', repoId, 'shared');
  const kept = fs.existsSync(keptRoot) ? fs.readdirSync(keptRoot).filter((k) => fs.existsSync(path.join(keptRoot, k, 'node_modules', 'is-odd', 'package.json'))) : [];
  check('dependencies were installed in the sandbox and kept for reuse', kept.length === 1, `${kept.length} kept install(s) under deps/${repoId}/shared`);
  check("the developer's clone was left untouched", !fs.existsSync(path.join(clone, 'node_modules')) && sh(clone, 'status', '--porcelain') === '' && sh(clone, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main');

  // 5 ─ Usage per agent run equals what the run reported
  const runs = task.runs as Array<{ id: string; role: string; state: string; log_path: string; usage: { costUsd: number } }>;
  const mismatches = runs.filter((r) => {
    const reported = reportedCost(r.log_path);
    return reported === null || Math.abs(reported - r.usage.costUsd) > 1e-9;
  });
  const total = runs.reduce((sum, r) => sum + r.usage.costUsd, 0);
  check('the cost recorded for each agent run equals what the run reported', runs.length >= 3 && mismatches.length === 0,
    `${runs.map((r) => `${r.role} $${r.usage.costUsd.toFixed(4)}`).join(', ')}; task total $${task.usage.costUsd.toFixed(4)}`);
  check('the task total is the sum of its runs', Math.abs(total - task.usage.costUsd) < 1e-9);

  // 6 ─ Approve at the UI: merged into staging on the scratch remote
  const link = await call('POST', '/api/session/launch-code');
  const code = String(link.body.code ?? '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ code }) });
  cookie = (session.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  check('a one-time launch link opens a UI session', session.ok && cookie.startsWith(`fryday_ui_${PORT}=`));
  const ticket = task.approval;
  const byToken = await call('POST', `/api/approvals/${ticket.id}/resolve`, { decision: 'approved' });
  check('holding the secret alone is not enough to approve a release', byToken.status >= 400, `refused with ${byToken.status}`);
  const stgBefore = sh(clone, 'ls-remote', origin, 'refs/heads/stg').split(/\s/)[0];
  const approved = await call('POST', `/api/approvals/${ticket.id}/resolve`, { decision: 'approved' }, 'cookie');
  check('the owner approves at the UI', approved.status === 202, JSON.stringify(approved.body).slice(0, 160));
  const released = await waitForTask(task.id, 10, (t) => t.release?.state === 'pushed' || t.release?.state === 'stopped' || t.state === 'needs_owner' || t.state === 'failed');
  const stgAfter = sh(clone, 'ls-remote', origin, 'refs/heads/stg').split(/\s/)[0];
  const onStg = execFileSync('git', ['--git-dir', origin, 'show', 'stg:parity.js'], { encoding: 'utf8' });
  check('the change is merged into staging on the scratch remote', released.release?.state === 'pushed' && stgAfter !== stgBefore && /isEven/.test(onStg), `${released.state}: ${String(released.note ?? '').split('\n')[0]}`);
  const mainNow = sh(clone, 'ls-remote', origin, 'refs/heads/main').split(/\s/)[0];
  check('production was not touched', mainNow === sh(clone, 'rev-parse', 'main'));

  // 7 ─ A token limit raises a ticket
  const lowered = await call('PUT', '/api/settings', { roles: { planner: { tokenLimit: 1000 } } });
  check("the Planner's limit is changed from Settings", lowered.status === 200 && lowered.body.settings.roles.planner.tokenLimit === 1000);
  const second = await call('POST', '/api/tasks', { title: 'Add isOddString', description: 'Add isOddString(s) to parity.js: true when the string holds an odd whole number. Add tests.', repoId });
  const stopped = await waitForTask(second.body.id, 10);
  const pending = (await call('GET', '/api/approvals')).body.approvals as Array<{ id: string; task_id?: string; taskId?: string; action: string }>;
  const budgetTicket = pending.find((a) => (a.taskId ?? a.task_id) === second.body.id && a.action === 'continue_budget');
  const plannerRun = (stopped.runs as Array<{ role: string; state: string }>).find((r) => r.role === 'planner');
  check('reaching the limit stops the agent and asks, instead of failing the task', stopped.state === 'needs_owner' && plannerRun?.state === 'budget' && !!budgetTicket,
    `${stopped.state}; planner run "${plannerRun?.state}"; ticket ${budgetTicket ? budgetTicket.action : 'none'}; ${String(stopped.note ?? '').split('\n')[0]}`);
  if (budgetTicket) {
    const declined = await call('POST', `/api/approvals/${budgetTicket.id}/resolve`, { decision: 'rejected' }, 'cookie');
    const after = await detail(second.body.id);
    check('declining leaves the task stopped with the reason', declined.status === 200 && after.state !== 'planning' && after.state !== 'coding', `${after.state}: ${String(after.note ?? '').split('\n')[0]}`);
  }
}

main()
  .catch((err) => {
    check('the script ran to the end', false, err instanceof Error ? err.message : String(err));
    if (coreLog) console.log(`\n--- core output (end) ---\n${coreLog.slice(-3000)}`);
  })
  .finally(async () => {
    core?.kill('SIGTERM');
    await sleep(500);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
    if (keepFiles || failed.length > 0) console.log(`Files kept in ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
  });
