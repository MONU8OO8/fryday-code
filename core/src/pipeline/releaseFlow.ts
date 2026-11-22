/**
 * A task's release to staging: runs release.ts for an approved ticket, records every
 * step, and tells the owner what happened in plain words.
 *
 * After the push, a project with a Jenkins deployer gets a "deploy staging?" ticket
 * (deploy/deployFlow.ts); any other project goes to the owner to deploy.
 */

import fs from 'fs';
import { randomUUID } from 'crypto';
import { getDb, nowMs } from '../db/db.js';
import { getConfig } from '../config.js';
import { getRepo } from '../registry/registry.js';
import { sseEmit } from '../api/events.js';
import { canTransition } from './stateMachine.js';
import { getTask, setTaskState, setTaskNote } from './taskState.js';
import { activeWorkspace, type WorkspaceRow } from './workspaces.js';
import { createCheckout, removeCheckout } from './worktrees.js';
import { cannotRun, checkSpecs, runCheck, runChecks, isBlocking } from './checks.js';
import { depsForCheckout, depsUsable } from './deps.js';
import { releaseToStg, revertRelease, isOnStg, type ReleaseResult, type MergedCheck } from './release.js';
import { withRepoLock } from './repoLock.js';
import { offerDeploy } from '../deploy/deployFlow.js';

export interface ReleaseRow {
  id: string;
  task_id: string;
  repo_id: string;
  approval_id: string | null;
  state: 'running' | 'pushed' | 'stopped' | 'reverted';
  outcome: string | null;
  stg_branch: string;
  head_sha: string;
  strategy: string | null;
  stg_before_sha: string | null;
  merge_sha: string | null;
  twin_branch: string | null;
  attempts: number | null;
  revert_sha: string | null;
  detail: string | null;
  started_at: number;
  ended_at: number | null;
}

export class ReleaseError extends Error {}

const short = (sha: string | null | undefined) => (sha ?? '').slice(0, 8);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function latestRelease(taskId: string): ReleaseRow | undefined {
  return getDb().prepare('SELECT * FROM releases WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(taskId) as ReleaseRow | undefined;
}

function update(id: string, fields: Partial<ReleaseRow>): void {
  const keys = Object.keys(fields) as Array<keyof ReleaseRow>;
  if (keys.length === 0) return;
  getDb().prepare(`UPDATE releases SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] as string | number | null), id);
}

function tell(taskId: string, note: string): void {
  const task = getTask(taskId);
  if (!task) return;
  if (task.state !== 'needs_owner' && canTransition(task.state, 'needs_owner')) setTaskState(taskId, 'needs_owner', note);
  else setTaskNote(taskId, note);
  sseEmit({ type: 'release_updated', taskId });
}

const releasePath = (ws: WorkspaceRow) => `${ws.worktree_path}.release`;
const stgBasePath = (ws: WorkspaceRow) => `${ws.worktree_path}.stgbase`;

/** Sandboxed checks on the merged tree; a check blocks only for failures staging did not already have. */
async function checkMergedTree(ws: WorkspaceRow, worktreePath: string, stgBeforeSha: string): Promise<MergedCheck> {
  const cfg = getConfig();
  const repo = getRepo(ws.repo_id);
  const specs = repo ? checkSpecs(repo) : [];
  if (specs.length === 0) return { ok: true, summary: 'no checks configured' };
  fs.mkdirSync(cfg.scratchDir, { recursive: true });
  const owner = { repoId: ws.repo_id, taskId: ws.task_id, ownerRepoPath: ws.repo_path };
  const deps = await depsForCheckout(owner, worktreePath, true);
  if (!depsUsable(deps)) return { ok: false, summary: `the checks could not be run on the merged code because its dependencies are not available: ${deps.detail}` };
  const opts = { scratchRoot: cfg.scratchDir, timeoutMs: cfg.checkTimeoutMs, memoryWaitMs: cfg.memoryWaitMs };
  const results = await runChecks({
    ...opts,
    specs,
    workspacePath: worktreePath,
    baseline: async (spec) => {
      const base = stgBasePath(ws);
      createCheckout(ws.repo_path, base, stgBeforeSha);
      try {
        const baseDeps = await depsForCheckout(owner, base, false);
        if (!depsUsable(baseDeps)) return cannotRun(spec, `Dependencies are not available for ${short(stgBeforeSha)}: ${baseDeps.detail}`);
        return await runCheck(spec, { ...opts, workspacePath: base });
      } finally {
        removeCheckout(ws.repo_path, base);
      }
    },
  });
  const failing = results.filter(isBlocking);
  return {
    ok: failing.length === 0,
    summary: failing.length
      ? failing.map((c) => c.status === 'error'
          ? `${c.name} could not be run on the merged code`
          : `${c.name} fails on the merged code${c.newFailures?.length ? ` (${c.newFailures.length} new: ${c.newFailures.slice(0, 3).join('; ')})` : ''}`).join('; ')
      : results.map((c) => `${c.name}: ${c.status}`).join(', '),
  };
}

function describe(result: ReleaseResult, branch: string, stg: string): { state: ReleaseRow['state']; note: string } {
  switch (result.status) {
    case 'pushed':
      return {
        state: 'pushed',
        note: `Merged into ${stg} and pushed (merge ${short(result.mergeSha)}${result.strategy === 'twin' ? `, through twin ${result.twinBranch}` : ''}${result.attempts > 1 ? `, after ${stg} moved ${result.attempts - 1} time${result.attempts === 2 ? '' : 's'}` : ''}).`,
      };
    case 'already_merged':
      return { state: 'pushed', note: `${branch} is already in ${stg}; nothing to merge.` };
    case 'conflict':
      return { state: 'stopped', note: `Merging into ${stg} conflicts in ${result.files.join(', ') || 'some files'}. Nothing was pushed to ${stg}.` };
    case 'checks_failed':
      return { state: 'stopped', note: `The merged code does not pass its checks (${result.summary}). Nothing was pushed to ${stg}.` };
    case 'stg_moved':
      return { state: 'stopped', note: `${stg} kept changing while merging (${result.attempts} tries). Nothing was pushed; approve again when it is quiet.` };
    case 'stale':
      return { state: 'stopped', note: `The approval no longer matches the branch (${result.reason}). Nothing was pushed.` };
  }
}

/** The merge is on staging: offer the deploy when the project has one, else the owner deploys. */
function afterPush(releaseId: string, note: string, stg: string): void {
  const row = getDb().prepare('SELECT * FROM releases WHERE id = ?').get(releaseId) as ReleaseRow;
  let offer: ReturnType<typeof offerDeploy> = null;
  try {
    offer = offerDeploy(row);
  } catch (err) {
    offer = { asked: false, sentence: `The deploy could not be offered: ${message(err)}` };
  }
  if (offer?.asked) {
    setTaskNote(row.task_id, `${note} ${offer.sentence}`);
    sseEmit({ type: 'release_updated', taskId: row.task_id });
    return;
  }
  tell(row.task_id, `${note} ${offer?.sentence ?? `Deploy ${stg} yourself: this project has no deployer set up.`}`);
}

/**
 * Carry out an approved release. Resolves when it is over, whatever the outcome; the
 * outcome is on the task and in the releases table.
 */
export async function executeRelease(approval: { id: string; task_id: string; commit_sha: string }): Promise<ReleaseRow> {
  const taskId = approval.task_id;
  const task = getTask(taskId);
  const ws = activeWorkspace(taskId);
  if (!task || !ws) throw new ReleaseError(`${taskId} has no workspace to release`);
  const repo = getRepo(ws.repo_id);
  if (!repo?.stgBranch) throw new ReleaseError(`${ws.repo_id} has no staging branch in the registry`);
  const stg = repo.stgBranch;
  if (!canTransition(task.state, 'releasing')) throw new ReleaseError(`${taskId} is ${task.state}; it cannot be released from there`);

  setTaskState(taskId, 'releasing', `Merging ${ws.branch} into ${stg}`);
  const id = `rel-${randomUUID()}`;
  getDb().prepare(`
    INSERT INTO releases (id, task_id, repo_id, approval_id, state, stg_branch, head_sha, started_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
  `).run(id, taskId, ws.repo_id, approval.id, stg, approval.commit_sha, nowMs());
  sseEmit({ type: 'release_updated', taskId });

  try {
    const result = await withRepoLock(ws.repo_path, () =>
      releaseToStg({
        repoPath: ws.repo_path,
        branch: ws.branch,
        headSha: approval.commit_sha,
        baseSha: ws.base_sha,
        stgBranch: stg,
        // Work that continued an existing branch: merged whole, and not pushed again under FryDay's name when it already went to the owner's branch.
        plainMergeOnly: !!ws.target_branch,
        pushBranch: !(ws.pushed_sha === approval.commit_sha && ws.pushed_ref),
        mergeName: ws.pushed_sha === approval.commit_sha && ws.pushed_ref ? ws.pushed_ref : undefined,
        releasePath: releasePath(ws),
        label: `${taskId}: ${task.title}`,
        checkMerged: (worktree, stgBefore) => {
          setTaskNote(taskId, `Checking the merged code before pushing to ${stg}`);
          return checkMergedTree(ws, worktree, stgBefore);
        },
        // Written before the push: after a crash, the remote is checked for this commit.
        onIntent: (i) => update(id, { strategy: i.strategy, stg_before_sha: i.stgBeforeSha, merge_sha: i.mergeSha, twin_branch: i.twinBranch, attempts: i.attempt }),
      })
    );
    const { state, note } = describe(result, ws.branch, stg);
    update(id, {
      state, outcome: result.status, detail: note, ended_at: nowMs(),
      ...(result.status === 'pushed' ? { strategy: result.strategy, stg_before_sha: result.stgBeforeSha, merge_sha: result.mergeSha, twin_branch: result.twinBranch, attempts: result.attempts } : {}),
      // A merge that was built but not pushed must not look like one that is on staging.
      ...(result.status !== 'pushed' && result.status !== 'already_merged' ? { merge_sha: null } : {}),
    });
    getDb().prepare(`UPDATE approvals SET state = 'executed' WHERE id = ?`).run(approval.id);
    if (state === 'pushed') afterPush(id, note, stg);
    else tell(taskId, note);
  } catch (err) {
    // Something broke mid-way (network, credentials). If a merge was about to be pushed, find out whether it landed.
    const row = getDb().prepare('SELECT * FROM releases WHERE id = ?').get(id) as ReleaseRow;
    let landed = false;
    if (row.merge_sha) {
      try { landed = await isOnStg(ws.repo_path, stg, row.merge_sha); } catch { /* cannot tell */ }
    }
    const note = landed
      ? `Merged into ${stg} and pushed (merge ${short(row.merge_sha)}), but the release then hit an error: ${message(err)}`
      : `The release failed before anything reached ${stg}: ${message(err)}`;
    update(id, { state: landed ? 'pushed' : 'stopped', outcome: landed ? 'pushed' : 'error', detail: note, ended_at: nowMs(), ...(landed ? {} : { merge_sha: null }) });
    tell(taskId, note);
  }
  return getDb().prepare('SELECT * FROM releases WHERE id = ?').get(id) as ReleaseRow;
}

/** Undo a task's release on staging with a revert commit. An owner action. */
export async function revertTaskRelease(taskId: string): Promise<ReleaseRow> {
  const task = getTask(taskId);
  const row = latestRelease(taskId);
  if (!task || !row) throw new ReleaseError(`${taskId} has no release`);
  if (row.state !== 'pushed' || !row.merge_sha) throw new ReleaseError(`${taskId}'s release is ${row.state}; there is nothing on staging to revert`);
  const repo = getRepo(row.repo_id);
  const ws = activeWorkspace(taskId);
  const repoPath = ws?.repo_path ?? repo?.localPath;
  if (!repoPath) throw new ReleaseError(`The repository for ${taskId} was not found`);
  const scratch = ws ? releasePath(ws) : `${getConfig().workspaceDir}/${taskId}/${row.repo_id}.release`;

  setTaskNote(taskId, `Reverting the merge on ${row.stg_branch}`);
  const result = await withRepoLock(repoPath, () =>
    revertRelease({ repoPath, stgBranch: row.stg_branch, mergeSha: row.merge_sha!, releasePath: scratch, label: `${taskId}: ${task.title}` })
  );
  if (result.status === 'reverted') {
    update(row.id, { state: 'reverted', revert_sha: result.revertSha, detail: `Reverted on ${row.stg_branch} (${short(result.revertSha)})` });
    tell(taskId, `Reverted on ${row.stg_branch} with commit ${short(result.revertSha)}. The task branch is kept. Deploy ${row.stg_branch} again to take the change out of staging.`);
  } else if (result.status === 'conflict') {
    tell(taskId, `The revert conflicts in ${result.files.join(', ') || 'some files'} because later changes build on this one. ${row.stg_branch} was not changed.`);
  } else if (result.status === 'not_on_stg') {
    tell(taskId, `The merge ${short(row.merge_sha)} is not on ${row.stg_branch} any more; nothing was reverted.`);
  } else {
    tell(taskId, `${row.stg_branch} kept changing while reverting (${result.attempts} tries). Nothing was pushed.`);
  }
  return latestRelease(taskId)!;
}

/**
 * Call once at startup. A release that was running when core stopped either got its
 * merge onto staging or it did not; the remote is asked, nothing is pushed again.
 */
export async function reconcileReleasesOnStartup(): Promise<void> {
  const rows = getDb().prepare(`SELECT * FROM releases WHERE state = 'running'`).all() as ReleaseRow[];
  for (const row of rows) {
    const repoPath = activeWorkspace(row.task_id)?.repo_path ?? getRepo(row.repo_id)?.localPath;
    let landed: boolean | null = false;
    if (row.merge_sha && repoPath) {
      try { landed = await isOnStg(repoPath, row.stg_branch, row.merge_sha); } catch { landed = null; }
    }
    const note =
      landed === true ? `Merged into ${row.stg_branch} and pushed (merge ${short(row.merge_sha)}); Fryday restarted right after. Deploy it from the task when you are ready.`
      : landed === false ? `Fryday restarted during the release, before anything reached ${row.stg_branch}. Approve again to retry.`
      : `Fryday restarted during the release and could not reach the remote to see whether merge ${short(row.merge_sha)} is on ${row.stg_branch}. Check before approving again.`;
    update(row.id, {
      state: landed === true ? 'pushed' : 'stopped', outcome: landed === true ? 'pushed' : 'interrupted', detail: note, ended_at: nowMs(),
      ...(landed === false ? { merge_sha: null } : {}),
    });
    tell(row.task_id, note);
  }
}
