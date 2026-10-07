/**
 * The Added products aside of the new pending order: a header with the count, a search, the rows,
 * and a footer with the checks, the total and Cancel / Save.
 *
 * The rows are the screen's own (`children`): each panel keeps its row behaviour, selection and
 * modify/remove; this is the frame they sit in, so the two panels cannot drift apart.
 */

import type { ReactNode } from 'react';

import { Button } from '../Button.js';
import { OrderChecks, type OrderCheck } from './OrderChecks.js';
import './order.css';

export function AddedProductsPanel({
  ariaLabel,
  title,
  count,
  headExtra,
  search,
  toolbar,
  empty,
  children,
  footerNote,
  checks,
  totalLabel,
  totalPcs,
  pcsUnit,
  cancelLabel,
  onCancel,
  saveLabel,
  saveKbd,
  saveTitle,
  saveDisabled,
  saving = false,
  onSave,
}: {
  ariaLabel: string;
  title: string;
  /** The badge: a number, or a "3 of 12" while a search narrows the rows; empty hides it. */
  count: string;
  /** Right of the badge in the header (the screens' short summary). */
  headExtra?: ReactNode;
  /** The search box, above the rows. */
  search?: ReactNode;
  /** Between the search and the rows: the selection bar and Select all. */
  toolbar?: ReactNode;
  /** Shown instead of the rows when there are none. */
  empty?: ReactNode;
  children?: ReactNode;
  /** Above the checks: a save hint or a status line ("queued, will send when online"). */
  footerNote?: ReactNode;
  checks: OrderCheck[];
  /** "3 products · 5 lines". */
  totalLabel: string;
  totalPcs: string;
  pcsUnit: string;
  cancelLabel: string;
  onCancel: () => void;
  saveLabel: string;
  /** The chord shown on the Save button, e.g. "Ctrl S". */
  saveKbd: string;
  saveTitle?: string;
  saveDisabled: boolean;
  saving?: boolean;
  onSave: () => void;
}) {
  return (
    <aside className="ob-order-aside" aria-label={ariaLabel}>
      <div className="ob-order-aside__head">
        <h2 className="ob-order-eyebrow">{title}</h2>
        {count !== '' && <span className="ob-order-count">{count}</span>}
        <span style={{ flex: 1, minWidth: 0 }} />
        {headExtra}
      </div>

      {(search || toolbar) && (
        <div className="ob-order-aside__tools">
          {search}
          {toolbar}
        </div>
      )}

      {empty ? (
        <div className="ob-order-aside__empty">{empty}</div>
      ) : (
        <div className="ob-order-aside__rows">{children}</div>
      )}

      <div className="ob-order-aside__foot">
        {footerNote}
        <OrderChecks items={checks} />
        <div className="ob-order-total">
          <span className="ob-order-total__label">{totalLabel}</span>
          <span className="ob-order-total__figure">
            {totalPcs} <span className="ob-order-total__unit">{pcsUnit}</span>
          </span>
        </div>
        <div className="ob-order-actions">
          <Button variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant="primary"
            className="ob-order-save"
            busy={saving}
            disabled={saveDisabled}
            title={saveTitle}
            aria-label={saveLabel}
            onClick={onSave}
          >
            {saveLabel}
            <span className="ob-order-kbd" aria-hidden="true">
              {saveKbd}
            </span>
          </Button>
        </div>
      </div>
    </aside>
  );
}
