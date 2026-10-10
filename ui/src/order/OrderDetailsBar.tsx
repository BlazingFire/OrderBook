/**
 * The order details bar of the New Order screen: party, source, follow-up, owner, in one card.
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

/** The follow-up date control, held at the design's width. */
export function FollowUpField({ date }: { date: ReactNode }) {
  return <div className="ob-order-followup">{date}</div>;
}
