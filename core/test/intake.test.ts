// Intake with stand-in agents: which project, the Analyst's questions, continuing an
// existing branch (the owner's own, or one with a teammate's commits), documents, notes,
// and what is posted to the Chat space. Real git against a scratch remote on disk.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// The sandbox runs on macOS and on Linux (bubblewrap); elsewhere there is none to test.
const skip = !['darwin', 'linux'].includes(process.platform);
const tmp = path.join(os.homedir(), '.fryday-code', `intake-test-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
const planFile = path.join(tmp, 'script.json');
const wrapper = path.join(tmp, 'claude-wrapper.sh');
fs.writeFileSync(wrapper, `#!/bin/sh\nexport FAKE_PLAN_FILE='${planFile}'\nexec node '${path.join(__dirname, 'fixtures', 'fake-claude.mjs')}' "$@"\n`, { mode: 0o755 });
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_MAC_NOTIFY = 'off';
// These tests are about the pipeline, not about waiting for a busy Mac to have memory.
process.env.FRYDAY_MEMORY_WAIT_MS = '0';
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_RUNS = path.join(tmp, 'runs');
process.env.FRYDAY_WORKTREES = path.join(tmp, 'worktrees');
process.env.FRYDAY_SCRATCH = path.join(tmp, 'scratch');
process.env.FRYDAY_ATTACHMENTS = path.join(tmp, 'attachments');
process.env.CLAUDE_BIN = wrapper;
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';
process.env.FRYDAY_MAX_AGENTS = '2';

import { initDb, getDb } from '../src/db/db';
import { getConfig } from '../src/config';
import { saveProject } from '../src/registry/registry';
import { activeRunIds, stopFollowing } from '../src/runner/supervisor';
import { startTask, registerPipeline, ownerAnswered, StartError } from '../src/pipeline/pipeline';
import { getWorkspaces } from '../src/pipeline/workspaces';
import { getTask } from '../src/pipeline/taskState';
import { latestApproval, resolveApproval } from '../src/pipeline/approvals';
import { answerQuestion, listQuestions, openQuestions, skipOpenQuestions, NO_ANSWER, QuestionError } from '../src/pipeline/questions';
import { addMessage, listMessages } from '../src/pipeline/thread';
import { saveAttachment, listAttachments, safeName, AttachmentError } from '../src/pipeline/attachments';
import { listCandidates, branchFacts } from '../src/pipeline/branches';
import { registerOwnerNotifications } from '../src/notify/owner';
import { saveWebhook, removeWebhook, chatStatus, parseWebhook, setChatTransport, postToChat, ChatConfigError, type Outgoing } from '../src/notify/chat';

const origin = path.join(tmp, 'origin.git');
const main = path.join(tmp, 'main');
const mate = path.join(tmp, 'teammate');
const REPO = 'scratch';
const OTHER = 'billing';
const ME = ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid'];
const THEM = ['-c', 'user.name=Teammate', '-c', 'user.email=teammate@example.invalid'];
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...ME, ...args], { encoding: 'utf8' }).trim();
const remoteSha = (branch: string) => execFileSync('git', ['--git-dir', origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
const remoteHas = (branch: string) => { try { remoteSha(branch); return true; } catch { return false; } };

const BASE_TEST = "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst m = require('../src/math');\ntest('add', () => assert.equal(m.add(2, 3), 5));\n";
const PLAN = {
  summary: 'Add a function.', approach: 'Export it from src/math.js.', flow: [{ step: 'call', detail: 'callers call it' }],
  files: ['src/math.js'], criteria: ['it works'], testPlan: ['node --test'], risks: [], questions: [],
};
const pass = { verdict: 'pass', summary: 'ok', criteria: [{ criterion: 'it works', met: true, evidence: 'ran node --test' }], issues: [] };
const brief = (change: Record<string, unknown> = {}) => ({
  summary: 'Add a function to the math module.', requirements: ['The function exists and is exported.'], areas: ['src/math.js'],
  assumptions: [], risks: [], questions: [], continueOn: '', continueWhy: '', ...change,
});
/** A coder step that appends a new export, so each task changes something. */
const adds = (name: string) => ({ write: { [`src/${name}.js`]: `exports.${name} = () => '${name}';\n` } });

interface Call { role: string; job: string; prompt: string; argv: string[]; cwd: string; taskFolder?: string }
function script(s: Record<string, unknown>) {
  for (const f of [`${planFile}.count.json`, `${planFile}.calls.jsonl`]) fs.rmSync(f, { force: true });
  fs.writeFileSync(planFile, JSON.stringify({ planner: PLAN, tester: [pass], ...s }));
}
const calls = (): Call[] =>
  fs.existsSync(`${planFile}.calls.jsonl`) ? fs.readFileSync(`${planFile}.calls.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

let seq = 0;
function addTask(title: string, description = `${title} — details`): string {
  const id = `T-${++seq}`;
  getDb().prepare(`INSERT INTO tasks (id, seq, title, description, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, 0)`).run(id, seq, title, description);
  return id;
}
const note = (id: string) => JSON.parse(getTask(id)!.metadata_json ?? '{}').note as string;
const RESTING = new Set(['waiting_owner', 'awaiting_approval', 'needs_owner', 'failed']);
async function rest(id: string, timeoutMs = 60_000): Promise<string> {
  const start = Date.now();
  while (!RESTING.has(getTask(id)!.state) || activeRunIds().length > 0) {
    if (Date.now() - start > timeoutMs) throw new Error(`${id} still ${getTask(id)!.state} after ${timeoutMs} ms: ${note(id)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return getTask(id)!.state;
}
/** Approve the task's open ticket as the owner at the UI and wait for what it started to finish. */
async function approve(id: string): Promise<string> {
  const ticket = latestApproval(id)!;
  let done = false;
  resolveApproval(ticket.id, 'approved', { via: 'cookie' }, () => { done = true; });
  const start = Date.now();
  while (!done) {
    if (Date.now() - start > 60_000) throw new Error(`approval of ${ticket.action} did not finish`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return rest(id);
}
const ticketOf = (id: string) => {
  const t = latestApproval(id)!;
  return { action: t.action, state: t.state, payload: JSON.parse(t.payload_json) as { summary: string; pushes: string[]; notPushed?: string[] } };
};

/** A branch on the remote with one commit by `who`, cut from production. */
function remoteBranch(name: string, file: string, who: string[]): string {
  const repo = who === THEM ? mate : main;
  execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin']);
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-B', name, 'origin/release']);
  fs.writeFileSync(path.join(repo, 'src', file), `exports.started = '${name}';\n`);
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, ...who, 'commit', '-q', '-m', `start ${name}`]);
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', name]);
  execFileSync('git', ['-C', repo, 'checkout', '-q', repo === main ? 'release' : 'origin/release']);
  return remoteSha(name);
}

// ─── Chat space: capture instead of sending ───────────────────────────────────
const posted: Outgoing[] = [];
const FAKE_WEBHOOK = 'https://chat.googleapis.com/v1/spaces/AAAAtest/messages?key=not-a-real-key&token=not-a-real-token';
const postedFor = (id: string) => posted.filter((m) => m.body.thread?.threadKey === `fryday-${id}`).map((m) => m.body.text);
const settle = () => new Promise((r) => setTimeout(r, 50));

let ownerBefore = '';
const ownerState = () => `${sh(main, 'status', '--porcelain')}|${sh(main, 'rev-parse', 'HEAD')}|${sh(main, 'rev-parse', '--abbrev-ref', 'HEAD')}`;

before(() => {
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  fs.mkdirSync(path.join(main, 'test'), { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'release', origin]);
  execFileSync('git', ['init', '-q', '-b', 'release', main]);
  sh(main, 'config', 'user.email', 'owner@example.invalid');
  sh(main, 'config', 'user.name', 'Owner');
  fs.writeFileSync(path.join(main, 'src', 'math.js'), 'exports.add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(main, 'test', 'math.test.js'), BASE_TEST);
  fs.writeFileSync(path.join(main, 'package.json'), '{"name":"scratch","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(main, 'README.md'), '# Scratch\n\nA small math library.\n');
  sh(main, 'add', '-A');
  sh(main, 'commit', '-q', '-m', 'init');
  sh(main, 'remote', 'add', 'origin', origin);
  sh(main, 'push', '-q', '-u', 'origin', 'release');
  sh(main, 'push', '-q', 'origin', 'release:stg');
  execFileSync('git', ['clone', '-q', origin, mate]);

  initDb(process.env.FRYDAY_DB!);
  registerPipeline();
  registerOwnerNotifications();
  setChatTransport(async (m) => { posted.push(m); return { ok: true, status: 200 }; });
  saveWebhook(FAKE_WEBHOOK);
  saveProject({ id: REPO, name: 'Scratch repo', localPath: main, prodBranch: 'release', stgBranch: 'stg', testCmd: 'node --test', verified: true });
  saveProject({ id: OTHER, name: 'Billing service', localPath: main, prodBranch: 'release', verified: true });
  ownerBefore = ownerState();
});
after(() => { stopFollowing(); setChatTransport(null); fs.rmSync(tmp, { recursive: true, force: true }); });

// ─── Questions ────────────────────────────────────────────────────────────────

test('an unclear task asks before any code is written, and goes on from the answers', { skip }, async () => {
  const unclear = brief({
    requirements: [],
    questions: [
      { question: 'Should the export be CSV or JSON?', why: 'The task does not say and the two need different code.', options: ['CSV', 'JSON'] },
      { question: 'Which columns belong in it?', why: 'No document lists them.', options: [] },
    ],
  });
  script({ analyst: [unclear, brief()], coder: [adds('exporter')] });
  const id = addTask('Make the export better');
  startTask(id, REPO);
  assert.equal(await rest(id), 'waiting_owner');
  assert.equal(note(id), '2 questions for you before any code is written.');

  // Nothing was built: no workspace, no planner, no coder.
  assert.deepEqual(getWorkspaces(id), []);
  assert.deepEqual(calls().map((c) => c.role), ['analyst']);
  const [format, columns] = openQuestions(id);
  assert.deepEqual(format!.options.map((o) => o.label), ['CSV', 'JSON']);
  assert.equal(columns!.options.length, 0);
  await settle();
  assert.match(postedFor(id).at(-1)!, /2 questions for you before any code is written\.\n1\. Should the export be CSV or JSON\? \(CSV \/ JSON\)\n2\. Which columns belong in it\?/);

  // One answer is not enough to go on.
  answerQuestion(id, format!.id, 'CSV');
  assert.equal(ownerAnswered(id), false);
  assert.equal(getTask(id)!.state, 'waiting_owner');
  assert.throws(() => answerQuestion(id, format!.id, 'JSON'), (e: unknown) => e instanceof QuestionError && e.status === 409);
  assert.throws(() => answerQuestion(id, columns!.id, '   '), (e: unknown) => e instanceof QuestionError && e.status === 400);

  answerQuestion(id, columns!.id, 'id, name and total');
  assert.equal(ownerAnswered(id), true);
  assert.equal(await rest(id), 'awaiting_approval');

  // The Analyst ran again with the answers in front of it; they also reached the planner.
  const analystRuns = calls().filter((c) => c.role === 'analyst');
  assert.equal(analystRuns.length, 2);
  assert.match(analystRuns[1]!.taskFolder!, /## Answers from the owner\n\n- Q: Should the export be CSV or JSON\?\n  A: CSV\n- Q: Which columns belong in it\?\n  A: id, name and total/);
  assert.match(calls().find((c) => c.role === 'planner')!.prompt, /## Answers from the owner[\s\S]*A: id, name and total/);
  // The thread tells the story in order.
  const kinds = listMessages(id).map((m) => `${m.author}:${m.kind}`);
  assert.ok(kinds.indexOf('analyst:question') < kinds.indexOf('owner:answer'));
});

test('the owner can say "go ahead", and the Analyst cannot keep asking for ever', { skip }, async () => {
  const asks = brief({ questions: [{ question: 'Round or truncate?', why: 'Both are plausible.', options: [] }] });
  script({ analyst: [asks, asks, asks], coder: [adds('rounding')] });
  const id = addTask('Tidy the totals');
  startTask(id, REPO);
  assert.equal(await rest(id), 'waiting_owner');
  assert.equal(skipOpenQuestions(id), 1);
  assert.equal(listQuestions(id)[0]!.answer, NO_ANSWER);
  assert.equal(ownerAnswered(id), true);

  // Second round of questions is allowed; a third is not, and work starts.
  assert.equal(await rest(id), 'waiting_owner');
  answerQuestion(id, openQuestions(id)[0]!.id, 'Round half up');
  ownerAnswered(id);
  assert.equal(await rest(id), 'awaiting_approval');
  assert.equal(calls().filter((c) => c.role === 'analyst').length, 3);
  assert.equal(listQuestions(id).length, 2, 'the third set of questions was not put to the owner');
});

// ─── Which project ────────────────────────────────────────────────────────────

test('a task without a project: a sure Analyst picks it, an unsure one asks', { skip }, async () => {
  script({ triage: [{ projectId: REPO, confidence: 'sure', reason: 'The task is about the math library.' }], coder: [adds('picked')] });
  const sure = addTask('Add a square function to the math library');
  startTask(sure);
  assert.equal(await rest(sure), 'awaiting_approval');
  assert.equal(getWorkspaces(sure)[0]!.repo_id, REPO);
  const triage = calls().find((c) => c.job === 'triage')!;
  assert.match(triage.taskFolder!, /## Projects to choose from[\s\S]*### billing\nName: Billing service[\s\S]*### scratch\nName: Scratch repo/);
  assert.match(triage.taskFolder!, /> A small math library\./, 'each project is described from its README');
  assert.equal(triage.argv[triage.argv.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(listQuestions(sure).length, 0);

  // Unsure, or a project that does not exist: the owner is asked, with the real projects as the choices.
  script({ triage: [{ projectId: 'made-up', confidence: 'sure', reason: 'Guessing.' }], coder: [adds('asked')] });
  const asked = addTask('Fix the rounding');
  startTask(asked);
  assert.equal(await rest(asked), 'waiting_owner');
  const [q] = openQuestions(asked);
  assert.equal(q!.kind, 'project');
  assert.deepEqual(q!.options, [{ value: OTHER, label: 'Billing service' }, { value: REPO, label: 'Scratch repo' }]);
  assert.throws(() => answerQuestion(asked, q!.id, 'made-up'), (e: unknown) => e instanceof QuestionError && /one of the options/.test(e.message));
  answerQuestion(asked, q!.id, REPO);
  assert.equal(ownerAnswered(asked), true);
  assert.equal(await rest(asked), 'awaiting_approval');
  assert.equal(getWorkspaces(asked)[0]!.repo_id, REPO);

  assert.throws(() => startTask(addTask('Branch without a project'), null, { branch: 'feat/x' }), (e: unknown) => e instanceof StartError && /Choose the project/.test(e.message));
  assert.throws(() => startTask(addTask('Bad branch name'), REPO, { branch: '--upload-pack=x' }), (e: unknown) => e instanceof StartError && /not a branch name/.test(e.message));
});

// ─── Existing branches ────────────────────────────────────────────────────────

test('branches are read from git: whose they are, and which are worth offering', { skip }, () => {
  remoteBranch('feat/mine', 'mine.js', ME);
  remoteBranch('feat/theirs', 'theirs.js', THEM);
  execFileSync('git', ['-C', main, 'fetch', '-q', 'origin']);
  const names = listCandidates(main, 'release', 'stg').map((c) => c.name);
  assert.ok(names.includes('feat/mine') && names.includes('feat/theirs'));
  assert.equal(names.includes('release') || names.includes('stg') || names.includes('HEAD'), false, 'production and staging are never offered');

  const mine = branchFacts(main, 'release', 'feat/mine')!;
  assert.deepEqual([mine.ahead, mine.byOthers, mine.owned], [1, 0, true]);
  const theirs = branchFacts(main, 'release', 'feat/theirs')!;
  assert.deepEqual([theirs.ahead, theirs.byOthers, theirs.owned], [1, 1, false]);
  assert.equal(branchFacts(main, 'release', 'no/such-branch'), null);
  assert.deepEqual(listCandidates(main, 'release', 'stg').find((c) => c.name === 'feat/mine')!.files, ['src/mine.js']);
  // Too old to be this task's work.
  assert.deepEqual(listCandidates(main, 'release', 'stg', Date.now() + 200 * 86_400_000), []);
});

test("the owner's own branch: asked first, continued, pushed back to it on approval, then staging is a separate yes", { skip }, async () => {
  const cut = remoteSha('feat/mine');
  script({ analyst: [brief({ continueOn: 'feat/mine', continueWhy: 'It already starts this function.' })], coder: [adds('finished')] });
  const id = addTask('Finish the mine function');
  startTask(id, REPO);
  assert.equal(await rest(id), 'waiting_owner');
  const [q] = openQuestions(id);
  assert.equal(q!.kind, 'branch');
  assert.equal(q!.question, 'Continue on the existing branch feat/mine?');
  assert.match(q!.why!, /It already starts this function\. All of its commits are yours, so the work can be pushed back to it when you approve\./);
  assert.match(calls()[0]!.taskFolder!, /- `feat\/mine` — 1 commit, last today: "start feat\/mine"; changes src\/mine\.js/);

  answerQuestion(id, q!.id, 'continue:feat/mine');
  ownerAnswered(id);
  assert.equal(await rest(id), 'awaiting_approval');

  // The work sits on FryDay's own local branch, cut from the tip of the owner's branch.
  const [ws] = getWorkspaces(id);
  assert.deepEqual([ws!.base_ref, ws!.base_sha, ws!.target_branch, ws!.target_owned], ['origin/feat/mine', cut, 'feat/mine', 1]);
  assert.match(ws!.branch, /^feat\/fryday-/);
  assert.match(calls().find((c) => c.role === 'planner')!.prompt, /## Existing work\n\nThis task continues the branch `feat\/mine`[\s\S]*start feat\/mine/);

  // The ticket says exactly what is pushed where. Nothing has been pushed yet.
  let ticket = ticketOf(id);
  assert.equal(ticket.action, 'push_branch');
  assert.equal(ticket.payload.summary, 'Push 1 new commit to your branch feat/mine (Scratch repo)');
  assert.deepEqual(ticket.payload.pushes, ['1 commit → origin/feat/mine (your existing branch; not forced)']);
  assert.equal(remoteSha('feat/mine'), cut);
  await settle();
  assert.match(postedFor(id).at(-1)!, /Needs your decision: Push 1 new commit to your branch feat\/mine \(Scratch repo\)\nThis will push:\n• 1 commit → origin\/feat\/mine/);

  assert.equal(await approve(id), 'awaiting_approval');
  assert.equal(remoteSha('feat/mine'), ws!.head_sha ?? getWorkspaces(id)[0]!.head_sha);
  assert.equal(remoteHas(ws!.branch), false, "FryDay's own branch name never reached the remote");
  assert.match(note(id), /^Pushed to feat\/mine \([0-9a-f]{8}\)\. Merging into stg is a separate decision/);

  // Staging: its own ticket, which says the earlier commit comes along and lists the one push.
  ticket = ticketOf(id);
  assert.equal(ticket.action, 'release_stg');
  assert.equal(ticket.payload.summary, 'Merge feat/mine into stg (Scratch repo). The merge also brings 1 earlier commit from feat/mine into stg, 0 of them by other people.');
  assert.deepEqual(ticket.payload.pushes, ['a merge commit → origin/stg (not forced)']);
  const stgBefore = remoteSha('stg');
  assert.equal(await approve(id), 'needs_owner');
  assert.match(note(id), /^Merged into stg and pushed/);
  assert.notEqual(remoteSha('stg'), stgBefore);
  const onStg = execFileSync('git', ['--git-dir', origin, 'ls-tree', '-r', '--name-only', 'stg'], { encoding: 'utf8' });
  assert.match(onStg, /src\/mine\.js/, 'the earlier commit of the branch is in the merge');
  assert.match(onStg, /src\/finished\.js/);
  assert.equal(remoteHas(ws!.branch), false);
  assert.match(execFileSync('git', ['--git-dir', origin, 'log', '-1', '--format=%s', 'stg'], { encoding: 'utf8' }), /^Merge feat\/mine into stg/);
});

test("a teammate's branch is never pushed to: FryDay pushes its own branch for a pull request", { skip }, async () => {
  const theirs = remoteSha('feat/theirs');
  script({ coder: [adds('helped')] });
  const id = addTask('Help finish their feature');
  startTask(id, REPO, { branch: 'origin/feat/theirs' });
  assert.equal(await rest(id), 'awaiting_approval', note(id));
  assert.equal(listQuestions(id).length, 0, 'the owner named the branch, so nothing is asked');
  assert.match(calls()[0]!.taskFolder!, /The owner asked for this task to continue on the existing branch `feat\/theirs`/);

  const [ws] = getWorkspaces(id);
  assert.deepEqual([ws!.base_sha, ws!.target_branch, ws!.target_owned], [theirs, 'feat/theirs', 0]);
  const ticket = ticketOf(id);
  assert.equal(ticket.action, 'push_branch');
  assert.equal(ticket.payload.summary, `Push FryDay's own branch ${ws!.branch} for a pull request into feat/theirs (Scratch repo)`);
  assert.deepEqual(ticket.payload.pushes, [`${ws!.branch} → origin/${ws!.branch} (a new branch)`]);
  assert.deepEqual(ticket.payload.notPushed, ['feat/theirs is not pushed to: it has commits by other people']);

  assert.equal(await approve(id), 'awaiting_approval');
  assert.equal(remoteSha('feat/theirs'), theirs, "the teammate's branch is exactly where it was");
  assert.equal(remoteSha(ws!.branch), getWorkspaces(id)[0]!.head_sha);
  assert.match(note(id), new RegExp(`^Pushed ${ws!.branch} \\([0-9a-f]{8}\\)\\. Open a pull request from it into feat/theirs; feat/theirs itself was not pushed to\\.`));

  // The staging ticket says how many of the commits it carries are someone else's.
  const release = ticketOf(id);
  assert.equal(release.action, 'release_stg');
  assert.match(release.payload.summary, /The merge also brings 1 earlier commit from feat\/theirs into stg, 1 of them by other people\./);
  // Declining leaves staging alone.
  const stgBefore = remoteSha('stg');
  resolveApproval(latestApproval(id)!.id, 'rejected', { via: 'cookie' });
  assert.equal(remoteSha('stg'), stgBefore);
  assert.equal(getTask(id)!.state, 'needs_owner');
});

test('a branch that moved on the remote, or gained someone else\'s commits, is not pushed to', { skip }, async () => {
  remoteBranch('feat/moving', 'moving.js', ME);
  script({ coder: [adds('late')] });
  const moved = addTask('Continue the moving branch');
  startTask(moved, REPO, { branch: 'feat/moving' });
  assert.equal(await rest(moved), 'awaiting_approval');
  assert.equal(ticketOf(moved).action, 'push_branch');

  // Someone pushes to the branch while the ticket is waiting.
  execFileSync('git', ['-C', mate, 'fetch', '-q', 'origin']);
  execFileSync('git', ['-C', mate, 'checkout', '-q', '-B', 'feat/moving', 'origin/feat/moving']);
  fs.writeFileSync(path.join(mate, 'src', 'elsewhere.js'), 'exports.elsewhere = 1;\n');
  execFileSync('git', ['-C', mate, 'add', '-A']);
  execFileSync('git', ['-C', mate, ...THEM, 'commit', '-q', '-m', 'a change made elsewhere']);
  execFileSync('git', ['-C', mate, 'push', '-q', 'origin', 'feat/moving']);
  const after = remoteSha('feat/moving');

  assert.equal(await approve(moved), 'needs_owner');
  assert.match(note(moved), /^feat\/moving now has commits by someone else, so FryDay will not push to it\. Nothing was pushed/);
  assert.equal(remoteSha('feat/moving'), after, 'nothing was pushed and nothing was forced');

  // A branch the Analyst names that was never in the list it was shown is ignored.
  script({ analyst: [brief({ continueOn: 'feat/mine; rm -rf ~', continueWhy: 'trust me' })], coder: [adds('fresh')] });
  const fresh = addTask('A task the Analyst tries to misdirect');
  startTask(fresh, REPO);
  assert.equal(await rest(fresh), 'awaiting_approval');
  assert.equal(listQuestions(fresh).length, 0);
  const [ws] = getWorkspaces(fresh);
  assert.deepEqual([ws!.base_ref, ws!.target_branch], ['origin/release', null]);
  assert.equal(ticketOf(fresh).action, 'release_stg');
  assert.deepEqual(ticketOf(fresh).payload.pushes, [`${ws!.branch} → origin/${ws!.branch} (a new branch)`, 'a merge commit → origin/stg (not forced)']);
});

// ─── Documents and notes ──────────────────────────────────────────────────────

test('documents are checked on the way in, read by the Analyst, and reach the planner', { skip }, async () => {
  const dir = getConfig().attachmentsDir;
  const id = addTask('Build what the PRD says');
  assert.equal(safeName('../../etc/pass wd.md'), 'pass_wd.md');
  assert.equal(safeName('.hidden.txt'), 'hidden.txt');
  assert.throws(() => saveAttachment(id, dir, 'run.sh', Buffer.from('echo hi')), (e: unknown) => e instanceof AttachmentError && /Only \.md, \.txt and \.pdf/.test(e.message));
  assert.throws(() => saveAttachment(id, dir, 'fake.pdf', Buffer.from('not a pdf at all')), /is not a PDF/);
  assert.throws(() => saveAttachment(id, dir, 'binary.txt', Buffer.from([0x68, 0x00, 0x69])), /not plain text/);
  assert.throws(() => saveAttachment(id, dir, 'empty.md', Buffer.alloc(0)), /empty/);

  const prd = saveAttachment(id, dir, 'Loyalty PRD.md', Buffer.from('# Loyalty points\n\nCustomers earn 3 points per order above 500.\n'));
  saveAttachment(id, dir, 'spec.pdf', Buffer.from('%PDF-1.4\n%stand-in\n'));
  assert.deepEqual([prd.name, prd.media], ['Loyalty_PRD.md', 'markdown']);
  assert.equal(listAttachments(id).length, 2);
  // Kept where no agent can read, readable only by the developer.
  const stored = fs.readdirSync(path.join(dir, id)).map((f) => fs.statSync(path.join(dir, id, f)).mode & 0o777);
  assert.deepEqual(stored, [0o600, 0o600]);

  addMessage(id, 'owner', 'note', 'Points are whole numbers, never fractions.');
  script({ coder: [adds('loyalty')] });
  startTask(id, REPO);
  assert.equal(await rest(id), 'awaiting_approval');

  const analyst = calls().find((c) => c.role === 'analyst')!;
  assert.match(analyst.taskFolder!, /## Documents from the owner\n\nRead all of them; they are part of the task\.\n\n- FRYDAY_TASK\/documents\/Loyalty_PRD\.md\n- FRYDAY_TASK\/documents\/spec\.pdf/);
  assert.match(analyst.taskFolder!, /## Notes from the owner\n\n- Points are whole numbers, never fractions\./);
  const planner = calls().find((c) => c.role === 'planner')!;
  assert.match(planner.prompt, /## Notes from the owner\n\n- Points are whole numbers, never fractions\./);
  assert.match(planner.prompt, /### Loyalty_PRD\.md\n\n# Loyalty points\n\nCustomers earn 3 points per order above 500\./);
  assert.match(planner.prompt, /### spec\.pdf\n\n\(A PDF\. The Analyst read it/);
  assert.match(calls().find((c) => c.role === 'coder')!.prompt, /Customers earn 3 points per order above 500\./);
  // The documents never became part of the change.
  assert.equal(getWorkspaces(id)[0]!.files_json!.includes('FRYDAY_TASK'), false);
});

// ─── Chat space ───────────────────────────────────────────────────────────────

test('the Chat webhook is checked, kept private, and a failed post never stops anything', { skip }, async () => {
  assert.throws(() => parseWebhook('https://evil.example/v1/spaces/AAAA/messages?key=k&token=t'), ChatConfigError);
  assert.throws(() => parseWebhook('http://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t'), ChatConfigError);
  assert.throws(() => parseWebhook('https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k'), /incomplete/);
  assert.throws(() => parseWebhook('https://chat.googleapis.com.evil.example/v1/spaces/AAAA/messages?key=k&token=t'), ChatConfigError);

  const status = chatStatus();
  assert.deepEqual([status.configured, status.space], [true, 'spaces/AAAAtest']);
  assert.equal(JSON.stringify(status).includes('not-a-real-token'), false, 'the address is never handed back');
  assert.equal(fs.statSync(path.join(tmp, 'chat-webhook')).mode & 0o777, 0o600);

  // Every task posts in its own thread, and messages carry the task's name.
  const anyTask = posted.find((m) => m.body.thread)!;
  assert.match(anyTask.url, /messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD/);
  assert.match(anyTask.body.text, /^\*T-\d+ · /);

  // A space that refuses, or cannot be reached: recorded, never thrown, and the address stays out of the error.
  setChatTransport(async () => ({ ok: false, status: 404 }));
  assert.equal(await postToChat('hello'), false);
  assert.match(chatStatus().lastError!, /refused the message \(404\)/);
  setChatTransport(async () => { throw new Error(`connect ECONNREFUSED ${FAKE_WEBHOOK}`); });
  assert.equal(await postToChat('hello'), false);
  assert.equal(chatStatus().lastError, 'Google Chat could not be reached.');

  removeWebhook();
  assert.equal(chatStatus().configured, false);
  assert.equal(await postToChat('nobody is listening'), false);
  setChatTransport(async (m) => { posted.push(m); return { ok: true, status: 200 }; });
  saveWebhook(FAKE_WEBHOOK);
});

test("through all of it the owner's working copy was never touched", { skip }, () => {
  assert.equal(ownerState(), ownerBefore);
});
