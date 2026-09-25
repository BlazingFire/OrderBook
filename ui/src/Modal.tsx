/**
 * Modal (§9 Structure, elevation 3) — centred, focus-trapped, Esc closes.
 *
 * For dialogs: a create/edit form, an import wizard, a confirmation — "a
 * distinct, narrowly scoped task without losing track of their previous
 * context" (HIG, Modality). Not for reading a record: an Open on a table row
 * shows the record on a screen of its own (`EditorScreen` + `useSubNav`), the
 * standing rule `master/tests/ui-conventions.test.ts` writes down.
 *
 * Two rules from that guidance shape the API:
 *
 *  - A dismiss control the reader can see. Esc and the scrim both close, but on
 *    desktop people look for a button, so the header always has one.
 *  - Never two at once. A dialog opened from inside another dialog buries the
 *    context the first one was holding, so a screen that needs a confirmation
 *    closes its dialog first rather than stacking on top of it.
 */

import { useRef } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from './Button';
import { t } from './i18n.js';
import { useOverlay } from './useOverlay';

/**
 * Confirmations stay narrow; a create/edit form wants room for two columns;
 * `lg` holds a table — a role's permissions, a stock ledger; `xl` is the
 * near-full-width editor, and the width `expanded` widens any size to.
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
   * than one that never expands.
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
                label={expanded ? t('modal.shrink') : t('modal.expand')}
                onClick={onToggleExpand}
              />
            )}
            <IconButton icon="close" label={t('modal.close')} onClick={onClose} />
          </div>
          <div className="ob-modal-body">{children}</div>
          {footer && <div className="ob-modal-foot">{footer}</div>}
        </div>
      </div>
    </>
  );
}
