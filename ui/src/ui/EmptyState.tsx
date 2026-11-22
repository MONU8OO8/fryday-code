/** EmptyState: nothing to show yet. A small picture, a title, one short line and an action. */

import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface EmptyStateProps {
  /** A decorative icon or Avatar (it is hidden from screen readers). */
  icon?: ReactNode;
  title: ReactNode;
  text?: ReactNode;
  /** A Button or a Link styled with buttonClass(). */
  action?: ReactNode;
  /** Tighter spacing for a narrow column. */
  compact?: boolean;
  className?: string;
}

export default function EmptyState({ icon, title, text, action, compact = false, className }: EmptyStateProps) {
  return (
    <div className={clsx('flex flex-col items-center text-center', compact ? 'px-3 py-6' : 'px-6 py-12', className)}>
      {icon && (
        <div aria-hidden className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-hud-cyan/10 text-hud-cyan">{icon}</div>
      )}
      <p className="text-sm font-semibold text-hud-bright">{title}</p>
      {text && <p className="mt-1 max-w-sm text-sm text-hud-dim">{text}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
