/**
 * The task pipeline:
 *
 *   queued → intake ⇄ waiting_owner → workspace → planning → coding ⇄ testing → verifying → awaiting_approval → releasing (on the owner's yes)
 *                                                                        └────→ needs_owner (round limit, or something only the owner can fix)
 *
 *   intake     the Analyst (read-only) works out which project the task is for, what
 *              exactly is asked, and whether an existing branch already holds part of it;
 *              anything only the owner can decide becomes a question (waiting_owner)
 *   workspace  core cuts a worktree from the production branch, or from the tip of the
 *              existing branch the task continues
 *   planning   the Planner (read-only) writes the plan and acceptance criteria
 *   coding     the Coder edits; core commits what it changed
 *   testing    core runs the repo's checks in the sandbox and reads the diff for
 *              weakened tests; only if both are clean does the Tester review. Anything
 *              that fails goes back to the Coder with the evidence.
 *   verifying  for a project with a run profile: core starts the service and tester
 *              agents use it through its API and in a browser (see verifyFlow.ts)
 *
 * Every step works from stored state, so an agent that finishes after a core restart
 * is handled the same way; steps core itself was running are picked up by
 * recoverInterruptedTasks().
 */

import fs from 'fs';
import path from 'path';
import { getDb } from '../db/db.js';
import { getConfig } from '../config.js';
import { getSettings, runSettingsFor } from '../settings.js';
import { getRepo, listRepos, type Project } from '../registry/registry.js';
import { startRun, onRunExit, killRun, CapacityError, type RunExit, type RunHandle, type RunOptions } from '../runner/supervisor.js';
import { sseEmit } from '../api/events.js';
import { canTransition } from './stateMachine.js';
import {
  getTask, setTaskState, setTaskNote, taskMetadata, updateTaskMetadata, taskTokenLimit, taskTokensLeft, taskTokensUsed, type TaskRow,
} from './taskState.js';
import { ACTOR_NAME, actorOfRole, formatTokens } from './plainWords.js';
import {
  branchName, createWorkspace, commitAll, summarizeChanges, createCheckout, removeCheckout, diffPatch, fileAt, git,
} from './worktrees.js';
import { activeWorkspace, saveWorkspace, readGuidance, reviewCheckoutPath, baseCheckoutPath, type WorkspaceRow } from './workspaces.js';
import { cannotRun, checkSpecs, runCheck, runChecks, type CheckResult, type CheckSpec } from './checks.js';
import { depsForCheckout, depsUsable } from './deps.js';
import { analyzeDiff, type DiffFlag } from './diffFlags.js';
import { saveGate, saveVerdict, saveOutcome, saveSelfCheck, getRound, getRounds } from './rounds.js';
import { raiseTicket, registerApprovalAction, type ApprovalRow } from './approvals.js';
import { requestNextApproval, executeBranchPush } from './pushFlow.js';
import { BRIEF_SCHEMA, TRIAGE_SCHEMA, TASK_FOLDER, parseBrief, parseTriage, briefText, writeTaskFolder, type Brief, type Triage } from './brief.js';
import { splitIntoSubtasks, validSplit } from './initiative.js';
import { unmetDependencies } from './taskLinks.js';
import { branchFacts, existsOnRemote, fetchBranches, listCandidates } from './branches.js';
import { askQuestions, listQuestions, openQuestions } from './questions.js';
import { addMessage, ownerNotes } from './thread.js';
import { StoppedError, stoppedChoices, canStop, canSendBack } from './stopped.js';
import { stopFollowingTask } from '../deploy/deployFlow.js';
import { prepareDeployer } from '../deploy/ownerDeploy.js';
import { documentsText } from './attachments.js';
import { retryWhenBusy, cancelPendingRetry, type RetryStage } from './retry.js';
import { verifyRound, onTesterRunExit, runProfileOf, isTesterRole, stopVerification, type VerifyHost } from './verifyFlow.js';
import { ownerSentBack, taskEnded } from '../learning/retro.js';
import { lessonsFor } from '../learning/inject.js';
import { stopLeftoverServices } from '../verify/service.js';
import {
  PLAN_SCHEMA, VERDICT_SCHEMA, parsePlan, parseVerdict, verdictPasses, gateBlocks, coderFeedback, roundSummary,
  writeReviewBrief, parseSelfCheck, calibrate, type Plan, type Verdict, type SelfCheck, type Calibration,
} from './review.js';
import { refreshWithin } from '../knowledge/graph.js';
import { projectMap } from '../knowledge/digest.js';
import { codePackFor } from '../knowledge/index/forTask.js';
import { rememberTask, similarTasks } from '../knowledge/index/memory.js';
import { kickEmbedding } from '../knowledge/index/indexer.js';
import { budgetedDiff } from './diffBudget.js';

const prompt = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'agents', 'prompts', `${name}.md`), 'utf8').trim();
const PLANNER_PROMPT = prompt('planner');
const CODER_PROMPT = prompt('coder');
const TESTER_PROMPT = prompt('tester');
const ANALYST_PROMPT = prompt('analyst');
const TRIAGE_PROMPT = prompt('analyst-triage');

/** How many times the Analyst may come back with questions before it has to go on with assumptions. */
const MAX_QUESTION_ROUNDS = 2;

const SLOT_RETRY_MS = 2000;

export class StartError extends Error {}

interface RunRow {
  id: string; task_id: string | null; role: string; round: number; state: string;
  session_id: string | null; output_json: string | null; tools_json: string | null; error_msg: string | null; result_text: string | null;
}
const getRun = (runId: string) => getDb().prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Hand the task to the owner with a reason; if that is not a legal move from here, fail it. */
function handToOwner(taskId: string, reason: string): void {
  const task = getTask(taskId);
  if (!task || task.state === 'failed' || task.state === 'needs_owner') return;
  setTaskState(taskId, canTransition(task.state, 'needs_owner') ? 'needs_owner' : 'failed', reason);
}

/** Move the task to `state` with a note; when it is already there (its stage is tried again), only the note. */
function enterState(taskId: string, state: TaskRow['state'], note: string): void {
  if (getTask(taskId)?.state === state) setTaskNote(taskId, note);
  else setTaskState(taskId, state, note);
}

function failTask(taskId: string, reason: string): void {
  const task = getTask(taskId);
  if (!task || task.state === 'failed') return;
  if (canTransition(task.state, 'failed')) setTaskState(taskId, 'failed', reason);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const ownerOf = (ws: WorkspaceRow) => ({ repoId: ws.repo_id, taskId: ws.task_id, ownerRepoPath: ws.repo_path });

/** Run a stage in the background; anything it throws goes to the owner instead of vanishing. */
function background(taskId: string, what: string, work: () => Promise<void>): void {
  void work().catch((err) => {
    console.error(`[fryday-core] ${taskId} ${what} failed:`, err);
    handToOwner(taskId, `${what} failed: ${message(err)}`);
  });
}

/**
 * The run failed because the AI service was busy for a moment: start its stage once more,
 * after a pause, as long as the task is still where it was (see retry.ts). False when this
 * is not such a failure or the stage already had its retry; then the caller goes on as before.
 */
function retryStage(exit: RunExit, run: RunRow, stage: RetryStage, state: TaskRow['state'], again: () => Promise<void>): boolean {
  const taskId = exit.taskId!;
  return retryWhenBusy(taskId, { state: exit.state, error: exit.error }, stage, () => {
    if (getTask(taskId)?.state !== state) return; // stopped, or moved on, in the meantime
    background(taskId, 'Trying again', again);
  });
}

// ─── Budget ───────────────────────────────────────────────────────────────────

/** Where a task was when it reached a token limit, so it can go on from there. */
interface Stage {
  role: 'analyst' | 'planner' | 'coder' | 'tester' | 'api_tester' | 'ui_tester';
  round: number;
}

const CONTINUE_PROMPT =
  'You were stopped because you reached your token limit, and the owner has allowed more. Continue the task from where you stopped, then finish with your report.';
/**
 * The owner tried the change and says it does not do what they need. Their words reach the
 * Builder as "Notes from the owner" (fromTheOwner), so this only says what to do with them.
 */
const OWNER_REWORK_PROMPT =
  '# The owner tried the change and it does not do what they need\n\n' +
  'Their words are under "Notes from the owner". Find out why the change does not work for them and fix it in this same ' +
  'workspace. Check your earlier work against what they describe instead of assuming it was right. If part of what they ' +
  'need cannot be done in this repository (another service, the API the code calls, the backend), do the part that ' +
  'belongs here, and start your report by saying exactly what the other change is and which project it belongs in.';

const RETRY_PROMPT =
  'You were stopped because the AI service was briefly unavailable. Continue the task from where you stopped, then finish with your report.';

/** Pause the task and ask the owner whether to allow more tokens. */
function askToContinue(taskId: string, stage: Stage, requested: 'agent' | 'task'): void {
  const task = getTask(taskId)!;
  const used = taskTokensUsed(taskId);
  // An agent stopped because the task ran out of tokens is a task limit, whatever stopped it first.
  const why: 'agent' | 'task' = requested === 'task' || taskTokensLeft(taskId) <= 0 ? 'task' : 'agent';
  let summary: string;
  if (why === 'task') {
    summary = `${taskId} has used ${formatTokens(used)} of its ${formatTokens(taskTokenLimit(task))} tokens. Allow another ${formatTokens(getSettings().taskTokenLimit)}?`;
  } else {
    // Quote the limit the stopped run really had, not what Settings says now.
    const run = getDb()
      .prepare(`SELECT token_limit, error_msg FROM runs WHERE task_id = ? AND role = ? ORDER BY started_at DESC LIMIT 1`)
      .get(taskId, stage.role) as { token_limit: number | null; error_msg: string | null } | undefined;
    const who = `The ${ACTOR_NAME[actorOfRole(stage.role)]} on ${taskId}`;
    const rest = `(${formatTokens(used)} used on the task so far). Let it go on?`;
    if (run?.error_msg?.includes('safety limit')) summary = `${who} reached its safety limit ${rest}`;
    else {
      const limit = run?.token_limit ?? getSettings().roles[stage.role].tokenLimit;
      summary = `${who} reached its ${formatTokens(limit)}-token limit for one go ${rest}`;
    }
  }
  raiseTicket(taskId, 'continue_budget', { summary, stage, why, usedTokens: used }, null);
  handToOwner(taskId, `Paused at a token limit. ${summary}`);
}

/** The owner said yes: raise the task's token limit if that was the limit, and go on from the same stage. */
async function continueAfterBudget(ticket: ApprovalRow): Promise<void> {
  const taskId = ticket.task_id;
  const { stage, why } = JSON.parse(ticket.payload_json) as { stage: Stage; why: 'agent' | 'task' };
  const task = getTask(taskId);
  if (!task || task.state !== 'needs_owner') return;
  if (why === 'task' || taskTokensLeft(taskId) <= 0) {
    updateTaskMetadata(taskId, { tokenLimit: taskTokensUsed(taskId) + getSettings().taskTokenLimit });
  }
  if (stage.role === 'analyst') {
    setTaskState(taskId, 'intake', 'Continuing after the token limit');
    await runIntake(taskId);
  } else if (stage.role === 'planner') await startPlanner(taskId);
  else if (stage.role === 'coder') await startCoder(taskId, stage.round, CONTINUE_PROMPT);
  else if (isTesterRole(stage.role)) await verifyRound(verifyHost, taskId, stage.round);
  else await reviewRound(taskId, stage.round);
}

/**
 * Start an agent for a task, within the tokens the task may still use. Returns null, with a
 * ticket raised, when the task's tokens are already used up.
 */
async function startTaskAgent(taskId: string, stage: Stage, opts: RunOptions): Promise<RunHandle | null> {
  cancelPendingRetry(taskId); // a new start of a stage: an older retry's timer must not start another
  const left = taskTokensLeft(taskId);
  if (left <= 0) {
    askToContinue(taskId, stage, 'task');
    return null;
  }
  return startAgent({ ...opts, maxTokens: left });
}

/** Start an agent, waiting for a free slot rather than failing the task when all are busy. */
async function startAgent(opts: RunOptions): Promise<RunHandle> {
  for (;;) {
    try {
      return startRun(opts);
    } catch (err) {
      if (!(err instanceof CapacityError)) throw err;
      await new Promise((r) => setTimeout(r, SLOT_RETRY_MS));
    }
  }
}

function withGuidance(base: string, repo: Project | undefined, ws: WorkspaceRow): string {
  return guided(base, repo?.name ?? ws.repo_id, [ws.worktree_path, ws.repo_path]);
}

function guided(base: string, repoName: string, roots: string[]): string {
  const guidance = readGuidance(roots);
  return guidance ? `${base}\n\n# Repo guidance (${repoName})\n\n${guidance}` : base;
}

/** What the owner added to the task after writing it: notes in the thread and attached documents. */
function fromTheOwner(taskId: string, sinceMs = 0): string {
  const notes = ownerNotes(taskId, sinceMs);
  const task = getTask(taskId);
  // Long documents are cut to the parts that bear on the task (the Analyst read them whole).
  const documents = sinceMs === 0 ? documentsText(taskId, undefined, task ? `${task.title}\n${task.description}\n${parseBrief(task.brief_json)?.summary ?? ''}` : '') : '';
  return [
    notes.length ? `## Notes from the owner\n\n${notes.map((n) => `- ${n}`).join('\n')}` : '',
    documents,
  ].filter(Boolean).join('\n\n');
}

function planOf(task: TaskRow): Plan | null {
  return parsePlan(task.plan_json);
}

function planText(plan: Plan): string {
  const list = (items: string[]) => items.map((i) => `- ${i}`).join('\n');
  return [
    `## Plan\n\n${plan.summary}\n\n${plan.approach}`,
    `## Acceptance criteria\n\n${plan.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    plan.testPlan.length ? `## Test plan\n\n${list(plan.testPlan)}` : '',
    plan.files.length ? `## Files expected to change\n\n${list(plan.files)}` : '',
    plan.risks.length ? `## Risks to keep in mind\n\n${list(plan.risks)}` : '',
  ].filter(Boolean).join('\n\n');
}

// ─── Start ────────────────────────────────────────────────────────────────────

/** What intake has settled so far. Kept on the task, so a restart or an answer picks up from it. */
interface Intake {
  /** The project, once known. */
  repoId: string | null;
  /** An existing branch the owner asked to continue. */
  branch: string | null;
  /** What the Analyst is doing, or was doing last. */
  stage: 'triage' | 'brief';
  /** How many times the Analyst has come back with questions. */
  rounds: number;
  /** Branches the Analyst was shown; it may only name one of these. */
  candidates: string[];
  /** What the open questions are about. */
  waitingFor: 'project' | 'clarify' | 'branch' | 'split' | null;
}

function intakeOf(task: TaskRow): Intake {
  const stored = taskMetadata(task)['intake'] as Partial<Intake> | undefined;
  return { repoId: null, branch: null, stage: 'brief', rounds: 0, candidates: [], waitingFor: null, ...stored };
}
const saveIntake = (taskId: string, intake: Intake) => updateTaskMetadata(taskId, { intake });

const BRANCH_NAME = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const analysisCheckoutPath = (taskId: string, repoId: string) => path.join(getConfig().workspaceDir, taskId, `${repoId}.analysis`);
const triageFolder = (taskId: string) => path.join(getConfig().workspaceDir, taskId, '_which-project');

function usableProject(repoId: string): Project {
  const repo = getRepo(repoId);
  if (!repo) throw new StartError(`Unknown project ${repoId}`);
  if (!repo.verified) throw new StartError(`${repo.name} is not confirmed yet; confirm it on the Projects page first`);
  if (!fs.existsSync(path.join(repo.localPath, '.git'))) throw new StartError(`${repo.name} was not found at ${repo.localPath}`);
  try {
    git(repo.localPath, ['remote', 'get-url', 'origin']);
  } catch {
    throw new StartError(`${repo.name} at ${repo.localPath} has no "origin" remote; check its path on the Projects page`);
  }
  return repo;
}

export interface StartOptions {
  /** Continue on this existing remote branch instead of starting a new one. Needs a project. */
  branch?: string | null;
}

/**
 * Accept a task. With a project it goes straight to the Analyst's brief; without one the
 * Analyst first works out which project it is for. Throws StartError for anything the
 * owner can fix; the slow part continues in the background.
 */
export function startTask(taskId: string, repoId: string | null = null, opts: StartOptions = {}): void {
  const task = getTask(taskId);
  if (!task) throw new StartError(`Unknown task ${taskId}`);
  if (task.state !== 'queued') throw new StartError(`${taskId} is ${task.state}; only a queued task can be started`);
  const waiting = unmetDependencies(taskId, 'start');
  if (waiting.length) throw new StartError(`Not yet: ${waiting.map((w) => w.why).join('; ')}. Turn on auto-start and FryDay starts it then, or remove the dependency.`);
  const branch = opts.branch?.trim().replace(/^origin\//, '') || null;
  if (branch && !repoId) throw new StartError('Choose the project when you name a branch to continue');
  if (branch && !BRANCH_NAME.test(branch)) throw new StartError(`"${branch}" is not a branch name`);

  const repo = repoId ? usableProject(repoId) : null;
  if (!repo && !listRepos().some((r) => r.verified)) throw new StartError('Add and confirm a project first (Projects page)');
  saveIntake(taskId, { ...intakeOf(task), repoId: repo?.id ?? null, branch });
  setTaskState(taskId, 'intake', repo ? `Reading the task and ${repo.name}` : 'Working out which project this is for');
  background(taskId, 'Reading the task', () => runIntake(taskId));
}

// ─── Intake: the Analyst ──────────────────────────────────────────────────────

/** Do the next piece of intake for a task in "intake": choose the project if needed, else write the brief. */
async function runIntake(taskId: string): Promise<void> {
  const task = getTask(taskId)!;
  const intake = intakeOf(task);
  if (taskTokensLeft(taskId) <= 0) { askToContinue(taskId, { role: 'analyst', round: 0 }, 'task'); return; }
  if (!intake.repoId) {
    const projects = listRepos().filter((r) => r.verified);
    if (projects.length !== 1) { await startTriage(task, intake, projects); return; }
    intake.repoId = projects[0]!.id; // only one project: nothing to choose
    saveIntake(taskId, intake);
  }
  await startBrief(task, intake);
}

async function startTriage(task: TaskRow, intake: Intake, projects: Project[]): Promise<void> {
  const dir = triageFolder(task.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writeTaskFolder(dir, { taskId: task.id, title: task.title, description: task.description, questions: listQuestions(task.id), notes: ownerNotes(task.id), projects });
  saveIntake(task.id, { ...intake, stage: 'triage' });
  setTaskNote(task.id, 'Working out which project this is for');
  await startTaskAgent(task.id, { role: 'analyst', round: 0 }, {
    taskId: task.id,
    role: 'analyst',
    prompt: `Decide which project task ${task.id} is for. Start with ${TASK_FOLDER}/README.md.`,
    appendSystemPrompt: TRIAGE_PROMPT,
    jsonSchema: TRIAGE_SCHEMA,
    cwd: dir,
    workspacePath: dir,
  });
}

async function startBrief(task: TaskRow, intake: Intake): Promise<void> {
  const taskId = task.id;
  let repo: Project;
  try {
    repo = usableProject(intake.repoId!);
  } catch (err) {
    handToOwner(taskId, message(err));
    return;
  }
  setTaskNote(taskId, `Reading the task and ${repo.name}`);
  await fetchBranches(repo.localPath);
  if (intake.branch && !branchFacts(repo.localPath, repo.prodBranch, intake.branch)) {
    handToOwner(taskId, `The branch ${intake.branch} was not found on the remote of ${repo.name}. Create the task again with the right branch name, or without one.`);
    return;
  }
  // The Analyst sees the branches, but only as a list to pick from.
  const candidates = intake.branch ? [] : listCandidates(repo.localPath, repo.prodBranch, repo.stgBranch);
  const checkout = analysisCheckoutPath(taskId, repo.id);
  createCheckout(repo.localPath, checkout, git(repo.localPath, ['rev-parse', '--verify', `origin/${intake.branch ?? repo.prodBranch}^{commit}`]));
  writeTaskFolder(checkout, {
    taskId, title: task.title, description: task.description,
    questions: listQuestions(taskId), notes: ownerNotes(taskId), candidates, namedBranch: intake.branch,
    projectMap: projectMap(taskId, repo.id),
    lessons: lessonsFor(taskId, 'analyst', repo.id, { text: `${task.title}\n${task.description}` }),
  });
  saveIntake(taskId, { ...intake, stage: 'brief', candidates: candidates.map((c) => c.name) });
  await startTaskAgent(taskId, { role: 'analyst', round: 0 }, {
    taskId,
    role: 'analyst',
    prompt: `Analyse task ${taskId} for this repository. Start with ${TASK_FOLDER}/README.md.`,
    appendSystemPrompt: guided(ANALYST_PROMPT, repo.name, [checkout, repo.localPath]),
    jsonSchema: BRIEF_SCHEMA,
    cwd: checkout,
    workspacePath: checkout,
  });
}

/** Stop and wait for the owner. */
function waitForOwner(taskId: string, intake: Intake, waitingFor: NonNullable<Intake['waitingFor']>, note: string): void {
  saveIntake(taskId, { ...intake, waitingFor });
  setTaskState(taskId, 'waiting_owner', note);
}

function onAnalystExit(exit: RunExit, run: RunRow): void {
  const taskId = exit.taskId!;
  const task = getTask(taskId);
  if (!task || task.state !== 'intake') return;
  const intake = intakeOf(task);
  // The Analyst's folders are throwaway either way.
  if (intake.stage === 'triage') fs.rmSync(triageFolder(taskId), { recursive: true, force: true });
  else if (intake.repoId) {
    const repo = getRepo(intake.repoId);
    if (repo) removeCheckout(repo.localPath, analysisCheckoutPath(taskId, repo.id));
  }
  if (exit.state === 'budget') { askToContinue(taskId, { role: 'analyst', round: 0 }, 'agent'); return; }
  if (exit.state !== 'completed') {
    if (retryStage(exit, run, { role: 'analyst', job: intake.stage, round: intake.rounds }, 'intake', () => runIntake(taskId))) return;
    handToOwner(taskId, `The analyst ${exit.state === 'killed' ? 'was stopped' : 'failed'}${exit.error ? `: ${exit.error}` : ''}`);
    return;
  }
  if (intake.stage === 'triage') afterTriage(task, intake, run);
  else afterBrief(task, intake, run);
}

function afterTriage(task: TaskRow, intake: Intake, run: RunRow): void {
  const projects = listRepos().filter((r) => r.verified);
  const triage = parseTriage(run.output_json);
  const split = triage ? validSplit(triage.subtasks, projects.map((p) => p.id)) : null;
  if (triage && split) {
    // Kept until the owner answers: the split to make, or the single project to go on with.
    updateTaskMetadata(task.id, { proposedSplit: { ...triage, subtasks: split } });
    const name = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
    const parts = split.map((s, i) => `${i + 1}. ${name(s.projectId)}: ${s.title}${s.dependsOn.length ? ` (after ${s.dependsOn.map((d) => d + 1).join(', ')}${s.gate === 'release' ? ' reaches staging' : ''})` : ''}`).join('\n');
    askQuestions(task.id, 'analyst', [{
      kind: 'split',
      question: `This needs changes in ${new Set(split.map((s) => s.projectId)).size} projects. Split it into ${split.length} tasks?`,
      why: `${triage.reason}\n${parts}`,
      options: [{ value: 'accept', label: `Split into ${split.length} tasks` }, { value: 'single', label: 'Keep it as one task' }],
    }]);
    waitForOwner(task.id, intake, 'split', 'This task spans several projects. Answer on the task to go on.');
    return;
  }
  chooseTriagedProject(task, intake, triage, projects);
}

/** Go on with the project the Analyst is sure of, or ask the owner which one. */
function chooseTriagedProject(task: TaskRow, intake: Intake, triage: Triage | null, projects: Project[]): void {
  const guess = triage ? projects.find((p) => p.id === triage.projectId) : undefined;
  if (triage?.confidence === 'sure' && guess) {
    saveIntake(task.id, { ...intake, repoId: guess.id });
    addMessage(task.id, 'analyst', 'event', `This is for ${guess.name}. ${triage.reason}`);
    background(task.id, 'Reading the task', () => runIntake(task.id));
    return;
  }
  askQuestions(task.id, 'analyst', [{
    kind: 'project',
    question: 'Which project is this task for?',
    why: guess ? `My guess is ${guess.name}, but I am not sure: ${triage!.reason}` : triage?.reason || 'I could not tell from the task.',
    options: projects.map((p) => ({ value: p.id, label: p.name })),
  }]);
  waitForOwner(task.id, intake, 'project', 'Which project is this for? Answer on the task to go on.');
}

function afterBrief(task: TaskRow, intake: Intake, run: RunRow): void {
  const taskId = task.id;
  const brief = parseBrief(run.output_json);
  if (!brief) {
    handToOwner(taskId, 'The analyst did not return a usable brief');
    return;
  }
  getDb().prepare('UPDATE tasks SET brief_json = ? WHERE id = ?').run(JSON.stringify(brief), taskId);
  sseEmit({ type: 'brief_ready', taskId });
  addMessage(taskId, 'analyst', 'event', brief.summary);

  if (brief.questions.length > 0 && intake.rounds < MAX_QUESTION_ROUNDS) {
    askQuestions(taskId, 'analyst', brief.questions.map((q) => ({
      kind: 'clarify' as const, question: q.question, why: q.why, options: q.options.map((o) => ({ value: o, label: o })),
    })));
    const n = brief.questions.length;
    waitForOwner(taskId, { ...intake, rounds: intake.rounds + 1 }, 'clarify', `${n} question${n === 1 ? '' : 's'} for you before any code is written.`);
    return;
  }
  chooseBranch(taskId, intake, brief);
}

/** Decide where the work starts from: the branch the owner named, one the owner agrees to continue, or production. */
function chooseBranch(taskId: string, intake: Intake, brief: Brief): void {
  const repo = getRepo(intake.repoId!)!;
  if (intake.branch) { beginWork(taskId, repo, intake.branch); return; }

  const facts = brief.continueOn && intake.candidates.includes(brief.continueOn) ? branchFacts(repo.localPath, repo.prodBranch, brief.continueOn) : null;
  if (!facts || facts.ahead === 0) { beginWork(taskId, repo, null); return; }
  const whose = facts.owned
    ? 'All of its commits are yours, so the work can be pushed back to it when you approve.'
    : `${facts.byOthers} of its ${facts.ahead} commits are by someone else, so FryDay will work on its own branch cut from it and will not push to ${facts.name}.`;
  askQuestions(taskId, 'fryday', [{
    kind: 'branch',
    question: `Continue on the existing branch ${facts.name}?`,
    why: `${brief.continueWhy.trim() || 'It looks like work on this task.'} ${whose}`,
    options: [
      { value: `continue:${facts.name}`, label: `Continue on ${facts.name}` },
      { value: 'fresh', label: `Start a new branch from ${repo.prodBranch}` },
    ],
  }]);
  waitForOwner(taskId, intake, 'branch', `There is already a branch that looks like this task (${facts.name}). Continue on it?`);
}

/**
 * Call after the owner answered a question. When none is left open the task goes on from
 * where it stopped. Returns false when it is still waiting.
 */
export function ownerAnswered(taskId: string): boolean {
  const task = getTask(taskId);
  if (!task || task.state !== 'waiting_owner' || openQuestions(taskId).length > 0) return false;
  const intake = intakeOf(task);
  const lastAnswer = (kind: string) => listQuestions(taskId).filter((q) => q.kind === kind && q.answer !== null).at(-1)?.answer ?? null;
  const waitingFor = intake.waitingFor;
  saveIntake(taskId, { ...intake, waitingFor: null });

  if (waitingFor === 'split') {
    const proposed = taskMetadata(task)['proposedSplit'] as Triage | undefined;
    const projects = listRepos().filter((r) => r.verified);
    const split = proposed ? validSplit(proposed.subtasks, projects.map((p) => p.id)) : null;
    if (lastAnswer('split') === 'accept' && split) {
      splitIntoSubtasks(taskId, split);
      return true;
    }
    setTaskState(taskId, 'intake', 'Keeping it as one task');
    chooseTriagedProject(getTask(taskId)!, intakeOf(getTask(taskId)!), proposed ?? null, projects);
  } else if (waitingFor === 'project') {
    const chosen = lastAnswer('project');
    const repo = chosen ? getRepo(chosen) : undefined;
    if (!repo?.verified) { handToOwner(taskId, 'The chosen project is not available any more'); return true; }
    saveIntake(taskId, { ...intake, waitingFor: null, repoId: repo.id });
    setTaskState(taskId, 'intake', `Reading the task and ${repo.name}`);
    background(taskId, 'Reading the task', () => runIntake(taskId));
  } else if (waitingFor === 'branch') {
    const answer = lastAnswer('branch') ?? 'fresh';
    const repo = getRepo(intake.repoId!)!;
    beginWork(taskId, repo, answer.startsWith('continue:') ? answer.slice('continue:'.length) : null);
  } else {
    setTaskState(taskId, 'intake', 'Reading your answers');
    background(taskId, 'Reading the task', () => runIntake(taskId));
  }
  return true;
}

// ─── Workspace ────────────────────────────────────────────────────────────────

/** Cut the task's workspace — from production, or from the tip of the branch it continues — and start planning. */
function beginWork(taskId: string, repo: Project, continueBranch: string | null): void {
  const task = getTask(taskId)!;
  setTaskState(taskId, 'workspace', continueBranch ? `Setting up a workspace on top of ${continueBranch}` : `Setting up a workspace in ${repo.name}`);
  // While the team works: find the project's Jenkins job if it has none, so the one approval at
  // the end can carry the change all the way to the staging server.
  void prepareDeployer(taskId, repo.id);
  background(taskId, 'Workspace setup', async () => {
    if (continueBranch && !(await existsOnRemote(repo.localPath, continueBranch))) {
      handToOwner(taskId, `The branch ${continueBranch} is not on the remote any more. Create the task again to start from ${repo.prodBranch}.`);
      return;
    }
    const ws = await createWorkspace({
      taskId,
      repo: { id: repo.id, localPath: repo.localPath, prodBranch: repo.prodBranch },
      branch: branchName(taskId, task.title),
      worktreesRoot: getConfig().workspaceDir,
      baseBranch: continueBranch ?? undefined,
    });
    const target = continueBranch ? branchFacts(repo.localPath, repo.prodBranch, continueBranch) : null;
    saveWorkspace(ws, target ? { targetBranch: target.name, forkSha: target.forkSha, owned: target.owned } : undefined);
    const deps = await depsForCheckout({ repoId: repo.id, taskId, ownerRepoPath: ws.repoPath }, ws.worktreePath, false);
    if (!depsUsable(deps) && checkSpecs(repo).length > 0) {
      // Without dependencies every check fails the same way on the task and on its base, which would look like "nothing new broke".
      handToOwner(taskId, `${repo.name} has no usable dependencies, so its checks cannot be run: ${deps.detail}\n\nSet a working install command on the Projects page (or install in your own clone), then create the task again.`);
      return;
    }
    sseEmit({ type: 'workspace_ready', taskId, repoId: repo.id, branch: ws.branch });
    // The workspace fetched production: if it moved, the project map is rebuilt before the Planner reads it.
    await refreshWithin(repo.id, 20_000);
    await startPlanner(taskId);
  });
}

// ─── Planning ─────────────────────────────────────────────────────────────────

/** For a task that continues a branch: what is already there. */
function existingWork(ws: WorkspaceRow): string {
  if (!ws.target_branch || !ws.fork_sha) return '';
  let commits = '';
  try {
    commits = git(ws.repo_path, ['log', '--format=- %h %s', '--max-count=40', `${ws.fork_sha}..${ws.base_sha}`]);
  } catch {
    /* the list is a help, not a need */
  }
  return `## Existing work\n\nThis task continues the branch \`${ws.target_branch}\`, and you are looking at its code. It already has these commits on top of production:\n\n${commits || '(none listed)'}\n\nPlan only what is still missing. Do not redo or undo what is there unless the task needs it.`;
}

/**
 * Where the Planner reads the code. On Claude Code that is the task's workspace, held
 * read-only by the guard. Cursor has no per-run guard, so it gets a throwaway checkout of
 * the same commit: whatever it might change there is thrown away when it exits.
 */
const plannerCheckoutPath = (ws: WorkspaceRow) => `${ws.worktree_path}.plan`;

function plannerFolder(ws: WorkspaceRow): string {
  if (runSettingsFor('planner').engine !== 'cursor') return ws.worktree_path;
  const dir = plannerCheckoutPath(ws);
  createCheckout(ws.repo_path, dir, ws.base_sha);
  return dir;
}

function removePlannerCheckout(taskId: string): void {
  const ws = activeWorkspace(taskId);
  if (ws) removeCheckout(ws.repo_path, plannerCheckoutPath(ws));
}

async function startPlanner(taskId: string): Promise<void> {
  const task = getTask(taskId)!;
  const ws = activeWorkspace(taskId)!;
  if (taskTokensLeft(taskId) <= 0) { askToContinue(taskId, { role: 'planner', round: 0 }, 'task'); return; }
  const brief = parseBrief(task.brief_json);
  enterState(taskId, 'planning', 'Planning the change');
  const folder = plannerFolder(ws);
  try {
    await startPlannerRun(taskId, task, ws, brief, folder);
  } catch (err) {
    if (folder !== ws.worktree_path) removeCheckout(ws.repo_path, folder);
    throw err;
  }
}

async function startPlannerRun(taskId: string, task: TaskRow, ws: WorkspaceRow, brief: Brief | null, folder: string): Promise<void> {
  // Code the task is about, found by searching the project, so the Planner reads less to plan.
  const about = [task.title, task.description, brief?.summary ?? '', ...(brief?.areas ?? [])].join('\n');
  const code = await codePackFor(taskId, ws, 'planner', about);
  const past = await similarTasks(taskId, ws.repo_id, about);
  const run = await startTaskAgent(taskId, { role: 'planner', round: 0 }, {
    taskId,
    role: 'planner',
    prompt: [
      `Task ${task.id}: ${task.title}\n\n${task.description}`,
      brief ? briefText(brief, listQuestions(taskId)) : '',
      fromTheOwner(taskId),
      existingWork(ws),
      projectMap(taskId, ws.repo_id),
      code,
      past,
      lessonsFor(taskId, 'planner', ws.repo_id, { text: `${task.title}\n${task.description}`, areas: brief?.areas }),
    ].filter(Boolean).join('\n\n'),
    appendSystemPrompt: withGuidance(PLANNER_PROMPT, getRepo(ws.repo_id), ws),
    jsonSchema: PLAN_SCHEMA,
    cwd: folder,
    workspacePath: folder,
  });
  if (!run && folder !== ws.worktree_path) removeCheckout(ws.repo_path, folder);
}

function onPlannerExit(exit: RunExit, run: RunRow): void {
  const taskId = exit.taskId!;
  removePlannerCheckout(taskId);
  if (getTask(taskId)?.state !== 'planning') return;
  if (exit.state === 'budget') { askToContinue(taskId, { role: 'planner', round: 0 }, 'agent'); return; }
  if (exit.state !== 'completed') {
    if (retryStage(exit, run, { role: 'planner', round: 0 }, 'planning', () => startPlanner(taskId))) return;
    handToOwner(taskId, `The planner ${exit.state === 'killed' ? 'was stopped' : 'failed'}${exit.error ? `: ${exit.error}` : ''}`);
    return;
  }
  const plan = parsePlan(run.output_json);
  if (!plan) {
    handToOwner(taskId, 'The planner did not return a usable plan');
    return;
  }
  getDb().prepare('UPDATE tasks SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan), taskId);
  nudgeAboutPageTester(taskId, plan);
  sseEmit({ type: 'plan_ready', taskId });
  background(taskId, 'Starting the coder', () => startCoder(taskId, 1, null));
}

// ─── Coding ───────────────────────────────────────────────────────────────────

const PAGE_FILE = /\.(tsx|jsx|vue|svelte|html?|css|scss|sass|less)$/i;

/**
 * A change to pages in a project where FryDay cannot open them: say so once, with what would let
 * it check the pages on a phone, a tablet and a desktop. Nothing is changed for the owner.
 */
function nudgeAboutPageTester(taskId: string, plan: Plan): void {
  const ws = activeWorkspace(taskId);
  const repo = ws ? getRepo(ws.repo_id) : undefined;
  if (!repo || !plan.files.some((f) => PAGE_FILE.test(f))) return;
  const profile = runProfileOf(repo);
  if (profile?.ui) return;
  const task = getTask(taskId)!;
  if (taskMetadata(task)['pageTesterNudged']) return;
  updateTaskMetadata(taskId, { pageTesterNudged: true });
  addMessage(taskId, 'fryday', 'reply', profile
    ? `This change touches pages of ${repo.name}, but its Page tester is off, so nobody will open them in a browser. Turn it on in ${repo.name}'s run profile on the Projects page and I will also check them on a phone, a tablet and a desktop.`
    : `This change touches pages of ${repo.name}, but ${repo.name} has no run profile, so I cannot start it to look at them. Add one on the Projects page (how to start it, its port, and the Page tester on) and I will try the pages in a browser and check them on a phone, a tablet and a desktop.`);
}

/** How long after a Builder run its prompt cache is still warm enough to resume it cheaply. */
const WARM_RESUME_MS = 4 * 60_000;
const REPORT_CHARS = 2500;
const ROUND_DIFF_CHARS = 14_000;

interface CoderRun { session_id: string | null; round: number; started_at: number; ended_at: number | null; result_text: string | null }

/**
 * Where a later round starts from, instead of the whole earlier conversation: the task, the plan,
 * what the Builder reported, what the branch already changes, the feedback, and the code around
 * it. A resumed conversation grows every round and is written to the cache again on a model
 * switch; this stays about the same size.
 */
async function roundPacket(task: TaskRow, ws: WorkspaceRow, plan: Plan | null, round: number, feedback: string, last: CoderRun | undefined): Promise<string> {
  let diff = '';
  try {
    diff = budgetedDiff(diffPatch(ws.worktree_path, ws.base_sha), ROUND_DIFF_CHARS, `${feedback}\n${plan?.criteria.join('\n') ?? ''}`).text;
  } catch {
    /* no commit yet: the Builder starts from the plan */
  }
  const files = ws.files_json ? (JSON.parse(ws.files_json) as Array<{ path: string }>).map((f) => f.path) : [];
  const report = last?.result_text ? last.result_text.slice(0, REPORT_CHARS) + (last.result_text.length > REPORT_CHARS ? ' […]' : '') : '';
  const code = await codePackFor(task.id, ws, 'coder_round', `${feedback}\n${plan?.criteria.join('\n') ?? task.title}`, [...files, ...(plan?.files ?? [])]);
  return [
    `Task ${task.id}: ${task.title}\n\n${task.description}`,
    plan ? planText(plan) : '',
    fromTheOwner(task.id),
    `# Round ${round}: you are fixing your own earlier work\n\nThis is a fresh start for you: your earlier conversation is not here, but your work is, in this workspace (the files as you left them). Below is what you reported last time, what the branch changes so far, and what has to be fixed.`,
    report ? `## What you reported last round\n\n${report}` : '',
    diff ? `## What the branch changes so far\n\n\`\`\`diff\n${diff}\n\`\`\`` : '',
    `# Review feedback on the work so far\n\n${feedback}`,
    code,
  ].filter(Boolean).join('\n\n');
}

async function startCoder(taskId: string, round: number, feedback: string | null): Promise<void> {
  const task = getTask(taskId)!;
  const ws = activeWorkspace(taskId)!;
  const plan = planOf(task);

  const previous = getDb()
    .prepare(`SELECT session_id, round, started_at, ended_at, result_text FROM runs WHERE task_id = ? AND role = 'coder' AND session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1`)
    .get(taskId) as CoderRun | undefined;
  // Resumed only to finish a run that was cut off a moment ago on the same model: then the
  // conversation is still in the prompt cache. Every other later round starts fresh from a packet.
  const interrupted = feedback === CONTINUE_PROMPT || feedback === RETRY_PROMPT;
  const warm = !!previous?.session_id && previous.ended_at !== null && Date.now() - previous.ended_at < WARM_RESUME_MS
    // The model this round gets is the one the cut-off run had (no escalation in between).
    && runSettingsFor('coder', previous.round).model === runSettingsFor('coder', round).model;
  const resume = interrupted && warm ? previous!.session_id! : undefined;

  if (taskTokensLeft(taskId) <= 0) { askToContinue(taskId, { role: 'coder', round }, 'task'); return; }
  const continuing = feedback === CONTINUE_PROMPT;
  enterState(taskId, 'coding', continuing ? `Round ${round}: continuing after the token limit` : feedback === RETRY_PROMPT ? `Round ${round}: trying again after the AI service was busy` : feedback?.startsWith(OWNER_REWORK_PROMPT) ? `Round ${round}: fixing what you found` : round === 1 ? `Coding on ${ws.branch}` : `Round ${round}: fixing what the review found`);

  let prompt: string;
  if (resume) {
    // What the owner said since the coder last started is new to it.
    const said = fromTheOwner(taskId, previous!.started_at);
    prompt = said ? `${feedback}\n\n${said}` : feedback!;
  } else if (feedback === null) {
    const code = await codePackFor(taskId, ws, 'coder', [plan?.summary ?? task.title, plan?.approach ?? task.description, ...(plan?.criteria ?? [])].join('\n'), plan?.files ?? []);
    prompt = [
      `Task ${task.id}: ${task.title}\n\n${task.description}`, plan ? planText(plan) : '', fromTheOwner(taskId), existingWork(ws), projectMap(taskId, ws.repo_id), code,
      lessonsFor(taskId, 'coder', ws.repo_id, { text: `${task.title}\n${task.description}`, areas: parseBrief(task.brief_json)?.areas, files: plan?.files }),
    ].filter(Boolean).join('\n\n');
  } else {
    prompt = await roundPacket(task, ws, plan, round, feedback, previous);
  }
  if (getTask(taskId)?.state !== 'coding') return; // stopped while the packet was being put together
  await startTaskAgent(taskId, { role: 'coder', round }, {
    taskId,
    role: 'coder',
    round,
    prompt,
    appendSystemPrompt: withGuidance(CODER_PROMPT, getRepo(ws.repo_id), ws),
    resumeSessionId: resume,
    cwd: ws.worktree_path,
    workspacePath: ws.worktree_path,
  });
}

function onCoderExit(exit: RunExit, run: RunRow): void {
  const taskId = exit.taskId!;
  const task = getTask(taskId);
  if (!task || task.state !== 'coding') return;
  const ws = activeWorkspace(taskId);
  if (!ws || !fs.existsSync(ws.worktree_path)) {
    failTask(taskId, 'The task workspace is missing');
    return;
  }
  try {
    recordChanges(task, ws, `Coded by the Fryday coder agent (${exit.runId}), round ${run.round}.`);
  } catch (err) {
    handToOwner(taskId, `Could not record the changes: ${message(err)}`);
    return;
  }
  if (exit.state === 'budget') { askToContinue(taskId, { role: 'coder', round: Math.max(run.round, 1) }, 'agent'); return; }
  if (exit.state !== 'completed') {
    const round = Math.max(run.round, 1);
    if (retryStage(exit, run, { role: 'coder', round }, 'coding', () => retryCoder(taskId, round, run))) return;
    handToOwner(taskId, `The coder ${exit.state === 'killed' ? 'was stopped' : 'failed'}${exit.error ? `: ${exit.error}` : ''}`);
    return;
  }
  background(taskId, 'Review', () => reviewRound(taskId, Math.max(run.round, 1)));
}

/**
 * The coder's run failed because the AI service was busy. Its work so far is committed; it
 * continues its own conversation when it had one, else the round starts again as it began.
 */
async function retryCoder(taskId: string, round: number, failed: RunRow): Promise<void> {
  if (failed.session_id) { await startCoder(taskId, round, RETRY_PROMPT); return; }
  await startCoder(taskId, round, round > 1 ? getRound(taskId, round - 1)?.feedback ?? null : null);
}

/** Commit whatever is in the workspace and store what the branch now changes. */
function recordChanges(task: TaskRow, ws: WorkspaceRow, trailer: string): { headSha: string; files: Array<{ status: string; path: string }> } {
  commitAll(ws.worktree_path, `fryday(${task.id}): ${task.title}\n\n${trailer}`);
  const summary = summarizeChanges(ws.worktree_path, ws.base_sha);
  getDb()
    .prepare('UPDATE task_workspaces SET head_sha = ?, files_json = ? WHERE task_id = ? AND repo_id = ?')
    .run(summary.headSha, JSON.stringify(summary.files), task.id, ws.repo_id);
  return summary;
}

// ─── Review: checks, diff flags, then the tester ──────────────────────────────

/**
 * Review the task branch as it stands. Also the entry point when a commit was put on
 * the branch by something other than the coder.
 */
export async function reviewRound(taskId: string, round: number): Promise<void> {
  const cfg = getConfig();
  const task = getTask(taskId)!;
  const ws = activeWorkspace(taskId)!;
  const repo = getRepo(ws.repo_id);
  if (task.state !== 'testing') setTaskState(taskId, 'testing', `Round ${round}: running checks`);

  const { headSha, files } = recordChanges(task, ws, `Recorded by Fryday before review, round ${round}.`);
  if (files.length === 0) {
    handToOwner(taskId, 'The coder finished without changing any file');
    return;
  }

  const packageJson: Record<string, { before: string | null; after: string | null }> = {};
  for (const f of files.filter((x) => /(^|\/)package\.json$/.test(x.path))) {
    packageJson[f.path] = { before: fileAt(ws.repo_path, ws.base_sha, f.path), after: fileAt(ws.worktree_path, 'HEAD', f.path) };
  }
  const flags = analyzeDiff({ files, patch: diffPatch(ws.worktree_path, ws.base_sha, 0), packageJson });

  // Checks run on a clean checkout of the commit, with freshly cloned dependencies, so
  // nothing left in the coder's folder (a patched node_modules, say) can affect them.
  const checkout = reviewCheckoutPath(ws);
  createCheckout(ws.repo_path, checkout, headSha);
  const deps = await depsForCheckout(ownerOf(ws), checkout, true);
  fs.mkdirSync(cfg.scratchDir, { recursive: true });
  const specs = repo ? checkSpecs(repo) : [];
  const checks = !depsUsable(deps)
    ? specs.map((spec) => cannotRun(spec, `Dependencies are not available in the review checkout: ${deps.detail}`))
    : await runChecks({
        specs,
        workspacePath: checkout,
        scratchRoot: cfg.scratchDir,
        timeoutMs: cfg.checkTimeoutMs,
        memoryWaitMs: cfg.memoryWaitMs,
        baseline: (spec) => baselineCheck(ws, spec),
      });
  saveGate(taskId, round, headSha, checks, flags);
  sseEmit({ type: 'round_updated', taskId, round });

  // A check that could not be run is not the coder's fault and another round will not fix it.
  const broken = checks.filter((c) => c.status === 'error');
  if (broken.length > 0) {
    removeCheckout(ws.repo_path, checkout);
    saveOutcome(taskId, round, 'escalated', null);
    sseEmit({ type: 'round_updated', taskId, round });
    handToOwner(taskId, `The ${broken.map((c) => c.name).join(', ')} check could not be run. Nothing was judged; see the round for the reason.`);
    return;
  }
  if (gateBlocks(checks, flags)) {
    removeCheckout(ws.repo_path, checkout);
    requestChanges(taskId, round, checks, flags, null);
    return;
  }

  // The last round the Checker itself judged: this round is a re-check of what it found there.
  const judged = getRounds(taskId).filter((r) => r.round < round && r.verdict && r.headSha).at(-1);
  let lastReview: { round: number; verdict: Verdict; patchSince: string } | null = null;
  if (judged) {
    try {
      lastReview = { round: judged.round, verdict: judged.verdict!, patchSince: git(ws.worktree_path, ['diff', '-U3', `${judged.headSha}..HEAD`]) };
    } catch {
      lastReview = null; // that commit is gone (the branch was rebuilt): review the whole change
    }
  }
  writeReviewBrief(checkout, {
    taskId, title: task.title, description: task.description, round, plan: planOf(task), checks, flags,
    depsNote: deps.detail, patch: diffPatch(ws.worktree_path, ws.base_sha), ownerNotes: fromTheOwner(taskId),
    // What testers observed on the running service is a fact the coder acted on; the reviewer of a
    // later round gets it too, so both judge from the same facts. Earlier check results are not
    // passed on: the checks above are run again on this commit and are the only ones that count.
    earlier: getRounds(taskId).filter((r) => r.round < round && r.feedback && r.verify?.status === 'failed').slice(-2).map((r) => ({ round: r.round, feedback: r.feedback! })),
    lessons: lessonsFor(taskId, 'tester', ws.repo_id, { text: `${task.title}\n${task.description}`, areas: parseBrief(task.brief_json)?.areas, files: planOf(task)?.files }),
    lastReview,
  });
  if (taskTokensLeft(taskId) <= 0) {
    removeCheckout(ws.repo_path, checkout);
    askToContinue(taskId, { role: 'tester', round }, 'task');
    return;
  }
  setTaskNote(taskId, `Round ${round}: checks are clean; the tester is reviewing`);
  await startTaskAgent(taskId, { role: 'tester', round }, {
    taskId,
    role: 'tester',
    round,
    prompt: `Review round ${round} of task ${task.id}. Your brief is in FRYDAY_REVIEW/README.md.`,
    appendSystemPrompt: withGuidance(TESTER_PROMPT, repo, ws),
    // Confirming fixes to its own findings needs less than a first review: a cheaper model, when set.
    ...(lastReview && getSettings().recheckModel && !process.env.FRYDAY_MODEL ? { model: getSettings().recheckModel! } : {}),
    jsonSchema: VERDICT_SCHEMA,
    cwd: checkout,
    workspacePath: checkout,
  });
}

/** The same check on the task's base commit, run once and remembered. */
async function baselineCheck(ws: WorkspaceRow, spec: CheckSpec): Promise<CheckResult> {
  const row = getDb().prepare('SELECT baseline_json FROM task_workspaces WHERE task_id = ? AND repo_id = ?').get(ws.task_id, ws.repo_id) as { baseline_json: string | null };
  const cache = row.baseline_json ? (JSON.parse(row.baseline_json) as Record<string, CheckResult>) : {};
  const cached = cache[spec.name];
  if (cached && cached.cmd === spec.cmd) return cached;

  const cfg = getConfig();
  const checkout = baseCheckoutPath(ws);
  createCheckout(ws.repo_path, checkout, ws.base_sha);
  try {
    const deps = await depsForCheckout(ownerOf(ws), checkout, false);
    if (!depsUsable(deps)) return cannotRun(spec, `Dependencies are not available for the base commit: ${deps.detail}`);
    const result = await runCheck(spec, { workspacePath: checkout, scratchRoot: cfg.scratchDir, timeoutMs: cfg.checkTimeoutMs, memoryWaitMs: cfg.memoryWaitMs });
    cache[spec.name] = { ...result, output: result.output.slice(-2000) }; // failures are kept in full for the comparison
    getDb().prepare('UPDATE task_workspaces SET baseline_json = ? WHERE task_id = ? AND repo_id = ?').run(JSON.stringify(cache), ws.task_id, ws.repo_id);
    return result;
  } finally {
    removeCheckout(ws.repo_path, checkout);
  }
}

function onTesterExit(exit: RunExit, run: RunRow): void {
  const taskId = exit.taskId!;
  const task = getTask(taskId);
  const ws = activeWorkspace(taskId);
  if (ws) removeCheckout(ws.repo_path, reviewCheckoutPath(ws));
  if (!task || task.state !== 'testing') return;

  const round = getRound(taskId, run.round);
  if (!round) {
    handToOwner(taskId, 'The tester finished but its review round was not found');
    return;
  }
  if (exit.state === 'budget') { askToContinue(taskId, { role: 'tester', round: run.round }, 'agent'); return; }
  if (exit.state !== 'completed') {
    if (retryStage(exit, run, { role: 'tester', round: run.round }, 'testing', () => reviewRound(taskId, run.round))) return;
    handToOwner(taskId, `The tester ${exit.state === 'killed' ? 'was stopped' : 'failed'}${exit.error ? `: ${exit.error}` : ''}`);
    return;
  }
  const verdict = parseVerdict(run.output_json);
  if (!verdict) {
    handToOwner(taskId, 'The tester did not return a verdict');
    return;
  }
  saveVerdict(taskId, run.round, verdict);
  const selfCheck = recordSelfCheck(taskId, run.round, planOf(task)?.criteria ?? [], verdict);

  if (verdictPasses(verdict)) {
    sseEmit({ type: 'round_updated', taskId, round: run.round });
    // A project that can be run is also tried out running before the owner is asked.
    if (ws && runProfileOf(getRepo(ws.repo_id))) {
      background(taskId, 'Verification', () => verifyRound(verifyHost, taskId, run.round));
      return;
    }
    approveRound(taskId, run.round, null);
    return;
  }
  requestChanges(taskId, run.round, round.checks, round.flags, verdict, selfCheck?.calibration ?? null);
}

/** The coder's report for this round, read for its self-check and compared with the tester's verdict. */
function recordSelfCheck(taskId: string, round: number, criteria: string[], verdict: Verdict): SelfCheck | null {
  const report = (getDb()
    .prepare(`SELECT result_text FROM runs WHERE task_id = ? AND role = 'coder' AND round = ? AND state = 'completed' ORDER BY started_at DESC LIMIT 1`)
    .get(taskId, round) as { result_text: string | null } | undefined)?.result_text ?? null;
  const claims = parseSelfCheck(report, criteria.length);
  if (claims.length === 0) return null;
  const selfCheck: SelfCheck = { claims, calibration: calibrate(criteria, claims, verdict) };
  saveSelfCheck(taskId, round, selfCheck);
  return selfCheck;
}

/** Everything the round had to pass, it passed: ask the owner for the next step. */
function approveRound(taskId: string, round: number, verified: string | null): void {
  const stored = getRound(taskId, round);
  saveOutcome(taskId, round, 'passed', null);
  const reviewFlags = stored?.flags.filter((f) => f.severity === 'review').length ?? 0;
  const passed =
    `Passed checks and review in ${round} round${round === 1 ? '' : 's'}` +
    (verified ? `, and ${verified}` : '') +
    (reviewFlags ? `; ${reviewFlags} change${reviewFlags === 1 ? '' : 's'} flagged for your attention` : '');
  setTaskState(taskId, 'awaiting_approval', `${passed}.`);
  setTaskNote(taskId, `${passed}. ${requestNextApproval(taskId)}`);
  sseEmit({ type: 'round_updated', taskId, round });
  rememberTask(taskId);
  kickEmbedding();
}

/** Send the round back to the coder, or to the owner once the round limit is reached. */
function requestChanges(taskId: string, round: number, checks: CheckResult[], flags: DiffFlag[], verdict: Verdict | null, calibration: Calibration | null = null): void {
  sendBack(taskId, round, coderFeedback(round, checks, flags, verdict, calibration), roundSummary(checks, flags, verdict));
}

function sendBack(taskId: string, round: number, feedback: string, summary: string): void {
  const maxRounds = getSettings().maxRounds;

  if (round >= maxRounds) {
    saveOutcome(taskId, round, 'escalated', feedback);
    sseEmit({ type: 'round_updated', taskId, round });
    handToOwner(taskId, `Still not passing after ${round} round${round === 1 ? '' : 's'} — ${summary}`);
    return;
  }
  saveOutcome(taskId, round, 'changes_requested', feedback);
  sseEmit({ type: 'round_updated', taskId, round });
  background(taskId, 'Starting the next coder round', () => startCoder(taskId, round + 1, feedback));
}

// ─── The owner decides on a task that ran out of rounds ───────────────────────

export { StoppedError, stoppedChoices, canStop, canSendBack, type StoppedChoices } from './stopped.js';

/** One more Builder round on a stopped task. The Builder and Checker read what the owner wrote. */
export async function tryAgainAfterStop(taskId: string): Promise<void> {
  if (!stoppedChoices(taskId).tryAgain) throw new StoppedError(409, `${taskId} is not waiting for you to try again`);
  const last = getRounds(taskId).at(-1)!;
  addMessage(taskId, 'fryday', 'event', 'You asked the team to try again.');
  await startCoder(taskId, last.round + 1, last.feedback);
}

const expireOpenTickets = (taskId: string) =>
  getDb().prepare(`UPDATE approvals SET state = 'expired', resolved_at = ? WHERE task_id = ? AND state = 'pending'`).run(Date.now(), taskId);

/**
 * The owner stops the task: agents are stopped, open questions for them are withdrawn, and a
 * deploy being followed is let go of. Nothing is undone: what was committed stays on the branch,
 * and a build already running in Jenkins is the owner's to stop there.
 */
export async function stopTask(taskId: string): Promise<void> {
  if (!canStop(taskId)) throw new StoppedError(409, `${taskId} has nothing to stop right now`);
  if (getTask(taskId)!.kind === 'initiative') { await stopInitiative(taskId); return; }
  const note = 'You stopped the task. Nothing more runs until you send it back to the team.';
  cancelPendingRetry(taskId);
  stopFollowingTask(taskId, 'You stopped following the deploy. Nothing was cancelled in Jenkins.');
  // The state goes first, so an agent that exits because it was stopped finds the task no
  // longer in its stage and does not hand it over a second time.
  const state = getTask(taskId)!.state;
  if (state !== 'needs_owner' && canTransition(state, 'needs_owner')) setTaskState(taskId, 'needs_owner', note);
  else if (state === 'queued') setTaskState(taskId, 'failed', note);
  else setTaskNote(taskId, note);
  expireOpenTickets(taskId);
  const running = getDb().prepare(`SELECT id FROM runs WHERE task_id = ? AND state = 'running'`).all(taskId) as Array<{ id: string }>;
  for (const r of running) killRun(r.id);
  await stopTaskWork(taskId);
  addMessage(taskId, 'fryday', 'event', note);
  // A task that went to failed was handled by the state change; one waiting for the owner is reflected on here.
  if (getTask(taskId)!.state === 'needs_owner') taskEnded(taskId, 'stopped');
  sseEmit({ type: 'task_updated', taskId });
}

/** Stop every sub-task that can be stopped (one being merged is left to finish), then end the initiative. */
async function stopInitiative(taskId: string): Promise<void> {
  const parts = getDb().prepare('SELECT id FROM tasks WHERE parent_id = ?').all(taskId) as Array<{ id: string }>;
  getDb().prepare('UPDATE tasks SET auto_start = 0 WHERE parent_id = ?').run(taskId);
  for (const p of parts) if (canStop(p.id)) await stopTask(p.id);
  const state = getTask(taskId)!.state;
  if (canTransition(state, 'failed')) setTaskState(taskId, 'failed', 'You stopped the initiative and its sub-tasks. Work already on staging stays there.');
  sseEmit({ type: 'task_updated', taskId });
}

/**
 * The owner tried the work and it is not right: one more Builder round with what they wrote.
 * Open tickets are withdrawn (they were for the commit that is about to change), and a deploy
 * being followed is let go of. When the round passes, the usual approvals follow, including a
 * new merge into staging when the earlier version was already there.
 */
export async function sendBackToBuilder(taskId: string, note: string): Promise<void> {
  const said = note.trim();
  if (!said) throw new StoppedError(400, 'Say what is wrong, so the Builder knows what to fix');
  if (!canSendBack(taskId)) throw new StoppedError(409, `${taskId} cannot be sent back right now`);
  stopFollowingTask(taskId, 'You sent the work back to be fixed, so FryDay stopped following this deploy. Nothing was cancelled in Jenkins.');
  expireOpenTickets(taskId);
  addMessage(taskId, 'owner', 'note', said);
  ownerSentBack(taskId);
  const last = getRounds(taskId).at(-1)!;
  await startCoder(taskId, last.round + 1, OWNER_REWORK_PROMPT);
}

/**
 * The same, started by the Lead after reading what the owner wrote on the task. The owner's
 * words are already on the thread (the Builder gets them as notes); `instructions` is what the
 * Lead made of them, with the task's whole record in front of it.
 */
export async function sendBackFromLead(taskId: string, instructions: string): Promise<void> {
  if (!canSendBack(taskId)) throw new StoppedError(409, `${taskId} cannot be sent back right now`);
  stopFollowingTask(taskId, 'The work went back to be fixed, so FryDay stopped following this deploy. Nothing was cancelled in Jenkins.');
  expireOpenTickets(taskId);
  ownerSentBack(taskId);
  const last = getRounds(taskId).at(-1)!;
  await startCoder(taskId, last.round + 1, `${OWNER_REWORK_PROMPT}\n\n## What the team lead understood from the owner\n\n${instructions.trim()}`);
}

/** The owner takes the change as it is: the task goes on to the approval a passed round gets. */
export function acceptAsItIs(taskId: string): void {
  if (!stoppedChoices(taskId).accept) throw new StoppedError(409, `${taskId} cannot be accepted as it is`);
  const last = getRounds(taskId).at(-1)!;
  saveOutcome(taskId, last.round, 'accepted', last.feedback);
  const accepted = 'You accepted the change as it is, with the Checker\'s open points.';
  setTaskState(taskId, 'awaiting_approval', accepted);
  setTaskNote(taskId, `${accepted} ${requestNextApproval(taskId)}`);
  sseEmit({ type: 'round_updated', taskId, round: last.round });
}

// ─── Verification (the running service) ───────────────────────────────────────

const verifyHost: VerifyHost = {
  handToOwner,
  startTaskAgent,
  askToContinue,
  sendBack,
  approve: approveRound,
  planOf,
  ownerNotes: (taskId) => fromTheOwner(taskId),
  guided: withGuidance,
};

// ─── Wiring ───────────────────────────────────────────────────────────────────

function onExit(exit: RunExit): void {
  if (!exit.taskId) return;
  const run = getRun(exit.runId);
  if (!run) return;
  if (exit.role === 'analyst') onAnalystExit(exit, run);
  else if (exit.role === 'planner') onPlannerExit(exit, run);
  else if (exit.role === 'coder') onCoderExit(exit, run);
  else if (exit.role === 'tester') onTesterExit(exit, run);
  else if (isTesterRole(exit.role)) onTesterRunExit(verifyHost, exit, run);
}

/** Call once at startup, before runs are picked up again. */
export function registerPipeline(): void {
  onRunExit(onExit);
  registerApprovalAction('continue_budget', {
    onApprove: continueAfterBudget,
    declinedNote: 'You stopped the task at its token limit. The branch and the work so far are kept.',
  });
  registerApprovalAction('push_branch', {
    onApprove: async (ticket) => { await executeBranchPush(ticket); },
    declinedNote: 'You declined the push. The work stays on its local branch; nothing was pushed.',
  });
}

/**
 * Call once at startup, after runs are picked up again. A task whose agent is still
 * running needs nothing. A task that was in the middle of core's own work is resumed
 * (review) or handed to the owner (anything else).
 */
export function recoverInterruptedTasks(): void {
  // A service under test does not outlive the core that started it.
  const leftover = stopLeftoverServices(getConfig().scratchDir);
  if (leftover > 0) console.log(`[fryday-core] stopped ${leftover} service${leftover === 1 ? '' : 's'} left running by the previous start`);

  const tasks = getDb()
    .prepare(`SELECT id, state FROM tasks WHERE state IN ('intake', 'workspace', 'planning', 'coding', 'testing', 'verifying')`)
    .all() as Array<{ id: string; state: string }>;
  for (const t of tasks) {
    const rounds = getRounds(t.id);
    const last = rounds[rounds.length - 1];
    if (t.state === 'verifying') {
      // The tester's service is gone, so its run is of no use; start the verification again.
      const testers = getDb().prepare(`SELECT id FROM runs WHERE task_id = ? AND state = 'running'`).all(t.id) as Array<{ id: string }>;
      for (const r of testers) killRun(r.id);
      if (last && activeWorkspace(t.id)) background(t.id, 'Verification', () => verifyRound(verifyHost, t.id, last.round));
      else handToOwner(t.id, 'Fryday restarted while this task was being verified and could not continue it');
      continue;
    }
    const running = getDb().prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND state = 'running' AND role != 'reflector'`).get(t.id) as { n: number };
    if (running.n > 0) continue;
    if (t.state === 'testing' && activeWorkspace(t.id)) {
      const round = last && last.outcome === null ? last.round : (last?.round ?? 0) + 1;
      background(t.id, 'Review', () => reviewRound(t.id, Math.max(round, 1)));
    } else {
      handToOwner(t.id, `Fryday restarted while this task was in "${t.state}" and could not continue it`);
    }
  }
}

/** Stop whatever core is running for a task that is being stopped or discarded. */
export async function stopTaskWork(taskId: string): Promise<void> {
  await stopVerification(taskId);
}
