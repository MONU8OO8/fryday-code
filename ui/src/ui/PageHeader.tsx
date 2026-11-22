/** PageHeader: the title of a screen or panel, a one-line subtitle, and buttons on the right. */

import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Buttons or links shown at the right (they wrap under the title on small screens). */
  actions?: ReactNode;
  /** Heading level of the title; defaults to h1. */
  level?: 1 | 2;
  className?: string;
}

export default function PageHeader({ title, subtitle, actions, level = 1, className }: PageHeaderProps) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <div className={clsx('flex flex-wrap items-start gap-x-4 gap-y-2', className)}>
      <div className="min-w-0 flex-1">
        <Heading className={clsx('font-semibold tracking-tight text-hud-bright', level === 1 ? 'text-xl' : 'text-lg')}>{title}</Heading>
        {subtitle && <p className="mt-1 text-sm text-hud-dim">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
