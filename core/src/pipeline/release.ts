/**
 * Releasing a task branch to staging, and taking it back out — plain git, no agent.
 *
 * Rules this file keeps:
 *   - The owner's working copy is never touched; all merging happens in a temporary
 *     worktree that is removed afterwards.
 *   - Nothing is ever force-pushed. If staging moved while we were merging, the merge is
 *     redone on the new tip, a limited number of times.
 *   - A conflict stops the release; nothing reaches staging and nobody guesses.
 *   - No repo hook runs (worktrees.ts disables them for every git command). The tree
 *     being merged holds an agent's changes, so a hook in it (pre-push, post-merge, …) is
 *     agent-written code that would otherwise run as the owner, outside the sandbox.
 *   - The merge commit is reported (onIntent) before the push, so that after a crash the
 *     remote can be checked for it instead of pushing again.
 *
 * Merge or twin: if merging the task branch would add only the task's own commits to
 * staging, it is merged (`--no-ff`). If it would also drag in production commits that
 * staging does not have (staging has diverged), the task's commits are cherry-picked
 * (`-x`) onto a `<branch>-stg` twin cut from staging, and the twin is merged instead.
 */

import { createCheckout, removeCheckout, git, gitAsync, GitError } from './worktrees.js';

const REMOTE = 'origin';
const DEFAULT_PUSH_ATTEMPTS = 3; // the first try, then redo at most twice

export type ReleaseStrategy = 'merge' | 'twin';

export interface ReleaseIntent {
  strategy: ReleaseStrategy;
  stgBeforeSha: string;
  mergeSha: string;
  twinBranch: string | null;
  attempt: number;
}

export interface MergedCheck {
  ok: boolean;
  summary: string;
}

export interface ReleaseInput {
  /** The owner's repository. Only refs are added to it; its working copy is not touched. */
  repoPath: string;
  /** The task branch and the exact commit the owner approved. */
  branch: string;
  headSha: string;
  /** The commit the task branch was cut from. */
  baseSha: string;
  stgBranch: string;
  /** Where the temporary merge worktree is created (and removed). */
  releasePath: string;
  /** Commit message subject for the merge, e.g. "T-12: add total()". */
  label: string;
  maxPushAttempts?: number;
  /** False when the commit is already on the remote under another name (work that continued an existing branch). Default: push it. */
  pushBranch?: boolean;
  /** Always merge the branch as it is; never copy only the task's commits. For work that continues a branch, whose earlier commits belong to the change. */
  plainMergeOnly?: boolean;
  /** Name used in the merge commit's message. Default: the branch. */
  mergeName?: string;
  /** Check the merged tree before anything is pushed (sandboxed checks). */
  checkMerged?: (worktreePath: string, stgBeforeSha: string) => Promise<MergedCheck>;
  /** Called with the merge commit just before it is pushed. Persist it. */
  onIntent?: (intent: ReleaseIntent) => void;
  /** Test seam: runs after the merge is built and before the push. */
  beforePush?: (attempt: number) => void | Promise<void>;
}

export type ReleaseResult =
  | { status: 'pushed'; strategy: ReleaseStrategy; stgBeforeSha: string; mergeSha: string; twinBranch: string | null; attempts: number }
  | { status: 'already_merged'; stgSha: string }
  | { status: 'conflict'; strategy: ReleaseStrategy; stgBeforeSha: string; files: string[] }
  | { status: 'checks_failed'; strategy: ReleaseStrategy; stgBeforeSha: string; summary: string }
  | { status: 'stg_moved'; attempts: number }
  | { status: 'stale'; reason: string };

// git() and gitAsync() already disable repo hooks for every command.
const safe = git;
const safeAsync = gitAsync;

function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  try {
    git(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/** The remote refused a push because its branch moved (as opposed to auth or network trouble). */
function isRejectedPush(err: unknown): boolean {
  return err instanceof GitError && /\[rejected\]|\(fetch first\)|non-fast-forward|\[remote rejected\].*(stale|fetch first)/i.test(err.stderr);
}

function conflictedFiles(worktreePath: string): string[] {
  try {
    return git(worktreePath, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function tryGit(cwd: string, args: string[]): void {
  try {
    safe(cwd, args);
  } catch {
    /* best effort clean-up */
  }
}

/**
 * How many production commits merging the task branch would drag into staging besides
 * the task's own: the commits its base has that staging does not.
 */
export function commitsBesidesTheTask(repoPath: string, stgSha: string, baseSha: string): number {
  return Number(git(repoPath, ['rev-list', '--count', `${stgSha}..${baseSha}`]));
}

export function twinBranchName(branch: string): string {
  return `${branch}-stg`;
}

export async function releaseToStg(input: ReleaseInput): Promise<ReleaseResult> {
  const { repoPath, branch, headSha, baseSha, stgBranch, releasePath } = input;
  const maxAttempts = input.maxPushAttempts ?? DEFAULT_PUSH_ATTEMPTS;
  const stgRef = `refs/remotes/${REMOTE}/${stgBranch}`;

  const branchSha = git(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  if (branchSha !== headSha) {
    return { status: 'stale', reason: `${branch} is at ${branchSha.slice(0, 8)}, not the approved ${headSha.slice(0, 8)}` };
  }

  await safeAsync(repoPath, ['fetch', '--no-tags', REMOTE, stgBranch]);
  // The task branch goes to the remote first, so the work is visible there whatever happens next.
  if (input.pushBranch !== false) await safeAsync(repoPath, ['push', REMOTE, `${headSha}:refs/heads/${branch}`]);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const stgBeforeSha = git(repoPath, ['rev-parse', '--verify', `${stgRef}^{commit}`]);
    if (isAncestor(repoPath, headSha, stgBeforeSha)) return { status: 'already_merged', stgSha: stgBeforeSha };

    const strategy: ReleaseStrategy = input.plainMergeOnly || commitsBesidesTheTask(repoPath, stgBeforeSha, baseSha) === 0 ? 'merge' : 'twin';
    const twinBranch = strategy === 'twin' ? twinBranchName(branch) : null;

    createCheckout(repoPath, releasePath, stgBeforeSha);
    try {
      let mergeFrom = headSha;
      let mergeName = input.mergeName ?? branch;

      if (twinBranch) {
        const commits = git(repoPath, ['rev-list', '--reverse', '--no-merges', `${baseSha}..${headSha}`]).split('\n').filter(Boolean);
        safe(releasePath, ['checkout', '-B', twinBranch, stgBeforeSha]);
        try {
          safe(releasePath, ['cherry-pick', '-x', '--keep-redundant-commits', ...commits]);
        } catch {
          const files = conflictedFiles(releasePath);
          tryGit(releasePath, ['cherry-pick', '--abort']);
          tryGit(releasePath, ['checkout', '--detach', stgBeforeSha]);
          tryGit(repoPath, ['branch', '-D', twinBranch]);
          return { status: 'conflict', strategy, stgBeforeSha, files };
        }
        mergeFrom = git(releasePath, ['rev-parse', 'HEAD']);
        mergeName = twinBranch;
        safe(releasePath, ['checkout', '--detach', stgBeforeSha]);
      }

      try {
        safe(releasePath, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${mergeName} into ${stgBranch} (${input.label})`, mergeFrom]);
      } catch {
        const files = conflictedFiles(releasePath);
        tryGit(releasePath, ['merge', '--abort']);
        if (twinBranch) tryGit(repoPath, ['branch', '-D', twinBranch]);
        return { status: 'conflict', strategy, stgBeforeSha, files };
      }
      const mergeSha = git(releasePath, ['rev-parse', 'HEAD']);

      if (input.checkMerged) {
        const checked = await input.checkMerged(releasePath, stgBeforeSha);
        if (!checked.ok) {
          if (twinBranch) tryGit(repoPath, ['branch', '-D', twinBranch]);
          return { status: 'checks_failed', strategy, stgBeforeSha, summary: checked.summary };
        }
      }

      input.onIntent?.({ strategy, stgBeforeSha, mergeSha, twinBranch, attempt });
      await input.beforePush?.(attempt);

      try {
        await safeAsync(repoPath, ['push', REMOTE, `${mergeSha}:refs/heads/${stgBranch}`]);
      } catch (err) {
        if (!isRejectedPush(err)) throw err;
        // Staging moved under us. Take the new tip and build the merge again on it.
        await safeAsync(repoPath, ['fetch', '--no-tags', REMOTE, stgBranch]);
        continue;
      }

      if (twinBranch) {
        // Following the team's convention the twin is published too; staging already has its commits.
        try {
          await safeAsync(repoPath, ['push', REMOTE, `${mergeFrom}:refs/heads/${twinBranch}`]);
        } catch {
          /* a twin of that name already exists on the remote; the release itself is done */
        }
      }
      return { status: 'pushed', strategy, stgBeforeSha, mergeSha, twinBranch, attempts: attempt };
    } finally {
      removeCheckout(repoPath, releasePath);
    }
  }
  return { status: 'stg_moved', attempts: maxAttempts };
}

// ─── Revert ───────────────────────────────────────────────────────────────────

export interface RevertInput {
  repoPath: string;
  stgBranch: string;
  /** The merge commit a release put on staging. */
  mergeSha: string;
  releasePath: string;
  label: string;
  maxPushAttempts?: number;
  beforePush?: (attempt: number) => void | Promise<void>;
}

export type RevertResult =
  | { status: 'reverted'; revertSha: string; stgBeforeSha: string; attempts: number }
  | { status: 'not_on_stg' }
  | { status: 'conflict'; files: string[] }
  | { status: 'stg_moved'; attempts: number };

/** Put a commit on staging that undoes a release's merge. History is kept; nothing is rewritten. */
export async function revertRelease(input: RevertInput): Promise<RevertResult> {
  const { repoPath, stgBranch, mergeSha, releasePath } = input;
  const maxAttempts = input.maxPushAttempts ?? DEFAULT_PUSH_ATTEMPTS;
  const stgRef = `refs/remotes/${REMOTE}/${stgBranch}`;
  await safeAsync(repoPath, ['fetch', '--no-tags', REMOTE, stgBranch]);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const stgBeforeSha = git(repoPath, ['rev-parse', '--verify', `${stgRef}^{commit}`]);
    if (!isAncestor(repoPath, mergeSha, stgBeforeSha)) return { status: 'not_on_stg' };

    createCheckout(repoPath, releasePath, stgBeforeSha);
    try {
      try {
        // -m 1: keep staging's side of the merge, drop what the task brought in.
        safe(releasePath, ['revert', '-m', '1', '--no-edit', mergeSha]);
      } catch {
        const files = conflictedFiles(releasePath);
        tryGit(releasePath, ['revert', '--abort']);
        return { status: 'conflict', files };
      }
      safe(releasePath, ['commit', '--amend', '--no-edit', '-m', `Revert ${input.label} on ${stgBranch}\n\nThis reverts merge ${mergeSha}.`]);
      const revertSha = git(releasePath, ['rev-parse', 'HEAD']);
      await input.beforePush?.(attempt);
      try {
        await safeAsync(repoPath, ['push', REMOTE, `${revertSha}:refs/heads/${stgBranch}`]);
      } catch (err) {
        if (!isRejectedPush(err)) throw err;
        await safeAsync(repoPath, ['fetch', '--no-tags', REMOTE, stgBranch]);
        continue;
      }
      return { status: 'reverted', revertSha, stgBeforeSha, attempts: attempt };
    } finally {
      removeCheckout(repoPath, releasePath);
    }
  }
  return { status: 'stg_moved', attempts: maxAttempts };
}

/** Whether `sha` is on the remote's staging branch right now (after a fresh fetch). For restart recovery. */
export async function isOnStg(repoPath: string, stgBranch: string, sha: string): Promise<boolean> {
  await safeAsync(repoPath, ['fetch', '--no-tags', REMOTE, stgBranch]);
  return isAncestor(repoPath, sha, git(repoPath, ['rev-parse', '--verify', `refs/remotes/${REMOTE}/${stgBranch}^{commit}`]));
}
