// Releasing to staging and reverting, against scratch repos whose "remote" is a bare
// repo on disk. Nothing here can reach a real remote.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { releaseToStg, revertRelease, isOnStg, commitsBesidesTheTask, twinBranchName, type ReleaseInput } from '../src/pipeline/release';
import { createWorkspace, commitAll } from '../src/pipeline/worktrees';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fryday-release-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();
const write = (dir: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};

interface Scratch {
  origin: string;
  main: string;
  other: string;
  hookMarker: string;
  input: ReleaseInput;
  ownerBefore: { status: string; head: string; branch: string };
  /** Someone else pushes a commit to a remote branch. */
  otherPushes: (branch: string, file: string, content: string) => string;
  remote: (ref: string) => string;
  ownerState: () => { status: string; head: string; branch: string };
}

let n = 0;
/**
 * A repo with `release` (production) and `stg`, an owner clone mid-work on another
 * branch, and a task branch with one commit changing `taskFile`.
 * `stgSetup` runs in a second clone before the task branch exists, to shape staging.
 */
async function scratch(opts: { taskFile?: string; taskContent?: string; divergeProd?: boolean; stgSetup?: (other: string) => void } = {}): Promise<Scratch> {
  const dir = path.join(tmp, `s${++n}`);
  const origin = path.join(dir, 'origin.git');
  const main = path.join(dir, 'main');
  const other = path.join(dir, 'other');
  fs.mkdirSync(main, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'release', origin]);
  execFileSync('git', ['init', '-q', '-b', 'release', main]);
  sh(main, 'config', 'user.name', 'Owner');
  sh(main, 'config', 'user.email', 'owner@example.invalid');
  write(main, 'app.js', 'line 1\nline 2\nline 3\n');
  write(main, 'README.md', 'scratch\n');
  sh(main, 'add', '-A');
  sh(main, 'commit', '-q', '-m', 'init');
  sh(main, 'remote', 'add', 'origin', origin);
  sh(main, 'push', '-q', 'origin', 'release', 'release:stg');

  execFileSync('git', ['clone', '-q', origin, other]);
  sh(other, 'config', 'user.name', 'Colleague');
  sh(other, 'config', 'user.email', 'colleague@example.invalid');
  const otherPushes = (branch: string, file: string, content: string) => {
    sh(other, 'fetch', '-q', 'origin');
    sh(other, 'checkout', '-q', '-B', branch, `origin/${branch}`);
    write(other, file, content);
    sh(other, 'add', '-A');
    sh(other, 'commit', '-q', '-m', `colleague: ${file}`);
    sh(other, 'push', '-q', 'origin', branch);
    return sh(other, 'rev-parse', 'HEAD');
  };
  opts.stgSetup?.(other);
  // Production gets a commit staging never received: staging has diverged from production.
  if (opts.divergeProd) otherPushes('release', 'prod-only.txt', 'only on production\n');

  // The owner is mid-work on something else, with uncommitted changes.
  sh(main, 'checkout', '-q', '-b', 'owner-wip');
  write(main, 'app.js', 'line 1\nline 2\nline 3\nowner is editing\n');
  write(main, 'untracked.txt', 'owner scratch\n');

  // Hooks that must never run during a release.
  const hookMarker = path.join(dir, 'hook-ran');
  for (const hook of ['pre-push', 'post-merge', 'pre-merge-commit', 'commit-msg', 'post-commit', 'prepare-commit-msg', 'pre-commit', 'post-checkout']) {
    fs.writeFileSync(path.join(main, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> ${hookMarker}\n`, { mode: 0o755 });
  }

  const ws = await createWorkspace({ taskId: 'T-1', repo: { id: 'scratch', localPath: main, prodBranch: 'release' }, branch: 'feat/fryday-demo-t1', worktreesRoot: path.join(dir, 'worktrees') });
  write(ws.worktreePath, opts.taskFile ?? 'feature.js', opts.taskContent ?? 'exports.feature = true;\n');
  const headSha = commitAll(ws.worktreePath, 'fryday(T-1): demo')!;

  const ownerState = () => ({ status: sh(main, 'status', '--porcelain'), head: sh(main, 'rev-parse', 'HEAD'), branch: sh(main, 'rev-parse', '--abbrev-ref', 'HEAD') });
  return {
    origin, main, other, hookMarker, otherPushes, ownerState,
    ownerBefore: ownerState(),
    remote: (ref) => sh(origin, 'rev-parse', ref),
    input: { repoPath: main, branch: ws.branch, headSha, baseSha: ws.baseSha, stgBranch: 'stg', releasePath: path.join(dir, 'release-wt'), label: 'T-1: demo' },
  };
}

/** What must hold after any release attempt, whatever its outcome. */
function assertLeftAlone(s: Scratch) {
  assert.deepEqual(s.ownerState(), s.ownerBefore, "the owner's working copy changed");
  assert.equal(fs.existsSync(s.hookMarker), false, `a repo hook ran: ${fs.existsSync(s.hookMarker) ? fs.readFileSync(s.hookMarker, 'utf8') : ''}`);
  assert.equal(fs.existsSync(s.input.releasePath), false, 'the temporary merge worktree was left behind');
  assert.doesNotMatch(sh(s.main, 'worktree', 'list'), /release-wt/);
}

test('merge: when staging has everything production has, the task branch is merged with --no-ff and pushed', async () => {
  const s = await scratch();
  const stgBefore = s.remote('stg');
  assert.equal(commitsBesidesTheTask(s.main, stgBefore, s.input.baseSha), 0);
  const intents: string[] = [];
  const r = await releaseToStg({ ...s.input, onIntent: (i) => intents.push(i.mergeSha) });

  assert.equal(r.status, 'pushed');
  if (r.status !== 'pushed') return;
  assert.equal(r.strategy, 'merge');
  assert.equal(r.attempts, 1);
  assert.equal(r.stgBeforeSha, stgBefore);
  assert.equal(s.remote('stg'), r.mergeSha);
  assert.deepEqual(intents, [r.mergeSha], 'the merge commit is reported before it is pushed');
  // A real merge commit: staging's old tip first, the task commit second.
  assert.deepEqual(sh(s.origin, 'rev-list', '--parents', '-n', '1', 'stg').split(' ').slice(1), [stgBefore, s.input.headSha]);
  assert.equal(sh(s.origin, 'log', '-1', '--format=%s', 'stg'), 'Merge feat/fryday-demo-t1 into stg (T-1: demo)');
  assert.equal(sh(s.origin, 'show', 'stg:feature.js'), 'exports.feature = true;');
  // The task branch is on the remote too; production is untouched.
  assert.equal(s.remote('feat/fryday-demo-t1'), s.input.headSha);
  assert.equal(s.remote('release'), s.input.baseSha);
  assertLeftAlone(s);
});

test('twin: when staging has diverged from production, only the task commits are cherry-picked across', async () => {
  const s = await scratch({ divergeProd: true });
  const stgBefore = s.remote('stg');
  assert.equal(commitsBesidesTheTask(s.main, stgBefore, s.input.baseSha), 1, 'merging the branch would drag one production commit into staging');
  const r = await releaseToStg(s.input);

  assert.equal(r.status, 'pushed');
  if (r.status !== 'pushed') return;
  assert.equal(r.strategy, 'twin');
  assert.equal(r.twinBranch, twinBranchName('feat/fryday-demo-t1'));
  assert.equal(s.remote('stg'), r.mergeSha);
  assert.equal(sh(s.origin, 'show', 'stg:feature.js'), 'exports.feature = true;');
  // The production-only commit did NOT come along.
  assert.throws(() => sh(s.origin, 'cat-file', '-e', 'stg:prod-only.txt'));
  // The twin holds a cherry-pick that names the original commit, and is published.
  const twinTip = s.remote('feat/fryday-demo-t1-stg');
  assert.match(sh(s.origin, 'log', '-1', '--format=%B', twinTip), new RegExp(`\\(cherry picked from commit ${s.input.headSha}\\)`));
  assert.deepEqual(sh(s.origin, 'rev-list', '--parents', '-n', '1', 'stg').split(' ').slice(1), [stgBefore, twinTip]);
  assert.equal(sh(s.origin, 'log', '-1', '--format=%s', 'stg'), 'Merge feat/fryday-demo-t1-stg into stg (T-1: demo)');
  assertLeftAlone(s);
});

test('conflict: the release stops, names the files, and nothing reaches staging', async () => {
  // Staging changed the same lines the task changes.
  const s = await scratch({
    taskFile: 'app.js', taskContent: 'line 1\nTASK CHANGE\nline 3\n',
    stgSetup: (other) => {
      execFileSync('git', ['-C', other, 'checkout', '-q', '-B', 'stg', 'origin/stg']);
      fs.writeFileSync(path.join(other, 'app.js'), 'line 1\nSTAGING CHANGE\nline 3\n');
      execFileSync('git', ['-C', other, '-c', 'user.name=C', '-c', 'user.email=c@example.invalid', 'commit', '-q', '-am', 'stg-only change']);
      execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'stg']);
    },
  });
  const stgBefore = s.remote('stg');
  const r = await releaseToStg(s.input);
  assert.deepEqual(r, { status: 'conflict', strategy: 'merge', stgBeforeSha: stgBefore, files: ['app.js'] });
  assert.equal(s.remote('stg'), stgBefore, 'staging must be untouched');
  assertLeftAlone(s);

  // Same with the twin path: a cherry-pick that conflicts leaves no twin branch behind.
  const t = await scratch({
    divergeProd: true, taskFile: 'app.js', taskContent: 'line 1\nTASK CHANGE\nline 3\n',
    stgSetup: (other) => {
      execFileSync('git', ['-C', other, 'checkout', '-q', '-B', 'stg', 'origin/stg']);
      fs.writeFileSync(path.join(other, 'app.js'), 'line 1\nSTAGING CHANGE\nline 3\n');
      execFileSync('git', ['-C', other, '-c', 'user.name=C', '-c', 'user.email=c@example.invalid', 'commit', '-q', '-am', 'stg-only change']);
      execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'stg']);
    },
  });
  const tBefore = t.remote('stg');
  const tr = await releaseToStg(t.input);
  assert.deepEqual(tr, { status: 'conflict', strategy: 'twin', stgBeforeSha: tBefore, files: ['app.js'] });
  assert.equal(t.remote('stg'), tBefore);
  assert.equal(sh(t.main, 'branch', '--list', 'feat/fryday-demo-t1-stg'), '', 'no half-built twin is left');
  assertLeftAlone(t);
});

test('push race: staging moved while merging, so the merge is rebuilt on the new tip — never forced', async () => {
  const s = await scratch();
  const stgBefore = s.remote('stg');
  const intents: string[] = [];
  let theirs = '';
  const r = await releaseToStg({
    ...s.input,
    onIntent: (i) => intents.push(i.mergeSha),
    beforePush: (attempt) => { if (attempt === 1) theirs = s.otherPushes('stg', 'colleague.txt', 'pushed while Fryday was merging\n'); },
  });

  assert.equal(r.status, 'pushed');
  if (r.status !== 'pushed') return;
  assert.equal(r.attempts, 2);
  assert.equal(r.stgBeforeSha, theirs, 'the second merge is built on the colleague\'s commit');
  assert.equal(intents.length, 2);
  assert.equal(s.remote('stg'), intents[1]);
  // Nothing was overwritten: the colleague's commit and the old tip are both still in staging.
  for (const sha of [stgBefore, theirs, s.input.headSha]) sh(s.origin, 'merge-base', '--is-ancestor', sha, 'stg');
  assert.equal(sh(s.origin, 'show', 'stg:colleague.txt'), 'pushed while Fryday was merging');
  // The first merge was thrown away, not pushed anywhere.
  assert.throws(() => sh(s.origin, 'cat-file', '-e', intents[0]!));
  assertLeftAlone(s);
});

test('push race that never settles: it gives up after the limit and leaves staging to the others', async () => {
  const s = await scratch();
  let pushes = 0;
  const r = await releaseToStg({ ...s.input, beforePush: () => { s.otherPushes('stg', `c${++pushes}.txt`, 'again\n'); } });
  assert.deepEqual(r, { status: 'stg_moved', attempts: 3 });
  assert.equal(pushes, 3);
  assert.throws(() => sh(s.origin, 'cat-file', '-e', 'stg:feature.js'), 'the task must not be on staging');
  assert.equal(sh(s.origin, 'show', 'stg:c3.txt'), 'again');
  assertLeftAlone(s);
});

test('a merged tree that fails its checks is not pushed', async () => {
  const s = await scratch();
  const stgBefore = s.remote('stg');
  let seen = '';
  const r = await releaseToStg({
    ...s.input,
    checkMerged: async (worktree, before) => {
      // The check sees the merged tree: the task's file on top of staging.
      seen = `${fs.existsSync(path.join(worktree, 'feature.js'))}:${before === stgBefore}`;
      return { ok: false, summary: 'test: 1 new failure' };
    },
  });
  assert.equal(seen, 'true:true');
  assert.deepEqual(r, { status: 'checks_failed', strategy: 'merge', stgBeforeSha: stgBefore, summary: 'test: 1 new failure' });
  assert.equal(s.remote('stg'), stgBefore);
  assertLeftAlone(s);
});

test('a branch that moved after approval is refused, and one already on staging is not merged twice', async () => {
  const s = await scratch();
  const stale = await releaseToStg({ ...s.input, headSha: s.input.baseSha });
  assert.equal(stale.status, 'stale');
  assert.equal(s.remote('stg'), s.input.baseSha, 'nothing was pushed for a stale approval');

  const first = await releaseToStg(s.input);
  assert.equal(first.status, 'pushed');
  const again = await releaseToStg(s.input);
  assert.deepEqual(again, { status: 'already_merged', stgSha: s.remote('stg') });
  assertLeftAlone(s);
});

test('revert: a new commit undoes the merge, history is kept, and later work on staging survives', async () => {
  const s = await scratch();
  const released = await releaseToStg(s.input);
  assert.equal(released.status, 'pushed');
  if (released.status !== 'pushed') return;
  // A colleague builds on staging after the release.
  const theirs = s.otherPushes('stg', 'colleague.txt', 'after the release\n');

  assert.equal(await isOnStg(s.main, 'stg', released.mergeSha), true);
  const r = await revertRelease({ repoPath: s.main, stgBranch: 'stg', mergeSha: released.mergeSha, releasePath: s.input.releasePath, label: 'T-1: demo' });
  assert.equal(r.status, 'reverted');
  if (r.status !== 'reverted') return;
  assert.equal(r.stgBeforeSha, theirs);
  assert.equal(s.remote('stg'), r.revertSha);
  // The task's change is gone, the colleague's is still there, and nothing was rewritten.
  assert.throws(() => sh(s.origin, 'cat-file', '-e', 'stg:feature.js'));
  assert.equal(sh(s.origin, 'show', 'stg:colleague.txt'), 'after the release');
  for (const sha of [released.mergeSha, theirs]) sh(s.origin, 'merge-base', '--is-ancestor', sha, 'stg');
  assert.match(sh(s.origin, 'log', '-1', '--format=%B', 'stg'), new RegExp(`^Revert T-1: demo on stg\\n\\nThis reverts merge ${released.mergeSha}\\.`));
  assertLeftAlone(s);
});

test('revert refuses a merge that is not on staging, and survives a push race', async () => {
  const s = await scratch();
  const notThere = await revertRelease({ repoPath: s.main, stgBranch: 'stg', mergeSha: s.input.headSha, releasePath: s.input.releasePath, label: 'x' });
  assert.deepEqual(notThere, { status: 'not_on_stg' });

  const released = await releaseToStg(s.input);
  if (released.status !== 'pushed') throw new Error('release failed');
  let theirs = '';
  const r = await revertRelease({
    repoPath: s.main, stgBranch: 'stg', mergeSha: released.mergeSha, releasePath: s.input.releasePath, label: 'T-1: demo',
    beforePush: (attempt) => { if (attempt === 1) theirs = s.otherPushes('stg', 'colleague.txt', 'racing the revert\n'); },
  });
  assert.equal(r.status, 'reverted');
  if (r.status !== 'reverted') return;
  assert.equal(r.attempts, 2);
  sh(s.origin, 'merge-base', '--is-ancestor', theirs, 'stg');
  assert.throws(() => sh(s.origin, 'cat-file', '-e', 'stg:feature.js'));
  assertLeftAlone(s);
});
