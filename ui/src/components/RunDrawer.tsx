/**
 * One agent run, opened from a lane: every step it took, the files it touched, the commands it
 * ran with their exit codes, its final report and, for the Builder, what its round changed.
 * While the run is going the timeline follows it.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { FileText, Search, Pencil, Terminal, Plug, Globe, MessageSquare, Wrench, Flag, X, type LucideIcon } from 'lucide-react';
import { useCoreApi } from '../hooks/useSse';
import { Badge } from '../ui';
import { look, fmtTokens, fmtDuration, modelName } from '../agents';
import { RUN_STATE, type RunSummary, type StepKind, type TimelinePage, type TimelineStep } from '../runTypes';

const KIND: Record<StepKind, { icon: LucideIcon; label: string }> = {
  read: { icon: FileText, label: 'Read' },
  search: { icon: Search, label: 'Searched' },
  edit: { icon: Pencil, label: 'Edited' },
  command: { icon: Terminal, label: 'Ran' },
  mcp: { icon: Plug, label: 'Used' },
  web: { icon: Globe, label: 'Looked up' },
  message: { icon: MessageSquare, label: 'Said' },
  other: { icon: Wrench, label: 'Used' },
  finished: { icon: Flag, label: 'Finished' },
};

const TABS = ['Timeline', 'Files', 'Commands', 'Report', 'Diff'] as const;
type Tab = (typeof TABS)[number];
const PAGE = 100;
const FOLLOW_MS = 2500;

/** Steps in order; a step that comes again (its result arrived) replaces the earlier copy. */
export function mergeSteps(prev: TimelineStep[], next: TimelineStep[]): TimelineStep[] {
  const byId = new Map(prev.map((s, i) => [s.id, i]));
  const out = [...prev];
  for (const s of next) {
    const at = byId.get(s.id);
    if (at === undefined) { byId.set(s.id, out.length); out.push(s); } else out[at] = s;
  }
  return out;
}

function StepRow({ step }: { step: TimelineStep }) {
  const k = KIND[step.kind] ?? KIND.other;
  const Icon = k.icon;
  const failed = step.ok === false;
  return (
    <li className="flex gap-2.5 py-1.5">
      <Icon aria-hidden className={clsx('mt-0.5 h-3.5 w-3.5 flex-shrink-0', failed ? 'text-hud-red' : step.kind === 'edit' ? 'text-hud-amber' : 'text-hud-dim')} />
      <div className="min-w-0 flex-1 text-xs">
        {step.kind === 'message'
          ? <p className="whitespace-pre-wrap text-hud-bright">{step.text}</p>
          : (
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-hud-dim">{k.label}</span>
              {step.tool && step.kind !== 'finished' && <span className="font-mono text-hud-cyan">{step.tool}</span>}
              {step.hint && <code className="break-all font-mono text-hud-bright">{step.hint}</code>}
              {step.kind === 'command' && step.exitCode !== undefined && (
                <Badge tone={step.exitCode === 0 ? 'ok' : 'bad'}>exit {step.exitCode}</Badge>
              )}
              {step.kind !== 'command' && failed && <Badge tone="bad">{step.kind === 'finished' ? 'with an error' : 'failed'}</Badge>}
              {step.ok === undefined && step.kind !== 'finished' && <span className="text-hud-dim">…</span>}
            </div>
          )}
      </div>
      {step.at && <time className="flex-shrink-0 text-[11px] tabular-nums text-hud-dim" dateTime={new Date(step.at).toISOString()}>{new Date(step.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>}
    </li>
  );
}

function DiffView({ patch }: { patch: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-hud-border bg-hud-bg p-3 font-mono text-[11px] leading-relaxed">
      {patch.split('\n').map((line, i) => (
        <div key={i} className={clsx(
          line.startsWith('+++') || line.startsWith('---') ? 'font-semibold text-hud-bright'
            : line.startsWith('+') ? 'bg-hud-green/10 text-hud-green'
            : line.startsWith('-') ? 'bg-hud-red/10 text-hud-red'
            : line.startsWith('@@') ? 'text-hud-cyan'
            : line.startsWith('diff ') ? 'mt-2 text-hud-dim' : 'text-hud-bright')}>{line || ' '}</div>
      ))}
    </pre>
  );
}

export default function RunDrawer({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const api = useCoreApi();
  const [tab, setTab] = useState<Tab>('Timeline');
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [steps, setSteps] = useState<TimelineStep[]>([]);
  const [cursor, setCursor] = useState(0);
  const [more, setMore] = useState(false);
  const [live, setLive] = useState(false);
  const [failed, setFailed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const cursorRef = useRef(0);

  const loadSummary = (id: string) =>
    api.get(`/agents/${id}/summary`).then((d) => setSummary(d?.run ? (d as RunSummary) : null)).catch(() => setFailed(true));

  const loadPage = (id: string, from: number) =>
    api.get(`/agents/${id}/timeline?cursor=${from}&limit=${PAGE}`).then((d: Partial<TimelinePage>) => {
      setSteps((prev) => mergeSteps(from === 0 ? [] : prev, d.steps ?? []));
      cursorRef.current = d.cursor ?? from;
      setCursor(d.cursor ?? from);
      setMore(!!d.more);
      setLive((was) => {
        if (was && !d.live) void loadSummary(id);
        return !!d.live;
      });
    });

  useEffect(() => {
    setTab('Timeline'); setSummary(null); setSteps([]); setCursor(0); setMore(false); setLive(false); setFailed(false);
    cursorRef.current = 0;
    if (!runId) return;
    void loadSummary(runId);
    loadPage(runId, 0).catch(() => setFailed(true));
    closeRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // Follow a live run: ask for what came after the last page (a step still waiting for its result comes again).
  useEffect(() => {
    if (!runId || !live) return;
    const t = window.setInterval(() => { void loadPage(runId, cursorRef.current).catch(() => {}); }, FOLLOW_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, live]);

  useEffect(() => {
    if (!runId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runId, onClose]);

  if (!runId) return null;
  const run = summary?.run;
  const l = look(run?.role ?? 'system');
  const Icon = l.icon;
  const state = run ? RUN_STATE[live ? 'running' : run.state] ?? { label: run.state, tone: 'neutral' as const } : null;

  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end" role="presentation">
      <button type="button" aria-label="Close" tabIndex={-1} className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={`${run?.who ?? 'Agent'} run`}
        className="flow-in relative flex h-full w-full max-w-2xl flex-col border-l border-hud-border bg-hud-surface shadow-xl">
        <header className="border-b border-hud-border p-4">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full" style={{ background: `${l.color}22`, color: l.color }}>
              <Icon aria-hidden className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-hud-bright">{run?.who ?? 'Loading…'}{run && run.round > 0 && <span className="font-normal text-hud-dim"> · round {run.round}</span>}</h2>
                {state && <Badge tone={state.tone} dot={live}>{state.label}</Badge>}
              </div>
              {run && (
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-hud-dim">
                  {run.taskId ? <Link to={`/tasks/${run.taskId}`} onClick={onClose} className="font-mono text-hud-cyan hover:underline">{run.taskId}</Link> : <span>Chat</span>}
                  {run.taskTitle && <span className="truncate">{run.taskTitle}</span>}
                  {run.model && <span>{modelName(run.model)}</span>}
                  <span>{fmtTokens(run.tokens)}{run.limit ? ` of ${fmtTokens(run.limit)}` : ''} tokens</span>
                  <span>{fmtDuration((run.endedAt ?? Date.now()) - run.startedAt)}</span>
                </div>
              )}
              {run?.error && run.state !== 'completed' && <p className="mt-1 text-xs text-hud-red">{run.error}</p>}
            </div>
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Close"
              className="rounded-lg p-1.5 text-hud-dim hover:bg-hud-border/40 hover:text-hud-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60">
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>
          <div role="tablist" aria-label="Run details" className="mt-3 flex gap-1 text-xs">
            {TABS.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={clsx('rounded-lg px-2.5 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60',
                  tab === t ? 'bg-hud-cyan/10 font-semibold text-hud-cyan' : 'text-hud-dim hover:text-hud-bright')}>
                {t}
                {t === 'Files' && summary ? ` (${summary.filesEdited.length})` : ''}
                {t === 'Commands' && summary ? ` (${summary.commands.length})` : ''}
              </button>
            ))}
          </div>
        </header>

        <div role="tabpanel" aria-label={tab} className="flex-1 overflow-y-auto p-4">
          {failed && <p role="alert" className="text-sm text-hud-red">Could not load this run. Is FryDay running?</p>}

          {tab === 'Timeline' && (
            <>
              {steps.length === 0 && !failed && <p className="text-sm text-hud-dim">{live ? 'Starting…' : 'No steps were recorded for this run.'}</p>}
              <ol className="divide-y divide-hud-border/60">{steps.map((s) => <StepRow key={s.id} step={s} />)}</ol>
              {more && !live && (
                <button type="button" onClick={() => void loadPage(runId, cursor).catch(() => {})}
                  className="mt-3 text-sm font-semibold text-hud-cyan hover:underline">Show more steps</button>
              )}
              {live && <p className="mt-3 flex items-center gap-1.5 text-xs text-hud-dim"><span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-hud-cyan motion-reduce:animate-none" />Following the run as it goes.</p>}
            </>
          )}

          {tab === 'Files' && summary && (
            <div className="space-y-3 text-sm">
              {summary.filesEdited.length === 0
                ? <p className="text-hud-dim">It changed no file.</p>
                : <ul className="space-y-1">{summary.filesEdited.map((f) => <li key={f} className="flex gap-2"><Pencil aria-hidden className="mt-0.5 h-3.5 w-3.5 text-hud-amber" /><code className="break-all font-mono text-xs text-hud-bright">{f}</code></li>)}</ul>}
              <p className="text-xs text-hud-dim">It read {summary.filesRead} file{summary.filesRead === 1 ? '' : 's'}{summary.mcpCalls ? ` and used the service or browser ${summary.mcpCalls} time${summary.mcpCalls === 1 ? '' : 's'}` : ''}, in {summary.steps} step{summary.steps === 1 ? '' : 's'}.</p>
            </div>
          )}

          {tab === 'Commands' && summary && (
            summary.commands.length === 0 ? <p className="text-sm text-hud-dim">It ran no command.</p> : (
              <ul className="space-y-1.5">
                {summary.commands.map((c, i) => (
                  <li key={i} className="flex items-baseline gap-2 text-xs">
                    <Badge tone={c.exitCode === null ? 'neutral' : c.exitCode === 0 ? 'ok' : 'bad'}>{c.exitCode === null ? 'no result' : `exit ${c.exitCode}`}</Badge>
                    <code className="break-all font-mono text-hud-bright">{c.hint || '(a command)'}</code>
                  </li>
                ))}
              </ul>
            )
          )}

          {tab === 'Report' && summary && (
            <div className="space-y-3">
              {summary.report ? <p className="whitespace-pre-wrap text-sm text-hud-bright">{summary.report}</p> : <p className="text-sm text-hud-dim">{live ? 'The report comes when it finishes.' : 'It left no report.'}</p>}
              {summary.output !== null && summary.output !== undefined && (
                <details>
                  <summary className="cursor-pointer text-xs font-semibold text-hud-cyan">Its structured answer</summary>
                  <pre className="mt-2 overflow-x-auto rounded-lg border border-hud-border bg-hud-bg p-3 font-mono text-[11px] text-hud-bright">{JSON.stringify(summary.output, null, 2)}</pre>
                </details>
              )}
            </div>
          )}

          {tab === 'Diff' && summary && (
            !summary.diff ? <p className="text-sm text-hud-dim">Only the Builder changes code; this run has no diff.</p>
              : summary.diff.patch ? <>{summary.diff.note && <p className="mb-2 text-xs text-hud-amber">{summary.diff.note}</p>}<DiffView patch={summary.diff.patch} /></>
              : <p className="text-sm text-hud-dim">{summary.diff.note}</p>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
