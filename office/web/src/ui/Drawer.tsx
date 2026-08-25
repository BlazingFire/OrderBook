/**
 * Drawer (§8, §9 Structure, elevation 3) — the detail-screen surface. Opens at
 * a fixed 520px on the right so the list behind it keeps its scroll position
 * and filters; only Lead and Order detail may expand to full screen via
 * `onExpand`.
 */

import { useRef } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from './Button';
import { useOverlay } from './useOverlay';

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  expanded,
  onToggleExpand,
  headerActions,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  expanded?: boolean;
  onToggleExpand?: () => void;
  headerActions?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open, onClose, ref);

  if (!open) return null;
  return (
    <>
      <div className="ob-overlay" onClick={onClose} />
      <div
        className="ob-drawer"
        style={expanded ? { width: '100%', maxWidth: '100%' } : undefined}
        role="dialog"
        aria-modal="true"
        ref={ref}
        tabIndex={-1}
      >
        <div className="ob-drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="ob-title" style={{ margin: 0 }}>
              {title}
            </h2>
            {subtitle && <div className="ob-small">{subtitle}</div>}
          </div>
          {headerActions}
          {onToggleExpand && (
            <IconButton
              icon={expanded ? 'collapse' : 'expand'}
              label={expanded ? 'Shrink' : 'Open full screen'}
              onClick={onToggleExpand}
            />
          )}
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>
        <div className="ob-drawer-body">{children}</div>
      </div>
    </>
  );
}
