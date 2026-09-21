/**
 * A dense form: many short fields laid out in columns, grouped by heading.
 *
 * The shape a product record actually is. Twenty-two fields stacked one per row
 * is a form somebody scrolls through twice to check they filled it in; the same
 * twenty-two in labelled groups of four across is one they read.
 *
 * `repeat(auto-fill, minmax(13rem, 1fr))` and **no media query**, deliberately.
 * The track floor is in rem, so it grows with the UI scale — which means the
 * column *count* falls as somebody turns the scale up, and rises again on a
 * wider window, without any breakpoint knowing either number. A media query
 * here would have to be maintained against every scale step.
 *
 * `Field` renders its own `<div data-span>` **around** `FormField` rather than
 * adding an attribute to it. `FormField` owns the `.ob-field` div, and a
 * wrapper cannot reach inside a component to put an attribute on an element it
 * did not render.
 */

import type { ReactNode } from 'react';

import { FormField } from './Form';

export function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="ob-fieldgrid">{children}</div>;
}

/**
 * One labelled group of fields.
 *
 * The heading is what makes a dense form readable rather than merely small:
 * "Codes & weight" over the variant rows tells somebody what the block is for
 * before they read a single field.
 */
export function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ob-fieldgroup">
      <h3 className="ob-eyebrow">{title}</h3>
      <div className="ob-fieldgrid">{children}</div>
    </section>
  );
}

/**
 * One field in the grid, optionally spanning more than one column.
 *
 * `span` is for the fields that are genuinely wider than a name — an address
 * line, a note. Everything else stays one column, because a form where each
 * field claims what it needs is a form that reflows correctly at every width.
 */
export function Field({
  label,
  hint,
  error,
  required,
  span = 1,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  span?: 1 | 2 | 3;
  children: (id: string) => ReactNode;
}) {
  return (
    <div data-span={span > 1 ? span : undefined}>
      <FormField label={label} hint={hint} error={error} required={required}>
        {children}
      </FormField>
    </div>
  );
}
