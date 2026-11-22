/**
 * "What do you want done?": the one box for a new task, with documents and a project.
 * Until a project is confirmed, the first-run welcome (Welcome.tsx) is shown instead.
 */

import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { transport } from '@transport';
import { useCoreApi } from '../hooks/useSse';
import clsx from 'clsx';
import { FileText, X } from 'lucide-react';
import { STOPS, readError } from '../plain';
import type { Actor, StopId } from '../storyTypes';
import { Avatar, Button, Field, PageHeader, cardClass } from '../ui';
import { useSystem } from '../hooks/useSystem';
import Welcome from './Welcome';

/** Who does each step, for "How it works". */
const WHO: Record<StopId, Actor> = { understand: 'understander', plan: 'planner', build: 'builder', check: 'checker', approve: 'you', live: 'releaser' };

interface Project { id: string; name: string; verified: boolean }

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
  const uploaded = useRef(new Set<File>());

  useEffect(() => { api.get('/projects').then((d) => setAllProjects((d.repos ?? []) as Project[])).catch(() => setProjectsFailed(true)); }, []);
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
    try {
      // Created first, so its documents are attached before the Understander reads the task.
      let id = draftId;
      if (!id) {
        const task = await api.post('/tasks', { title: words.split('\n')[0]!.slice(0, 200), description: words, start: false });
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
      await api.post(`/tasks/${id}/start`, { ...(project ? { repoId: project } : {}), ...(project && branch.trim() ? { branch: branch.trim() } : {}) });
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
          <Field as="select" label="Project" value={project} onChange={(e) => setProject(e.target.value)} wrapperClassName="w-full sm:w-64"
            error={projectsFailed ? 'Could not load the projects.' : undefined}>
            <option value="">Let FryDay work it out</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Field>
          <Button variant="ghost" onClick={() => setMore((m) => !m)} aria-expanded={more}>{more ? 'Fewer options' : 'More options'}</Button>
          <Button type="submit" size="lg" className="ml-auto" disabled={busy || !text.trim()}>{busy ? 'Starting…' : 'Start'}</Button>
        </div>
        {more && (
          <Field label="Continue work already started on a branch" hint="Optional. Needs a project." value={branch} onChange={(e) => setBranch(e.target.value)}
            disabled={!project} placeholder="branch name" wrapperClassName="mt-4 max-w-sm" className="font-mono" />
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
