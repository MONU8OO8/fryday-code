// The one-yes way to staging, and FryDay doing the deploy setup itself: the approval that
// merges also deploys and answers the staging prompt; a project with no deployer gets its
// Jenkins job found from the repository it builds; the owner's words in the task chat
// ("approve", "deploy it", "stop") are carried out by the Lead. Stand-in agents, real git
// with a bare remote on disk, and a stand-in Jenkins on this machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const skip = !['darwin', 'linux'].includes(process.platform);
const tmp = path.join(os.homedir(), '.fryday-code', `one-yes-test-${randomBytes(4).toString('hex')}`);
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
delete process.env.FRYDAY_STAGING_APPROVALS;

import { initDb, getDb } from '../src/db/db';
import { saveProject, getRepo } from '../src/registry/registry';
import { activeRunIds, stopFollowing } from '../src/runner/supervisor';
import { startTask, registerPipeline } from '../src/pipeline/pipeline';
import { getTask } from '../src/pipeline/taskState';
import { resolveApproval, latestApproval } from '../src/pipeline/approvals';
import { latestRelease } from '../src/pipeline/releaseFlow';
import { addMessage, listMessages } from '../src/pipeline/thread';
import { askLead, markFromChat, ownerSaid, registerLead } from '../src/pipeline/lead';
import { registerDeploy, setDeployTransport, latestDeploy, stopAllDeploys } from '../src/deploy/deployFlow';
import { ensureDeployer } from '../src/deploy/ownerDeploy';
import { saveJenkinsCredentials, answersItself } from '../src/deploy/config';
import { pickDeployJob, deployJobsOf, candidateNamed, repoKey, branchParamOf } from '../src/deploy/discover';
import type { JobSummary } from '../src/deploy/jenkins';
import { StubJenkins, type StubStage } from './fixtures/stub-jenkins';

const REPO = 'scratch';
const REMOTE = 'git@github.com:acme/scratch.git';
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();
const MATH = "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n";
const TEST = "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst m = require('../src/math');\ntest('mul', () => assert.equal(m.mul(2, 3), 6));\n";
const PLAN = { summary: 'Add mul.', approach: 'Export mul.', flow: [{ step: 'call', detail: 'mul' }], files: ['src/math.js'], criteria: ['mul(2, 3) returns 6'], testPlan: ['node --test'], risks: [], questions: [] };
const PASS = { verdict: 'pass', summary: 'ok', criteria: [{ criterion: PLAN.criteria[0], met: true, evidence: 'ran it' }], issues: [] };
const lead = (action: string, reply: string, instructions = '') => ({ reply, action, instructions, project: '', title: '' });

const jenkins = new StubJenkins();
const STAGES: StubStage[] = [
  { name: 'Build' },
  { name: 'Deploy to STG', input: { id: 'Stg1', message: 'Move to STG', proceedText: 'Release' } },
  { name: 'Deploy to PROD', input: { id: 'Prod1', message: 'Deploy to production?' } },
];
let origin = '';
const builtSha = () => sh(origin, 'rev-parse', 'stg');

let seq = 0;
function freshRepo(deployerJob: string | null, stage: string | null = 'Deploy to STG'): void {
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
    id: REPO, name: 'Scratch repo', localPath: main, remoteUrl: REMOTE, prodBranch: 'release', stgBranch: 'stg', testCmd: 'node --test', verified: true,
    deployer: deployerJob ? 'jenkins' : null, deployerConfig: deployerJob ? { job: deployerJob, branchParam: 'BRANCH', stage } : null,
  });
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 60_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const ticket = (taskId: string) => latestApproval(taskId)!;
const payload = (taskId: string) => JSON.parse(ticket(taskId).payload_json);
const tickets = (taskId: string) => (getDb().prepare('SELECT action FROM approvals WHERE task_id = ? ORDER BY requested_at, rowid').all(taskId) as Array<{ action: string }>).map((a) => a.action);
const said = (taskId: string) => listMessages(taskId).filter((m) => m.author === 'fryday' && m.kind === 'reply').map((m) => m.body);
const posts = (job: string) => jenkins.actions.filter((r) => r.path.startsWith(`/job/${job.split('/').join('/job/')}/`)).map((r) => r.path.replace(/^(\/job\/[^/]+)+/, '') + (r.body ? `?${r.body}` : ''));
const leadIdle = (taskId: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND role = 'fryday' AND state = 'running'`).get(taskId) as { n: number }).n === 0;

/** A task through review, waiting for the owner's yes to the change. */
async function reviewed(title: string, deployerJob: string | null, opts: { stage?: string | null; fryday?: unknown[] } = {}): Promise<string> {
  seq++;
  freshRepo(deployerJob, opts.stage === undefined ? 'Deploy to STG' : opts.stage);
  for (const f of [`${planFile}.count.json`, `${planFile}.calls.jsonl`]) fs.rmSync(f, { force: true });
  fs.writeFileSync(planFile, JSON.stringify({ planner: PLAN, coder: [{ write: { 'src/math.js': MATH, 'test/math.test.js': TEST } }], tester: [PASS], fryday: opts.fryday ?? [] }));
  const id = `T-${seq}`;
  getDb().prepare(`INSERT INTO tasks (id, seq, title, description, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, 0)`).run(id, seq, title, title);
  startTask(id, REPO);
  await waitFor(`${id} to pass review`, () => getTask(id)!.state === 'awaiting_approval' && activeRunIds().length === 0 && latestApproval(id)?.action === 'release_stg');
  return id;
}
/** The owner writes on the task at the UI (or, with fromChat, in the Chat space) and the Lead answers. */
async function ownerWrites(taskId: string, text: string, fromChat = false): Promise<void> {
  const before = said(taskId).length;
  const m = addMessage(taskId, 'owner', 'note', text);
  if (fromChat) markFromChat(taskId, m.id);
  askLead(taskId);
  await waitFor(`the Lead to answer "${text}"`, () => said(taskId).length > before && leadIdle(taskId));
}

before(async () => {
  await jenkins.start();
  initDb(process.env.FRYDAY_DB!);
  registerPipeline();
  registerLead();
  registerDeploy();
  setDeployTransport(undefined, 40);
  saveJenkinsCredentials({ baseUrl: jenkins.url, user: jenkins.user, token: jenkins.token });
});
after(async () => { stopAllDeploys(); stopFollowing(); await jenkins.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ─── Which job is the project's ───────────────────────────────────────────────

const job = (name: string, over: Partial<JobSummary> = {}): JobSummary => ({ name, buildable: true, parameters: ['BRANCH'], remotes: ['https://github.com/Acme/Scratch.git'], branches: ['refs/remotes/origin/stg'], ...over });

test('a job is the project\'s when it builds the project\'s repository, whatever it is called', () => {
  assert.equal(repoKey('git@github.com:Acme/Shop.git'), 'github.com/acme/shop');
  assert.equal(repoKey('https://user@github.com/acme/shop/'), 'github.com/acme/shop');
  assert.equal(repoKey('ssh://git@github.com:22/acme/shop.git'), 'github.com/acme/shop');
  assert.equal(repoKey('/Users/me/code/shop.git'), null, 'a folder on disk is not a remote Jenkins could have built');
  assert.equal(branchParamOf(['ENV', 'GIT_BRANCH']), 'GIT_BRANCH');
  assert.equal(branchParamOf(['ENV']), null);

  const others = [job('team/billing', { remotes: ['git@github.com:acme/billing.git'] }), job('team/no-builds-yet', { remotes: [] })];
  assert.deepEqual(pickDeployJob([...others, job('team/orders-api')], REMOTE, 'stg'), { kind: 'found', job: 'team/orders-api', branchParam: 'BRANCH' }, 'found by repository, though the name has nothing in common with "scratch"');
  assert.deepEqual(pickDeployJob(others, REMOTE, 'stg'), { kind: 'none', looked: 2 });
});

test('a production job is never picked, a job that cannot build staging is not picked, and a tie is not guessed', () => {
  assert.deepEqual(pickDeployJob([job('apps/scratch-prod'), job('apps/scratch-production-deploy')], REMOTE, 'stg'), { kind: 'none', looked: 2 });
  assert.deepEqual(pickDeployJob([job('apps/fixed-main', { parameters: [], branches: ['origin/main'] })], REMOTE, 'stg'), { kind: 'none', looked: 1 }, 'no branch parameter and it builds main: it cannot be told to build staging');
  assert.deepEqual(pickDeployJob([job('apps/always-stg', { parameters: [], branches: ['origin/stg'] })], REMOTE, 'stg'), { kind: 'found', job: 'apps/always-stg', branchParam: null });
  assert.deepEqual(pickDeployJob([job('apps/scratch'), job('apps/scratch-prod'), job('apps/scratch-stg')], REMOTE, 'stg'), { kind: 'found', job: 'apps/scratch-stg', branchParam: 'BRANCH' }, 'the one named for staging wins over the plain one');
  assert.deepEqual(pickDeployJob([job('apps/api'), job('apps/worker')], REMOTE, 'stg'), { kind: 'several', jobs: ['apps/api', 'apps/worker'] });
  assert.equal(pickDeployJob([job('apps/off', { buildable: false })], REMOTE, 'stg').kind, 'none');
});

test('the Lead acts only on the owner\'s own plain words, and a named job only chooses from the list', () => {
  for (const yes of ['approve', 'Approve.', 'ok approve it', 'yes', 'go ahead', 'yes, ship it']) assert.equal(ownerSaid('approve', yes), true, yes);
  for (const no of ['what happens if I approve', 'should I approve this?', 'do not approve', 'is the page count field right?', 'looks fine to me', 'not yet', `approve ${'x'.repeat(200)}`]) assert.equal(ownerSaid('approve', no), false, no);
  for (const yes of ['deploy it', 'set it deployer and deploy that too in stg', 'try the deploy again', 'can you deploy it to stg', 'put it on staging', 'redeploy']) assert.equal(ownerSaid('deploy', yes), true, yes);
  for (const no of ['why is it not deployed?', 'is the deployer set', "don't deploy yet", 'did you deploy it?']) assert.equal(ownerSaid('deploy', no), false, no);
  assert.equal(ownerSaid('stop', 'stop it'), true);
  assert.equal(ownerSaid('stop', 'why did it stop?'), false);
  assert.equal(ownerSaid('send_back', 'anything at all'), true, 'sending back starts nothing outside this machine');

  const fits = deployJobsOf([job('apps/api-stg'), job('apps/worker-stg'), job('apps/api-prod'), job('other/billing', { remotes: ['git@github.com:acme/billing.git'] })], REMOTE, 'stg');
  assert.deepEqual(fits.map((c) => c.name), ['apps/api-stg', 'apps/worker-stg']);
  assert.equal(candidateNamed(fits, 'apps/worker-stg')?.name, 'apps/worker-stg');
  assert.equal(candidateNamed(fits, 'Worker-STG')?.name, 'apps/worker-stg', 'the last part is enough when only one job has it');
  assert.equal(candidateNamed(fits, 'other/billing'), null, 'a job of another repository cannot be named in');
  assert.equal(candidateNamed(fits, 'apps/api-prod'), null);
});

test('FryDay answers a pipeline prompt itself only when it names staging outright', () => {
  assert.equal(answersItself('Deploy', 'Move to STG', 'Release', false), true);
  assert.equal(answersItself('Deploy to staging', 'Go on?', 'Proceed', false), true);
  assert.equal(answersItself(null, 'Tests passed. Ship it?', 'Proceed', false), false, '"test" alone could be the gate before anything');
  assert.equal(answersItself(null, 'Move to STG, then production', 'Proceed', false), false, 'anything that mentions production');
  assert.equal(answersItself(null, 'Move to STG', 'Release', true), false, 'a prompt that asks for values');
  assert.equal(answersItself(null, 'Continue?', 'Proceed', false), false);
});

// ─── One yes ──────────────────────────────────────────────────────────────────

test('one yes: approving the change merges it, starts the job the ticket named and answers its staging prompt; production is never answered', { skip }, async () => {
  const JOB = 'apps/scratch-deploy';
  jenkins.addJob({ name: JOB, parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: STAGES, builtSha });
  const id = await reviewed('One yes', JOB);
  assert.deepEqual(payload(id).thenDeploy, { job: JOB, params: { BRANCH: 'stg' } });
  assert.match(payload(id).summary, /into stg \(Scratch repo\), then deploy it to staging with Jenkins/);
  assert.ok(payload(id).effects.some((e: string) => e.includes(`then starts the Jenkins job ${JOB} with BRANCH=stg`)), 'the ticket names the job the yes will start');
  assert.ok(payload(id).effects.some((e: string) => /answers the pipeline's own staging prompt/.test(e)) && payload(id).effects.some((e: string) => /production is never answered/.test(e)));
  assert.equal(jenkins.actions.length, 0, 'nothing is started in Jenkins before the yes');

  resolveApproval(ticket(id).id, 'approved', { via: 'cookie' });
  await waitFor('the deploy to finish', () => getTask(id)!.state === 'deployed' || getTask(id)!.state === 'needs_owner');
  assert.equal(getTask(id)!.state, 'deployed');
  assert.deepEqual(tickets(id), ['release_stg'], 'the owner was asked once: no deploy ticket, no prompt ticket');
  assert.equal(latestDeploy(id)!.approval_id, ticket(id).id, 'the deploy is tied to the ticket that listed its job');
  assert.deepEqual(posts(JOB), ['/buildWithParameters?BRANCH=stg', '/101/input/Stg1/proceedEmpty'], 'the staging prompt was answered, the production one was not');
  assert.equal(latestDeploy(id)!.outcome, 'deployed');
  assert.ok(said(id).some((t) => /Jenkins asked "Move to STG" .* I answered "Release": it is the staging step you approved\./.test(t)), 'what FryDay answered is said in the chat');
});

test('a prompt that does not name staging outright still goes to the owner', { skip }, async () => {
  const JOB = 'apps/gated';
  jenkins.addJob({ name: JOB, parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: [{ name: 'Build' }, { name: 'Gate', input: { id: 'G1', message: 'Tests passed. Go on to the test environment?' } }], builtSha });
  const id = await reviewed('Gated', JOB, { stage: null });
  resolveApproval(ticket(id).id, 'approved', { via: 'cookie' });
  await waitFor('the prompt to reach the owner', () => ticket(id).action === 'deploy_input' && ticket(id).state === 'pending');
  assert.deepEqual(posts(JOB), ['/buildWithParameters?BRANCH=stg'], 'FryDay did not answer it');
  resolveApproval(ticket(id).id, 'rejected', { via: 'cookie' });
});

// ─── Finding the job ──────────────────────────────────────────────────────────

test('a project with no deployer: FryDay finds its Jenkins job while the team works, says so, and the one yes deploys with it', { skip }, async () => {
  const JOB = 'team/orders-api';
  jenkins.addJob({ name: JOB, parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: [{ name: 'Build' }, { name: 'Deploy', input: { id: 'S1', message: 'Move to STG', proceedText: 'Release' } }], builtSha, remote: 'https://github.com/acme/scratch.git', lastBranch: 'stg' });
  jenkins.addJob({ name: 'team/orders-api-prod', parameters: [{ name: 'BRANCH', defaultValue: 'main' }], stages: [], builtSha, remote: 'https://github.com/acme/scratch.git', lastBranch: 'main' });
  const id = await reviewed('Find the job', null);
  assert.equal((getRepo(REPO)!.deployerConfig as { job: string }).job, JOB, 'kept on the project, so the next task does not look again');
  assert.equal((getRepo(REPO)!.deployerConfig as { branchParam: string }).branchParam, 'BRANCH');
  assert.ok(said(id).some((t) => t.startsWith(`I found the Jenkins job that builds Scratch repo's repository, ${JOB}, and set it as this project's staging deploy.`)));
  assert.equal(payload(id).thenDeploy.job, JOB, 'the approval names the job that was found');
  assert.equal(jenkins.actions.length, jenkins.actions.filter((r) => !r.path.startsWith('/job/team/')).length, 'looking started nothing');

  resolveApproval(ticket(id).id, 'approved', { via: 'cookie' });
  await waitFor('the deploy to finish', () => getTask(id)!.state === 'deployed' || getTask(id)!.state === 'needs_owner');
  assert.equal(getTask(id)!.state, 'deployed');
  assert.deepEqual(posts(JOB), ['/buildWithParameters?BRANCH=stg', '/101/input/S1/proceedEmpty']);
  assert.deepEqual(posts('team/orders-api-prod'), [], 'the production job was never touched');
});

test('when two jobs fit equally FryDay does not pick; the owner names one, and a production job is refused', { skip }, async () => {
  seq++;
  freshRepo(null);
  // The jobs of the test before are still on the stand-in; these two tie with each other above them.
  jenkins.addJob({ name: 'tie/api-stg', parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: [], builtSha, remote: REMOTE, lastBranch: 'stg' });
  jenkins.addJob({ name: 'tie/worker-stg', parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: [], builtSha, remote: REMOTE, lastBranch: 'stg' });
  const several = await ensureDeployer(REPO);
  assert.equal(several.ok, false);
  assert.match(several.sentence, /2 Jenkins jobs build Scratch repo: tie\/api-stg, tie\/worker-stg\. Tell me here which one deploys staging/);
  assert.equal(getRepo(REPO)!.deployer, null, 'nothing was set');

  const prod = await ensureDeployer(REPO, 'team/orders-api-prod');
  assert.equal(prod.ok, false);
  assert.match(prod.sentence, /looks like a production job\. I only ever deploy staging/);
  // A name said in a chat only chooses among the jobs core found for this repository.
  jenkins.addJob({ name: 'other/billing-deploy', parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: [], builtSha, remote: 'git@github.com:acme/billing.git', lastBranch: 'stg' });
  const outside = await ensureDeployer(REPO, 'other/billing-deploy');
  assert.equal(outside.ok, false);
  assert.match(outside.sentence, /other\/billing-deploy is not one of the Jenkins jobs that build Scratch repo's repository \(.*tie\/api-stg.*\)\. To use a different job, set it on the Projects page\./);
  assert.equal(getRepo(REPO)!.deployer, null, 'still nothing set');

  const named = await ensureDeployer(REPO, 'worker-stg');
  assert.ok(named.ok && named.isNew);
  assert.equal((getRepo(REPO)!.deployerConfig as { job: string }).job, 'tie/worker-stg');
});

// ─── The owner's words in the task chat ───────────────────────────────────────

test('"approve" written in the task chat at the UI is the yes; from the Chat space it still needs the code', { skip }, async () => {
  const JOB = 'apps/chat-approve';
  jenkins.addJob({ name: JOB, parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: [{ name: 'Build' }], builtSha });
  const id = await reviewed('Approve in chat', JOB, { stage: null, fryday: [lead('approve', 'Approved, as the report asked.'), lead('approve', 'Approved from Chat.'), lead('approve', 'Approved. Merging it and deploying to staging now.')] });

  // A Lead talked into "approve" by something it read, while the owner only asked a question.
  await ownerWrites(id, 'is the page count field right?');
  assert.equal(ticket(id).state, 'pending', 'nothing was approved: the owner never said so');
  assert.match(said(id).at(-1)!, /^To be safe I only approve when you say it plainly\./);
  assert.deepEqual(jenkins.actions.filter((r) => r.path.includes('chat-approve')), []);

  await ownerWrites(id, 'approve', true);
  assert.equal(ticket(id).state, 'pending', 'a message from the Chat space did not approve anything');
  assert.match(said(id).at(-1)!, /From the Chat space an approval needs its code/);
  const calls = fs.readFileSync(`${planFile}.calls.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { role: string; prompt: string });
  assert.match(calls.filter((c) => c.role === 'fryday').at(-1)!.prompt, /approve: not possible from the Chat space without the code/, 'the Lead was told so before it answered');

  await ownerWrites(id, 'ok approve it');
  assert.equal(said(id).at(-1), 'Approved. Merging it and deploying to staging now.');
  await waitFor('the deploy to finish', () => getTask(id)!.state === 'deployed' || getTask(id)!.state === 'needs_owner');
  assert.equal(getTask(id)!.state, 'deployed');
  assert.match(ticket(id).resolved_by ?? '', /owner, in the task chat/);
});

test('"deploy it" on a task whose project has no deployer: the job is found, the owner sees which, and one more yes in the chat starts it', { skip }, async () => {
  const JOB = 'late/scratch-deploy';
  // While the team worked no single job fitted (the two of the test before tie), so the approval names none.
  const id = await reviewed('Deploy on request', null, { fryday: [lead('deploy', 'On it.'), lead('approve', 'Starting it now.'), lead('stop', 'Stopped.')] });
  // From here the project is a repository Jenkins has no job for yet.
  saveProject({ ...getRepo(REPO)!, remoteUrl: 'git@github.com:acme/late.git' });
  assert.equal(payload(id).thenDeploy, undefined, 'no job was known, so the approval promised no deploy');
  resolveApproval(ticket(id).id, 'approved', { via: 'cookie' });
  await waitFor('the release', () => latestRelease(id)?.state === 'pushed' && getTask(id)!.state === 'needs_owner');
  assert.match(JSON.parse(getTask(id)!.metadata_json!).note, /none of them builds Scratch repo's repository/);

  jenkins.addJob({ name: JOB, parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: [{ name: 'Build' }], builtSha, remote: 'https://github.com/acme/late', lastBranch: 'stg' });
  await ownerWrites(id, 'set the deployer and deploy it to stg');
  assert.match(said(id).at(-1)!, new RegExp(`^I found the Jenkins job that builds Scratch repo's repository, ${JOB}, and set it as this project's staging deploy\\. Approve below and I start it\\.$`));
  assert.equal(ticket(id).action, 'deploy_stg');
  assert.equal(payload(id).job, JOB);
  assert.deepEqual(posts(JOB), [], 'a job the owner has not seen is not started without their yes');

  await ownerWrites(id, 'yes');
  await waitFor('the deploy to finish', () => getTask(id)!.state === 'deployed' || getTask(id)!.state === 'needs_owner');
  assert.equal(getTask(id)!.state, 'deployed');
  assert.deepEqual(posts(JOB), ['/buildWithParameters?BRANCH=stg']);

  await ownerWrites(id, 'stop');
  assert.match(said(id).at(-1)!, /Nothing is running or waiting on this task, so there was nothing to stop/);
});

test('"deploy it" with a job the owner already knows starts it at once', { skip }, async () => {
  const JOB = 'apps/known';
  jenkins.addJob({ name: JOB, parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: [{ name: 'Build', result: 'FAILED' }], builtSha });
  const id = await reviewed('Deploy again', JOB, { stage: null, fryday: [lead('deploy', 'On it.')] });
  resolveApproval(ticket(id).id, 'approved', { via: 'cookie' });
  await waitFor('the first deploy to fail', () => latestDeploy(id)?.state === 'failed' && getTask(id)!.state === 'needs_owner');
  jenkins.addJob({ name: JOB, parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: [{ name: 'Build' }], builtSha });

  await ownerWrites(id, 'try the deploy again');
  assert.match(said(id).at(-1)!, /^Starting the Jenkins job apps\/known to deploy stg\./);
  await waitFor('the second deploy', () => getTask(id)!.state === 'deployed' || (latestDeploy(id)?.state === 'failed' && posts(JOB).length > 1 && getTask(id)!.state === 'needs_owner'));
  assert.equal(getTask(id)!.state, 'deployed');
  assert.deepEqual(tickets(id), ['release_stg', 'deploy_stg'], 'the second deploy has its own ticket');
  assert.equal(ticket(id).state, 'executed');
  assert.match(ticket(id).resolved_by ?? '', /owner, in the task chat/, 'approved in the owner\'s name by what they wrote, not left waiting');
  assert.deepEqual(payload(id).params, { BRANCH: 'stg' });
});
