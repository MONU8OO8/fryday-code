/** Where tokens and agent time went, per journey stage and per project, over the last days. */

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Coins } from 'lucide-react';
import { useCoreApi } from '../hooks/useSse';
import { fmtTokens } from '../agents';
import type { CostAnalytics as Cost, CostRow } from '../runTypes';

const RANGES = [7, 30, 90];

function minutes(m: number): string {
  if (m < 1) return m > 0 ? 'under a minute' : '0 min';
  if (m < 90) return `${Math.round(m)} min`;
  return `${Math.round((m / 60) * 10) / 10} h`;
}

function Bars({ title, rows }: { title: string; rows: CostRow[] }) {
  const max = Math.max(...rows.map((r) => r.tokens), 1);
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-hud-dim">{title}</h3>
      {rows.length === 0 ? <p className="text-sm text-hud-dim">Nothing ran in this time.</p> : (
        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={r.key} className="text-sm">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-hud-bright">{r.key}</span>
                <span className="tabular-nums text-hud-bright">{fmtTokens(r.tokens)}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hud-border/60">
                <div className="h-full rounded-full bg-hud-cyan transition-all duration-700" style={{ width: `${(r.tokens / max) * 100}%` }} />
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-hud-dim">
                <span>{r.runs} run{r.runs === 1 ? '' : 's'}</span>
                <span>{minutes(r.minutes)} of agent time</span>
                {r.reusedTokens > 0 && <span>{fmtTokens(r.reusedTokens)} reused</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function CostAnalytics() {
  const api = useCoreApi();
  const [days, setDays] = useState(30);
  const [cost, setCost] = useState<Cost | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.get(`/agents/analytics?days=${days}`)
      .then((d) => { setCost({ days, byStage: Array.isArray(d?.byStage) ? d.byStage : [], byProject: Array.isArray(d?.byProject) ? d.byProject : [] }); setFailed(false); })
      .catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);
  const total = cost?.byStage.reduce((n, r) => n + r.tokens, 0) ?? 0;
  const time = cost?.byStage.reduce((n, r) => n + r.minutes, 0) ?? 0;
  return (
    <section className="rounded-2xl border border-hud-border bg-hud-surface p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Coins aria-hidden className="h-4 w-4 text-hud-amber" />
        <h2 className="text-lg font-bold">Cost and time</h2>
        {cost && <span className="text-sm text-hud-dim">{fmtTokens(total)} tokens · {minutes(time)} of agent time</span>}
        <div className="ml-auto flex text-xs" role="group" aria-label="Time range">
          {RANGES.map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d}
              className={clsx('border px-2.5 py-1 first:rounded-l-lg last:rounded-r-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60',
                days === d ? 'border-hud-cyan bg-hud-cyan/10 font-semibold text-hud-cyan' : 'border-hud-border text-hud-dim hover:text-hud-bright')}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      {failed ? <p className="text-sm text-hud-red">Could not load the figures. Is FryDay running?</p> : cost && (
        <div className="grid gap-6 md:grid-cols-2">
          <Bars title="By stage" rows={cost.byStage} />
          <Bars title="By project" rows={cost.byProject} />
        </div>
      )}
      <p className="mt-3 text-xs text-hud-dim">Tokens are input, output and cache writes. Agent time adds up each run, so agents working side by side count twice.</p>
    </section>
  );
}
