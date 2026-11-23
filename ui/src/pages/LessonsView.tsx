/**
 * Lessons: what the agents learned from earlier tasks. The Reflector and FryDay itself
 * propose them with the evidence; the owner approves, rewords or rejects each one, and only
 * approved lessons are ever given to an agent. Active lessons show how often they were used
 * and whether the tasks that got them went better.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Check, GraduationCap, Pencil, X } from 'lucide-react';
import { useCoreApi, useSse } from '../hooks/useSse';
import { useThrottle } from '../hooks/useThrottle';
import { ago } from '../plain';
import { look } from '../agents';
import { Badge, Button, EmptyState, PageHeader, cardClass, controlClass } from '../ui';

const ROLES = ['analyst', 'planner', 'coder', 'tester'] as const;
type Role = (typeof ROLES)[number];

interface Evidence { taskId: string; round: number | null; what: string }
interface Lesson {
  id: number;
  projectId: string | null;
  role: Role;
  text: string;
  evidence: Evidence[];
  source: 'reflector' | 'core';
  state: 'proposed' | 'active' | 'retired' | 'rejected';
  uses: number;
  helped: number;
  hurt: number;
  createdAt: number;
  decidedAt: number | null;
  suggestRetire: boolean;
}
interface Lessons { proposed: Lesson[]; active: Lesson[]; retired: Lesson[]; projects: Record<string, string> }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const SOURCE: Record<Lesson['source'], string> = { reflector: 'Proposed by the Reflector', core: "From FryDay's own records" };

export default function LessonsView() {
  const api = useCoreApi();
  const [data, setData] = useState<Lessons | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.get('/lessons').then((d: Partial<Lessons>) => {
    setData({ proposed: d.proposed ?? [], active: d.active ?? [], retired: d.retired ?? [], projects: d.projects ?? {} });
  }).catch((err) => setError(message(err)));
  useEffect(() => { void load(); }, []);
  const reload = useThrottle(() => { void load(); }, 1000);
  useSse('/api/events', (ev) => { if (ev['type'] === 'lessons_updated') reload(); });

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(message(err));
    }
  };
  const decide = (id: number, to: 'active' | 'rejected' | 'retired') => act(() => api.post(`/lessons/${id}/decide`, { to }));
  const scope = (l: Lesson) => (l.projectId ? data?.projects[l.projectId] ?? l.projectId : 'Every project');

  const empty = data && data.proposed.length + data.active.length + data.retired.length === 0;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-5">
      <PageHeader title="Lessons" subtitle="What the agents learned from earlier tasks. Nothing here reaches an agent until you approve it." />
      {error && <p role="alert" className="text-sm text-hud-red">{error}</p>}

      {empty && (
        <div className={cardClass('none')}>
          <EmptyState icon={<GraduationCap className="w-5 h-5" />} title="No lessons yet"
            text="When a task is sent back, fails or is stopped, the Reflector reads what happened and proposes lessons here for you to approve. FryDay also proposes one when a check keeps failing the same way." />
        </div>
      )}

      {data && data.proposed.length > 0 && (
        <section aria-label="Waiting for you" className="space-y-3">
          <h2 className="text-sm font-semibold text-hud-bright">Waiting for you <span className="text-hud-dim font-normal">({data.proposed.length})</span></h2>
          {data.proposed.map((l) => (
            <Proposed key={l.id} lesson={l} scope={scope(l)}
              onApprove={() => void decide(l.id, 'active')}
              onReject={() => void decide(l.id, 'rejected')}
              onSave={(change) => act(() => api.patch(`/lessons/${l.id}`, change))} />
          ))}
        </section>
      )}

      {data && data.active.length > 0 && (
        <section aria-label="Active lessons" className="space-y-3">
          <h2 className="text-sm font-semibold text-hud-bright">Active <span className="text-hud-dim font-normal">({data.active.length})</span></h2>
          <div className={clsx(cardClass('none'), 'divide-y divide-hud-border/60')}>
            {data.active.map((l) => (
              <div key={l.id} className="p-4 space-y-2">
                <Meta lesson={l} scope={scope(l)} />
                <p className="text-sm text-hud-bright">{l.text}</p>
                <div className="flex flex-wrap items-center gap-3 text-xs text-hud-dim">
                  <span>Given {l.uses} time{l.uses === 1 ? '' : 's'}</span>
                  <span title="Tasks that got it and passed their first round">Helped {l.helped}</span>
                  <span title="Tasks that got it and still hit the failure it came from">Did not help {l.hurt}</span>
                  {l.suggestRetire && <Badge tone="warn">Did not help {l.hurt} times: retire it?</Badge>}
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void decide(l.id, 'retired')}>Retire</Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {data && data.retired.length > 0 && (
        <details className={clsx(cardClass('sm'), 'text-sm')}>
          <summary className="cursor-pointer text-hud-dim">Retired ({data.retired.length})</summary>
          <ul className="mt-3 space-y-3">
            {data.retired.map((l) => (
              <li key={l.id} className="space-y-1">
                <Meta lesson={l} scope={scope(l)} />
                <p className="text-hud-dim">{l.text}</p>
                <Button size="sm" variant="ghost" onClick={() => void decide(l.id, 'active')}>Make active again</Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Meta({ lesson, scope }: { lesson: Lesson; scope: string }) {
  const agent = look(lesson.role);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge tone="accent">For the {agent.name}</Badge>
      <Badge>{scope}</Badge>
      <span className="text-hud-dim">{SOURCE[lesson.source]} · {ago(lesson.createdAt)}</span>
    </div>
  );
}

function Proposed({ lesson, scope, onApprove, onReject, onSave }: {
  lesson: Lesson;
  scope: string;
  onApprove: () => void;
  onReject: () => void;
  onSave: (change: { text: string; role: Role; global: boolean }) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(lesson.text);
  const [role, setRole] = useState<Role>(lesson.role);
  const [global, setGlobal] = useState(lesson.projectId === null);
  useEffect(() => { setText(lesson.text); setRole(lesson.role); setGlobal(lesson.projectId === null); }, [lesson.text, lesson.role, lesson.projectId]);

  return (
    <article className={clsx(cardClass('md'), 'space-y-3')} aria-label={`Proposed lesson for the ${look(lesson.role).name}`}>
      <Meta lesson={lesson} scope={scope} />
      {editing ? (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void onSave({ text: text.trim(), role, global }).then(() => setEditing(false)); }}>
          <textarea aria-label="Lesson" rows={3} value={text} onChange={(e) => setText(e.target.value)} className={controlClass()} maxLength={400} />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-hud-dim">For the</span>
              <span className="w-40">
                <select aria-label="Agent" value={role} onChange={(e) => setRole(e.target.value as Role)} className={controlClass()}>
                  {ROLES.map((r) => <option key={r} value={r}>{look(r).name}</option>)}
                </select>
              </span>
            </label>
            <label className="flex items-center gap-2 text-hud-dim">
              <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} disabled={lesson.projectId === null} />
              Every project
            </label>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
              <Button size="sm" type="submit" disabled={text.trim().length < 12}>Save</Button>
            </div>
          </div>
        </form>
      ) : (
        <p className="text-sm text-hud-bright">{lesson.text}</p>
      )}
      {lesson.evidence.length > 0 && (
        <div className="text-xs">
          <p className="text-hud-dim mb-1">Why</p>
          <ul className="space-y-1">
            {lesson.evidence.map((e, i) => (
              <li key={i} className="flex gap-2">
                <Link to={`/tasks/${encodeURIComponent(e.taskId)}`} className="text-hud-cyan hover:underline shrink-0">{e.taskId}{e.round ? `, round ${e.round}` : ''}</Link>
                <span className="text-hud-dim break-words">{e.what}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!editing && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="success" onClick={onApprove}><Check aria-hidden className="w-3.5 h-3.5" />Approve</Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}><Pencil aria-hidden className="w-3.5 h-3.5" />Edit</Button>
          <Button size="sm" variant="ghost" onClick={onReject}><X aria-hidden className="w-3.5 h-3.5" />Reject</Button>
        </div>
      )}
    </article>
  );
}
