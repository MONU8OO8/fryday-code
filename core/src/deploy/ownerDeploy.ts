/**
 * Deploying without the owner doing the setup by hand.
 *
 * ensureDeployer   a project with no deployer gets one: FryDay looks through the Jenkins it
 *                  is connected to for the job that builds the project's repository and
 *                  keeps it on the project. A name said in conversation only chooses among
 *                  those jobs: core gathers the list, and nothing outside it can be set from
 *                  a chat (any other job is the owner's to enter on the Projects page).
 * deployForOwner   the owner said "deploy it" on a task (to the Lead, or with the button):
 *                  whatever is missing is found first, then a deploy ticket is raised. For a
 *                  job the owner already knows, said at the UI, that ticket is approved in
 *                  their name at once; otherwise it waits for them, naming the job.
 *
 * Every deploy has a ticket. A job about production is never set up here, and nothing is
 * started in Jenkins by looking.
 */

import { execFileSync } from 'child_process';
import { getDb } from '../db/db.js';
import { getRepo, overrideRepo, type Project } from '../registry/registry.js';
import { getTask } from '../pipeline/taskState.js';
import { addMessage } from '../pipeline/thread.js';
import { resolveApproval, type ApprovalRow } from '../pipeline/approvals.js';
import type { ReleaseRow } from '../pipeline/releaseFlow.js';
import { deployerOf, loadJenkinsCredentials, looksLikeProduction, type JenkinsDeployer } from './config.js';
import { candidateNamed, deployJobsOf, pickDeployJob } from './discover.js';
import { jenkinsClient, latestDeploy, oneYesToStaging, requestDeployApproval, type DeployAsk } from './deployFlow.js';

export type Ensured =
  | { ok: true; deployer: JenkinsDeployer; /** Set up just now: the owner has not seen which job it is. */ isNew: boolean; sentence: string }
  | { ok: false; sentence: string };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function remoteOf(project: Project): string | null {
  if (project.remoteUrl) return project.remoteUrl;
  try {
    return execFileSync('git', ['-C', project.localPath, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function keep(project: Project, job: string, branchParam: string | null): JenkinsDeployer {
  const saved = overrideRepo(project.id, { deployer: 'jenkins', deployerConfig: { job, branchParam } });
  return deployerOf(saved)!;
}

// One search per project at a time: a task start and a release asking at once share the answer.
const searching = new Map<string, Promise<Ensured>>();

/**
 * The project's deployer; found and kept when there is none. With `named`, someone said which
 * job it is: it is kept only when it is one of the jobs that build this project's repository.
 */
export function ensureDeployer(repoId: string, named: string | null = null): Promise<Ensured> {
  const key = `${repoId}\n${named ?? ''}`;
  const going = searching.get(key);
  if (going) return going;
  const run = find(repoId, named).finally(() => searching.delete(key));
  searching.set(key, run);
  return run;
}

async function find(repoId: string, named: string | null): Promise<Ensured> {
  const project = getRepo(repoId);
  if (!project) return { ok: false, sentence: `${repoId} is not a project set up here.` };
  const existing = deployerOf(project);
  if (existing && (!named || named === existing.job)) return { ok: true, deployer: existing, isNew: false, sentence: `${project.name} deploys with the Jenkins job ${existing.job}.` };
  if (!project.stgBranch) return { ok: false, sentence: `${project.name} has no staging branch set, so there is nothing for a deploy to build.` };
  if (!loadJenkinsCredentials()) return { ok: false, sentence: 'Jenkins is not connected here, so I cannot deploy. Connect it on the Connections page (one press when Claude Code already has it), then write "deploy it" here.' };

  try {
    const jenkins = jenkinsClient();
    const remote = remoteOf(project);
    if (!remote) return { ok: false, sentence: `${project.name} has no Git remote, so I cannot tell which Jenkins job builds it. Set the job on the Projects page.` };
    const jobs = await jenkins.allJobs();
    if (named) {
      if (looksLikeProduction(named)) return { ok: false, sentence: `${named} looks like a production job. I only ever deploy staging, so I did not set it.` };
      const fits = deployJobsOf(jobs, remote, project.stgBranch);
      const chosen = candidateNamed(fits, named);
      if (!chosen) {
        return { ok: false, sentence: fits.length
          ? `${named} is not one of the Jenkins jobs that build ${project.name}'s repository (${fits.map((c) => c.name).slice(0, 6).join(', ')}). To use a different job, set it on the Projects page.`
          : `No Jenkins job builds ${project.name}'s repository, so I cannot check that ${named} is the right one. Set it on the Projects page and I deploy with it.` };
      }
      const deployer = keep(project, chosen.name, chosen.branchParam);
      return { ok: true, deployer, isNew: true, sentence: `I set ${deployer.job} as the Jenkins job that deploys ${project.name}.` };
    }

    const found = pickDeployJob(jobs, remote, project.stgBranch);
    if (found.kind === 'several') return { ok: false, sentence: `${found.jobs.length} Jenkins jobs build ${project.name}: ${found.jobs.join(', ')}. Tell me here which one deploys staging and I will set it.` };
    if (found.kind === 'none') return { ok: false, sentence: `I looked through ${found.looked} Jenkins jobs and none of them builds ${project.name}'s repository. Set its job on the Projects page, then write "deploy it" here.` };
    const deployer = keep(project, found.job, found.branchParam);
    return { ok: true, deployer, isNew: true, sentence: `I found the Jenkins job that builds ${project.name}'s repository, ${deployer.job}, and set it as this project's staging deploy.` };
  } catch (err) {
    return { ok: false, sentence: `I could not look for the Jenkins job: ${message(err)}` };
  }
}

/**
 * Before the owner is asked to approve a change: make sure the project's deployer is known,
 * so the one approval can say the deploy follows. Says so on the task when it found one.
 * Never throws; with no Jenkins connected it does nothing.
 */
export async function prepareDeployer(taskId: string, repoId: string): Promise<void> {
  const project = getRepo(repoId);
  if (!project?.stgBranch || deployerOf(project) || !loadJenkinsCredentials()) return;
  try {
    const ensured = await ensureDeployer(repoId);
    if (ensured.ok && ensured.isNew) addMessage(taskId, 'fryday', 'reply', `${ensured.sentence} When you approve the change, I deploy it with that job.`);
  } catch (err) {
    console.error(`[fryday-core] looking for the deployer of ${repoId} failed:`, err);
  }
}

const pendingTicket = (taskId: string) =>
  getDb().prepare(`SELECT * FROM approvals WHERE task_id = ? AND state = 'pending' ORDER BY requested_at DESC LIMIT 1`).get(taskId) as ApprovalRow | undefined;

/**
 * The owner asked for this task's change to be deployed to staging.
 *   atUi  the owner said it themself at the UI (in the chat box, or with the button): a job
 *         they already know is started at once. Said in the Chat space, or when the job was
 *         only just found, or when Settings asks for every step, it becomes one decision
 *         that names the job.
 *   job   the Jenkins job the owner named, when they did.
 * Returns what to tell the owner. Never throws.
 */
export async function deployForOwner(taskId: string, release: ReleaseRow | undefined, opts: { atUi: boolean; job?: string | null }): Promise<string> {
  const byCode = 'reply approve with the code from that message';
  try {
    const task = getTask(taskId);
    if (!task) return 'That task is gone.';
    if (!release || release.state !== 'pushed') return 'Nothing of this task is on the staging branch yet, so there is nothing to deploy. Approve the change first; the deploy follows it.';
    const going = latestDeploy(taskId);
    if (going && ['queued', 'running'].includes(going.state)) return `A deploy of this task is already running in Jenkins (${going.job}${going.build_number ? ` #${going.build_number}` : ''}).`;
    const waiting = pendingTicket(taskId);
    if (waiting && (waiting.action === 'deploy_stg' || waiting.action === 'deploy_input')) {
      if (!opts.atUi) return `The deploy is waiting for your yes: ${byCode}.`;
      resolveApproval(waiting.id, 'approved', { via: 'cookie', resolvedBy: 'owner, in the task chat' });
      return waiting.action === 'deploy_stg' ? 'Starting the deploy now. I will say here how it ends.' : 'I answered the Jenkins prompt; the deploy goes on. I will say here how it ends.';
    }
    if (task.state !== 'awaiting_approval' && task.state !== 'needs_owner') return `The task is busy right now (${task.state}). Ask again when it has come to rest.`;

    const ensured = await ensureDeployer(release.repo_id, opts.job?.trim() || null);
    if (!ensured.ok) return ensured.sentence;
    const project = getRepo(release.repo_id)!;
    const ask: DeployAsk = { repoId: project.id, repoName: project.name, stg: release.stg_branch, expectedSha: release.merge_sha ?? release.head_sha, releaseId: release.id, deployer: ensured.deployer };
    if (opts.atUi && oneYesToStaging() && !ensured.isNew) {
      // The owner's own words at their machine are the yes; the ticket is the record of what it started.
      const ticket = requestDeployApproval(taskId, ask, false);
      resolveApproval(ticket.id, 'approved', { via: 'cookie', resolvedBy: 'owner, in the task chat' });
      return `Starting the Jenkins job ${ensured.deployer.job} to deploy ${release.stg_branch}. I will say here how it ends.`;
    }
    requestDeployApproval(taskId, ask);
    const how = opts.atUi ? 'Approve below and I start it' : `To start it, ${byCode}`;
    return ensured.isNew ? `${ensured.sentence} ${how}.` : `The deploy with ${ensured.deployer.job} is ready. ${how}.`;
  } catch (err) {
    return `I could not start the deploy: ${message(err)}`;
  }
}
