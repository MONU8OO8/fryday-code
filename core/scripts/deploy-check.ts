/**
 * Deploying staging, through the API only, with a real core, real git and a stand-in
 * Jenkins on this machine. The agents are stand-ins too: this check is about what
 * happens after review, and it must not spend money or touch a real Jenkins.
 *
 *   npm run deploy-check                    run it
 *   npm run deploy-check -- --keep-running  leave core and the stand-in Jenkins up to look at it
 *
 * What it proves:
 *   1. Jenkins can be set up only by the owner at the UI; its token never comes back.
 *   2. After a release, the owner is asked before anything starts in Jenkins.
 *   3. A staging prompt in the pipeline is its own decision; a production prompt is never answered.
 *   4. The deploy counts only when the build contains the merge on staging.
 *   5. The owner is nudged (toast events) at each decision and at the end.
 *
 * Everything lives under ~/.fryday-code/deploy-check; the remote is a folder on disk.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { StubJenkins } from '../test/fixtures/stub-jenkins';

const root = path.join(os.homedir(), '.fryday-code', 'deploy-check');
const home = path.join(root, 'state');
const PORT = 7494;
const base = `http://127.0.0.1:${PORT}`;
const keepRunning = process.argv.includes('--keep-running');

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', ...args], { encoding: 'utf8' }).trim();

const PLAN = { summary: 'Add mul.', approach: 'Export mul.', flow: [{ step: 'call', detail: 'mul' }], files: ['src/math.js'], criteria: ['mul(2, 3) returns 6'], testPlan: ['node --test'], risks: [], questions: [] };
const PASS = { verdict: 'pass', summary: 'Meets the criterion.', criteria: [{ criterion: PLAN.criteria[0], met: true, evidence: 'node --test passes' }], issues: [] };

let core: ChildProcess | null = null;
let coreLog = '';
let secret = '';
let cookie = '';
const events: Array<Record<string, unknown>> = [];

async function call(method: string, route: string, body?: unknown, as: 'token' | 'cookie' = 'token') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (as === 'token') headers['x-fryday-core-token'] = secret;
  else { headers['Cookie'] = cookie; headers['Origin'] = base; }
  const res = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, text };
}
async function detail(id: string) {
  const { body } = await call('GET', `/api/tasks/${id}`);
  let note = '';
  try { note = String(JSON.parse(body.task.metadata_json ?? '{}').note ?? ''); } catch { /* none */ }
  return { ...body, state: body.task.state as string, note };
}
async function until(what: string, test: (d: any) => boolean, seconds = 120) {
  const end = Date.now() + seconds * 1000;
  let last = '';
  for (;;) {
    const d = await detail('T-1');
    const line = `${d.state}: ${d.note.split('\n')[0]}`;
    if (line !== last) { console.log(`      T-1 ${line}`); last = line; }
    if (test(d)) return d;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (still ${line})`);
    await sleep(400);
  }
}
async function approve(d: any) {
  const res = await call('POST', `/api/approvals/${d.approval.id}/resolve`, { decision: 'approved' }, 'cookie');
  if (res.status !== 202 && res.status !== 200) throw new Error(`approval refused: ${res.text}`);
}

async function main(): Promise<void> {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  // A project with a staging branch on a bare remote.
  const origin = path.join(root, 'shop.git');
  const clone = path.join(root, 'shop');
  fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  git(clone, 'config', 'user.email', 'owner@example.invalid');
  git(clone, 'config', 'user.name', 'Owner');
  fs.writeFileSync(path.join(clone, 'src', 'math.js'), 'exports.add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(clone, 'package.json'), '{ "name": "shop", "version": "1.0.0", "scripts": { "test": "node --test" } }\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'first version');
  git(clone, 'remote', 'add', 'origin', origin);
  git(clone, 'push', '-q', 'origin', 'main', 'main:stg');

  // A stand-in Jenkins whose job looks like a real one: build, deploy to staging (asks first), deploy to production (asks first).
  const jenkins = new StubJenkins();
  await jenkins.start();
  jenkins.addJob({
    name: 'apps/shop', parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], queueLooks: 2, stageLooks: 3,
    stages: [{ name: 'Checkout' }, { name: 'Build' }, { name: 'Deploy to STG', input: { id: 'StgGate', message: 'Deploy to staging?' } }, { name: 'Deploy to PROD', input: { id: 'ProdGate', message: 'Deploy to production?' } }],
    builtSha: (params) => (params['BRANCH'] ? execFileSync('git', ['--git-dir', origin, 'rev-parse', params['BRANCH']], { encoding: 'utf8' }).trim() : null),
  });

  // Stand-in agents.
  const planFile = path.join(root, 'agents.json');
  fs.writeFileSync(planFile, JSON.stringify({ planner: PLAN, coder: [{ write: { 'src/math.js': 'exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n', 'test/math.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst m = require('../src/math');\ntest('mul', () => assert.equal(m.mul(2, 3), 6));\n" } }], tester: [PASS] }));
  const wrapper = path.join(root, 'claude');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexport FAKE_PLAN_FILE='${planFile}'\nexec '${process.execPath}' '${path.join(__dirname, '..', 'test', 'fixtures', 'fake-claude.mjs')}' "$@"\n`, { mode: 0o755 });

  const env: NodeJS.ProcessEnv = { ...process.env, FRYDAY_HOME: home, FRYDAY_MAC_NOTIFY: 'off', FRYDAY_PORT: String(PORT), CLAUDE_BIN: wrapper, FRYDAY_MEMORY_WAIT_MS: '0' };
  for (const key of ['FRYDAY_CORE_SECRET', 'FRYDAY_DB', 'FRYDAY_RUNS', 'FRYDAY_WORKTREES', 'FRYDAY_SCRATCH', 'FRYDAY_MODEL']) delete env[key];
  core = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: path.join(__dirname, '..'), env, stdio: keepRunning ? 'ignore' : ['ignore', 'pipe', 'pipe'], detached: keepRunning });
  core.stdout?.on('data', (c: Buffer) => { coreLog += c.toString('utf8'); });
  core.stderr?.on('data', (c: Buffer) => { coreLog += c.toString('utf8'); });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up */ }
    await sleep(200);
  }
  secret = fs.readFileSync(path.join(home, 'secret'), 'utf8').trim();
  const link = await call('POST', '/api/session/launch-code');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ code: link.body.code }) });
  cookie = (session.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  // Follow the event stream the UI follows, for the toasts.
  const stream = await fetch(`${base}/api/events`, { headers: { 'x-fryday-core-token': secret } });
  void (async () => {
    const reader = stream.body!.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = chunk.match(/^data: (.*)$/m);
        if (m) { try { events.push(JSON.parse(m[1]!)); } catch { /* keepalive */ } }
      }
    }
  })().catch(() => undefined);

  // 1 ─ Setting up Jenkins
  console.log('\n1. Setting up Jenkins');
  const creds = { baseUrl: jenkins.url, user: jenkins.user, token: jenkins.token };
  const byToken = await call('PUT', '/api/deploy/jenkins', creds);
  check('a caller with the token cannot set up Jenkins; only the owner at the UI can', byToken.status === 403, `${byToken.status}`);
  const saved = await call('PUT', '/api/deploy/jenkins', creds, 'cookie');
  check('the owner sets it up', saved.status === 200 && saved.body.jenkins.configured === true, JSON.stringify(saved.body));
  const status = await call('GET', '/api/deploy/jenkins');
  check('the token never comes back', !saved.text.includes(jenkins.token) && !status.text.includes(jenkins.token) && status.body.jenkins.user === jenkins.user);
  const before = jenkins.actions.length;
  const tested = await call('POST', '/api/deploy/jenkins/test', { job: 'apps/shop' });
  check('the read-only test finds the job and its parameters, and starts nothing', tested.body.ok === true && tested.body.job?.parameters?.[0]?.name === 'BRANCH' && jenkins.actions.length === before, JSON.stringify(tested.body));

  const detected = await call('POST', '/api/projects/detect', { path: clone });
  const { runProfile: _r, deployer: _d, deployerConfig: _c, ...facts } = detected.body.facts;
  const added = await call('POST', '/api/projects', { ...facts, stgBranch: 'stg', verified: true, deployer: 'jenkins', deployerConfig: { job: 'apps/shop', branchParam: 'BRANCH', stage: 'Deploy to STG' } });
  check('the project names its Jenkins job and staging stage', added.status === 201 && added.body.deployerConfig?.stage === 'Deploy to STG', JSON.stringify(added.body.deployerConfig ?? added.body));

  // 2 ─ A task through review and release
  console.log('\n2. A task to staging');
  await call('POST', '/api/tasks', { title: 'Add mul', description: 'Export mul(a, b) from src/math.js, with a test.', repoId: facts.id });
  let d = await until('the release ticket', (x) => x.state === 'awaiting_approval' && x.approval?.action === 'release_stg' && x.approval.state === 'pending');
  await approve(d);
  d = await until('the deploy ticket', (x) => x.approval?.action === 'deploy_stg' && x.approval.state === 'pending');
  const ask = JSON.parse(d.approval.payload_json);
  check('after the merge, the owner is asked to deploy, and nothing has started in Jenkins', jenkins.actions.length === before && d.state === 'awaiting_approval', ask.summary);
  check('the ticket says what will happen, including that production is never answered', ask.params?.BRANCH === 'stg' && ask.effects.some((e: string) => /production is never answered/.test(e)), ask.effects.join(' | '));
  check('the owner was nudged about it', events.some((e) => e['type'] === 'owner_alert' && e['kind'] === 'decision' && /Start the Jenkins job/.test(String(e['text']))));

  // 3 ─ The deploy
  console.log('\n3. The deploy');
  await approve(d);
  d = await until('the staging prompt', (x) => x.approval?.action === 'deploy_input' && x.approval.state === 'pending');
  const prompt = JSON.parse(d.approval.payload_json);
  check('the staging prompt in the pipeline is its own decision for the owner', /Jenkins asks "Deploy to staging\?" in the stage "Deploy to STG"/.test(prompt.summary) && d.deploy?.state === 'waiting_input', prompt.summary);
  check('so far Jenkins was asked to do one thing: start the build', jenkins.actions.slice(before).map((r) => r.path).join() === '/job/apps/job/shop/buildWithParameters');
  await approve(d);
  d = await until('the end of the deploy', (x) => ['deployed', 'needs_owner', 'failed'].includes(x.state) && x.deploy && ['succeeded', 'failed', 'stopped'].includes(x.deploy.state));
  const stgNow = execFileSync('git', ['--git-dir', origin, 'rev-parse', 'stg'], { encoding: 'utf8' }).trim();
  check('deployed, and confirmed by the commit the build contains', d.state === 'deployed' && d.deploy.outcome === 'deployed' && d.deploy.built_sha === stgNow && d.deploy.expected_sha === d.release.merge_sha, d.note);
  const answered = jenkins.actions.slice(before).map((r) => r.path);
  check('the production prompt was never answered', !answered.some((p) => p.includes('ProdGate')) && answered.filter((p) => p.includes('StgGate')).length === 1, answered.join(' '));
  check('the flow shows the deploy step done', d.flow?.nodes.find((n: any) => n.id === 'deploy')?.state === 'done');
  check('the owner was told it is deployed', events.some((e) => e['type'] === 'owner_alert' && e['kind'] === 'done'));
  check('every request to Jenkins carried the configured user, and every action a crumb', jenkins.requests.every((r) => r.auth !== null) && jenkins.actions.every((r) => r.crumb === jenkins.crumb));

  // The owner's clone was only read.
  check("the owner's clone was never touched", git(clone, 'status', '--porcelain') === '' && git(clone, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main');
  if (keepRunning) {
    const fresh = await call('POST', '/api/session/launch-code');
    console.log(`\nCore is still running (pid ${core.pid}) on ${base}. Open: ${fresh.body.url}\nThe stand-in Jenkins runs inside this script; press Ctrl-C to stop both.`);
    core.unref();
    await new Promise(() => undefined);
  }
  await jenkins.stop();
}

main()
  .catch((err) => {
    check('the script ran to the end', false, err instanceof Error ? err.message : String(err));
    if (coreLog) console.log(`\n--- core output (end) ---\n${coreLog.slice(-3000)}`);
  })
  .finally(async () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
    core?.kill('SIGTERM');
    await sleep(500);
    if (failed.length === 0) fs.rmSync(root, { recursive: true, force: true });
    else console.log(`Files kept in ${root}`);
    process.exit(failed.length ? 1 : 0);
  });
