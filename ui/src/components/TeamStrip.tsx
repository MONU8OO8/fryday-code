/**
 * The team on a task, under its title: the pipeline's agents as avatars with names. The agent
 * working now bobs gently, agents not reached yet are dimmed, and on each hand-off a small
 * yellow task card hops from the previous agent to the next (about 600 ms). Reduced motion:
 * no bob, no flying card.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import clsx from 'clsx';
import type { Actor, StopId, StopState, TaskStory } from '../storyTypes';
import { ACTORS } from '../plain';
import { Avatar } from '../ui';

/** The usual team, in pipeline order. The testers join only when they took part. */
const CORE: Actor[] = ['understander', 'planner', 'builder', 'checker', 'releaser'];
const TESTERS: Actor[] = ['app_tester', 'page_tester'];

/** The stop each agent works at. */
const STOP_OF: Partial<Record<Actor, StopId[]>> = {
  understander: ['understand'],
  planner: ['plan'],
  builder: ['build'],
  checker: ['check'],
  releaser: ['approve', 'live'],
};
/**
 * Who has the task at each stop. The Releaser asks for your OK; while the Understander's question
 * waits for your answer, core puts the journey at Understand (journey.ts), so the Understander is the
 * one marked as waiting for you, never the Releaser.
 */
const ACTOR_AT: Record<StopId, Actor> = { understand: 'understander', plan: 'planner', build: 'builder', check: 'checker', approve: 'releaser', live: 'releaser' };

const REACHED: StopState[] = ['active', 'waiting', 'done', 'failed'];

export function teamOf(story: TaskStory): Actor[] {
  const took = new Set(story.items.map((i) => i.from));
  if (story.now) took.add(story.now.actor);
  const testers = TESTERS.filter((t) => took.has(t));
  // The testers sit between the Checker and the Releaser.
  return [...CORE.slice(0, 4), ...testers, 'releaser'];
}

/** The agent working now: who core says is running, else who holds the journey's current stop. */
export function workingOf(story: TaskStory, team: Actor[]): Actor | null {
  const now = story.now?.actor;
  if (now && team.includes(now)) return now;
  if (now === 'checks') return 'checker';
  if (story.journey.finished !== null) return null;
  return story.journey.current ? ACTOR_AT[story.journey.current] : null;
}

function reachedOf(story: TaskStory, team: Actor[], working: Actor | null): Set<Actor> {
  const seen = new Set<Actor>();
  for (const i of story.items) { seen.add(i.from); if (i.to) seen.add(i.to); }
  const state = new Map(story.journey.stops.map((s) => [s.id, s.state]));
  return new Set(team.filter((a) => a === working || seen.has(a) || (STOP_OF[a] ?? []).some((s) => REACHED.includes(state.get(s) ?? 'idle'))));
}

interface Flight { key: number; x: number; y: number; dx: number; dy: number }

export default function TeamStrip({ story }: { story: TaskStory }) {
  const team = teamOf(story);
  const working = workingOf(story, team);
  const reached = reachedOf(story, team, working);
  const current = story.journey.stops.find((s) => s.id === story.journey.current);
  const waitsForYou = !story.now && current?.state === 'waiting';

  const box = useRef<HTMLUListElement>(null);
  const spots = useRef(new Map<Actor, HTMLElement>());
  // The last agent that had the task; a gap with nobody working does not reset it.
  const last = useRef<Actor | null>(working);
  const [flight, setFlight] = useState<Flight | null>(null);

  useLayoutEffect(() => {
    if (!working) return;
    const from = last.current;
    last.current = working;
    if (!from || from === working) return;
    const a = spots.current.get(from), b = spots.current.get(working), root = box.current;
    if (!a || !b || !root) return;
    const r = root.getBoundingClientRect(), ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    setFlight({ key: Date.now(), x: ra.left - r.left + ra.width / 2, y: ra.top - r.top, dx: rb.left - ra.left, dy: rb.top - ra.top });
  }, [working]);

  useEffect(() => {
    if (!flight) return;
    const t = window.setTimeout(() => setFlight(null), 700);
    return () => window.clearTimeout(t);
  }, [flight]);

  return (
    <ul ref={box} aria-label="The team on this task" className="relative flex flex-wrap gap-x-2 gap-y-3 sm:gap-x-4 pt-4 pb-1">
      {team.map((actor) => {
        const on = actor === working;
        const dim = !reached.has(actor);
        return (
          <li key={actor} ref={(el) => { if (el) spots.current.set(actor, el); else spots.current.delete(actor); }}
            className={clsx('flex flex-col items-center gap-1.5 w-[4.5rem] text-center transition-opacity duration-500', dim && 'opacity-40')}>
            <span className={clsx('rounded-full', on && !waitsForYou && 'team-bob', on && (waitsForYou ? 'ring-2 ring-hud-amber ring-offset-2 ring-offset-hud-surface' : 'ring-2 ring-hud-cyan/50 ring-offset-2 ring-offset-hud-surface'))}>
              <Avatar actor={actor} size="lg" />
            </span>
            <span className={clsx('text-xs leading-tight', on ? 'font-semibold text-hud-bright' : 'text-hud-dim')}>
              {ACTORS[actor].name}
              {on && <span className="sr-only">{waitsForYou ? ', waiting for you' : ', working now'}</span>}
              {dim && <span className="sr-only">, not reached yet</span>}
            </span>
          </li>
        );
      })}
      {flight && (
        <li key={flight.key} aria-hidden className="team-fly pointer-events-none absolute w-4 h-3 rounded-[3px] bg-amber-400 shadow-md shadow-amber-400/50 z-10"
          style={{ left: flight.x, top: flight.y, '--dx': `${flight.dx}px`, '--dy': `${flight.dy}px` } as CSSProperties} />
      )}
    </ul>
  );
}
