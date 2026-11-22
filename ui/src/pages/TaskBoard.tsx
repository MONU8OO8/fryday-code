import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { LayoutGrid, Clock } from 'lucide-react';
import clsx from 'clsx';
import { useSse, useCoreApi } from '../hooks/useSse';
import { look } from '../agents';

interface Task {
  id: string;
  title: string;
  state: string;
  created_at: number;
  updated_at: number;
}

// Every state has a column, so no task is ever missing from the board.
const COLUMNS: { states: string[]; label: string; color: string }[] = [
  { states: ['queued'],                 label: 'Queued',            color: 'hud-dim'   },
  { states: ['intake'],                 label: 'Understanding',     color: 'hud-cyan'  },
  { states: ['waiting_owner'],          label: 'Your answer',       color: 'hud-amber' },
  { states: ['workspace', 'planning'],  label: 'Planning',          color: 'hud-cyan'  },
  { states: ['coding'],                 label: 'Coding',            color: 'hud-amber' },
  { states: ['testing'],                label: 'Testing',           color: 'hud-cyan'  },
  { states: ['verifying'],              label: 'Trying it out',     color: 'hud-cyan'  },
  { states: ['awaiting_approval'],      label: 'Needs approval',    color: 'hud-amber' },
  { states: ['releasing'],              label: 'Releasing',         color: 'hud-amber' },
  { states: ['deploying'],              label: 'Deploying',         color: 'hud-cyan'  },
  { states: ['needs_owner'],            label: 'Back with you',     color: 'hud-red'   },
  { states: ['deployed'],               label: 'Deployed',          color: 'hud-green' },
  { states: ['failed'],                 label: 'Failed',            color: 'hud-red'   },
];

function since(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function TaskCard({ task, working }: { task: Task; working: string | null }) {
  const agent = working ? look(working) : null;
  const Icon = agent?.icon;
  return (
    <Link
      to={`/tasks/${task.id}`}
      className={clsx('flow-in block bg-hud-bg border rounded p-2.5 text-xs font-mono hover:border-hud-cyan/40 transition-colors',
        agent ? 'border-hud-cyan/30' : 'border-hud-border')}
    >
      <div className="text-hud-cyan font-bold mb-1">{task.id}</div>
      <div className="text-hud-bright mb-1.5 leading-tight line-clamp-2 font-sans text-[13px]">{task.title}</div>
      <div className="flex items-center gap-1 text-hud-dim">
        {agent && Icon ? (
          <span className="flex items-center gap-1" style={{ color: agent.color }}>
            <span className="relative flex w-3.5 h-3.5 items-center justify-center">
              <span className="absolute inset-0 rounded-full animate-ping opacity-30" style={{ background: agent.color }} />
              <Icon className="w-3 h-3 relative" />
            </span>
            {agent.name}
          </span>
        ) : (
          <><Clock className="w-3 h-3" /><span>{since(task.updated_at)}</span></>
        )}
      </div>
    </Link>
  );
}

export default function TaskBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  /** Which agent is working on each task right now. */
  const [working, setWorking] = useState<Record<string, string>>({});
  const api = useCoreApi();

  const refresh = () => {
    api.get('/tasks?limit=200').then((d) => setTasks(d.tasks ?? [])).catch(() => {});
    api.get('/agents').then((d) => {
      const map: Record<string, string> = {};
      for (const run of (d.agents ?? []) as Array<{ task_id: string | null; role: string; is_active: boolean }>) {
        if (run.is_active && run.task_id) map[run.task_id] = run.role;
      }
      setWorking(map);
    }).catch(() => {});
  };
  useEffect(() => { refresh(); }, []);
  useSse('/api/events', (ev) => {
    if (['task_created', 'task_updated', 'task_cancelled', 'run_started', 'run_exit'].includes(ev['type'] as string)) refresh();
  });

  const byState = (state: string) => tasks.filter((t) => t.state === state);

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-4 pb-2 border-b border-hud-border">
        <LayoutGrid className="w-5 h-5 text-hud-cyan" />
        <h1 className="text-lg font-mono font-bold text-hud-cyan">TASKS</h1>
        <span className="text-hud-dim text-xs font-mono ml-1">{tasks.length} total</span>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {COLUMNS.map(({ states, label, color }) => {
          const col = states.flatMap((state) => byState(state));
          return (
            // An empty column stays (so nothing can go missing) but takes little room.
            <div key={label} className={clsx('flex-shrink-0 transition-all duration-500', col.length ? 'w-52' : 'w-24 opacity-50')}>
              <div className={clsx('text-xs font-mono font-bold mb-2 flex items-center gap-1 truncate', `text-${color}`)}>
                {label}
                {col.length > 0 && <span className="ml-1 px-1 rounded bg-hud-border text-hud-dim">{col.length}</span>}
              </div>
              <div className="space-y-1.5 min-h-8">
                {col.map((t) => <TaskCard key={`${t.id}-${t.state}`} task={t} working={working[t.id] ?? null} />)}
              </div>
            </div>
          );
        })}
      </div>

      {tasks.length === 0 && (
        <div className="mt-8 text-center text-hud-dim font-mono text-sm italic">
          No tasks yet. Send something from the Command Deck.
        </div>
      )}
    </div>
  );
}
