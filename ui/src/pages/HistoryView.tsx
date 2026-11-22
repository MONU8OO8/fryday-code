/** Finished tasks and the tokens the week used. */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCoreApi } from '../hooks/useSse';
import type { OverviewItem } from '../storyTypes';
import { ACTORS, ago, fixedTimes } from '../plain';
import { countedTokens, fmtTokens } from '../agents';

interface RoleUsage { role: string; runs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
const ACTOR_OF_ROLE: Record<string, keyof typeof ACTORS> = {
  analyst: 'understander', planner: 'planner', coder: 'builder', tester: 'checker', api_tester: 'app_tester', ui_tester: 'page_tester', fryday: 'fryday', system: 'fryday',
};

export default function HistoryView() {
  const api = useCoreApi();
  const [tasks, setTasks] = useState<OverviewItem[]>([]);
  const [roles, setRoles] = useState<RoleUsage[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.get('/tasks/overview').then((d) => setTasks((d.tasks as OverviewItem[]).filter((t) => t.group === 'done'))).catch(() => setFailed(true));
    api.get('/usage/by-role?days=7').then((d) => setRoles(d.roles ?? [])).catch(() => {});
  }, []);
  const week = roles.reduce((n, r) => n + countedTokens(r), 0);
  const reused = roles.reduce((n, r) => n + r.cacheReadTokens, 0);
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
      <section>
        <h2 className="text-lg font-bold mb-1">This week</h2>
        <p className="text-sm text-hud-dim mb-3">{fmtTokens(week)} tokens used by all agents together{reused ? `, and ${fmtTokens(reused)} reused from earlier steps` : ''}.</p>
        <div className="rounded-2xl bg-hud-surface border border-hud-border p-4 space-y-2">
          {roles.filter((r) => r.runs > 0).map((r) => {
            const a = ACTORS[ACTOR_OF_ROLE[r.role] ?? 'fryday'];
            return (
              <div key={r.role} className="flex items-center gap-3 text-sm">
                <span className="w-36">{a.icon} {a.name}</span>
                <span className="flex-1 h-2 rounded-full bg-hud-border overflow-hidden"><span className="block h-full rounded-full" style={{ width: `${week ? (countedTokens(r) / week) * 100 : 0}%`, background: a.color }} /></span>
                <span className="w-24 text-right">{fmtTokens(countedTokens(r))} tokens</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
