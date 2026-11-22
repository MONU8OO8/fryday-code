/**
 * Where a task is: six stops on a line. A small marker above the line slides along it when one
 * agent hands the task to the next, the current stop pulses, and a dashed loop counts the times
 * work went back.
 */

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { Journey, StopState } from '../storyTypes';
import { STOPS, fixedTimes } from '../plain';

const DOT: Record<StopState, string> = {
  done: 'bg-hud-green/15',
  active: 'bg-hud-cyan/15 ring-2 ring-hud-cyan jr-pulse',
  waiting: 'bg-hud-amber/15 ring-2 ring-hud-amber jr-pulse-amber',
  failed: 'bg-hud-amber/10 ring-1 ring-hud-amber/60',
  skipped: 'bg-hud-border/40 opacity-40',
  idle: 'bg-hud-border/60 opacity-60',
};
const SEG: Record<StopState, string> = {
  done: 'bg-hud-green', active: 'bg-hud-cyan jr-blink', waiting: 'bg-hud-amber jr-blink',
  failed: 'bg-hud-amber/60', skipped: 'bg-hud-border/50', idle: 'bg-hud-border',
};

/** Index of the stop the marker sits at: the current one, else the last one done. */
function position(j: Journey): number {
  const cur = j.current ? STOPS.findIndex((s) => s.id === j.current) : -1;
  if (cur >= 0) return cur;
  let last = 0;
  j.stops.forEach((s, i) => { if (s.state === 'done') last = i; });
  return last;
}

function label(j: Journey): string {
  const at = STOPS[position(j)]!.name;
  if (j.finished === 'live') return 'Done: live on staging';
  if (j.finished === 'on_staging') return 'Done: on staging';
  if (j.finished === 'handed_over') return 'Done: handed over for review';
  return `${at}${j.sendbacks ? `, ${fixedTimes(j.sendbacks)}` : ''}`;
}

// Stops are 4rem wide inside 1.25rem padding: their centres run from 3.25rem to 100% - 3.25rem.
const along = (f: number) => `calc(3.25rem + (100% - 6.5rem) * ${f})`;

export default function JourneyLine({ journey, compact = false }: { journey: Journey; compact?: boolean }) {
  const f = position(journey) / (STOPS.length - 1);
  const [burst, setBurst] = useState(false);
  const wasLive = useRef(journey.finished === 'live');
  useEffect(() => {
    const live = journey.finished === 'live';
    if (live && !wasLive.current) {
      setBurst(true);
      const t = window.setTimeout(() => setBurst(false), 1200);
      wasLive.current = true;
      return () => window.clearTimeout(t);
    }
    wasLive.current = live;
  }, [journey.finished]);

  if (compact) {
    return (
      <div className="flex gap-1 mt-1.5" role="img" aria-label={label(journey)}>
        {journey.stops.map((s) => <i key={s.id} className={clsx('h-1 flex-1 rounded-full', SEG[s.state])} />)}
      </div>
    );
  }
  return (
    // The stops start 20px down, leaving room for the marker above them; the line runs through their centres (42px).
    <div className="relative px-5 pt-5 pb-10" role="img" aria-label={label(journey)}>
      <div className="absolute top-[40px] h-1 rounded-full bg-hud-border" style={{ left: along(0), right: '3.25rem' }} />
      <div className="absolute top-[40px] h-1 rounded-full bg-gradient-to-r from-hud-green to-hud-cyan transition-[width] duration-700 motion-reduce:transition-none"
        style={{ left: along(0), width: `calc((100% - 6.5rem) * ${f})` }} />
      {journey.current && (
        <div className="jr-token absolute top-[4px] w-3 h-3 -ml-1.5 rounded-full bg-amber-400 ring-2 ring-hud-surface shadow z-10" style={{ left: along(f) }} />
      )}
      <div className="relative flex justify-between">
        {STOPS.map((stop, i) => {
          const s = journey.stops[i]!;
          const here = s.state === 'active' || s.state === 'waiting';
          return (
            <div key={stop.id} className="flex flex-col items-center w-16">
              <div className={clsx('w-11 h-11 rounded-full flex items-center justify-center text-xl', DOT[s.state], burst && stop.id === 'live' && 'jr-burst')}>{stop.icon}</div>
              <span className={clsx('mt-1 text-xs', here ? 'text-hud-bright font-semibold' : 'text-hud-dim')}>{stop.name}</span>
            </div>
          );
        })}
      </div>
      {journey.sendbacks > 0 && (
        <div className="absolute top-[84px] h-5 border-2 border-t-0 border-dashed border-hud-amber/70 rounded-b-2xl" style={{ left: along(0.4), width: 'calc((100% - 6.5rem) * 0.2)' }}>
          <span className="absolute -bottom-5 inset-x-0 text-center text-[11px] text-hud-amber whitespace-nowrap">{fixedTimes(journey.sendbacks)}</span>
        </div>
      )}
    </div>
  );
}
