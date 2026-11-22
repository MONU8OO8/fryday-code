/**
 * Approval tickets — the owner's yes for an action that leaves the Mac.
 *
 * A ticket is typed (what will be done) and bound to one commit. If the branch moves
 * after the ticket was raised, the ticket is void: nobody approves code they did not
 * see. Approving does not hand anything to an agent; core carries the action out itself.
 *
 * Who may resolve a ticket:
 *   - the UI (session cookie, same-origin): the owner at their own machine;
 *   - a caller with the install's secret (an integration relaying a chat message): only with the ticket's
 *     one-time code, which the owner has to type back.
 */

import { randomInt, randomUUID, timingSafeEqual } from 'crypto';
import { getDb, nowMs } from '../db/db.js';
import { getRepo } from '../registry/registry.js';
import { sseEmit } from '../api/events.js';
import { getTask, setTaskState, setTaskNote } from './taskState.js';
import { activeWorkspace } from './workspaces.js';
import { getRounds, roundCleared } from './rounds.js';
import { verifiedPhrase } from '../verify/report.js';
import { git } from './worktrees.js';
import { executeRelease, latestRelease } from './releaseFlow.js';
import { commitsBesidesTheTask, twinBranchName } from './release.js';
import { ownerEmail } from './branches.js';
import { deployerOf, deployParams, loadJenkinsCredentials } from '../deploy/config.js';
import { oneYesToStaging, STAGING_PROMPT_EFFECT } from '../deploy/deployFlow.js';

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';

export interface ApprovalRow {
  id: string;
  task_id: string;
  run_id: string | null;
  action: string;
  payload_json: string;
  code: string | null;
  commit_sha: string | null;
  state: ApprovalState;
  requested_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

/** An approval with the one-time code left out. This is what the API returns. */
export type PublicApproval = Omit<ApprovalRow, 'code'>;

export class ApprovalError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
  }
}

export interface Resolver {
  via: 'cookie' | 'token';
  /** Required when via is 'token'. */
  code?: string;
  resolvedBy?: string;
}

export function publicApproval(row: ApprovalRow): PublicApproval {
  const { code: _code, ...rest } = row;
  return rest;
}

export function getApproval(id: string): ApprovalRow | undefined {
  return getDb().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
}

export function latestApproval(taskId: string): ApprovalRow | undefined {
  return getDb().prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1').get(taskId) as ApprovalRow | undefined;
}

export function pendingApprovals(): ApprovalRow[] {
  return getDb().prepare(`SELECT * FROM approvals WHERE state = 'pending' ORDER BY requested_at DESC`).all() as ApprovalRow[];
}

const short = (sha: string) => sha.slice(0, 8);

/**
 * Raise a "merge into staging" ticket for the task's current commit. Any earlier pending
 * ticket for the task is voided. Throws ApprovalError when there is nothing releasable.
 */
export function requestReleaseApproval(taskId: string): ApprovalRow {
  const task = getTask(taskId);
  const ws = activeWorkspace(taskId);
  if (!task || !ws || !ws.head_sha) throw new ApprovalError(409, `${taskId} has no committed work to release`);
  if (task.state !== 'awaiting_approval' && task.state !== 'needs_owner') {
    throw new ApprovalError(409, `${taskId} is ${task.state}; a release can only be requested once it has passed review`);
  }
  const rounds = getRounds(taskId);
  if (!roundCleared(rounds[rounds.length - 1]?.outcome)) throw new ApprovalError(409, `${taskId} has not passed checks and review`);
  const repo = getRepo(ws.repo_id);
  if (!repo?.stgBranch) throw new ApprovalError(409, `${repo?.name ?? ws.repo_id} has no staging branch in the registry`);
  const release = latestRelease(taskId);
  // Already on staging, unless the work changed since (the owner sent it back and it was fixed):
  // then the new commits need a merge of their own.
  if (release?.state === 'pushed' && release.head_sha === ws.head_sha) throw new ApprovalError(409, `${taskId} is already merged into ${release.stg_branch}`);
  if (release?.state === 'running') throw new ApprovalError(409, `${taskId} is being released right now`);

  const files = ws.files_json ? (JSON.parse(ws.files_json) as unknown[]).length : 0;
  const flags = rounds[rounds.length - 1]!.flags.filter((f) => f.severity === 'review').length;
  // Everything this approval will put on the remote, worked out from what is known now.
  const pushes: string[] = [];
  const alreadyPushed = ws.pushed_sha === ws.head_sha ? ws.pushed_ref : null;
  if (!alreadyPushed) pushes.push(`${ws.branch} → origin/${ws.branch} (a new branch)`);
  pushes.push(`a merge commit → origin/${repo.stgBranch} (not forced)`);
  let carried = '';
  if (ws.target_branch) {
    // Merging continued work brings the branch's earlier commits along with the task's own.
    const stgRef = `refs/remotes/origin/${repo.stgBranch}`;
    try {
      const owner = ownerEmail(ws.repo_path);
      const earlier = git(ws.repo_path, ['log', '--format=%ae', `${stgRef}..${ws.base_sha}`]).split('\n').filter(Boolean);
      const byOthers = earlier.filter((a) => !owner || a.toLowerCase() !== owner).length;
      if (earlier.length > 0) {
        carried = ` The merge also brings ${earlier.length} earlier commit${earlier.length === 1 ? '' : 's'} from ${ws.target_branch} into ${repo.stgBranch}, ${byOthers} of them by other people.`;
      }
    } catch {
      carried = ` The merge also brings the earlier commits of ${ws.target_branch} into ${repo.stgBranch}.`;
    }
  } else {
    try {
      const stgSha = git(ws.repo_path, ['rev-parse', '--verify', `refs/remotes/origin/${repo.stgBranch}^{commit}`]);
      if (commitsBesidesTheTask(ws.repo_path, stgSha, ws.base_sha) > 0) {
        pushes.push(`${twinBranchName(ws.branch)} → origin (a copy of the task's commits on top of ${repo.stgBranch}, because ${repo.stgBranch} is behind ${repo.prodBranch})`);
      }
    } catch {
      /* staging not fetched yet: the release itself decides */
    }
  }
  // One yes for the whole way to staging: the ticket names the Jenkins job that follows the merge,
  // so the owner approves the deploy here and is not asked a second and third time.
  const deployer = oneYesToStaging() && loadJenkinsCredentials() ? deployerOf(repo) : null;
  const params = deployer ? deployParams(deployer, repo.stgBranch) : {};
  const payload = {
    summary: `${alreadyPushed ? `Merge ${alreadyPushed}` : `Push ${ws.branch} and merge it`} into ${repo.stgBranch} (${repo.name})${deployer ? ', then deploy it to staging with Jenkins' : ''}.${carried}`.replace(/\)\.$/, ')'),
    pushes,
    ...(deployer ? {
      thenDeploy: { job: deployer.job, params },
      effects: [
        `then starts the Jenkins job ${deployer.job}${Object.keys(params).length ? ` with ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''} to deploy ${repo.stgBranch}`,
        STAGING_PROMPT_EFFECT,
        'any prompt in the pipeline that mentions production is never answered by FryDay',
      ],
    } : {}),
    repoId: repo.id,
    repoName: repo.name,
    branch: ws.branch,
    stgBranch: repo.stgBranch,
    commit: ws.head_sha,
    filesChanged: files,
    rounds: rounds.length,
    flaggedForAttention: flags,
    verified: verifiedPhrase(rounds[rounds.length - 1]!.verify),
  };
  return raiseTicket(taskId, 'release_stg', payload, ws.head_sha);
}

/**
 * Put a question to the owner. A task has at most one open ticket: raising a new one
 * voids the one before it.
 */
export function raiseTicket(taskId: string, action: string, payload: Record<string, unknown> & { summary: string }, commitSha: string | null, announce = true): ApprovalRow {
  if (!actions.has(action)) throw new Error(`No handler is registered for the approval action "${action}"`);
  getDb().prepare(`UPDATE approvals SET state = 'expired', resolved_at = ? WHERE task_id = ? AND state = 'pending'`).run(nowMs(), taskId);
  const id = `apr-${randomUUID()}`;
  getDb().prepare(`
    INSERT INTO approvals (id, task_id, action, payload_json, code, commit_sha, state, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, taskId, action, JSON.stringify(payload), String(randomInt(100_000, 1_000_000)), commitSha, nowMs());
  const row = getApproval(id)!;
  sseEmit({ type: 'approval_requested', taskId, approval: publicApproval(row) });
  const task = getTask(taskId);
  // A ticket the owner has just answered in their own words is recorded, not announced as a question.
  if (task && announce) ticketListener?.(task, payload.summary, Array.isArray(payload['pushes']) ? (payload['pushes'] as string[]) : [], row);
  return row;
}

// ─── What each kind of ticket does ────────────────────────────────────────────

export interface ApprovalAction {
  /** Carried out by core when the owner says yes. Runs in the background. */
  onApprove: (ticket: ApprovalRow) => Promise<void> | void;
  /** What to tell the owner when they say no. */
  declinedNote: string;
  /** What else a no means, when it means more than a note (it then also tells the owner). */
  onDecline?: (ticket: ApprovalRow) => void;
}

const actions = new Map<string, ApprovalAction>();

// Set at startup by the notifier: every new ticket is something the owner should hear about.
let ticketListener: ((task: { id: string; title: string }, summary: string, pushes: string[], ticket: ApprovalRow) => void) | null = null;
export function onTicketRaised(listener: typeof ticketListener): void {
  ticketListener = listener;
}

/** Teach core what a kind of ticket does. Called once per action at startup. */
export function registerApprovalAction(action: string, handler: ApprovalAction): void {
  actions.set(action, handler);
}

registerApprovalAction('release_stg', {
  onApprove: async (ticket) => {
    await executeRelease({ id: ticket.id, task_id: ticket.task_id, commit_sha: ticket.commit_sha! });
  },
  declinedNote: 'You declined the release. The branch is kept; nothing was pushed.',
});

function codeMatches(expected: string | null, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function finish(id: string, state: ApprovalState, by: string): ApprovalRow {
  getDb().prepare('UPDATE approvals SET state = ?, resolved_at = ?, resolved_by = ? WHERE id = ?').run(state, nowMs(), by, id);
  const row = getApproval(id)!;
  sseEmit({ type: 'approval_resolved', taskId: row.task_id, approval: publicApproval(row) });
  return row;
}

/**
 * Approve or decline a ticket. Approving starts the action and returns at once; the
 * outcome appears on the task. `onDone` is for tests.
 */
export function resolveApproval(id: string, decision: 'approved' | 'rejected', by: Resolver, onDone?: () => void): ApprovalRow {
  const ticket = getApproval(id);
  if (!ticket) throw new ApprovalError(404, 'No such approval');
  if (decision !== 'approved' && decision !== 'rejected') throw new ApprovalError(400, 'decision must be approved or rejected');
  if (ticket.state !== 'pending') throw new ApprovalError(409, `This approval is already ${ticket.state}`);
  if (by.via === 'token' && !codeMatches(ticket.code, by.code)) throw new ApprovalError(403, 'The approval code is missing or wrong');
  const who = by.resolvedBy ?? (by.via === 'cookie' ? 'ui' : 'chat');

  const handler = actions.get(ticket.action);
  if (!handler) throw new ApprovalError(400, `FryDay does not know how to carry out "${ticket.action}"`);

  if (decision === 'rejected') {
    const row = finish(id, 'rejected', who);
    if (handler.onDecline) {
      try {
        handler.onDecline(ticket);
        return row;
      } catch (err) {
        console.error(`[fryday-core] declining ${ticket.action} for ${ticket.task_id} failed:`, err);
      }
    }
    const task = getTask(ticket.task_id);
    if (task?.state === 'awaiting_approval') setTaskState(ticket.task_id, 'needs_owner', handler.declinedNote);
    else setTaskNote(ticket.task_id, handler.declinedNote);
    return row;
  }

  // A ticket bound to a commit is a yes for that commit only. If the branch has moved since, it is void.
  if (ticket.commit_sha) {
    const ws = activeWorkspace(ticket.task_id);
    let branchSha: string | null = null;
    try {
      branchSha = ws ? git(ws.repo_path, ['rev-parse', '--verify', `refs/heads/${ws.branch}^{commit}`]) : null;
    } catch {
      branchSha = null;
    }
    if (!ws || branchSha !== ticket.commit_sha || ws.head_sha !== ticket.commit_sha) {
      finish(id, 'expired', who);
      setTaskNote(
        ticket.task_id,
        `That approval was for commit ${short(ticket.commit_sha)}, but the branch is now at ${branchSha ? short(branchSha) : 'an unknown commit'}. Nothing was pushed.`
      );
      throw new ApprovalError(409, 'The branch changed after this approval was requested, so the approval is void. Nothing was pushed.');
    }
  }

  const row = finish(id, 'approved', who);
  void Promise.resolve()
    .then(() => handler.onApprove(ticket))
    .catch((err) => {
      console.error(`[fryday-core] approved action ${ticket.action} for ${ticket.task_id} failed:`, err);
      setTaskNote(ticket.task_id, `What you approved could not be carried out: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => onDone?.());
  return row;
}
