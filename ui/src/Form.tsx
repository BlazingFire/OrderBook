import { rem } from './rem.js';
/**
 * Form foundation (§9): Input, NumberInput, Textarea, DateField, Checkbox,
 * Switch, Slider, Label, HelperText, FieldError, and FormField — the
 * label/control/help/error composite every screen builds a field from.
 * `Select` lives in `SuggestInput.tsx`, beside the list it shares.
 *
 * Numeric entry is right-aligned tabular figures with no steppers; a screen
 * that wants ↑/↓ ± Shift stepping adds it on its own quantity cells (§9.2).
 */

import { forwardRef, useId, useState } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react';
import { Icon } from './icons';
import { t } from './i18n.js';

export function Label({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label className="ob-label" htmlFor={htmlFor}>
      {children}
    </label>
  );
}

export function HelperText({ children }: { children: ReactNode }) {
  return <div className="ob-help">{children}</div>;
}

export function FieldError({ children }: { children: ReactNode }) {
  return (
    <div className="ob-field-error" role="alert">
      {children}
    </div>
  );
}

export function FormField({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="ob-field">
      <Label htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </Label>
      {children(id)}
      {error ? <FieldError>{error}</FieldError> : hint ? <HelperText>{hint}</HelperText> : null}
    </div>
  );
}

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function Input({ className, invalid, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={['ob-input', className].filter(Boolean).join(' ')}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

/**
 * The one password field: an Input with an eye toggle that shows what is typed.
 * The toggle is a real button that is not a submit button, so Enter still
 * submits the form and Tab reaches it. `initiallyVisible` is for fields whose
 * value is meant to be read (an admin choosing someone's new password).
 */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
    invalid?: boolean;
    initiallyVisible?: boolean;
  }
>(function PasswordInput({ initiallyVisible = false, className, style, ...rest }, ref) {
  const [visible, setVisible] = useState(initiallyVisible);
  return (
    <span className="ob-password" style={style}>
      <Input
        ref={ref}
        className={['ob-password__input', className].filter(Boolean).join(' ')}
        type={visible ? 'text' : 'password'}
        {...rest}
      />
      <button
        type="button"
        className="ob-password__toggle"
        aria-label={visible ? t('password.hide') : t('password.show')}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
      >
        <Icon name={visible ? 'eye-off' : 'eye'} size={16} />
      </button>
    </span>
  );
});

export function NumberInput({
  className,
  invalid,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      type="text"
      inputMode="decimal"
      className={['ob-input', 'ob-numinput', className].filter(Boolean).join(' ')}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export function Textarea({
  className,
  invalid,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      className={['ob-textarea', className].filter(Boolean).join(' ')}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export function DateField({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input type="date" className={['ob-input', className].filter(Boolean).join(' ')} {...rest} />
  );
}

interface CheckRowProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  indeterminate?: boolean;
  name?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  indeterminate,
  name,
}: CheckRowProps) {
  return (
    <label className="ob-check-row" data-disabled={disabled || undefined}>
      <input
        type="checkbox"
        name={name}
        checked={checked}
        disabled={disabled}
        ref={(el) => {
          if (el) el.indeterminate = Boolean(indeterminate);
        }}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="ob-checkbox-box" aria-hidden="true">
        {checked && !indeterminate && (
          <svg
            width={10}
            height={10}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 8.5l3.2 3.2L13 4.5" />
          </svg>
        )}
        {indeterminate && (
          <span style={{ width: rem(8), height: 2, background: 'currentColor', borderRadius: 1 }} />
        )}
      </span>
      {label != null && <span>{label}</span>}
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled, name }: CheckRowProps) {
  return (
    <label className="ob-check-row" data-disabled={disabled || undefined}>
      <input
        type="checkbox"
        role="switch"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="ob-switch" aria-hidden="true" />
      {label != null && <span>{label}</span>}
    </label>
  );
}

/**
 * A native range input, styled.
 *
 * Native because a range is one of the few controls the platform gets exactly
 * right — keyboard, screen reader, touch and pointer all work with no code —
 * and the alternative is a dependency or a hand-rolled drag handler that has
 * to reimplement all four. The legacy stylesheet deliberately excludes
 * `[type='range']` from its input rule, so this is the only styling it gets.
 */
export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  label,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  /** Fires once when a drag or key press ends, with the final value. */
  onCommit?: (value: number) => void;
  label: string;
  disabled?: boolean;
}) {
  const commit = (event: { currentTarget: HTMLInputElement }) =>
    onCommit?.(Number(event.currentTarget.value));
  return (
    <input
      className="ob-slider"
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(Number(event.target.value))}
      onPointerUp={commit}
      onKeyUp={commit}
    />
  );
}
