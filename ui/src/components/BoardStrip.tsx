/**
 * The board facts of one task, under its journey line: priority, whether FryDay starts it on its
 * own, the initiative it belongs to (or its sub-tasks), and the tasks it waits for. Everything
 * shown comes from the story; the owner can change priority, auto-start and drop a dependency.
 */

import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Check, Clock, Layers, Link2, X } from 'lucide-react';
import type { BoardFacts, Gate, Priority } from '../storyTypes';

const GATE_WORDS: Record<Gate, string> = { start: 'starts after its review', release: 'staging after it', link: 'related' };
const PRIORITY_TONE: Record<Priority, string> = {
  p0: 'border-hud-red/50 text-hud-red', p1: 'border-hud-amber/50 text-hud-amber',
  p2: 'border-hud-border text-hud-dim', p3: 'border-hud-border text-hud-dim/70',
};

interface Props {
  board: BoardFacts;
  /** Whether it has not started yet, so auto-start still means something. */
  notStarted: boolean;
  busy: boolean;
  onChange: (change: { priority?: Priority; autoStart?: boolean }) => void;
  onDropDependency: (dependsOn: string) => void;
}

export default function BoardStrip({ board, notStarted, busy, onChange, onDropDependency }: Props) {
  const initiative = board.kind === 'initiative';
  return (
    <div className="mb-3 space-y-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <label className={clsx('inline-flex items-center rounded-full border px-1.5', PRIORITY_TONE[board.priority])}>
          <span className="sr-only">Priority</span>
          <select value={board.priority} disabled={busy} onChange={(e) => onChange({ priority: e.target.value as Priority })}
            className="bg-transparent py-0.5 font-semibold uppercase focus:outline-none">
            {(['p0', 'p1', 'p2', 'p3'] as const).map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
          </select>
        </label>
        {initiative && <span className="inline-flex items-center gap-1 rounded-full border border-hud-cyan/40 text-hud-cyan px-2 py-0.5"><Layers aria-hidden className="w-3 h-3" />{board.children.length} sub-tasks</span>}
        {board.parent && (
          <Link to={`/home/${board.parent.id}`} className="inline-flex items-center gap-1 rounded-full border border-hud-border px-2 py-0.5 text-hud-dim hover:text-hud-bright">
            <Layers aria-hidden className="w-3 h-3" />Part of {board.parent.id} · <span className="truncate max-w-[14rem]">{board.parent.title}</span>
          </Link>
        )}
        {!initiative && notStarted && (
          <label className="inline-flex items-center gap-1.5 text-hud-dim">
            <input type="checkbox" checked={board.autoStart} disabled={busy} onChange={(e) => onChange({ autoStart: e.target.checked })} />
            Start automatically when it may
          </label>
        )}
      </div>
      {initiative && board.children.length > 0 && (
        <ol className="space-y-1" aria-label="Sub-tasks">
          {(board.parts ?? board.children.map((id) => ({ id, title: '', state: '', label: '' }))).map((p) => (
            <li key={p.id}>
              <Link to={`/home/${p.id}`} className="flex items-center gap-2 rounded-lg border border-hud-border px-2 py-1 hover:border-hud-dim/40">
                <span className="font-mono text-hud-dim">{p.id}</span>
                <span className="min-w-0 flex-1 truncate text-hud-bright">{p.title}</span>
                {p.label && <span className={clsx(p.state === 'deployed' ? 'text-hud-green' : p.state === 'failed' ? 'text-hud-red' : 'text-hud-dim')}>{p.label}</span>}
              </Link>
            </li>
          ))}
        </ol>
      )}
      {board.dependsOn.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Waits for">
          {board.dependsOn.map((d) => (
            <li key={d.id} className={clsx('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5',
              d.gate === 'link' ? 'border-hud-border text-hud-dim' : d.met ? 'border-hud-green/40 text-hud-green' : 'border-hud-amber/50 text-hud-amber')}>
              {d.gate === 'link' ? <Link2 aria-hidden className="w-3 h-3" /> : d.met ? <Check aria-hidden className="w-3 h-3" /> : <Clock aria-hidden className="w-3 h-3" />}
              <Link to={`/home/${d.id}`} className="font-mono hover:underline">{d.id}</Link>
              <span className="truncate max-w-[12rem]">{d.title}</span>
              <span className="opacity-70">· {GATE_WORDS[d.gate]}</span>
              <button type="button" disabled={busy} aria-label={`Stop waiting for ${d.id}`} onClick={() => onDropDependency(d.id)} className="ml-0.5 opacity-60 hover:opacity-100"><X aria-hidden className="w-3 h-3" /></button>
            </li>
          ))}
        </ul>
      )}
      {board.waiting && <p role="status" className="text-hud-amber">{board.waiting}</p>}
    </div>
  );
}
