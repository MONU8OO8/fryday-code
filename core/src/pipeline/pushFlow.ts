/**
 * What happens to reviewed work that continues an existing branch, and which approval
 * comes next for any reviewed task.
 *
 * Work that continues a branch goes back in one of two ways, each with its own yes:
 *   - the branch is the owner's own  → the new commits are pushed to that branch, never
 *     forced; if it moved on the remote in the meantime, nothing is pushed;
 *   - it has anyone else's commits   → FryDay Code pushes only its own branch, for a
 *     pull request; the existing branch is not pushed to.
 * A merge into staging, where the project has one, is a separate approval after that.
 */

import { getDb } from '../db/db.js';
import { getRepo } from '../registry/registry.js';
import { sseEmit } from '../api/events.js';
import { canTransition } from './stateMachine.js';
import { getTask, setTaskState, setTaskNote } from './taskState.js';
import { activeWorkspace, type WorkspaceRow } from './workspaces.js';
import { git, gitAsync, GitError } from './worktrees.js';
import { branchFacts } from './branches.js';
import { withRepoLock } from './repoLock.js';
import { ApprovalError, raiseTicket, requestReleaseApproval, type ApprovalRow } from './approvals.js';
import { getRounds } from './rounds.js';
import { verifiedPhrase } from '../verify/report.js';

const short = (sha: string | null | undefined) => (sha ?? '').slice(0, 8);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  try {
    git(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

const isRejected = (err: unknown) => err instanceof GitError && /\[rejected\]|\(fetch first\)|non-fast-forward/i.test(err.stderr);

/** True when the task continues a branch and its reviewed commit has not been pushed yet. */
function pushIsDue(ws: WorkspaceRow): boolean {
  return !!ws.target_branch && !!ws.head_sha && ws.pushed_sha !== ws.head_sha;
}

/** Raise the ticket for pushing a continued task's work. */
export function requestBranchPush(taskId: string): ApprovalRow {
  const ws = activeWorkspace(taskId);
  if (!ws?.head_sha || !ws.target_branch) throw new ApprovalError(409, `${taskId} does not continue an existing branch`);
  const rounds = getRounds(taskId);
  if (rounds[rounds.length - 1]?.outcome !== 'passed') throw new ApprovalError(409, `${taskId} has not passed checks and review`);
  const repo = getRepo(ws.repo_id);
  const commits = Number(git(ws.repo_path, ['rev-list', '--count', `${ws.base_sha}..${ws.head_sha}`]));
  const owned = ws.target_owned === 1;
  const summary = owned
    ? `Push ${plural(commits, 'new commit')} to your branch ${ws.target_branch} (${repo?.name ?? ws.repo_id})`
    : `Push FryDay's own branch ${ws.branch} for a pull request into ${ws.target_branch} (${repo?.name ?? ws.repo_id})`;
  return raiseTicket(taskId, 'push_branch', {
    summary,
    repoId: ws.repo_id,
    repoName: repo?.name ?? ws.repo_id,
    branch: ws.branch,
    targetBranch: ws.target_branch,
    owned,
    commit: ws.head_sha,
    verified: verifiedPhrase(rounds[rounds.length - 1]!.verify),
    commits,
    pushes: owned
      ? [`${plural(commits, 'commit')} → origin/${ws.target_branch} (your existing branch; not forced)`]
      : [`${ws.branch} → origin/${ws.branch} (a new branch)`],
    notPushed: owned ? [] : [`${ws.target_branch} is not pushed to: it has commits by other people`],
  }, ws.head_sha);
}

/**
 * Raise whatever approval comes next for a task that has passed review, and say it in
 * one sentence. Never throws: with nothing to approve, it says the branch is ready.
 */
export function requestNextApproval(taskId: string): string {
  const ws = activeWorkspace(taskId);
  try {
    if (ws && pushIsDue(ws)) {
      const ticket = requestBranchPush(taskId);
      return `${(JSON.parse(ticket.payload_json) as { summary: string }).summary}? Approve to do that.`;
    }
    const ticket = requestReleaseApproval(taskId);
    return `Approve to merge it into ${(JSON.parse(ticket.payload_json) as { stgBranch: string }).stgBranch}.`;
  } catch (err) {
    // Nothing to approve (no staging branch for this project, say): the branch is simply ready.
    return `The branch is ready. ${message(err)}.`;
  }
}

/** End a push that did not happen: the task goes back to the owner with the reason. */
function stop(taskId: string, note: string): void {
  setTaskState(taskId, 'needs_owner', note);
}

/** Carry out an approved branch push, then raise the staging approval if the project has staging. */
export async function executeBranchPush(ticket: Pick<ApprovalRow, 'id' | 'task_id' | 'commit_sha'>): Promise<void> {
  const taskId = ticket.task_id;
  const task = getTask(taskId);
  const ws = activeWorkspace(taskId);
  if (!task || !ws?.target_branch || !ticket.commit_sha) throw new Error(`${taskId} has no branch push to carry out`);
  if (!canTransition(task.state, 'releasing')) throw new Error(`${taskId} is ${task.state}; nothing can be pushed from there`);
  const repo = getRepo(ws.repo_id);
  const target = ws.target_branch;
  const head = ticket.commit_sha;
  const owned = ws.target_owned === 1;
  setTaskState(taskId, 'releasing', owned ? `Pushing to ${target}` : `Pushing ${ws.branch}`);

  let pushedRef: string | null = null;
  let stopped: string | null = null;
  try {
    await withRepoLock(ws.repo_path, async () => {
      if (!owned) {
        await gitAsync(ws.repo_path, ['push', 'origin', `${head}:refs/heads/${ws.branch}`]);
        pushedRef = ws.branch;
        return;
      }
      // The branch may have moved, or gained someone else's commits, since the task began.
      await gitAsync(ws.repo_path, ['fetch', '--no-tags', 'origin', target]);
      const now = branchFacts(ws.repo_path, repo?.prodBranch ?? target, target);
      if (!now) { stopped = `${target} is not on the remote any more. Nothing was pushed.`; return; }
      if (now.byOthers > 0) { stopped = `${target} now has commits by someone else, so FryDay will not push to it. Nothing was pushed; the work is on the local branch ${ws.branch}.`; return; }
      if (now.tipSha !== ws.base_sha && !isAncestor(ws.repo_path, now.tipSha, head)) {
        const added = Number(git(ws.repo_path, ['rev-list', '--count', `${ws.base_sha}..${now.tipSha}`]));
        stopped = `${target} moved on the remote after this task branched from it (${plural(added, 'new commit')}). Nothing was pushed; the work is on the local branch ${ws.branch}.`;
        return;
      }
      try {
        await gitAsync(ws.repo_path, ['push', 'origin', `${head}:refs/heads/${target}`]);
        pushedRef = target;
      } catch (err) {
        if (!isRejected(err)) throw err;
        stopped = `The remote refused the push because ${target} changed just now. Nothing was pushed.`;
      }
    });
  } catch (err) {
    stopped = `The push failed: ${message(err)}`;
  }

  if (stopped || !pushedRef) {
    stop(taskId, stopped ?? 'Nothing was pushed.');
    return;
  }
  getDb().prepare('UPDATE task_workspaces SET pushed_ref = ?, pushed_sha = ? WHERE task_id = ? AND repo_id = ?').run(pushedRef, head, taskId, ws.repo_id);
  getDb().prepare(`UPDATE approvals SET state = 'executed' WHERE id = ?`).run(ticket.id);
  sseEmit({ type: 'workspace_updated', taskId });

  const done = owned
    ? `Pushed to ${target} (${short(head)}).`
    : `Pushed ${ws.branch} (${short(head)}). Open a pull request from it into ${target}; ${target} itself was not pushed to.`;
  if (!repo?.stgBranch) {
    setTaskState(taskId, 'needs_owner', `${done} This project has no staging branch, so nothing else is waiting.`);
    return;
  }
  setTaskState(taskId, 'awaiting_approval', done);
  try {
    requestReleaseApproval(taskId);
    setTaskNote(taskId, `${done} Merging into ${repo.stgBranch} is a separate decision: approve it if you want that too.`);
  } catch (err) {
    setTaskState(taskId, 'needs_owner', `${done} ${message(err)}.`);
  }
}
