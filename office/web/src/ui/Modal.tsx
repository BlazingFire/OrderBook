/** Modal (§9 Structure, elevation 3) — centred, focus-trapped, Esc closes. */

import { useRef } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from './Button';
import { useOverlay } from './useOverlay';

export function Modal({
  open,
  onClose,
  title,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open, onClose, ref);

  if (!open) return null;
  return (
    <>
      <div className="ob-overlay" onClick={onClose} />
      <div className="ob-modal-wrap">
        <div className="ob-modal" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref} tabIndex={-1}>
          <div className="ob-modal-head">
            <h2 className="ob-title" style={{ margin: 0, flex: 1 }}>
              {title}
            </h2>
            <IconButton icon="close" label="Close" onClick={onClose} />
          </div>
          <div className="ob-modal-body">{children}</div>
          {footer && <div className="ob-modal-foot">{footer}</div>}
        </div>
      </div>
    </>
  );
}
