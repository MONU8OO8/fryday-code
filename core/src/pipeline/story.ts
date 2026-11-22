/**
 * The team chat of the simple UI, built only from facts core stores: hand-offs, plans,
 * check results, verdicts, tester reports, questions, approvals and releases. No model
 * writes these lines; where a line quotes an agent (a brief, a plan, a verdict), it is that
 * agent's stored output, with paths taken out.
 */

import { hasBlockingFlag } from './diffFlags.js';
import { getDb } from '../db/db.js';
import { getRepo } from '../registry/registry.js';
import { recentActivity, type RunEventSummary } from '../runner/runEvents.js';
import { parseBrief } from './brief.js';
import { taskFlow, type TaskFlow } from './flow.js';
import { groupOf, journeyOf, overviewLine, type Journey, type TaskGroup, type TaskOutcome } from './journey.js';
import { listQuestions, NO_ANSWER } from './questions.js';
import { parsePlan } from './review.js';
import { getRounds, roundCleared } from './rounds.js';
import { getTask, taskMetadata, type TaskRow } from './taskState.js';
import { listMessages } from './thread.js';
import { getWorkspaces } from './workspaces.js';
import { loadJenkinsCredentials } from '../deploy/config.js';
import { stoppedChoices, canStop, canSendBack, type StoppedChoices } from './stopped.js';
import type { QuestionOption } from './questions.js';
import type { Round } from './rounds.js';
import { ACTOR_NAME, actorOfRole, capital, checkName, clip, doingText, formatTokens, joinWords, plainText, times, type Actor } from './plainWords.js';

export type StoryKind = 'said' | 'handoff' | 'sendback' | 'question' | 'approval' | 'note' | 'outcome';

export type DetailRef =
  | { kind: 'brief' }
  | { kind: 'plan' }
  | { kind: 'round'; round: number; part: 'checks' | 'verdict' | 'changes' | 'verify' }
  | { kind: 'deploy' }
  /** Why the task stopped: core's own note on the task. */
  | { kind: 'note' };

export type StoryAction =
  /** freeText: the owner may write an answer (a clarifying question); otherwise only an option counts. */
  | { kind: 'answer'; questionId: string; options: QuestionOption[]; freeText: boolean }
  | { kind: 'approve'; approvalId: string; plain: string; effects: string[] };

export interface StoryItem {
  /** Stable between calls, so the UI animates only new items. */
  id: string;
  at: number;
  from: Actor;
  to: Actor | null;
  kind: StoryKind;
  text: string;
  round: number | null;
  details: { label: string; ref: DetailRef } | null;
  action: StoryAction | null;
}

export interface StoryNow {
  actor: Actor;
  text: string;
  since: number;
}

export interface StoryInput {
  task: { id: string; title: string; description: string; state: string; createdAt: number; note: string | null };
  projectName: string | null;
  brief: { summary: string; at: number } | null;
  plan: { summary: string; criteria: number; at: number } | null;
  questions: Array<{ id: string; kind: string; question: string; options: QuestionOption[]; askedBy: string; askedAt: number; answer: string | null; answeredAt: number | null }>;
  rounds: Array<Round & { createdAt: number }>;
  /** The owner's notes on the task. */
  notes: Array<{ id: number; body: string; at: number }>;
  /** Things agents posted on the task thread (the Analyst's "this is for …"). */
  agentEvents: Array<{ id: number; author: string; body: string; at: number }>;
  approvals: Array<{ id: string; action: string; state: string; payload: Record<string, unknown>; requestedAt: number; resolvedAt: number | null }>;
  release: { id: string; state: string; at: number } | null;
  deploy: { id: string; state: string; at: number } | null;
  /** How a task that is back with the owner ended (outcomeOf). */
  outcome: TaskOutcome;
  /** When each agent run started, oldest first: who read a note of the owner's. */
  runStarts?: Array<{ role: string; at: number }>;
  /** What the owner can do with a task that stopped at the round limit (stoppedChoices). */
  choices?: StoppedChoices;
  /** The task had a workspace and every one was discarded: its work is gone, it cannot go on. */
  discarded?: boolean;
  /** What the Builder reported at the end of each round, by round: its own account of the work. */
  builderSaid?: Record<number, string>;
  /** The work can be sent back to the Builder with what the owner found (canSendBack). */
  canSendBack?: boolean;
}

/** The stored facts an ending is read from. Approvals in any order. */
export interface OutcomeFacts {
  state: string;
  approvals: Array<{ action: string; state: string; requestedAt: number; resolvedAt: number | null }>;
  release: { state: string; at: number } | null;
  deploy: { at: number } | null;
  hasStaging: boolean;
  hasDeployer: boolean;
  /** When the task's latest agent run started; null when no agent ran. */
  lastRunAt: number | null;
}

/**
 * Core moves a task to needs_owner on some successful endings too. Tell those apart from a
 * real stop by what core stored: the last decision the owner made, and what it led to.
 */
export function outcomeOf(f: OutcomeFacts): TaskOutcome {
  if (f.state !== 'needs_owner') return null;
  if (f.approvals.some((a) => a.state === 'pending')) return null;
  const latest = f.approvals.filter((a) => a.state !== 'expired').sort((a, b) => a.requestedAt - b.requestedAt).at(-1);
  if (!latest || latest.state !== 'executed') return null;
  // An agent that started after the decision means the task went on; a later stop is a real stop.
  if (f.lastRunAt !== null && f.lastRunAt > (latest.resolvedAt ?? latest.requestedAt)) return null;
  if (latest.action === 'release_stg' && !f.hasDeployer && f.release?.state === 'pushed' && f.release.at >= latest.requestedAt && (!f.deploy || f.deploy.at < f.release.at)) {
    return 'on_staging_no_deploy';
  }
  if (latest.action === 'push_branch' && !f.hasStaging && (!f.release || f.release.at < latest.requestedAt)) return 'handed_over';
  return null;
}

/** Whether the project has a staging branch and a deployer, as the flow model read them. */
function projectHas(flow: TaskFlow): { hasStaging: boolean; hasDeployer: boolean } {
  const skipped = (id: 'release' | 'deploy') => flow.nodes.find((n) => n.id === id)?.state === 'skipped';
  return { hasStaging: !skipped('release'), hasDeployer: !skipped('deploy') };
}

/**
 * A commit hash: 7 to 40 hex characters with at least one digit and one letter a to f, so a
 * word like "defaced" and a plain number or date like 20261122 stay.
 */
const HASH = String.raw`\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b`;
const LABEL = String.raw`(?:merge|commit|now at)?\s*`;
const hash = (pattern: string) => new RegExp(pattern.replaceAll('<hash>', HASH), 'gi');

/**
 * Core's note on a stopped task, without paths or hashes. A hash goes out with the words that
 * only name it ("(merge 2a85c981)", "with commit 2a85c981"), so no fragment is left behind.
 */
function plainNote(note: string): string {
  return plainText(note)
    .replace(hash(String.raw`\s*\(\S+ is at <hash>, not the approved <hash>\)`), ' (it moved on after you approved it)')
    .replace(hash(String.raw`\bthat <hash> is what`), 'that the change is what')
    .replace(hash(String.raw`\bit built <hash>(?:,\s*<hash>)*,? which does not contain`), 'the build does not contain')
    .replace(hash(String.raw`\bcontains <hash>`), 'contains the change')
    .replace(hash(String.raw`\s*\(${LABEL}<hash>\)`), '')
    .replace(hash(String.raw`\(${LABEL}<hash>,\s*`), '(')
    .replace(hash(String.raw`\s+for commit <hash>`), ' for an earlier version')
    .replace(hash(String.raw`\s+(?:is\s+)?now at (?:<hash>|an unknown commit)`), ' has moved on')
    .replace(hash(String.raw`\s+(?:for|with|at)(?: commit)? <hash>`), '')
    .replace(hash(String.raw`\b(the )?(merge) <hash>`), (_m, the: string | undefined, word: string) => `${the ?? (word[0] === 'M' ? 'The ' : 'the ')}merge`)
    .replace(hash(String.raw`\bcommit <hash>`), '')
    .replace(hash('<hash>'), '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([.,;:)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const said = (text: string, max = 280) => clip(plainText(text), max);
/** The opening of an agent's Markdown report, as plain text: its first paragraph, without markup. */
function builderWords(report: string): string {
  const first = report.trim().split(/\n\s*\n/)[0] ?? '';
  return plainText(first.replace(/^#+\s*/gm, '').replace(/\*\*/g, '').replace(/\s*\n\s*/g, ' '));
}

/** Whole sentences from the start of text, as many as fit in max (at least the first, clipped). */
function sentences(text: string, max: number): string {
  let out = '';
  for (const p of text.split(/(?<=[.!?])\s+/)) {
    const next = out ? `${out} ${p}` : p;
    if (out && next.length > max) break;
    out = next;
  }
  return clip(out, max);
}

/** A sentence that ends with its own stop, so the next one can follow it. */
const endSentence = (text: string) => (!text || /[.!?…]$/.test(text) ? text : `${text}.`);

/** FryDay's reply to a note of the owner's that no agent has read yet: what happens with it now. */
function ackWhileWaiting(state: string, pendingApproval: boolean, choices: StoppedChoices | undefined, sendBack: boolean): string {
  if (choices?.tryAgain) return 'Got it. Press “Try again” below and the Builder starts on it.';
  if (sendBack) return 'Saved as a note, so nobody is working on it yet. To have the Builder fix it, write it again and press “Send back to fix”.';
  if (pendingApproval) return 'Got it. To go on, press Approve (or Not yet) on the card above. A message does not approve anything.';
  if (state === 'waiting_owner') return 'Got it. The team is waiting for your answer to the question above.';
  if (state === 'needs_owner' || state === 'deployed' || state === 'failed') return 'Saved on the task. Nothing is running right now, so nobody reads it until the task goes on.';
  return 'Got it. The next teammate to start reads it.';
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** What approving does, in one or two plain sentences. The technical list stays beside it. */
export function plainApproval(action: string, payload: Record<string, unknown>, projectName: string | null): string {
  const project = str(payload['repoName']) || projectName || 'the project';
  switch (action) {
    case 'release_stg':
      return `When you approve, the change is added to ${project} and put on staging. Nothing goes live for customers.`;
    case 'push_branch':
      return payload['owned'] === true
        ? `When you approve, the work is added to the branch you started (${str(payload['targetBranch'])}).`
        : `When you approve, the work is shared on a new branch so the owner of ${str(payload['targetBranch'])} can review it.`;
    case 'deploy_stg':
      return `When you approve, the new version of ${project} is started on the staging server. Nothing goes live for customers.`;
    case 'deploy_input':
      return 'The staging deploy is asking to go on. When you approve, FryDay answers yes to that one question.';
    case 'continue_budget': {
      const usedTokens = payload['usedTokens'];
      const used = typeof usedTokens === 'number' ? ` (${formatTokens(usedTokens)} tokens)` : '';
      if (payload['why'] === 'task') return `This task has used its token budget${used}. Let it go on?`;
      const stage = payload['stage'] as { role?: unknown } | undefined;
      return `The ${ACTOR_NAME[actorOfRole(str(stage?.role))]} reached its token limit for one go. Let it go on?`;
    }
    default:
      return said(str(payload['summary']) || 'FryDay needs your OK to go on.');
  }
}

export function storyNow(live: { role: string; tools: string[]; toolInputs: string[]; text: string; since: number } | null): StoryNow | null {
  if (!live) return null;
  return { actor: actorOfRole(live.role), text: doingText(live.tools, live.toolInputs, live.text), since: live.since };
}

type NewItem = Omit<StoryItem, 'to' | 'round' | 'details' | 'action'> & Partial<Pick<StoryItem, 'to' | 'round' | 'details' | 'action'>>;

export function buildStory(input: StoryInput): StoryItem[] {
  const items: StoryItem[] = [];
  const add = (item: NewItem) => { items.push({ to: null, round: null, details: null, action: null, ...item }); };
  const t = input.task;

  add({ id: `task:${t.id}`, at: t.createdAt, from: 'you', kind: 'note', text: clip(t.description || t.title, 400) });

  if (input.brief) {
    add({ id: `brief:${t.id}`, at: input.brief.at, from: 'understander', kind: 'said', text: said(input.brief.summary), details: { label: 'What I understood', ref: { kind: 'brief' } } });
  }
  for (const e of input.agentEvents) {
    if (input.brief && e.body.trim() === input.brief.summary.trim()) continue;
    add({ id: `event:${e.id}`, at: e.at, from: actorOfRole(e.author), kind: 'said', text: said(e.body) });
  }
  for (const q of input.questions) {
    const open = q.answer === null;
    add({
      id: `question:${q.id}`, at: q.askedAt, from: actorOfRole(q.askedBy), to: 'you', kind: 'question', text: said(q.question, 400),
      action: open && t.state === 'waiting_owner' ? { kind: 'answer', questionId: q.id, options: q.options, freeText: q.kind === 'clarify' } : null,
    });
    if (!open) {
      const shown = q.answer === NO_ANSWER ? 'Go on without an answer.' : q.options.find((o) => o.value === q.answer)?.label ?? q.answer ?? '';
      add({ id: `answer:${q.id}`, at: q.answeredAt ?? q.askedAt, from: 'you', kind: 'note', text: clip(shown, 400) });
    }
  }
  // After the questions: when a note and a question share a millisecond, the question came first.
  for (const n of input.notes) add({ id: `note:${n.id}`, at: n.at, from: 'you', kind: 'note', text: clip(n.body, 400) });

  if (input.plan) {
    const n = input.plan.criteria;
    add({
      id: `plan:${t.id}`, at: input.plan.at, from: 'planner', to: 'builder', kind: 'handoff',
      text: `Here's the plan: ${said(input.plan.summary, 240)} ${n} ${n === 1 ? 'thing' : 'things'} must be true when it's done.`,
      details: { label: 'See the plan', ref: { kind: 'plan' } },
    });
  }

  for (const r of input.rounds) {
    const at = r.createdAt;
    const own = input.builderSaid?.[r.round];
    add({
      id: `round:${r.round}`, at, from: 'builder', to: 'checks', kind: 'handoff', round: r.round,
      text: own ? `${endSentence(sentences(builderWords(own), 260))} ${r.round === 1 ? 'Please check it.' : 'Please check again.'}` : r.round === 1 ? 'Done. Please check it.' : 'Fixed. Please check again.',
      details: { label: 'What changed', ref: { kind: 'round', round: r.round, part: 'changes' } },
    });
    const failing = r.checks.filter((c) => c.status === 'failed' || c.status === 'timeout' || c.status === 'error');
    const blocked = hasBlockingFlag(r.flags);
    if (failing.length > 0 || blocked) {
      const parts = failing.map((c) => `${checkName(c.name)} ${c.status === 'timeout' ? 'took too long' : c.status === 'error' ? 'could not run' : 'did not pass'}`);
      if (blocked) parts.push('the change does something FryDay does not allow');
      add({
        id: `gate:${r.round}`, at: at + 1, from: 'checks', to: 'builder', kind: 'sendback', round: r.round,
        text: `${capital(joinWords(parts))}. Back to you.`, details: { label: 'What failed', ref: { kind: 'round', round: r.round, part: 'checks' } },
      });
      continue;
    }
    if (r.verdict) {
      const unmet = r.verdict.criteria.filter((c) => !c.met);
      const details = { label: 'How it was checked', ref: { kind: 'round' as const, round: r.round, part: 'verdict' as const } };
      if (r.verdict.verdict === 'pass' && unmet.length === 0) {
        add({ id: `verdict:${r.round}`, at: at + 2, from: 'checker', kind: 'said', round: r.round, text: `It meets all ${r.verdict.criteria.length} points of the plan.`, details });
      } else {
        const first = endSentence(said(unmet[0]?.criterion ?? '', 160));
        const text = unmet.length === 1
          ? `1 of ${r.verdict.criteria.length} points is not met yet: ${first} Back to you.`
          : unmet.length > 1
          ? `${unmet.length} of ${r.verdict.criteria.length} points are not met yet, for example: ${first} Back to you.`
          : `${said(r.verdict.summary, 200)} Back to you.`;
        add({ id: `verdict:${r.round}`, at: at + 2, from: 'checker', to: 'builder', kind: 'sendback', round: r.round, text, details });
        continue;
      }
    }
    const v = r.verify;
    if (!v) continue;
    const details = { label: 'What was tried', ref: { kind: 'round' as const, round: r.round, part: 'verify' as const } };
    if (v.startFailure) {
      const failed = v.status === 'failed';
      add({
        id: `verify:${r.round}:start`, at: at + 3, from: 'app_tester', to: failed ? 'builder' : null, kind: failed ? 'sendback' : 'said', round: r.round, details,
        text: failed ? 'The app does not start with the change. Back to you.' : 'The app could not be started to try it, so this goes to you.',
      });
      continue;
    }
    for (const tester of v.testers) {
      const who: Actor = tester.kind === 'api' ? 'app_tester' : 'page_tester';
      const tried = tester.kind === 'api' ? `Tried the app ${times(tester.calls)}` : `Used the pages ${times(tester.calls)}`;
      if (tester.passed) {
        add({ id: `verify:${r.round}:${tester.kind}`, at: at + 3, from: who, kind: 'said', round: r.round, text: `${tried}: it works as planned.`, details });
      } else {
        add({
          id: `verify:${r.round}:${tester.kind}`, at: at + 3, from: who, to: 'builder', kind: 'sendback', round: r.round, details,
          text: `${tried}. ${said(tester.report?.summary ?? 'It did not work as planned.', 200)} Back to you.`,
        });
      }
    }
  }

  for (const r of input.rounds.filter((x) => x.outcome === 'accepted')) {
    add({ id: `accepted:${r.round}`, at: r.createdAt + 4, from: 'you', kind: 'note', round: r.round, text: 'Accept it as it is.' });
  }

  const pendingNow = input.approvals.some((a) => a.state === 'pending');
  for (const n of input.notes) {
    const reader = input.runStarts?.find((r) => r.at > n.at);
    add({ id: `ack:${n.id}`, at: n.at, from: 'fryday', to: 'you', kind: 'said', text: reader ? `Got it. I passed it on to the ${ACTOR_NAME[actorOfRole(reader.role)]}.` : ackWhileWaiting(t.state, pendingNow, input.choices, input.canSendBack === true) });
  }

  let pending = false;
  for (const a of input.approvals) {
    if (a.state === 'expired') continue; // replaced by a newer one before anyone decided
    const open = a.state === 'pending';
    pending ||= open;
    const plain = plainApproval(a.action, a.payload, input.projectName);
    add({
      id: `approval:${a.id}`, at: a.requestedAt, from: a.action === 'continue_budget' ? 'fryday' : 'releaser', to: 'you', kind: 'approval', text: plain,
      action: open ? { kind: 'approve', approvalId: a.id, plain, effects: [...strings(a.payload['pushes']), ...strings(a.payload['effects'])] } : null,
    });
    if (a.resolvedAt !== null && a.state !== 'pending') {
      add({ id: `decision:${a.id}`, at: a.resolvedAt, from: 'you', kind: 'note', text: a.state === 'rejected' ? 'Not yet.' : 'Approved.' });
    }
  }

  if (input.release) {
    const r = input.release;
    const text = r.state === 'pushed' ? 'The change is on staging.'
      : r.state === 'stopped' ? 'Releasing stopped before anything changed on staging.'
      : r.state === 'reverted' ? 'The change was taken back off staging.'
      : null;
    if (text) add({ id: `release:${r.id}`, at: r.at + 1, from: 'releaser', kind: 'outcome', text });
  }
  if (input.deploy) {
    const d = input.deploy;
    const text = d.state === 'succeeded' ? 'The staging server is running the new version.'
      : d.state === 'failed' || d.state === 'stopped' ? 'The staging deploy did not finish.'
      : null;
    if (text) add({ id: `deploy:${d.id}`, at: d.at + 1, from: 'releaser', kind: 'outcome', text, details: { label: 'Deploy details', ref: { kind: 'deploy' } } });
  }

  const last = items.reduce((m, i) => Math.max(m, i.at), 0);
  const whatHappened = { label: 'What happened', ref: { kind: 'note' as const } };
  if (t.state === 'needs_owner' && !pending) {
    const latest = input.approvals.filter((a) => a.state !== 'expired').sort((a, b) => a.requestedAt - b.requestedAt).at(-1);
    const id = `stopped:${t.id}`;
    if (input.outcome === 'on_staging_no_deploy') {
      // The Releaser has already said "The change is on staging."
      add({ id, at: last + 1, from: 'fryday', to: 'you', kind: 'said', text: 'This project has no automatic deploy, so deploy staging yourself.' });
    } else if (input.outcome === 'handed_over') {
      const push = input.approvals.filter((a) => a.action === 'push_branch' && a.state === 'executed').at(-1);
      add({
        id, at: last + 1, from: 'fryday', to: 'you', kind: 'said',
        text: push?.payload['owned'] === true ? 'The work is added to your branch. Nothing was changed on staging.' : 'The work is saved and shared for review. Nothing was changed on staging.',
      });
    } else if (latest?.state === 'rejected') {
      const deploy = latest.action === 'deploy_stg' || latest.action === 'deploy_input';
      const text = latest.action === 'continue_budget' ? 'You stopped the task at its token limit. Nothing more was used.'
        : deploy ? 'You said not yet. The change is on staging, but the staging server was not updated.'
        : 'You said not yet. Nothing was changed on staging.';
      add({ id, at: last + 1, from: 'fryday', to: 'you', kind: 'said', text });
    } else if (input.discarded) {
      add({ id, at: last + 1, from: 'fryday', to: 'you', kind: 'said', text: 'The work on this task was discarded, so it cannot go on. To try again, start a new task.' });
    } else if (input.choices?.tryAgain) {
      const tries = input.rounds.length;
      const why = input.choices.why ? ` The Checker says: ${endSentence(sentences(plainText(input.choices.why), 260))}` : '';
      add({
        id, at: last + 1, from: 'fryday', to: 'you', kind: 'said', details: whatHappened,
        text: `The team tried ${times(tries)} and it still does not pass.${why} It is your call: try again (tell them what to do differently), or accept it as it is.`,
      });
    } else {
      add({ id, at: last + 1, from: 'fryday', to: 'you', kind: 'said', text: t.note ? `I stopped and need you: ${said(plainNote(t.note), 300)}` : 'I stopped and need you.', details: t.note ? whatHappened : null });
    }
  }
  if (t.state === 'failed') {
    add({ id: `failed:${t.id}`, at: last + 1, from: 'fryday', kind: 'said', text: t.note ? `The task stopped: ${said(plainNote(t.note), 300)}` : 'The task stopped.', details: t.note ? whatHappened : null });
  }

  return items.sort((a, b) => a.at - b.at);
}

// ─── Reading it from the database ─────────────────────────────────────────────

export interface TaskStory {
  task: { id: string; title: string; state: string; projectName: string | null; createdAt: number; budget: { limitTokens: number; usedTokens: number } };
  journey: Journey;
  items: StoryItem[];
  now: StoryNow | null;
  /** What the owner may ask for again (askAgainOf): POST /api/tasks/:id/approval or /deploy. */
  askAgain: AskAgain;
  /** A task that stopped at the round limit: POST /api/tasks/:id/try-again or /accept. */
  choices: StoppedChoices;
  /** Its work was discarded: nothing more can happen on it. */
  discarded: boolean;
  /** POST /api/tasks/:id/stop is available. */
  canStop: boolean;
  /** POST /api/tasks/:id/send-back { note } is available. */
  canSendBack: boolean;
}

export type AskAgain = 'release' | 'deploy' | null;

/** The stored facts askAgainOf reads. */
export interface AskAgainFacts {
  state: string;
  approvals: Array<{ state: string }>;
  /** The outcome of the task's last round; null before the first. */
  lastRoundOutcome: string | null;
  /** The task has a workspace that was not removed. */
  hasLiveWorkspace: boolean;
  hasStaging: boolean;
  /** The project has a Jenkins deployer (the flow's deploy step is not skipped). */
  hasDeployer?: boolean;
  /** Jenkins itself is set up on this machine. Without it a deploy cannot be started at all. */
  jenkinsReady?: boolean;
  /** head: the commit that was merged, when known. */
  release: { state: string; head?: string | null } | null;
  deploy: { state: string } | null;
  /** The commit the task's work is at now, when known. */
  head?: string | null;
}

/**
 * Whether the owner can ask again, with the rules of the full task page (TaskDetail's
 * canAskAgain and the deploy card's ask again), plus a staging branch to release to.
 */
export function askAgainOf(f: AskAgainFacts): AskAgain {
  // Only a task at rest with the owner: while agents are rewriting the change, deploying what
  // is on staging would put up a version the owner already said is not right.
  if (f.state !== 'awaiting_approval' && f.state !== 'needs_owner') return null;
  if (f.approvals.some((a) => a.state === 'pending')) return null;
  // On staging already, but the work moved on since (it was sent back and fixed): the new
  // commits need their own merge before any deploy means anything.
  const movedOn = f.release?.state === 'pushed' && !!f.head && !!f.release.head && f.release.head !== f.head;
  if (movedOn && roundCleared(f.lastRoundOutcome) && f.hasLiveWorkspace && f.hasStaging && (f.state === 'awaiting_approval' || f.state === 'needs_owner')) return 'release';
  // Asking again starts a Jenkins job, so without Jenkins set up here there is nothing to offer:
  // the task already says so in the chat, with what to do instead.
  // A deploy that ran is proof enough of a deployer; a task that never got one needs hasDeployer.
  const jenkins = f.jenkinsReady !== false;
  if (f.release?.state === 'pushed' && jenkins && (f.deploy?.state === 'failed' || f.deploy?.state === 'stopped')) return 'deploy';
  // A declined deploy leaves no deploy row; the full task page offers "Deploy with Jenkins" then (POST /deploy).
  if (f.release?.state === 'pushed' && !f.deploy && f.state === 'needs_owner' && f.hasDeployer && jenkins) return 'deploy';
  const releasable = !f.release || f.release.state === 'stopped' || f.release.state === 'reverted';
  if (roundCleared(f.lastRoundOutcome) && f.hasLiveWorkspace && f.hasStaging && releasable && (f.state === 'awaiting_approval' || f.state === 'needs_owner')) return 'release';
  return null;
}

export interface OverviewItem {
  id: string;
  title: string;
  state: string;
  group: TaskGroup;
  line: string;
  journey: Journey;
  projectName: string | null;
  createdAt: number;
  updatedAt: number;
  /** Counted tokens the task has used so far (the flow budget's usedTokens). */
  usedTokens: number;
}

function projectNameOf(task: TaskRow): string | null {
  const ws = getDb().prepare('SELECT repo_id FROM task_workspaces WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(task.id) as { repo_id: string } | undefined;
  const intake = taskMetadata(task)['intake'] as { repoId?: unknown } | undefined;
  const repoId = ws?.repo_id ?? (typeof intake?.repoId === 'string' ? intake.repoId : null);
  return repoId ? getRepo(repoId)?.name ?? null : null;
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type RunRow = { id: string; role: string; state: string; started_at: number; ended_at: number | null; log_path: string };
type Step = Extract<RunEventSummary, { kind: 'assistant' }>;

export function taskStory(taskId: string): TaskStory | null {
  const task = getTask(taskId);
  if (!task) return null;
  const flow = taskFlow(taskId)!;
  const db = getDb();
  const runs = db.prepare('SELECT id, role, state, started_at, ended_at, log_path FROM runs WHERE task_id = ? ORDER BY started_at').all(taskId) as RunRow[];
  const endedAt = (role: string) => runs.filter((r) => r.role === role && r.state === 'completed').at(-1)?.ended_at ?? task.updated_at;
  const created = new Map((db.prepare('SELECT round, created_at FROM task_rounds WHERE task_id = ?').all(taskId) as Array<{ round: number; created_at: number }>).map((r) => [r.round, r.created_at]));
  const brief = parseBrief(task.brief_json);
  const plan = parsePlan(task.plan_json);
  const messages = listMessages(taskId);
  const approvals = (db.prepare('SELECT id, action, state, payload_json, requested_at, resolved_at FROM approvals WHERE task_id = ? ORDER BY requested_at').all(taskId) as Array<{ id: string; action: string; state: string; payload_json: string; requested_at: number; resolved_at: number | null }>)
    .map((a) => ({ id: a.id, action: a.action, state: a.state, payload: parsePayload(a.payload_json), requestedAt: a.requested_at, resolvedAt: a.resolved_at }));
  const release = db.prepare('SELECT id, state, started_at, head_sha FROM releases WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(taskId) as { id: string; state: string; started_at: number; head_sha: string | null } | undefined;
  const deploy = db.prepare('SELECT id, state, started_at FROM deploys WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(taskId) as { id: string; state: string; started_at: number } | undefined;
  const projectName = projectNameOf(task);
  const note = taskMetadata(task)['note'];
  const has = projectHas(flow);
  const outcome = outcomeOf({
    state: task.state, approvals, ...has,
    release: release ? { state: release.state, at: release.started_at } : null,
    deploy: deploy ? { at: deploy.started_at } : null,
    lastRunAt: runs.at(-1)?.started_at ?? null,
  });
  const rounds = getRounds(taskId);
  const choices = stoppedChoices(taskId);
  const workspaces = getWorkspaces(taskId);
  const discarded = workspaces.length > 0 && workspaces.every((w) => w.removed_at !== null);
  const sendBack = canSendBack(taskId);
  // The Builder's own report for each round: its last finished run in that round.
  const builderSaid: Record<number, string> = {};
  for (const r of db.prepare(`SELECT round, result_text FROM runs WHERE task_id = ? AND role = 'coder' AND state = 'completed' AND result_text IS NOT NULL ORDER BY started_at`).all(taskId) as Array<{ round: number; result_text: string }>) {
    builderSaid[r.round] = r.result_text;
  }

  const items = buildStory({
    task: { id: task.id, title: task.title, description: task.description, state: task.state, createdAt: task.created_at, note: typeof note === 'string' ? note : null },
    projectName,
    brief: brief ? { summary: brief.summary, at: endedAt('analyst') } : null,
    plan: plan ? { summary: plan.summary, criteria: plan.criteria.length, at: endedAt('planner') } : null,
    questions: listQuestions(taskId).map((q) => ({ id: q.id, kind: q.kind, question: q.question, options: q.options, askedBy: q.askedBy, askedAt: q.askedAt, answer: q.answer, answeredAt: q.answeredAt })),
    rounds: rounds.map((r) => ({ ...r, createdAt: created.get(r.round) ?? task.updated_at })),
    notes: messages.filter((m) => m.author === 'owner' && m.kind === 'note').map((m) => ({ id: m.id, body: m.body, at: m.created_at })),
    agentEvents: messages.filter((m) => m.kind === 'event' && m.author !== 'fryday' && m.author !== 'owner').map((m) => ({ id: m.id, author: m.author, body: m.body, at: m.created_at })),
    approvals,
    release: release ? { id: release.id, state: release.state, at: release.started_at } : null,
    deploy: deploy ? { id: deploy.id, state: deploy.state, at: deploy.started_at } : null,
    outcome,
    runStarts: runs.map((r) => ({ role: r.role, at: r.started_at })),
    choices,
    discarded,
    builderSaid,
    canSendBack: sendBack,
  });

  const live = runs.filter((r) => r.state === 'running').at(-1);
  const step = live ? recentActivity(live.log_path, 5).filter((s): s is Step => s.kind === 'assistant').at(-1) : undefined;
  const now = live ? storyNow({ role: live.role, tools: step?.tools ?? [], toolInputs: step?.toolInputs ?? [], text: step?.text ?? '', since: live.started_at }) : null;

  return {
    task: { id: task.id, title: task.title, state: task.state, projectName, createdAt: task.created_at, budget: flow.budget },
    journey: journeyOf(flow, task.state, outcome),
    items,
    now,
    choices,
    discarded,
    canStop: canStop(taskId),
    canSendBack: sendBack,
    askAgain: askAgainOf({
      state: task.state, approvals, hasStaging: has.hasStaging, hasDeployer: has.hasDeployer,
      jenkinsReady: loadJenkinsCredentials() !== null,
      lastRoundOutcome: rounds.at(-1)?.outcome ?? null,
      hasLiveWorkspace: workspaces.some((w) => w.removed_at === null),
      release: release ? { state: release.state, head: release.head_sha } : null,
      head: workspaces.find((w) => w.removed_at === null)?.head_sha ?? null,
      deploy: deploy ?? null,
    }),
  };
}

/** The ending of a task for the overview, read with the same rules as its story. */
function storedOutcome(taskId: string, state: string, flow: TaskFlow): TaskOutcome {
  if (state !== 'needs_owner') return null;
  const db = getDb();
  const approvals = (db.prepare('SELECT action, state, requested_at, resolved_at FROM approvals WHERE task_id = ?').all(taskId) as Array<{ action: string; state: string; requested_at: number; resolved_at: number | null }>)
    .map((a) => ({ action: a.action, state: a.state, requestedAt: a.requested_at, resolvedAt: a.resolved_at }));
  const lastRun = db.prepare('SELECT MAX(started_at) AS at FROM runs WHERE task_id = ?').get(taskId) as { at: number | null } | undefined;
  const release = db.prepare('SELECT state, started_at FROM releases WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(taskId) as { state: string; started_at: number } | undefined;
  const deploy = db.prepare('SELECT started_at FROM deploys WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(taskId) as { started_at: number } | undefined;
  return outcomeOf({
    state, approvals, ...projectHas(flow),
    release: release ? { state: release.state, at: release.started_at } : null,
    deploy: deploy ? { at: deploy.started_at } : null,
    lastRunAt: lastRun?.at ?? null,
  });
}

export function tasksOverview(limit = 100): OverviewItem[] {
  const rows = getDb().prepare('SELECT id FROM tasks ORDER BY updated_at DESC LIMIT ?').all(limit) as Array<{ id: string }>;
  return rows.flatMap(({ id }) => {
    // One task whose stored facts cannot be read must not take the whole list down.
    try {
      const task = getTask(id);
      const flow = task ? taskFlow(id) : null;
      if (!task || !flow) return [];
      const outcome = storedOutcome(id, task.state, flow);
      const journey = journeyOf(flow, task.state, outcome);
      return [{
        id, title: task.title, state: task.state, group: groupOf(task.state, outcome), line: overviewLine(task.state, journey, outcome), journey,
        projectName: projectNameOf(task), createdAt: task.created_at, updatedAt: task.updated_at, usedTokens: flow.budget.usedTokens,
      }];
    } catch (err) {
      console.error('[fryday-core] overview: could not read', id, err);
      return [];
    }
  });
}
