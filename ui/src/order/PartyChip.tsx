/**
 * The chosen party on the new pending order: a chip with the initials badge, the NAME, the CODE
 * and the CITY (owner's rule, 2026-10-07: all three, replacing both the old name-only rule and
 * the artboard's code + city), an optional extra (a pill) and a 24 px close button that gives the
 * party back to the search box.
 *
 * Presentational. The close button carries `data-field`, which keeps it a step of the screen's
 * Enter/Escape walk: choosing a party replaces the search box with this chip, so without it Escape
 * from the source select would find no party field to go back to.
 */

import type { ReactNode } from 'react';

import { Icon } from '../icons.js';
import './order.css';

/** "Shree Ceramics" becomes "SC": the first letters of the first two words. */
export function partyInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

export function PartyChip({
  name,
  code,
  city,
  extra,
  changeLabel,
  onChange,
}: {
  name: string;
  code?: string | null;
  city?: string | null;
  /** After the city, before the close button: the "own product names" pill. */
  extra?: ReactNode;
  /** The close button's name and tooltip ("Change party"). */
  changeLabel: string;
  onChange: () => void;
}) {
  return (
    <div className="ob-order-party" data-party-chip>
      <span className="ob-order-party__badge" aria-hidden="true">
        {partyInitials(name)}
      </span>
      <span className="ob-order-party__name">{name}</span>
      {code && <span className="ob-order-party__code">{code}</span>}
      {city && <span className="ob-order-party__meta">· {city}</span>}
      {extra}
      <span className="ob-order-party__gap" />
      <button
        type="button"
        className="ob-order-party__close"
        data-field
        aria-label={changeLabel}
        title={changeLabel}
        onClick={onChange}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
