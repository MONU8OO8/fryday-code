// From "merged into staging" to "deployed": the deploy ticket, the Jenkins build it
// starts, pipeline prompts, the commit check, and picking up after a restart. Stand-in
// agents, real git with a bare remote on disk, and a stand-in Jenkins on this machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// The sandbox runs on macOS and on Linux (bubblewrap); elsewhere there is none to test.
const skip = !['darwin', 'linux'].includes(process.platform);
const tmp = path.join(os.homedir(), '.fryday-code', `deploy-flow-test-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
const planFile = path.join(tmp, 'script.json');
const wrapper = path.join(tmp, 'claude-wrapper.sh');
fs.writeFileSync(wrapper, `#!/bin/sh\nexport FAKE_PLAN_FILE='${planFile}'\nexec node '${path.join(__dirname, 'fixtures', 'fake-claude.mjs')}' "$@"\n`, { mode: 0o755 });
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_MAC_NOTIFY = 'off';
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_RUNS = path.join(tmp, 'runs');
process.env.FRYDAY_WORKTREES = path.join(tmp, 'worktrees');
process.env.FRYDAY_SCRATCH = path.join(tmp, 'scratch');
process.env.FRYDAY_MEMORY_WAIT_MS = '0';
process.env.CLAUDE_BIN = wrapper;
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';
// These tests are the ask-at-every-step way to staging; oneYes.test.ts covers the one-yes way.
process.env.FRYDAY_STAGING_APPROVALS = 'each_step';

import { initDb, getDb } from '../src/db/db';
import { saveProject, overrideRepo } from '../src/registry/registry';
import { activeRunIds, stopFollowing } from '../src/runner/supervisor';
import { startTask, registerPipeline } from '../src/pipeline/pipeline';
import { getTask } from '../src/pipeline/taskState';
import { resolveApproval, latestApproval } from '../src/pipeline/approvals';
import { latestRelease } from '../src/pipeline/releaseFlow';
import { registerDeploy, setDeployTransport, latestDeploy, reconcileDeploysOnStartup, stopAllDeploys, askToDeployAgain } from '../src/deploy/deployFlow';
import { saveJenkinsCredentials, removeJenkinsCredentials } from '../src/deploy/config';
import { registerOwnerNotifications } from '../src/notify/owner';
import { setDesktopNotifier } from '../src/notify/desktop';
import { StubJenkins, type StubStage } from './fixtures/stub-jenkins';

const REPO = 'scratch';
const JOB = 'apps/scratch-deploy';
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();
const MATH = "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n";
const TEST = "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst m = require('../src/math');\ntest('mul', () => assert.equal(m.mul(2, 3), 6));\n";
const PLAN = { summary: 'Add mul.', approach: 'Export mul.', flow: [{ step: 'call', detail: 'mul' }], files: ['src/math.js'], criteria: ['mul(2, 3) returns 6'], testPlan: ['node --test'], risks: [], questions: [] };
const PASS = { verdict: 'pass', summary: 'ok', criteria: [{ criterion: PLAN.criteria[0], met: true, evidence: 'ran it' }], issues: [] };

const jenkins = new StubJenkins();
const STAGES: StubStage[] = [
  { name: 'Build' },
  { name: 'Deploy to STG', input: { id: 'Stg1', message: 'Deploy to staging?' } },
  { name: 'Deploy to PROD', input: { id: 'Prod1', message: 'Deploy to production?' } },
];
let origin = '';
/** What the stand-in says it built: by default, whatever staging is on the remote right now. */
let builtSha: () => string | null = () => sh(origin, 'rev-parse', 'stg');
const alerts: Array<{ title: string; body: string }> = [];

let seq = 0;
function freshRepo(withDeployer = true): void {
  const dir = path.join(tmp, `repo${seq}`);
  origin = path.join(dir, 'origin.git');
  const main = path.join(dir, 'main');
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'release', origin]);
  execFileSync('git', ['init', '-q', '-b', 'release', main]);
  sh(main, 'config', 'user.name', 'Owner');
  sh(main, 'config', 'user.email', 'owner@example.invalid');
  fs.writeFileSync(path.join(main, 'src', 'math.js'), 'exports.add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(main, 'package.json'), '{"name":"scratch","version":"1.0.0"}\n');
  sh(main, 'add', '-A');
  sh(main, 'commit', '-q', '-m', 'init');
  sh(main, 'remote', 'add', 'origin', origin);
  sh(main, 'push', '-q', 'origin', 'release', 'release:stg');
  saveProject({
    id: REPO, name: 'Scratch repo', localPath: main, prodBranch: 'release', stgBranch: 'stg', testCmd: 'node --test', verified: true,
    ...(withDeployer ? { deployer: 'jenkins', deployerConfig: { job: JOB, branchParam: 'BRANCH', stage: 'Deploy to STG' } } : {}),
  });
}

const note = (id: string) => JSON.parse(getTask(id)!.metadata_json ?? '{}').note as string;
async function waitFor(what: string, cond: () => boolean, timeoutMs = 60_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const approve = (taskId: string, decision: 'approved' | 'rejected' = 'approved') => resolveApproval(latestApproval(taskId)!.id, decision, { via: 'cookie' });
const ticket = (taskId: string) => latestApproval(taskId)!;
const payload = (taskId: string) => JSON.parse(ticket(taskId).payload_json);
const posts = () => jenkins.actions.map((r) => r.path.replace(/^\/job\/apps\/job\/scratch-deploy/, '') + (r.body ? `?${r.body}` : ''));

/** A task through review and release, ending with the merge on staging. */
async function onStaging(title: string, withDeployer = true): Promise<string> {
  seq++;
  freshRepo(withDeployer);
  for (const f of [`${planFile}.count.json`, `${planFile}.calls.jsonl`]) fs.rmSync(f, { force: true });
  fs.writeFileSync(planFile, JSON.stringify({ planner: PLAN, coder: [{ write: { 'src/math.js': MATH, 'test/math.test.js': TEST } }], tester: [PASS] }));
  const id = `T-${seq}`;
  getDb().prepare(`INSERT INTO tasks (id, seq, title, description, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, 0)`).run(id, seq, title, title);
  startTask(id, REPO);
  await waitFor(`${id} to pass review`, () => getTask(id)!.state === 'awaiting_approval' && activeRunIds().length === 0 && latestApproval(id)?.action === 'release_stg');
  approve(id);
  await waitFor(`${id} release`, () => latestRelease(id)?.state === 'pushed' || latestRelease(id)?.state === 'stopped');
  return id;
}

before(async () => {
  await jenkins.start();
  jenkins.addJob({ name: JOB, parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: STAGES, builtSha: () => builtSha() });
  initDb(process.env.FRYDAY_DB!);
  registerPipeline();
  registerDeploy();
  registerOwnerNotifications();
  setDesktopNotifier((title, body) => alerts.push({ title, body }));
  setDeployTransport(undefined, 40);
  saveJenkinsCredentials({ baseUrl: jenkins.url, user: jenkins.user, token: jenkins.token });
});
after(async () => { stopAllDeploys(); stopFollowing(); await jenkins.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('after the merge, the owner is asked; on yes the job runs, a staging prompt is asked too, and the deploy is confirmed by its commit', { skip }, async () => {
  const id = await onStaging('Deploy all the way');
  assert.equal(getTask(id)!.state, 'awaiting_approval');
  assert.equal(ticket(id).action, 'deploy_stg');
  assert.match(note(id), /Merged into stg and pushed .* Deploy stg with Jenkins \(apps\/scratch-deploy\)\? Approve on the task\./);
  assert.deepEqual(payload(id).params, { BRANCH: 'stg' });
  assert.ok(payload(id).effects.some((e: string) => /production is never answered/.test(e)), 'the ticket says production is never answered');
  assert.equal(jenkins.actions.length, 0, 'nothing is started in Jenkins before the yes');
  assert.ok(alerts.some((a) => /Needs your decision: Start the Jenkins job/.test(a.body)), 'the owner was nudged');

  approve(id);
  await waitFor('the staging prompt', () => ticket(id).action === 'deploy_input' && ticket(id).state === 'pending');
  assert.equal(getTask(id)!.state, 'awaiting_approval');
  assert.match(payload(id).summary, /Jenkins asks "Deploy to staging\?" in the stage "Deploy to STG" for apps\/scratch-deploy #\d+\. Answer "Proceed"\?/);
  assert.equal(latestDeploy(id)!.state, 'waiting_input');
  assert.deepEqual(posts(), ['/buildWithParameters?BRANCH=stg'], 'only the build was started; the prompt is not answered yet');

  approve(id);
  await waitFor('the deploy to finish', () => ['succeeded', 'failed', 'stopped'].includes(latestDeploy(id)!.state));
  const deploy = latestDeploy(id)!;
  assert.equal(deploy.outcome, 'deployed', deploy.detail ?? '');
  assert.equal(getTask(id)!.state, 'deployed');
  assert.equal(deploy.expected_sha, latestRelease(id)!.merge_sha, 'the build is checked against the merge FryDay pushed');
  assert.equal(deploy.built_sha, sh(origin, 'rev-parse', 'stg'));
  assert.match(note(id), /Deployed to staging: apps\/scratch-deploy #\d+ .*"Deploy to STG" stage succeeded and it contains/);
  assert.deepEqual(posts(), ['/buildWithParameters?BRANCH=stg', `/${deploy.build_number}/input/Stg1/proceedEmpty`], 'the production prompt was never answered');
  assert.deepEqual(JSON.parse(deploy.stages_json!).map((s: { status: string }) => s.status).slice(0, 2), ['SUCCESS', 'SUCCESS']);
  assert.ok(alerts.some((a) => /Deployed to staging/.test(a.body)));
});

test('with no staging stage named, a production prompt stops FryDay: it is never answered', { skip }, async () => {
  const id = await onStaging('No stage named');
  overrideRepo(REPO, { deployerConfig: { job: JOB, branchParam: 'BRANCH', stage: null } });
  // The ticket was raised before the change; ask again with the new settings.
  const again = askToDeployAgain(id, latestRelease(id)!);
  assert.equal(again.action, 'deploy_stg');
  const before = jenkins.actions.length;
  approve(id);
  await waitFor('the staging prompt', () => ticket(id).action === 'deploy_input');
  approve(id);
  await waitFor('FryDay to stop', () => ['succeeded', 'failed', 'stopped'].includes(latestDeploy(id)!.state));
  const deploy = latestDeploy(id)!;
  assert.equal(deploy.outcome, 'production_prompt');
  assert.equal(getTask(id)!.state, 'needs_owner');
  assert.match(note(id), /waiting for someone's yes: "Deploy to production\?" in the stage "Deploy to PROD"\. It is about production, which FryDay never approves\./);
  const mine = jenkins.actions.slice(before).map((r) => r.path);
  assert.equal(mine.filter((p) => p.includes('Prod1')).length, 0);
  assert.equal(mine.filter((p) => p.includes('Stg1')).length, 1);
  overrideRepo(REPO, { deployerConfig: { job: JOB, branchParam: 'BRANCH', stage: 'Deploy to STG' } });
});

test('a build that did not build the merge is not called deployed', { skip }, async () => {
  const id = await onStaging('Wrong commit');
  builtSha = () => sh(origin, 'rev-parse', 'release');
  try {
    approve(id);
    await waitFor('the staging prompt', () => ticket(id).action === 'deploy_input');
    approve(id);
    await waitFor('the end', () => ['succeeded', 'failed', 'stopped'].includes(latestDeploy(id)!.state));
    assert.equal(latestDeploy(id)!.outcome, 'wrong_commit');
    assert.equal(getTask(id)!.state, 'needs_owner');
    assert.match(note(id), /does not contain the merge .* The change is not on staging; was the job told the right branch\?/);
  } finally {
    builtSha = () => sh(origin, 'rev-parse', 'stg');
  }
});

test('a build that says nothing about its commit cannot be confirmed, and says so', { skip }, async () => {
  const id = await onStaging('No commit recorded');
  builtSha = () => null;
  try {
    approve(id);
    await waitFor('the staging prompt', () => ticket(id).action === 'deploy_input');
    approve(id);
    await waitFor('the end', () => ['succeeded', 'failed', 'stopped'].includes(latestDeploy(id)!.state));
    assert.equal(latestDeploy(id)!.outcome, 'unconfirmed');
    assert.notEqual(getTask(id)!.state, 'deployed');
    assert.match(note(id), /does not say which commit it built, so FryDay cannot confirm/);
  } finally {
    builtSha = () => sh(origin, 'rev-parse', 'stg');
  }
});

test('declining the deploy starts nothing; declining a prompt answers nothing; a failed stage is a failed deploy', { skip }, async () => {
  const id = await onStaging('Declines');
  const before = jenkins.actions.length;
  approve(id, 'rejected');
  assert.equal(jenkins.actions.length, before);
  assert.equal(getTask(id)!.state, 'needs_owner');
  assert.match(note(id), /You declined the deploy\. The merge is on staging; nothing was started in Jenkins\./);

  askToDeployAgain(id, latestRelease(id)!);
  approve(id);
  await waitFor('the staging prompt', () => ticket(id).action === 'deploy_input');
  approve(id, 'rejected');
  assert.equal(latestDeploy(id)!.outcome, 'declined');
  assert.match(note(id), /You declined the prompt\. FryDay did not answer it/);
  assert.equal(jenkins.actions.slice(before).filter((r) => r.path.includes('/input/')).length, 0);

  // A stage that fails.
  jenkins.addJob({ name: JOB, parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: [{ name: 'Build', result: 'FAILED' }, ...STAGES.slice(1)], builtSha: () => builtSha() });
  try {
    askToDeployAgain(id, latestRelease(id)!);
    approve(id);
    await waitFor('the end', () => latestDeploy(id)!.outcome === 'build_failed');
    assert.match(note(id), /ended FAILURE/);
  } finally {
    jenkins.addJob({ name: JOB, parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: STAGES, builtSha: () => builtSha() });
  }
});

test('a deploy being followed when core stops is picked up again from where it was', { skip }, async () => {
  const id = await onStaging('Restart');
  jenkins.addJob({ name: JOB, parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: [{ name: 'Build' }, { name: 'Deploy to STG' }], builtSha: () => builtSha(), queueLooks: 3, stageLooks: 3 });
  try {
    approve(id);
    await waitFor('the build to be queued', () => latestDeploy(id)?.queue_path !== null && latestDeploy(id) !== undefined);
    stopAllDeploys(); // core "stops"
    const queued = latestDeploy(id)!;
    assert.ok(['queued', 'running'].includes(queued.state));
    reconcileDeploysOnStartup(); // core starts again
    await waitFor('the deploy to finish', () => ['succeeded', 'failed', 'stopped'].includes(latestDeploy(id)!.state));
    assert.equal(latestDeploy(id)!.outcome, 'deployed', latestDeploy(id)!.detail ?? '');
    assert.equal(jenkins.actions.filter((r) => r.path.endsWith('/buildWithParameters')).length >= 1, true);
    assert.equal(getTask(id)!.state, 'deployed');
  } finally {
    jenkins.addJob({ name: JOB, parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: STAGES, builtSha: () => builtSha() });
  }
});

test('a cancelled queue item, a prompt that asks for values, and a project without Jenkins set up', { skip }, async () => {
  const id = await onStaging('Edge cases');
  jenkins.addJob({ name: JOB, stages: STAGES, builtSha: () => builtSha(), cancelInQueue: true });
  approve(id);
  await waitFor('the end', () => latestDeploy(id)?.outcome === 'cancelled');
  assert.match(note(id), /cancelled in the Jenkins queue before it started/);

  jenkins.addJob({ name: JOB, stages: [{ name: 'Deploy to STG', input: { id: 'Ask', message: 'Deploy to staging? Which version?', parameters: true } }], builtSha: () => builtSha() });
  askToDeployAgain(id, latestRelease(id)!);
  approve(id);
  await waitFor('the end', () => latestDeploy(id)?.outcome === 'production_prompt');
  assert.match(note(id), /It asks for values, which FryDay does not fill in\./);
  jenkins.addJob({ name: JOB, parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: STAGES, builtSha: () => builtSha() });

  removeJenkinsCredentials();
  try {
    const other = await onStaging('No Jenkins');
    assert.equal(getTask(other)!.state, 'needs_owner');
    assert.match(note(other), /deploys with Jenkins, but Jenkins is not connected here\. Connect it on the Connections page/);
    assert.notEqual(latestApproval(other)?.action, 'deploy_stg');
  } finally {
    saveJenkinsCredentials({ baseUrl: jenkins.url, user: jenkins.user, token: jenkins.token });
  }
  const plain = await onStaging('No deployer', false);
  await waitFor('the search for a Jenkins job to end', () => getTask(plain)!.state === 'needs_owner');
  assert.match(note(plain), /I looked through \d+ Jenkins jobs? and none of them builds Scratch repo's repository\. Set its job on the Projects page/, 'FryDay looked for the job itself before leaving the deploy to the owner');
});

test('the owner is nudged in the app every time, and on the Mac unless that is switched off', async () => {
  const { tellOwner } = await import('../src/notify/owner');
  const { updateSettings } = await import('../src/settings');
  const { sseHandler } = await import('../src/api/events');
  // Listen to the event stream the UI listens to.
  const written: string[] = [];
  const fakeRes = { setHeader() {}, flushHeaders() {}, write(chunk: string) { written.push(chunk); return true; } };
  const closers: Array<() => void> = [];
  sseHandler({ query: {}, on: (_e: string, fn: () => void) => closers.push(fn) } as never, fakeRes as never);
  const before = alerts.length;
  tellOwner({ id: 'T-99', title: 'Nudge test' }, 'Needs your decision: something\nmore lines', 'decision');
  assert.equal(alerts.length, before + 1);
  assert.equal(alerts.at(-1)!.title, 'FryDay · T-99');
  assert.equal(alerts.at(-1)!.body, 'Nudge test: Needs your decision: something');
  const toast = written.map((w) => w.match(/^data: (.*)\n\n$/)?.[1]).filter(Boolean).map((j) => JSON.parse(j!)).find((e) => e.type === 'owner_alert');
  assert.deepEqual(toast, { type: 'owner_alert', taskId: 'T-99', title: 'T-99 · Nudge test', text: 'Needs your decision: something', kind: 'decision' });

  updateSettings({ alerts: { mac: false } });
  tellOwner({ id: 'T-99', title: 'Nudge test' }, 'Again', 'stopped');
  assert.equal(alerts.length, before + 1, 'no Mac notification when switched off');
  assert.equal(written.filter((w) => w.includes('owner_alert')).length, 2, 'the toast still comes');
  updateSettings({ alerts: { mac: true } });
  for (const close of closers) close();
});
