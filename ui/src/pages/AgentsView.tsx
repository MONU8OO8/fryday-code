/**
 * Agents: one lane per agent. "Now" is what it is doing this moment (kept current from the
 * live event stream), "Recent" its last runs, each opening the run drawer, and its scorecard
 * for the last 7 and 30 days. Below, where the tokens went by agent.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Square, Gauge, Cpu } from 'lucide-react';
import clsx from 'clsx';
import { useSse, useCoreApi } from '../hooks/useSse';
import { toolLabel } from '../hooks/useRunActivity';
import { Badge, Button, Card, EmptyState, PageHeader } from '../ui';
import { look, fmtTokens, countedTokens, fmtDuration, modelName } from '../agents';
import RunDrawer from '../components/RunDrawer';
import ScoreStrip from '../components/ScoreStrip';
import { RUN_STATE, type Lane, type LaneRun } from '../runTypes';

interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
interface RoleUsage extends Usage { role: string; runs: number; budgetStops: number; model: string | null }

const LANE_NAME: Record<string, { name: string; job: string }> = {
  fryday: { name: 'Lead', job: 'FryDay: talks with you and keeps the board' },
};
const laneLook = (role: string) => ({ ...look(role), ...LANE_NAME[role] });
const RECENT_SHOWN = 6;

function doingNow(run: LaneRun): string {
  const n = run.now;
  if (!n) return 'Starting…';
  if (n.tool) return [n.tool, n.hint].filter(Boolean).join(' · ');
  return n.text.split('\n')[0] || 'Thinking…';
}

function LiveRun({ run, color, now, onOpen, onKill }: { run: LaneRun; color: string; now: number; onOpen: () => void; onKill: () => void }) {
  const doing = doingNow(run);
  const share = run.limit ? Math.min(run.tokens / run.limit, 1) : null;
  return (
    <div className="flow-in rounded-xl border border-hud-cyan/40 bg-hud-bg p-3">
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span aria-hidden className="h-2 w-2 animate-pulse rounded-full motion-reduce:animate-none" style={{ background: color }} />
        {run.taskId ? <Link to={`/tasks/${run.taskId}`} className="font-mono text-hud-cyan hover:underline">{run.taskId}</Link> : <span className="text-hud-dim">Chat</span>}
        {run.round > 0 && <span className="text-hud-dim">round {run.round}</span>}
        <span className="min-w-0 flex-1 truncate text-hud-dim">{run.taskTitle}</span>
        <span className="tabular-nums text-hud-dim">{fmtDuration(now - run.startedAt)}</span>
      </div>
      <button type="button" onClick={onOpen} title={doing}
        className="mb-2 block w-full truncate rounded-lg border border-hud-border bg-hud-surface px-2.5 py-1.5 text-left font-mono text-xs text-hud-bright hover:border-hud-cyan/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60">
        <span key={doing} className="flow-in">{doing}</span>
      </button>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-hud-border/60" role="meter" aria-label="Tokens against the limit"
          aria-valuemin={0} aria-valuemax={run.limit ?? undefined} aria-valuenow={run.tokens}>
          <div className={clsx('h-full rounded-full transition-all duration-700', share !== null && share > 0.85 ? 'bg-hud-amber' : 'bg-hud-cyan')} style={{ width: `${(share ?? 0) * 100}%` }} />
        </div>
        <span className="text-[11px] tabular-nums text-hud-dim">{fmtTokens(run.tokens)}{run.limit ? ` / ${fmtTokens(run.limit)}` : ''}</span>
        <Button size="sm" variant="ghost" onClick={onOpen}>Open</Button>
        <Button size="sm" variant="danger" onClick={onKill} title="Stop this agent" icon={<Square className="h-3 w-3" aria-hidden />}>Stop</Button>
      </div>
    </div>
  );
}

function RecentRun({ run, onOpen }: { run: LaneRun; onOpen: () => void }) {
  const s = RUN_STATE[run.state] ?? { label: run.state, tone: 'neutral' as const };
  return (
    <li>
      <button type="button" onClick={onOpen}
        className="grid w-full grid-cols-[4.5rem_1fr_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-hud-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60">
        <span className="font-mono text-hud-cyan">{run.taskId ?? 'Chat'}{run.round > 0 ? <span className="text-hud-dim"> r{run.round}</span> : null}</span>
        <span className="truncate text-hud-bright">{run.taskTitle ?? ''}</span>
        <span className="flex items-center gap-2">
          <Badge tone={s.tone}>{s.label}</Badge>
          <span className="w-10 text-right tabular-nums text-hud-dim">{fmtTokens(run.tokens)}</span>
          <span className="w-12 text-right tabular-nums text-hud-dim">{run.endedAt ? fmtDuration(run.endedAt - run.startedAt) : ''}</span>
        </span>
      </button>
    </li>
  );
}

function LaneCard({ lane, now, onOpen, onKill }: { lane: Lane; now: number; onOpen: (runId: string) => void; onKill: (run: LaneRun) => void }) {
  const [all, setAll] = useState(false);
  const l = laneLook(lane.role);
  const Icon = l.icon;
  const recent = all ? lane.recent : lane.recent.slice(0, RECENT_SHOWN);
  return (
    <Card padding="none" className={clsx('overflow-hidden', lane.live.length > 0 && 'border-hud-cyan/40')}>
      <div className="flex items-center gap-3 border-b border-hud-border px-4 py-3">
        <span className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full" style={{ background: `${l.color}22`, color: l.color }}>
          {lane.live.length > 0 && <span aria-hidden className="absolute inset-0 animate-ping rounded-full opacity-20 motion-reduce:animate-none" style={{ background: l.color }} />}
          <Icon aria-hidden className="relative h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-hud-bright">{l.name}</h2>
          <p className="truncate text-xs text-hud-dim">{l.job}</p>
        </div>
        <Badge className="ml-auto" tone={lane.live.length ? 'accent' : 'neutral'} dot={lane.live.length > 0}>
          {lane.live.length ? `${lane.live.length} working` : 'Idle'}
        </Badge>
      </div>
      <div className="grid gap-4 p-4 lg:grid-cols-2">
        <section aria-label={`${l.name} now`}>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-hud-dim">Now</h3>
          {lane.live.length === 0
            ? <p className="text-xs text-hud-dim">Not working on anything.</p>
            : <div className="space-y-2">{lane.live.map((r) => <LiveRun key={r.runId} run={r} color={l.color} now={now} onOpen={() => onOpen(r.runId)} onKill={() => onKill(r)} />)}</div>}
        </section>
        <section aria-label={`${l.name} recent runs`}>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-hud-dim">Recent</h3>
          {lane.recent.length === 0 ? <p className="text-xs text-hud-dim">No runs yet.</p> : (
            <>
              <ul className="-mx-2">{recent.map((r) => <RecentRun key={r.runId} run={r} onOpen={() => onOpen(r.runId)} />)}</ul>
              {lane.recent.length > RECENT_SHOWN && (
                <button type="button" onClick={() => setAll(!all)} className="mt-1 text-xs font-semibold text-hud-cyan hover:underline">
                  {all ? 'Show fewer' : `Show all ${lane.recent.length}`}
                </button>
              )}
            </>
          )}
        </section>
      </div>
      <div className="border-t border-hud-border px-4 py-3">
        <ScoreStrip role={lane.role} card={lane.scorecard} />
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
          const l = laneLook(r.role);
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
      <p className="mt-3 text-xs text-hud-dim">Tokens are input, output and cache writes; context reused from earlier turns is shown apart and does not count toward a limit. Models and token limits per agent are in Setup.</p>
    </Card>
  );
}

export default function AgentsView() {
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [roles, setRoles] = useState<RoleUsage[]>([]);
  const [days, setDays] = useState(7);
  const [open, setOpen] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const api = useCoreApi();
  const timer = useRef<number | null>(null);

  const refresh = () => {
    api.get('/agents/roles').then((d) => { setLanes(Array.isArray(d?.lanes) ? d.lanes : []); setFailed(false); }).catch(() => setFailed(true));
  };
  const refreshSoon = () => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => { timer.current = null; refresh(); }, 800);
  };
  useEffect(() => { refresh(); }, []);
  useEffect(() => { api.get(`/usage/by-role?days=${days}`).then((d) => setRoles(d?.roles ?? [])).catch(() => {}); }, [days]);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  const working = lanes.reduce((n, l) => n + l.live.length, 0);
  useEffect(() => {
    if (working === 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

  useSse('/api/events', (ev) => {
    const type = ev['type'];
    if (type === 'run_started' || type === 'run_exit') { refreshSoon(); return; }
    if (type !== 'run_event' || ev['kind'] !== 'assistant') return;
    const runId = ev['runId'];
    const tools = (ev['tools'] as string[] | undefined) ?? [];
    const inputs = (ev['toolInputs'] as string[] | undefined) ?? [];
    const step = { tool: tools.length ? toolLabel(tools[tools.length - 1]!) : null, hint: inputs[inputs.length - 1] ?? '', text: String(ev['text'] ?? '').slice(0, 280) };
    let known = false;
    setLanes((prev) => prev.map((lane) => {
      if (!lane.live.some((r) => r.runId === runId)) return lane;
      known = true;
      return { ...lane, live: lane.live.map((r) => (r.runId === runId ? { ...r, now: step } : r)) };
    }));
    if (!known) refreshSoon();
  });

  const kill = async (run: LaneRun, who: string) => {
    if (!window.confirm(`Stop the ${who}${run.taskId ? ` on ${run.taskId}` : ''}? The task is handed back to you.`)) return;
    await api.post(`/agents/${run.runId}/kill`, {});
    refresh();
  };
  const close = useCallback(() => setOpen(null), []);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <PageHeader title="Agents"
        subtitle={working > 0 ? `${working} agent${working === 1 ? '' : 's'} working now. Open any run to see each step it took.` : 'No agent is working now. Open any run to see each step it took.'} />
      <p className="text-xs text-hud-dim">Each figure: the last 7 days, and on the right the last 30. An arrow shows the week doing better or worse than the month.</p>

      {failed && <p role="alert" className="text-sm text-hud-red">Could not load the agents. Is FryDay running?</p>}
      {!failed && lanes.length === 0 && (
        <Card><EmptyState compact icon={<Cpu className="h-5 w-5" />} title="No agent has run yet" text="Put a task on the board, or talk to FryDay in the console."
          action={<><Link to="/home/new" className="text-sm font-semibold text-hud-cyan hover:underline">New task</Link><Link to="/setup/console" className="text-sm font-semibold text-hud-cyan hover:underline">Open the console</Link></>} /></Card>
      )}

      <div className="space-y-3">
        {lanes.map((lane) => <LaneCard key={lane.role} lane={lane} now={now} onOpen={setOpen} onKill={(r) => void kill(r, laneLook(lane.role).name)} />)}
      </div>

      <ByRole roles={roles} days={days} setDays={setDays} />
      <RunDrawer runId={open} onClose={close} />
    </div>
  );
}
