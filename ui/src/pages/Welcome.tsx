/**
 * First run: shown on Home instead of the new-task form while there is no confirmed project.
 * Three steps: check this computer, add a project, give FryDay a task.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useCoreApi } from '../hooks/useSse';
import { Badge, Card, PageHeader, buttonClass } from '../ui';

interface Check { id: string; name: string; required: boolean; state: 'ok' | 'warn' | 'problem' | 'off' }
interface Project { verified: boolean }

type StepState = 'done' | 'todo' | 'later' | 'checking';

function Step({ n, title, text, state, status, action }: { n: number; title: string; text: ReactNode; state: StepState; status?: ReactNode; action?: ReactNode }) {
  return (
    <li className={clsx('flex gap-4 rounded-xl border p-4', state === 'todo' ? 'border-hud-cyan/40 bg-hud-cyan/5' : 'border-hud-border bg-hud-bg/60')}>
      <span aria-hidden className={clsx('flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-semibold',
        state === 'done' ? 'bg-hud-green/10 text-hud-green' : state === 'todo' ? 'bg-hud-cyan text-hud-onaccent' : 'bg-hud-border/60 text-hud-dim')}>
        {state === 'done' ? <CheckCircle2 className="h-4 w-4" /> : state === 'checking' ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold text-hud-bright">
          <span className="sr-only">Step {n}: </span>{title}
          <span className="sr-only"> ({state === 'done' ? 'done' : state === 'checking' ? 'checking' : state === 'todo' ? 'to do' : 'after the steps above'})</span>
        </h3>
        <p className="mt-1 text-sm text-hud-dim">{text}</p>
        {status && <div className="mt-2 text-sm">{status}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </li>
  );
}

export default function Welcome({ projects }: { projects: Project[] }) {
  const api = useCoreApi();
  // undefined: still checking (it runs the tools, so it takes a few seconds); null: could not check.
  const [checks, setChecks] = useState<Check[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api.get('/connections').then((r) => { if (live) setChecks((r.checks ?? []) as Check[]); }).catch(() => { if (live) setChecks(null); });
    return () => { live = false; };
  }, []);

  const problems = (checks ?? []).filter((c) => c.required && c.state === 'problem');
  const machine: StepState = checks === undefined ? 'checking' : checks !== null && problems.length === 0 ? 'done' : 'todo';
  const unconfirmed = projects.filter((p) => !p.verified).length;

  return (
    <Card padding="lg" className="h-full overflow-y-auto">
      <PageHeader title="Welcome to FryDay Code" subtitle="Three steps to your first task. It takes a few minutes, once." />
      <ol className="mt-6 space-y-3">
        <Step n={1} title="Check your computer" state={machine}
          text="FryDay runs Claude Code agents in a sandbox on this computer, with your git. This checks that they all work."
          status={checks === undefined ? <span className="text-hud-dim">Checking…</span>
            : checks === null ? <span className="text-hud-red">Could not check. Is FryDay Code still running?</span>
            : problems.length === 0 ? <Badge tone="ok" dot>Everything needed works</Badge>
            : <span className="text-hud-amber">To fix: {problems.map((p) => p.name).join(', ')}</span>}
          action={<Link to="/setup/connections" className={buttonClass(machine === 'done' ? 'secondary' : 'primary', 'sm')}>{machine === 'done' ? 'See the details' : 'Open Connections'}</Link>} />
        <Step n={2} title="Add a project" state={machine === 'done' ? 'todo' : 'later'}
          text="Point FryDay at a git repository on this computer. It works out the branches and commands; you confirm them."
          status={unconfirmed > 0 ? <span className="text-hud-amber">{unconfirmed === 1 ? 'One project is' : `${unconfirmed} projects are`} added but not confirmed yet.</span> : undefined}
          action={<Link to="/setup/projects" className={buttonClass(machine === 'done' ? 'primary' : 'secondary', 'sm')}>Open Your projects</Link>} />
        <Step n={3} title="Give FryDay a task" state="later"
          text="Describe what you want done, in your own words. The team plans, builds and checks it, and asks you before anything leaves this computer." />
      </ol>
      <p className="mt-6 text-sm text-hud-dim">
        Just looking? Run <code className="font-mono text-hud-bright">npx fryday-code demo</code> to try it with stand-in agents: no Claude account and no cost.
      </p>
    </Card>
  );
}
