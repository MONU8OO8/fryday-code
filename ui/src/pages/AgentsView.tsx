/**
 * Activity: who is working now and on what, where the tokens went by agent, and every
 * recent run.
 */

import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Square, Gauge, Cpu } from 'lucide-react';
import clsx from 'clsx';
import { useSse, useCoreApi } from '../hooks/useSse';
import { toolLabel } from '../hooks/useRunActivity';
import { Badge, Button, Card, EmptyState, PageHeader, Section, type BadgeTone } from '../ui';
import { look, fmtTokens, countedTokens, fmtDuration, modelName } from '../agents';
import { TokenBar, ClockBar, RunTokenBar } from '../components/Meters';

interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
interface AgentRun {
  id: string;
  task_id: string | null;
  role: string;
  round: number;
  state: string;
  model: string | null;
  started_at: number;
  ended_at: number | null;
  deadline_at: number | null;
  /** Most counted tokens this run may use. */
  token_limit: number | null;
  /** The engine it ran on: claude, or cursor (reduced isolation, uses the Cursor plan). */
  engine?: string;
  is_active: boolean;
  error_msg: string | null;
  usage: Usage;
  last: { text: string; tools: string[]; toolInputs: string[] } | null;
}
interface RoleUsage extends Usage { role: string; runs: number; budgetStops: number; model: string | null }

const STATE: Record<string, { label: string; tone: BadgeTone }> = {
  completed: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  killed: { label: 'Stopped', tone: 'warn' },
  budget: { label: 'Token limit', tone: 'warn' },
  timeout: { label: 'Time limit', tone: 'bad' },
  running: { label: 'Finishing', tone: 'neutral' },
};

function LiveCard({ run, onKill }: { run: AgentRun; onKill: () => void }) {
  const l = look(run.role);
  const Icon = l.icon;
  const step = run.last;
  const doing = step ? (step.tools.length ? step.tools.map((t, i) => [toolLabel(t), step.toolInputs[i]].filter(Boolean).join(' · ')).join('  ') : step.text.split('\n')[0]) : 'starting…';
  return (
    <Card padding="sm" className="flow-in border-hud-cyan/40 p-4">
      <div className="mb-3 flex items-center gap-3">
        <span className="relative flex h-9 w-9 items-center justify-center rounded-full" style={{ background: `${l.color}22`, color: l.color }}>
          <span aria-hidden className="absolute inset-0 animate-ping rounded-full opacity-20 motion-reduce:animate-none" style={{ background: l.color }} />
          <Icon aria-hidden className="relative h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-hud-bright">{l.name}{run.round > 0 && <span className="font-normal text-hud-dim"> · round {run.round}</span>}</div>
          <div className="text-xs text-hud-dim">
            {run.task_id ? <Link to={`/tasks/${run.task_id}`} className="font-mono text-hud-cyan hover:underline">{run.task_id}</Link> : 'Chat'} · {run.engine === 'cursor' ? `Cursor ${run.model ?? ''}` : modelName(run.model) || 'starting'}
            {run.engine === 'cursor' && <span className="text-hud-amber"> · reduced isolation</span>}
          </div>
        </div>
        <Button size="sm" variant="danger" className="ml-auto" onClick={onKill} title="Stop this agent" icon={<Square className="h-3 w-3" aria-hidden />}>Stop</Button>
      </div>
      <div key={doing} className="flow-in mb-3 truncate rounded-lg border border-hud-border bg-hud-bg px-2.5 py-1.5 font-mono text-xs text-hud-bright" title={doing}>
        <span aria-hidden className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-hud-cyan align-middle motion-reduce:animate-none" />{doing}
      </div>
      <div className="space-y-2">
        <TokenBar usage={run.usage} />
        <ClockBar startedAt={run.started_at} deadlineAt={run.deadline_at} />
        {run.token_limit !== null && run.engine !== 'cursor' && <RunTokenBar usage={run.usage} limit={run.token_limit} />}
        {run.engine === 'cursor' && <div className="text-xs text-hud-dim">Uses your Cursor plan. Tokens are known when it finishes. Read-only, on a throwaway copy.</div>}
      </div>
    </Card>
  );
}

/** Where the tokens went, by agent, over the last days: what to look at when choosing models. */
function ByRole({ roles, days, setDays }: { roles: RoleUsage[]; days: number; setDays: (d: number) => void }) {
  const max = Math.max(...roles.map((r) => countedTokens(r)), 1);
  const total = roles.reduce((n, r) => n + countedTokens(r), 0);
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Gauge aria-hidden className="h-4 w-4 text-hud-amber" />
        <h2 className="text-sm font-semibold text-hud-bright">Where the tokens went</h2>
        <span className="text-sm tabular-nums text-hud-dim">{fmtTokens(total)} tokens</span>
        <div className="ml-auto flex text-xs" role="group" aria-label="Time range">
          {[1, 7, 30].map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d}
              className={clsx('border px-2.5 py-1 first:rounded-l-lg last:rounded-r-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60',
                days === d ? 'border-hud-cyan bg-hud-cyan/10 font-semibold text-hud-cyan' : 'border-hud-border text-hud-dim hover:text-hud-bright')}>
              {d === 1 ? '24 hours' : `${d} days`}
            </button>
          ))}
        </div>
      </div>
      {roles.length === 0 && <p className="text-sm text-hud-dim">No agent ran in this time.</p>}
      <div className="space-y-3">
        {roles.map((r) => {
          const l = look(r.role);
          const Icon = l.icon;
          const tokens = countedTokens(r);
          return (
            <div key={r.role} className="grid grid-cols-[9rem_1fr_auto] items-center gap-3">
              <div className="flex min-w-0 items-center gap-1.5">
                <Icon aria-hidden className="h-4 w-4 flex-shrink-0" style={{ color: l.color }} />
                <span className="truncate text-sm text-hud-bright">{l.name}</span>
              </div>
              <div>
                <div className="h-2 overflow-hidden rounded-full bg-hud-border/60">
                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${(tokens / max) * 100}%`, background: l.color }} />
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-hud-dim">
                  <span>{r.runs} run{r.runs === 1 ? '' : 's'}</span>
                  <span>{fmtTokens(r.cacheReadTokens)} reused</span>
                  {r.model && <span>mostly {modelName(r.model)}</span>}
                  {r.budgetStops > 0 && <span className="text-hud-amber">{r.budgetStops} stopped at the token limit</span>}
                </div>
              </div>
              <div className="w-16 text-right text-sm tabular-nums text-hud-bright">{fmtTokens(tokens)}</div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-hud-dim">Tokens are input, output and cache writes; context reused from earlier turns is shown apart and does not count toward a limit. Models and token limits per agent are on the Agents page.</p>
    </Card>
  );
}

export default function AgentsView() {
  const [agents, setAgents] = useState<AgentRun[]>([]);
  const [roles, setRoles] = useState<RoleUsage[]>([]);
  const [days, setDays] = useState(7);
  const api = useCoreApi();
  const timer = useRef<number | null>(null);

  const refresh = () => {
    api.get('/agents').then((d) => setAgents(d.agents ?? [])).catch(() => {});
    api.get(`/usage/by-role?days=${days}`).then((d) => setRoles(d.roles ?? [])).catch(() => {});
  };
  const refreshSoon = () => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => { timer.current = null; refresh(); }, 800);
  };
  useEffect(() => { refresh(); }, [days]);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  useSse('/api/events', (ev) => {
    if (['run_started', 'run_event', 'run_exit'].includes(ev['type'] as string)) refreshSoon();
  });

  const kill = async (run: AgentRun) => {
    if (!window.confirm(`Stop the ${look(run.role).name}${run.task_id ? ` on ${run.task_id}` : ''}? The task is handed back to you.`)) return;
    await api.post(`/agents/${run.id}/kill`, {});
    refresh();
  };
  const live = agents.filter((a) => a.is_active);
  const past = agents.filter((a) => !a.is_active);

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
      <PageHeader title="Activity" subtitle={live.length > 0 ? `${live.length} agent${live.length === 1 ? '' : 's'} working now.` : 'No agent is working now.'} />

      <Section title="Working now">
        {live.length === 0
          ? <Card><EmptyState compact icon={<Cpu className="h-5 w-5" />} title="No agent is working" text="Give FryDay a task from Home, or talk to it in the console."
              action={<><Link to="/home/new" className="text-sm font-semibold text-hud-cyan hover:underline">New task</Link><Link to="/setup/console" className="text-sm font-semibold text-hud-cyan hover:underline">Open the console</Link></>} /></Card>
          : <div className="grid gap-3 md:grid-cols-2">{live.map((r) => <LiveCard key={r.id} run={r} onKill={() => void kill(r)} />)}</div>}
      </Section>

      <ByRole roles={roles} days={days} setDays={setDays} />

      <Section title="Recent runs">
        {past.length === 0 ? <p className="text-sm text-hud-dim">No runs yet.</p> : (
          <Card padding="none" className="divide-y divide-hud-border">
            {past.map((run) => {
              const l = look(run.role);
              const Icon = l.icon;
              const s = STATE[run.state] ?? { label: run.state, tone: 'neutral' as BadgeTone };
              return (
                <div key={run.id} className="grid grid-cols-[1.5rem_8rem_5rem_1fr_auto] items-center gap-2 px-4 py-2.5 text-xs">
                  <Icon aria-hidden className="h-4 w-4" style={{ color: l.color }} />
                  <span className="truncate text-sm text-hud-bright">{l.name}{run.round > 0 ? ` r${run.round}` : ''}</span>
                  {run.task_id ? <Link to={`/tasks/${run.task_id}`} className="font-mono text-hud-cyan hover:underline">{run.task_id}</Link> : <span className="text-hud-dim">Chat</span>}
                  <div className="min-w-0">
                    <TokenBar usage={run.usage} compact />
                    {run.error_msg && run.state !== 'completed' && <div className="mt-0.5 truncate text-hud-red" title={run.error_msg}>{run.error_msg}</div>}
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <Badge tone={s.tone}>{s.label}</Badge>
                    <span className="w-14 text-right tabular-nums text-hud-dim">{fmtDuration((run.ended_at ?? Date.now()) - run.started_at)}</span>
                    {run.engine === 'cursor'
                      ? <span className="w-14 text-right text-hud-dim" title="Uses your Cursor plan">Cursor</span>
                      : <span className="w-14 text-right tabular-nums text-hud-bright" title="tokens">{fmtTokens(countedTokens(run.usage))}</span>}
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </Section>
    </div>
  );
}
