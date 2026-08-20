/**
 * Labelled form control. Generates the id/htmlFor pairing so clicking a label
 * focuses its input and screen readers announce the two together — easy to get
 * wrong when writing labels by hand on every form.
 */

import { useId, type ReactNode } from 'react';

interface Props {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}

export function Field({ label, hint, children }: Props) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <div className="muted">{hint}</div>}
    </div>
  );
}

/** For read-only detail blocks, where there is no control to label. */
export function ReadOnlyField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
    </div>
  );
}
