/**
 * The order details bar of the new pending order: party, source, follow-up, owner, in one card.
 *
 * Presentational only. The screen passes the controls in (it owns the party search, the lists and
 * the Enter walk); this lays them out the way the design does and keeps both panels identical.
 */

import type { ReactNode } from 'react';

import './order.css';

export function OrderDetailsBar({
  hasOwner,
  children,
}: {
  /** False when the person cannot raise an order for somebody else: three columns, not four. */
  hasOwner: boolean;
  children: ReactNode;
}) {
  return (
    <section className="ob-order-details" data-owner={hasOwner ? 'true' : 'false'}>
      {children}
    </section>
  );
}

/** One labelled cell of the bar. `wide` lets the party take a row of its own when the bar wraps. */
export function OrderField({
  label,
  wide = false,
  children,
}: {
  label: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="ob-order-field" data-wide={wide ? 'true' : undefined}>
      <span className="ob-order-eyebrow">{label}</span>
      {children}
    </div>
  );
}

export interface QuickFollowUp {
  key: string;
  /** The short face: "+1 d". */
  label: string;
  /** The long name, for the tooltip and the screen reader: "Tomorrow". */
  title: string;
  active: boolean;
  onClick: () => void;
}

/** The date control and, beside it, the quick follow-up as one segmented radio group. */
export function FollowUpField({
  date,
  quick,
  groupLabel,
}: {
  /** The screen's own date control. */
  date: ReactNode;
  quick: QuickFollowUp[];
  groupLabel: string;
}) {
  return (
    <div className="ob-order-followup">
      {date}
      <div
        role="radiogroup"
        aria-label={groupLabel}
        className="ob-order-segmented"
        data-follow-up-chips
      >
        {quick.map((item) => (
          <button
            key={item.key}
            type="button"
            role="radio"
            aria-checked={item.active}
            title={item.title}
            aria-label={item.title}
            onClick={item.onClick}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
