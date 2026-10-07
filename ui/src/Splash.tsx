/**
 * Splash (the Motion artboard): the cold-start screen — the mark and the
 * wordmark side by side, and a determinate bar reporting the boot the app is
 * actually doing underneath it. Played once:
 *
 *   0–240 ms    the lattice outline draws (one path, `pathLength` 1)
 *   240–620 ms  the ten squares ink in reading order, 34 ms apart
 *   620–908 ms  the wordmark rises 4 px
 *   700 ms      the bar and its caption ride in a beat behind the wordmark
 *
 * The bar is not decoration. `progress` and `label` come from the shell's real
 * startup sequence, so a Master whose database is unreachable stalls visibly
 * on the step that hung instead of sitting on a "Starting…" line that never
 * changes. A step that fails replaces the bar with the reason and a Retry.
 *
 * Motion is CSS (`mark.css`): under `prefers-reduced-motion` or
 * `data-motion="off"` the splash shows its final frame at once. The one thing
 * this component checks is `motionDisabled()`, to drop the minimum hold — with
 * animation off there is nothing left to hold *for*.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { CELLS, CELL_RADIUS, GHOST_CELLS } from './logoCells.js';
import { motionDisabled } from './theme';

/**
 * Long enough to contain the whole entrance: the last arrival is the bar and
 * its caption, at 700 ms over 280 ms, so the sequence ends at 980 ms; the
 * wordmark ends at 908 and the last square at 240 + 9 × 34 + 144 = 690.
 */
export const SPLASH_MS = 1000;

/** Delay between one square inking and the next. */
export const SPLASH_STAGGER_MS = 34;

/** The outline of all twelve squares, ghosts included, as one path the draw-in traces. */
const OUTLINE = [...CELLS.slice(0, 2), ...GHOST_CELLS, ...CELLS.slice(2)]
  .map(([x, y]) => `M${x} ${y}h4v4h-4z`)
  .join(' ');

export function Splash({
  wordmark,
  progress,
  label,
  error,
  retryLabel,
  onRetry,
  onDone,
}: {
  wordmark: string;
  /** 0–1, from the shell's completed boot steps. */
  progress: number;
  /** What the shell is waiting on right now. */
  label: string;
  /** Why the boot stopped, if it did. Replaces the bar. */
  error?: string | null;
  retryLabel: string;
  onRetry: () => void;
  /** The minimum hold has elapsed; the shell may take the screen back. */
  onDone: () => void;
}) {
  const animated = useRef(!motionDisabled());
  const target = Math.round(Math.min(Math.max(progress, 0), 1) * 100);

  // What the bar is allowed to show. On a warm local server the whole boot is
  // over inside a frame, which would make the count read 0, then 100, and
  // nothing in between. So the figure eases towards the real one — and only
  // ever towards it: a step that hangs still parks the bar on that step's
  // ceiling, which is the whole point of showing a number at all.
  const [shown, setShown] = useState(0);
  const targetRef = useRef(target);
  targetRef.current = target;

  // An interval rather than requestAnimationFrame: rAF does not fire at all
  // while the window is not compositing, which would freeze the figure on 0%
  // for anyone who starts the panel and looks away. The splash lives about a
  // second, so a 16ms timer costs nothing.
  useEffect(() => {
    if (!animated.current) return;
    const tick = window.setInterval(() => {
      setShown((current) =>
        current >= targetRef.current
          ? current // Same value, so React skips the render; the timer idles.
          : Math.min(
              targetRef.current,
              current + Math.max(0.6, (targetRef.current - current) * 0.06),
            ),
      );
    }, 16);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!animated.current) {
      onDone();
      return;
    }
    const timer = setTimeout(onDone, SPLASH_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  const percent = animated.current ? Math.round(shown) : target;

  return (
    <div className="ob-splash" role="status" aria-live="polite">
      <div className="ob-splash-lockup">
        <svg width={56} height={56} viewBox="0 0 24 24" aria-hidden="true" className="ob-splash-mark">
          <path
            className="ob-splash-outline"
            pathLength={1}
            fill="none"
            stroke="var(--ob-mark-ink)"
            strokeOpacity={0.35}
            strokeWidth={0.35}
            d={OUTLINE}
          />
          <g fill="var(--ob-mark-ink)">
            {CELLS.map(([x, y], i) => (
              <rect
                key={i}
                className="ob-splash-cell"
                x={x}
                y={y}
                width={4}
                height={4}
                rx={CELL_RADIUS}
                style={{ animationDelay: `${240 + i * SPLASH_STAGGER_MS}ms` }}
              />
            ))}
          </g>
        </svg>
        <span className="ob-splash-word">{wordmark}</span>
      </div>

      {error ? (
        <div className="ob-splash-status ob-splash-status--error">
          <p className="ob-splash-error">{error}</p>
          <Button variant="secondary" size="sm" icon="sync" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : (
        <div className="ob-splash-status">
          <div
            className="ob-splash-track"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={label}
          >
            <div className="ob-splash-fill" style={{ width: `${percent}%` }} />
          </div>
          <p key={label} className="ob-splash-label">
            <span>{label}</span>
            <span className="ob-splash-percent">{percent}%</span>
          </p>
        </div>
      )}
    </div>
  );
}
