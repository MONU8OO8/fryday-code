/**
 * Task workspaces — one git worktree per (task, repo).
 *
 * The owner's working copy is never touched: no checkout, no stash, no index or
 * working-tree change. A workspace only adds a branch and a worktree entry to the
 * repo's .git, both removed again by removeWorkspace().
 *
 * Commits are made here by core, not by the agent. An agent that could run
 * `git commit` would need write access to the repo's shared .git directory (hooks,
 * config), which is a way out of its sandbox. For the same reason commits never run
 * the repo's hooks: after an agent has edited the tree, those hooks are agent-written
 * code. That holds for every git command core runs (see NO_HOOKS). Lint and tests run
 * later as sandboxed checks instead.
 */

import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface WorkspaceRepo {
  id: string;
  localPath: string;
  prodBranch: string;
}

export interface Workspace {
  taskId: string;
  repoId: string;
  /** The owner's working copy. Read-only as far as Fryday is concerned. */
  repoPath: string;
  worktreePath: string;
  branch: string;
  /** The ref the branch was cut from, e.g. origin/main. */
  baseRef: string;
  baseSha: string;
}

export class GitError extends Error {
  constructor(public readonly args: string[], public readonly stderr: string) {
    super(`git ${args.join(' ')} failed: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
  }
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
/**
 * Core never runs a repo's git hooks, for any command. A hook is code, and with tools
 * like husky the hooks live in the checked-out tree — which, for a task, is an agent's
 * change. Checking out, committing, merging or pushing it must not execute it.
 */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

export function git(cwd: string, args: string[], timeoutMs = 60_000): string {
  try {
    return execFileSync('git', ['-C', cwd, ...NO_HOOKS, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, ...GIT_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError(args, e.stderr || e.message);
  }
}

/** Same as git(), without blocking the event loop. For network operations. */
export function gitAsync(cwd: string, args: string[], timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...NO_HOOKS, ...args],
      { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ...GIT_ENV } },
      (err, stdout, stderr) => (err ? reject(new GitError(args, stderr || err.message)) : resolve(stdout.trim()))
    );
  });
}

/** feat/fryday-<slug>-t12 — unique per task, readable in branch lists. */
export function branchName(taskId: string, title: string, kind: 'feat' | 'fix' = 'feat'): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  const id = taskId.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${kind}/fryday-${slug || 'task'}-${id}`;
}

export interface CreateWorkspaceOptions {
  taskId: string;
  repo: WorkspaceRepo;
  branch: string;
  /** Root for all worktrees: <state folder>/worktrees. */
  worktreesRoot: string;
  /** Fetch origin/<prodBranch> first. On by default; tests turn it off. */
  fetch?: boolean;
  /** Cut the workspace from the tip of this existing remote branch instead of production. */
  baseBranch?: string;
}

export async function createWorkspace(opts: CreateWorkspaceOptions): Promise<Workspace> {
  const { taskId, repo, branch } = opts;
  if (!fs.existsSync(path.join(repo.localPath, '.git'))) {
    throw new Error(`${repo.id}: ${repo.localPath} is not a git repository`);
  }
  const from = opts.baseBranch ?? repo.prodBranch;
  const baseRef = `origin/${from}`;
  if (opts.fetch !== false) await gitAsync(repo.localPath, ['fetch', '--no-tags', 'origin', ...new Set([repo.prodBranch, from])]);

  const baseSha = git(repo.localPath, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  if (refExists(repo.localPath, `refs/heads/${branch}`)) {
    throw new Error(`${repo.id}: branch ${branch} already exists; a task never reuses a branch`);
  }

  const worktreePath = path.join(opts.worktreesRoot, taskId, repo.id);
  if (fs.existsSync(worktreePath)) throw new Error(`${worktreePath} already exists`);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(repo.localPath, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, baseSha]);

  return { taskId, repoId: repo.id, repoPath: repo.localPath, worktreePath, branch, baseRef, baseSha };
}

function refExists(repoPath: string, ref: string): boolean {
  try {
    git(repoPath, ['show-ref', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Commit everything the agent changed. Returns the new commit sha, or null when
 * there is nothing to commit. Hooks are not run (see the note at the top).
 */
export function commitAll(worktreePath: string, message: string): string | null {
  git(worktreePath, ['add', '-A']);
  if (git(worktreePath, ['status', '--porcelain']) === '') return null;
  git(worktreePath, ['commit', '-m', message]);
  return git(worktreePath, ['rev-parse', 'HEAD']);
}

export interface ChangeSummary {
  headSha: string;
  commits: number;
  files: Array<{ status: string; path: string }>;
}

/** What the task branch adds on top of its base. */
export function summarizeChanges(worktreePath: string, baseSha: string): ChangeSummary {
  const headSha = git(worktreePath, ['rev-parse', 'HEAD']);
  const commits = Number(git(worktreePath, ['rev-list', '--count', `${baseSha}..HEAD`]));
  const files = git(worktreePath, ['diff', '--name-status', `${baseSha}..HEAD`])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status ?? '', path: rest.join('\t') };
    });
  return { headSha, commits, files };
}

/** The task's changes as a unified diff. */
export function diffPatch(worktreePath: string, baseSha: string, context = 3): string {
  return git(worktreePath, ['diff', `-U${context}`, `${baseSha}..HEAD`]);
}

/** A file's content at a revision, or null if it does not exist there. */
export function fileAt(repoPath: string, rev: string, file: string): string | null {
  try {
    return git(repoPath, ['show', `${rev}:${file}`]);
  } catch {
    return null;
  }
}

/**
 * A throwaway checkout of one commit, on no branch. Checks and the Tester run here, so
 * they see exactly what was committed — not whatever else is lying in the coder's folder.
 */
export function createCheckout(repoPath: string, checkoutPath: string, sha: string): void {
  removeCheckout(repoPath, checkoutPath);
  fs.mkdirSync(path.dirname(checkoutPath), { recursive: true });
  git(repoPath, ['worktree', 'add', '--detach', checkoutPath, sha]);
}

export function removeCheckout(repoPath: string, checkoutPath: string): void {
  if (fs.existsSync(checkoutPath)) {
    try {
      git(repoPath, ['worktree', 'remove', '--force', checkoutPath]);
    } catch {
      fs.rmSync(checkoutPath, { recursive: true, force: true });
    }
  }
  git(repoPath, ['worktree', 'prune']);
}

/** Remove the worktree; with deleteBranch, the task branch too. Unpushed work on it is lost. */
export function removeWorkspace(ws: Pick<Workspace, 'repoPath' | 'worktreePath' | 'branch'>, deleteBranch: boolean): void {
  if (fs.existsSync(ws.worktreePath)) {
    git(ws.repoPath, ['worktree', 'remove', '--force', ws.worktreePath]);
  }
  git(ws.repoPath, ['worktree', 'prune']);
  if (deleteBranch && refExists(ws.repoPath, `refs/heads/${ws.branch}`)) {
    git(ws.repoPath, ['branch', '-D', ws.branch]);
  }
}
