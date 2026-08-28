/**
 * Popover (§9 Structure, elevation 2) — a positioned surface anchored to a
 * trigger, closed by an outside click or Esc (innermost first, §10).
 */

import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export function Popover({
  open,
  onClose,
  anchorStyle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorStyle?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div ref={ref} className="ob-popover" style={anchorStyle}>
      {children}
    </div>
  );
}
