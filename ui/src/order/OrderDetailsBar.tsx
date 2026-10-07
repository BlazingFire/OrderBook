/**
 * The order details bar of the New Order screen: party, source, follow-up, owner, in one card.
 *
 * Presentational only. The screen passes the controls in (it owns the party search, the lists and
 * the Enter walk); this lays them out the way the design does and keeps both panels identical.
 */

import { useRef, type KeyboardEvent, type ReactNode } from 'react';

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

/**
 * The date control and, beside it, the quick follow-up as one segmented radio group.
 *
 * A real radiogroup: one tab stop (the checked choice, else the first), and the arrow keys move
 * to the next or previous choice and select it, wrapping at the ends.
 */
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
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const checked = quick.findIndex((item) => item.active);
  const tabStop = checked >= 0 ? checked : 0;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) return;
    const here = buttons.current.findIndex((button) => button === document.activeElement);
    const from = here >= 0 ? here : tabStop;
    const next = (from + (forward ? 1 : -1) + quick.length) % quick.length;
    event.preventDefault();
    buttons.current[next]?.focus();
    // Moving selects, but never clears: the choice already checked stays as it is.
    if (!quick[next]!.active) quick[next]!.onClick();
  }

  return (
    <div className="ob-order-followup">
      {date}
      <div
        role="radiogroup"
        aria-label={groupLabel}
        className="ob-order-segmented"
        data-follow-up-chips
        onKeyDown={onKeyDown}
      >
        {quick.map((item, index) => (
          <button
            key={item.key}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={item.active}
            tabIndex={index === tabStop ? 0 : -1}
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
