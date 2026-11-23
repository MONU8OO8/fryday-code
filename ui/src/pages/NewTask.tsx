/**
 * "What do you want done?": the one box for a new task, with documents and a project.
 * Until a project is confirmed, the first-run welcome (Welcome.tsx) is shown instead.
 */

import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { transport } from '@transport';
import { useCoreApi } from '../hooks/useSse';
import clsx from 'clsx';
import { FileText, Plus, X } from 'lucide-react';
import { STOPS, readError } from '../plain';
import type { Actor, Gate, OverviewItem, Priority, StopId } from '../storyTypes';
import { Avatar, Button, Field, PageHeader, cardClass, controlClass } from '../ui';
import { useSystem } from '../hooks/useSystem';
import Welcome from './Welcome';

/** Who does each step, for "How it works". */
const WHO: Record<StopId, Actor> = { understand: 'understander', plan: 'planner', build: 'builder', check: 'checker', approve: 'you', live: 'releaser' };

interface Project { id: string; name: string; verified: boolean }
interface Part { repoId: string; title: string; after: string; gate: 'start' | 'release' }

const GATE_LABEL: Record<Gate, string> = { start: 'starts after it passes review', release: 'goes to staging after it', link: 'is related (nothing waits)' };

/** The task the demo's stand-in agents follow (core/demo/scenario.json `task.description`). */
const DEMO_TASK = 'Add a CSV export of orders: a toCsv(orders) function in src/export.js, with a test. Customer names can contain commas.';

export default function NewTask() {
  const api = useCoreApi();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  // null: not loaded yet. Every project, confirmed or not; only confirmed ones can take a task.
  const [allProjects, setAllProjects] = useState<Project[] | null>(null);
  const projects = (allProjects ?? []).filter((p) => p.verified);
  const [project, setProject] = useState('');
  const [more, setMore] = useState(false);
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [priority, setPriority] = useState<Priority>('p2');
  const [autoStart, setAutoStart] = useState(false);
  const [openTasks, setOpenTasks] = useState<OverviewItem[]>([]);
  const [waitsFor, setWaitsFor] = useState<Array<{ id: string; gate: Gate }>>([]);
  const [several, setSeveral] = useState(false);
  const [parts, setParts] = useState<Part[]>([]);
  const uploaded = useRef(new Set<File>());

  useEffect(() => { api.get('/projects').then((d) => setAllProjects((d.repos ?? []) as Project[])).catch(() => setProjectsFailed(true)); }, []);
  useEffect(() => {
    if (!more) return;
    api.get('/tasks/overview').then((d) => setOpenTasks(((d.tasks ?? []) as OverviewItem[]).filter((t) => t.group !== 'done' && t.board?.kind !== 'initiative'))).catch(() => {});
  }, [more]);
  useEffect(() => {
    if (several && parts.length === 0) {
      const two = projects.slice(0, 2).map((p) => ({ repoId: p.id, title: '', after: '', gate: 'start' as const }));
      setParts(two.length === 2 ? two : [{ repoId: projects[0]?.id ?? '', title: '', after: '', gate: 'start' }, { repoId: '', title: '', after: '', gate: 'start' }]);
    }
  }, [several]);
  const setPart = (i: number, change: Partial<Part>) => setParts((all) => all.map((p, j) => (j === i ? { ...p, ...change } : p)));
  // The demo's stand-in agents follow one script; suggest the task it was written for
  // (the `task` in core/demo/scenario.json).
  const demo = useSystem()?.demo === true;
  useEffect(() => { if (demo) setText((t) => t || DEMO_TASK); }, [demo]);
  // ...on its one sample project.
  const onlyProject = projects.length === 1 ? projects[0]!.id : '';
  useEffect(() => { if (demo && onlyProject) setProject((p) => p || onlyProject); }, [demo, onlyProject]);

  const drop = (e: DragEvent) => { e.preventDefault(); setFiles((f) => [...f, ...Array.from(e.dataTransfer.files)]); };
  const start = async (e: FormEvent) => {
    e.preventDefault();
    const words = text.trim();
    if (!words) return;
    setBusy(true); setError('');
    const title = words.split('\n')[0]!.slice(0, 200);
    try {
      if (several) {
        // One sub-task per project, made at once; the scheduler starts each as its dependencies allow.
        const body = parts.map((p) => ({
          repoId: p.repoId, title: p.title.trim() || title,
          ...(p.after !== '' ? { dependsOn: [Number(p.after)], gate: p.gate } : {}),
        }));
        const task = await api.post('/tasks', { title, description: words, priority, parts: body, autoStart: true });
        navigate(`/home/${task.id as string}`);
        return;
      }
      // Created first, so its documents are attached before the Understander reads the task.
      let id = draftId;
      if (!id) {
        const task = await api.post('/tasks', {
          title, description: words, start: false, priority,
          ...(project ? { repoId: project } : {}), ...(project && branch.trim() ? { branch: branch.trim() } : {}),
          ...(waitsFor.length ? { dependsOn: waitsFor } : {}),
        });
        id = task.id as string;
        setDraftId(id);
      }
      for (const file of files) {
        if (uploaded.current.has(file)) continue;
        let reason = '';
        try {
          const up = await transport.rawFetch(`/api/tasks/${id}/attachments`, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
            body: file,
          });
          if (up.ok) { uploaded.current.add(file); continue; }
          reason = (await up.json().catch(() => ({}))).error ?? up.statusText;
        } catch (e) {
          reason = readError(e);
        }
        setError(`Your task was saved, but ${file.name} could not be attached: ${reason}. Remove the file or press Start again.`);
        return;
      }
      // Waiting for another task, or left to the scheduler: it starts when it may.
      if (autoStart || waitsFor.some((w) => w.gate === 'start')) await api.patch(`/tasks/${id}/board`, { autoStart: true });
      else await api.post(`/tasks/${id}/start`, { ...(project ? { repoId: project } : {}), ...(project && branch.trim() ? { branch: branch.trim() } : {}) });
      navigate(`/home/${id}`);
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  };

  if (allProjects === null && !projectsFailed) return <div aria-busy="true" className={clsx(cardClass('lg'), 'h-full')} />;
  if (allProjects !== null && projects.length === 0) return <Welcome projects={allProjects} />;

  return (
    <div className={clsx(cardClass('lg'), 'h-full overflow-y-auto')}>
      <Link to="/home" className="md:hidden text-sm text-hud-cyan mb-3 block">← All tasks</Link>
      <PageHeader title="What do you want done?" subtitle="Describe it in your own words. You can drop a document (PDF, Markdown or text) on the box." />
      <form onSubmit={start} onDragOver={(e) => e.preventDefault()} onDrop={drop} className="mt-5">
        <Field as="textarea" label="What do you want done" hideLabel value={text} onChange={(e) => setText(e.target.value)} rows={6}
          placeholder="For example: add a button on the orders page that downloads all orders as a spreadsheet"
          className="resize-y leading-relaxed" />
        {files.length > 0 && (
          <ul aria-label="Attached documents" className="flex flex-wrap gap-2 mt-3">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="inline-flex items-center gap-1.5 text-xs rounded-full border border-hud-border bg-hud-bg pl-2.5 pr-1 py-1">
                <FileText aria-hidden className="w-3.5 h-3.5 text-hud-dim" />
                <span className="font-mono">{f.name}</span>
                <button type="button" onClick={() => setFiles((all) => all.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}
                  className="rounded-full p-0.5 text-hud-dim hover:text-hud-bright hover:bg-hud-border/60"><X aria-hidden className="w-3 h-3" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-3 mt-4">
          {!several && (
            <Field as="select" label="Project" value={project} onChange={(e) => setProject(e.target.value)} wrapperClassName="w-full sm:w-64"
              error={projectsFailed ? 'Could not load the projects.' : undefined}>
              <option value="">Let FryDay work it out</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Field>
          )}
          <Field as="select" label="Priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority)} wrapperClassName="w-36">
            <option value="p0">P0 · now</option>
            <option value="p1">P1 · high</option>
            <option value="p2">P2 · normal</option>
            <option value="p3">P3 · low</option>
          </Field>
          <Button variant="ghost" onClick={() => setMore((m) => !m)} aria-expanded={more}>{more ? 'Fewer options' : 'More options'}</Button>
          <Button type="submit" size="lg" className="ml-auto" disabled={busy || !text.trim() || (several && parts.some((p) => !p.repoId))}>
            {busy ? 'Starting…' : several ? `Create ${parts.length} tasks` : autoStart ? 'Add to the board' : 'Start'}
          </Button>
        </div>
        {more && (
          <div className="mt-4 space-y-4">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={several} onChange={(e) => setSeveral(e.target.checked)} disabled={projects.length < 2} className="mt-0.5" />
              <span>It needs changes in several projects<span className="block text-xs text-hud-dim">One task per project, in the order you set. {projects.length < 2 ? 'Needs two confirmed projects.' : 'Without this, the Understander may still suggest a split.'}</span></span>
            </label>
            {several ? (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium mb-1">Parts</legend>
                {parts.map((p, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-xl border border-hud-border p-2">
                    <span className="text-xs text-hud-dim w-5">{i + 1}.</span>
                    <div className="w-44 shrink-0">
                      <select aria-label={`Project of part ${i + 1}`} value={p.repoId} onChange={(e) => setPart(i, { repoId: e.target.value })} className={controlClass()}>
                        <option value="">Choose a project</option>
                        {projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    </div>
                    <input aria-label={`What changes in part ${i + 1}`} value={p.title} onChange={(e) => setPart(i, { title: e.target.value })}
                      placeholder="What changes there" className={clsx(controlClass(), 'flex-1 min-w-[10rem]')} />
                    {i > 0 && (
                      <div className="w-36 shrink-0">
                        <select aria-label={`Part ${i + 1} waits for`} value={p.after} onChange={(e) => setPart(i, { after: e.target.value })} className={controlClass()}>
                          <option value="">Waits for nothing</option>
                          {parts.slice(0, i).map((_, j) => <option key={j} value={String(j)}>After part {j + 1}</option>)}
                        </select>
                      </div>
                    )}
                    {i > 0 && p.after !== '' && (
                      <div className="w-44 shrink-0">
                        <select aria-label={`How part ${i + 1} waits`} value={p.gate} onChange={(e) => setPart(i, { gate: e.target.value as Part['gate'] })} className={controlClass()}>
                          <option value="start">Start after its review</option>
                          <option value="release">Staging after it</option>
                        </select>
                      </div>
                    )}
                    {parts.length > 2 && (
                      <button type="button" aria-label={`Remove part ${i + 1}`} className="p-1 text-hud-dim hover:text-hud-bright"
                        onClick={() => setParts((all) => all.filter((_, j) => j !== i).map((x) => ({ ...x, after: x.after === String(i) ? '' : x.after !== '' && Number(x.after) > i ? String(Number(x.after) - 1) : x.after })))}>
                        <X aria-hidden className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
                {parts.length < 6 && <Button variant="ghost" size="sm" onClick={() => setParts((all) => [...all, { repoId: '', title: '', after: '', gate: 'start' }])}><Plus aria-hidden className="w-3.5 h-3.5" />Add a part</Button>}
                {files.length > 0 && <p className="text-xs text-hud-amber">Documents cannot be attached to a task split by hand yet; remove them or attach them to a part later.</p>}
              </fieldset>
            ) : (
              <>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} className="mt-0.5" />
                  <span>Start it automatically<span className="block text-xs text-hud-dim">FryDay starts it when a slot is free, by priority. Otherwise it starts now.</span></span>
                </label>
                <div>
                  <span className="text-sm font-medium">Waits for</span>
                  <ul className="mt-1 space-y-1">
                    {waitsFor.map((w, i) => {
                      const t = openTasks.find((x) => x.id === w.id);
                      return (
                        <li key={w.id} className="flex items-center gap-2 text-sm">
                          <span className="font-mono text-xs">{w.id}</span><span className="truncate max-w-[16rem]">{t?.title}</span>
                          <select aria-label={`How it waits for ${w.id}`} value={w.gate} onChange={(e) => setWaitsFor((all) => all.map((x, j) => (j === i ? { ...x, gate: e.target.value as Gate } : x)))}
                            className="rounded-lg border border-hud-border bg-hud-surface text-xs px-1.5 py-1">
                            {(Object.keys(GATE_LABEL) as Gate[]).map((g) => <option key={g} value={g}>{GATE_LABEL[g]}</option>)}
                          </select>
                          <button type="button" aria-label={`Do not wait for ${w.id}`} onClick={() => setWaitsFor((all) => all.filter((_, j) => j !== i))} className="p-0.5 text-hud-dim"><X aria-hidden className="w-3.5 h-3.5" /></button>
                        </li>
                      );
                    })}
                  </ul>
                  <select aria-label="Add a task it waits for" value="" onChange={(e) => { const v = e.target.value; if (v) setWaitsFor((all) => [...all, { id: v, gate: 'start' }]); }}
                    className={clsx(controlClass(), 'mt-1 max-w-sm')} disabled={openTasks.length === 0}>
                    <option value="">{openTasks.length ? 'Add a task it waits for…' : 'No open tasks'}</option>
                    {openTasks.filter((t) => !waitsFor.some((w) => w.id === t.id)).map((t) => <option key={t.id} value={t.id}>{t.id} · {t.title}</option>)}
                  </select>
                </div>
                <Field label="Continue work already started on a branch" hint="Optional. Needs a project." value={branch} onChange={(e) => setBranch(e.target.value)}
                  disabled={!project} placeholder="branch name" wrapperClassName="max-w-sm" className="font-mono" />
              </>
            )}
          </div>
        )}
        {error && <p role="alert" className="text-sm text-hud-red mt-3">{error}</p>}
      </form>
      <h2 className="text-sm font-semibold mt-10 mb-3">How it works</h2>
      <ol className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center text-xs text-hud-dim">
        {STOPS.map((s, i) => (
          <li key={s.id} className="flex flex-col items-center gap-1.5 rounded-xl border border-hud-border bg-hud-bg/60 px-2 py-3">
            <Avatar actor={WHO[s.id]} size="md" />
            <span><span className="sr-only">{i + 1}. </span>{s.name}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
