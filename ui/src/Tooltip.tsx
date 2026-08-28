/**
 * Tooltip (§9 Structure) — 400ms hover delay, immediate on keyboard focus,
 * keyboard-reachable. Every icon-only control's aria-label matches this text.
 */

import { useRef, useState } from 'react';
import type { ReactElement } from 'react';

const HOVER_DELAY_MS = 400;

export function Tooltip({ text, children }: { text: string; children: ReactElement }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // Explicitly initialised: React 19's types dropped the zero-argument
  // `useRef` overload.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wrapRef = useRef<HTMLSpanElement>(null);

  function place() {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ top: rect.bottom + 6, left: rect.left });
  }

  function onEnter() {
    timer.current = setTimeout(place, HOVER_DELAY_MS);
  }
  function onLeave() {
    if (timer.current) clearTimeout(timer.current);
    setPos(null);
  }
  function onFocus() {
    place();
  }

  return (
    <span
      ref={wrapRef}
      style={{ display: 'inline-flex' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onFocus}
      onBlur={onLeave}
    >
      {children}
      {pos && (
        <span className="ob-tooltip" role="tooltip" style={{ top: pos.top, left: pos.left }}>
          {text}
        </span>
      )}
    </span>
  );
}
