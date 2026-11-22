/**
 * Section: a titled group inside a page (plain sentence-case title, optional description and
 * actions). Set `card` to put the section in a Card.
 */

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { cardClass } from './Card';

export interface SectionProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Wrap the section in a card. */
  card?: boolean;
  className?: string;
  children?: ReactNode;
}

export default function Section({ title, description, actions, card = false, className, children }: SectionProps) {
  return (
    <section className={clsx(card && cardClass('md'), className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1 mb-3">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-sm font-semibold text-hud-bright">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-hud-dim">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
