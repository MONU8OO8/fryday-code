/**
 * Verification with REAL agents, through the API only: do the tester agents catch what
 * the repository's own tests and a code review let through?
 *
 *   npm run verify                    (uses FRYDAY_MODEL if set, else claude-sonnet-5-5)
 *   npm run verify -- --keep-running  leave core up afterwards and print a link to look at it
 *
 * Two tasks on two scratch projects, each with a bug planted in the first round:
 *   1. A backend change whose unit tests pass, but the route does not use the tested
 *      function, and a price was copied wrong. Only using the API shows it, and the
 *      staging data confirms the price. The API tester must catch both and send the round back.
 *   2. A page change that adds the new button and, in passing, breaks the button that
 *      was already there. Only clicking in a browser shows it. The UI tester must catch it.
 *
 * How the bug is planted: for the FIRST coder round of each task a stand-in writes a
 * prepared change instead of a real coder, and for the first review a stand-in passes
 * it, so the testers are the only thing between the bug and the owner. Everything else
 * is real: the Analyst, the Planner, the testers, and from round 2 the Coder and the
 * Reviewer, who have to fix it from what the tester reported.
 *
 * Everything lives under ~/.fryday-code/verify-check; the remotes are folders on disk and
 * the "staging database" is a SQLite file behind a stand-in MCP server.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import { findOnPath } from '../src/config';
import { startService, portInUse } from '../src/verify/service';
import { validateRunProfile } from '../src/verify/profile';

const root = path.join(os.homedir(), '.fryday-code', 'verify-check');
const home = path.join(root, 'state');
const seedDir = path.join(root, 'seed');
const stagingDb = path.join(root, 'billing-staging.sqlite');
const claudeSettings = path.join(root, 'claude.json');
const PORT = 7495;
const base = `http://127.0.0.1:${PORT}`;
const MODEL = process.env.FRYDAY_MODEL ?? 'claude-sonnet-5-5';
const keepRunning = process.argv.includes('--keep-running');

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail.replace(/\s+/g, ' ').slice(0, 400)}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OWNER = ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid'];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...OWNER, ...args], { encoding: 'utf8' }).trim();

// ─── Scratch projects ─────────────────────────────────────────────────────────

interface Scratch { clone: string; origin: string }
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
}
function makeProject(name: string, files: Record<string, string>): Scratch {
  const clone = path.join(root, name);
  const origin = path.join(root, `${name}.git`);
  fs.mkdirSync(clone, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  git(clone, 'config', 'user.email', 'owner@example.invalid');
  git(clone, 'config', 'user.name', 'Owner');
  writeFiles(clone, files);
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'first version');
  git(clone, 'remote', 'add', 'origin', origin);
  git(clone, 'push', '-q', 'origin', 'main');
  git(clone, 'fetch', '-q', 'origin');
  git(clone, 'remote', 'set-head', 'origin', 'main');
  return { clone, origin };
}

// 1 ─ a small backend: plans and invoices
const PLANS_JSON = (pro: number) => `${JSON.stringify([{ id: 1, name: 'Free', price: 0 }, { id: 2, name: 'Pro', price: pro }, { id: 3, name: 'Team', price: 1499 }], null, 2)}\n`;
const PLANS_FILES: Record<string, string> = {
  'package.json': '{ "name": "plans-api", "version": "1.0.0", "description": "Subscription plans and what they cost", "scripts": { "start": "node server.js", "test": "node --test" } }\n',
  'README.md': '# plans-api\n\nSubscription plans and invoices.\n\n- `GET /plans` — the plans with their monthly price in rupees.\n- `GET /invoice?plan=<id>&seats=<n>` — what that many seats of a plan cost.\n\nPrices are mastered in the billing database (table `plans`). `data/plans.json` is this service\'s copy and must match it.\n\nStart it with `npm start`; it listens on `PORT`.\n',
  'data/plans.json': PLANS_JSON(499),
  'src/plans.js': "const plans = require('../data/plans.json');\n\nexports.list = () => plans;\nexports.find = (id) => plans.find((p) => p.id === id);\n",
  'src/invoice.js': "/** What `seats` seats of a plan cost for one month, in rupees. */\nexports.monthly = (plan, seats) => plan.price * seats;\n",
  'test/invoice.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst invoice = require('../src/invoice');\n\ntest('a month of seats', () => {\n  assert.equal(invoice.monthly({ price: 499 }, 3), 1497);\n});\n",
  'server.js': `const http = require('http');
const plans = require('./src/plans');
const invoice = require('./src/invoice');

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/plans') return send(res, 200, plans.list());
  if (req.method === 'GET' && url.pathname === '/invoice') {
    const plan = plans.find(Number(url.searchParams.get('plan')));
    const seats = Number(url.searchParams.get('seats'));
    if (!plan) return send(res, 404, { error: 'unknown plan' });
    if (!Number.isInteger(seats) || seats < 1) return send(res, 400, { error: 'seats must be a whole number of at least 1' });
    return send(res, 200, { plan: plan.name, seats, total: invoice.monthly(plan, seats) });
  }
  send(res, 404, { error: 'not found' });
}).listen(Number(process.env.PORT || 3000), '127.0.0.1');
`,
};
/** The planted first round: the tested function is right, the route does not use it, and a price is mistyped. */
const PLANS_SEEDED: Record<string, string> = {
  'data/plans.json': PLANS_JSON(594),
  'src/invoice.js': `${PLANS_FILES['src/invoice.js']}\n/** A year of seats: two months are free. */\nexports.annual = (plan, seats) => plan.price * 10 * seats;\n`,
  'test/invoice.test.js': `${PLANS_FILES['test/invoice.test.js']}\ntest('a year of seats has two months free', () => {\n  assert.equal(invoice.annual({ price: 499 }, 3), 14970);\n});\n`,
  'server.js': PLANS_FILES['server.js']!.replace(
    "    return send(res, 200, { plan: plan.name, seats, total: invoice.monthly(plan, seats) });",
    "    const cycle = url.searchParams.get('cycle') || 'monthly';\n    if (cycle !== 'monthly' && cycle !== 'annual') return send(res, 400, { error: 'cycle must be monthly or annual' });\n    const total = cycle === 'annual' ? invoice.monthly(plan, seats) * 12 : invoice.monthly(plan, seats);\n    return send(res, 200, { plan: plan.name, seats, cycle, total });",
  ),
};
const PLANS_TASK = {
  title: 'Annual billing for invoices',
  description: [
    'Add yearly billing to GET /invoice.',
    '- With cycle=annual the total is for a whole year with two months free: 10 × the plan\'s monthly price × seats.',
    '- With cycle=monthly, or with no cycle at all, the answer is exactly what it is today.',
    '- Any other cycle is a 400 with an error message.',
    '- The response says which cycle was used.',
    'Also: the Pro plan now costs 549 a month. The billing staging database (table `plans`) already has it and is the source of truth for prices. Update this service\'s copy in data/plans.json, so that GET /plans returns the same names and prices as that table.',
  ].join('\n'),
};

// 2 ─ a small web shop
const CART_APP = `async function refreshCart() {
  const cart = await (await fetch('/api/cart')).json();
  document.getElementById('cart-count').textContent = cart.count;
  document.getElementById('cart-total').textContent = cart.total;
}

async function addToCart(id) {
  await fetch('/api/cart/add?id=' + id, { method: 'POST' });
  await refreshCart();
}

async function loadItems() {
  const items = await (await fetch('/api/items')).json();
  const list = document.getElementById('items');
  list.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.innerHTML = item.name + ' — ₹' + item.price + ' <button onclick="addToCart(' + item.id + ')">Add to cart</button>';
    list.appendChild(li);
  }
}

loadItems();
refreshCart();
`;
const CART_HTML = (extra = '') => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Corner shop</title>
<style>body { font-family: system-ui, sans-serif; margin: 2rem; } button { margin-left: .5rem; } #summary { margin-bottom: 1rem; font-weight: 600; }</style>
</head>
<body>
  <h1>Corner shop</h1>
  <div id="summary">Cart: <span id="cart-count">0</span> items · ₹<span id="cart-total">0</span>${extra}</div>
  <ul id="items"></ul>
  <script src="/app.js"></script>
</body>
</html>
`;
const CART_SERVER = (extraRoute = '') => `const http = require('http');
const fs = require('fs');
const path = require('path');
const cart = require('./src/cart');

const ITEMS = [{ id: 1, name: 'Tea', price: 120 }, { id: 2, name: 'Biscuits', price: 45 }, { id: 3, name: 'Honey', price: 310 }];
const state = cart.create();
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const file = (res, name, type) => { res.writeHead(200, { 'content-type': type }); res.end(fs.readFileSync(path.join(__dirname, 'public', name))); };
const summary = () => ({ count: cart.count(state), total: cart.total(state) });

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return file(res, 'index.html', 'text/html; charset=utf-8');
  if (url.pathname === '/app.js') return file(res, 'app.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/api/items') return json(res, 200, ITEMS);
  if (url.pathname === '/api/cart' && req.method === 'GET') return json(res, 200, summary());
  if (url.pathname === '/api/cart/add' && req.method === 'POST') {
    const item = ITEMS.find((i) => i.id === Number(url.searchParams.get('id')));
    if (!item) return json(res, 404, { error: 'unknown item' });
    cart.add(state, item);
    return json(res, 200, summary());
  }
${extraRoute}  json(res, 404, { error: 'not found' });
}).listen(Number(process.env.PORT || 3000), '127.0.0.1');
`;
const CART_JS = "exports.create = () => ({ items: [] });\nexports.add = (cart, item) => { cart.items.push(item); return cart; };\nexports.count = (cart) => cart.items.length;\nexports.total = (cart) => cart.items.reduce((sum, item) => sum + item.price, 0);\n";
const CART_TEST = "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst cart = require('../src/cart');\n\ntest('adding items counts and totals them', () => {\n  const c = cart.create();\n  cart.add(c, { price: 120 });\n  cart.add(c, { price: 45 });\n  assert.equal(cart.count(c), 2);\n  assert.equal(cart.total(c), 165);\n});\n";
const CART_FILES: Record<string, string> = {
  'package.json': '{ "name": "cart-web", "version": "1.0.0", "description": "A small web shop with a cart", "scripts": { "start": "node server.js", "test": "node --test" } }\n',
  'README.md': '# cart-web\n\nA one-page shop: a list of items, an "Add to cart" button on each, and a cart summary at the top.\n\nStart it with `npm start`; it listens on `PORT`. The page is `public/index.html` with `public/app.js`.\n',
  'src/cart.js': CART_JS,
  'test/cart.test.js': CART_TEST,
  'server.js': CART_SERVER(),
  'public/index.html': CART_HTML(),
  'public/app.js': CART_APP,
};
/** The planted first round: the new button works, and a rename leaves the old buttons calling a function that is gone. */
const CART_SEEDED: Record<string, string> = {
  'src/cart.js': `${CART_JS}exports.clear = (cart) => { cart.items.length = 0; return cart; };\n`,
  'test/cart.test.js': `${CART_TEST}\ntest('clearing empties the cart', () => {\n  const c = cart.create();\n  cart.add(c, { price: 120 });\n  cart.clear(c);\n  assert.equal(cart.count(c), 0);\n  assert.equal(cart.total(c), 0);\n});\n`,
  'server.js': CART_SERVER("  if (url.pathname === '/api/cart/clear' && req.method === 'POST') {\n    cart.clear(state);\n    return json(res, 200, summary());\n  }\n"),
  'public/index.html': CART_HTML(' <button id="clear-cart" onclick="clearCart()">Clear cart</button>'),
  'public/app.js': CART_APP
    .replace('async function addToCart(id) {', 'async function addItem(id) {')
    .replace('async function loadItems() {', "async function clearCart() {\n  await fetch('/api/cart/clear', { method: 'POST' });\n  await refreshCart();\n}\n\nasync function loadItems() {"),
};
const CART_TASK = {
  title: 'Clear cart button',
  description: 'Add a "Clear cart" button next to the cart summary at the top of the page. Clicking it empties the cart: the item count and the total both go back to 0. Adding items with the "Add to cart" buttons keeps working exactly as before.',
};

// ─── Planting the first round ─────────────────────────────────────────────────

/** A stand-in agent: writes prepared files (coder) or returns a prepared verdict (reviewer), in the CLI's own output format. */
const SEEDED_AGENT = `import fs from 'node:fs';
import path from 'node:path';
const [mode, seed] = process.argv.slice(2);
fs.readFileSync(0, 'utf8');
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
let structured;
if (mode === 'coder') {
  const from = path.join(seed, 'files');
  for (const rel of fs.readdirSync(from, { recursive: true })) {
    const source = path.join(from, rel);
    if (!fs.statSync(source).isFile()) continue;
    fs.mkdirSync(path.dirname(rel), { recursive: true });
    fs.copyFileSync(source, rel);
  }
} else {
  structured = JSON.parse(fs.readFileSync(path.join(seed, 'verdict.json'), 'utf8'));
}
emit({ type: 'assistant', message: { id: 'msg_planted_' + process.pid, role: 'assistant', model: 'planted-stand-in', content: [{ type: 'text', text: 'Planted stand-in for the verification check.' }], usage } });
emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', ...(structured ? { structured_output: structured } : {}), usage, total_cost_usd: 0, num_turns: 1 });
`;

function plant(taskId: string, files: Record<string, string>): void {
  const dir = path.join(seedDir, taskId);
  writeFiles(path.join(dir, 'files'), files);
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'pass', summary: 'Stand-in review for the verification check: passed without reading.', criteria: [], issues: [] }));
}

/** The `claude` that core runs: the real one, except for the first coder and the first review of a planted task. */
function writeWrapper(realClaude: string): string {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const agent = path.join(root, 'planted-agent.mjs');
  fs.writeFileSync(agent, SEEDED_AGENT);
  const wrapper = path.join(bin, 'claude');
  fs.writeFileSync(wrapper, `#!/bin/sh
SEED='${seedDir}'/"$FRYDAY_TASK_ID"
if [ "$FRYDAY_ROLE" = coder ] && [ -d "$SEED/files" ] && [ ! -e "$SEED/coder.done" ]; then
  : > "$SEED/coder.done"
  exec '${process.execPath}' '${agent}' coder "$SEED"
fi
if [ "$FRYDAY_ROLE" = tester ] && [ -f "$SEED/verdict.json" ] && [ ! -e "$SEED/reviewer.done" ]; then
  : > "$SEED/reviewer.done"
  exec '${process.execPath}' '${agent}' reviewer "$SEED"
fi
exec '${realClaude}' "$@"
`, { mode: 0o755 });
  return wrapper;
}

// ─── Core, and the API ────────────────────────────────────────────────────────

let core: ChildProcess | null = null;
let coreLog = '';
let secret = '';
let cookie = '';

async function startCore(claudeBin: string): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, FRYDAY_HOME: home, FRYDAY_MAC_NOTIFY: 'off', FRYDAY_PORT: String(PORT), FRYDAY_MODEL: MODEL, CLAUDE_BIN: claudeBin, FRYDAY_CLAUDE_SETTINGS: claudeSettings,
    // On a Mac that is short of memory core holds each check back for up to ten minutes. These projects are tiny, so one minute is plenty here.
    FRYDAY_MEMORY_WAIT_MS: process.env.FRYDAY_MEMORY_WAIT_MS ?? '60000',
  };
  for (const key of ['FRYDAY_CORE_SECRET', 'FRYDAY_DB', 'FRYDAY_RUNS', 'FRYDAY_WORKTREES', 'FRYDAY_SCRATCH', 'FRYDAY_SEED', 'FRYDAY_DEPS', 'FRYDAY_REPOS', 'FRYDAY_ATTACHMENTS', 'FRYDAY_EVIDENCE']) delete env[key];
  core = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: path.join(__dirname, '..'), env, stdio: keepRunning ? 'ignore' : ['ignore', 'pipe', 'pipe'], detached: keepRunning });
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

const SETTLED = new Set(['awaiting_approval', 'needs_owner', 'failed']);
/** Follow tasks to the end. A question from the Analyst is answered with "go ahead on your assumptions". */
async function settleAll(ids: string[], minutes = 60): Promise<Record<string, any>> {
  const deadline = Date.now() + minutes * 60_000;
  const last: Record<string, string> = {};
  const done: Record<string, any> = {};
  while (Object.keys(done).length < ids.length) {
    for (const id of ids.filter((i) => !done[i])) {
      const task = await detail(id);
      const line = `${task.state}: ${task.note.split('\n')[0]}`;
      if (line !== last[id]) { console.log(`      ${id} ${line}`); last[id] = line; }
      const running = (task.runs as Array<{ state: string }>).some((r) => r.state === 'running');
      if (task.state === 'waiting_owner' && !running) {
        console.log(`      ${id} asked: ${(task.questions as Array<{ question: string; answer: string | null }>).filter((q) => q.answer === null).map((q) => q.question).join(' | ').slice(0, 300)}`);
        await call('POST', `/api/tasks/${id}/questions/skip`, {});
      } else if (SETTLED.has(task.state) && !running) done[id] = task;
    }
    if (Date.now() > deadline) throw new Error(`not settled in ${minutes} minutes: ${ids.filter((i) => !done[i]).map((i) => `${i} ${last[i]}`).join('; ')}`);
    await sleep(3000);
  }
  return done;
}

async function addProject(p: Scratch, runProfile: Record<string, unknown>): Promise<string> {
  const detected = await call('POST', '/api/projects/detect', { path: p.clone });
  const { runProfile: _r, deployer: _d, deployerConfig: _c, ...facts } = detected.body.facts;
  const added = await call('POST', '/api/projects', { ...facts, runProfile, verified: true });
  if (added.status !== 201) throw new Error(`could not add ${p.clone}: ${JSON.stringify(added.body)}`);
  return facts.id as string;
}

async function newTask(task: { title: string; description: string }, repoId: string): Promise<string> {
  const created = await call('POST', '/api/tasks', { ...task, repoId });
  if (created.status !== 201 && created.status !== 202) throw new Error(`task not created: ${JSON.stringify(created.body)}`);
  return created.body.id as string;
}

interface Round { round: number; outcome: string | null; verify: any; checks: Array<{ name: string; status: string }>; verdict: any }
const toolCount = (runs: any[], role: string, round: number, prefix: string): number => {
  const run = runs.filter((r) => r.role === role && r.round === round).at(-1);
  const tally = run?.tools_json ? (JSON.parse(run.tools_json) as Record<string, number>) : {};
  return Object.entries(tally).filter(([name]) => name.startsWith(prefix)).reduce((n, [, c]) => n + c, 0);
};
/** What the coder of `round` was sent: the feedback from the round before. */
function feedbackFor(runs: any[], round: number): string {
  const run = runs.filter((r) => r.role === 'coder' && r.round === round).at(-1);
  const file = run ? path.join(home, 'runs', `${run.id}.prompt.txt`) : '';
  return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

async function main(): Promise<void> {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const realClaude = findOnPath('claude');
  if (!realClaude) throw new Error('the claude CLI was not found on PATH');

  const plans = makeProject('plans-api', PLANS_FILES);
  const cart = makeProject('cart-web', CART_FILES);
  // The "staging database": Pro now costs 549 there. The service's copy still says 499.
  const db = new Database(stagingDb);
  db.exec('CREATE TABLE plans (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL)');
  db.exec("INSERT INTO plans VALUES (1, 'Free', 0), (2, 'Pro', 549), (3, 'Team', 1499)");
  db.close();
  fs.writeFileSync(claudeSettings, JSON.stringify({
    mcpServers: { 'billing-stg-db': { command: process.execPath, args: [path.join(__dirname, '..', 'test', 'fixtures', 'sqlite-mcp.mjs'), stagingDb] } },
  }));
  plant('T-1', PLANS_SEEDED);
  plant('T-2', CART_SEEDED);

  await startCore(writeWrapper(realClaude));
  secret = fs.readFileSync(path.join(home, 'secret'), 'utf8').trim();
  const link = await call('POST', '/api/session/launch-code');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ code: link.body.code }) });
  cookie = (session.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  const plansId = await addProject(plans, { command: 'npm start', api: true, ui: false });
  const cartId = await addProject(cart, { command: 'npm start', api: false, ui: true });
  check('two projects with a run profile are set up', plansId === 'plans-api' && cartId === 'cart-web');

  // The developer grants the staging database to the backend project, read-only, one tool.
  const byToken = await call('POST', '/api/connections/data/billing-stg-db/discover', {});
  check('what agents may reach can only be decided at the UI, not by a token', byToken.status === 403, `${byToken.status}`);
  const found = await call('POST', '/api/connections/data/billing-stg-db/discover', {}, 'cookie');
  const granted = await call('PUT', '/api/connections/data/billing-stg-db', { envKind: 'staging', access: 'read_only', enabled: true, tools: [{ tool: 'query', check: 'sql' }, { tool: 'list_tables', check: 'plain' }], projects: [plansId] }, 'cookie');
  check('the staging database is granted to the backend project, read-only', found.status === 200 && granted.status === 200 && granted.body.connection?.enabled === true,
    `${found.status} ${granted.status} ${JSON.stringify(granted.body.connection?.allowed ?? granted.body)}`);
  const write = await call('PUT', '/api/connections/data/billing-stg-db', { tools: [{ tool: 'execute_write', check: 'plain' }] }, 'cookie');
  check('its write tool cannot be given to an agent', write.status === 400, JSON.stringify(write.body));

  const t1 = await newTask(PLANS_TASK, plansId);
  const t2 = await newTask(CART_TASK, cartId);
  check('the two tasks are the ones the bugs were planted for', t1 === 'T-1' && t2 === 'T-2', `${t1} ${t2}`);
  console.log('\nRunning both tasks (real agents; the first coder round and first review of each are planted)…');
  const done = await settleAll([t1, t2]);

  // 1 ─ the backend bug
  console.log('\n1. A backend bug that the unit tests miss');
  const one = done[t1];
  const r1 = one.rounds as Round[];
  const first = r1[0];
  check('the planted change passed the repository\'s own tests', first?.checks.some((c) => c.name === 'test' && c.status === 'passed') === true, JSON.stringify(first?.checks.map((c) => `${c.name}:${c.status}`)));
  check('and passed review (the stand-in), so only the tester was left', first?.verdict?.verdict === 'pass' && fs.existsSync(path.join(seedDir, 'T-1', 'coder.done')) && fs.existsSync(path.join(seedDir, 'T-1', 'reviewer.done')));
  const api1 = first?.verify?.testers?.find((t: any) => t.kind === 'api');
  check('the service was started from the change', first?.verify?.service?.command === 'npm start', JSON.stringify(first?.verify?.service ?? first?.verify?.startFailure ?? null));
  check('the API tester used the running service', (api1?.calls ?? 0) >= 2, `${api1?.calls ?? 0} requests`);
  const dataCalls = toolCount(one.runs, 'api_tester', 1, 'mcp__billing-stg-db__');
  check('and read the staging data it was granted', dataCalls >= 1 && first?.verify?.dataConnections?.includes('billing-stg-db'), `${dataCalls} database call(s)`);
  check('it found a problem and the round went back to the coder', first?.verify?.status === 'failed' && first?.outcome === 'changes_requested', `${first?.verify?.status} / ${first?.outcome}: ${api1?.report?.summary ?? ''}`);
  const said1 = JSON.stringify(api1?.report ?? {});
  check('it caught the yearly total (the route does not give two months free)', /annual|year/i.test(said1) && /\b(12|twelve|10|ten)\b/.test(said1) && (api1?.report?.criteria ?? []).some((c: any) => c.result === 'not_met'),
    (api1?.report?.criteria ?? []).filter((c: any) => c.result === 'not_met').map((c: any) => c.evidence).join(' | '));
  check('it caught the wrong price, and checked it against the staging data', /594/.test(said1) && /549/.test(said1) && dataCalls >= 1, said1.match(/[^.|"]*549[^.|"]*/)?.[0] ?? '');
  const fb1 = feedbackFor(one.runs, 2);
  check('the coder was sent what happened, not an opinion', /failed when the service was started and used/.test(fb1) && /What the API tester found/.test(fb1) && /549/.test(fb1), fb1.slice(0, 200));

  const stagingAfter = new Database(stagingDb, { readonly: true }).prepare('SELECT id, name, price FROM plans ORDER BY id').all();
  check('the staging data is exactly as it was', JSON.stringify(stagingAfter) === '[{"id":1,"name":"Free","price":0},{"id":2,"name":"Pro","price":549},{"id":3,"name":"Team","price":1499}]', JSON.stringify(stagingAfter));
  const dbCalls = fs.existsSync(`${stagingDb}.calls.jsonl`) ? fs.readFileSync(`${stagingDb}.calls.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; args: { query?: string } }) : [];
  check('only reading statements ever reached it', dbCalls.length > 0 && dbCalls.every((c) => c.tool === 'list_tables' || (c.tool === 'query' && /^\s*(select|with|pragma table_info|explain)/i.test(c.args.query ?? ''))),
    dbCalls.map((c) => c.args.query ?? c.tool).join(' ; ').slice(0, 300));

  const last1 = r1.at(-1);
  check('with the tester\'s report, real agents fixed it and it now passes verification', one.state === 'awaiting_approval' && last1?.outcome === 'passed' && last1?.verify?.status === 'passed' && r1.length >= 2,
    `${one.state} after ${r1.length} round(s): ${one.note.split('\n')[0]}`);
  // The fix is checked here too, not only taken from the tester: the final code is started (in the sandbox) and asked.
  const ws1 = one.workspaces[0];
  let answers = '';
  if (ws1 && fs.existsSync(ws1.worktreePath)) {
    fs.mkdirSync(path.join(root, 'scratch'), { recursive: true });
    const started = await startService({ key: 'final-plans', profile: validateRunProfile({ command: 'npm start', readyPath: '/plans' }), checkoutPath: ws1.worktreePath, ownerRepoPath: plans.clone, scratchRoot: path.join(root, 'scratch'), logPath: path.join(root, 'final-plans.log') });
    if (started.ok) {
      try {
        const get = async (p: string) => { const r = await fetch(`${started.service.origin}${p}`); return `${r.status} ${await r.text()}`; };
        answers = [await get('/invoice?plan=3&seats=2&cycle=annual'), await get('/invoice?plan=3&seats=2'), await get('/invoice?plan=3&seats=2&cycle=weekly'), await get('/plans')].join(' || ');
      } finally {
        await started.service.stop();
      }
    } else answers = `did not start: ${started.detail}`;
  }
  check('the final code gives the right yearly total, the old monthly one, a 400 for an unknown cycle, and the staging price',
    /"total":29980/.test(answers) && /"total":2998[,}]/.test(answers) && / \|\| 400 /.test(answers) && /"name":"Pro","price":549/.test(answers), answers);

  // 2 ─ the UI regression
  console.log('\n2. A page regression that only shows in a browser');
  const two = done[t2];
  const r2 = two.rounds as Round[];
  const firstUi = r2[0];
  const ui1 = firstUi?.verify?.testers?.find((t: any) => t.kind === 'ui');
  check('the planted change passed the tests and the stand-in review', firstUi?.checks.some((c) => c.name === 'test' && c.status === 'passed') === true && firstUi?.verdict?.verdict === 'pass' && fs.existsSync(path.join(seedDir, 'T-2', 'reviewer.done')));
  check('the UI tester used the pages in a real browser', (ui1?.calls ?? 0) >= 3, `${ui1?.calls ?? 0} browser steps`);
  check('it found a problem and the round went back to the coder', firstUi?.verify?.status === 'failed' && firstUi?.outcome === 'changes_requested', `${firstUi?.verify?.status} / ${firstUi?.outcome}: ${ui1?.report?.summary ?? ''}`);
  const said2 = JSON.stringify(ui1?.report ?? {});
  check('it caught that "Add to cart" stopped working', /add to cart/i.test(said2) && /(addToCart|not defined|nothing|does not|did not|doesn't|didn't|no longer|stays|remain|still 0|unchanged|broken|error)/i.test(said2),
    [...(ui1?.report?.criteria ?? []).filter((c: any) => c.result === 'not_met').map((c: any) => c.evidence), ...(ui1?.report?.issues ?? []).map((i: any) => i.description)].join(' | '));
  const shots = (firstUi?.verify?.evidence ?? []) as string[];
  let shotType = '';
  if (shots[0]) {
    const res = await fetch(`${base}/api/tasks/${t2}/evidence/1/${encodeURIComponent(shots[0])}`, { headers: { 'x-fryday-core-token': secret } });
    shotType = `${res.status} ${res.headers.get('content-type')} ${(await res.arrayBuffer()).byteLength} bytes`;
  }
  check('its screenshots are kept for the owner', shots.length >= 1 && /^200 image\/png \d{4,} bytes$/.test(shotType), `${shots.length} file(s); ${shotType}`);
  const fb2 = feedbackFor(two.runs, 2);
  check('the coder was sent what the tester saw', /What the UI tester found/.test(fb2) && /add to cart/i.test(fb2), fb2.slice(0, 200));
  const last2 = r2.at(-1);
  const uiLast = last2?.verify?.testers?.find((t: any) => t.kind === 'ui');
  check('with the tester\'s report, real agents fixed it and it now passes in the browser', two.state === 'awaiting_approval' && last2?.outcome === 'passed' && last2?.verify?.status === 'passed' && r2.length >= 2 && (uiLast?.calls ?? 0) >= 3,
    `${two.state} after ${r2.length} round(s): ${two.note.split('\n')[0]}`);
  const ws2 = two.workspaces[0];
  const app = ws2 && fs.existsSync(path.join(ws2.worktreePath, 'public', 'app.js')) ? fs.readFileSync(path.join(ws2.worktreePath, 'public', 'app.js'), 'utf8') : '';
  const called = [...app.matchAll(/onclick="(\w+)\(/g)].map((m) => m[1]!);
  check('in the final code every button calls a function that exists', called.length > 0 && called.every((name) => new RegExp(`function ${name}\\b|${name}\\s*=`).test(app)) && /clearCart|clear/i.test(app), `buttons call: ${called.join(', ')}`);

  // Afterwards
  console.log('\nAfterwards');
  const ports = [...r1, ...r2].map((r) => r.verify?.service?.port).filter((p): p is number => typeof p === 'number');
  const busy = (await Promise.all(ports.map((p) => portInUse(p)))).filter(Boolean).length;
  check('no service under test is left running', ports.length >= 4 && busy === 0, `${ports.length} services were started over the rounds`);
  let browsers = '';
  try { browsers = execFileSync('pgrep', ['-f', '--', '--fryday-run='], { encoding: 'utf8' }).trim(); } catch { /* none */ }
  check('no browser is left running', browsers === '');
  const leftovers = [ws1, ws2].filter((w) => w && fs.existsSync(`${w.worktreePath}.verify`)).length;
  check('the testers\' throwaway checkouts are gone', leftovers === 0);
  const untouched = [plans, cart].every((p) => git(p.clone, 'status', '--porcelain') === '' && git(p.clone, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main');
  check("the owner's clones were never touched", untouched);
  check('nothing was pushed', [plans, cart].every((p) => execFileSync('git', ['--git-dir', p.origin, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).trim() === 'refs/heads/main'));

  const roles = (task: any) => (task.runs as Array<{ role: string; round: number; started_at: number }>).slice().sort((a, b) => a.started_at - b.started_at).map((r) => r.role).join(' → ');
  console.log(`\nAgents, task 1: ${roles(one)}\nAgents, task 2: ${roles(two)}`);
  const usage = [one, two].map((t) => t.usage.costUsd as number);
  console.log(`Cost at API prices: ${usage.map((u, i) => `task ${i + 1} $${u.toFixed(2)}`).join(', ')}; total $${usage.reduce((a, b) => a + b, 0).toFixed(2)}`);
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
