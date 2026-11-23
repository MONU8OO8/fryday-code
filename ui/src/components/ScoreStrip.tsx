/**
 * How one agent has been doing: the last 7 days next to the last 30, with an arrow when the
 * week is better or worse than the month. Built from stored facts (core/src/runner/scorecard.ts).
 */

import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { fmtTokens } from '../agents';
import type { RoleScore, Scorecard } from '../runTypes';

type Better = 'higher' | 'lower' | null;
interface Figure { label: string; week: number | null; month: number | null; show: (n: number) => string; better: Better; title?: string }

const pct = (n: number) => `${Math.round(n * 100)}%`;
const num = (n: number) => String(Math.round(n * 10) / 10);
const stops = (s: RoleScore) => s.stops.timeout + s.stops.budget + s.stops.failed;

/** Week against month: a change under 5% of the month's value is no trend. */
function trend(f: Figure): 'up' | 'down' | null {
  if (f.week === null || f.month === null || f.better === null) return null;
  const gap = f.week - f.month;
  if (Math.abs(gap) <= Math.max(Math.abs(f.month) * 0.05, 1e-9)) return null;
  return gap > 0 ? 'up' : 'down';
}

function figures(role: string, c: Scorecard): Figure[] {
  const { week, month } = c;
  const out: Figure[] = [
    { label: 'Runs', week: week.runs, month: month.runs, show: String, better: null },
    { label: 'Tokens per task', week: week.tokensPerTask, month: month.tokensPerTask, show: fmtTokens, better: 'lower' },
    { label: 'Minutes per run', week: week.minutesPerRun, month: month.minutesPerRun, show: num, better: 'lower' },
    { label: 'Stopped', week: stops(week), month: stops(month), show: String, better: 'lower', title: 'Runs stopped at their time or token limit, or that failed' },
  ];
  if (role === 'coder') {
    out.splice(1, 0,
      { label: 'Passed first time', week: week.firstRoundPassRate ?? null, month: month.firstRoundPassRate ?? null, show: pct, better: 'higher', title: "Share of tasks whose first round passed every check and the Checker's reading" },
      { label: 'Rounds to pass', week: week.roundsToPass ?? null, month: month.roundsToPass ?? null, show: num, better: 'lower' },
      { label: 'Self-check right', week: week.selfCheckAccuracy ?? null, month: month.selfCheckAccuracy ?? null, show: pct, better: 'higher', title: 'Of the criteria the Builder said were met, the share the Checker agreed with. A wrong "met" is overconfidence.' });
  } else if (['tester', 'api_tester', 'ui_tester'].includes(role)) {
    out.splice(1, 0, { label: 'Let through', week: week.passRate ?? null, month: month.passRate ?? null, show: pct, better: null, title: 'Share of its verdicts that let the change through' });
  }
  return out;
}

export default function ScoreStrip({ role, card }: { role: string; card: Scorecard | null | undefined }) {
  if (!card || card.month.runs === 0) return <p className="text-xs text-hud-dim">No runs in the last 30 days.</p>;
  const causes = card.month.failureCauses ?? [];
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {figures(role, card).map((f) => {
          const t = trend(f);
          const good = t && ((t === 'up') === (f.better === 'higher'));
          const Arrow = t === 'up' ? ArrowUpRight : ArrowDownRight;
          return (
            <div key={f.label} className="rounded-lg border border-hud-border/70 px-2.5 py-1.5" title={f.title}>
              <dt className="truncate text-[11px] text-hud-dim">{f.label}</dt>
              <dd className="flex items-baseline gap-1">
                <span className="text-sm font-semibold tabular-nums text-hud-bright">{f.week === null ? '–' : f.show(f.week)}</span>
                {t && <Arrow aria-label={good ? 'better than the month' : 'worse than the month'} className={clsx('h-3.5 w-3.5 self-center', good ? 'text-hud-green' : 'text-hud-red')} />}
                <span className="ml-auto text-[11px] tabular-nums text-hud-dim" title="Last 30 days">{f.month === null ? '–' : f.show(f.month)}</span>
              </dd>
            </div>
          );
        })}
      </dl>
      {causes.length > 0 && (
        <div className="text-xs">
          <span className="text-hud-dim">Sent back for: </span>
          {causes.map((c, i) => (
            <span key={c.cause} className="text-hud-bright" title={c.example ? `Latest: ${c.example}` : undefined}>
              {i > 0 && <span className="text-hud-dim"> · </span>}{c.cause} <span className="text-hud-dim">×{c.count}</span>
            </span>
          ))}
        </div>
      )}
      {role === 'coder' && card.month.lessonTrend && card.month.lessonTrend.withLessons.tasks > 0 && (
        <p className="text-xs text-hud-dim" title="Last 30 days, first rounds only">
          Passed first time with approved lessons:{' '}
          <span className="text-hud-bright">{pct(card.month.lessonTrend.withLessons.firstRoundPassRate ?? 0)}</span> of {card.month.lessonTrend.withLessons.tasks}
          {' '}· without: <span className="text-hud-bright">{card.month.lessonTrend.without.firstRoundPassRate === null ? '–' : pct(card.month.lessonTrend.without.firstRoundPassRate)}</span> of {card.month.lessonTrend.without.tasks}
        </p>
      )}
    </div>
  );
}
