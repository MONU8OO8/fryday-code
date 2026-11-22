/**
 * Logo: the FryDay Code mark (an indigo-to-violet rounded square with a white lightning bolt),
 * optionally with the "FryDay Code" wordmark. The same mark is ui/public/favicon.svg.
 */

import { useId } from 'react';
import clsx from 'clsx';

export interface LogoProps {
  /** Mark size in px (default 28). */
  size?: number;
  /** Show the "FryDay Code" wordmark next to the mark. */
  wordmark?: boolean;
  className?: string;
}

/** Just the mark, as an inline SVG. Decorative unless `title` is given. */
export function LogoMark({ size = 28, title }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title} className="flex-shrink-0">
      <defs>
        <linearGradient id={`fd-logo-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="7" fill={`url(#fd-logo-${id})`} />
      <path d="M13.5 4 7 13.2h4.2L10 20l6.8-9.6h-4.3z" fill="#fff" />
    </svg>
  );
}

export default function Logo({ size = 28, wordmark = true, className }: LogoProps) {
  if (!wordmark) return <LogoMark size={size} title="FryDay Code" />;
  return (
    <span className={clsx('inline-flex items-center gap-2', className)}>
      <LogoMark size={size} />
      <span className="font-bold tracking-tight text-hud-bright" style={{ fontSize: Math.max(14, Math.round(size * 0.55)) }}>FryDay Code</span>
    </span>
  );
}
