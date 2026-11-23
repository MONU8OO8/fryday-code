// The code index and what is built on it: cutting files into pieces, indexing a production
// commit from git's object store (only blobs not seen before, never a real .env), a task's own
// changes seen only by that task, keyword search, search by meaning with a stand-in model,
// fusing, diversity and packing to a budget, the diff cut to a budget, and the memory of
// finished tasks. Scratch repositories only; no real model is loaded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';

const tmp = path.join(os.tmpdir(), `fryday-index-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_INDEX_DB = path.join(tmp, 'index.db');
process.env.FRYDAY_EMBED = 'off';
process.env.FRYDAY_INDEX = 'off'; // indexed by hand below, not by the scan

import { initDb, getDb } from '../src/db/db';
import { saveProject } from '../src/registry/registry';
import { chunkFile, importsOf, indexable, tokensOf } from '../src/knowledge/index/chunk';
import { indexProject, indexState, indexTaskFiles, embedPending, blobId } from '../src/knowledge/index/indexer';
import { indexDb, closeIndex, hasVectors } from '../src/knowledge/index/store';
import { search, relevantCode, mmr, queryTerms, renderPieces, type Piece } from '../src/knowledge/index/retrieve';
import { setEmbedderForTests } from '../src/knowledge/index/embed';
import { budgetedDiff, parseDiff } from '../src/pipeline/diffBudget';
import { rememberTask, similarTasks } from '../src/knowledge/index/memory';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function scratchRepo(name: string, files: Record<string, string>): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, files);
  git(dir, 'add', '-A', '-f');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}
function write(dir: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

// Built at run time so no secret-shaped literal sits in the source.
const fakeSecret = ['sk', 'live', randomBytes(12).toString('hex')].join('_');

const CART = `import { applyDiscount } from './discount';

export function cartTotal(items: Array<{ price: number; qty: number }>, percent = 0): number {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  return applyDiscount(subtotal, percent);
}

export class Basket {
  private items: string[] = [];
  add(item: string): void {
    this.items.push(item);
  }
}
`;
const DISCOUNT = `export function applyDiscount(amount: number, percent: number): number {
  if (percent < 0 || percent > 100) throw new RangeError('percent must be between 0 and 100');
  return Math.round(amount * (1 - percent / 100));
}
`;
const HEADERS = `export function parseHeaders(raw: string): Record<string, string> {
  return Object.fromEntries(raw.split('\\n').map((l) => l.split(': ')));
}
`;

let repo = '';

before(() => {
  initDb(process.env.FRYDAY_DB!);
  repo = scratchRepo('shop', {
    'src/cart.ts': CART,
    'src/discount.ts': DISCOUNT,
    'src/http/headers.ts': HEADERS,
    'src/config.ts': `export const PAYMENT_KEY = '${fakeSecret}';\n`,
    '.env': `PAYMENT_KEY=${fakeSecret}\n`,
    'README.md': '# Shop\n\nIntro.\n\n## Discounts\n\nDiscounts are percentages.\n',
    'package-lock.json': '{}',
    'node_modules/x/index.js': 'module.exports = 1;\n',
  });
  saveProject({ id: 'shop', name: 'Shop', localPath: repo, prodBranch: 'main', verified: true });
});
after(() => { closeIndex(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ─── Cutting files ────────────────────────────────────────────────────────────

test('a file is cut at its functions and classes, keeping line numbers and names', () => {
  const pieces = chunkFile('src/cart.ts', CART);
  const total = pieces.find((p) => p.symbol?.includes('cartTotal'))!;
  assert.ok(total, JSON.stringify(pieces.map((p) => p.symbol)));
  assert.equal(CART.split('\n').slice(total.startLine - 1, total.endLine).join('\n'), total.text, 'the text is exactly those lines');
  assert.ok(total.text.includes('return applyDiscount(subtotal, percent);'));
  assert.ok(pieces.some((p) => p.symbol?.includes('Basket') && p.text.includes('this.items.push(item);')), 'a class stays whole');
  assert.equal(tokensOf('x'.repeat(40)), 10);
});

test('Python is cut at def and class, Markdown at headings, and a long function becomes overlapping windows', () => {
  const py = chunkFile('app/svc.py', 'import os\n\n@cache\ndef load(path):\n    return open(path).read()\n\nclass Store:\n    def get(self, k):\n        return k\n');
  const names = py.map((p) => p.symbol ?? '').join(', ');
  assert.ok(names.includes('load') && names.includes('Store') && !/load.*load/.test(names), names);
  const load = py.find((p) => p.symbol?.includes('load'))!;
  assert.ok(load.text.includes('@cache\ndef load(path):'), 'the decorator belongs to its function');
  const para = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i} of this part.`).join('\n');
  const md = chunkFile('README.md', `# Shop\n\n${para(10)}\n\n## Discounts\n\n${para(10)}\n`);
  assert.deepEqual(md.map((p) => p.symbol), ['Shop', 'Discounts']);
  assert.deepEqual(chunkFile('README.md', '# Shop\n\nIntro.\n\n## Discounts\n\nShort.\n').map((p) => p.symbol), ['Shop, Discounts'], 'short sections read better as one');
  const long = `export function huge() {\n${Array.from({ length: 300 }, (_, i) => `  const v${i} = ${i};`).join('\n')}\n}\n`;
  const windows = chunkFile('src/huge.ts', long);
  assert.ok(windows.length >= 5, `${windows.length} windows`);
  assert.ok(windows.every((w) => w.endLine - w.startLine + 1 <= 120));
  assert.ok(windows.every((w) => w.symbol === 'huge'), 'every window keeps the name');
  assert.ok(windows[1]!.startLine <= windows[0]!.endLine, 'windows overlap');
});

test('lockfiles, minified and generated files are not indexed; relative imports are resolved', () => {
  assert.equal(indexable('package-lock.json', 10), false);
  assert.equal(indexable('dist/app.min.js', 10), false);
  assert.equal(indexable('src/types.d.ts', 10), false);
  assert.equal(indexable('src/a.ts', 0), false);
  assert.equal(indexable('src/a.ts', 300 * 1024), false);
  assert.equal(indexable('src/a.ts', 100), true);
  assert.deepEqual(importsOf('src/cart.ts', CART, new Set(['src/cart.ts', 'src/discount.ts'])), ['src/discount.ts']);
  assert.deepEqual(importsOf('app/views.py', 'from .models import User\n', new Set(['app/models.py'])), ['app/models.py']);
});

// ─── Indexing a commit ────────────────────────────────────────────────────────

test('the production commit is indexed from git; a real .env, lockfiles and dependencies are never read; secrets are hidden', async () => {
  const state = await indexProject('shop');
  assert.equal(state!.error, null);
  assert.equal(state!.sha, git(repo, 'rev-parse', 'main'));
  const paths = (indexDb().prepare('SELECT path FROM files WHERE project_id = ? ORDER BY path').all('shop') as Array<{ path: string }>).map((r) => r.path);
  assert.deepEqual(paths, ['README.md', 'src/cart.ts', 'src/config.ts', 'src/discount.ts', 'src/http/headers.ts']);
  const all = (indexDb().prepare('SELECT text FROM chunks').all() as Array<{ text: string }>).map((r) => r.text).join('\n');
  assert.ok(!all.includes(fakeSecret), 'the secret-shaped value is hidden');
  assert.ok(all.includes('PAYMENT_KEY'), 'the name around it is kept');
  assert.deepEqual(indexDb().prepare('SELECT from_path, to_path FROM imports WHERE project_id = ?').all('shop'), [{ from_path: 'src/cart.ts', to_path: 'src/discount.ts' }]);
});

test('a new commit reads only what changed; the same commit again reads nothing', async () => {
  const blobsBefore = (indexDb().prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n;
  const again = await indexProject('shop');
  assert.equal(again!.indexedAt, indexState('shop')!.indexedAt);
  write(repo, { 'src/discount.ts': DISCOUNT.replace('RangeError', 'TypeError') });
  git(repo, 'commit', '-q', '-am', 'change');
  await indexProject('shop');
  const blobs = (indexDb().prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n;
  assert.equal(blobs, blobsBefore, 'one blob in, the replaced one collected');
  assert.equal(indexState('shop')!.sha, git(repo, 'rev-parse', 'main'));
  const text = (indexDb().prepare(`SELECT c.text FROM chunks c JOIN files f ON f.blob_sha = c.blob_sha WHERE f.path = 'src/discount.ts'`).all() as Array<{ text: string }>).map((r) => r.text).join('');
  assert.ok(text.includes('TypeError') && !text.includes('RangeError'));
  assert.equal(blobId(Buffer.from('hello\n')), createHash('sha1').update('blob 6\0hello\n').digest('hex'), "git's own blob id");
  assert.equal(blobId(Buffer.from('hello\n')), git(repo, 'hash-object', '--stdin', '-w').length ? execFileSync('git', ['hash-object', '--stdin'], { input: 'hello\n', encoding: 'utf8' }).trim() : '');
});

// ─── Searching ────────────────────────────────────────────────────────────────

test('keyword search finds the code a task is about and keeps to its budget', async () => {
  assert.deepEqual(queryTerms('Fix applyDiscount in the cartTotal').slice(0, 2).sort(), ['applydiscount', 'carttotal']);
  assert.ok(queryTerms('applyDiscount').includes('discount'), 'identifiers are split as well as kept');
  const found = await search({ projectId: 'shop', query: 'applyDiscount rejects a percent outside range', budget: 2000 });
  assert.equal(found.byMeaning, false, 'no model here: keyword only');
  assert.equal(found.pieces[0]!.path, 'src/discount.ts');
  assert.ok(found.tokens <= 2000);
  assert.ok(!found.pieces.some((p) => p.path.includes('headers')), 'unrelated code is not packed');
  const tight = await search({ projectId: 'shop', query: 'applyDiscount cartTotal Basket discount percent', budget: 60 });
  assert.ok(tight.tokens <= 60, `${tight.tokens}`);
  const pack = await relevantCode({ projectId: 'shop', query: 'applyDiscount', budget: 2000 });
  assert.match(pack, /^## Relevant code\n\nFryDay searched this project by keyword for/);
  assert.match(pack, /### src\/discount\.ts \(lines 1–4\) · applyDiscount\n```ts\n/);
  assert.equal(await relevantCode({ projectId: 'shop', query: 'zzzz qqqq', budget: 2000 }), '', 'nothing found, nothing said');
});

test('files the plan names are boosted and shown even without a matching word', async () => {
  const found = await search({ projectId: 'shop', query: 'discount percent', budget: 4000, boostPaths: ['src/http/headers.ts'] });
  assert.ok(found.pieces.some((p) => p.path === 'src/http/headers.ts'), 'a named file is in the pack');
  const withImport = await search({ projectId: 'shop', query: 'total of the items', budget: 4000, boostPaths: ['src/cart.ts'] });
  assert.equal(withImport.pieces[0]!.path, 'src/cart.ts');
});

test("a task's own changes are seen by that task only, and a file it deleted is hidden", async () => {
  const wt = path.join(tmp, 'wt');
  fs.cpSync(repo, wt, { recursive: true });
  write(wt, { 'src/loyalty.ts': 'export function loyaltyPoints(total: number): number {\n  return Math.floor(total / 100);\n}\n' });
  fs.rmSync(path.join(wt, 'src/http/headers.ts'));
  fs.writeFileSync(path.join(wt, '.env'), `X=${fakeSecret}\n`);
  getDb().prepare(`INSERT INTO tasks (id, seq, title, description, state, created_at, updated_at) VALUES ('T-9', 9, 't', 'd', 'coding', 0, 0)`).run();
  indexTaskFiles('T-9', 'shop', wt, ['src/loyalty.ts', 'src/http/headers.ts', '.env', '../outside.ts']);
  const mine = await search({ projectId: 'shop', taskId: 'T-9', query: 'loyaltyPoints', budget: 2000 });
  assert.equal(mine.pieces[0]?.path, 'src/loyalty.ts');
  const theirs = await search({ projectId: 'shop', taskId: 'T-8', query: 'loyaltyPoints', budget: 2000 });
  assert.equal(theirs.pieces.length, 0, 'another task does not see it');
  const prod = await search({ projectId: 'shop', query: 'loyaltyPoints', budget: 2000 });
  assert.equal(prod.pieces.length, 0, 'production does not see it');
  const deleted = await search({ projectId: 'shop', taskId: 'T-9', query: 'parseHeaders', budget: 2000 });
  assert.equal(deleted.pieces.length, 0, 'the task deleted it');
  const rows = indexDb().prepare(`SELECT path FROM task_files WHERE task_id = 'T-9'`).all() as Array<{ path: string }>;
  assert.ok(!rows.some((r) => r.path === '.env' || r.path.includes('..')), 'a real .env and paths outside the worktree are never read');
});

test('search by meaning with a stand-in model: vectors are made in the background and fused with keywords', async () => {
  if (!hasVectors()) { assert.fail('sqlite-vec did not load'); return; }
  // A stand-in model: a bag of words hashed into 384 numbers.
  const vec = (t: string) => {
    const v = new Array(384).fill(0);
    for (const w of t.toLowerCase().match(/[a-z]{3,}/g) ?? []) v[parseInt(createHash('md5').update(w).digest('hex').slice(0, 6), 16) % 384] += 1;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  process.env.FRYDAY_EMBED = 'on';
  setEmbedderForTests(async (texts) => ({ tolist: () => texts.map(vec) }));
  try {
    const made = await embedPending();
    assert.ok(made > 0, `${made} vectors`);
    const n = (indexDb().prepare('SELECT COUNT(*) AS n FROM chunk_vec').get() as { n: number }).n;
    assert.equal(n, (indexDb().prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n, 'every piece has a vector');
    assert.equal(await embedPending(), 0, 'nothing left to do');
    const found = await search({ projectId: 'shop', query: 'percentages discounts', budget: 3000 });
    assert.equal(found.byMeaning, true);
    assert.ok(found.pieces.some((p) => p.path === 'README.md' || p.path === 'src/discount.ts'));
  } finally {
    setEmbedderForTests(null);
    process.env.FRYDAY_EMBED = 'off';
  }
});

test('diversity: one file cannot fill the pack; neighbouring pieces of a file are shown as one block', () => {
  const p = (id: number, filePath: string, start: number, score: number, text: string): Piece => ({ id, path: filePath, startLine: start, endLine: start + 2, symbol: null, text, tokens: 10, score });
  const pieces = [p(1, 'a.ts', 1, 1.0, 'alpha beta gamma'), p(2, 'a.ts', 4, 0.99, 'alpha beta gamma'), p(3, 'a.ts', 7, 0.98, 'alpha beta gamma'), p(4, 'b.ts', 1, 0.9, 'delta epsilon')];
  const order = mmr(pieces, 4).map((x) => x.id);
  assert.equal(order[0], 1);
  assert.equal(order[1], 4, 'the other file comes before more of the same');
  const text = renderPieces([p(1, 'a.ts', 1, 1, 'l1\nl2\nl3'), p(2, 'a.ts', 4, 1, 'l4\nl5\nl6'), p(4, 'b.ts', 10, 1, 'x')]);
  assert.match(text, /### a\.ts \(lines 1–6\)\n```ts\nl1\nl2\nl3\nl4\nl5\nl6\n```/);
  assert.match(text, /### b\.ts \(lines 10–12\)/);
});

// ─── The diff within a budget ─────────────────────────────────────────────────

test('a diff over its budget keeps every file named, shows the relevant hunks first and lists the rest', () => {
  const hunk = (file: string, body: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,2 @@\n-old\n+${body}\n`;
  const patch = hunk('src/discount.ts', 'applyDiscount fixed') + hunk('src/big.ts', 'x'.repeat(5000)) + hunk('src/other.ts', 'unrelated');
  assert.equal(parseDiff(patch).length, 3);
  assert.deepEqual(budgetedDiff(patch, 100_000), { text: patch, complete: true });
  const cut = budgetedDiff(patch, 1200, 'applyDiscount must reject');
  assert.equal(cut.complete, false);
  assert.match(cut.text, /Changed files:\n src\/discount\.ts \| \+1 −1\n src\/big\.ts \| \+1 −1\n src\/other\.ts \| \+1 −1/);
  assert.ok(cut.text.includes('+applyDiscount fixed'), 'the hunk the focus names is shown');
  assert.match(cut.text, /Not shown here, to save room \(open diff\.patch for them\):\n- src\/big\.ts: 1 hunk \(line 1\)/);
  assert.ok(cut.text.length <= 1200 + 300);
});

// ─── Memory of finished tasks ─────────────────────────────────────────────────

test('a finished task is remembered, and the Planner of a like task is shown it', async () => {
  const db = getDb();
  const plan = { summary: 'Make applyDiscount reject a percent outside 0 to 100.', approach: 'Throw RangeError in src/discount.ts.', flow: [], files: ['src/discount.ts'], criteria: ['rejects 150'], testPlan: [], risks: [], questions: [] };
  db.prepare(`INSERT INTO tasks (id, seq, title, description, state, plan_json, created_at, updated_at) VALUES ('T-1', 1, 'Validate the discount percent', 'applyDiscount accepts 150 percent; it should not', 'awaiting_approval', ?, 0, 0)`).run(JSON.stringify(plan));
  db.prepare(`INSERT INTO tasks (id, seq, title, description, state, created_at, updated_at) VALUES ('T-2', 2, 'Discount percent validation for coupons', 'coupons can give more than 100 percent discount', 'planning', 0, 0)`).run();
  rememberTask('T-1');
  const shown = await similarTasks('T-2', 'shop', 'Discount percent validation for coupons: coupons can give more than 100 percent discount');
  assert.match(shown, /^## Similar past tasks\n/);
  assert.match(shown, /### T-1 · 0 rounds\nTask: Validate the discount percent/);
  assert.match(shown, /Planned: Make applyDiscount reject a percent outside 0 to 100\./);
  assert.equal(await similarTasks('T-1', 'shop', 'Validate the discount percent applyDiscount'), '', 'a task is not shown itself');
  assert.equal(await similarTasks('T-2', 'shop', 'render the login page in dark mode'), '', 'nothing alike, nothing shown');
});
