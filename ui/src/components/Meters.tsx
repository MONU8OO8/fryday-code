/**
 * Small meters: where an agent's tokens went, how much of a budget is used, how much of
 * a time limit has passed.
 */

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { countedTokens, fmtDuration, fmtTokens } from '../agents';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const PARTS = [
  { key: 'cacheReadTokens', label: 'reused (not counted)', color: 'bg-hud-dim/30' },
  { key: 'cacheWriteTokens', label: 'written to cache', color: 'bg-hud-green/50' },
  { key: 'inputTokens', label: 'new input', color: 'bg-hud-cyan/80' },
  { key: 'outputTokens', label: 'written by the agent', color: 'bg-hud-amber' },
] as const;

/**
 * Where the tokens went. Cache reads are context reused from earlier turns: they are shown
 * as "reused" and do not count toward a limit. A bar that is mostly reused is an agent
 * re-using context well.
 */
export function TokenBar({ usage, compact = false }: { usage: Usage; compact?: boolean }) {
  const total = PARTS.reduce((n, p) => n + usage[p.key], 0);
  return (
    <div>
      <div className="flex h-1.5 rounded-full overflow-hidden bg-hud-border/60" title={PARTS.map((p) => `${p.label}: ${usage[p.key].toLocaleString()}`).join('\n')}>
        {total > 0 && PARTS.map((p) => (
          <div key={p.key} className={clsx(p.color, 'transition-all duration-700')} style={{ width: `${(usage[p.key] / total) * 100}%` }} />
        ))}
      </div>
      {!compact && (
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs tabular-nums text-hud-dim">
          <span>{fmtTokens(countedTokens(usage))} tokens</span>
          <span><span className="font-medium text-hud-amber">{fmtTokens(usage.outputTokens)}</span> out</span>
          <span><span className="font-medium text-hud-cyan">{fmtTokens(usage.inputTokens)}</span> in</span>
          <span><span className="text-hud-green font-medium">{fmtTokens(usage.cacheWriteTokens)}</span> to cache</span>
          <span><span className="text-hud-bright">{fmtTokens(usage.cacheReadTokens)}</span> reused</span>
        </div>
      )}
    </div>
  );
}

/** A filled bar; amber past 75%, red past 95%. */
export function LimitBar({ used, limit, label, value }: { used: number; limit: number; label: string; value: string }) {
  const share = limit > 0 ? Math.min(used / limit, 1) : 0;
  const color = share > 0.95 ? 'bg-hud-red' : share > 0.75 ? 'bg-hud-amber' : 'bg-hud-green/70';
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-xs tabular-nums text-hud-dim">
        <span>{label}</span>
        <span className={share > 0.75 ? 'font-medium text-hud-amber' : 'text-hud-bright'}>{value}</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden bg-hud-border/60">
        <div className={clsx(color, 'h-full transition-all duration-700')} style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

/** The task's token budget: the tokens it has used against what it may use. */
export function BudgetBar({ usedTokens, limitTokens }: { usedTokens: number; limitTokens: number }) {
  return <LimitBar used={usedTokens} limit={limitTokens} label="Token budget" value={`${fmtTokens(usedTokens)} of ${fmtTokens(limitTokens)} tokens`} />;
}

/** One run's token limit: what it has used against what it may use. */
export function RunTokenBar({ usage, limit }: { usage: Usage; limit: number }) {
  const used = countedTokens(usage);
  return <LimitBar used={used} limit={limit} label="Tokens this run" value={`${fmtTokens(used)} of ${fmtTokens(limit)}`} />;
}

/** Re-renders every second, for clocks. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** How long a running agent has been at it, against its time limit. */
export function ClockBar({ startedAt, deadlineAt }: { startedAt: number; deadlineAt: number | null }) {
  const now = useNow(true);
  const elapsed = now - startedAt;
  if (!deadlineAt) return <div className="text-xs tabular-nums text-hud-dim">Running {fmtDuration(elapsed)}</div>;
  return <LimitBar used={elapsed} limit={deadlineAt - startedAt} label="Time" value={`${fmtDuration(elapsed)} of ${fmtDuration(deadlineAt - startedAt)}`} />;
}
