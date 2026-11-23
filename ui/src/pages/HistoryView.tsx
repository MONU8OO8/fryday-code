/** Finished tasks, and where tokens and agent time went by stage and by project. */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCoreApi } from '../hooks/useSse';
import type { OverviewItem } from '../storyTypes';
import { ago, fixedTimes } from '../plain';
import { fmtTokens } from '../agents';
import CostAnalytics from '../components/CostAnalytics';

export default function HistoryView() {
  const api = useCoreApi();
  const [tasks, setTasks] = useState<OverviewItem[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.get('/tasks/overview').then((d) => setTasks(((d?.tasks ?? []) as OverviewItem[]).filter((t) => t.group === 'done'))).catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <section>
        <h1 className="text-xl font-bold mb-3">Finished tasks</h1>
        {failed ? <p className="text-sm text-hud-red">Could not load your tasks. Is FryDay running?</p> : tasks.length === 0 ? <p className="text-sm text-hud-dim">Nothing finished yet.</p> : (
          <div className="rounded-2xl bg-hud-surface border border-hud-border divide-y divide-hud-border">
            {tasks.map((t) => (
              <Link key={t.id} to={`/home/${t.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-hud-bg">
                <span className="text-lg">{t.journey.finished === 'live' || t.journey.finished === 'on_staging' ? '🚀' : t.journey.finished === 'handed_over' ? '📦' : '⏹️'}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold truncate">{t.title}</span>
                  <span className="block text-xs text-hud-dim">{t.line}{t.projectName ? ` · ${t.projectName}` : ''}{t.journey.sendbacks ? ` · ${fixedTimes(t.journey.sendbacks)}` : ''}</span>
                </span>
                <span className="text-xs text-hud-dim text-right">{fmtTokens(t.usedTokens)} tokens · {ago(t.updatedAt)}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
      <CostAnalytics />
    </div>
  );
}
