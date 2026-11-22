/**
 * The agents of one task: a card each with the tokens it used and, while it works, its clock
 * and limits; below, step by step, what the chosen agent did.
 */

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Badge, type BadgeTone } from '../ui';
import { look, fmtTokens, countedTokens, modelName } from '../agents';
import { TokenBar, BudgetBar, ClockBar, RunTokenBar } from './Meters';
import { useRunActivity, toolLabel } from '../hooks/useRunActivity';
import type { Flow, FlowNode, FlowNodeId } from './AgentFlow';

export interface CrewRun {
  id: string;
  role: string;
  round: number;
  state: string;
  model: string | null;
  started_at: number;
  ended_at: number | null;
  deadline_at: number | null;
  token_limit: number | null;
  engine?: string | null;
  error_msg: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

const ROLE_OF_NODE: Partial<Record<FlowNodeId, string>> = {
  analyst: 'analyst', planner: 'planner', coder: 'coder', reviewer: 'tester', api_tester: 'api_tester', ui_tester: 'ui_tester',
};

const STATE_CHIP: Record<FlowNode['state'], { label: string; tone: BadgeTone }> = {
  idle: { label: 'Not yet', tone: 'neutral' },
  active: { label: 'Working', tone: 'accent' },
  waiting: { label: 'Waiting for you', tone: 'warn' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Sent it back', tone: 'bad' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

function AgentCard({ node, runs, selected, onSelect }: { node: FlowNode; runs: CrewRun[]; selected: boolean; onSelect: () => void }) {
  const l = look(node.id);
  const Icon = l.icon;
  const live = runs.find((r) => r.id === node.liveRunId);
  const lastRun = runs[runs.length - 1];
  const chip = node.state === 'failed' && lastRun && ['budget', 'timeout', 'killed', 'failed'].includes(lastRun.state)
    ? { label: node.detail, tone: 'bad' as BadgeTone }
    : STATE_CHIP[node.state];
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected}
      className={clsx('flow-in rounded-xl border bg-hud-bg p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60',
        selected ? 'border-hud-cyan ring-2 ring-hud-cyan/15' : 'border-hud-border hover:border-hud-cyan/40')}>
      <div className="mb-2 flex items-center gap-2">
        <span aria-hidden className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full" style={{ background: `${l.color}22`, color: l.color }}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold text-hud-bright">{l.name}</span>
        <Badge tone={chip.tone} dot={node.state === 'active'} className="ml-auto">{chip.label}</Badge>
      </div>
      <div className="mb-1.5 flex gap-2 text-xs text-hud-dim">
        <span>{runs.length} run{runs.length === 1 ? '' : 's'}</span>
        {lastRun?.model && <span>{modelName(lastRun.model)}</span>}
        <span className="ml-auto tabular-nums text-hud-bright" title="Input, output and cache writes; reused context is not counted">{fmtTokens(countedTokens(node.usage))} tokens</span>
      </div>
      <TokenBar usage={node.usage} />
      {live && (
        <div className="mt-2 space-y-1.5">
          <ClockBar startedAt={live.started_at} deadlineAt={live.deadline_at} />
          {live.token_limit !== null && live.engine !== 'cursor' && <RunTokenBar usage={live.usage} limit={live.token_limit} />}
        </div>
      )}
    </button>
  );
}

function Activity({ node, runs }: { node: FlowNode; runs: CrewRun[] }) {
  const [runId, setRunId] = useState<string | null>(null);
  const chosen = runs.find((r) => r.id === runId) ?? runs[runs.length - 1] ?? null;
  const live = chosen?.state === 'running';
  const steps = useRunActivity(chosen?.id ?? null, live);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { setRunId(null); }, [node.id]);
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [steps.length]);

  if (!ROLE_OF_NODE[node.id]) {
    const about: Record<string, string> = {
      checks: "FryDay runs the project's own test, lint and typecheck commands itself, in the sandbox, on a clean copy of each round. No model, no tokens. The results are in the review rounds below.",
      owner: 'Questions and approvals wait here for you. Nothing leaves this computer without your yes.',
      release: 'On your yes, FryDay pushes and merges into the staging branch itself, never with force. No model, no tokens.',
      deploy: "On your yes, FryDay starts the project's Jenkins job and follows it. Each staging prompt in the pipeline is asked of you; a prompt about production is never answered. It counts as deployed only when the build is shown to contain the merge. No model, no tokens.",
    };
    return <div className="text-sm text-hud-dim">{about[node.id]}</div>;
  }
  if (!chosen) return <div className="text-sm text-hud-dim">{look(node.id).name} has not worked on this task yet.</div>;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-sm font-semibold text-hud-bright">{look(node.id).name}</span>
        {runs.length > 1 && runs.map((r, i) => (
          <button key={r.id} type="button" onClick={() => setRunId(r.id)} aria-pressed={r.id === chosen.id}
            className={clsx('rounded-full border px-2 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60', r.id === chosen.id ? 'border-hud-cyan bg-hud-cyan/10 font-medium text-hud-cyan' : 'border-hud-border text-hud-dim hover:text-hud-bright')}>
            {r.round > 0 ? `Round ${r.round}` : `Run ${i + 1}`}
          </button>
        ))}
        <span className="text-hud-dim">{chosen.state === 'running' ? '· live' : `· ${chosen.state}`}</span>
        <span className="ml-auto tabular-nums text-hud-dim">
          {fmtTokens(countedTokens(chosen.usage))} tokens · {fmtTokens(chosen.usage.cacheReadTokens)} reused
        </span>
      </div>
      {chosen.error_msg && chosen.state !== 'completed' && chosen.state !== 'running' && <div className="text-hud-red text-sm mb-2">{chosen.error_msg}</div>}
      <div ref={list} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        className="max-h-72 overflow-y-auto space-y-1 pr-1" aria-live={live ? 'polite' : undefined}>
        {steps.length === 0 && <div className="text-sm text-hud-dim">{live ? 'Starting…' : 'Nothing recorded.'}</div>}
        {steps.map((s, i) => (
          <div key={i} className={clsx('rounded px-2 py-1 border border-transparent', s.at && Date.now() - s.at < 2000 && 'step-new')}>
            {s.tools.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {s.tools.map((t, j) => (
                  <span key={j} className="inline-flex max-w-full items-center gap-1 rounded-md border border-hud-border bg-hud-surface px-1.5 py-0.5 font-mono text-xs">
                    <span style={{ color: look(node.id).color }}>{toolLabel(t)}</span>
                    {s.toolInputs[j] && <span className="text-hud-dim truncate">{s.toolInputs[j]}</span>}
                  </span>
                ))}
              </div>
            )}
            {s.text && <div className="text-sm text-hud-bright whitespace-pre-wrap break-words line-clamp-3">{s.text}</div>}
          </div>
        ))}
        {live && <div className="cursor-blink px-2 text-xs text-hud-dim">Working</div>}
      </div>
    </div>
  );
}

export default function AgentCrew({ flow, runs, selected, onSelect }: {
  flow: Flow;
  runs: CrewRun[];
  selected: FlowNodeId | null;
  onSelect: (id: FlowNodeId) => void;
}) {
  const runsOf = (id: FlowNodeId) => runs.filter((r) => r.role === ROLE_OF_NODE[id]).sort((a, b) => a.started_at - b.started_at);
  const shown = flow.nodes.filter((n) => n.kind === 'agent' && (n.runs > 0 || n.state === 'active'));
  const reused = flow.nodes.reduce((sum, n) => sum + n.usage.cacheReadTokens, 0);
  const focus = flow.nodes.find((n) => n.id === selected) ?? null;

  return (
    <div>
      <div className="grid sm:grid-cols-[1fr_auto] gap-3 items-end mt-1 mb-3">
        <BudgetBar usedTokens={flow.budget.usedTokens} limitTokens={flow.budget.limitTokens} />
        <div className="text-xs tabular-nums text-hud-dim">{fmtTokens(flow.budget.usedTokens)} tokens on this task · {fmtTokens(reused)} reused</div>
      </div>
      {shown.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 mb-3">
          {shown.map((n) => <AgentCard key={n.id} node={n} runs={runsOf(n.id)} selected={selected === n.id} onSelect={() => onSelect(n.id)} />)}
        </div>
      )}
      {focus && (
        <div className="border-t border-hud-border pt-3">
          <Activity node={focus} runs={runsOf(focus.id)} />
        </div>
      )}
    </div>
  );
}
