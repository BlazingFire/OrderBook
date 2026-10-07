/**
 * One row of the Added products list: a head that opens and closes it, a slot for a tick box in
 * front, the actions beside it, and the detail under it.
 *
 * Presentational: the screen supplies the words and the handlers. `open` and `onToggle` are the
 * screen's (a row opens on a click and the open one is remembered by the screen).
 */

import type { ReactNode } from 'react';

import './order.css';

export function CartEntry({
  open,
  onToggle,
  leading,
  head,
  actions,
  facts,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  /** In front of the head, outside the toggle: opening a row must not tick it (a tick box). */
  leading?: ReactNode;
  /** The collapsed line: code, name, quantity. Inside the toggle button. */
  head: ReactNode;
  /** Edit and remove, at the right of the head or of the opened row. */
  actions?: ReactNode;
  /** The opened row's facts, one wrapping line. */
  facts?: ReactNode;
  /** Anything else under the head when open, such as a `CartLines` grid. */
  children?: ReactNode;
}) {
  return (
    <div className="ob-order-entry" data-open={open ? 'true' : undefined}>
      <div className="ob-order-entry__head">
        {leading}
        <button
          type="button"
          className="ob-order-entry__toggle"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span aria-hidden="true" style={{ flex: 'none', color: 'var(--fg-tertiary)' }}>
            {open ? '▾' : '▸'}
          </span>
          {head}
        </button>
      </div>
      {open && (
        <div className="ob-order-entry__body">
          {facts}
          {actions}
          {children}
        </div>
      )}
    </div>
  );
}

/** The grid of sub lines under a cart row: sub product, colour, packaging, grade, quantity. */
export function CartLines({ children }: { children: ReactNode }) {
  return <div className="ob-order-entry__lines">{children}</div>;
}
