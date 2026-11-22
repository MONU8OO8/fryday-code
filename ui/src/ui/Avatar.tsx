/**
 * Avatar: an agent (or You) as a small person in the actor's colour (ui/src/plain.ts ACTORS) on
 * a tinted circle, with one tool mark: magnifier (Understander), document (Planner), hard hat
 * (Builder), check (Checker), ticked box (Automatic checks), signal (App tester), screen
 * (Page tester), rocket (Releaser), bolt (FryDay), none (You).
 *
 * Decorative by default (aria-hidden), because a name is almost always next to it. Pass
 * `decorative={false}` when the avatar stands alone; it is then an image named after the actor.
 */

import { useId, type ReactNode } from 'react';
import clsx from 'clsx';
import type { Actor } from '../storyTypes';
import { ACTORS } from '../plain';

export type AvatarSize = 'sm' | 'md' | 'lg';
const PX: Record<AvatarSize, number> = { sm: 24, md: 32, lg: 40 };

const W = '#fff';
const line = { stroke: W, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/** The tool mark, drawn on the chest (or the head, for the hard hat). */
function mark(actor: Actor, color: string): ReactNode {
  switch (actor) {
    case 'understander':
      return <><circle cx="19" cy="30.5" r="3.2" strokeWidth="1.6" {...line} /><path d="M21.4 32.9 24 35.5" strokeWidth="1.8" {...line} /></>;
    case 'planner':
      return <><rect x="15.5" y="27" width="9" height="9.5" rx="1.3" fill={W} /><path d="M17.5 30h5M17.5 32.6h3.4" stroke={color} strokeWidth="1.2" strokeLinecap="round" /></>;
    case 'builder':
      return <><path d="M12.6 15a7.4 7.4 0 0 1 14.8 0z" fill="#b45309" /><rect x="10.8" y="13.8" width="18.4" height="2.4" rx="1.2" fill="#b45309" /><rect x="19.2" y="8.2" width="1.6" height="5" rx="0.8" fill="#fcd34d" /></>;
    case 'checker':
      return <path d="M15.6 31.4l3 3 5.8-6.4" strokeWidth="2.1" {...line} />;
    case 'checks':
      return <><rect x="15" y="27" width="10" height="9" rx="2" strokeWidth="1.5" {...line} /><path d="M17.6 31.5l1.8 1.8 3.1-3.4" strokeWidth="1.5" {...line} /></>;
    case 'app_tester':
      return <g transform="translate(0 1.2)"><circle cx="20" cy="34.5" r="1.4" fill={W} /><path d="M16.8 31.6a4.6 4.6 0 0 1 6.4 0M14.6 29.4a7.8 7.8 0 0 1 10.8 0" strokeWidth="1.5" {...line} /></g>;
    case 'page_tester':
      return <><rect x="14.5" y="27" width="11" height="7" rx="1.2" strokeWidth="1.5" {...line} /><path d="M18 36.3h4" strokeWidth="1.5" {...line} /></>;
    case 'releaser':
      return <g transform="translate(0 1.8)"><path d="M20 25.6c2.4 1.7 3.2 4.3 3.2 7.1l-1.2 1.3h-4l-1.2-1.3c0-2.8.8-5.4 3.2-7.1z" fill={W} /><circle cx="20" cy="29.8" r="1.1" fill={color} /><path d="M19 35h2l-1 2.2z" fill="#fbbf24" /></g>;
    case 'fryday':
      return <path d="M21.2 27.6 16.8 34h3l-.9 4.6 4.4-6.4h-3z" fill={W} />;
    case 'you':
      return null;
  }
}

export interface AvatarProps {
  actor: Actor;
  /** sm 24px, md 32px (default), lg 40px. */
  size?: AvatarSize;
  /** Hidden from screen readers (default). Set false when no name is shown next to it. */
  decorative?: boolean;
  className?: string;
}

export default function Avatar({ actor, size = 'md', decorative = true, className }: AvatarProps) {
  const a = ACTORS[actor];
  const clip = `av-${useId().replace(/:/g, '')}`;
  const px = PX[size];
  return (
    <svg width={px} height={px} viewBox="0 0 40 40" className={clsx('flex-shrink-0', className)}
      aria-hidden={decorative ? true : undefined} role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : a.name}>
      <defs><clipPath id={clip}><circle cx="20" cy="20" r="20" /></clipPath></defs>
      <circle cx="20" cy="20" r="20" fill={a.color} fillOpacity="0.16" />
      <g clipPath={`url(#${clip})`}>
        <path d="M7 41c0-8.5 5.8-13.3 13-13.3S33 32.5 33 41z" fill={a.color} />
      </g>
      <circle cx="20" cy="16" r="7" fill={a.color} />
      {mark(actor, a.color)}
    </svg>
  );
}
