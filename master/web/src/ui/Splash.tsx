/**
 * Splash (§6): 900ms, cold start only, never on navigation.
 *
 *   0–240ms    lattice outline draws in (stroke-dashoffset on one path)
 *   240–620ms  squares ink in reading order, 34ms stagger
 *   620–900ms  wordmark rises in
 *
 * With reduced motion or `data-motion="off"` there is no splash delay at all:
 * nothing renders and startup continues immediately.
 */

import { useEffect, useRef } from 'react';
import { CELLS } from './logoCells';
import { motionDisabled } from './theme';
const SPLASH_MS = 950;

export function Splash({ wordmark, onDone }: { wordmark: string; onDone: () => void }) {
  const skipped = useRef(motionDisabled());

  useEffect(() => {
    if (skipped.current) {
      onDone();
      return;
    }
    const timer = setTimeout(onDone, SPLASH_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  if (skipped.current) return null;

  return (
    <div className="ob-splash" aria-hidden="true">
      <svg width={96} height={96} viewBox="0 0 24 24">
        <rect
          x={0.5}
          y={3.5}
          width={23}
          height={17}
          rx={1}
          fill="none"
          stroke="var(--line-strong)"
          strokeWidth={0.5}
          strokeDasharray={80}
          style={{
            animation: `ob-outline-draw 240ms linear forwards, ob-outline-fade 200ms linear 640ms forwards`,
          }}
        />
        {CELLS.map(([x, y], i) => (
          <rect
            key={i}
            x={x}
            y={y}
            width={4}
            height={4}
            fill="var(--accent)"
            style={{
              transformOrigin: `${x + 2}px ${y + 2}px`,
              animation: 'ob-ink 90ms var(--e-standard) both',
              animationDelay: `${240 + i * 34}ms`,
            }}
          />
        ))}
      </svg>
      <span className="ob-splash-word">{wordmark}</span>
    </div>
  );
}
