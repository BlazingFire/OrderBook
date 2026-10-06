/**
 * Popover (§9 Structure, elevation 2) — a positioned surface anchored to a
 * trigger, closed by an outside click or Esc (innermost first, §10).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  const [placed, setPlaced] = useState<CSSProperties | null>(null);

  // Without an `anchorStyle` the surface had no offsets at all, so it opened on
  // top of its trigger and could run off the right or bottom edge. The default:
  // under the trigger (the element just before it), above when there is no room
  // below, and pulled in from the right edge.
  useLayoutEffect(() => {
    if (!open || anchorStyle) return;
    setPlaced(placeBeside(ref.current));
  }, [open, anchorStyle]);

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
    <div ref={ref} className="ob-popover" style={anchorStyle ?? placed ?? { visibility: 'hidden' }}>
      {children}
    </div>
  );
}

const EDGE = 8;
const GAP = 4;

/** Where an unanchored popover goes, in viewport pixels; `{}` when it has no trigger. */
export function placeBeside(surface: HTMLElement | null): CSSProperties {
  const trigger = surface?.previousElementSibling;
  if (!surface || !trigger) return {};
  const t = trigger.getBoundingClientRect();
  const p = surface.getBoundingClientRect();
  const below = t.bottom + GAP;
  const above = t.top - GAP - p.height;
  const top = below + p.height > window.innerHeight - EDGE && above >= EDGE ? above : below;
  const left = Math.max(EDGE, Math.min(t.left, window.innerWidth - EDGE - p.width));
  return { position: 'fixed', top, left };
}
