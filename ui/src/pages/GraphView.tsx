/**
 * Graph: which project calls which, from core's scan of each production branch. A link the
 * scan guessed from names is dashed until the owner confirms it; the owner can also remove
 * a link, add one the scan cannot see, name a service, and rescan a project.
 */

import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Check, List, Maximize2, Minus, Network, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { layout, NODE_H, NODE_W } from './graphLayout';
import { usePanZoom } from '../hooks/usePanZoom';
import { useCoreApi, useSse } from '../hooks/useSse';
import { useThrottle } from '../hooks/useThrottle';
import { ago } from '../plain';
import { Badge, Button, EmptyState, PageHeader, buttonClass, cardClass, controlClass } from '../ui';

type Source = 'scan' | 'owner';
interface GraphNode { id: string; kind: 'project' | 'external_service' | 'endpoint' | 'env_key'; projectId: string | null; label: string; source: Source; confidence: number; confirmed: boolean }
interface Step { from: string; to: string; kind: 'calls' | 'exposes' | 'served_by'; label: string; source: Source; confidence: number; confirmed: boolean }
interface ServiceLink { from: string; to: string; confidence: number; confirmed: boolean; via: Step[] }
interface ScanStatus { sha: string | null; scannedAt: number; error: string | null; truncated: boolean }
interface Graph { projects: Array<{ id: string; name: string; scan: ScanStatus | null }>; services: GraphNode[]; links: ServiceLink[] }
interface Panel {
  projectId: string;
  scan: ScanStatus | null;
  frameworks: string[];
  exposes: string[];
  calls: ServiceLink[];
  calledBy: ServiceLink[];
  keys: Array<{ id: string; key: string; servedBy: { id: string; label: string; confidence: number; confirmed: boolean } | null }>;
}

type Certainty = 'confirmed' | 'seen' | 'guess';
const certaintyOf = (l: { confirmed: boolean; confidence: number }): Certainty => (l.confirmed ? 'confirmed' : l.confidence >= 1 ? 'seen' : 'guess');
const CERTAINTY: Record<Certainty, { label: string; tone: 'ok' | 'accent' | 'warn'; stroke: string; marker: string }> = {
  confirmed: { label: 'Confirmed', tone: 'ok', stroke: 'stroke-hud-green', marker: 'arrow-confirmed' },
  seen: { label: 'Seen in code', tone: 'accent', stroke: 'stroke-hud-cyan', marker: 'arrow-seen' },
  guess: { label: 'Guess from names', tone: 'warn', stroke: 'stroke-hud-amber', marker: 'arrow-guess' },
};

const short = (s: string, n = 22) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const onActivate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
};

type Selection = { kind: 'node'; id: string } | { kind: 'link'; from: string; to: string } | null;

export default function GraphView() {
  const api = useCoreApi();
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [version, setVersion] = useState(0);
  const [newService, setNewService] = useState('');

  const load = () => api.get('/graph').then((d: Partial<Graph>) => {
    setGraph({ projects: d.projects ?? [], services: d.services ?? [], links: d.links ?? [] });
    setVersion((v) => v + 1);
  }).catch((err) => setError(message(err)));
  useEffect(() => { void load(); }, []);
  const reload = useThrottle(() => { void load(); }, 1500);
  useSse('/api/events', (ev) => { if (ev['type'] === 'graph_updated') reload(); });

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(message(err));
    }
  };

  const labelOf = useMemo(() => {
    const m = new Map((graph?.services ?? []).map((n) => [n.id, n.label]));
    return (id: string) => m.get(id) ?? id.replace(/^(project|ext):/, '');
  }, [graph]);
  const drawn = useMemo(() => (graph ? layout(graph.services, graph.links) : null), [graph]);
  // Projects with a task being worked on right now pulse on the map.
  const [working, setWorking] = useState<string[]>([]);
  const loadWorking = () => api.get('/tasks/overview').then((d: { tasks?: Array<{ group: string; projectName: string | null }> }) =>
    setWorking([...new Set((d.tasks ?? []).filter((t) => t.group === 'working' && t.projectName).map((t) => t.projectName!))])).catch(() => {});
  useEffect(() => { void loadWorking(); }, []);
  const reloadWorking = useThrottle(() => { void loadWorking(); }, 3000);
  useSse('/api/events', (ev) => { if (String(ev['type']).startsWith('task_') || ev['type'] === 'run_started' || ev['type'] === 'run_ended') reloadWorking(); });
  const busyProjects = useMemo(() => new Set((graph?.projects ?? []).filter((p) => working.includes(p.name)).map((p) => p.id)), [graph, working]);

  if (graph && graph.projects.length === 0) {
    return (
      <div className="p-4 md:p-6 max-w-6xl mx-auto">
        <PageHeader title="Graph" subtitle="Which project calls which, read from each production branch." />
        <div className={clsx(cardClass('none'), 'mt-5')}>
          <EmptyState icon={<Network className="w-5 h-5" />} title="No projects yet"
            text="Add your projects in Setup. FryDay reads each one's production branch and draws who calls whom."
            action={<Link to="/setup/projects" className={buttonClass('primary', 'sm')}>Add a project</Link>} />
        </div>
      </div>
    );
  }

  const selectedLink = selected?.kind === 'link' ? graph?.links.find((l) => l.from === selected.from && l.to === selected.to) : undefined;
  const selectedNode = selected?.kind === 'node' ? graph?.services.find((n) => n.id === selected.id) : undefined;
  const unscanned = (graph?.projects ?? []).filter((p) => !p.scan || p.scan.error);

  return (
    <div className="p-3 sm:p-4 md:p-6 max-w-7xl mx-auto space-y-4 sm:space-y-5">
      <PageHeader title="Graph" subtitle="Which project calls which, read from each production branch. The agents get this map instead of exploring every repository again."
        actions={
          <form className="flex w-full sm:w-auto items-center gap-2" onSubmit={(e) => { e.preventDefault(); const label = newService.trim(); if (label) void act(() => api.post('/graph/services', { label })).then(() => setNewService('')); }}>
 <div className="w-full sm:w-48"><input aria-label="New outside service" placeholder="Add an outside service" value={newService} onChange={(e) => setNewService(e.target.value)} className={controlClass()} /></div>
            <Button type="submit" size="sm" variant="secondary" disabled={!newService.trim()}><Plus aria-hidden className="w-3.5 h-3.5" />Add</Button>
          </form>
        } />

      {error && <p role="alert" className="text-sm text-hud-red">{error}</p>}
      {unscanned.length > 0 && (
        <div role="note" className="flex flex-wrap items-center gap-2 text-sm text-hud-dim">
          <Badge tone="warn">Not read yet</Badge>
          {unscanned.map((p) => <span key={p.id}>{p.name}{p.scan?.error ? `: ${p.scan.error}` : ''}</span>).reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, ' · ', el] : [el]), [])}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem] gap-5 items-start">
        <GraphCanvas graph={graph} drawn={drawn} selected={selected} setSelected={setSelected} labelOf={labelOf} busy={busyProjects} />

        <aside className="space-y-4" aria-label="Details">
          {selectedNode?.kind === 'project' && selectedNode.projectId ? (
            <ProjectPanel key={`${selectedNode.id}:${version}`} projectId={selectedNode.projectId} node={selectedNode} graph={graph!} labelOf={labelOf} act={act} onClose={() => setSelected(null)} />
          ) : selectedNode ? (
            <ServicePanel key={`${selectedNode.id}:${version}`} node={selectedNode} graph={graph!} labelOf={labelOf} act={act} onClose={() => setSelected(null)} />
          ) : selectedLink ? (
            <section className={cardClass('md')} aria-label="Link">
              <PanelHead title={`${labelOf(selectedLink.from)} → ${labelOf(selectedLink.to)}`} onClose={() => setSelected(null)} />
              <Steps link={selectedLink} act={act} />
            </section>
          ) : (
            <section className={cardClass('md')}>
              <p className="text-sm text-hud-dim">Pick a project to see what it exposes and calls, or a line to confirm or remove it. Dashed lines are guesses from names: confirm the right ones so the agents can rely on them.</p>
            </section>
          )}
        </aside>
      </div>

      {graph && graph.links.length > 0 && (
        <section className={cardClass('md')} aria-labelledby="all-links">
          <h2 id="all-links" className="text-sm font-semibold">All links</h2>
          <div className="overflow-x-auto"><table className="mt-2 w-full min-w-[32rem] text-sm">
            <thead className="text-xs text-hud-dim text-left"><tr><th className="py-1 font-medium">From</th><th className="font-medium">To</th><th className="font-medium">Through</th><th className="font-medium">How sure</th></tr></thead>
            <tbody>
              {graph.links.map((l) => {
                const c = certaintyOf(l);
                return (
                  <tr key={`${l.from}→${l.to}`} className="border-t border-hud-border/60">
                    <td className="py-1.5">{labelOf(l.from)}</td>
                    <td>{labelOf(l.to)}</td>
                    <td className="text-hud-dim font-mono text-xs">{[...new Set(l.via.map((v) => v.label))].join(', ')}</td>
                    <td><button type="button" className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60" onClick={() => setSelected({ kind: 'link', from: l.from, to: l.to })}><Badge tone={CERTAINTY[c].tone}>{CERTAINTY[c].label}</Badge></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        </section>
      )}
    </div>
  );
}


type Drawn = ReturnType<typeof layout<GraphNode, ServiceLink>>;

/**
 * The map: fills the width at every screen size, moves and zooms (drag, wheel, pinch, buttons),
 * lines flow in the direction of each call, and picking a node lights up who it calls and who
 * calls it. On a phone it starts as a list, which reads better than a small drawing.
 */
function GraphCanvas({ graph, drawn, selected, setSelected, labelOf, busy }: {
  graph: Graph | null; drawn: Drawn | null; selected: Selection; setSelected: (s: Selection) => void; labelOf: (id: string) => string; busy: Set<string>;
}) {
  const [hidden, setHidden] = useState<Set<Certainty>>(new Set());
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState<string | null>(null);
  const [mode, setMode] = useState<'map' | 'list'>(() => (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches ? 'list' : 'map'));
  const content = useMemo(() => (drawn ? { w: drawn.width, h: drawn.height } : null), [drawn]);
  const pz = usePanZoom(mode === 'map' ? content : null);

  const links = (drawn?.links ?? []).filter((l) => !hidden.has(certaintyOf(l)));
  const focus = hover ?? (selected?.kind === 'node' ? selected.id : null);
  const near = useMemo(() => {
    if (!focus) return null;
    const set = new Set([focus]);
    for (const l of links) { if (l.from === focus) set.add(l.to); if (l.to === focus) set.add(l.from); }
    return set;
  }, [focus, links]);
  const q = query.trim().toLowerCase();
  const matches = q ? (graph?.services ?? []).filter((n) => n.label.toLowerCase().includes(q) || (n.projectId ?? '').toLowerCase().includes(q)) : [];
  const jump = () => {
    const first = matches[0];
    const p = first && drawn?.pos.get(first.id);
    if (!first || !p) return;
    setSelected({ kind: 'node', id: first.id });
    if (mode === 'map') pz.centreOn(p.x + NODE_W / 2, p.y + NODE_H / 2);
  };
  const toggle = (c: Certainty) => setHidden((h) => { const n = new Set(h); if (n.has(c)) n.delete(c); else n.add(c); return n; });

  return (
    <section className={cardClass('none')} aria-label="Service graph">
      <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4 pt-3">
        <form role="search" className="relative w-full sm:w-56" onSubmit={(e) => { e.preventDefault(); jump(); }}>
          <Search aria-hidden className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-hud-dim" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a project or service" aria-label="Find a project or service" className={clsx(controlClass(), 'pl-9')} />
        </form>
        {(Object.keys(CERTAINTY) as Certainty[]).map((c) => (
          <button key={c} type="button" onClick={() => toggle(c)} aria-pressed={!hidden.has(c)} title={hidden.has(c) ? `Show ${CERTAINTY[c].label.toLowerCase()} links` : `Hide ${CERTAINTY[c].label.toLowerCase()} links`}
            className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-opacity', hidden.has(c) ? 'opacity-40 border-hud-border' : 'border-hud-border/80')}>
            <svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" className={CERTAINTY[c].stroke} strokeWidth="2" strokeDasharray={c === 'guess' ? '5 4' : undefined} /></svg>
            {CERTAINTY[c].label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <div role="tablist" aria-label="View" className="flex rounded-full border border-hud-border p-0.5 text-xs">
            <button type="button" role="tab" aria-selected={mode === 'map'} onClick={() => setMode('map')} className={clsx('inline-flex items-center gap-1 rounded-full px-2.5 py-1', mode === 'map' ? 'bg-hud-cyan/10 text-hud-cyan font-semibold' : 'text-hud-dim')}><Network aria-hidden className="w-3.5 h-3.5" />Map</button>
            <button type="button" role="tab" aria-selected={mode === 'list'} onClick={() => setMode('list')} className={clsx('inline-flex items-center gap-1 rounded-full px-2.5 py-1', mode === 'list' ? 'bg-hud-cyan/10 text-hud-cyan font-semibold' : 'text-hud-dim')}><List aria-hidden className="w-3.5 h-3.5" />List</button>
          </div>
        </div>
      </div>

      {mode === 'list' ? (
        <ul className="p-3 sm:p-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {(graph?.services ?? []).filter((n) => !q || matches.includes(n)).sort((a, b) => Number(b.kind === 'project') - Number(a.kind === 'project') || a.label.localeCompare(b.label)).map((n) => {
            const calls = links.filter((l) => l.from === n.id);
            const calledBy = links.filter((l) => l.to === n.id);
            const isSel = selected?.kind === 'node' && selected.id === n.id;
            return (
              <li key={n.id}>
                <button type="button" onClick={() => setSelected({ kind: 'node', id: n.id })} aria-pressed={isSel}
                  className={clsx('w-full text-left rounded-xl border px-3 py-2.5 transition-colors', isSel ? 'border-hud-cyan bg-hud-cyan/5' : 'border-hud-border hover:border-hud-cyan/40')}>
                  <span className="flex items-center gap-2 font-semibold text-sm">
                    {busy.has(n.projectId ?? '') && <span aria-label="Work in progress" className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-hud-cyan opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-hud-cyan" /></span>}
                    {n.label}{n.kind !== 'project' && <span className="text-[11px] font-normal text-hud-dim">outside service</span>}
                  </span>
                  <span className="mt-1 block text-xs text-hud-dim">
                    {calls.length ? <>Calls {calls.map((l) => labelOf(l.to)).join(', ')}</> : 'Calls nothing it knows of'}
                    {calledBy.length ? <> · Called by {calledBy.map((l) => labelOf(l.from)).join(', ')}</> : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="relative">
          <div className="absolute right-3 top-3 z-10 flex flex-col gap-1 rounded-xl border border-hud-border bg-hud-surface/90 p-1 shadow-card backdrop-blur">
            <button type="button" onClick={pz.zoomIn} aria-label="Zoom in" className="p-1.5 rounded-lg text-hud-dim hover:text-hud-bright hover:bg-hud-border/40"><Plus className="w-4 h-4" /></button>
            <button type="button" onClick={pz.zoomOut} aria-label="Zoom out" className="p-1.5 rounded-lg text-hud-dim hover:text-hud-bright hover:bg-hud-border/40"><Minus className="w-4 h-4" /></button>
            <button type="button" onClick={pz.fitAll} aria-label="Show it all" title="Show it all" className="p-1.5 rounded-lg text-hud-dim hover:text-hud-bright hover:bg-hud-border/40"><Maximize2 className="w-4 h-4" /></button>
          </div>
          {drawn && (
            <svg ref={pz.ref} role="group" aria-label="Projects and the services they call" viewBox={`${pz.view.x} ${pz.view.y} ${pz.view.w} ${pz.view.h}`}
              preserveAspectRatio="xMidYMid meet" className="block w-full h-[62vh] min-h-[360px] touch-none select-none cursor-grab active:cursor-grabbing" {...pz.handlers}>
              <defs>
                {(Object.keys(CERTAINTY) as Certainty[]).map((c) => (
                  <marker key={c} id={CERTAINTY[c].marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"
                    className={c === 'confirmed' ? 'text-hud-green' : c === 'seen' ? 'text-hud-cyan' : 'text-hud-amber'}>
                    <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
                  </marker>
                ))}
              </defs>
              <rect data-bg="" x={pz.view.x - pz.view.w} y={pz.view.y - pz.view.h} width={pz.view.w * 3} height={pz.view.h * 3} fill="transparent" />
              {links.map((l) => {
                const a = drawn.pos.get(l.from)!;
                const b = drawn.pos.get(l.to)!;
                const c = certaintyOf(l);
                const up = b.y < a.y;
                const x1 = a.x + NODE_W / 2, y1 = up ? a.y : a.y + NODE_H;
                const x2 = b.x + NODE_W / 2, y2 = up ? b.y + NODE_H : b.y;
                const bend = Math.max(40, Math.abs(y2 - y1) / 2) * (up ? -1 : 1);
                const d = `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2 - (up ? -2 : 2)}`;
                const isSel = selected?.kind === 'link' && selected.from === l.from && selected.to === l.to;
                const lit = !near || (near.has(l.from) && near.has(l.to) && (l.from === focus || l.to === focus));
                const select = () => setSelected({ kind: 'link', from: l.from, to: l.to });
                return (
                  <g key={`${l.from}→${l.to}`} role="button" tabIndex={0} aria-label={`${labelOf(l.from)} calls ${labelOf(l.to)}, ${CERTAINTY[c].label}`}
                    onClick={select} onKeyDown={onActivate(select)} className="cursor-pointer focus:outline-none group" style={{ opacity: lit ? 1 : 0.12, transition: 'opacity 200ms' }}>
                    <path d={d} fill="none" stroke="transparent" strokeWidth="14" />
                    <path d={d} fill="none" className={clsx(CERTAINTY[c].stroke, 'group-focus-visible:opacity-100')} strokeWidth={isSel ? 3 : 1.75}
                      strokeDasharray={c === 'guess' ? '6 5' : undefined} markerEnd={`url(#${CERTAINTY[c].marker})`} />
                    {/* The call, flowing from caller to callee. */}
                    {c !== 'guess' && <path d={d} fill="none" className={clsx(CERTAINTY[c].stroke, 'graph-flow')} strokeWidth={isSel ? 3.5 : 2.5} strokeLinecap="round" />}
                  </g>
                );
              })}
              {(graph?.services ?? []).map((n, i) => {
                const p = drawn.pos.get(n.id)!;
                const isSel = selected?.kind === 'node' && selected.id === n.id;
                const select = () => setSelected({ kind: 'node', id: n.id });
                const project = n.kind === 'project';
                const dim = near ? !near.has(n.id) : q ? !matches.includes(n) : false;
                const found = q && matches.includes(n);
                return (
                  <motion.g key={n.id} role="button" tabIndex={0} aria-label={`${project ? 'Project' : 'Outside service'} ${n.label}`} aria-pressed={isSel}
                    onClick={select} onKeyDown={onActivate(select)} onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)}
                    className="cursor-pointer focus:outline-none group"
                    initial={{ x: p.x, y: p.y, opacity: 0 }} animate={{ x: p.x, y: p.y, opacity: dim ? 0.3 : 1 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 28, delay: Math.min(i * 0.02, 0.4) }}>
                    {busy.has(n.projectId ?? '') && <rect width={NODE_W} height={NODE_H} rx={10} className="fill-none stroke-hud-cyan graph-pulse" strokeWidth={2} />}
                    <rect width={NODE_W} height={NODE_H} rx={project ? 10 : 22}
                      className={clsx(project ? 'fill-hud-surface' : 'fill-hud-bg', isSel || found ? 'stroke-hud-cyan' : 'stroke-hud-border', 'group-hover:stroke-hud-cyan group-focus-visible:stroke-hud-cyan transition-colors')}
                      strokeWidth={isSel || found ? 2 : 1} strokeDasharray={project ? undefined : '4 3'} />
                    <text x={NODE_W / 2} y={project ? 19 : 27} textAnchor="middle" className="fill-hud-bright text-[12px] font-semibold pointer-events-none">{short(n.label)}</text>
                    {project && <text x={NODE_W / 2} y={34} textAnchor="middle" className="fill-hud-dim text-[10px] pointer-events-none">{short(n.projectId ?? '', 26)}</text>}
                    <title>{n.label}{busy.has(n.projectId ?? '') ? ' · work in progress' : ''}</title>
                  </motion.g>
                );
              })}
            </svg>
          )}
          <p className="px-4 pb-3 text-[11px] text-hud-dim">Drag to move · scroll or pinch to zoom · pick a node to light up who it calls and who calls it.</p>
        </div>
      )}
    </section>
  );
}

type Act = (fn: () => Promise<unknown>) => Promise<void>;

function PanelHead({ title, onClose, children }: { title: string; onClose: () => void; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold break-words">{title}</h2>
        {children}
      </div>
      <button type="button" onClick={onClose} aria-label="Close details" className={buttonClass('ghost', 'sm')}><X aria-hidden className="w-3.5 h-3.5" /></button>
    </div>
  );
}

/** The edges a project-level link stands on, each with Confirm and Remove. */
function Steps({ link, act }: { link: ServiceLink; act: Act }) {
  const api = useCoreApi();
  return (
    <ul className="mt-3 space-y-2">
      {link.via.map((s) => {
        const c = certaintyOf(s);
        const edge = { from: s.from, to: s.to, kind: s.kind };
        return (
          <li key={`${s.from}|${s.to}|${s.kind}`} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs break-all">{s.label}</span>
            <Badge tone={CERTAINTY[c].tone}>{CERTAINTY[c].label}</Badge>
            <span className="flex-1" />
            {!s.confirmed && <Button size="sm" variant="secondary" onClick={() => void act(() => api.post('/graph/edges/confirm', edge))}><Check aria-hidden className="w-3.5 h-3.5" />Confirm</Button>}
            <Button size="sm" variant="ghost" aria-label={`Remove the link through ${s.label}`} onClick={() => void act(() => api.post('/graph/edges/delete', edge))}><Trash2 aria-hidden className="w-3.5 h-3.5" />Remove</Button>
          </li>
        );
      })}
    </ul>
  );
}

function Rename({ node, act }: { node: GraphNode; act: Act }) {
  const api = useCoreApi();
  const [label, setLabel] = useState(node.label);
  return (
    <form className="mt-3 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (label.trim() && label !== node.label) void act(() => api.patch('/graph/nodes', { id: node.id, label: label.trim() })); }}>
      <div className="flex-1"><input aria-label="Name" value={label} onChange={(e) => setLabel(e.target.value)} className={controlClass()} /></div>
      <Button type="submit" size="sm" variant="secondary" disabled={!label.trim() || label === node.label}>Rename</Button>
    </form>
  );
}

/** Pick a project or service and add a link to it. */
function AddLink({ from, kind, graph, exclude, act, label }: { from: string; kind: 'calls' | 'served_by'; graph: Graph; exclude: string; act: Act; label: string }) {
  const api = useCoreApi();
  const [to, setTo] = useState('');
  const options = graph.services.filter((n) => n.id !== exclude);
  return (
    <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (to) void act(() => api.post('/graph/edges', { from, to, kind })); }}>
      <div className="flex-1">
        <select aria-label={label} value={to} onChange={(e) => setTo(e.target.value)} className={controlClass()}>
          <option value="">{label}…</option>
          {options.map((n) => <option key={n.id} value={n.id}>{n.label}{n.kind === 'external_service' ? ' (outside service)' : ''}</option>)}
        </select>
      </div>
      <Button type="submit" size="sm" variant="secondary" disabled={!to}>Link</Button>
    </form>
  );
}

function ProjectPanel({ projectId, node, graph, labelOf, act, onClose }: { projectId: string; node: GraphNode; graph: Graph; labelOf: (id: string) => string; act: Act; onClose: () => void }) {
  const api = useCoreApi();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [allRoutes, setAllRoutes] = useState(false);
  const [scanning, setScanning] = useState(false);
  useEffect(() => { void api.get(`/graph/projects/${encodeURIComponent(projectId)}`).then((d: Partial<Panel>) => setPanel({ projectId, scan: d.scan ?? null, frameworks: d.frameworks ?? [], exposes: d.exposes ?? [], calls: d.calls ?? [], calledBy: d.calledBy ?? [], keys: d.keys ?? [] })).catch(() => {}); }, [projectId]);
  const rescan = () => { setScanning(true); void act(() => api.post(`/graph/projects/${encodeURIComponent(projectId)}/rescan`, {})).finally(() => setScanning(false)); };
  const scan = panel?.scan;
  const routes = panel ? (allRoutes ? panel.exposes : panel.exposes.slice(0, 12)) : [];
  return (
    <section className={clsx(cardClass('md'), 'space-y-4')} aria-label={`Project ${node.label}`}>
      <PanelHead title={node.label} onClose={onClose}>
        <p className="mt-1 text-xs text-hud-dim">
          {scan?.error ? <span className="text-hud-amber">{scan.error}</span> : scan?.sha ? <>Read at {scan.sha.slice(0, 7)} · {ago(scan.scannedAt)}{scan.truncated ? ' · large repository, read in part' : ''}</> : 'Not read yet'}
        </p>
      </PanelHead>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={rescan} disabled={scanning}><RefreshCw aria-hidden className={clsx('w-3.5 h-3.5', scanning && 'animate-spin')} />{scanning ? 'Reading…' : 'Read again'}</Button>
        {panel?.frameworks.map((f) => <Badge key={f}>{f}</Badge>)}
      </div>
      <Rename node={node} act={act} />

      <div>
        <h3 className="text-xs font-semibold text-hud-dim uppercase tracking-wide">Calls</h3>
        {panel?.calls.length ? (
          <ul className="mt-2 space-y-3">{panel.calls.map((l) => (
            <li key={l.to}><div className="text-sm font-medium">{labelOf(l.to)}</div><Steps link={l} act={act} /></li>
          ))}</ul>
        ) : <p className="mt-1 text-sm text-hud-dim">Nothing found.</p>}
        <div className="mt-3"><AddLink from={node.id} kind="calls" graph={graph} exclude={node.id} act={act} label="Add a project or service it calls" /></div>
      </div>

      {panel && panel.keys.some((k) => !k.servedBy) && (
        <div>
          <h3 className="text-xs font-semibold text-hud-dim uppercase tracking-wide">Addresses not linked yet</h3>
          <ul className="mt-2 space-y-2">{panel.keys.filter((k) => !k.servedBy).map((k) => (
            <li key={k.id} className="space-y-1"><div className="font-mono text-xs">{k.key}</div><AddLink from={k.id} kind="served_by" graph={graph} exclude={node.id} act={act} label="It points at" /></li>
          ))}</ul>
        </div>
      )}

      <div>
        <h3 className="text-xs font-semibold text-hud-dim uppercase tracking-wide">Called by</h3>
        {panel?.calledBy.length ? (
          <ul className="mt-1 text-sm space-y-1">{panel.calledBy.map((l) => <li key={l.from} className="flex items-center gap-2">{labelOf(l.from)}<Badge tone={CERTAINTY[certaintyOf(l)].tone}>{CERTAINTY[certaintyOf(l)].label}</Badge></li>)}</ul>
        ) : <p className="mt-1 text-sm text-hud-dim">Nothing found.</p>}
      </div>

      <div>
        <h3 className="text-xs font-semibold text-hud-dim uppercase tracking-wide">Exposes{panel ? ` (${panel.exposes.length})` : ''}</h3>
        {routes.length ? (
          <ul className="mt-1 font-mono text-xs space-y-0.5">{routes.map((r) => <li key={r} className="break-all">{r}</li>)}</ul>
        ) : <p className="mt-1 text-sm text-hud-dim">No routes recognised.</p>}
        {panel && panel.exposes.length > 12 && (
          <button type="button" className="mt-1 text-xs text-hud-cyan hover:underline" onClick={() => setAllRoutes((v) => !v)}>{allRoutes ? 'Show fewer' : `Show all ${panel.exposes.length}`}</button>
        )}
      </div>
    </section>
  );
}

function ServicePanel({ node, graph, labelOf, act, onClose }: { node: GraphNode; graph: Graph; labelOf: (id: string) => string; act: Act; onClose: () => void }) {
  const callers = graph.links.filter((l) => l.to === node.id);
  return (
    <section className={clsx(cardClass('md'), 'space-y-3')} aria-label={`Outside service ${node.label}`}>
      <PanelHead title={node.label} onClose={onClose}>
        <p className="mt-1 text-xs text-hud-dim">Outside service{node.source === 'owner' ? ', added or named by you' : ', found by the scan'}</p>
      </PanelHead>
      <Rename node={node} act={act} />
      <div>
        <h3 className="text-xs font-semibold text-hud-dim uppercase tracking-wide">Used by</h3>
        {callers.length ? (
          <ul className="mt-2 space-y-3">{callers.map((l) => <li key={l.from}><div className="text-sm font-medium">{labelOf(l.from)}</div><Steps link={l} act={act} /></li>)}</ul>
        ) : <p className="mt-1 text-sm text-hud-dim">Nothing links to it yet.</p>}
      </div>
    </section>
  );
}
