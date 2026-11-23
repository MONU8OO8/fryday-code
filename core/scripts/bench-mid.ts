/**
 * The mid-size benchmark: real agents on a generated service of about sixty files, where the
 * agents have to find the right module before they can change it. The two-file project of
 * `npm run e2e` cannot show what searching and long Builder sessions cost; this can.
 *
 *   npx tsx scripts/bench-mid.ts        (via `npm run token-bench -- --suite mid`)
 *
 * Two tasks:
 *   1. A feature: GET /orders takes a status filter, validated like the other modules do.
 *   2. The same feature seeded broken (it filters on the wrong field and its test fails): the
 *      checks fail, and the real Builder must fix it in a second round.
 *
 * Everything lives under <BENCH_HOME or ~/.fryday-code/bench-mid>, recreated each run. The
 * generated project is a scratch repository with a remote on disk; nothing is pushed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = process.env.BENCH_HOME ?? path.join(os.homedir(), '.fryday-code', 'bench-mid');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
process.env.FRYDAY_MAC_NOTIFY = 'off';
process.env.FRYDAY_HOME = root;
process.env.FRYDAY_DB = path.join(root, 'bench.db');
process.env.FRYDAY_RUNS = path.join(root, 'runs');
process.env.FRYDAY_WORKTREES = path.join(root, 'worktrees');
process.env.FRYDAY_SCRATCH = path.join(root, 'scratch');
process.env.FRYDAY_CORE_SECRET = process.env.FRYDAY_CORE_SECRET ?? randomBytes(16).toString('hex');
process.env.FRYDAY_MODEL = process.env.FRYDAY_MODEL ?? 'claude-sonnet-5-5';

/* eslint-disable import/first */
import { initDb, getDb } from '../src/db/db';
import { getConfig } from '../src/config';
import { saveProject } from '../src/registry/registry';
import { activeRunIds, stopFollowing } from '../src/runner/supervisor';
import { startTask, registerPipeline, reviewRound } from '../src/pipeline/pipeline';
import { getTask, setTaskState } from '../src/pipeline/taskState';
import { getRounds } from '../src/pipeline/rounds';
import { saveWorkspace } from '../src/pipeline/workspaces';
import { branchName, createWorkspace } from '../src/pipeline/worktrees';

const REPO = 'scratch-shop';
const origin = path.join(root, 'origin.git');
const main = path.join(root, 'main');
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Bench', '-c', 'user.email=bench@example.invalid', ...args], { encoding: 'utf8' }).trim();

// ─── The generated service ────────────────────────────────────────────────────

const LIB: Record<string, string> = {
  'src/lib/http.js': `// A tiny router: routes are { method, path, handler }; handlers get { query, params, body }.
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details || null;
  }
}

function json(status, body) {
  return { status, body };
}

function createRouter() {
  const routes = [];
  return {
    add(method, path, handler) { routes.push({ method, path, handler }); },
    async handle(method, url, body) {
      const [path, qs] = url.split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      for (const r of routes) {
        if (r.method !== method) continue;
        const params = match(r.path, path);
        if (!params) continue;
        try {
          return await r.handler({ query, params, body });
        } catch (err) {
          if (err instanceof HttpError) return json(err.status, { error: err.message, details: err.details });
          return json(500, { error: 'internal error' });
        }
      }
      return json(404, { error: 'not found' });
    },
  };
}

function match(pattern, path) {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

module.exports = { HttpError, json, createRouter };
`,
  'src/lib/validate.js': `// Small validators. Each returns the cleaned value or throws a 400 HttpError naming the field.
const { HttpError } = require('./http');

function fail(field, message) {
  throw new HttpError(400, 'validation failed', [{ field, message }]);
}

function requiredString(value, field, max = 200) {
  if (typeof value !== 'string' || value.trim() === '') fail(field, 'is required');
  if (value.length > max) fail(field, \`must be at most \${max} characters\`);
  return value.trim();
}

function positiveInt(value, field, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(field, 'must be a positive whole number');
  return n;
}

// For an optional value that must be one of a fixed list (a status, a kind, a carrier).
function oneOf(value, field, allowed) {
  if (value === undefined || value === '') return undefined;
  if (!allowed.includes(value)) fail(field, \`must be one of \${allowed.join(', ')}\`);
  return value;
}

function email(value, field) {
  const v = requiredString(value, field);
  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v)) fail(field, 'must be an email address');
  return v.toLowerCase();
}

module.exports = { requiredString, positiveInt, oneOf, email, fail };
`,
  'src/lib/pagination.js': `// page / limit from the query, and a page of a list with its totals.
const { positiveInt } = require('./validate');

const MAX_LIMIT = 100;

function pageParams(query) {
  const page = positiveInt(query.page, 'page', 1);
  const limit = Math.min(positiveInt(query.limit, 'limit', 20), MAX_LIMIT);
  return { page, limit };
}

function paginate(items, { page, limit }) {
  const total = items.length;
  const start = (page - 1) * limit;
  return { items: items.slice(start, start + limit), page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

module.exports = { pageParams, paginate, MAX_LIMIT };
`,
  'src/lib/logger.js': `// One line per event, JSON, to stdout. Never logs request bodies.
function log(level, event, fields = {}) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), level, event, ...fields }) + '\\n');
}

module.exports = {
  info: (event, fields) => log('info', event, fields),
  warn: (event, fields) => log('warn', event, fields),
  error: (event, fields) => log('error', event, fields),
};
`,
  'src/lib/ids.js': `// Short, sortable ids: a prefix, the time, and a counter.
let counter = 0;
function newId(prefix) {
  counter = (counter + 1) % 100000;
  return \`\${prefix}_\${Date.now().toString(36)}\${counter.toString(36).padStart(3, '0')}\`;
}
module.exports = { newId };
`,
};

interface Mod { name: string; entity: string; fields: Array<[string, string]>; extra: string; seed: string }

const MODULES: Mod[] = [
  { name: 'users', entity: 'user', fields: [['email', 'email'], ['name', 'requiredString']], extra: `
function findByEmail(email) {
  return store.all().find((u) => u.email === email) || null;
}`, seed: `{ id: 'u1', email: 'ana@example.invalid', name: 'Ana' }, { id: 'u2', email: 'bo@example.invalid', name: 'Bo' }` },
  { name: 'orders', entity: 'order', fields: [['userId', 'requiredString'], ['item', 'requiredString']], extra: `
const STATUSES = ['pending', 'paid', 'shipped', 'cancelled'];

function cancel(id) {
  const order = get(id);
  if (order.status === 'shipped') throw new HttpError(409, 'a shipped order cannot be cancelled');
  return store.update(id, { status: 'cancelled' });
}`, seed: `{ id: 'o1', userId: 'u1', item: 'lamp', status: 'pending' }, { id: 'o2', userId: 'u1', item: 'desk', status: 'paid' }, { id: 'o3', userId: 'u2', item: 'chair', status: 'shipped' }, { id: 'o4', userId: 'u2', item: 'rug', status: 'cancelled' }, { id: 'o5', userId: 'u1', item: 'shelf', status: 'paid' }` },
  { name: 'shipping', entity: 'shipment', fields: [['orderId', 'requiredString'], ['address', 'requiredString']], extra: `
const CARRIERS = ['post', 'courier', 'pickup'];

function listByCarrier(query) {
  const carrier = oneOf(query.carrier, 'carrier', CARRIERS);
  const all = store.all();
  return carrier ? all.filter((s) => s.carrier === carrier) : all;
}`, seed: `{ id: 's1', orderId: 'o3', address: '1 High St', carrier: 'post' }` },
  { name: 'payments', entity: 'payment', fields: [['orderId', 'requiredString'], ['method', 'requiredString']], extra: `
function refund(id) {
  const p = get(id);
  if (p.refunded) throw new HttpError(409, 'already refunded');
  return store.update(id, { refunded: true });
}`, seed: `{ id: 'p1', orderId: 'o2', method: 'card', refunded: false }` },
  { name: 'inventory', entity: 'stockItem', fields: [['sku', 'requiredString'], ['location', 'requiredString']], extra: `
function lowStock(threshold = 5) {
  return store.all().filter((s) => (s.count || 0) < threshold);
}`, seed: `{ id: 'i1', sku: 'LAMP-1', location: 'A1', count: 3 }` },
  { name: 'notifications', entity: 'notification', fields: [['userId', 'requiredString'], ['message', 'requiredString']], extra: `
function markRead(id) {
  return store.update(id, { read: true });
}`, seed: `{ id: 'n1', userId: 'u1', message: 'Your order shipped', read: false }` },
  { name: 'reviews', entity: 'review', fields: [['orderId', 'requiredString'], ['text', 'requiredString']], extra: `
function averageRating(items) {
  if (items.length === 0) return null;
  return items.reduce((s, r) => s + (r.rating || 0), 0) / items.length;
}`, seed: `{ id: 'r1', orderId: 'o3', text: 'Great chair', rating: 5 }` },
  { name: 'coupons', entity: 'coupon', fields: [['code', 'requiredString'], ['kind', 'requiredString']], extra: `
const KINDS = ['percent', 'fixed'];

function redeem(code) {
  const c = store.all().find((x) => x.code === code);
  if (!c) throw new HttpError(404, 'no such coupon');
  if (c.used) throw new HttpError(409, 'coupon already used');
  return store.update(c.id, { used: true });
}`, seed: `{ id: 'c1', code: 'SAVE10', kind: 'percent', used: false }` },
  { name: 'catalog', entity: 'product', fields: [['title', 'requiredString'], ['category', 'requiredString']], extra: `
function search(text) {
  const t = text.toLowerCase();
  return store.all().filter((p) => p.title.toLowerCase().includes(t));
}`, seed: `{ id: 'pr1', title: 'Lamp', category: 'lighting' }, { id: 'pr2', title: 'Desk', category: 'furniture' }` },
  { name: 'invoices', entity: 'invoice', fields: [['orderId', 'requiredString'], ['currency', 'requiredString']], extra: `
function totalFor(userOrders) {
  return userOrders.length * 100;
}`, seed: `{ id: 'inv1', orderId: 'o2', currency: 'INR' }` },
  { name: 'reports', entity: 'report', fields: [['kind', 'requiredString'], ['period', 'requiredString']], extra: `
function summary() {
  return { reports: store.all().length };
}`, seed: `{ id: 'rep1', kind: 'sales', period: '2026-10' }` },
];

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

function moduleFiles(m: Mod): Record<string, string> {
  const E = cap(m.entity);
  const validated = m.fields.map(([f, v]) => `    ${f}: ${v}(body.${f}, '${f}'),`).join('\n');
  return {
    [`src/${m.name}/store.js`]: `// In-memory ${m.name}, seeded for local runs and tests.
const { newId } = require('../lib/ids');

let rows = [${m.seed}];

module.exports = {
  all: () => rows.slice(),
  get: (id) => rows.find((r) => r.id === id) || null,
  insert(fields) {
    const row = { id: newId('${m.entity.slice(0, 3)}'), ...fields };
    rows.push(row);
    return row;
  },
  update(id, fields) {
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    rows[i] = { ...rows[i], ...fields };
    return rows[i];
  },
  reset(seed) { rows = seed.slice(); },
};
`,
    [`src/${m.name}/service.js`]: `// ${E} rules. The routes call these; nothing here knows about HTTP requests.
const store = require('./store');
const { HttpError } = require('../lib/http');
const { requiredString, email, oneOf } = require('../lib/validate');
const { paginate } = require('../lib/pagination');
const logger = require('../lib/logger');

function list(page) {
  return paginate(store.all(), page);
}

function get(id) {
  const row = store.get(id);
  if (!row) throw new HttpError(404, '${m.entity} not found');
  return row;
}

function create(body) {
  const fields = {
${validated}
  };
  const row = store.insert(${m.name === 'orders' ? "{ ...fields, status: 'pending' }" : 'fields'});
  logger.info('${m.entity}.created', { id: row.id });
  return row;
}
${m.extra}

module.exports = { list, get, create${m.extra.match(/function (\w+)/g)?.map((f) => `, ${f.slice(9)}`).join('') ?? ''}${m.name === 'orders' ? ', STATUSES' : ''} };
void email; void oneOf;
`,
    [`src/${m.name}/routes.js`]: `// HTTP routes for ${m.name}.
const service = require('./service');
const { json } = require('../lib/http');
const { pageParams } = require('../lib/pagination');

function register(router) {
  router.add('GET', '/${m.name}', async ({ query }) => json(200, service.list(pageParams(query))));
  router.add('GET', '/${m.name}/:id', async ({ params }) => json(200, service.get(params.id)));
  router.add('POST', '/${m.name}', async ({ body }) => json(201, service.create(body || {})));
}

module.exports = { register };
`,
    [`test/${m.name}.test.js`]: `const { test } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');

test('${m.name}: list is paginated', async () => {
  const app = createApp();
  const res = await app.handle('GET', '/${m.name}?page=1&limit=1');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.page, 1);
});

test('${m.name}: an unknown id is a 404', async () => {
  const app = createApp();
  const res = await app.handle('GET', '/${m.name}/nope');
  assert.equal(res.status, 404);
});

test('${m.name}: create validates its fields', async () => {
  const app = createApp();
  const res = await app.handle('POST', '/${m.name}', {});
  assert.equal(res.status, 400);
  assert.equal(res.body.details[0].field, '${m.fields[0]![0]}');
});
`,
  };
}

function projectFiles(): Record<string, string> {
  const files: Record<string, string> = { ...LIB };
  for (const m of MODULES) Object.assign(files, moduleFiles(m));
  files['src/app.js'] = `// Wires every module's routes into one router.
const { createRouter } = require('./lib/http');
const MODULES = [${MODULES.map((m) => `'${m.name}'`).join(', ')}];

function createApp() {
  const router = createRouter();
  for (const name of MODULES) require(\`./\${name}/routes\`).register(router);
  return router;
}

module.exports = { createApp, MODULES };
`;
  files['package.json'] = '{"name":"scratch-shop","version":"1.0.0","private":true,"scripts":{"test":"node --test"}}\n';
  files['README.md'] = `# scratch-shop

A small shop backend. CommonJS, no dependencies. Tests: \`node --test\`.

## Layout

- \`src/lib/\`: the router (\`http.js\`), validators (\`validate.js\`), pagination, logging, ids.
- \`src/<module>/\`: \`routes.js\` (HTTP), \`service.js\` (rules), \`store.js\` (in-memory data).
- \`test/\`: one file per module.

## Conventions

- Validate input in the service with \`lib/validate.js\`; an optional value from a fixed list uses \`oneOf\`.
- Lists are paginated with \`lib/pagination.js\` (\`page\`, \`limit\`).
- Errors are \`HttpError\` with a status; validation errors are 400 with \`details\`.
`;
  files['docs/api.md'] = `# API\n\n${MODULES.map((m) => `## ${cap(m.name)}\n\n- GET /${m.name}?page&limit\n- GET /${m.name}/:id\n- POST /${m.name}\n`).join('\n')}`;
  return files;
}

const TASK = {
  title: 'Filter the orders list by status',
  description: 'GET /orders should accept an optional `status` query parameter (one of pending, paid, shipped, cancelled) and return only orders with that status, still paginated. An unknown status must be a 400 validation error naming the `status` field, the same way other modules validate a value from a fixed list. Without `status` the list is unchanged. Add tests for the filter, for pagination together with the filter, and for the 400.',
};
const SEEDED_PLAN = {
  summary: 'GET /orders takes an optional status filter, validated with oneOf, applied before pagination.',
  approach: 'In src/orders/routes.js pass query.status to the service; in src/orders/service.js validate it with oneOf against STATUSES and filter before paginate. Tests in test/orders.test.js.',
  flow: [{ step: 'route', detail: 'GET /orders → service.list(page, query.status)' }, { step: 'filter', detail: 'oneOf(status) → filter by order.status → paginate' }],
  files: ['src/orders/routes.js', 'src/orders/service.js', 'test/orders.test.js'],
  criteria: [
    'GET /orders?status=paid returns only orders whose status is paid',
    'GET /orders?status=paid&limit=1 returns one item and total equal to the number of paid orders',
    'GET /orders?status=lost returns 400 with details[0].field equal to "status"',
    'GET /orders without status returns all orders as before, and the existing tests still pass',
  ],
  testPlan: ['node --test'],
  risks: [],
  questions: [],
};

function setupRepo(): void {
  fs.mkdirSync(main, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'release', origin]);
  execFileSync('git', ['init', '-q', '-b', 'release', main]);
  sh(main, 'config', 'user.name', 'Bench');
  sh(main, 'config', 'user.email', 'bench@example.invalid');
  for (const [file, text] of Object.entries(projectFiles())) {
    fs.mkdirSync(path.dirname(path.join(main, file)), { recursive: true });
    fs.writeFileSync(path.join(main, file), text);
  }
  sh(main, 'add', '-A');
  sh(main, 'commit', '-q', '-m', 'init');
  sh(main, 'remote', 'add', 'origin', origin);
  sh(main, 'push', '-q', '-u', 'origin', 'release');
}

let seq = 0;
function addTask(suffix: string): string {
  const id = `T-${++seq}`;
  getDb().prepare(`INSERT INTO tasks (id, seq, title, description, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`)
    .run(id, seq, `${TASK.title} (${suffix})`, TASK.description, Date.now(), Date.now());
  return id;
}

async function rest(id: string): Promise<string> {
  const started = Date.now();
  const resting = new Set(['awaiting_approval', 'needs_owner', 'failed']);
  let last = '';
  while (!resting.has(getTask(id)!.state) || activeRunIds().length > 0) {
    const t = getTask(id)!;
    const line = `${t.state}: ${JSON.parse(t.metadata_json ?? '{}').note ?? ''}`;
    if (line !== last) { console.log(`   ${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s  ${line}`); last = line; }
    if (Date.now() - started > 30 * 60_000) throw new Error(`${id} did not finish in 30 minutes`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return getTask(id)!.state;
}

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function branchFile(id: string, file: string): string {
  const ws = getDb().prepare('SELECT branch FROM task_workspaces WHERE task_id = ?').get(id) as { branch: string } | undefined;
  try { return ws ? sh(main, 'show', `${ws.branch}:${file}`) : ''; } catch { return ''; }
}

async function mainFlow(): Promise<number> {
  setupRepo();
  initDb(process.env.FRYDAY_DB!);
  registerPipeline();
  saveProject({ id: REPO, name: 'Scratch shop', localPath: main, prodBranch: 'release', testCmd: 'node --test', verified: true });
  console.log(`model: ${process.env.FRYDAY_MODEL} · ${Object.keys(projectFiles()).length} files\n`);

  console.log('1. Feature on a mid-size project (real Understander, Planner, Builder, Checker)');
  const t1 = addTask('feature');
  startTask(t1, REPO);
  const s1 = await rest(t1);
  check(s1 === 'awaiting_approval' && getRounds(t1).at(-1)?.outcome === 'passed', 'ends ready for approval with the last round passed', `${s1} after ${getRounds(t1).length} round(s)`);
  check(/status/.test(branchFile(t1, 'src/orders/service.js')), 'the orders service filters by status');

  console.log('\n2. The same feature seeded broken: the real Builder must fix it');
  const t2 = addTask('seeded failure');
  const task = getTask(t2)!;
  setTaskState(t2, 'workspace', 'Setting up a workspace (seeded scenario)');
  const ws = await createWorkspace({ taskId: t2, repo: { id: REPO, localPath: main, prodBranch: 'release' }, branch: branchName(t2, task.title), worktreesRoot: getConfig().workspaceDir });
  saveWorkspace(ws);
  getDb().prepare('UPDATE tasks SET plan_json = ? WHERE id = ?').run(JSON.stringify(SEEDED_PLAN), t2);
  setTaskState(t2, 'coding', 'Seeded change standing in for coder round 1');
  const service = fs.readFileSync(path.join(ws.worktreePath, 'src/orders/service.js'), 'utf8')
    .replace('function list(page) {\n  return paginate(store.all(), page);\n}', "function list(page, status) {\n  const wanted = oneOf(status, 'status', STATUSES);\n  const all = store.all();\n  return paginate(wanted ? all.filter((o) => o.state === wanted) : all, page);\n}");
  fs.writeFileSync(path.join(ws.worktreePath, 'src/orders/service.js'), service);
  fs.writeFileSync(path.join(ws.worktreePath, 'src/orders/routes.js'), fs.readFileSync(path.join(ws.worktreePath, 'src/orders/routes.js'), 'utf8').replace('service.list(pageParams(query))', 'service.list(pageParams(query), query.status)'));
  fs.appendFileSync(path.join(ws.worktreePath, 'test/orders.test.js'), `
test('orders: filter by status', async () => {
  const app = createApp();
  const res = await app.handle('GET', '/orders?status=paid');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map((o) => o.status), ['paid', 'paid']);
});
`);
  await reviewRound(t2, 1);
  const s2 = await rest(t2);
  const r2 = getRounds(t2);
  check(r2[0]?.checks.some((c) => c.status === 'failed') === true && r2[0]?.outcome === 'changes_requested', 'round 1: the failing test sent it back');
  check(s2 === 'awaiting_approval' && r2.at(-1)?.outcome === 'passed', 'the Builder fixed it and the last round passed', `${s2} after ${r2.length} round(s)`);
  check(/o\.status === wanted|\.status\s*===/.test(branchFile(t2, 'src/orders/service.js')), 'it filters on status now');

  check(sh(origin, 'for-each-ref', '--format=%(refname)') === 'refs/heads/release', 'nothing was pushed');
  stopFollowing();
  console.log(failures === 0 ? '\nAll mid-size checks passed.' : `\n${failures} check(s) FAILED.`);
  return failures === 0 ? 0 : 1;
}

if (process.env.BENCH_GENERATE_ONLY === '1') { setupRepo(); console.log(main); process.exit(0); }
mainFlow().then((code) => process.exit(code), (err) => { console.error(err); process.exit(2); });
