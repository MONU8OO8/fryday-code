/**
 * Button: the one button of the Studio look. A real <button> (type="button" unless you say
 * otherwise). For a link that looks like a button, use `buttonClass()` on a <Link>.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

export type ButtonVariant = 'primary' | 'secondary' | 'success' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT: Record<ButtonVariant, string> = {
  // Accent and danger fills use text-hud-onaccent, which flips with the theme to keep contrast.
  primary: 'bg-hud-cyan text-hud-onaccent shadow-sm hover:bg-hud-cyan/90',
  secondary: 'bg-hud-surface text-hud-bright border border-hud-border shadow-sm hover:bg-hud-bg',
  // For "Approve" and other go-ahead decisions.
  success: 'bg-hud-green text-hud-onaccent shadow-sm hover:bg-hud-green/90',
  danger: 'bg-hud-red text-hud-onaccent shadow-sm hover:bg-hud-red/90',
  ghost: 'text-hud-dim hover:text-hud-bright hover:bg-hud-border/40',
};
const SIZE: Record<ButtonSize, string> = {
  sm: 'min-h-8 px-3 py-1 text-xs gap-1.5 rounded-lg',
  md: 'min-h-9 px-4 py-1.5 text-sm gap-2 rounded-lg',
  lg: 'min-h-11 px-5 py-2 text-sm gap-2 rounded-xl',
};

/** Classes for anything that should look like a button (a <Link>, a <label> for a file input). */
export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', block = false): string {
  return clsx(
    'inline-flex items-center justify-center text-center font-semibold select-none transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60 focus-visible:ring-offset-2 focus-visible:ring-offset-hud-surface',
    'disabled:opacity-50 disabled:pointer-events-none aria-disabled:opacity-50 aria-disabled:pointer-events-none',
    VARIANT[variant], SIZE[size], block && 'w-full',
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full width. */
  block?: boolean;
  /** An icon before the text (decorative; give it aria-hidden). */
  icon?: ReactNode;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', block = false, icon, type = 'button', className, children, ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={clsx(buttonClass(variant, size, block), className)} {...rest}>
      {icon}
      {children}
    </button>
  );
});

export default Button;
