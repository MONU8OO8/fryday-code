/**
 * Field: a labelled form control with an optional hint and error, wired for screen readers
 * (label → control, aria-describedby → hint and error, aria-invalid on error).
 *
 *   <Field label="Project" as="select" value={v} onChange={…}>…options…</Field>
 *   <Field label="Notes" as="textarea" rows={4} hint="Optional" />
 *   <Field label="Name" error={err} value={name} onChange={…} />   // as="input" is the default
 *
 * `className` styles the control; `wrapperClassName` the block around it. For a bare control
 * without a label (a chat reply box), use `controlClass()`.
 */

import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';

/** Classes of a text input, select or textarea in the Studio look. */
export function controlClass(invalid = false): string {
  return clsx(
    'w-full rounded-xl border bg-hud-surface px-3 py-2 text-sm text-hud-bright placeholder:text-hud-dim/80',
    'transition-shadow focus:outline-none focus:ring-4 disabled:opacity-50 disabled:cursor-not-allowed',
    invalid ? 'border-hud-red focus:ring-hud-red/15' : 'border-hud-border focus:border-hud-cyan focus:ring-hud-cyan/15',
  );
}

interface Common {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Keep the label for screen readers only (when a heading above already says it). */
  hideLabel?: boolean;
  wrapperClassName?: string;
}
type InputProps = Common & { as?: 'input' } & InputHTMLAttributes<HTMLInputElement>;
type SelectProps = Common & { as: 'select' } & SelectHTMLAttributes<HTMLSelectElement>;
type TextareaProps = Common & { as: 'textarea' } & TextareaHTMLAttributes<HTMLTextAreaElement>;
export type FieldProps = InputProps | SelectProps | TextareaProps;

export default function Field(props: FieldProps) {
  const auto = useId();
  const { label, hint, error, hideLabel = false, wrapperClassName, id: givenId, className } = props;
  const id = givenId ?? auto;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const aria = {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': clsx(hintId, errorId, props['aria-describedby']) || undefined,
    className: clsx(controlClass(Boolean(error)), className),
  };

  let control: ReactNode;
  if (props.as === 'select') {
    const { label: _l, hint: _h, error: _e, hideLabel: _hl, wrapperClassName: _w, as: _a, ...rest } = props;
    control = <select {...rest} {...aria} />;
  } else if (props.as === 'textarea') {
    const { label: _l, hint: _h, error: _e, hideLabel: _hl, wrapperClassName: _w, as: _a, ...rest } = props;
    control = <textarea {...rest} {...aria} />;
  } else {
    const { label: _l, hint: _h, error: _e, hideLabel: _hl, wrapperClassName: _w, as: _a, ...rest } = props;
    control = <input {...rest} {...aria} />;
  }

  return (
    <div className={wrapperClassName}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'block text-sm font-medium text-hud-bright mb-1.5'}>{label}</label>
      {control}
      {hint && <p id={hintId} className="mt-1.5 text-xs text-hud-dim">{hint}</p>}
      {error && <p id={errorId} className="mt-1.5 text-xs text-hud-red">{error}</p>}
    </div>
  );
}
