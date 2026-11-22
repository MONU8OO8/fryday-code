import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  branchName, createWorkspace, commitAll, summarizeChanges, removeWorkspace, createCheckout, removeCheckout, git,
} from '../src/pipeline/worktrees';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fryday-worktrees-')));
const origin = path.join(tmp, 'origin.git');
const main = path.join(tmp, 'main');
const worktreesRoot = path.join(tmp, 'worktrees');
const repo = { id: 'scratch', localPath: main, prodBranch: 'release' };

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();

/** Everything about the owner's copy that a workspace must leave alone. */
function ownerState() {
  return {
    status: sh(main, 'status', '--porcelain'),
    head: sh(main, 'rev-parse', 'HEAD'),
    branch: sh(main, 'rev-parse', '--abbrev-ref', 'HEAD'),
    dirtyFile: fs.readFileSync(path.join(main, 'app.js'), 'utf8'),
    stash: sh(main, 'stash', 'list'),
  };
}

before(() => {
  fs.mkdirSync(main, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'release', origin]);
  execFileSync('git', ['init', '-b', 'release', main]);
  sh(main, 'config', 'user.name', 'Test');
  sh(main, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(main, 'app.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'CLAUDE.md\n.claude/\n.env\n');
  sh(main, 'add', '-A');
  sh(main, 'commit', '-m', 'init');
  sh(main, 'remote', 'add', 'origin', origin);
  sh(main, 'push', '-u', 'origin', 'release');
  // The owner is mid-work on another branch, with uncommitted and untracked changes.
  sh(main, 'checkout', '-b', 'owner-wip');
  fs.writeFileSync(path.join(main, 'app.js'), 'console.log("owner is editing this");\n');
  fs.writeFileSync(path.join(main, 'untracked.txt'), 'owner scratch\n');
  fs.writeFileSync(path.join(main, '.env'), 'DB_PASSWORD=not-a-real-secret\n');
  fs.writeFileSync(path.join(main, 'CLAUDE.md'), '# repo rules\n');
  fs.mkdirSync(path.join(main, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(main, '.claude', 'rules', 'style.md'), 'use tabs\n');
  fs.writeFileSync(path.join(main, '.claude', 'settings.local.json'), '{}\n');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('branch names are readable, safe and unique per task', () => {
  assert.equal(branchName('T-12', 'Fix: login OTP expiry!!'), 'feat/fryday-fix-login-otp-expiry-t12');
  assert.equal(branchName('T-3', '  ', 'fix'), 'fix/fryday-task-t3');
  assert.match(branchName('T-9', 'x'.repeat(200)), /^feat\/fryday-x{40}-t9$/);
  assert.doesNotMatch(branchName('T-1', '../../etc; rm -rf ~'), /[^a-z0-9/-]/);
});

test('a workspace is cut from origin/<prod> without touching the owner copy', async () => {
  const before = ownerState();
  const ws = await createWorkspace({ taskId: 'T-1', repo, branch: 'feat/fryday-demo-t1', worktreesRoot });

  assert.deepEqual(ownerState(), before, 'owner working copy changed');
  assert.equal(ws.worktreePath, path.join(worktreesRoot, 'T-1', 'scratch'));
  assert.equal(ws.baseRef, 'origin/release');
  assert.equal(ws.baseSha, sh(main, 'rev-parse', 'origin/release'));
  assert.equal(sh(ws.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/fryday-demo-t1');
  assert.equal(sh(ws.worktreePath, 'rev-parse', 'HEAD'), ws.baseSha);
  // Committed content, not the owner's uncommitted edit.
  assert.equal(fs.readFileSync(path.join(ws.worktreePath, 'app.js'), 'utf8'), 'console.log(1);\n');
});

test('nothing ignored or untracked from the owner copy reaches the workspace', () => {
  const wt = path.join(worktreesRoot, 'T-1', 'scratch');
  for (const rel of ['.env', 'CLAUDE.md', '.claude', 'untracked.txt']) {
    assert.equal(fs.existsSync(path.join(wt, rel)), false, rel);
  }
});

test('core commits the agent changes without running any hook', () => {
  const before = ownerState();
  const wt = path.join(worktreesRoot, 'T-1', 'scratch');
  const base = sh(main, 'rev-parse', 'origin/release');
  assert.equal(commitAll(wt, 'nothing yet'), null);

  fs.writeFileSync(path.join(wt, 'app.js'), 'console.log(2);\n');
  fs.writeFileSync(path.join(wt, 'new.js'), 'export {};\n');
  // A hook the agent planted must not run when core commits.
  const marker = path.join(tmp, 'hook-ran');
  fs.mkdirSync(path.join(wt, '.husky'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.husky', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  // ...and neither must a hook that is really installed in the repo.
  const installed = path.join(main, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(installed, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });

  const sha = commitAll(wt, 'fryday(T-1): demo');
  assert.match(sha ?? '', /^[0-9a-f]{40}$/);
  assert.equal(fs.existsSync(marker), false, 'a repo hook ran during the commit');
  fs.rmSync(installed);

  const summary = summarizeChanges(wt, base);
  assert.equal(summary.headSha, sha);
  assert.equal(summary.commits, 1);
  const paths = summary.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['.husky/pre-commit', 'app.js', 'new.js']);
  assert.deepEqual(ownerState(), before, 'owner working copy changed');
});

test('a task never reuses a branch or a worktree path', async () => {
  await assert.rejects(createWorkspace({ taskId: 'T-2', repo, branch: 'feat/fryday-demo-t1', worktreesRoot }), /already exists/);
  await assert.rejects(createWorkspace({ taskId: 'T-1', repo, branch: 'feat/other-t1', worktreesRoot }), /already exists/);
  await assert.rejects(
    createWorkspace({ taskId: 'T-3', repo: { ...repo, prodBranch: 'nope' }, branch: 'feat/x-t3', worktreesRoot, fetch: false }),
    /rev-parse/
  );
});

test('checking out an agent commit does not run hooks, even hooks that live in the tree', () => {
  const marker = path.join(tmp, 'checkout-hook-ran');
  const wt = path.join(worktreesRoot, 'T-1', 'scratch');
  // Like husky: the repo is configured to take its hooks from a folder inside the tree...
  sh(main, 'config', 'core.hooksPath', '.husky');
  // ...and the agent's commit contains a post-checkout hook there.
  fs.mkdirSync(path.join(wt, '.husky'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.husky', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(wt, '.husky', 'post-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const sha = commitAll(wt, 'agent adds hooks')!;
  try {
    const checkout = path.join(tmp, 'review-checkout');
    createCheckout(main, checkout, sha);
    assert.equal(fs.existsSync(path.join(checkout, '.husky', 'post-checkout')), true, 'the hook file is in the checkout');
    assert.equal(fs.existsSync(marker), false, 'a hook from the agent tree ran');
    removeCheckout(main, checkout);
    assert.equal(fs.existsSync(checkout), false);
  } finally {
    sh(main, 'config', '--unset', 'core.hooksPath');
  }
});

test('removing a workspace leaves the owner copy as it was and nothing behind', () => {
  const before = ownerState();
  const wt = path.join(worktreesRoot, 'T-1', 'scratch');
  removeWorkspace({ repoPath: main, worktreePath: wt, branch: 'feat/fryday-demo-t1' }, true);

  assert.equal(fs.existsSync(wt), false);
  assert.equal(sh(main, 'branch', '--list', 'feat/fryday-demo-t1'), '');
  assert.doesNotMatch(git(main, ['worktree', 'list']), /T-1/);
  assert.deepEqual(ownerState(), before);
  // Safe to call again.
  removeWorkspace({ repoPath: main, worktreePath: wt, branch: 'feat/fryday-demo-t1' }, true);
});
