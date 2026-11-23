/**
 * The board: every open task in the column core puts it in, initiatives above them with their
 * parts, and the backlog the scheduler starts from (priority, order, auto-start). The board
 * decides nothing itself: columns, lines and what a task waits for all come from core.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Bug, Layers, Link2, Play, Plus, Search, WifiOff, Zap } from 'lucide-react';
import { useCoreApi, useSse } from '../hooks/useSse';
import { useThrottle } from '../hooks/useThrottle';
import type { Actor, BoardColumn, OverviewItem, Priority } from '../storyTypes';
import { ACTORS, ago, readError } from '../plain';
import JourneyLine from '../components/JourneyLine';
import { Avatar, Badge, Button, EmptyState, PageHeader, buttonClass, cardClass, controlClass } from '../ui';

const WEEK = 7 * 24 * 3600 * 1000;
const DONE_SHOWN = 15;

const COLUMNS: Array<{ id: BoardColumn; title: string; hint: string }> = [
  { id: 'backlog', title: 'Backlog', hint: 'Waiting to start' },
  { id: 'understand', title: 'Understand', hint: 'Reading the task' },
  { id: 'plan', title: 'Plan', hint: 'Working out the change' },
  { id: 'build', title: 'Build', hint: 'Making the change' },
  { id: 'check', title: 'Check', hint: 'Checks, review, trying it' },
  { id: 'needs_you', title: 'Needs you', hint: 'A question or your OK' },
  { id: 'live', title: 'Live', hint: 'Going to staging' },
  { id: 'done', title: 'Done', hint: 'This week' },
];

const PRIORITY: Record<Priority, { label: string; tone: 'bad' | 'warn' | 'accent' | 'neutral' }> = {
  p0: { label: 'P0', tone: 'bad' }, p1: { label: 'P1', tone: 'warn' }, p2: { label: 'P2', tone: 'accent' }, p3: { label: 'P3', tone: 'neutral' },
};
const RANK: Record<Priority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
const ACTOR_BY_NAME = new Map((Object.entries(ACTORS) as Array<[Actor, { name: string }]>).map(([id, a]) => [a.name, id]));

/** An older core (or the public demo) sends no column: place the task by its group. */
function columnOf(t: OverviewItem): BoardColumn | null {
  if (t.column !== undefined) return t.column;
  if (t.state === 'queued') return 'backlog';
  return t.group === 'done' ? 'done' : t.group === 'needs_you' ? 'needs_you' : 'understand';
}
const priorityOf = (t: OverviewItem): Priority => t.board?.priority ?? 'p2';
const backlogOrder = (a: OverviewItem, b: OverviewItem) =>
  RANK[priorityOf(a)] - RANK[priorityOf(b)] || (a.board?.position ?? 0) - (b.board?.position ?? 0) || a.createdAt - b.createdAt;

export default function BoardView() {
  const api = useCoreApi();
  const [tasks, setTasks] = useState<OverviewItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [kind, setKind] = useState<'' | 'bugs' | 'mine'>('');
  const load = useCallback(() => api.get('/tasks/overview').then((d) => { setTasks(d.tasks); setFailed(false); }).catch(() => setFailed(true)), []);
  useEffect(() => { void load(); }, [load]);
  const refresh = useThrottle(() => void load(), 1500);
  useSse('/api/events', (ev) => {
    const type = String(ev['type']);
    if (type === 'run_event' || type === 'health') return;
    if (typeof ev['taskId'] === 'string' || type.startsWith('task_') || type === 'board_reordered' || type === 'scheduler' || type.startsWith('run_')) refresh();
  });

  const act = async (work: () => Promise<unknown>) => {
    setError('');
    try { await work(); await load(); } catch (e) { setError(readError(e)); }
  };

  const all = tasks ?? [];
  const projects = useMemo(() => [...new Set(all.map((t) => t.projectName).filter((p): p is string => !!p))].sort(), [all]);
  const matches = (t: OverviewItem) =>
    (!query || `${t.id} ${t.title}`.toLowerCase().includes(query.toLowerCase()))
    && (!project || t.projectName === project)
    && (!priority || priorityOf(t) === priority)
    && (!kind || (kind === 'bugs') === !!t.board?.bug);
  const recent = (t: OverviewItem) => t.group !== 'done' || Date.now() - t.updatedAt < WEEK;
  const shown = all.filter((t) => matches(t) && recent(t));
  const byId = new Map(all.map((t) => [t.id, t]));
  const initiatives = shown.filter((t) => t.board?.kind === 'initiative');
  const backlog = shown.filter((t) => columnOf(t) === 'backlog').sort(backlogOrder);

  const move = (id: string, by: -1 | 1) => {
    const ids = backlog.map((t) => t.id);
    const i = ids.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void act(() => api.post('/tasks/board/order', { ids }));
  };
  const setBoard = (id: string, change: { priority?: Priority; autoStart?: boolean }) => void act(() => api.patch(`/tasks/${encodeURIComponent(id)}/board`, change));
  const start = (id: string) => void act(() => api.post(`/tasks/${encodeURIComponent(id)}/start`, {}));

  const open = all.filter((t) => t.group !== 'done' && t.board?.kind !== 'initiative').length;
  const bugCount = all.filter((t) => t.board?.bug && t.group !== 'done').length;
  const needYou = all.filter((t) => t.group === 'needs_you' && t.board?.kind !== 'initiative').length;

  return (
    <div className="h-full flex flex-col p-4 md:p-5 gap-4 min-h-0">
      <PageHeader title="Board"
        subtitle={tasks ? `${open} open task${open === 1 ? '' : 's'}${needYou ? ` · ${needYou} need${needYou === 1 ? 's' : ''} you` : ''}` : 'Loading…'}
        actions={<Link to="/home/new" className={buttonClass('primary', 'md')}><Plus aria-hidden className="w-4 h-4" />New task</Link>} />

      <div className="flex flex-wrap gap-2 items-center" role="search">
        <label className="relative w-56">
          <span className="sr-only">Search tasks</span>
          <Search aria-hidden className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-hud-dim" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className={clsx(controlClass(), 'pl-9')} />
        </label>
        <div className="w-48">
          <select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)} className={controlClass()}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="w-40">
          <select aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority | '')} className={controlClass()}>
            <option value="">All priorities</option>
            {(Object.keys(PRIORITY) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY[p].label}</option>)}
          </select>
        </div>
        <div className="w-40">
          <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as '' | 'bugs' | 'mine')} className={controlClass()}>
            <option value="">All cards</option>
            <option value="bugs">Bugs FryDay found{bugCount ? ` (${bugCount})` : ''}</option>
            <option value="mine">Your tasks</option>
          </select>
        </div>
        {error && <p role="alert" className="text-sm text-hud-red">{error}</p>}
      </div>

      {failed && (
        <div className={cardClass('none')}>
          <EmptyState compact icon={<WifiOff className="w-5 h-5" />} title="Could not load the board" text="Is FryDay Code still running?"
            action={<Button variant="secondary" size="sm" onClick={() => void load()}>Try again</Button>} />
        </div>
      )}

      {initiatives.length > 0 && (
        <section aria-labelledby="initiatives" className="flex-shrink-0">
          <h2 id="initiatives" className="flex items-center gap-2 text-xs font-semibold text-hud-dim mb-2"><Layers aria-hidden className="w-3.5 h-3.5" />Initiatives</h2>
          <ul className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
            {initiatives.map((t) => <InitiativeCard key={t.id} item={t} parts={(t.board?.children ?? []).map((c) => byId.get(c)).filter((c): c is OverviewItem => !!c)} />)}
          </ul>
        </section>
      )}

      <div className="flex-1 min-h-0 overflow-x-auto">
        <div className="grid grid-flow-col auto-cols-[minmax(240px,1fr)] gap-3 h-full min-w-max">
          {COLUMNS.map((col) => {
            const list = col.id === 'backlog' ? backlog
              : shown.filter((t) => columnOf(t) === col.id).sort((a, b) => col.id === 'done' ? b.updatedAt - a.updatedAt : backlogOrder(a, b));
            const visible = col.id === 'done' ? list.slice(0, DONE_SHOWN) : list;
            return (
              <section key={col.id} aria-labelledby={`col-${col.id}`}
                className={clsx('flex flex-col min-h-0 rounded-2xl border p-2', col.id === 'needs_you' && list.length ? 'border-hud-amber/40 bg-hud-amber/[0.04]' : 'border-hud-border bg-hud-bg/60')}>
                <h2 id={`col-${col.id}`} className="flex items-baseline gap-2 px-1.5 pt-1 pb-2 text-sm font-semibold">
                  {col.title}<span className="text-xs font-normal text-hud-dim">{list.length}</span>
                  <span className="ml-auto text-[11px] font-normal text-hud-dim truncate">{col.hint}</span>
                </h2>
                <ul className="flex-1 min-h-0 overflow-y-auto space-y-2 px-0.5 pb-1">
                  {visible.map((t, i) => (
                    <TaskCard key={t.id} item={t} backlog={col.id === 'backlog'}
                      canUp={col.id === 'backlog' && i > 0 && priorityOf(list[i - 1]!) === priorityOf(t)}
                      canDown={col.id === 'backlog' && i < list.length - 1 && priorityOf(list[i + 1]!) === priorityOf(t)}
                      onMove={(by) => move(t.id, by)} onBoard={(c) => setBoard(t.id, c)} onStart={() => start(t.id)} />
                  ))}
                  {list.length === 0 && <li className="px-1.5 py-6 text-center text-xs text-hud-dim">Nothing here</li>}
                  {list.length > visible.length && <li className="px-1.5 text-xs text-hud-dim"><Link to="/history" className="text-hud-cyan">{list.length - visible.length} more in History</Link></li>}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TaskCard({ item: t, backlog, canUp, canDown, onMove, onBoard, onStart }: {
  item: OverviewItem; backlog: boolean; canUp: boolean; canDown: boolean;
  onMove: (by: -1 | 1) => void; onBoard: (c: { priority?: Priority; autoStart?: boolean }) => void; onStart: () => void;
}) {
  const b = t.board;
  const p = PRIORITY[priorityOf(t)];
  const actor = b?.agent ? ACTOR_BY_NAME.get(b.agent.who) ?? 'fryday' : null;
  return (
    <li className={clsx('rounded-xl border bg-hud-surface px-3 py-2.5 shadow-card', t.group === 'needs_you' ? 'border-hud-amber/40' : 'border-hud-border')}>
      <div className="flex items-start gap-1.5">
        <Badge tone={p.tone} className="flex-shrink-0">{p.label}</Badge>
        {b?.bug && <span title="A bug FryDay found and filed" className="flex-shrink-0 mt-0.5 text-hud-red"><Bug aria-label="Bug" className="w-3.5 h-3.5" /></span>}
        <Link to={`/home/${t.id}`} className="min-w-0 flex-1 text-sm font-semibold leading-snug line-clamp-2 hover:text-hud-cyan focus-visible:outline-none focus-visible:underline">
          {t.title}
        </Link>
      </div>
      <div className="mt-1 text-xs text-hud-dim line-clamp-2">{t.line}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-hud-dim">
        <span className="font-mono">{t.id}</span>
        {t.projectName && <span>· {t.projectName}</span>}
        {b?.parent && <Link to={`/home/${b.parent.id}`} title={b.parent.title} className="inline-flex items-center gap-0.5 text-hud-cyan"><Layers aria-hidden className="w-3 h-3" />{b.parent.id}</Link>}
        {b?.autoStart && backlog && <span className="inline-flex items-center gap-0.5 text-hud-green"><Zap aria-hidden className="w-3 h-3" />auto</span>}
      </div>
      {b?.bug && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-hud-dim">Found by {b.bug.foundBy}{b.bug.foundIn ? <> in <Link to={`/home/${b.bug.foundIn}`} className="text-hud-cyan">{b.bug.foundIn}</Link></> : null}</span>
          {b.bug.reproduced === 'yes' && <span className="rounded-full border border-hud-red/30 px-1.5 py-0.5 text-hud-red">reproduced</span>}
          {b.bug.reproduced === 'no' && <span className="rounded-full border border-hud-green/30 px-1.5 py-0.5 text-hud-green">not reproduced</span>}
          {b.bug.reproduced === 'pending' && <span className="rounded-full border border-hud-border px-1.5 py-0.5 text-hud-dim">to reproduce</span>}
        </div>
      )}
      {b && b.dependsOn.length > 0 && (
        <ul aria-label="Waits for" className="mt-1.5 flex flex-wrap gap-1">
          {b.dependsOn.map((d) => (
            <li key={d.id}>
              <Link to={`/home/${d.id}`} title={`${d.gate === 'start' ? 'Starts after' : d.gate === 'release' ? 'Goes to staging after' : 'Related to'} ${d.title}`}
                className={clsx('inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] border',
                  d.met ? 'border-hud-green/30 text-hud-green' : 'border-hud-amber/40 text-hud-amber')}>
                <Link2 aria-hidden className="w-3 h-3" />{d.id}{d.gate === 'release' ? ' · staging' : d.gate === 'link' ? ' · related' : ''}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {b?.agent && actor && (
        <div className="mt-2 flex items-center gap-1.5 text-xs">
          <Avatar actor={actor} size="sm" /><span className="font-medium">{b.agent.who}</span><span className="text-hud-dim">working · since {ago(b.agent.since)}</span>
        </div>
      )}
      {t.group !== 'done' && !backlog && <JourneyLine journey={t.journey} compact />}
      {backlog && b && (
        <div className="mt-2 flex items-center gap-1">
          <select aria-label={`Priority of ${t.id}`} value={b.priority} onChange={(e) => onBoard({ priority: e.target.value as Priority })}
            className="rounded-lg border border-hud-border bg-hud-surface text-xs px-1.5 py-1">
            {(Object.keys(PRIORITY) as Priority[]).map((k) => <option key={k} value={k}>{PRIORITY[k].label}</option>)}
          </select>
          <button type="button" onClick={() => onBoard({ autoStart: !b.autoStart })} aria-pressed={b.autoStart}
            title={b.autoStart ? 'FryDay starts it when a slot is free and what it waits for is done' : 'Start it automatically'}
            className={clsx('rounded-lg border px-1.5 py-1 text-xs', b.autoStart ? 'border-hud-green/40 text-hud-green bg-hud-green/10' : 'border-hud-border text-hud-dim')}>
            <Zap aria-hidden className="w-3 h-3 inline" /> Auto
          </button>
          {!b.autoStart && (
            <button type="button" onClick={onStart} className="rounded-lg border border-hud-border px-1.5 py-1 text-xs text-hud-cyan" title="Start it now">
              <Play aria-hidden className="w-3 h-3 inline" /> Start
            </button>
          )}
          <span className="ml-auto flex">
            <button type="button" disabled={!canUp} onClick={() => onMove(-1)} aria-label={`Move ${t.id} up`} className="p-1 rounded text-hud-dim disabled:opacity-30 hover:text-hud-bright"><ArrowUp aria-hidden className="w-3.5 h-3.5" /></button>
            <button type="button" disabled={!canDown} onClick={() => onMove(1)} aria-label={`Move ${t.id} down`} className="p-1 rounded text-hud-dim disabled:opacity-30 hover:text-hud-bright"><ArrowDown aria-hidden className="w-3.5 h-3.5" /></button>
          </span>
        </div>
      )}
    </li>
  );
}

function InitiativeCard({ item: t, parts }: { item: OverviewItem; parts: OverviewItem[] }) {
  const done = parts.filter((p) => p.state === 'deployed' || (p.group === 'done' && p.state !== 'failed')).length;
  const p = PRIORITY[priorityOf(t)];
  return (
    <li className={clsx(cardClass('sm'), t.group === 'needs_you' && 'border-hud-amber/40')}>
      <div className="flex items-start gap-2">
        <Badge tone={p.tone}>{p.label}</Badge>
        <Link to={`/home/${t.id}`} className="min-w-0 flex-1 text-sm font-semibold line-clamp-2 hover:text-hud-cyan">{t.title}</Link>
        <span className="text-xs text-hud-dim tabular-nums">{done}/{parts.length}</span>
      </div>
      <div className="mt-1 text-xs text-hud-dim">{t.line}</div>
      <div className="mt-2 h-1.5 rounded-full bg-hud-border/60 overflow-hidden" aria-hidden>
        <div className="h-full bg-hud-green rounded-full" style={{ width: `${parts.length ? (done / parts.length) * 100 : 0}%` }} />
      </div>
      <JourneyLine journey={t.journey} compact />
      <ul aria-label="Parts" className="mt-2 flex flex-wrap gap-1.5">
        {parts.map((c) => (
          <li key={c.id}>
            <Link to={`/home/${c.id}`} title={`${c.title}: ${c.line}`}
              className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                c.state === 'deployed' ? 'border-hud-green/30 text-hud-green' : c.group === 'needs_you' ? 'border-hud-amber/40 text-hud-amber' : c.state === 'failed' ? 'border-hud-red/30 text-hud-red' : 'border-hud-border text-hud-dim')}>
              {c.id}{c.projectName ? ` · ${c.projectName}` : ''}
            </Link>
          </li>
        ))}
      </ul>
    </li>
  );
}
