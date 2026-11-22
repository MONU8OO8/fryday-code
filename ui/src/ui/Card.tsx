/**
 * Card: a white (surface) panel with a soft border, radius 16 and a faint shadow. Use
 * `cardClass()` to give the same look to a <Link> or <form>.
 */

import type { HTMLAttributes } from 'react';
import clsx from 'clsx';

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

const PAD: Record<CardPadding, string> = { none: '', sm: 'p-3', md: 'p-5', lg: 'p-6 sm:p-8' };

/** Classes of a card; `selected` adds the accent ring used for the open item of a list. */
export function cardClass(padding: CardPadding = 'md', selected = false): string {
  return clsx(
    'rounded-2xl border bg-hud-surface shadow-card',
    selected ? 'border-hud-cyan ring-4 ring-hud-cyan/15' : 'border-hud-border',
    PAD[padding],
  );
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: CardPadding;
  selected?: boolean;
}

export default function Card({ padding = 'md', selected = false, className, ...rest }: CardProps) {
  return <div className={clsx(cardClass(padding, selected), className)} {...rest} />;
}
