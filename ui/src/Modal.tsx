/**
 * Modal (§9 Structure, elevation 3) — centred, focus-trapped, Esc closes.
 *
 * This is where a record's detail opens: centred over the list it came from,
 * which is what modality is for — "a distinct, narrowly scoped task without
 * losing track of their previous context" (HIG, Modality). Two earlier answers
 * were tried and rejected: a right-hand drawer, and a row that expanded inline.
 *
 * Two rules from that guidance shape the API:
 *
 *  - A dismiss control the reader can see. Esc and the scrim both close, but on
 *    desktop people look for a button, so the header always has one and a
 *    detail dialog also closes from its footer.
 *  - Never two at once. A dialog opened from inside another dialog buries the
 *    context the first one was holding, so a screen that needs a confirmation
 *    closes the detail first rather than stacking on top of it.
 */

import { useRef } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from './Button';
import { useOverlay } from './useOverlay';

/**
 * Confirmations stay narrow; a record's detail needs room for two columns; `xl`
 * is the near-full-width state a lead or an order can be expanded into, which
 * is the one thing the retired right-hand drawer could do that a modal could
 * not.
 */
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export function Modal({
  open,
  onClose,
  title,
  label,
  subtitle,
  size = 'sm',
  expanded,
  onToggleExpand,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** The dialog's accessible name, for when `title` is markup rather than a
   *  string — a colour swatch beside a product name, say. Without it such a
   *  dialog reaches a screen reader unnamed. */
  label?: string;
  /** What the record is, under its name — the line that keeps a reader placed. */
  subtitle?: ReactNode;
  size?: ModalSize;
  /**
   * Widen this dialog to `xl`, and show the toggle that does it.
   *
   * Only meaningful together with `onToggleExpand` — the button is what makes
   * the state reachable, and a dialog stuck expanded with no way back is worse
   * than one that never expands. Lead and Order detail are the two records big
   * enough to want it.
   */
  expanded?: boolean;
  onToggleExpand?: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open, onClose, ref);

  if (!open) return null;

  const width = expanded ? 'xl' : size;

  return (
    <>
      <div className="ob-overlay" onClick={onClose} />
      <div className="ob-modal-wrap">
        <div
          className={width === 'sm' ? 'ob-modal' : `ob-modal ob-modal--${width}`}
          role="dialog"
          aria-modal="true"
          aria-label={label ?? (typeof title === 'string' ? title : undefined)}
          ref={ref}
          tabIndex={-1}
        >
          <div className="ob-modal-head">
            <div className="ob-modal-heading">
              <h2 className="ob-modal-title">{title}</h2>
              {subtitle && <div className="ob-modal-sub">{subtitle}</div>}
            </div>
            {onToggleExpand && (
              <IconButton
                icon={expanded ? 'collapse' : 'expand'}
                label={expanded ? 'Shrink' : 'Open full width'}
                onClick={onToggleExpand}
              />
            )}
            <IconButton icon="close" label="Close" onClick={onClose} />
          </div>
          <div className="ob-modal-body">{children}</div>
          {footer && <div className="ob-modal-foot">{footer}</div>}
        </div>
      </div>
    </>
  );
}
