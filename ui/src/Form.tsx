/**
 * Form foundation (§9): Input, NumberInput, Select, Textarea, DateField,
 * Checkbox, Radio, Switch, Label, HelperText, FieldError, and FormField — the
 * label/control/help/error composite every screen builds a field from.
 *
 * Numeric entry is right-aligned tabular figures with no steppers; the grid's
 * own ↑/↓ ± Shift handling lives in ColourQuantityGrid, not here (§9.2).
 */

import { forwardRef, useId } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

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

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={['ob-select', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </select>
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
          <span style={{ width: 8, height: 2, background: 'currentColor', borderRadius: 1 }} />
        )}
      </span>
      {label != null && <span>{label}</span>}
    </label>
  );
}

export function Radio({
  checked,
  onChange,
  label,
  disabled,
  name,
  value,
}: {
  checked: boolean;
  onChange: () => void;
  label?: ReactNode;
  disabled?: boolean;
  name: string;
  value: string;
}) {
  return (
    <label className="ob-check-row" data-disabled={disabled || undefined}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="ob-radio-box" aria-hidden="true" />
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
  label,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  label: string;
  disabled?: boolean;
}) {
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
    />
  );
}
