import VerifyCard, { type Verification } from './VerifyCard';
import DeployCard, { type Deploy } from './DeployCard';
import AgentFlow, { type Flow, type FlowNodeId } from '../components/AgentFlow';
import AgentCrew from '../components/AgentCrew';
import { useNow } from '../components/Meters';
import { useRunActivity, toolLabel } from '../hooks/useRunActivity';
import { fmtDuration } from '../agents';
import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, ChevronDown, GitBranch, Trash2, Rocket, CheckCircle, XCircle, Undo2 } from 'lucide-react';
import clsx from 'clsx';
import { Avatar, Badge, Button, Card, Section, type BadgeTone } from '../ui';
import type { Actor } from '../storyTypes';
import { useSse, useCoreApi } from '../hooks/useSse';
import { BriefCard, QuestionsCard, ThreadCard, type Brief, type Question, type Attachment, type Message } from './TaskIntake';

interface Run {
  id: string;
  role: string;
  state: string;
  round: number;
  model: string | null;
  started_at: number;
  ended_at: number | null;
  deadline_at: number | null;
  token_limit: number | null;
  error_msg: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

interface Task {
  id: string;
  title: string;
  description: string;
  state: string;
  created_at: number;
  plan_json: string | null;
  metadata_json: string | null;
}

interface Plan {
  summary: string;
  approach: string;
  flow: Array<{ step: string; detail: string }>;
  files: string[];
  criteria: string[];
  testPlan: string[];
  risks: string[];
  questions: string[];
}

interface Check {
  name: string;
  cmd: string;
  status: 'passed' | 'failed' | 'preexisting' | 'timeout' | 'error';
  exitCode: number | null;
  durationMs: number;
  output: string;
  failures?: string[];
  newFailures?: string[];
  comparedBy?: 'failures' | 'exit-code';
}

interface Flag {
  severity: 'blocking' | 'review';
  kind: string;
  path: string;
  detail: string;
}

interface Verdict {
  verdict: 'pass' | 'fail';
  summary: string;
  criteria: Array<{ criterion: string; met: boolean; evidence: string }>;
  issues: Array<{ severity: 'blocking' | 'minor'; file: string; description: string }>;
}

interface Round {
  round: number;
  checks: Check[];
  flags: Flag[];
  verdict: Verdict | null;
  verify: Verification | null;
  outcome: 'passed' | 'changes_requested' | 'escalated' | 'accepted' | null;
}

const CHECK_STYLE: Record<Check['status'], { label: string; cls: string }> = {
  passed: { label: 'passed', cls: 'text-hud-green' },
  failed: { label: 'failed', cls: 'text-hud-red' },
  timeout: { label: 'timed out', cls: 'text-hud-red' },
  preexisting: { label: 'failing before this task', cls: 'text-hud-amber' },
  error: { label: 'could not run', cls: 'text-hud-red' },
};

const OUTCOME_STYLE: Record<NonNullable<Round['outcome']>, { label: string; tone: BadgeTone }> = {
  passed: { label: 'Passed', tone: 'ok' },
  changes_requested: { label: 'Sent back to the Builder', tone: 'warn' },
  escalated: { label: 'Handed to you', tone: 'bad' },
  accepted: { label: 'Accepted by you', tone: 'ok' },
};

const SUB = 'mb-1 text-xs font-semibold text-hud-dim';

type StageTone = 'done' | 'working' | 'waiting' | 'problem' | 'idle';
const STAGE_CHIP: Record<StageTone, { label: string; tone: BadgeTone }> = {
  done: { label: 'Done', tone: 'ok' },
  working: { label: 'Working', tone: 'accent' },
  waiting: { label: 'Needs you', tone: 'warn' },
  problem: { label: 'Problem', tone: 'bad' },
  idle: { label: 'Not yet', tone: 'neutral' },
};

/**
 * One member of the team on the task's timeline: who, how far they got, and one line of what
 * they did. Everything else about their part is inside, shown only when the row is opened.
 */
function StageRow({ actor, name, summary, tone, startOpen = false, last = false, children }: {
  actor: Actor; name: string; summary: string; tone: StageTone; startOpen?: boolean; last?: boolean; children?: ReactNode;
}) {
  const [open, setOpen] = useState(startOpen);
  const chip = STAGE_CHIP[tone];
  return (
    <div className="relative flex gap-3">
      {!last && <span aria-hidden className={clsx('absolute bottom-0 left-[17px] top-10 w-0.5 rounded', tone === 'idle' ? 'bg-hud-border' : tone === 'problem' ? 'bg-hud-red/40' : 'bg-hud-cyan/40')} />}
      <div className={clsx('relative z-10 mt-1.5 flex-shrink-0', tone === 'idle' && 'opacity-40')}><Avatar actor={actor} /></div>
      <div className="mb-3 min-w-0 flex-1">
        <button type="button" aria-expanded={open} disabled={!children} onClick={() => setOpen((o) => !o)}
          className={clsx('flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60',
            open ? 'border-hud-cyan/40 bg-hud-cyan/[0.06]' : 'border-hud-border hover:border-hud-cyan/30',
            tone === 'waiting' && !open && 'border-hud-amber/50', tone === 'problem' && !open && 'border-hud-red/40')}>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-hud-bright">{name}</span>
            <span className={clsx('block text-sm text-hud-dim', !open && 'truncate')}>{summary}</span>
          </span>
          <Badge tone={chip.tone} className={tone === 'working' ? 'animate-pulse motion-reduce:animate-none' : undefined}>{chip.label}</Badge>
          {children && <ChevronDown aria-hidden className={clsx('h-4 w-4 flex-shrink-0 text-hud-dim transition-transform', open && 'rotate-180')} />}
        </button>
        {open && children && <div className="mt-2">{children}</div>}
      </div>
    </div>
  );
}

const short = (text: string, max = 120) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat; };

/** A task's state in the words Home uses. */
const PLAIN_STATE: Record<string, string> = {
  queued: 'Waiting to start', intake: 'Understanding the task', waiting_owner: 'Has a question for you', workspace: 'Setting up',
  planning: 'Planning', coding: 'Building', testing: 'Checking', verifying: 'Trying it out', awaiting_approval: 'Waiting for your OK',
  releasing: 'Putting it on staging', deploying: 'Deploying staging', deployed: 'Live on staging', failed: 'Stopped', needs_owner: 'Stopped: needs you',
};

function PlanCard({ plan, verdict }: { plan: Plan; verdict: Verdict | null }) {
  // The tester answers the criteria in order; fall back to matching by text if the counts differ.
  const sameCount = verdict?.criteria.length === plan.criteria.length;
  const met = (criterion: string, index: number) =>
    sameCount ? verdict?.criteria[index] : verdict?.criteria.find((c) => c.criterion === criterion);
  return (
    <Section title="Plan" card className="mb-3">
      <p className="mb-2 text-sm text-hud-bright">{plan.summary}</p>
      <p className="mb-4 text-sm text-hud-dim">{plan.approach}</p>

      {plan.flow.length > 0 && (
        <div className="mb-4">
          <h3 className={SUB}>How it flows</h3>
          <ol className="flex flex-col gap-1.5">
            {plan.flow.map((f, i) => (
              <li key={i} className="flex items-baseline gap-2 text-sm">
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-hud-cyan/50 text-xs text-hud-cyan">{i + 1}</span>
                <span><span className="font-mono text-xs text-hud-cyan">{f.step}</span> <span className="text-hud-bright">{f.detail}</span></span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <h3 className={SUB}>Acceptance criteria</h3>
      <ul className="mb-4 space-y-1.5">
        {plan.criteria.map((c, i) => {
          const result = met(c, i);
          return (
            <li key={c} className="flex gap-2 text-sm">
              <span aria-hidden className={clsx('flex-shrink-0', result === undefined ? 'text-hud-dim' : result.met ? 'text-hud-green' : 'text-hud-red')}>
                {result === undefined ? '○' : result.met ? '✓' : '✗'}
              </span>
              <span>
                <span className="text-hud-bright">{c}</span>
                <span className="sr-only">{result === undefined ? ' (not checked yet)' : result.met ? ' (met)' : ' (not met)'}</span>
                {result && <span className="block text-xs text-hud-dim">{result.evidence}</span>}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="grid gap-4 text-sm sm:grid-cols-2">
        {plan.files.length > 0 && (
          <div><h3 className={SUB}>Files</h3>{plan.files.map((f) => <div key={f} className="break-all font-mono text-xs text-hud-bright">{f}</div>)}</div>
        )}
        {plan.testPlan.length > 0 && (
          <div><h3 className={SUB}>Test plan</h3>{plan.testPlan.map((t) => <div key={t} className="text-hud-bright">{t}</div>)}</div>
        )}
      </div>
      {plan.risks.length > 0 && (
        <div className="mt-4 text-sm"><h3 className="mb-1 text-xs font-semibold text-hud-amber">Risks</h3>{plan.risks.map((r) => <div key={r} className="text-hud-bright">{r}</div>)}</div>
      )}
      {plan.questions.length > 0 && (
        <div className="mt-4 rounded-xl border border-hud-amber/40 p-3 text-sm">
          <h3 className="mb-1 text-xs font-semibold text-hud-amber">Questions for you</h3>
          {plan.questions.map((q) => <div key={q} className="text-hud-bright">{q}</div>)}
        </div>
      )}
    </Section>
  );
}

function RoundCard({ round, taskId }: { round: Round; taskId: string }) {
  const outcome = round.outcome ? OUTCOME_STYLE[round.outcome] : null;
  return (
    <Card padding="sm" className="p-4 text-sm">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="font-semibold text-hud-bright">Round {round.round}</h3>
        {outcome
          ? <Badge tone={outcome.tone}>{outcome.label}</Badge>
          : <Badge tone="accent" className="animate-pulse motion-reduce:animate-none">In review</Badge>}
      </div>

      {round.checks.length === 0 && <p className="mb-1 text-hud-dim">No checks are configured for this project.</p>}
      {round.checks.map((c) => (
        <details key={c.name} className="mb-1.5">
          <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60">
            <span className={clsx('mr-3 inline-block min-w-[11rem] font-medium', CHECK_STYLE[c.status].cls)}>{c.name}: {CHECK_STYLE[c.status].label}</span>
            <span className="font-mono text-xs text-hud-dim">{c.cmd} · {(c.durationMs / 1000).toFixed(1)}s</span>
          </summary>
          {c.status === 'preexisting' && (
            <div className="mt-1 text-hud-amber">
              {c.comparedBy === 'failures'
                ? `Same ${c.failures?.length ?? 0} failure${c.failures?.length === 1 ? '' : 's'} as before this task; none are new.`
                : 'Already failing before this task. New failures could not be told apart from old ones, so this check cannot catch a regression.'}
            </div>
          )}
          {c.status === 'failed' && (c.newFailures?.length ?? 0) > 0 && (
            <div className="mt-1 text-hud-red">
              New with this task: {c.newFailures!.slice(0, 20).map((f) => <div key={f} className="break-words">· {f}</div>)}
            </div>
          )}
          <pre className="mt-1 max-h-64 overflow-x-auto whitespace-pre-wrap rounded-lg border border-hud-border bg-hud-bg p-2 font-mono text-xs text-hud-dim">{c.output.trim() || '(no output)'}</pre>
        </details>
      ))}

      {round.flags.map((f, i) => (
        <div key={i} className={clsx('mt-1', f.severity === 'blocking' ? 'text-hud-red' : 'text-hud-amber')}>
          {f.severity === 'blocking' ? 'Not allowed' : 'For your attention'} · <span className="break-all font-mono text-xs">{f.path}</span> · {f.detail}
        </div>
      ))}

      {round.verdict && (
        <div className="mt-3 border-t border-hud-border pt-3">
          <div className="mb-1">
            <span className="text-hud-dim">Checker: </span>
            <span className={clsx('font-semibold', round.verdict.verdict === 'pass' ? 'text-hud-green' : 'text-hud-red')}>{round.verdict.verdict === 'pass' ? 'pass' : 'fail'}</span>
            <span className="text-hud-bright"> · {round.verdict.summary}</span>
          </div>
          {round.verdict.issues.map((issue, i) => (
            <div key={i} className={clsx(issue.severity === 'blocking' ? 'text-hud-red' : 'text-hud-dim')}>
              [{issue.severity}] {issue.file && <span className="font-mono text-xs">{issue.file}: </span>}{issue.description}
            </div>
          ))}
        </div>
      )}
      {round.verify && <VerifyCard taskId={taskId} round={round.round} verify={round.verify} />}
    </Card>
  );
}

interface Approval {
  id: string;
  action: string;
  payload_json: string;
  commit_sha: string | null;
  state: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
}

interface Release {
  state: 'running' | 'pushed' | 'stopped' | 'reverted';
  outcome: string | null;
  stg_branch: string;
  strategy: string | null;
  stg_before_sha: string | null;
  merge_sha: string | null;
  twin_branch: string | null;
  attempts: number | null;
  revert_sha: string | null;
}

const RELEASE_STYLE: Record<Release['state'], { label: string; tone: BadgeTone }> = {
  running: { label: 'Releasing', tone: 'accent' },
  pushed: { label: 'On staging', tone: 'ok' },
  stopped: { label: 'Not released', tone: 'bad' },
  reverted: { label: 'Reverted', tone: 'warn' },
};

interface Workspace {
  repoId: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  headSha: string | null;
  worktreePath: string;
  removed: boolean;
  files: Array<{ status: string; path: string }>;
  /** The existing branch this task continues, if any. */
  targetBranch: string | null;
  targetOwned: boolean | null;
  pushedRef: string | null;
  pushedSha: string | null;
}

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<Task | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [deploy, setDeploy] = useState<Deploy | null>(null);
  const [picked, setPicked] = useState<FlowNodeId | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [release, setRelease] = useState<Release | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [thread, setThread] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const api = useCoreApi();

  const refresh = () => {
    if (!id) return;
    api.get(`/tasks/${id}`).then((d) => {
      setTask(d.task);
      setRuns(d.runs ?? []);
      setFlow(d.flow ?? null);
      setDeploy(d.deploy ?? null);
      setWorkspaces(d.workspaces ?? []);
      setRounds(d.rounds ?? []);
      setApproval(d.approval ?? null);
      setRelease(d.release ?? null);
      setBrief(d.brief ?? null);
      setQuestions(d.questions ?? []);
      setAttachments(d.attachments ?? []);
      setThread(d.thread ?? []);
    }).catch(() => {});
  };

  useEffect(() => { refresh(); setPicked(null); }, [id]);
  // A busy agent sends many events; the page is refetched at most about once a second.
  const pendingRefresh = useRef<number | null>(null);
  const refreshSoon = () => {
    if (pendingRefresh.current !== null) return;
    pendingRefresh.current = window.setTimeout(() => { pendingRefresh.current = null; refresh(); }, 900);
  };
  useEffect(() => () => { if (pendingRefresh.current !== null) clearTimeout(pendingRefresh.current); }, []);
  useSse(`/api/events?taskId=${id}`, (ev) => {
    if (ev['type'] === 'run_event') { refreshSoon(); return; }
    if (['task_updated', 'run_started', 'run_exit', 'workspace_ready', 'workspace_removed', 'plan_ready', 'round_updated', 'approval_requested', 'approval_resolved', 'release_updated', 'brief_ready', 'questions_updated', 'task_message', 'workspace_updated', 'deploy_updated'].includes(ev['type'] as string)) refresh();
  });

  /** Run an owner action; whatever goes wrong is shown, never swallowed. */
  const act = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      refresh();
    } catch (err) {
      let message = String(err instanceof Error ? err.message : err);
      try { message = JSON.parse(message).error ?? message; } catch { /* not JSON */ }
      setError(message);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const resolve = (decision: 'approved' | 'rejected') => {
    if (!approval) return;
    const payload = (() => { try { return JSON.parse(approval.payload_json); } catch { return {}; } })();
    // Anything that leaves the machine asks twice, and says exactly what is pushed.
    const pushes = Array.isArray(payload.pushes) ? `\n\nThis pushes to the shared remote:\n${(payload.pushes as string[]).map((p) => `• ${p}`).join('\n')}` : '\n\nThis pushes to the shared remote.';
    if (decision === 'approved' && approval.action === 'release_stg'
      && !window.confirm(`${payload.summary ?? 'Release this task'}?${pushes}\n\nIt can be reverted afterwards, not undone.`)) return;
    if (decision === 'approved' && approval.action === 'push_branch'
      && !window.confirm(`${payload.summary ?? 'Push this branch'}?${pushes}\n\nNothing is forced. A push cannot be taken back.`)) return;
    const effects = Array.isArray(payload.effects) ? `\n\n${(payload.effects as string[]).map((e) => `• ${e}`).join('\n')}` : '';
    if (decision === 'approved' && approval.action === 'deploy_stg'
      && !window.confirm(`${payload.summary ?? 'Deploy staging'}?${effects}\n\nA deploy cannot be taken back; revert on staging and deploy again to undo it.`)) return;
    if (decision === 'approved' && approval.action === 'deploy_input'
      && !window.confirm(`${payload.summary ?? 'Answer the Jenkins prompt'}${effects}`)) return;
    void act(() => api.post(`/approvals/${approval.id}/resolve`, { decision }));
  };

  const revert = () => {
    if (!release || !window.confirm(`Revert this task on ${release.stg_branch}?\n\nA new commit that undoes the merge is pushed to ${release.stg_branch}. History is kept.`)) return;
    void act(() => api.post(`/tasks/${id}/release/revert`, {}));
  };

  const askAgain = () => void act(() => api.post(`/tasks/${id}/approval`, {}));

  const discard = async () => {
    if (!id) return;
    const names = workspaces.filter((w) => !w.removed).map((w) => w.branch).join(', ');
    if (!window.confirm(`Delete the worktree and the local branch ${names}? Work on it that was not merged is lost.`)) return;
    try {
      setError('');
      await api.del(`/tasks/${id}/workspace`);
      refresh();
    } catch (err) {
      let message = String(err instanceof Error ? err.message : err);
      try { message = JSON.parse(message).error ?? message; } catch { /* not JSON */ }
      setError(message);
    }
  };

  // The node shown in detail: the one picked, else wherever the task is now.
  const focus: FlowNodeId | null = picked ?? flow?.current?.node ?? null;
  const liveRunId = flow?.current ? flow.nodes.find((n) => n.id === flow.current!.node)?.liveRunId ?? null : null;
  const liveSteps = useRunActivity(liveRunId, true);
  const now = useNow(Boolean(flow?.current));
  const lastStep = liveSteps.length ? liveSteps[liveSteps.length - 1]! : null;
  const liveText = !lastStep ? (liveRunId ? 'starting…' : null)
    : lastStep.tools.length ? lastStep.tools.map((t, i) => [toolLabel(t), lastStep.toolInputs[i]].filter(Boolean).join(' · ')).join('  ')
    : lastStep.text.split('\n')[0]!.slice(0, 120);

  if (!task) return <div role="status" className="p-6 text-sm text-hud-dim">Loading…</div>;

  const plan = (() => { try { return task.plan_json ? (JSON.parse(task.plan_json) as Plan) : null; } catch { return null; } })();
  const lastVerdict = [...rounds].reverse().find((r) => r.verdict)?.verdict ?? null;
  const note = (() => { try { return task.metadata_json ? (JSON.parse(task.metadata_json).note as string | undefined) : undefined; } catch { return undefined; } })();
  const liveWorkspaces = workspaces.filter((w) => !w.removed);
  const pending = approval?.state === 'pending' ? approval : null;
  const pendingPayload = (() => { try { return pending ? JSON.parse(pending.payload_json) : {}; } catch { return {}; } })();
  const lastRoundPassed = rounds.length > 0 && rounds[rounds.length - 1]!.outcome === 'passed';
  const canAskAgain = !pending && lastRoundPassed && liveWorkspaces.length > 0 && (!release || release.state === 'stopped' || release.state === 'reverted')
    && ['awaiting_approval', 'needs_owner'].includes(task.state);

  // How far each member of the team got, for the timeline.
  const lastRound = rounds[rounds.length - 1];
  const stage: Record<'understand' | 'plan' | 'build' | 'check' | 'release', StageTone> = {
    understand: brief ? 'done' : task.state === 'waiting_owner' ? 'waiting' : task.state === 'intake' ? 'working' : 'idle',
    plan: plan ? 'done' : task.state === 'planning' || task.state === 'workspace' ? 'working' : 'idle',
    build: task.state === 'coding' ? 'working' : rounds.length > 0 ? 'done' : 'idle',
    check: task.state === 'testing' || task.state === 'verifying' ? 'working'
      : !lastRound ? 'idle'
      : lastRound.outcome === 'passed' || lastRound.outcome === 'accepted' ? 'done'
      : lastRound.outcome === 'escalated' ? 'waiting'
      : 'working',
    release: pending ? 'waiting'
      : task.state === 'releasing' || task.state === 'deploying' ? 'working'
      : deploy && (deploy.state === 'failed' || deploy.state === 'stopped') ? 'problem'
      : release?.state === 'stopped' ? 'problem'
      : deploy?.state === 'succeeded' || release?.state === 'pushed' ? 'done'
      : 'idle',
  };
  const points = lastRound?.verdict?.criteria ?? [];
  const open = points.filter((c) => !c.met).length;
  const checkLine = !lastRound ? 'Runs the project\'s own checks, then reviews the change against the plan.'
    : stage.check === 'working' && lastRound.outcome === null ? `Checking round ${lastRound.round}…`
    : lastRound.outcome === 'passed' ? `Passed on round ${lastRound.round}${points.length ? `: all ${points.length} points met` : ''}.`
    : lastRound.outcome === 'accepted' ? `You accepted it on round ${lastRound.round} with ${open} point${open === 1 ? '' : 's'} open.`
    : lastRound.outcome === 'escalated' ? `Still not passing after ${lastRound.round} rounds${open ? `: ${open} point${open === 1 ? '' : 's'} open` : ''}. Your call.`
    : `Sent round ${lastRound.round} back to the Builder${open ? `: ${open} point${open === 1 ? '' : 's'} open` : ''}.`;
  const releaseLine = pending ? `Waiting for your OK: ${short(String(pendingPayload.summary ?? 'a decision'), 90)}`
    : task.state === 'releasing' ? 'Putting the change on staging…'
    : task.state === 'deploying' ? 'Deploying staging with Jenkins…'
    : deploy?.state === 'succeeded' ? 'The staging server is running the new version.'
    : deploy && (deploy.state === 'failed' || deploy.state === 'stopped') ? `On staging, but the deploy did not finish${deploy.build_number ? ` (Jenkins #${deploy.build_number})` : ''}.`
    : release?.state === 'pushed' ? `The change is on ${release.stg_branch}.`
    : release?.state === 'reverted' ? 'The change was taken back off staging.'
    : release?.state === 'stopped' ? 'Releasing stopped before anything changed on staging.'
    : 'Puts the change on staging when you approve. Nothing is pushed without your yes.';

  // The files of the workspace still in use; a discarded one's, when that is all there is.
  const changedFiles = (liveWorkspaces[0] ?? workspaces[0])?.files ?? [];

  const stateTone: BadgeTone = task.state === 'deployed' ? 'ok' : task.state === 'failed' ? 'bad' : ['awaiting_approval', 'needs_owner', 'waiting_owner'].includes(task.state) ? 'warn' : 'accent';
  const pushLabel = pending && pending.action === 'push_branch' ? 'Push' : pending && (pending.action === 'deploy_stg' || pending.action === 'deploy_input') ? 'Deploy' : pending && pending.action !== 'release_stg' ? 'Your decision' : 'Release';

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6">
      <Link to="/tasks" className="mb-3 inline-flex items-center gap-1 rounded text-sm text-hud-dim hover:text-hud-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Tasks
      </Link>

      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 font-mono text-xs text-hud-dim">{task.id}</div>
          <h1 title={task.title} className="line-clamp-2 break-words text-lg font-semibold leading-snug tracking-tight text-hud-bright">{task.title}</h1>
        </div>
        <Badge tone={stateTone} dot className="mt-1">{PLAIN_STATE[task.state] ?? task.state.replace('_', ' ')}</Badge>
      </div>
      <p className="mb-2 text-sm text-hud-dim">Who did what, top to bottom. Open a row to see its details. To talk to the team, use the chat on Home.</p>

      {note && (
        <div role="status" className={clsx('mb-3 rounded-xl border p-3 text-sm', task.state === 'failed' ? 'border-hud-red/40 text-hud-red' : task.state === 'deployed' ? 'border-hud-green/40 text-hud-green' : 'border-hud-amber/40 text-hud-amber')}>
          {note}
        </div>
      )}

      <QuestionsCard
        questions={questions}
        busy={busy}
        onAnswer={(qid, answer) => void act(() => api.post(`/tasks/${id}/questions/${qid}/answer`, { answer }))}
        onSkip={() => void act(() => api.post(`/tasks/${id}/questions/skip`, {}))}
      />

      {/* The team, top to bottom: one row each, one line each. Open a row for its details. */}
      <div className="mt-4">
        <StageRow actor="you" name="You asked" summary={short(task.description || task.title)} tone="done">
          <Card padding="sm" className="p-4 text-sm leading-relaxed text-hud-bright whitespace-pre-wrap">{task.description || task.title}</Card>
        </StageRow>

        <StageRow actor="understander" name="Understander" tone={stage.understand} startOpen={stage.understand === 'waiting'}
          summary={brief ? short(brief.summary) : stage.understand === 'idle' ? 'Reads your words and the project.' : 'Reading your words and the project…'}>
          {brief ? <BriefCard brief={brief} attachments={attachments} /> : undefined}
        </StageRow>

        <StageRow actor="planner" name="Planner" tone={stage.plan}
          summary={plan && Array.isArray(plan.criteria) ? `A plan with ${plan.criteria.length} point${plan.criteria.length === 1 ? '' : 's'} to meet${lastVerdict ? `; ${lastVerdict.criteria.filter((c) => c.met).length} confirmed` : ''}.` : stage.plan === 'working' ? 'Writing the plan…' : 'Writes the plan and what must be true when it is done.'}>
          {plan && Array.isArray(plan.criteria) ? <PlanCard plan={plan} verdict={lastVerdict} /> : undefined}
        </StageRow>

        <StageRow actor="builder" name="Builder" tone={stage.build}
          summary={changedFiles.length > 0 ? `Changed ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} in ${rounds.length || 1} go${(rounds.length || 1) === 1 ? '' : 'es'}.` : stage.build === 'working' ? 'Writing the change…' : 'Writes the change in its own copy of the project.'}>
          {changedFiles.length > 0 ? (
            <Card padding="sm" className="p-4 text-sm">
              <p className="mb-2 text-xs text-hud-dim">Your own copy of the project is not touched until you approve.</p>
              <ul className="space-y-1">
                {changedFiles.map((f) => (
                  <li key={f.path} className="flex gap-2">
                    <span className={clsx('w-16 flex-shrink-0 text-xs', f.status.startsWith('A') ? 'text-hud-green' : f.status.startsWith('D') ? 'text-hud-red' : 'text-hud-amber')}>
                      {f.status.startsWith('A') ? 'added' : f.status.startsWith('D') ? 'removed' : 'changed'}
                    </span>
                    <code className="break-all font-mono text-xs text-hud-bright">{f.path}</code>
                  </li>
                ))}
              </ul>
            </Card>
          ) : undefined}
        </StageRow>

        <StageRow actor="checker" name="Checker" tone={stage.check} startOpen={stage.check === 'waiting'} summary={checkLine}>
          {rounds.length > 0 ? (
            <div className="space-y-2">
              <RoundCard round={rounds[rounds.length - 1]!} taskId={task.id} />
              {rounds.length > 1 && (
                <details>
                  <summary className="cursor-pointer rounded text-sm text-hud-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60">
                    Earlier rounds ({rounds.length - 1})
                  </summary>
                  <div className="mt-2 space-y-2">
                    {rounds.slice(0, -1).reverse().map((r) => <RoundCard key={r.round} round={r} taskId={task.id} />)}
                  </div>
                </details>
              )}
            </div>
          ) : undefined}
        </StageRow>

        <StageRow actor="releaser" name="Releaser" tone={stage.release} startOpen={stage.release === 'waiting' || stage.release === 'problem'} summary={releaseLine} last>
          {pending || release || canAskAgain || deploy ? (
            <div>
          {/* Release: the owner's yes, and what happened to it */}
          {(pending || release || canAskAgain) && (
            <Card padding="sm" className={clsx('mb-3 p-4', pending && 'border-hud-amber/60')}>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-hud-bright">
                  <Rocket className="h-4 w-4 text-hud-cyan" aria-hidden /> {pushLabel}
                </h2>
                {release && <Badge tone={RELEASE_STYLE[release.state].tone} className={release.state === 'running' ? 'animate-pulse motion-reduce:animate-none' : undefined}>{RELEASE_STYLE[release.state].label}</Badge>}
              </div>

              {pending && (
                <div>
                  <div className="mb-1 text-sm text-hud-bright">{pendingPayload.summary ?? 'Release this task'}</div>
                  {Array.isArray(pendingPayload.pushes) && (
                    <ul className="mb-2 space-y-0.5 font-mono text-xs text-hud-bright">
                      {(pendingPayload.pushes as string[]).map((p) => <li key={p}><span className="text-hud-amber">pushes</span> {p}</li>)}
                      {((pendingPayload.notPushed ?? []) as string[]).map((p) => <li key={p} className="text-hud-dim">{p}</li>)}
                    </ul>
                  )}
                  {Array.isArray(pendingPayload.effects) && (
                    <ul className="mb-2 space-y-0.5 text-sm text-hud-bright">
                      {(pendingPayload.effects as string[]).map((e) => <li key={e}><span className="text-hud-amber">·</span> {e}</li>)}
                    </ul>
                  )}
                  {pending.action === 'release_stg' && (
                    <div className="mb-3 text-xs text-hud-dim">
                      Commit <code className="font-mono">{(pending.commit_sha ?? '').slice(0, 8)}</code> · {pendingPayload.filesChanged ?? 0} file{pendingPayload.filesChanged === 1 ? '' : 's'} · {pendingPayload.rounds ?? 0} review round{pendingPayload.rounds === 1 ? '' : 's'}{pendingPayload.verified ? ` · ${pendingPayload.verified}` : ''}
                      {pendingPayload.flaggedForAttention > 0 && <span className="text-hud-amber"> · {pendingPayload.flaggedForAttention} flagged for your attention</span>}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="success" onClick={() => resolve('approved')} disabled={busy} icon={<CheckCircle className="h-4 w-4" aria-hidden />}>
                      {pending.action === 'release_stg' ? 'Approve and merge' : pending.action === 'push_branch' ? 'Approve and push' : pending.action === 'deploy_stg' ? 'Approve and deploy' : pending.action === 'deploy_input' ? `Answer "${pendingPayload.summary?.match(/Answer "([^"]+)"/)?.[1] ?? 'Proceed'}"` : 'Yes, continue'}
                    </Button>
                    <Button variant="secondary" onClick={() => resolve('rejected')} disabled={busy} icon={<XCircle className="h-4 w-4" aria-hidden />}>
                      {['release_stg', 'push_branch', 'deploy_stg', 'deploy_input'].includes(pending.action) ? 'Decline' : 'No, stop here'}
                    </Button>
                  </div>
                </div>
              )}

              {release && (release.merge_sha || release.revert_sha) && (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-hud-dim">
                  <span>{release.stg_branch}</span>
                  {release.strategy && <span>{release.strategy === 'twin' ? `twin ${release.twin_branch}` : 'merge'}</span>}
                  {release.stg_before_sha && release.merge_sha && <span>{release.stg_before_sha.slice(0, 8)} → <span className="text-hud-bright">{release.merge_sha.slice(0, 8)}</span></span>}
                  {(release.attempts ?? 1) > 1 && <span>{release.attempts} tries</span>}
                  {release.revert_sha && <span className="text-hud-amber">reverted by {release.revert_sha.slice(0, 8)}</span>}
                </div>
              )}

              <div className="mt-2 flex flex-wrap gap-2">
                {release?.state === 'pushed' && release.merge_sha && (
                  <Button size="sm" variant="secondary" onClick={revert} disabled={busy} icon={<Undo2 className="h-3.5 w-3.5" aria-hidden />}>Revert on {release.stg_branch}</Button>
                )}
                {canAskAgain && (
                  <Button size="sm" variant="secondary" onClick={askAgain} disabled={busy} icon={<Rocket className="h-3.5 w-3.5" aria-hidden />}>Ask me again to release</Button>
                )}
              </div>
              {error && <p role="alert" className="mt-2 text-sm text-hud-red">{error}</p>}
            </Card>
          )}

          {deploy && (
            <DeployCard deploy={deploy} busy={busy}
              canAskAgain={!pending && release?.state === 'pushed' && ['failed', 'stopped'].includes(deploy.state)}
              onAskAgain={() => void act(() => api.post(`/tasks/${id}/deploy`, {}))} />
          )}
          {!deploy && !pending && release?.state === 'pushed' && task.state === 'needs_owner' && (
            <Button className="mb-3" size="sm" variant="secondary" onClick={() => void act(() => api.post(`/tasks/${id}/deploy`, {}))} disabled={busy} icon={<Rocket className="h-3.5 w-3.5" aria-hidden />}>
              Deploy {release.stg_branch} with Jenkins
            </Button>
          )}
            </div>
          ) : undefined}
        </StageRow>
      </div>

      {/* Everything an engineer may want, out of the way of everyone else */}
      <details className="mt-6 rounded-xl border border-hud-border">
        <summary className="cursor-pointer rounded-xl px-4 py-3 text-sm font-semibold text-hud-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60">
          For engineers: tokens, branch and the raw thread
        </summary>
        <div className="px-4 pb-4 pt-1">
      {/* The agents: who has the task, how it got there, and the tokens each used */}
      {flow && (
        <Section title="Agents" card className="mb-3"
          actions={<span className="text-xs text-hud-dim">{flow.current
            ? `${flow.current.node === 'owner' ? 'Waiting for you' : `With the ${flow.nodes.find((n) => n.id === flow.current!.node)?.label}`} for ${fmtDuration(now - flow.current.since)}`
            : task.state.replace('_', ' ')}</span>}>
          <div className="-mx-1 overflow-x-auto px-1">
            <AgentFlow flow={flow} selected={focus} onSelect={(n) => setPicked(n)} liveText={liveText} />
          </div>
          <AgentCrew flow={flow} runs={runs} selected={focus} onSelect={(n) => setPicked(n)} />
        </Section>
      )}

      {/* Workspaces */}
      {workspaces.length > 0 && (
        <Section title="Workspace" card className="mb-3"
          actions={liveWorkspaces.length > 0 && <Button size="sm" variant="danger" onClick={discard} icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}>Discard</Button>}>
          {error && <p role="alert" className="mb-2 text-sm text-hud-red">{error}</p>}
          <div className="space-y-4 text-sm">
            {workspaces.map((w) => (
              <div key={w.repoId} className={clsx('space-y-1', w.removed && 'opacity-60')}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <GitBranch aria-hidden className="h-3.5 w-3.5 text-hud-dim" />
                  <span className="font-semibold text-hud-cyan">{w.repoId}</span>
                  <code className="break-all font-mono text-xs text-hud-bright">{w.branch}</code>
                  <span className="text-xs text-hud-dim">from <code className="font-mono">{w.baseRef}</code> @ <code className="font-mono">{w.baseSha.slice(0, 8)}</code></span>
                  {w.headSha && <span className="text-xs text-hud-dim">head <code className="font-mono">{w.headSha.slice(0, 8)}</code></span>}
                  {w.removed && <Badge tone="bad">Discarded</Badge>}
                </div>
                {w.targetBranch && (
                  <div className={clsx('text-xs', w.targetOwned ? 'text-hud-green' : 'text-hud-amber')}>
                    Continues <code className="font-mono">{w.targetBranch}</code>: {w.targetOwned ? 'your own branch, so work can be pushed back to it when you approve' : 'it has commits by other people, so it is never pushed to and the work goes back as a pull request'}
                    {w.pushedRef && <span className="text-hud-bright"> · pushed to <code className="font-mono">{w.pushedRef}</code> @ <code className="font-mono">{(w.pushedSha ?? '').slice(0, 8)}</code></span>}
                  </div>
                )}
                {!w.removed && <div className="break-all font-mono text-xs text-hud-dim">{w.worktreePath}</div>}
                {w.files.length > 0 && (
                  <div className="pt-1">
                    <div className="mb-0.5 text-xs text-hud-dim">{w.files.length} file{w.files.length === 1 ? '' : 's'} changed</div>
                    {w.files.map((f) => (
                      <div key={f.path} className="flex gap-2 font-mono text-xs">
                        <span className={clsx('w-4', f.status.startsWith('A') ? 'text-hud-green' : f.status.startsWith('D') ? 'text-hud-red' : 'text-hud-amber')}>{f.status[0]}</span>
                        <span className="break-all text-hud-bright">{f.path}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      <ThreadCard messages={thread} busy={busy} onSay={(body) => void act(() => api.post(`/tasks/${id}/messages`, { body }))} />
        </div>
      </details>
    </div>
  );
}
