// From "passed review" to staging and back: approval tickets, the release they trigger,
// revert and restart recovery. Stand-in agents, real git, real sandboxed checks, and a
// bare repo on disk as the remote.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// The sandbox runs on macOS and on Linux (bubblewrap); elsewhere there is none to test.
const skip = !['darwin', 'linux'].includes(process.platform);
const tmp = path.join(os.homedir(), '.fryday-code', `release-flow-test-${randomBytes(4).toString('hex')}`);
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

import { initDb, getDb } from '../src/db/db';
import { saveProject } from '../src/registry/registry';
import { activeRunIds, stopFollowing } from '../src/runner/supervisor';
import { startTask, registerPipeline } from '../src/pipeline/pipeline';
import { getTask } from '../src/pipeline/taskState';
import { activeWorkspace } from '../src/pipeline/workspaces';
import { commitAll } from '../src/pipeline/worktrees';
import {
  resolveApproval, requestReleaseApproval, latestApproval, pendingApprovals, publicApproval, getApproval, ApprovalError,
} from '../src/pipeline/approvals';
import { latestRelease, revertTaskRelease, reconcileReleasesOnStartup } from '../src/pipeline/releaseFlow';

const REPO = 'scratch';
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();

const MATH = "const { id } = require('./util');\nexports.add = (a, b) => id(a + b);\nexports.mul = (a, b) => id(a * b);\n";
const TEST = "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst m = require('../src/math');\ntest('add', () => assert.equal(m.add(2, 3), 5));\ntest('mul', () => assert.equal(m.mul(2, 3), 6));\n";
const PLAN = {
  summary: 'Add mul.', approach: 'Export mul from src/math.js.', flow: [{ step: 'call', detail: 'mul(a, b)' }],
  files: ['src/math.js'], criteria: ['mul(2, 3) returns 6'], testPlan: ['node --test'], risks: [], questions: [],
};
const PASS = { verdict: 'pass', summary: 'ok', criteria: [{ criterion: PLAN.criteria[0], met: true, evidence: 'ran it' }], issues: [] };

let repoN = 0;
let seq = 0;
interface Repo { origin: string; main: string; other: string; hookMarker: string }

/** A fresh scratch repo (release + stg on a bare remote) that the project REPO points at. */
function freshRepo(): Repo {
  const dir = path.join(tmp, `repo${++repoN}`);
  const origin = path.join(dir, 'origin.git'); const main = path.join(dir, 'main'); const other = path.join(dir, 'other');
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  fs.mkdirSync(path.join(main, 'test'), { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'release', origin]);
  execFileSync('git', ['init', '-q', '-b', 'release', main]);
  sh(main, 'config', 'user.name', 'Owner');
  sh(main, 'config', 'user.email', 'owner@example.invalid');
  fs.writeFileSync(path.join(main, 'src', 'util.js'), 'exports.id = (x) => x;\n');
  fs.writeFileSync(path.join(main, 'src', 'math.js'), 'exports.add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(main, 'test', 'math.test.js'), "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst m = require('../src/math');\ntest('add', () => assert.equal(m.add(2, 3), 5));\n");
  fs.writeFileSync(path.join(main, 'package.json'), '{"name":"scratch","version":"1.0.0"}\n');
  sh(main, 'add', '-A');
  sh(main, 'commit', '-q', '-m', 'init');
  sh(main, 'remote', 'add', 'origin', origin);
  sh(main, 'push', '-q', 'origin', 'release', 'release:stg');
  execFileSync('git', ['clone', '-q', origin, other]);
  const hookMarker = path.join(dir, 'hook-ran');
  for (const hook of ['pre-push', 'post-merge', 'post-checkout', 'post-commit']) {
    fs.writeFileSync(path.join(main, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> ${hookMarker}\n`, { mode: 0o755 });
  }
  saveProject({ id: REPO, name: 'Scratch repo', localPath: main, prodBranch: 'release', stgBranch: 'stg', testCmd: 'node --test', verified: true });
  return { origin, main, other, hookMarker };
}

function stgCommit(repo: Repo, change: (dir: string) => void, messageText: string): string {
  sh(repo.other, 'fetch', '-q', 'origin');
  sh(repo.other, 'checkout', '-q', '-B', 'stg', 'origin/stg');
  change(repo.other);
  sh(repo.other, 'add', '-A');
  sh(repo.other, 'commit', '-q', '-m', messageText);
  sh(repo.other, 'push', '-q', 'origin', 'stg');
  return sh(repo.other, 'rev-parse', 'HEAD');
}

const note = (id: string) => JSON.parse(getTask(id)!.metadata_json ?? '{}').note as string;
async function waitFor(what: string, cond: () => boolean, timeoutMs = 60_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Run a task through plan, code, checks and review until it is waiting for the owner's yes. */
async function passedTask(title: string): Promise<string> {
  for (const f of [`${planFile}.count.json`, `${planFile}.calls.jsonl`]) fs.rmSync(f, { force: true });
  fs.writeFileSync(planFile, JSON.stringify({ planner: PLAN, coder: [{ write: { 'src/math.js': MATH, 'test/math.test.js': TEST } }], tester: [PASS] }));
  const id = `T-${++seq}`;
  getDb().prepare(`INSERT INTO tasks (id, seq, title, description, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, 0)`).run(id, seq, title, title);
  startTask(id, REPO);
  await waitFor(`${id} to pass review`, () => getTask(id)!.state === 'awaiting_approval' && activeRunIds().length === 0 && latestApproval(id) !== undefined);
  return id;
}

/** Approve from the UI and wait until the release is over. */
async function approve(id: string): Promise<void> {
  let done = false;
  resolveApproval(latestApproval(id)!.id, 'approved', { via: 'cookie' }, () => { done = true; });
  await waitFor(`${id} release to finish`, () => done);
}

before(() => { initDb(process.env.FRYDAY_DB!); registerPipeline(); });
after(() => { stopFollowing(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('passing review raises a ticket for exactly that commit; the UI approves it and core merges and pushes', { skip }, async () => {
  const repo = freshRepo();
  const stgBefore = sh(repo.origin, 'rev-parse', 'stg');
  const id = await passedTask('Add mul');
  const ws = activeWorkspace(id)!;

  const ticket = latestApproval(id)!;
  assert.equal(ticket.state, 'pending');
  assert.equal(ticket.action, 'release_stg');
  assert.equal(ticket.commit_sha, ws.head_sha);
  assert.equal(JSON.parse(ticket.payload_json).summary, `Push ${ws.branch} and merge it into stg (Scratch repo)`);
  assert.match(note(id), /Approve to merge it into stg\.$/);
  assert.deepEqual(pendingApprovals().map((a) => a.id), [ticket.id]);
  assert.equal('code' in publicApproval(ticket), false, 'the one-time code is never handed to the UI');
  assert.equal(sh(repo.origin, 'rev-parse', 'stg'), stgBefore, 'nothing is pushed before the owner says yes');

  await approve(id);
  const release = latestRelease(id)!;
  assert.deepEqual([release.state, release.outcome, release.strategy], ['pushed', 'pushed', 'merge']);
  assert.equal(release.stg_before_sha, stgBefore);
  assert.equal(sh(repo.origin, 'rev-parse', 'stg'), release.merge_sha);
  assert.equal(sh(repo.origin, 'show', 'stg:src/math.js'), MATH.trim());
  assert.equal(getApproval(ticket.id)!.state, 'executed');
  assert.equal(getTask(id)!.state, 'needs_owner');
  assert.match(note(id), new RegExp(`^Merged into stg and pushed \\(merge ${release.merge_sha!.slice(0, 8)}\\)\\. Jenkins is not connected here, so I could not deploy stg\\.`));
  // A used ticket cannot be used again, and a merged task cannot be released twice.
  assert.throws(() => resolveApproval(ticket.id, 'approved', { via: 'cookie' }), (e: unknown) => e instanceof ApprovalError && e.status === 409);
  assert.throws(() => requestReleaseApproval(id), /already merged into stg/);
  assert.equal(fs.existsSync(repo.hookMarker), false, 'a repo hook ran');
  assert.equal(fs.existsSync(`${ws.worktree_path}.release`), false);

  // Revert: a new commit on staging takes the change out again.
  const reverted = await revertTaskRelease(id);
  assert.equal(reverted.state, 'reverted');
  assert.equal(sh(repo.origin, 'rev-parse', 'stg'), reverted.revert_sha);
  assert.equal(sh(repo.origin, 'show', 'stg:src/math.js'), 'exports.add = (a, b) => a + b;');
  sh(repo.origin, 'merge-base', '--is-ancestor', release.merge_sha!, 'stg');
  assert.match(note(id), /^Reverted on stg with commit [0-9a-f]{8}\. The task branch is kept\./);
  await assert.rejects(revertTaskRelease(id), /nothing on staging to revert/);
  assert.equal(fs.existsSync(repo.hookMarker), false, 'a repo hook ran');
});

test('a caller with the core token needs the one-time code; the UI does not', { skip }, async () => {
  const repo = freshRepo();
  const id = await passedTask('Add mul via chat');
  const ticket = latestApproval(id)!;
  assert.match(ticket.code!, /^\d{6}$/);
  const refused = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof ApprovalError && e.status === 403);
  refused(() => resolveApproval(ticket.id, 'approved', { via: 'token' }));
  refused(() => resolveApproval(ticket.id, 'approved', { via: 'token', code: '000000' === ticket.code ? '111111' : '000000' }));
  refused(() => resolveApproval(ticket.id, 'rejected', { via: 'token' }));
  assert.equal(getApproval(ticket.id)!.state, 'pending');
  assert.equal(latestRelease(id), undefined);

  let done = false;
  const approved = resolveApproval(ticket.id, 'approved', { via: 'token', code: ticket.code! }, () => { done = true; });
  assert.equal(approved.resolved_by, 'chat');
  await waitFor('release', () => done);
  assert.equal(latestRelease(id)!.state, 'pushed');
  assert.equal(sh(repo.origin, 'show', 'stg:src/math.js'), MATH.trim());
});

test('an approval is void once the branch has moved; declining pushes nothing; asking again works', { skip }, async () => {
  const repo = freshRepo();
  const stgBefore = sh(repo.origin, 'rev-parse', 'stg');
  const id = await passedTask('Add mul, then change it');
  const ws = activeWorkspace(id)!;
  const first = latestApproval(id)!;

  // Something lands on the branch after the ticket was raised.
  fs.writeFileSync(path.join(ws.worktree_path, 'late.js'), 'exports.late = true;\n');
  const newHead = commitAll(ws.worktree_path, 'a late change nobody reviewed')!;
  assert.throws(() => resolveApproval(first.id, 'approved', { via: 'cookie' }), /the approval is void/);
  assert.equal(getApproval(first.id)!.state, 'expired');
  assert.match(note(id), new RegExp(`for commit ${first.commit_sha!.slice(0, 8)}, but the branch is now at ${newHead.slice(0, 8)}`));
  assert.equal(latestRelease(id), undefined);
  assert.equal(sh(repo.origin, 'rev-parse', 'stg'), stgBefore);

  // Core records the new head (as a review round would); a fresh ticket is then for that commit.
  getDb().prepare('UPDATE task_workspaces SET head_sha = ? WHERE task_id = ?').run(newHead, id);
  const second = requestReleaseApproval(id);
  assert.equal(second.commit_sha, newHead);

  // Declining keeps everything local.
  const declined = resolveApproval(second.id, 'rejected', { via: 'cookie' });
  assert.equal(declined.state, 'rejected');
  assert.equal(getTask(id)!.state, 'needs_owner');
  assert.equal(note(id), 'You declined the release. The branch is kept; nothing was pushed.');
  assert.equal(sh(repo.origin, 'rev-parse', 'stg'), stgBefore);
  assert.throws(() => sh(repo.origin, 'rev-parse', '--verify', `refs/heads/${ws.branch}`), 'the task branch was not pushed either');

  // The owner changes their mind: a new ticket voids nothing else and releases the new head.
  const third = requestReleaseApproval(id);
  assert.deepEqual(pendingApprovals().map((a) => a.id), [third.id]);
  await approve(id);
  assert.equal(latestRelease(id)!.state, 'pushed');
  assert.equal(sh(repo.origin, 'show', 'stg:late.js'), 'exports.late = true;');
});

test('a conflict with staging stops the release and can be retried once staging is fixed', { skip }, async () => {
  const repo = freshRepo();
  const theirs = stgCommit(repo, (dir) => fs.writeFileSync(path.join(dir, 'src', 'math.js'), 'exports.add = (a, b) => a + b; // tuned on staging\n'), 'stg-only tweak');
  const id = await passedTask('Add mul against a changed staging');
  await approve(id);

  const release = latestRelease(id)!;
  assert.deepEqual([release.state, release.outcome, release.merge_sha], ['stopped', 'conflict', null]);
  assert.equal(note(id), 'Merging into stg conflicts in src/math.js. Nothing was pushed to stg.');
  assert.equal(getTask(id)!.state, 'needs_owner');
  assert.equal(sh(repo.origin, 'rev-parse', 'stg'), theirs);
  // After a stopped release the owner may ask again.
  assert.equal(requestReleaseApproval(id).state, 'pending');
});

test('merged code that fails its checks is not pushed, even though each side passed on its own', { skip }, async () => {
  const repo = freshRepo();
  // Staging removed a helper the task's code relies on. No textual conflict; the merge is clean.
  const theirs = stgCommit(repo, (dir) => fs.rmSync(path.join(dir, 'src', 'util.js')), 'stg removes util.js');
  const id = await passedTask('Add mul using a helper staging removed');
  await approve(id);

  const release = latestRelease(id)!;
  assert.deepEqual([release.state, release.outcome, release.merge_sha], ['stopped', 'checks_failed', null], `release said: ${release.detail}`);
  assert.match(note(id), /^The merged code does not pass its checks \(test fails on the merged code/);
  assert.match(note(id), /Nothing was pushed to stg\.$/);
  assert.equal(sh(repo.origin, 'rev-parse', 'stg'), theirs);
  const ws = activeWorkspace(id)!;
  assert.equal(fs.existsSync(`${ws.worktree_path}.release`), false);
  assert.equal(fs.existsSync(`${ws.worktree_path}.stgbase`), false);
});

test('a release interrupted by a restart is looked up on the remote, never pushed again', { skip }, async () => {
  const repo = freshRepo();
  const id = await passedTask('Add mul across a restart');
  await approve(id);
  const done = latestRelease(id)!;
  const stgNow = sh(repo.origin, 'rev-parse', 'stg');
  const insert = (rid: string, taskId: string, mergeSha: string | null) =>
    getDb().prepare(`INSERT INTO releases (id, task_id, repo_id, state, stg_branch, head_sha, merge_sha, started_at) VALUES (?, ?, ?, 'running', 'stg', ?, ?, ?)`)
      .run(rid, taskId, REPO, done.head_sha, mergeSha, Date.now() + 1000);

  // Case 1: core stopped after the push went through — the merge is on staging.
  insert('rel-landed', id, done.merge_sha);
  // Case 2: core stopped with a merge built but not pushed — that commit is nowhere on the remote.
  const other = await passedTask('Second task across a restart');
  insert('rel-lost', other, 'f'.repeat(40));
  // Case 3: core stopped before a merge was even built.
  const third = await passedTask('Third task across a restart');
  insert('rel-early', third, null);

  await reconcileReleasesOnStartup();
  const row = (rid: string) => getDb().prepare('SELECT state, outcome, merge_sha FROM releases WHERE id = ?').get(rid);
  assert.deepEqual(row('rel-landed'), { state: 'pushed', outcome: 'pushed', merge_sha: done.merge_sha });
  assert.deepEqual(row('rel-lost'), { state: 'stopped', outcome: 'interrupted', merge_sha: null });
  assert.deepEqual(row('rel-early'), { state: 'stopped', outcome: 'interrupted', merge_sha: null });
  assert.match(note(other), /restarted during the release, before anything reached stg\. Approve again to retry\./);
  assert.equal(sh(repo.origin, 'rev-parse', 'stg'), stgNow, 'reconciling must not push anything');
  assert.equal(getDb().prepare(`SELECT COUNT(*) AS n FROM releases WHERE state = 'running'`).get()!.n, 0);
});
