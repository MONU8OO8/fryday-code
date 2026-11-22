// Verification in the pipeline, with stand-in agents: a real service started in the
// sandbox from the coder's commit, scripted testers, and what each outcome leads to.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// The sandbox runs on macOS and on Linux; the pipeline around verification is tested on both.
const skip = !['darwin', 'linux'].includes(process.platform);
// Starting the service under test and the API and UI testers is macOS only: on Linux the sandbox gives
// the service a network of its own that core cannot reach, so the task goes to the owner instead (by
// design, serviceUnreachableReason in src/verify/service.ts; tested below on Linux).
const skipService = process.platform !== 'darwin';
const tmp = path.join(os.homedir(), '.fryday-code', `verify-test-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
const planFile = path.join(tmp, 'script.json');
const wrapper = path.join(tmp, 'claude-wrapper.sh');
fs.writeFileSync(wrapper, `#!/bin/sh\nexport FAKE_PLAN_FILE='${planFile}'\nexec node '${path.join(__dirname, 'fixtures', 'fake-claude.mjs')}' "$@"\n`, { mode: 0o755 });
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_MAC_NOTIFY = 'off';
process.env.FRYDAY_MEMORY_WAIT_MS = '0';
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_RUNS = path.join(tmp, 'runs');
process.env.FRYDAY_WORKTREES = path.join(tmp, 'worktrees');
process.env.FRYDAY_SCRATCH = path.join(tmp, 'scratch');
process.env.FRYDAY_EVIDENCE = path.join(tmp, 'evidence');
process.env.FRYDAY_CLAUDE_SETTINGS = path.join(tmp, 'claude.json');
process.env.CLAUDE_BIN = wrapper;
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';
process.env.FRYDAY_MAX_AGENTS = '2';
process.env.FRYDAY_RETRY_BACKOFF_MS = '0';

import { initDb, getDb } from '../src/db/db';
import { overrideRepo, saveProject, ProjectError } from '../src/registry/registry';
import { activeRunIds, stopFollowing } from '../src/runner/supervisor';
import { startTask, registerPipeline } from '../src/pipeline/pipeline';
import { getWorkspaces } from '../src/pipeline/workspaces';
import { getRounds } from '../src/pipeline/rounds';
import { getTask } from '../src/pipeline/taskState';
import { latestApproval, resolveApproval } from '../src/pipeline/approvals';
import { isVerifying, evidenceDir } from '../src/pipeline/verifyFlow';
import { portInUse } from '../src/verify/service';
import { findChrome } from '../src/verify/tools';
import { configureConnection, discoverConnection } from '../src/connections/store';
import { updateSettings } from '../src/settings';

const origin = path.join(tmp, 'origin.git');
const main = path.join(tmp, 'main');
const REPO = 'shop';
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();

const SERVER = `const http = require('http');
const price = require('./src/price');
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/price') return res.end(JSON.stringify({ total: price.total(Number(url.searchParams.get('qty')), 100) }));
  res.end('shop');
}).listen(Number(process.env.PORT), '127.0.0.1');
`;
const PRICE = 'exports.total = (qty, each) => qty * each;\n';
const PRICE_DISCOUNT = 'exports.total = (qty, each) => (qty >= 10 ? qty * each * 0.9 : qty * each);\n';
const PRICE_TEST = "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst p = require('../src/price');\ntest('total', () => assert.equal(p.total(2, 100), 200));\n";

const PLAN = {
  summary: 'Ten or more of an item get 10% off.',
  approach: 'Apply the discount in src/price.js.',
  flow: [{ step: 'GET /price', detail: 'server.js calls price.total' }],
  files: ['src/price.js'],
  criteria: ['GET /price?qty=10 returns total 900', 'GET /price?qty=2 still returns total 200'],
  testPlan: ['node --test', 'request /price for 2 and for 10'],
  risks: [],
  questions: [],
};
const review = { verdict: 'pass', summary: 'Reads right.', criteria: PLAN.criteria.map((criterion) => ({ criterion, met: true, evidence: 'read src/price.js' })), issues: [] };
const good = { write: { 'src/price.js': PRICE_DISCOUNT } };
const reportPass = {
  verdict: 'pass', summary: 'Both totals are right.',
  criteria: PLAN.criteria.map((criterion) => ({ criterion, result: 'met', evidence: 'GET /price → 200 with the expected total' })), issues: [], notTested: [],
};
const reportFail = {
  verdict: 'fail', summary: 'The discount is not applied at exactly ten.',
  criteria: [
    { criterion: PLAN.criteria[0], result: 'not_met', evidence: 'GET /price?qty=10 → 200 {"total":1000}, expected 900' },
    { criterion: PLAN.criteria[1], result: 'met', evidence: 'GET /price?qty=2 → 200 {"total":200}' },
  ],
  issues: [{ severity: 'blocking', where: 'GET /price', description: 'No discount at the boundary.', evidence: 'qty=10 gives 1000' }], notTested: [],
};

interface Call { role: string; call: number; prompt: string; argv: string[]; cwd: string; files?: { brief: string; patch: string }; verifyBrief?: string; fetched?: { status?: number; body?: string; error?: string }; mcpServers?: string[] }
function script(s: Record<string, unknown>) {
  for (const f of [`${planFile}.count.json`, `${planFile}.calls.jsonl`]) fs.rmSync(f, { force: true });
  fs.writeFileSync(planFile, JSON.stringify({ planner: PLAN, tester: [review], coder: [good], ...s }));
}
const calls = (): Call[] =>
  fs.existsSync(`${planFile}.calls.jsonl`) ? fs.readFileSync(`${planFile}.calls.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const roles = () => calls().map((c) => c.role);

let seq = 0;
function addTask(title: string): string {
  const id = `T-${++seq}`;
  getDb().prepare(`INSERT INTO tasks (id, seq, title, description, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, 0)`).run(id, seq, title, `${title} — details`);
  return id;
}
const note = (id: string) => JSON.parse(getTask(id)!.metadata_json ?? '{}').note as string;
const resting = new Set(['awaiting_approval', 'needs_owner', 'failed']);
async function rest(id: string, timeoutMs = 90_000): Promise<string> {
  const start = Date.now();
  while (!resting.has(getTask(id)!.state) || activeRunIds().length > 0 || isVerifying(id)) {
    if (Date.now() - start > timeoutMs) throw new Error(`${id} still ${getTask(id)!.state} after ${timeoutMs} ms: ${note(id)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return getTask(id)!.state;
}
async function run(title: string): Promise<{ id: string; state: string }> {
  const id = addTask(title);
  startTask(id, REPO);
  return { id, state: await rest(id) };
}
const profile = (change: Record<string, unknown> = {}) => overrideRepo(REPO, { runProfile: { command: 'node server.js', readyTimeoutSec: 20, ...change } });
/** Nothing of a verification may be left behind: no service, no checkout, no per-run config. */
async function assertCleanedUp(id: string, port: number | undefined): Promise<void> {
  if (port) assert.equal(await portInUse(port), false, 'the service is stopped');
  const ws = getWorkspaces(id)[0]!;
  assert.equal(fs.existsSync(`${ws.worktree_path}.verify`), false, 'the verification checkout is removed');
  const left = fs.readdirSync(process.env.FRYDAY_RUNS!).filter((f) => /\.(mcp|service|browser)\.json$/.test(f));
  assert.deepEqual(left, [], "the run's MCP config files are removed");
  assert.deepEqual(fs.existsSync(path.join(process.env.FRYDAY_SCRATCH!, 'services')) ? fs.readdirSync(path.join(process.env.FRYDAY_SCRATCH!, 'services')) : [], []);
}

before(() => {
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  fs.mkdirSync(path.join(main, 'test'), { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  sh(main, 'config', 'user.name', 'Test');
  sh(main, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(main, 'server.js'), SERVER);
  fs.writeFileSync(path.join(main, 'src', 'price.js'), PRICE);
  fs.writeFileSync(path.join(main, 'test', 'price.test.js'), PRICE_TEST);
  fs.writeFileSync(path.join(main, 'package.json'), '{"name":"shop","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules\n');
  sh(main, 'add', '-A');
  sh(main, 'commit', '-q', '-m', 'init');
  sh(main, 'remote', 'add', 'origin', origin);
  sh(main, 'push', '-q', '-u', 'origin', 'main');

  initDb(process.env.FRYDAY_DB!);
  registerPipeline();
  saveProject({ id: REPO, name: 'Shop', localPath: main, prodBranch: 'main', testCmd: 'node --test', verified: true });
  profile();
});
after(() => { stopFollowing(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('a run profile is checked when a project is saved', () => {
  assert.throws(() => overrideRepo(REPO, { runProfile: { command: '' } }), ProjectError);
  assert.throws(() => overrideRepo(REPO, { runProfile: { command: 'x', env: { PORT: '1' } } }), /Run profile: PORT is set by FryDay Code/);
  assert.equal(profile().runProfile?.['readyPath'], '/', 'stored with its defaults');
});

test('a change that passes review is started and used before the owner is asked', { skip: skipService }, async () => {
  script({ api_tester: [{ report: reportPass, calls: 4, get: '/price?qty=10' }] });
  const { id, state } = await run('Bulk discount');
  assert.equal(state, 'awaiting_approval', note(id));
  assert.deepEqual(roles(), ['analyst', 'planner', 'coder', 'tester', 'api_tester']);

  const tester = calls().at(-1)!;
  // The service the tester reached runs the coder's commit, not the base.
  assert.deepEqual(tester.fetched, { status: 200, body: '{"total":900}' });
  assert.deepEqual(tester.mcpServers, ['fryday_service'], 'no data connection is granted, so only the service tool');
  assert.match(tester.verifyBrief!, /GET \/price\?qty=10 returns total 900/);
  assert.match(tester.verifyBrief!, /mcp__fryday_service__request/);
  assert.match(tester.verifyBrief!, /Data you may read\n\nNone/);
  assert.match(tester.cwd, /\.verify$/, 'it works in its own throwaway checkout');
  assert.ok(tester.argv.includes('--mcp-config') && tester.argv.includes('--strict-mcp-config'));

  const round = getRounds(id)[0]!;
  assert.equal(round.outcome, 'passed');
  assert.equal(round.verify?.status, 'passed');
  assert.equal(round.verify?.service?.command, 'node server.js');
  assert.equal(round.verify?.service?.listen, 'loopback');
  assert.deepEqual(round.verify?.testers.map((t) => [t.kind, t.calls, t.passed]), [['api', 4, true]]);
  assert.match(note(id), /Passed checks and review in 1 round, and verified running \(API tester: 4 requests\)/);
  await assertCleanedUp(id, round.verify?.service?.port);
});

test('what a tester finds goes back to the coder with the evidence, and is checked again', { skip: skipService }, async () => {
  const offByOne = { write: { 'src/price.js': 'exports.total = (qty, each) => (qty > 10 ? qty * each * 0.9 : qty * each);\n' } };
  script({ coder: [offByOne, good], api_tester: [{ report: reportFail, get: '/price?qty=10' }, { report: reportPass, get: '/price?qty=10' }] });
  const { id, state } = await run('Bulk discount, off by one');
  assert.equal(state, 'awaiting_approval', note(id));
  assert.deepEqual(roles(), ['analyst', 'planner', 'coder', 'tester', 'api_tester', 'coder', 'tester', 'api_tester']);
  assert.deepEqual(getRounds(id).map((r) => [r.outcome, r.verify?.status]), [['changes_requested', 'failed'], ['passed', 'passed']]);

  const all = calls();
  assert.deepEqual(all[4]!.fetched, { status: 200, body: '{"total":1000}' }, 'round 1 really had the bug');
  assert.deepEqual(all[7]!.fetched, { status: 200, body: '{"total":900}' }, 'round 2 really has the fix');
  const feedback = all[5]!.prompt;
  assert.match(feedback, /failed when the service was started and used/);
  assert.match(feedback, /What the API tester found/);
  assert.match(feedback, /GET \/price\?qty=10 → 200 \{"total":1000\}, expected 900/);
  assert.match(all[7]!.verifyBrief!, /Found in an earlier round[\s\S]*expected 900/, 'the next tester is told what to check first');
  // The reviewer of round 2 is given the same facts the coder got, so it does not second-guess a fix that rests on them.
  assert.equal(all[6]!.role, 'tester');
  assert.match(all[6]!.files!.brief, /What testers saw in earlier rounds[\s\S]*not about the commit you are reviewing[\s\S]*GET \/price\?qty=10 → 200 \{"total":1000\}, expected 900/);
  assert.doesNotMatch(all[6]!.files!.brief, /^## What the API tester found/m, 'quoted feedback cannot look like a section of the brief');
  assert.doesNotMatch(all[3]!.files!.brief, /What testers saw in earlier rounds/, 'nothing of the kind in round 1');
  await assertCleanedUp(id, getRounds(id)[1]!.verify?.service?.port);
});

test('a tester whose run failed because the AI service was busy tries once more on the same service', { skip: skipService }, async () => {
  script({ api_tester: [{ report: reportPass, calls: 2, get: '/price?qty=10' }], overloaded: { api_tester: 1 } });
  const { id, state } = await run('Bulk discount, service busy');
  assert.equal(state, 'awaiting_approval', note(id));
  assert.deepEqual(roles(), ['analyst', 'planner', 'coder', 'tester', 'api_tester', 'api_tester']);
  assert.deepEqual(calls().at(-1)!.fetched, { status: 200, body: '{"total":900}' });
  const round = getRounds(id)[0]!;
  assert.equal(round.verify?.status, 'passed');
  assert.deepEqual(round.verify?.testers.map((t) => [t.kind, t.calls, t.passed]), [['api', 2, true]]);
  await assertCleanedUp(id, round.verify?.service?.port);

  // Busy twice: the owner decides, and nothing was judged.
  script({ api_tester: [{ report: reportPass }], overloaded: { api_tester: 2 } });
  const second = await run('Bulk discount, service stays busy');
  assert.equal(second.state, 'needs_owner');
  assert.match(note(second.id), /^The API tester failed: API Error: 529.*Nothing was judged\.$/s);
  assert.equal(getRounds(second.id)[0]!.verify?.status, 'error');
});

test('a report that says pass with a criterion not met is a fail', { skip: skipService }, async () => {
  const lying = { ...reportFail, verdict: 'pass', issues: [] };
  script({ api_tester: [{ report: lying }, { report: reportPass }] });
  const { id, state } = await run('Verdict against its own findings');
  assert.equal(state, 'awaiting_approval');
  assert.deepEqual(getRounds(id).map((r) => r.verify?.status), ['failed', 'passed']);
});

test('a tester that never used the service proves nothing: the owner decides', { skip: skipService }, async () => {
  script({ api_tester: [{ report: reportPass, calls: 0 }] });
  const { id, state } = await run('Report without a test');
  assert.equal(state, 'needs_owner');
  assert.match(note(id), /without once using the running service, so nothing was verified/);
  assert.equal(getRounds(id)[0]!.verify?.status, 'error');
  assert.notEqual(getRounds(id)[0]!.outcome, 'passed');
  assert.equal(getTask(id)!.state, 'needs_owner', 'unverified work is not offered for approval');
  await assertCleanedUp(id, getRounds(id)[0]!.verify?.service?.port);

  script({ api_tester: [{ report: { verdict: 'pass' } }] });
  const second = await run('Report that is not a report');
  assert.equal(second.state, 'needs_owner');
  assert.match(note(second.id), /did not return a usable report/);
});

test('a change that stops the service from starting goes back to the coder with what it printed', { skip: skipService }, async () => {
  const crashes = { write: { 'src/price.js': PRICE_DISCOUNT, 'server.js': `console.error('ReferenceError: discount is not defined');\nprocess.exit(1);\n` } };
  script({ coder: [crashes, { write: { 'server.js': SERVER } }], api_tester: [{ report: reportPass }] });
  const { id, state } = await run('Breaks startup');
  assert.equal(state, 'awaiting_approval', note(id));
  assert.deepEqual(roles(), ['analyst', 'planner', 'coder', 'tester', 'coder', 'tester', 'api_tester'], 'no tester is spent on a service that is not up');
  const first = getRounds(id)[0]!;
  assert.equal(first.verify?.status, 'failed');
  assert.equal(first.verify?.startFailure?.alsoWithoutTheChange, false);
  const feedback = calls()[4]!.prompt;
  assert.match(feedback, /The service does not start with your change/);
  assert.match(feedback, /ReferenceError: discount is not defined/);
  assert.match(feedback, /It starts without your change/);
});

test('a run profile that does not work even without the change is the owner\'s to fix', { skip: skipService }, async () => {
  profile({ command: 'node no-such-file.js' });
  try {
    script({});
    const { id, state } = await run('Profile is wrong');
    assert.equal(state, 'needs_owner');
    assert.match(note(id), /The change was not verified running/);
    assert.match(note(id), /does not start without this change either, so the run profile/);
    assert.match(note(id), /Cannot find module/);
    assert.deepEqual(roles(), ['analyst', 'planner', 'coder', 'tester']);
    assert.equal(getRounds(id)[0]!.verify?.status, 'error');
    assert.equal(getRounds(id)[0]!.verify?.startFailure?.alsoWithoutTheChange, true);
  } finally {
    profile();
  }
});

test('the API tester and then the UI tester use the same running service; screenshots are kept', { skip: skipService || !findChrome() }, async () => {
  profile({ ui: true, uiPath: '/cart' });
  try {
    script({
      api_tester: [{ report: reportPass, get: '/price?qty=2' }],
      ui_tester: [{ report: reportPass, calls: 6, shot: 'page-cart.png', get: '/' }],
    });
    const { id, state } = await run('Both testers');
    assert.equal(state, 'awaiting_approval', note(id));
    assert.deepEqual(roles(), ['analyst', 'planner', 'coder', 'tester', 'api_tester', 'ui_tester']);
    const ui = calls().at(-1)!;
    assert.deepEqual(ui.mcpServers, ['fryday_browser', 'fryday_service']);
    assert.deepEqual(ui.fetched, { status: 200, body: 'shop' }, 'the service was still up for the second tester');
    assert.match(ui.verifyBrief!, /running at http:\/\/127\.0\.0\.1:\d+\/cart/);
    assert.match(ui.verifyBrief!, /The API tester used this same running service before you/);
    const v = getRounds(id)[0]!.verify!;
    assert.deepEqual(v.testers.map((t) => [t.kind, t.calls, t.passed]), [['api', 3, true], ['ui', 6, true]]);
    assert.deepEqual(v.evidence, ['page-cart.png']);
    assert.ok(fs.existsSync(path.join(evidenceDir(id, 1), 'page-cart.png')), 'kept after the checkout is gone');
    assert.match(note(id), /API tester: 3 requests; UI tester: 6 browser steps/);
    await assertCleanedUp(id, v.service?.port);

    // If the UI tester is the one that fails, the round goes back all the same.
    script({ api_tester: [{ report: reportPass }], ui_tester: [{ report: reportFail, shot: 'broken.png' }, { report: reportPass }] });
    const second = await run('UI tester finds it');
    assert.equal(second.state, 'awaiting_approval');
    assert.deepEqual(getRounds(second.id).map((r) => r.verify?.status), ['failed', 'passed']);
    assert.deepEqual(getRounds(second.id)[0]!.verify?.evidence, ['broken.png'], 'the picture of the problem is kept too');
    assert.match(calls().find((c) => c.role === 'coder' && c.call === 2)!.prompt, /What the UI tester found/);
  } finally {
    profile();
  }
});

test('a granted data connection reaches the API tester, and only on the project it was granted to', { skip: skipService }, async () => {
  const dbFile = path.join(tmp, 'stage.sqlite');
  fs.writeFileSync(process.env.FRYDAY_CLAUDE_SETTINGS!, JSON.stringify({
    mcpServers: { 'shop-stg-db': { command: process.execPath, args: [path.join(__dirname, 'fixtures', 'sqlite-mcp.mjs'), dbFile] } },
  }));
  await discoverConnection('shop-stg-db');
  configureConnection('shop-stg-db', { enabled: true, envKind: 'staging', access: 'read_only', tools: [{ tool: 'query', check: 'sql' }], projects: [REPO] });
  try {
    script({ api_tester: [{ report: reportPass }] });
    const { id, state } = await run('With staging data');
    assert.equal(state, 'awaiting_approval', note(id));
    const tester = calls().at(-1)!;
    assert.deepEqual(tester.mcpServers, ['fryday_service', 'shop-stg-db']);
    assert.match(tester.verifyBrief!, /`shop-stg-db` \(staging data, read-only\): `mcp__shop-stg-db__query`/);
    assert.deepEqual(getRounds(id)[0]!.verify?.dataConnections, ['shop-stg-db']);
    // Its guard policy lists that one tool with the SQL check, and nothing else from the server.
    const policyFile = fs.readdirSync(process.env.FRYDAY_RUNS!).filter((f) => f.endsWith('.policy.json')).map((f) => JSON.parse(fs.readFileSync(path.join(process.env.FRYDAY_RUNS!, f), 'utf8')))
      .find((p) => p.role === 'api_tester' && p.mcp['mcp__shop-stg-db__query']);
    assert.deepEqual(Object.keys(policyFile.mcp).sort(), ['mcp__fryday_service__log', 'mcp__fryday_service__request', 'mcp__shop-stg-db__query']);
    assert.deepEqual(policyFile.mcp['mcp__shop-stg-db__query'], { check: 'sql' });

    // The definition changes behind the developer's back: the next run does not get it, and says so.
    fs.writeFileSync(process.env.FRYDAY_CLAUDE_SETTINGS!, JSON.stringify({
      mcpServers: { 'shop-stg-db': { command: process.execPath, args: [path.join(__dirname, 'fixtures', 'sqlite-mcp.mjs'), dbFile, '--changed'] } },
    }));
    script({ api_tester: [{ report: reportPass }] });
    const second = await run('After the server changed');
    assert.equal(second.state, 'awaiting_approval');
    assert.deepEqual(calls().at(-1)!.mcpServers, ['fryday_service']);
    assert.deepEqual(getRounds(second.id)[0]!.verify?.unavailable, [{ name: 'shop-stg-db', why: 'its definition changed since you reviewed it' }]);
    assert.match(calls().at(-1)!.verifyBrief!, /Not available this time: shop-stg-db \(its definition changed since you reviewed it\)/);
  } finally {
    fs.writeFileSync(process.env.FRYDAY_CLAUDE_SETTINGS!, JSON.stringify({ mcpServers: {} }));
  }
});

test('a tester stopped at a limit asks the owner, and yes verifies again from the start', { skip: skipService }, async () => {
  script({ api_tester: [{ budget: true }, { report: reportPass, get: '/price?qty=10' }] });
  const { id, state } = await run('Tester out of money');
  assert.equal(state, 'needs_owner');
  const ticket = latestApproval(id)!;
  assert.equal(ticket.action, 'continue_budget');
  assert.match(JSON.parse(ticket.payload_json).summary, /^The App tester on T-\d+ reached its safety limit \(/);
  await assertCleanedUp(id, getRounds(id)[0]!.verify?.service?.port);

  resolveApproval(ticket.id, 'approved', 'ui');
  const start = Date.now();
  while (getTask(id)!.state === 'needs_owner' && Date.now() - start < 10_000) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await rest(id), 'awaiting_approval', note(id));
  assert.deepEqual(calls().at(-1)!.fetched, { status: 200, body: '{"total":900}' }, 'the service was started again for the second try');
  assert.equal(getRounds(id)[0]!.verify?.status, 'passed');
});

test('a project without a run profile is not verified, and is handed over as before', { skip }, async () => {
  overrideRepo(REPO, { runProfile: null });
  try {
    script({});
    const { id, state } = await run('Library change');
    assert.equal(state, 'awaiting_approval');
    assert.deepEqual(roles(), ['analyst', 'planner', 'coder', 'tester']);
    assert.equal(getRounds(id)[0]!.verify, null);
    assert.doesNotMatch(note(id), /verified running/);
  } finally {
    profile();
  }
});

test('on Linux a project with a run profile is not tried out running: the owner is told why', { skip: process.platform !== 'linux' }, async () => {
  script({});
  const { id, state } = await run('Change on Linux');
  assert.equal(state, 'needs_owner');
  assert.match(note(id), /the API and UI testers are not available on Linux yet\. Nothing was verified running/);
  assert.deepEqual(roles(), ['analyst', 'planner', 'coder', 'tester'], 'no tester was started');
  assert.equal(getRounds(id)[0]!.verify?.status, 'error');
  assert.notEqual(getRounds(id)[0]!.outcome, 'passed');
});

test('tester roles have their own model and limits in Settings', () => {
  const s = updateSettings({ roles: { api_tester: { tokenLimit: 300_000 } } });
  assert.equal(s.roles.api_tester.tokenLimit, 300_000);
  assert.equal(s.roles.ui_tester.tokenLimit, 800_000);
  assert.equal(s.roles.ui_tester.model, 'claude-sonnet-5-5');
});
