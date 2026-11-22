/**
 * Intake with REAL agents, through the API only: documents, the choice of project,
 * questions, and continuing existing branches.
 *
 *   npm run intake                    (uses FRYDAY_MODEL if set, else claude-sonnet-5-5)
 *   npm run intake -- --keep-running  leave core up afterwards and print a link to look at it
 *
 * What it proves:
 *   1. A PRD attached as a PDF, with no project named: the Analyst picks the right one of
 *      two projects, and its brief carries what only the PDF says.
 *   2. A vague task asks the owner before anything is built: no workspace, no planner, no coder.
 *   3. A task that matches a branch the owner started is offered that branch; on yes the work
 *      is cut from it and, once approved, pushed back to it. Nothing is forced.
 *   4. A branch with a teammate's commits is never pushed to: FryDay pushes its own branch.
 *
 * Everything lives under ~/.fryday-code/intake-check; the remotes are folders on disk.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { runSandboxed } from '../src/pipeline/sandbox';

const root = path.join(os.homedir(), '.fryday-code', 'intake-check');
const home = path.join(root, 'state');
const PORT = 7498;
const base = `http://127.0.0.1:${PORT}`;
const MODEL = process.env.FRYDAY_MODEL ?? 'claude-sonnet-5-5';
const keepRunning = process.argv.includes('--keep-running');

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OWNER = ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid'];
const MATE = ['-c', 'user.name=Teammate', '-c', 'user.email=teammate@example.invalid'];
const git = (cwd: string, who: string[], ...args: string[]) => execFileSync('git', ['-C', cwd, ...who, ...args], { encoding: 'utf8' }).trim();
const onRemote = (origin: string, branch: string) => {
  try {
    return execFileSync('git', ['--git-dir', origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const fileOnRemote = (origin: string, branch: string, file: string) => execFileSync('git', ['--git-dir', origin, 'show', `${branch}:${file}`], { encoding: 'utf8' });

// ─── Two scratch projects ─────────────────────────────────────────────────────

interface Scratch { clone: string; origin: string }

function makeProject(name: string, files: Record<string, string>): Scratch {
  const clone = path.join(root, name);
  const origin = path.join(root, `${name}.git`);
  fs.mkdirSync(clone, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  git(clone, [], 'config', 'user.email', 'owner@example.invalid');
  git(clone, [], 'config', 'user.name', 'Owner');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(clone, file)), { recursive: true });
    fs.writeFileSync(path.join(clone, file), content);
  }
  git(clone, OWNER, 'add', '-A');
  git(clone, OWNER, 'commit', '-qm', 'first version');
  git(clone, OWNER, 'remote', 'add', 'origin', origin);
  git(clone, OWNER, 'push', '-q', 'origin', 'main', 'main:stg');
  git(clone, OWNER, 'fetch', '-q', 'origin');
  git(clone, OWNER, 'remote', 'set-head', 'origin', 'main');
  return { clone, origin };
}

/** A branch on the remote with one commit by `who`, made in a separate clone so the owner's is left alone. */
function remoteBranch(p: Scratch, branch: string, who: string[], files: Record<string, string>, subject: string): string {
  const work = path.join(root, `work-${branch.replace(/\W+/g, '-')}`);
  execFileSync('git', ['clone', '-q', p.origin, work]);
  git(work, who, 'checkout', '-q', '-b', branch);
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(work, file), content);
  git(work, who, 'add', '-A');
  git(work, who, 'commit', '-qm', subject);
  git(work, who, 'push', '-q', 'origin', branch);
  fs.rmSync(work, { recursive: true, force: true });
  return onRemote(p.origin, branch);
}

const PARITY_JS = "/** 'odd' or 'even' for a whole number. */\nexports.describe = (n) => (n % 2 === 0 ? 'even' : 'odd');\n";
const PARITY_TEST = "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst parity = require('./parity');\n\ntest('describes odd and even numbers', () => {\n  assert.equal(parity.describe(3), 'odd');\n  assert.equal(parity.describe(4), 'even');\n});\n";
const PRICE_JS = "// Amounts are whole rupees.\nexports.subtotal = (items) => items.reduce((sum, item) => sum + item.price * item.qty, 0);\n";
const PRICE_TEST = "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst price = require('./price');\n\ntest('subtotal adds up the lines', () => {\n  assert.equal(price.subtotal([{ price: 100, qty: 2 }, { price: 50, qty: 1 }]), 250);\n});\n";

/** A one-page PDF holding `text`, written by hand so no library is needed. */
function pdf(lines: string[]): Buffer {
  const content = lines.map((line, i) => `BT /F1 11 Tf 40 ${760 - i * 18} Td (${line.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

// ─── Core, and the API ────────────────────────────────────────────────────────

let core: ChildProcess | null = null;
let coreLog = '';
let secret = '';
let cookie = '';

async function startCore(): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, FRYDAY_HOME: home, FRYDAY_MAC_NOTIFY: 'off', FRYDAY_PORT: String(PORT), FRYDAY_MODEL: MODEL };
  for (const key of ['FRYDAY_CORE_SECRET', 'FRYDAY_DB', 'FRYDAY_RUNS', 'FRYDAY_WORKTREES', 'FRYDAY_SCRATCH', 'FRYDAY_SEED', 'FRYDAY_DEPS', 'FRYDAY_REPOS', 'FRYDAY_ATTACHMENTS']) delete env[key];
  core = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: path.join(__dirname, '..'), env, stdio: keepRunning ? 'ignore' : ['ignore', 'pipe', 'pipe'], detached: keepRunning });
  // When core is left running it must not hold a pipe to this script, which is about to exit.
  core.stdout?.on('data', (c: Buffer) => { coreLog += c.toString('utf8'); });
  core.stderr?.on('data', (c: Buffer) => { coreLog += c.toString('utf8'); });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
    if (core.exitCode !== null) break;
    await sleep(200);
  }
  throw new Error(`core did not start:\n${coreLog.slice(-2000)}`);
}

interface Reply { status: number; body: any }
async function call(method: string, route: string, body?: unknown, as: 'token' | 'cookie' = 'token'): Promise<Reply> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (as === 'token') headers['x-fryday-core-token'] = secret;
  else { headers['Cookie'] = cookie; headers['Origin'] = base; }
  const res = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

async function detail(id: string): Promise<any> {
  const { body } = await call('GET', `/api/tasks/${id}`);
  let note = '';
  try { note = String(JSON.parse(body.task.metadata_json ?? '{}').note ?? ''); } catch { /* no note */ }
  return { ...body, ...body.task, note };
}

const SETTLED = new Set(['waiting_owner', 'awaiting_approval', 'needs_owner', 'failed']);
async function settle(id: string, minutes = 20): Promise<any> {
  const deadline = Date.now() + minutes * 60_000;
  let last = '';
  for (;;) {
    const task = await detail(id);
    const line = `${task.state}: ${task.note.split('\n')[0]}`;
    if (line !== last) { console.log(`      ${id} ${line}`); last = line; }
    const running = (task.runs as Array<{ state: string }>).some((r) => r.state === 'running');
    if (SETTLED.has(task.state) && !running) return task;
    if (Date.now() > deadline) throw new Error(`${id} did not settle in ${minutes} minutes (still ${task.state})`);
    await sleep(3000);
  }
}

async function addProject(p: Scratch): Promise<string> {
  const detected = await call('POST', '/api/projects/detect', { path: p.clone });
  const { runProfile: _r, deployer: _d, deployerConfig: _c, ...facts } = detected.body.facts;
  const added = await call('POST', '/api/projects', { ...facts, verified: true });
  if (added.status !== 201) throw new Error(`could not add ${p.clone}: ${JSON.stringify(added.body)}`);
  return facts.id as string;
}

async function newTask(title: string, description: string, opts: { repoId?: string; branch?: string; files?: Array<{ name: string; content: Buffer }> } = {}): Promise<string> {
  const created = await call('POST', '/api/tasks', { title, description, start: false });
  const id = created.body.id as string;
  for (const file of opts.files ?? []) {
    const up = await fetch(`${base}/api/tasks/${id}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), 'x-fryday-core-token': secret },
      body: file.content,
    });
    if (!up.ok) throw new Error(`upload of ${file.name} failed: ${await up.text()}`);
  }
  const started = await call('POST', `/api/tasks/${id}/start`, { ...(opts.repoId ? { repoId: opts.repoId } : {}), ...(opts.branch ? { branch: opts.branch } : {}) });
  if (started.status !== 202) throw new Error(`${id} did not start: ${JSON.stringify(started.body)}`);
  return id;
}

/** Approve the task's open ticket as the owner at the UI, and wait for what that started. */
async function approve(id: string): Promise<any> {
  const before = await detail(id);
  const res = await call('POST', `/api/approvals/${before.approval.id}/resolve`, { decision: 'approved' }, 'cookie');
  if (res.status !== 202) throw new Error(`approval refused: ${JSON.stringify(res.body)}`);
  for (let i = 0; i < 200; i++) {
    const now = await detail(id);
    if (now.state !== 'releasing' && now.approval.state !== 'approved') return settle(id, 10);
    await sleep(500);
  }
  return settle(id, 10);
}

async function main(): Promise<void> {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const parity = makeProject('parity-kit', {
    'package.json': '{ "name": "parity-kit", "version": "1.0.0", "description": "Helpers about odd and even numbers", "scripts": { "test": "node --test" } }\n',
    'README.md': '# parity-kit\n\nSmall helpers about odd and even numbers. No other concerns live here.\n',
    'parity.js': PARITY_JS, 'parity.test.js': PARITY_TEST,
  });
  const cart = makeProject('cart-api', {
    'package.json': '{ "name": "cart-api", "version": "1.0.0", "description": "Shopping cart totals and pricing rules", "scripts": { "test": "node --test" } }\n',
    'README.md': '# cart-api\n\nPricing for the shopping cart: subtotals, discounts and other rules about what an order costs or earns.\n',
    'price.js': PRICE_JS, 'price.test.js': PRICE_TEST,
  });
  // Existing work on the remote: one branch the owner started, one a teammate started.
  const mineBefore = remoteBranch(parity, 'feat/is-even', OWNER, { 'parity.js': `${PARITY_JS}\n// TODO(owner): finish and test\nexports.isEven = (n) => n % 2 === 0;\n` }, 'Start isEven (no tests yet)');
  const theirsBefore = remoteBranch(parity, 'feat/describe-zero', MATE, { 'parity.js': PARITY_JS.replace("(n % 2 === 0 ? 'even' : 'odd')", "(n === 0 ? 'zero' : n % 2 === 0 ? 'even' : 'odd')") }, 'Describe zero as zero (tests still to update)');

  await startCore();
  secret = fs.readFileSync(path.join(home, 'secret'), 'utf8').trim();
  const link = await call('POST', '/api/session/launch-code');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ code: link.body.code }) });
  cookie = (session.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const parityId = await addProject(parity);
  const cartId = await addProject(cart);
  check('two projects are set up', parityId === 'parity-kit' && cartId === 'cart-api');

  // 1 ─ A PRD as a PDF, no project named
  console.log('\n1. A PRD attached as a PDF, with no project named');
  const prd = pdf([
    'PRD: Loyalty points',
    'When an order is priced, the customer earns loyalty points.',
    'Rule: 3 points for every full 100 rupees of the order subtotal.',
    'Orders with a subtotal below 500 rupees earn no points at all.',
    'Add a function loyaltyPoints(subtotal) next to the existing subtotal function, with tests.',
    'Example: 499 gives 0 points, 500 gives 15 points, 1250 gives 36 points.',
  ]);
  const t1 = await newTask('Implement the attached PRD', 'Please build what the attached PRD describes.', { files: [{ name: 'Loyalty PRD.pdf', content: prd }] });
  const one = await settle(t1);
  const ws1 = one.workspaces[0];
  check('the Analyst chose the right project without being told', ws1?.repoId === 'cart-api', `worked in ${ws1?.repoId ?? 'no project'}; asked ${one.questions.length} question(s)`);
  const said = JSON.stringify(one.brief ?? {});
  check('the brief carries what only the PDF says', /\b100\b/.test(said) && /\b500\b/.test(said) && /loyaltyPoints/.test(said), (one.brief?.requirements ?? []).slice(0, 3).join(' | '));
  check('the task was built and passed review', one.state === 'awaiting_approval', `${one.state}: ${one.note.split('\n')[0]}`);
  // The code was written by an agent, so it is tried out inside the sandbox, like everything else it wrote.
  let points = '';
  if (ws1 && fs.existsSync(ws1.worktreePath)) {
    fs.mkdirSync(path.join(root, 'scratch'), { recursive: true });
    const tried = await runSandboxed(`node -e "const p = require('./price'); console.log('POINTS=' + JSON.stringify([499, 500, 1250].map((n) => p.loyaltyPoints(n))))"`, {
      workspacePath: ws1.worktreePath, scratchRoot: path.join(root, 'scratch'), timeoutMs: 30_000,
    });
    points = /POINTS=(\[.*\])/.exec(tried.output)?.[1] ?? tried.output.trim().split('\n').pop() ?? '';
  }
  check("the code does what the PDF's examples say", points === '[0,15,36]', `loyaltyPoints(499, 500, 1250) = ${points}`);
  check('the PDF never became part of the change', !(ws1?.files ?? []).some((f: { path: string }) => /FRYDAY_TASK|\.pdf$/.test(f.path)));

  // 2 ─ A vague task
  console.log('\n2. A vague task');
  const t2 = await newTask('Make the helpers better', 'The parity helpers are not good enough. Improve them.', { repoId: parityId });
  const two = await settle(t2);
  const open = (two.questions as Array<{ question: string; answer: string | null }>).filter((q) => q.answer === null);
  check('it stops and asks the owner', two.state === 'waiting_owner' && open.length > 0, `${two.state}; ${open.length} question(s): ${open.map((q) => q.question).join(' | ').slice(0, 300)}`);
  check('nothing was built before the answer', two.workspaces.length === 0 && !(two.runs as Array<{ role: string }>).some((r) => r.role === 'planner' || r.role === 'coder'),
    `agents that ran: ${(two.runs as Array<{ role: string }>).map((r) => r.role).join(', ')}`);

  // 3 ─ A task that matches the owner's own branch
  console.log("\n3. A task that matches a branch the owner started");
  const t3 = await newTask('Add isEven', 'Add and export isEven(n) in parity.js: true for even whole numbers, false for odd ones. Add tests for it in parity.test.js.', { repoId: parityId });
  let three = await settle(t3);
  const branchQ = (three.questions as Array<{ id: string; kind: string; question: string; why: string; options: Array<{ value: string }> }>).find((q) => q.kind === 'branch');
  check('the owner is asked whether to continue on that branch', three.state === 'waiting_owner' && branchQ?.question === 'Continue on the existing branch feat/is-even?', branchQ ? `${branchQ.question} — ${branchQ.why}` : `${three.state}: ${three.note}`);
  if (branchQ) {
    await call('POST', `/api/tasks/${t3}/questions/${branchQ.id}/answer`, { answer: 'continue:feat/is-even' });
    three = await settle(t3);
    const ws3 = three.workspaces[0];
    check('the work was cut from the tip of that branch, on its own local branch', ws3?.baseSha === mineBefore && ws3?.targetBranch === 'feat/is-even' && ws3?.targetOwned === true && /^feat\/fryday-/.test(ws3?.branch ?? ''), `${ws3?.branch} from ${ws3?.baseRef}`);
    check('it passed review, and the next step is a push the owner must approve', three.state === 'awaiting_approval' && three.approval?.action === 'push_branch', `${three.state}: ${three.note.split('\n')[0]}`);
    const payload = JSON.parse(three.approval?.payload_json ?? '{}');
    check('the ticket lists exactly what is pushed', JSON.stringify(payload.pushes ?? []).includes('origin/feat/is-even') && (payload.pushes ?? []).length === 1, (payload.pushes ?? []).join(' | '));
    check('nothing was pushed before the yes', onRemote(parity.origin, 'feat/is-even') === mineBefore && onRemote(parity.origin, ws3.branch) === '');
    const mainBefore = onRemote(parity.origin, 'main');
    const pushed = await approve(t3);
    const tip = onRemote(parity.origin, 'feat/is-even');
    check("the new commits went to the owner's branch, on top of what was there", tip === pushed.workspaces[0].headSha && tip !== mineBefore
      && execFileSync('git', ['--git-dir', parity.origin, 'merge-base', '--is-ancestor', mineBefore, tip], { stdio: 'pipe' }).length === 0, `feat/is-even ${mineBefore.slice(0, 8)} → ${tip.slice(0, 8)}`);
    check('the branch now has the tests the task asked for', /isEven/.test(fileOnRemote(parity.origin, 'feat/is-even', 'parity.test.js')));
    check("FryDay's own branch name did not reach the remote, and production did not move", onRemote(parity.origin, ws3.branch) === '' && onRemote(parity.origin, 'main') === mainBefore);
    check('staging is a separate decision, not taken', pushed.state === 'awaiting_approval' && pushed.approval?.action === 'release_stg' && pushed.approval?.state === 'pending', pushed.note.split('\n')[0]);
  }

  // 4 ─ A teammate's branch, named by the owner
  console.log("\n4. A branch with a teammate's commits");
  const t4 = await newTask('Finish describing zero', "describe(0) should return 'zero'. The branch has the code change; update and add the tests so they cover it.", { repoId: parityId, branch: 'feat/describe-zero' });
  const four = await settle(t4);
  const ws4 = four.workspaces[0];
  check('no question: the owner named the branch', four.questions.length === 0 && ws4?.targetBranch === 'feat/describe-zero' && ws4?.targetOwned === false, `${four.state}: ${four.note.split('\n')[0]}`);
  check('it passed review', four.state === 'awaiting_approval' && four.approval?.action === 'push_branch', `${four.state}: ${four.note.split('\n')[0]}`);
  if (four.approval?.action === 'push_branch') {
    const payload = JSON.parse(four.approval.payload_json);
    check("the ticket says the teammate's branch is not pushed to", /pull request into feat\/describe-zero/.test(payload.summary) && JSON.stringify(payload.notPushed).includes('feat/describe-zero'), payload.summary);
    const done = await approve(t4);
    check("the teammate's branch is exactly where it was", onRemote(parity.origin, 'feat/describe-zero') === theirsBefore);
    check("FryDay's own branch is on the remote for a pull request", onRemote(parity.origin, ws4.branch) === done.workspaces[0].headSha && /Open a pull request/.test(done.note), done.note.split('\n')[0]);
  }

  // The owner's working copies were only ever read.
  const untouched = [parity, cart].every((p) => git(p.clone, [], 'status', '--porcelain') === '' && git(p.clone, [], 'rev-parse', '--abbrev-ref', 'HEAD') === 'main');
  check("the owner's clones were never touched", untouched);
  const usage = await Promise.all([t1, t2, t3, t4].map(async (id) => (await detail(id)).usage.costUsd as number));
  console.log(`\nCost at API prices: ${usage.map((u, i) => `task ${i + 1} $${u.toFixed(2)}`).join(', ')}; total $${usage.reduce((a, b) => a + b, 0).toFixed(2)}`);
}

main()
  .catch((err) => {
    check('the script ran to the end', false, err instanceof Error ? err.message : String(err));
    if (coreLog) console.log(`\n--- core output (end) ---\n${coreLog.slice(-3000)}`);
  })
  .finally(async () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
    if (keepRunning && core) {
      const link = await call('POST', '/api/session/launch-code').catch(() => null);
      console.log(`Core is still running (pid ${core.pid}) on ${base}. Open: ${link?.body?.url ?? '(no link)'}\nStop it with: kill ${core.pid}`);
      core.unref();
    } else {
      core?.kill('SIGTERM');
      await sleep(500);
      if (failed.length === 0) fs.rmSync(root, { recursive: true, force: true });
      else console.log(`Files kept in ${root}`);
    }
    process.exit(failed.length ? 1 : 0);
  });
