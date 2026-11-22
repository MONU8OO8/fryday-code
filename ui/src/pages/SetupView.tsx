/** Setup, for the developer: one checklist; each step opens the detailed screen for it. */

import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, CircleDashed, HelpCircle, Loader2 } from 'lucide-react';
import { useCoreApi } from '../hooks/useSse';
import { Badge, PageHeader, cardClass } from '../ui';
import clsx from 'clsx';

type Mark = 'checking' | 'done' | 'todo' | 'optional' | 'unknown';
interface Step { title: string; why: string; to: string; mark: Mark }

export function BackToSetup({ children }: { children: ReactNode }) {
  return (
    <div>
      <div className="mx-auto max-w-5xl px-4 pt-4 md:px-6"><Link to="/setup" className="rounded text-sm font-medium text-hud-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60">← Setup</Link></div>
      {children}
    </div>
  );
}

type Conn = { checks?: Array<{ id: string; state: string }>; dataConnections?: Array<{ enabled: boolean }> };

/** Each answer fills its own steps; until then a step says it is being checked. null: the request failed. */
function marks(conn: Conn | null | undefined, projects: { repos?: Array<{ verified: boolean }> } | null | undefined,
  notes: { chat?: { configured?: boolean } } | null | undefined, jenkins: { jenkins?: { configured?: boolean } } | null | undefined): Step[] {
  const ok = (id: string) => (conn?.checks ?? []).some((c) => c.id === id && c.state === 'ok');
  const mark = <T,>(answer: T | null | undefined, done: (a: T | null) => boolean, otherwise: Mark): Mark =>
    answer === undefined ? 'checking' : answer === null ? 'unknown' : done(answer) ? 'done' : otherwise;
  return [
    { title: 'Claude Code', why: 'The agents run on it, signed in on this computer.', to: '/setup/connections', mark: mark(conn, () => ok('claude') && ok('sandbox'), 'todo') },
    { title: 'Your projects', why: 'The code FryDay may work on.', to: '/setup/projects', mark: mark(projects, (p) => (p?.repos ?? []).some((r) => r.verified), 'todo') },
    { title: 'Chat space', why: 'So FryDay can message you, and you can give tasks from Chat.', to: '/setup/connections', mark: mark(notes, (n) => Boolean(n?.chat?.configured), 'todo') },
    { title: 'Staging deploys', why: 'Jenkins, if your team deploys staging with it.', to: '/setup/connections', mark: mark(jenkins, (j) => Boolean(j?.jenkins?.configured), 'optional') },
    { title: 'Agents', why: 'Models, token limits and engines. The defaults work.', to: '/setup/agents', mark: 'done' },
    { title: 'Data for testing', why: 'Read-only test databases the testers may look at.', to: '/setup/connections', mark: mark(conn, (c) => (c?.dataConnections ?? []).some((d) => d.enabled), 'optional') },
  ];
}

export default function SetupView() {
  const api = useCoreApi();
  // undefined: still asking. The connections check is slow; the others fill in first.
  const [conn, setConn] = useState<Conn | null | undefined>(undefined);
  const [projects, setProjects] = useState<{ repos?: Array<{ verified: boolean }> } | null | undefined>(undefined);
  const [notes, setNotes] = useState<{ chat?: { configured?: boolean } } | null | undefined>(undefined);
  const [jenkins, setJenkins] = useState<{ jenkins?: { configured?: boolean } } | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const fill = <T,>(path: string, set: (v: T | null) => void) => {
      api.get(path).then((v: T) => { if (live) set(v); }).catch(() => { if (live) set(null); });
    };
    fill('/connections', setConn);
    fill('/projects', setProjects);
    fill('/notifications', setNotes);
    fill('/deploy/jenkins', setJenkins);
    return () => { live = false; };
  }, []);
  const steps = marks(conn, projects, notes, jenkins);
  const icon: Record<Mark, { Icon: typeof Circle; cls: string; label: string }> = {
    checking: { Icon: Loader2, cls: 'animate-spin text-hud-dim motion-reduce:animate-none', label: 'Checking' },
    done: { Icon: CheckCircle2, cls: 'text-hud-green', label: 'Done' },
    todo: { Icon: Circle, cls: 'text-hud-amber', label: 'To do' },
    optional: { Icon: CircleDashed, cls: 'text-hud-dim', label: 'Optional' },
    unknown: { Icon: HelpCircle, cls: 'text-hud-dim', label: 'Could not check' },
  };
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
      <PageHeader title="Setup" subtitle="For your developer, once. Nothing here is needed day to day." />
      {[conn, projects, notes, jenkins].includes(null) && <p role="alert" className="text-sm text-hud-red">Could not check some of the steps. Is FryDay running?</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map((s) => {
          const { Icon, cls, label } = icon[s.mark];
          return (
            <Link key={s.title} to={s.to} className={clsx(cardClass('md'), 'block transition-colors hover:border-hud-cyan/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60')}>
              <div className="flex items-center gap-2 font-semibold text-hud-bright">
                <Icon aria-hidden className={clsx('h-4 w-4 flex-shrink-0', cls)} /> {s.title}
                <span className="sr-only"> ({label})</span>
              </div>
              <div className="mt-1 text-sm text-hud-dim">{s.why}</div>
              {(s.mark === 'optional' || s.mark === 'unknown' || s.mark === 'checking') && <Badge className="mt-2">{label}</Badge>}
            </Link>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <Link to="/setup/activity" className="font-medium text-hud-cyan hover:underline">Agent activity</Link>
        <Link to="/setup/console" className="font-medium text-hud-cyan hover:underline">Talk to FryDay (console)</Link>
      </div>
    </div>
  );
}
