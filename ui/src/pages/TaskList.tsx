/** The left column of Home: tasks grouped by what they need, each with a small journey. */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { CircleCheck, Plus, Sparkles, WifiOff } from 'lucide-react';
import { useCoreApi, useSse } from '../hooks/useSse';
import { useThrottle } from '../hooks/useThrottle';
import type { OverviewItem, TaskGroup } from '../storyTypes';
import { GROUP_TITLE } from '../plain';
import JourneyLine from '../components/JourneyLine';
import { Badge, Button, EmptyState, buttonClass, cardClass } from '../ui';

const WEEK = 7 * 24 * 3600 * 1000;
const ORDER: TaskGroup[] = ['needs_you', 'working', 'done'];

export default function TaskList({ selected }: { selected: string | null }) {
  const api = useCoreApi();
  const [tasks, setTasks] = useState<OverviewItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => api.get('/tasks/overview').then((d) => { setTasks(d.tasks); setFailed(false); }).catch(() => setFailed(true)), []);
  useEffect(() => { void load(); }, [load]);
  const refresh = useThrottle(() => void load(), 1500);
  useSse('/api/events', (ev) => {
    if (ev['type'] === 'run_event') return; // an agent's step changes nothing in the list
    if (typeof ev['taskId'] === 'string' || String(ev['type']).startsWith('task_')) refresh();
  });

  const shown = (tasks ?? []).filter((t) => t.group !== 'done' || Date.now() - t.updatedAt < WEEK);
  const empty = tasks !== null && shown.length === 0;
  return (
    <div>
      {!empty && <Link to="/home/new" className={clsx(buttonClass('primary', 'lg', true), 'mb-4')}><Plus aria-hidden className="w-4 h-4" />New task</Link>}
      {failed && (
        <div className={clsx(cardClass('none'), 'mb-4')}>
          <EmptyState compact icon={<WifiOff className="w-5 h-5" />} title="Could not load your tasks" text="Is FryDay Code still running?"
            action={<Button variant="secondary" size="sm" onClick={() => void load()}>Try again</Button>} />
        </div>
      )}
      {empty && (
        <div className={cardClass('none')}>
          {(tasks?.length ?? 0) === 0 ? (
            <EmptyState compact icon={<Sparkles className="w-5 h-5" />} title="No tasks yet"
              text="Tell FryDay Code what you want done. The team takes it from there."
              action={<Link to="/home/new" className={buttonClass('primary', 'md')}><Plus aria-hidden className="w-4 h-4" />New task</Link>} />
          ) : (
            <EmptyState compact icon={<CircleCheck className="w-5 h-5" />} title="All clear this week"
              text="Older tasks are in History."
              action={<>
                <Link to="/home/new" className={buttonClass('primary', 'md')}><Plus aria-hidden className="w-4 h-4" />New task</Link>
                <Link to="/history" className={buttonClass('secondary', 'md')}>History</Link>
              </>} />
          )}
        </div>
      )}
      {ORDER.map((group) => {
        const list = shown.filter((t) => t.group === group);
        if (list.length === 0) return null;
        return (
          <section key={group} className="mb-5" aria-labelledby={`group-${group}`}>
            <h2 id={`group-${group}`} className="flex items-center gap-2 text-xs font-semibold text-hud-dim mx-1 mb-2">
              {GROUP_TITLE[group]}<span className="font-normal text-hud-dim/80">{list.length}</span>
            </h2>
            <ul className="space-y-2">
              {list.map((t) => (
                <li key={t.id}>
                  <Link to={`/home/${t.id}`} aria-current={selected === t.id ? 'page' : undefined}
                    className={clsx('block rounded-xl border px-3.5 py-3 transition-[box-shadow,border-color] hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60',
                      selected === t.id ? 'border-hud-cyan ring-4 ring-hud-cyan/15 bg-hud-surface'
                        : t.group === 'needs_you' ? 'bg-hud-amber/[0.07] border-hud-amber/30 hover:border-hud-amber/50' : 'bg-hud-surface border-hud-border hover:border-hud-dim/30')}>
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 text-sm font-semibold truncate">{t.title}</span>
                      {t.group === 'needs_you' && <Badge tone="warn" className="flex-shrink-0">Needs you</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-hud-dim truncate">{t.line}{t.projectName ? ` · ${t.projectName}` : ''}</div>
                    {t.group !== 'done' && <JourneyLine journey={t.journey} compact />}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
