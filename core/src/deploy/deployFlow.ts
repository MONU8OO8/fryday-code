/**
 * Deploying staging after a release, with Jenkins:
 *
 *   merge pushed to staging → "deploy staging?" ticket → on yes, start the job
 *     → follow the queue item to its build → follow the build and its stages
 *     → a "Proceed?" prompt in a staging stage → its own ticket → on yes, Proceed
 *     → a prompt that mentions production, or is not clearly staging → never answered;
 *       the owner is told, and FryDay stops following
 *     → the staging stage (or the whole build) succeeded → check that the build built
 *       the merge FryDay pushed → deployed
 *
 * Nothing here runs without the owner's yes, and nothing ever answers a production
 * prompt. A deploy whose commit cannot be confirmed is not called deployed.
 *
 * Every step is stored, so a core restart picks up following where it was.
 */

import { randomUUID } from 'crypto';
import { getDb, nowMs } from '../db/db.js';
import { getRepo } from '../registry/registry.js';
import { sseEmit } from '../api/events.js';
import { canTransition } from '../pipeline/stateMachine.js';
import { getTask, setTaskState, setTaskNote } from '../pipeline/taskState.js';
import { activeWorkspace } from '../pipeline/workspaces.js';
import { gitAsync } from '../pipeline/worktrees.js';
import { raiseTicket, registerApprovalAction, type ApprovalRow } from '../pipeline/approvals.js';
import type { ReleaseRow } from '../pipeline/releaseFlow.js';
import { JenkinsClient, JenkinsError, type Stage, type Transport } from './jenkins.js';
import { deployerOf, deployParams, inputKind, loadJenkinsCredentials, type JenkinsDeployer } from './config.js';

export interface DeployRow {
  id: string;
  task_id: string;
  repo_id: string;
  release_id: string | null;
  approval_id: string | null;
  job: string;
  params_json: string;
  stage: string | null;
  expected_sha: string;
  state: 'queued' | 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'stopped';
  queue_path: string | null;
  build_number: number | null;
  build_url: string | null;
  built_sha: string | null;
  stages_json: string | null;
  input_id: string | null;
  outcome: string | null;
  detail: string | null;
  started_at: number;
  ended_at: number | null;
  deadline_at: number;
}

const short = (sha: string | null | undefined) => (sha ?? '').slice(0, 8);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

let pollMs = 5000;
let transport: Transport | undefined;
/** For tests: a stand-in Jenkins, and how often to look. */
export function setDeployTransport(t: Transport | undefined, poll = 5000): void {
  transport = t;
  pollMs = poll;
}

function client(): JenkinsClient {
  const creds = loadJenkinsCredentials();
  if (!creds) throw new JenkinsError('Jenkins is not set up: add its address, a user and an API token on the Connections page');
  return new JenkinsClient(creds, transport);
}

export function latestDeploy(taskId: string): DeployRow | undefined {
  return getDb().prepare('SELECT * FROM deploys WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(taskId) as DeployRow | undefined;
}
const getDeploy = (id: string) => getDb().prepare('SELECT * FROM deploys WHERE id = ?').get(id) as DeployRow | undefined;

function update(id: string, fields: Partial<DeployRow>): void {
  const keys = Object.keys(fields) as Array<keyof DeployRow>;
  if (keys.length === 0) return;
  getDb().prepare(`UPDATE deploys SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] as string | number | null), id);
  const row = getDeploy(id);
  if (row) sseEmit({ type: 'deploy_updated', taskId: row.task_id });
}

/** End a deploy and tell the owner. A finished deploy is never ended twice. */
function end(row: DeployRow, state: 'succeeded' | 'failed' | 'stopped', outcome: string, note: string): void {
  const current = getDeploy(row.id);
  if (!current || ['succeeded', 'failed', 'stopped'].includes(current.state)) return;
  update(row.id, { state, outcome, detail: note, ended_at: nowMs(), input_id: null });
  stopFollowing(row.id);
  const task = getTask(row.task_id);
  if (!task) return;
  if (state === 'succeeded' && canTransition(task.state, 'deployed')) setTaskState(row.task_id, 'deployed', note);
  else if (task.state !== 'needs_owner' && canTransition(task.state, 'needs_owner')) setTaskState(row.task_id, 'needs_owner', note);
  else setTaskNote(row.task_id, note);
}

// ─── Asking ───────────────────────────────────────────────────────────────────

/**
 * After a release is on staging: when the project has a Jenkins deployer and Jenkins is
 * set up, ask the owner whether to deploy. Returns the sentence for the owner, or null
 * when deploying is not set up for this project.
 */
export function offerDeploy(release: Pick<ReleaseRow, 'id' | 'task_id' | 'repo_id' | 'stg_branch' | 'merge_sha' | 'head_sha'>): { asked: boolean; sentence: string } | null {
  const repo = getRepo(release.repo_id);
  const deployer = repo ? deployerOf(repo) : null;
  if (!repo || !deployer) return null;
  if (!loadJenkinsCredentials()) return { asked: false, sentence: `${repo.name} deploys with Jenkins, but Jenkins is not set up here (Connections page). Deploy ${release.stg_branch} yourself, or set it up and ask again on the task.` };
  // Already-merged releases have no merge of their own: the reviewed commit must be on staging then.
  const expected = release.merge_sha ?? release.head_sha;
  requestDeployApproval(release.task_id, { repoId: repo.id, repoName: repo.name, stg: release.stg_branch, expectedSha: expected, releaseId: release.id, deployer });
  return { asked: true, sentence: `Deploy ${release.stg_branch} with Jenkins (${deployer.job})? Approve on the task.` };
}

/** The owner asks again (after a deploy that failed or was declined). */
export function askToDeployAgain(taskId: string, latestPushed: Pick<ReleaseRow, 'id' | 'task_id' | 'repo_id' | 'stg_branch' | 'merge_sha' | 'head_sha'>): ApprovalRow {
  const current = latestDeploy(taskId);
  if (current && ['queued', 'running', 'waiting_input'].includes(current.state)) throw new JenkinsError('A deploy of this task is still going');
  const offer = offerDeploy(latestPushed);
  if (!offer) throw new JenkinsError('This project has no Jenkins deployer set up (Projects page)');
  if (!offer.asked) throw new JenkinsError(offer.sentence);
  return getDb().prepare(`SELECT * FROM approvals WHERE task_id = ? AND state = 'pending' ORDER BY requested_at DESC LIMIT 1`).get(taskId) as ApprovalRow;
}

interface DeployAsk {
  repoId: string;
  repoName: string;
  stg: string;
  expectedSha: string;
  releaseId: string | null;
  deployer: JenkinsDeployer;
}

export function requestDeployApproval(taskId: string, ask: DeployAsk): ApprovalRow {
  const params = deployParams(ask.deployer, ask.stg);
  const task = getTask(taskId);
  if (task && task.state !== 'awaiting_approval' && canTransition(task.state, 'awaiting_approval')) setTaskState(taskId, 'awaiting_approval', `Ready to deploy ${ask.stg}`);
  return raiseTicket(taskId, 'deploy_stg', {
    summary: `Start the Jenkins job ${ask.deployer.job} to deploy ${ask.stg} (${ask.repoName})`,
    job: ask.deployer.job,
    params,
    stage: ask.deployer.stage,
    stgBranch: ask.stg,
    expectedSha: ask.expectedSha,
    releaseId: ask.releaseId,
    repoId: ask.repoId,
    // Nothing is pushed; this is what happens outside the Mac.
    effects: [
      `starts ${ask.deployer.job}${Object.keys(params).length ? ` with ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`,
      ask.deployer.stage ? `counts as deployed once its "${ask.deployer.stage}" stage succeeds and the build is shown to contain ${short(ask.expectedSha)}` : `counts as deployed once the build succeeds and is shown to contain ${short(ask.expectedSha)}`,
      'any prompt in the pipeline that mentions production is never answered by FryDay',
    ],
  }, null);
}

// ─── Starting ─────────────────────────────────────────────────────────────────

async function startDeploy(ticket: ApprovalRow): Promise<void> {
  const p = JSON.parse(ticket.payload_json) as { job: string; params: Record<string, string>; stage: string | null; expectedSha: string; releaseId: string | null; repoId: string; stgBranch: string };
  const repo = getRepo(p.repoId);
  const deployer = repo ? deployerOf(repo) : null;
  const taskId = ticket.task_id;
  const task = getTask(taskId);
  if (!task || !canTransition(task.state, 'deploying')) throw new JenkinsError(`${taskId} is ${task?.state ?? 'gone'}; it cannot be deployed from there`);
  // The project's deploy settings could have changed since the ticket was raised: the yes was for what the ticket said.
  if (!deployer || deployer.job !== p.job) throw new JenkinsError('The deploy settings of the project changed after you were asked; ask again on the task');

  const id = `dep-${randomUUID()}`;
  getDb().prepare(`
    INSERT INTO deploys (id, task_id, repo_id, release_id, approval_id, job, params_json, stage, expected_sha, state, started_at, deadline_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
  `).run(id, taskId, p.repoId, p.releaseId, ticket.id, p.job, JSON.stringify(p.params), p.stage, p.expectedSha, nowMs(), nowMs() + deployer.timeoutMinutes * 60_000);
  setTaskState(taskId, 'deploying', `Starting ${p.job} in Jenkins`);
  getDb().prepare(`UPDATE approvals SET state = 'executed' WHERE id = ?`).run(ticket.id);
  sseEmit({ type: 'deploy_updated', taskId });

  let queuePath: string;
  try {
    queuePath = await client().trigger(p.job, p.params);
  } catch (err) {
    end(getDeploy(id)!, 'failed', 'error', `Jenkins did not start the deploy: ${message(err)}. Nothing was deployed.`);
    return;
  }
  update(id, { queue_path: queuePath });
  setTaskNote(taskId, `${p.job} is queued in Jenkins`);
  follow(id);
}

// ─── Following ────────────────────────────────────────────────────────────────

const timers = new Map<string, NodeJS.Timeout>();
const busy = new Set<string>();

function stopFollowing(id: string): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

function follow(id: string, delay = 0): void {
  stopFollowing(id);
  timers.set(id, setTimeout(() => { void step(id); }, delay));
}

/** Look at Jenkins once and act on what it says; schedule the next look unless it is over. */
async function step(id: string): Promise<void> {
  if (busy.has(id)) return;
  busy.add(id);
  try {
    const row = getDeploy(id);
    if (!row || !['queued', 'running'].includes(row.state)) return;
    if (nowMs() > row.deadline_at) {
      end(row, 'stopped', 'timeout', `FryDay stopped following the deploy after its time limit. ${row.build_url ? `See the build in Jenkins: ${row.build_url}` : 'It never started in Jenkins.'} Nothing was cancelled there.`);
      return;
    }
    const again = await look(row);
    if (again) follow(id, pollMs);
  } catch (err) {
    // A network hiccup is not a failed deploy: try again until the time limit.
    const row = getDeploy(id);
    if (!row) return;
    if (err instanceof JenkinsError && (err.status === 401 || err.status === 403)) {
      end(row, 'stopped', 'error', `Jenkins refused FryDay while following the deploy: ${message(err)}`);
      return;
    }
    update(id, { detail: `Could not reach Jenkins just now (${message(err)}); trying again.` });
    follow(id, pollMs * 2);
  } finally {
    busy.delete(id);
  }
}

/** One look. Returns true when there is more to wait for. */
async function look(row: DeployRow): Promise<boolean> {
  const jenkins = client();
  // Queued: wait for Jenkins to turn the item into a build.
  if (row.build_number === null) {
    const q = await jenkins.queueItem(row.queue_path!);
    if (q.cancelled) { end(row, 'failed', 'cancelled', 'The deploy was cancelled in the Jenkins queue before it started. Nothing was deployed.'); return false; }
    if (q.buildNumber === null) {
      if (q.why) update(row.id, { detail: `Waiting in the Jenkins queue: ${q.why}` });
      return true;
    }
    update(row.id, { build_number: q.buildNumber, state: 'running', detail: null });
    setTaskNote(row.task_id, `${row.job} #${q.buildNumber} is running in Jenkins`);
    row = getDeploy(row.id)!;
  }

  const build = await jenkins.build(row.job, row.build_number!);
  const pipeline = await jenkins.stages(row.job, row.build_number!);
  update(row.id, { build_url: build.url || row.build_url, built_sha: build.builtSha, stages_json: pipeline ? JSON.stringify(pipeline.stages) : row.stages_json });

  // The staging stage, when one was named: success there is enough, whatever comes after.
  const target = row.stage ? pipeline?.stages.find((s) => s.name.toLowerCase() === row.stage!.toLowerCase()) : undefined;
  if (row.stage && pipeline && target?.status === 'SUCCESS') return finishIfRightCommit(row, build.builtShas, `its "${target.name}" stage succeeded`);
  if (row.stage && target && ['FAILED', 'ABORTED', 'UNSTABLE'].includes(target.status)) {
    end(row, 'failed', 'build_failed', `The "${target.name}" stage of ${row.job} #${build.number} ${target.status.toLowerCase()}. ${build.url}`);
    return false;
  }

  // A prompt waiting for someone's yes.
  const inputs = await jenkins.pendingInputs(row.job, row.build_number!);
  if (inputs.length > 0) {
    const input = inputs[0]!;
    const paused = pipeline?.stages.find((s) => s.status === 'PAUSED_PENDING_INPUT') ?? null;
    return askAboutInput(row, input.id, input.message, input.proceedText, input.hasParameters, paused);
  }

  if (build.building) return true;
  if (row.stage && pipeline && !target) {
    end(row, 'failed', 'build_failed', `${row.job} #${build.number} finished (${build.result ?? 'no result'}) without a stage named "${row.stage}". Check the stage name in the project's deploy settings. ${build.url}`);
    return false;
  }
  if (build.result === 'SUCCESS') return finishIfRightCommit(row, build.builtShas, 'the build succeeded');
  end(row, 'failed', 'build_failed', `${row.job} #${build.number} ended ${build.result ?? 'without a result'}. Nothing more was done. ${build.url}`);
  return false;
}

/** The build succeeded: it counts only if it built the merge FryDay pushed (or a later staging that contains it). */
async function finishIfRightCommit(row: DeployRow, builtShas: string[], how: string): Promise<boolean> {
  const fresh = getDeploy(row.id)!;
  const where = `${fresh.job} #${fresh.build_number}${fresh.build_url ? ` (${fresh.build_url})` : ''}`;
  if (builtShas.length === 0) {
    end(fresh, 'stopped', 'unconfirmed', `${where}: ${how}, but Jenkins does not say which commit it built, so FryDay cannot confirm that ${short(fresh.expected_sha)} is what was deployed. Check in Jenkins.`);
    return false;
  }
  const repoPath = activeWorkspace(fresh.task_id)?.repo_path ?? getRepo(fresh.repo_id)?.localPath;
  let contains = builtShas.includes(fresh.expected_sha.toLowerCase());
  if (!contains && repoPath) {
    try {
      await gitAsync(repoPath, ['fetch', '--quiet', '--no-tags', 'origin']);
    } catch {
      /* the check below decides with what is here */
    }
    for (const sha of builtShas) {
      try {
        await gitAsync(repoPath, ['merge-base', '--is-ancestor', fresh.expected_sha, sha]);
        contains = true;
        break;
      } catch {
        /* not this one */
      }
    }
  }
  if (!contains) {
    end(fresh, 'stopped', 'wrong_commit', `${where}: ${how}, but it built ${builtShas.map(short).join(', ')}, which does not contain the merge ${short(fresh.expected_sha)}. The change is not on staging; was the job told the right branch?`);
    return false;
  }
  end(fresh, 'succeeded', 'deployed', `Deployed to staging: ${where}, ${how} and it contains ${short(fresh.expected_sha)}.`);
  return false;
}

/** A pipeline prompt. A staging one becomes the owner's decision; anything else is never answered. */
function askAboutInput(row: DeployRow, inputId: string, msg: string, proceedText: string, hasParameters: boolean, stage: Stage | null): boolean {
  if (row.input_id === inputId) return false; // already asked; waiting for the owner
  const kind = inputKind(stage?.name ?? null, msg, proceedText);
  const where = `${row.job} #${row.build_number}${row.build_url ? ` (${row.build_url})` : ''}`;
  const said = `"${msg || proceedText}"${stage ? ` in the stage "${stage.name}"` : ''}`;
  if (kind !== 'staging' || hasParameters) {
    const why = kind === 'production' ? 'It is about production, which FryDay never approves.'
      : hasParameters ? 'It asks for values, which FryDay does not fill in.'
      : 'It does not clearly say it is about staging, so FryDay does not answer it.';
    end(row, 'stopped', 'production_prompt', `${where} is waiting for someone's yes: ${said}. ${why} Answer it in Jenkins yourself, or let it time out.${row.stage ? '' : ' FryDay has stopped following this build.'}`);
    return false;
  }
  update(row.id, { state: 'waiting_input', input_id: inputId, detail: `Waiting for your yes: ${said}` });
  const task = getTask(row.task_id);
  if (task && canTransition(task.state, 'awaiting_approval')) setTaskState(row.task_id, 'awaiting_approval', `Jenkins asks: ${msg || proceedText}`);
  raiseTicket(row.task_id, 'deploy_input', {
    summary: `Jenkins asks ${said} for ${row.job} #${row.build_number}. Answer "${proceedText}"?`,
    deployId: row.id,
    inputId,
    job: row.job,
    buildNumber: row.build_number,
    effects: [`answers "${proceedText}" to that prompt in Jenkins, and nothing else`],
  }, null);
  return false;
}

async function proceedInput(ticket: ApprovalRow): Promise<void> {
  const p = JSON.parse(ticket.payload_json) as { deployId: string; inputId: string };
  const row = getDeploy(p.deployId);
  if (!row || row.state !== 'waiting_input' || row.input_id !== p.inputId) throw new JenkinsError('That prompt is no longer waiting');
  getDb().prepare(`UPDATE approvals SET state = 'executed' WHERE id = ?`).run(ticket.id);
  const jenkins = client();
  // Still the same prompt, and still not about production, at the moment of answering.
  const inputs = await jenkins.pendingInputs(row.job, row.build_number!);
  const input = inputs.find((i) => i.id === p.inputId);
  if (!input) {
    update(row.id, { state: 'running', input_id: null, detail: 'The prompt was answered or went away in Jenkins before FryDay answered it.' });
  } else {
    if (inputKind(null, input.message, input.proceedText) === 'production') throw new JenkinsError('The prompt now mentions production; FryDay does not answer it');
    await jenkins.proceed(row.job, row.build_number!, p.inputId);
    update(row.id, { state: 'running', input_id: null, detail: `Answered "${input.proceedText}"` });
  }
  setTaskState(row.task_id, 'deploying', `${row.job} #${row.build_number} is running in Jenkins`);
  follow(row.id);
}

function declineInput(ticket: ApprovalRow): void {
  const p = JSON.parse(ticket.payload_json) as { deployId: string };
  const row = getDeploy(p.deployId);
  if (row) end(row, 'stopped', 'declined', `You declined the prompt. FryDay did not answer it and has stopped following ${row.job} #${row.build_number}; the build is still waiting in Jenkins until someone answers or it times out.`);
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

/** Call once at startup, before deploys are picked up again. */
export function registerDeploy(): void {
  registerApprovalAction('deploy_stg', {
    onApprove: startDeploy,
    declinedNote: 'You declined the deploy. The merge is on staging; nothing was started in Jenkins.',
  });
  registerApprovalAction('deploy_input', {
    onApprove: proceedInput,
    declinedNote: 'You declined the prompt. FryDay did not answer it in Jenkins.',
    onDecline: declineInput,
  });
}

/** Call once at startup: deploys that were being followed are followed again. */
export function reconcileDeploysOnStartup(): void {
  const rows = getDb().prepare(`SELECT * FROM deploys WHERE state IN ('queued', 'running')`).all() as DeployRow[];
  for (const row of rows) {
    if (row.state === 'queued' && !row.queue_path) {
      end(row, 'stopped', 'interrupted', 'FryDay restarted while starting the deploy, before Jenkins confirmed it. Check Jenkins before asking again: it may have started.');
      continue;
    }
    const task = getTask(row.task_id);
    if (task && task.state !== 'deploying' && canTransition(task.state, 'deploying')) setTaskState(row.task_id, 'deploying', 'Following the deploy again after a restart');
    follow(row.id);
  }
}

/** For tests and shutdown. */
export function stopAllDeploys(): void {
  for (const id of [...timers.keys()]) stopFollowing(id);
}
