/**
 * One product on the Added products list: its code and name, the pieces across its lines, edit and
 * remove, and under it one line per sub product and colour.
 *
 * Presentational: the screen supplies the words and handlers. `open` / `onToggle` make the lines
 * collapsible (the head is a toggle button, like `CartEntry`); `leading` is a slot outside the toggle
 * for a tick box, so opening a group never ticks it.
 */

import type { ReactNode } from 'react';

import { ColourChip } from '../DataDisplay.js';
import { Icon } from '../icons.js';
import './order.css';

export function AddedGroup({
  open = true,
  onToggle,
  leading,
  code,
  name,
  pieces,
  pcsUnit,
  onEdit,
  onRemove,
  editLabel,
  removeLabel,
  children,
}: {
  /** Whether the lines show. A group without `onToggle` always shows them. */
  open?: boolean;
  onToggle?: () => void;
  leading?: ReactNode;
  code?: string | null;
  name: string;
  pieces: number;
  pcsUnit: string;
  onEdit: () => void;
  onRemove: () => void;
  /** The names for the two buttons ("Edit One piece toilet"). */
  editLabel: string;
  removeLabel: string;
  children: ReactNode;
}) {
  const head = (
    <>
      {code && <span className="ob-order-group__code">{code}</span>}
      <span className="ob-order-group__name">{name}</span>
      <span className="ob-order-group__pieces">
        {pieces.toLocaleString('en-IN')} <span className="ob-order-group__unit">{pcsUnit}</span>
      </span>
    </>
  );
  return (
    <div className="ob-order-group" data-open={open ? 'true' : undefined} data-added-group>
      <div className="ob-order-group__head">
        {leading}
        {onToggle ? (
          <button
            type="button"
            className="ob-order-group__toggle"
            aria-expanded={open}
            onClick={onToggle}
          >
            {head}
          </button>
        ) : (
          <div className="ob-order-group__toggle ob-order-group__toggle--plain">{head}</div>
        )}
        <button
          type="button"
          className="ob-order-group__act"
          title={editLabel}
          aria-label={editLabel}
          onClick={onEdit}
        >
          <Icon name="edit" size={14} />
        </button>
        <button
          type="button"
          className="ob-order-group__act ob-order-group__act--danger"
          title={removeLabel}
          aria-label={removeLabel}
          onClick={onRemove}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      {open && <div className="ob-order-group__lines">{children}</div>}
    </div>
  );
}

/** One line under a group: sub product, colour (dot and name), packaging, grade, quantity. */
export function AddedLine({
  sub,
  colour,
  colourHex,
  packaging,
  grade,
  qty,
}: {
  sub: ReactNode;
  /** Blank for a line with no colour of its own (shows a dash). */
  colour: string;
  colourHex?: string;
  packaging: string;
  grade: string;
  qty: number;
}) {
  return (
    <div className="ob-order-line" data-added-line>
      {/* Cut short in a narrow panel: the whole name in the tooltip. */}
      <span className="ob-order-line__sub" title={typeof sub === 'string' ? sub : undefined}>
        {sub}
      </span>
      <span className="ob-order-line__colour">
        {colour ? (
          <>
            <ColourChip name={colour} hex={colourHex} />
            <span>{colour}</span>
          </>
        ) : (
          '—'
        )}
      </span>
      <span>{packaging || '—'}</span>
      <span>{grade || '—'}</span>
      <span className="ob-order-line__qty">{qty.toLocaleString('en-IN')}</span>
    </div>
  );
}
