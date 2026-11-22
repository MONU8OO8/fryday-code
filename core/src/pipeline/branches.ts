/**
 * Existing branches a task might continue, and who they belong to. Core reads these
 * from git itself; an agent is only ever shown the list and asked to pick from it.
 *
 * "Yours" means every commit the branch adds to production carries your own git e-mail.
 * FryDay Code pushes to an existing branch only when it is yours; a branch with anyone
 * else's commits is never pushed to.
 */

import { git, gitAsync } from './worktrees.js';

export interface BranchFacts {
  /** Branch name on the remote, without "origin/". */
  name: string;
  tipSha: string;
  /** Where the branch left production. */
  forkSha: string;
  /** Commits it adds to production. */
  ahead: number;
  /** How many of those are by someone other than the owner. */
  byOthers: number;
  /** True when it adds at least one commit and all of them are the owner's. */
  owned: boolean;
  lastCommitAt: number;
  lastSubject: string;
}

export interface Candidate extends BranchFacts {
  /** Up to a few of the files it changes, to judge what it is about. */
  files: string[];
}

const REMOTE = 'origin';
const MAX_AGE_DAYS = 120;
const MAX_CANDIDATES = 30;
const MAX_FILES = 8;

function tryGit(repoPath: string, args: string[]): string | null {
  try {
    return git(repoPath, args);
  } catch {
    return null;
  }
}

/** The e-mail this developer commits with in this repository, lower-cased; null when none is set. */
export function ownerEmail(repoPath: string): string | null {
  const email = tryGit(repoPath, ['config', 'user.email'])?.trim().toLowerCase();
  return email || null;
}

/** Facts about one remote branch as last fetched, or null when it is not there. */
export function branchFacts(repoPath: string, prodBranch: string, name: string, owner = ownerEmail(repoPath)): BranchFacts | null {
  const ref = `refs/remotes/${REMOTE}/${name}`;
  const tipSha = tryGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!tipSha) return null;
  const prod = `refs/remotes/${REMOTE}/${prodBranch}`;
  const forkSha = tryGit(repoPath, ['merge-base', prod, ref]);
  if (!forkSha) return null; // unrelated history
  const authors = git(repoPath, ['log', '--format=%ae', `${forkSha}..${ref}`]).split('\n').filter(Boolean).map((a) => a.toLowerCase());
  const byOthers = owner ? authors.filter((a) => a !== owner).length : authors.length;
  const [at, ...subject] = git(repoPath, ['log', '-1', '--format=%ct %s', ref]).split(' ');
  return {
    name, tipSha, forkSha,
    ahead: authors.length,
    byOthers,
    owned: authors.length > 0 && byOthers === 0,
    lastCommitAt: Number(at) * 1000,
    lastSubject: subject.join(' ').slice(0, 160),
  };
}

/** Bring the local picture of the remote's branches up to date. Only remote-tracking refs change. */
export async function fetchBranches(repoPath: string): Promise<void> {
  await gitAsync(repoPath, ['fetch', '--no-tags', REMOTE]);
}

/** Whether the branch exists on the remote right now (asks the remote). */
export async function existsOnRemote(repoPath: string, name: string): Promise<boolean> {
  try {
    return (await gitAsync(repoPath, ['ls-remote', '--heads', REMOTE, `refs/heads/${name}`], 60_000)).trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Remote branches with work that has not reached production: recent ones first. Leaves
 * out production, staging, and branches with nothing of their own.
 */
export function listCandidates(repoPath: string, prodBranch: string, stgBranch: string | null, now = Date.now()): Candidate[] {
  const owner = ownerEmail(repoPath);
  const names = git(repoPath, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', `refs/remotes/${REMOTE}`])
    .split('\n')
    .map((ref) => ref.replace(`refs/remotes/${REMOTE}/`, ''))
    .filter((name) => name && name !== 'HEAD' && name !== prodBranch && name !== stgBranch);

  const candidates: Candidate[] = [];
  for (const name of names) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const facts = branchFacts(repoPath, prodBranch, name, owner);
    if (!facts || facts.ahead === 0) continue; // merged, or nothing of its own
    if (now - facts.lastCommitAt > MAX_AGE_DAYS * 86_400_000) continue;
    const files = (tryGit(repoPath, ['diff', '--name-only', `${facts.forkSha}..${facts.tipSha}`]) ?? '').split('\n').filter(Boolean);
    candidates.push({ ...facts, files: files.slice(0, MAX_FILES) });
  }
  return candidates;
}
