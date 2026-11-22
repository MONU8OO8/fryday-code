/**
 * The Lead: FryDay answering the owner on a task.
 *
 * Before this, what the owner wrote on a task was a note for "the next agent to start", and
 * after review, release or deploy no agent starts, so nobody ever read it. Now each message
 * the owner writes is read by the Lead, with the task's whole record in front of it. It
 * answers in the chat and picks one thing to do:
 *
 *   none       it only answers
 *   send_back  the Builder gets one more round, with what the Lead made of the owner's words
 *   new_task   it proposes a task in another project (a change this project cannot hold);
 *              the owner starts it with one press, or does not
 *   approve    the owner said yes to the decision that is waiting: core carries it out
 *   decline    the owner said no to it
 *   deploy     the owner wants the change on the staging server: core finds the project's
 *              Jenkins job when it has none, and starts it
 *   stop       the owner wants the task stopped
 *
 * The Lead has no tools: it cannot read code or reach anything. It only names the action; core
 * carries it out, under the same rules as the buttons, and says in the chat what really
 * happened. The record tells the Lead what is possible right now, so it does not promise what
 * core would refuse. One Lead run per task at a time; what the owner writes meanwhile is
 * answered next.
 *
 * What the owner wrote at the UI is their own word at their own machine. What arrived through
 * the Chat space is not allowed to approve or deploy by itself: there the ticket's code is
 * still needed, as for every approval from Chat.
 *
 * The Lead reads text that agents wrote (the Builder's reports, the Checker's verdicts), and
 * agents read the repository. None of that may talk the Lead into something that leaves the
 * machine. So approve, deploy and stop are carried out only when the owner's own message says
 * so in plain words (ownerSaid): the model reads the intent, core checks the words.
 */

import fs from 'fs';
import path from 'path';
import { getDb } from '../db/db.js';
import { getConfig } from '../config.js';
import { getRepo, listRepos } from '../registry/registry.js';
import { startRun, onRunExit, type RunExit } from '../runner/supervisor.js';
import { sseEmit } from '../api/events.js';
import { latestDeploy } from '../deploy/deployFlow.js';
import { createTask, getTask, taskMetadata, updateTaskMetadata } from './taskState.js';
import { addMessage, listMessages, type TaskMessage } from './thread.js';
import { parseBrief } from './brief.js';
import { parsePlan } from './review.js';
import { getRounds } from './rounds.js';
import { activeWorkspace } from './workspaces.js';
import { latestRelease } from './releaseFlow.js';
import { canSendBack, canStop } from './stopped.js';
import { sendBackFromLead, startTask, stopTask, StartError } from './pipeline.js';
import { ApprovalError, resolveApproval } from './approvals.js';
import { deployForOwner } from '../deploy/ownerDeploy.js';
import { loadJenkinsCredentials } from '../deploy/config.js';
import { stateLabel } from './stateMachine.js';

const LEAD_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'agents', 'prompts', 'lead.md'), 'utf8').trim();

export const LEAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'action', 'instructions', 'project', 'title'],
  properties: {
    reply: { type: 'string' },
    action: { type: 'string', enum: ['none', 'send_back', 'new_task', 'approve', 'decline', 'deploy', 'stop'] },
    instructions: { type: 'string' },
    project: { type: 'string' },
    title: { type: 'string' },
  },
} as const;

const LEAD_ACTIONS = ['none', 'send_back', 'new_task', 'approve', 'decline', 'deploy', 'stop'] as const;
export type LeadAction = typeof LEAD_ACTIONS[number];

export interface LeadAnswer {
  reply: string;
  action: LeadAction;
  instructions: string;
  project: string;
  title: string;
}

export interface Proposal {
  projectId: string;
  title: string;
  description: string;
}

export class LeadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function parseLead(json: string | null): LeadAnswer | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string).trim() : '');
    const action = LEAD_ACTIONS.find((a) => a === str('action'));
    if (!str('reply') || !action) return null;
    return { reply: str('reply'), action, instructions: str('instructions'), project: str('project'), title: str('title') };
  } catch {
    return null;
  }
}

export function parseProposal(body: string): Proposal | null {
  try {
    const v = JSON.parse(body) as Partial<Proposal>;
    return typeof v.projectId === 'string' && typeof v.title === 'string' && typeof v.description === 'string' ? { projectId: v.projectId, title: v.title, description: v.description } : null;
  } catch {
    return null;
  }
}

// ─── Saying it ────────────────────────────────────────────────────────────────

/** What the Lead said on a task: its answer, or a task it proposed in another project. */
export type LeadSaid = { taskId: string; kind: 'reply'; text: string } | { taskId: string; kind: 'proposal'; projectName: string; title: string };
const listeners: Array<(said: LeadSaid) => void> = [];
/** Hear what the Lead says, to pass it on outside the app (the Chat space). */
export function onLeadSaid(listener: (said: LeadSaid) => void): void {
  listeners.push(listener);
}
const tell = (said: LeadSaid) => { for (const l of listeners) { try { l(said); } catch (err) { console.error('[fryday-core] a Lead listener failed:', err); } } };

/** The Lead's words on the task's thread, and to whoever listens. */
function say(taskId: string, text: string): void {
  addMessage(taskId, 'fryday', 'reply', text);
  tell({ taskId, kind: 'reply', text });
}

// ─── What the Lead has and has not answered ───────────────────────────────────

/** The id of the last owner note someone has dealt with (the Lead, or a button that used it). */
const seenUpTo = (taskId: string): number => {
  const task = getTask(taskId);
  const n = task ? taskMetadata(task)['leadSeen'] : 0;
  return typeof n === 'number' ? n : 0;
};

const ownerNotesAfter = (taskId: string, id: number): TaskMessage[] =>
  listMessages(taskId).filter((m) => m.author === 'owner' && m.kind === 'note' && m.id > id);

/** A button already acted on what the owner wrote (Send back, Try again): the Lead need not. */
export function markNotesHandled(taskId: string): void {
  const last = ownerNotesAfter(taskId, 0).at(-1);
  if (last) updateTaskMetadata(taskId, { leadSeen: last.id });
}

/** A note that came in through the Chat space, not typed at the UI. Call right after adding it. */
export function markFromChat(taskId: string, messageId: number): void {
  const task = getTask(taskId);
  if (!task) return;
  const had = taskMetadata(task)['chatNotes'];
  updateTaskMetadata(taskId, { chatNotes: [...(Array.isArray(had) ? (had as number[]) : []), messageId].slice(-50) });
}

const fromChat = (taskId: string, notes: TaskMessage[]): boolean => {
  const task = getTask(taskId);
  const ids = task ? taskMetadata(task)['chatNotes'] : null;
  return Array.isArray(ids) && notes.some((n) => (ids as number[]).includes(n.id));
};

const NEGATED = /\b(don'?t|do not|not|never|no)\b/;
const ASKING = /^(what|why|how|when|who|which|should|is|are|does|did|if)\b/;

/**
 * Whether the owner's own message says this in plain words. Checked by core on the owner's
 * text, never on anything a model wrote. A question ("what happens if I approve?") is not a yes.
 */
export function ownerSaid(action: LeadAction, text: string): boolean {
  const t = text.trim().toLowerCase();
  const question = t.endsWith('?');
  switch (action) {
    case 'approve':
      return t.length <= 120 && !question && !ASKING.test(t) && !NEGATED.test(t)
        && /\b(approve|approved|yes|yep|yeah|ok|okay|go ahead|ship it|merge it|do it|proceed)\b/.test(t);
    case 'deploy':
      return !question && !NEGATED.test(t)
        && (/\b(re)?deploy\b/.test(t) || /\b(put|push|ship|release|move)\b.{0,40}\b(stg|staging)\b/.test(t));
    case 'stop':
      return !question && /\b(stop|cancel|abort|halt)\b/.test(t);
    default:
      return true; // answering, declining, sending back and proposing start nothing outside this machine
  }
}

const PLAINLY: Partial<Record<LeadAction, string>> = {
  approve: 'To be safe I only approve when you say it plainly. Write "approve" here, or press Approve on the card.',
  deploy: 'To be safe I only start a deploy when you ask for it plainly. Write "deploy it" here.',
  stop: 'To be safe I only stop a task when you say it plainly. Write "stop" here, or press Stop.',
};

const pendingTicket = (taskId: string) =>
  getDb().prepare(`SELECT id, action, payload_json FROM approvals WHERE task_id = ? AND state = 'pending' ORDER BY requested_at DESC LIMIT 1`).get(taskId) as { id: string; action: string; payload_json: string } | undefined;

const leadRunning = (taskId: string): boolean =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND role = 'fryday' AND state = 'running'`).get(taskId) as { n: number }).n > 0;

// ─── The record the Lead reads ────────────────────────────────────────────────

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()} […]` : text);

/** Everything about the task the Lead answers from, as one Markdown text. Exported for tests. */
export function leadRecord(taskId: string, asked: TaskMessage[], atUi = true): string {
  const task = getTask(taskId)!;
  const meta = taskMetadata(task);
  const db = getDb();
  const ws = activeWorkspace(taskId);
  const project = ws ? getRepo(ws.repo_id) : undefined;
  const brief = parseBrief(task.brief_json);
  const plan = parsePlan(task.plan_json);
  const rounds = getRounds(taskId);
  const reports = new Map((db.prepare(`SELECT round, result_text FROM runs WHERE task_id = ? AND role = 'coder' AND state = 'completed' AND result_text IS NOT NULL ORDER BY started_at`).all(taskId) as Array<{ round: number; result_text: string }>).map((r) => [r.round, r.result_text]));
  const working = db.prepare(`SELECT role FROM runs WHERE task_id = ? AND state = 'running' AND role != 'fryday'`).all(taskId) as Array<{ role: string }>;
  const pending = pendingTicket(taskId);
  const release = latestRelease(taskId);
  const deploy = latestDeploy(taskId);
  const files = ws?.files_json ? (JSON.parse(ws.files_json) as Array<{ path: string }>).map((f) => f.path) : [];
  const note = typeof meta['note'] === 'string' ? meta['note'] : '';
  const summary = (json: string) => { try { return String((JSON.parse(json) as { summary?: unknown }).summary ?? ''); } catch { return ''; } };

  const roundText = rounds.slice(-3).map((r) => [
    `### Round ${r.round} (${r.outcome ?? 'not judged yet'})`,
    reports.has(r.round) ? `The Builder reported:\n${cut(reports.get(r.round)!, 1500)}` : '',
    r.verdict ? `The Checker said (${r.verdict.verdict}): ${cut(r.verdict.summary, 900)}` : '',
    r.verdict?.criteria.some((c) => !c.met) ? `Points not met: ${r.verdict.criteria.filter((c) => !c.met).map((c) => c.criterion).join('; ')}` : '',
  ].filter(Boolean).join('\n\n')).join('\n\n');

  // Earlier talk on this task, so an answer can follow from the last one.
  const talk = listMessages(taskId)
    .filter((m) => (m.author === 'owner' && m.kind === 'note') || m.kind === 'reply')
    .filter((m) => !asked.some((a) => a.id === m.id))
    .slice(-10)
    .map((m) => `${m.author === 'owner' ? 'Owner' : 'You'}: ${cut(m.body, 500)}`);

  const others = listRepos().filter((r) => r.verified && r.id !== project?.id).map((r) => `- ${r.id}: ${r.name}`);

  return [
    `# Task ${task.id}: ${task.title}`,
    `## What the owner asked for\n\n${cut(task.description, 2000)}`,
    `## This project\n\n${project ? `${project.id}: ${project.name}` : 'Not chosen yet.'}`,
    `## Where it stands now\n\n${stateLabel(task.state)}${note ? `. ${note}` : ''}\n\n` +
      `Agents working right now: ${working.length ? working.map((w) => w.role).join(', ') : 'none'}.\n` +
      `Can send back to the Builder: ${canSendBack(taskId) ? 'yes' : 'no'}.` +
      (pending ? `\nWaiting for the owner's approval: ${summary(pending.payload_json) || pending.action}.` : ''),
    `## What you can do right now\n\n${possible(taskId, atUi).map((l) => `- ${l}`).join('\n')}`,
    brief ? `## What the Understander understood\n\n${cut(brief.summary, 1200)}` : '',
    plan ? `## The plan\n\n${cut(plan.summary, 1500)}\n\nIt must be true when done:\n${plan.criteria.map((c) => `- ${c}`).join('\n')}` : '',
    files.length ? `## Files changed in this project\n\n${files.slice(0, 40).map((f) => `- ${f}`).join('\n')}` : '',
    roundText ? `## The last rounds\n\n${roundText}` : '',
    release ? `## Release\n\nMerge into ${release.stg_branch}: ${release.state}${release.outcome ? ` (${release.outcome})` : ''}.` : '',
    deploy ? `## Deploy\n\n${deploy.state}${deploy.outcome ? ` (${deploy.outcome})` : ''}. ${cut(deploy.detail ?? '', 500)}` : '',
    `## Other projects a task can be proposed in\n\n${others.length ? others.join('\n') : 'None are set up.'}`,
    talk.length ? `## Earlier on this task\n\n${talk.join('\n')}` : '',
    `## What the owner just wrote\n\n${asked.map((m) => cut(m.body, 3000)).join('\n\n')}`,
  ].filter(Boolean).join('\n\n');
}

/** One line per action: whether it is possible now, and if not, why and what the owner can do. */
function possible(taskId: string, atUi: boolean): string[] {
  const task = getTask(taskId)!;
  const pending = pendingTicket(taskId);
  const release = latestRelease(taskId);
  const deploy = latestDeploy(taskId);
  const ws = activeWorkspace(taskId);
  const project = ws ? getRepo(ws.repo_id) : release ? getRepo(release.repo_id) : undefined;
  const what = pending ? ((() => { try { return String((JSON.parse(pending.payload_json) as { summary?: unknown }).summary ?? pending.action); } catch { return pending.action; } })()) : '';
  const lines: string[] = [];
  lines.push(`send_back: ${canSendBack(taskId) ? 'possible' : 'not possible now (agents are working, or there is no reviewed change yet)'}.`);
  if (!pending) lines.push('approve, decline: not possible. No decision is waiting for the owner.');
  else if (atUi) lines.push(`approve: possible. It says yes to: ${what}. decline: possible, it says no to it.`);
  else lines.push(`approve: not possible from the Chat space without the code. Tell the owner to reply "approve" followed by the code in that decision's message. decline: possible. The decision waiting is: ${what}.`);
  const onStaging = release?.state === 'pushed';
  const running = deploy && ['queued', 'running'].includes(deploy.state);
  if (!onStaging) lines.push(`deploy: not possible yet. The change is not merged into the staging branch${pending?.action === 'release_stg' ? '; approving the waiting decision merges it, and the deploy follows' : ''}.`);
  else if (running) lines.push(`deploy: already running in Jenkins (${deploy!.job}).`);
  else if (!loadJenkinsCredentials()) lines.push('deploy: not possible. Jenkins is not connected here; the owner connects it on the Connections page (one press when Claude Code already has it).');
  else if (task.state !== 'awaiting_approval' && task.state !== 'needs_owner') lines.push('deploy: not possible while the task is busy.');
  else {
    const job = project?.deployerConfig && typeof project.deployerConfig['job'] === 'string' ? (project.deployerConfig['job'] as string) : null;
    lines.push(job
      ? `deploy: possible. It starts the Jenkins job ${job} for the staging branch${atUi ? '' : ', after the owner approves it with the code'}.`
      : 'deploy: possible. This project has no Jenkins job set yet: you look for the one that builds its repository, set it, and ask the owner to approve its first use. If the owner names the job, pass the name.');
  }
  lines.push(`stop: ${canStop(taskId) ? 'possible' : 'not possible, nothing is running or waiting'}.`);
  return lines;
}

// ─── Asking and acting ────────────────────────────────────────────────────────

/**
 * Have the Lead read what the owner wrote and has not been answered. Returns false when there
 * is nothing new, or the Lead is already reading (it picks up the rest when it is done).
 */
export function askLead(taskId: string): boolean {
  const task = getTask(taskId);
  if (!task || leadRunning(taskId)) return false;
  // A task from before there was a Lead has a pile of unread notes: answer the newest, and
  // give the rest as what was said earlier.
  const first = taskMetadata(task)['leadSeen'] === undefined;
  const unread = ownerNotesAfter(taskId, seenUpTo(taskId));
  const asked = first ? unread.slice(-1) : unread;
  if (asked.length === 0) return false;
  // Marked when the run starts: an answer that fails is said in the chat, not retried forever.
  const atUi = !fromChat(taskId, asked);
  updateTaskMetadata(taskId, { leadSeen: asked.at(-1)!.id, leadAtUi: atUi, leadAsked: asked.at(-1)!.body.slice(0, 2000) });
  try {
    startRun({ taskId, role: 'fryday', prompt: leadRecord(taskId, asked, atUi), appendSystemPrompt: LEAD_PROMPT, jsonSchema: LEAD_SCHEMA, cwd: getConfig().conciergeDir });
  } catch (err) {
    console.error(`[fryday-core] the Lead could not start for ${taskId}:`, err);
    say(taskId, 'I could not read this just now: every agent slot is busy. Your message is saved on the task; write again in a moment.');
    return false;
  }
  sseEmit({ type: 'task_updated', taskId });
  return true;
}

function onLeadExit(exit: RunExit): void {
  if (exit.role !== 'fryday' || !exit.taskId) return;
  const taskId = exit.taskId;
  if (!getTask(taskId)) return;
  const run = getDb().prepare('SELECT output_json FROM runs WHERE id = ?').get(exit.runId) as { output_json: string | null } | undefined;
  const answer = exit.state === 'completed' ? parseLead(run?.output_json ?? null) : null;
  if (!answer) {
    say(taskId, exit.state === 'killed'
      ? 'I stopped before answering. Your message is saved on the task.'
      : 'I could not answer just now (the AI service did not give me an answer). Your message is saved on the task; write again and I will read it.');
  } else {
    act(taskId, answer);
  }
  sseEmit({ type: 'task_updated', taskId });
  askLead(taskId); // what the owner wrote while this one was being answered
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The owner's yes or no, said in the chat, to the decision that is waiting. */
function decide(taskId: string, answer: LeadAnswer, atUi: boolean): void {
  const pending = pendingTicket(taskId);
  if (!pending) {
    say(taskId, `${answer.reply}\n\n(No decision is waiting on this task right now, so there was nothing to ${answer.action}.)`);
    return;
  }
  if (answer.action === 'approve' && !atUi) {
    say(taskId, 'From the Chat space an approval needs its code: reply "approve" followed by the code in that decision\'s message.');
    return;
  }
  try {
    resolveApproval(pending.id, answer.action === 'approve' ? 'approved' : 'rejected', { via: 'cookie', resolvedBy: 'owner, in the task chat' });
    say(taskId, answer.reply);
  } catch (err) {
    if (!(err instanceof ApprovalError)) throw err;
    say(taskId, `I could not ${answer.action} it: ${err.message}`);
  }
}

function act(taskId: string, answer: LeadAnswer): void {
  const task = getTask(taskId)!;
  const atUi = taskMetadata(task)['leadAtUi'] !== false;
  const asked = taskMetadata(task)['leadAsked'];
  if (!ownerSaid(answer.action, typeof asked === 'string' ? asked : '')) {
    say(taskId, PLAINLY[answer.action]!);
    return;
  }
  if (answer.action === 'approve' || answer.action === 'decline') {
    decide(taskId, answer, atUi);
    return;
  }
  if (answer.action === 'deploy') {
    // Core says what really happened: the Lead's own words would be a promise made before trying.
    void deployForOwner(taskId, latestRelease(taskId), { atUi, job: answer.instructions || null })
      .then((outcome) => say(taskId, outcome))
      .catch((err) => say(taskId, `I could not start the deploy: ${errorText(err)}`))
      .finally(() => sseEmit({ type: 'task_updated', taskId }));
    return;
  }
  if (answer.action === 'stop') {
    if (!canStop(taskId)) {
      say(taskId, `${answer.reply}\n\n(Nothing is running or waiting on this task, so there was nothing to stop.)`);
      return;
    }
    void stopTask(taskId)
      .then(() => say(taskId, answer.reply))
      .catch((err) => say(taskId, `I could not stop it: ${errorText(err)}`));
    return;
  }
  if (answer.action === 'send_back' && answer.instructions) {
    if (!canSendBack(taskId)) {
      say(taskId, `${answer.reply}\n\n(The work cannot go back to the Builder right now: wait until nothing is running, or press Stop, then write again.)`);
      return;
    }
    say(taskId, answer.reply);
    void sendBackFromLead(taskId, answer.instructions).catch((err) => {
      console.error(`[fryday-core] the Lead could not send ${taskId} back:`, err);
      say(taskId, `I could not send it back to the Builder: ${err instanceof Error ? err.message : String(err)}`);
    });
    return;
  }
  if (answer.action === 'new_task' && answer.instructions && answer.title) {
    const project = getRepo(answer.project);
    if (!project?.verified) {
      say(taskId, `${answer.reply}\n\n(I could not put up the task: "${answer.project}" is not a project set up here. Add it on the Projects page first.)`);
      return;
    }
    say(taskId, answer.reply);
    const proposal: Proposal = { projectId: project.id, title: answer.title.slice(0, 200), description: answer.instructions };
    addMessage(taskId, 'fryday', 'proposal', JSON.stringify(proposal));
    tell({ taskId, kind: 'proposal', projectName: project.name, title: proposal.title });
    return;
  }
  say(taskId, answer.reply);
}

// ─── Proposals ────────────────────────────────────────────────────────────────

/** Which proposals of this task were started, as { messageId: new task id }. */
export function startedProposals(taskId: string): Record<string, string> {
  const task = getTask(taskId);
  const v = task ? taskMetadata(task)['proposals'] : null;
  return v && typeof v === 'object' ? (v as Record<string, string>) : {};
}

/** The newest proposal on the task that was not started; null when there is none. */
export function openProposal(taskId: string): { messageId: number; proposal: Proposal } | null {
  const started = startedProposals(taskId);
  for (const m of listMessages(taskId).filter((x) => x.kind === 'proposal').reverse()) {
    const proposal = parseProposal(m.body);
    if (proposal && !started[String(m.id)]) return { messageId: m.id, proposal };
  }
  return null;
}

/** The owner pressed Start on a proposal: a new task in the other project, linked both ways. */
export function startProposal(taskId: string, messageId: number): { id: string } {
  const message = listMessages(taskId).find((m) => m.id === messageId && m.kind === 'proposal');
  const proposal = message ? parseProposal(message.body) : null;
  if (!proposal) throw new LeadError(404, 'That proposal is not on this task');
  const started = startedProposals(taskId);
  if (started[String(messageId)]) throw new LeadError(409, `That task was already started as ${started[String(messageId)]}`);
  const project = getRepo(proposal.projectId);
  if (!project?.verified) throw new LeadError(409, `${proposal.projectId} is not a project set up here`);

  const from = getTask(taskId)!;
  const created = createTask(proposal.title, `${proposal.description}\n\n(Follow-up to ${taskId}: ${from.title})`);
  updateTaskMetadata(taskId, { proposals: { ...started, [String(messageId)]: created.id } });
  updateTaskMetadata(created.id, { followUpOf: taskId });
  addMessage(taskId, 'fryday', 'event', `Started ${created.id} in ${project.name}: ${proposal.title}`);
  try {
    startTask(created.id, project.id);
  } catch (err) {
    if (!(err instanceof StartError)) throw err;
    addMessage(created.id, 'fryday', 'event', `Could not start: ${err.message}`);
  }
  sseEmit({ type: 'task_updated', taskId });
  return { id: created.id };
}

/** Call once at startup, with the pipeline. */
export function registerLead(): void {
  onRunExit(onLeadExit);
}
