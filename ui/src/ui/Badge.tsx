/** Badge: a small rounded label for a state ("Done", "Needs you", "Failed"). */

import type { HTMLAttributes } from 'react';
import clsx from 'clsx';

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad';

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-hud-border/50 text-hud-dim',
  accent: 'bg-hud-cyan/10 text-hud-cyan',
  ok: 'bg-hud-green/10 text-hud-green',
  warn: 'bg-hud-amber/10 text-hud-amber',
  bad: 'bg-hud-red/10 text-hud-red',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** A small dot in the tone's colour before the text. */
  dot?: boolean;
}

export default function Badge({ tone = 'neutral', dot = false, className, children, ...rest }: BadgeProps) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONE[tone], className)} {...rest}>
      {dot && <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
