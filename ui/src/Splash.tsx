/**
 * Splash (§6): the cold-start screen — the mark, the wordmark, and a
 * determinate bar reporting the boot the app is actually doing underneath it.
 *
 *   0–280ms    lattice outline draws in (stroke-dashoffset on one path)
 *   280–700ms  squares ink in reading order, 42ms stagger — each cell eases
 *              from a half-step below its final seat, so the lattice settles
 *   700–980ms  wordmark rises in
 *   800ms      the bar and its caption ride in a beat behind the wordmark
 *
 * The bar is not decoration. `progress` and `label` come from the shell's real
 * startup sequence, so a Master whose database is unreachable now stalls
 * visibly on the step that hung instead of sitting on a "Starting…" line that
 * never changes. A step that fails replaces the bar with the reason and a
 * Retry — the exit that used to be missing from an unbreakable wait.
 *
 * Motion is handled entirely in CSS: `reset.css` collapses every animation and
 * transition to 1ms under `prefers-reduced-motion` or `data-motion="off"`, so
 * the choreography disappears while the mark, the bar and any error stay. The
 * one thing this component does check is `motionDisabled()`, to drop the
 * minimum hold — with animation off there is nothing left to hold *for*.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { CELLS } from './logoCells';
import { motionDisabled } from './theme';

/**
 * Long enough that the ink-in and the wordmark read as one move, not a blink —
 * and long enough to actually contain them.
 *
 * The last thing to arrive is the bar and its caption at 800ms over 280ms, so
 * the sequence is not finished until 1080ms. At 1020 the splash dismissed
 * itself 60ms into that entrance, which reads as a stutter rather than a
 * hand-off. The other two: the cells finish at 280 + 9 x 42 + 150 = 808ms, the
 * wordmark at 700 + 300 = 1000ms.
 */
const SPLASH_MS = 1100;

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
      {/* The whole mark eases in as one body, then rests at 0.98: the lattice
       * never quite touches its own edges, which reads as precision rather
       * than a crop. */}
      <svg
        width={104}
        height={104}
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="ob-splash-mark"
      >
        <rect
          x={0.5}
          y={3.5}
          width={23}
          height={17}
          rx={2.5}
          fill="none"
          stroke="var(--line-strong)"
          strokeWidth={0.5}
          strokeDasharray={80}
          style={{
            animation: `ob-outline-draw 280ms var(--e-standard) forwards, ob-outline-fade 220ms var(--e-exit) 760ms forwards`,
          }}
        />
        {CELLS.map(([x, y], i) => (
          <rect
            key={i}
            x={x}
            y={y}
            width={4}
            height={4}
            rx={0.75}
            fill="var(--accent)"
            style={{
              transformOrigin: `${x + 2}px ${y + 2}px`,
              animation: 'ob-ink 150ms var(--e-standard) both',
              animationDelay: `${280 + i * 42}ms`,
            }}
          />
        ))}
      </svg>
      <span className="ob-splash-word">{wordmark}</span>

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
