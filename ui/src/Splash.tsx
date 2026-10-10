/**
 * Splash (the 2026-10-08 Splash artboard): the cold-start screen of every
 * panel. Played once, at least 5 s, then it hands the screen to the app:
 *
 *   0–750 ms      the grid fades in, the twelve squares' outlines draw
 *   750–2050 ms   the ten squares drop in, one by one, with a squash
 *   1900–2300 ms  the two ghost squares fade in
 *   2100–2700 ms  a glint crosses the mark
 *   2350–3050 ms  the mark rises from the middle to its place
 *   2700–3800 ms  "Welcome to OrderBook", letter by letter; the program line
 *   3700–5100 ms  the bar runs to 90 % under three status lines
 *   ready         Ready, the bar fills, the mark breathes, the scene fades out
 *
 * If the boot is still running at 5.1 s, the bar waits at 90 % on the third
 * status line until it is done. A boot that fails replaces the bar with the
 * reason and a Retry.
 *
 * Motion is CSS (`mark.css`). With the motion switch off the hold is dropped —
 * with animation off there is nothing left to hold *for*.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { t } from './i18n.js';
import { CELLS, CELL_RADIUS, GHOST_CELLS } from './logoCells.js';
import { motionDisabled } from './theme';

/** When the third status line starts to leave, if the boot is done by then. */
export const SPLASH_MIN_MS = 5100;

/** From "ready" to handing over: Ready, the bar's last 10 %, the breath, the fade. */
export const SPLASH_FINISH_MS = 1250;

/** Delay between one square dropping in and the next. */
export const SPLASH_STAGGER_MS = 85;

/** The order the squares drop in: bottom row first, left to right, then upwards. */
const DROP_ORDER = [...CELLS.slice(6), ...CELLS.slice(2, 6), ...CELLS.slice(0, 2)];

/** All twelve squares, ghosts included, bottom row first, for the outline. */
const OUTLINE = [...CELLS.slice(6), ...CELLS.slice(2, 6), ...CELLS.slice(0, 2), ...GHOST_CELLS];

/** Each outline draws 50 ms after its left neighbour and its neighbour below. */
const outlineDelay = (x: number, y: number) => 50 * (1 + (x - 1) / 6 + (16 - y) / 6);

export function Splash({
  program,
  company,
  version,
  ready,
  error,
  retryLabel,
  onRetry,
  onDone,
}: {
  /** Which panel is starting: names the program line and the third status. */
  program: 'master' | 'office';
  company?: string | null;
  version: string;
  /** The boot is done; the splash may finish once its minimum hold is up. */
  ready: boolean;
  /** Why the boot stopped, if it did. Replaces the bar. */
  error?: string | null;
  retryLabel: string;
  onRetry: () => void;
  /** The splash has finished; the shell may take the screen back. */
  onDone: () => void;
}) {
  const animated = useRef(!motionDisabled());
  const [held, setHeld] = useState(!animated.current);
  const finishing = held && ready && !error;

  useEffect(() => {
    if (!animated.current) return;
    const timer = setTimeout(() => setHeld(true), SPLASH_MIN_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!animated.current) {
      onDone();
      return;
    }
    if (!finishing) return;
    const timer = setTimeout(onDone, SPLASH_FINISH_MS);
    return () => clearTimeout(timer);
  }, [finishing, onDone]);

  const wordmark = t('app.name');
  const programLine = [t(program === 'master' ? 'master.app.panel' : 'office.app.panel'), company]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={finishing ? 'ob-splash ob-splash--done' : 'ob-splash'} role="status" aria-live="polite">
      <div className="ob-splash-body">
        <section className="ob-splash-scene" aria-label={`${t('splash.welcome')} ${wordmark}`}>
          <div className="ob-splash-grid" aria-hidden="true" />

          <div className="ob-splash-column">
            <div className="ob-splash-move">
              <div className="ob-splash-breath">
                <svg width={120} height={120} viewBox="0 0 24 24" aria-hidden="true" className="ob-splash-mark">
                  <defs>
                    <clipPath id="ob-splash-clip">
                      {CELLS.map(([x, y]) => (
                        <rect key={`${x},${y}`} x={x} y={y} width={4} height={4} rx={CELL_RADIUS} />
                      ))}
                    </clipPath>
                    <linearGradient id="ob-splash-glint" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0" stopColor="#fff" stopOpacity="0" />
                      <stop offset="0.5" stopColor="#fff" style={{ stopOpacity: 'var(--splash-glint)' }} />
                      <stop offset="1" stopColor="#fff" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <g className="ob-splash-outline" fill="none" stroke="var(--accent)" strokeWidth={0.22}>
                    {OUTLINE.map(([x, y]) => (
                      <path
                        key={`${x},${y}`}
                        className="ob-splash-draw"
                        pathLength={1}
                        d={`M${x} ${y}h4v4h-4z`}
                        style={{ animationDelay: `${outlineDelay(x, y)}ms` }}
                      />
                    ))}
                  </g>
                  <g fill="var(--accent)">
                    {DROP_ORDER.map(([x, y], i) => (
                      <rect
                        key={`${x},${y}`}
                        className="ob-splash-cell"
                        x={x}
                        y={y}
                        width={4}
                        height={4}
                        rx={CELL_RADIUS}
                        style={{ animationDelay: `${750 + i * SPLASH_STAGGER_MS}ms` }}
                      />
                    ))}
                  </g>
                  <g className="ob-splash-ghosts" fill="var(--accent)">
                    {GHOST_CELLS.map(([x, y], i) => (
                      <rect
                        key={`${x},${y}`}
                        className="ob-splash-ghost"
                        x={x}
                        y={y}
                        width={4}
                        height={4}
                        rx={CELL_RADIUS}
                        style={{ animationDelay: `${1900 + i * 50}ms` }}
                      />
                    ))}
                  </g>
                  <g clipPath="url(#ob-splash-clip)">
                    <rect className="ob-splash-shine" x={0} y={-2} width={7} height={28} fill="url(#ob-splash-glint)" />
                  </g>
                </svg>
              </div>
            </div>

            <span className="ob-splash-welcome" aria-hidden="true">
              {t('splash.welcome')}
            </span>
            <h1 className="ob-splash-word" aria-label={wordmark}>
              {wordmark.split('').map((letter, i) => (
                <span key={i} className="ob-splash-letter-box" aria-hidden="true">
                  <span className="ob-splash-letter" style={{ animationDelay: `${2900 + i * 45}ms` }}>
                    {letter}
                  </span>
                </span>
              ))}
            </h1>
            <span className="ob-splash-program">{programLine}</span>
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
              <div className="ob-splash-lines">
                <span className="ob-splash-line ob-splash-line--1">{t('splash.status.data')}</span>
                <span className="ob-splash-line ob-splash-line--2">{t('splash.status.updates')}</span>
                <span className="ob-splash-line ob-splash-line--3">
                  {t(program === 'master' ? 'splash.status.master' : 'splash.status.office')}
                </span>
                {finishing && (
                  <span className="ob-splash-ready">
                    <svg
                      width={14}
                      height={14}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M5 12.5l4.5 4.5L19 7" />
                    </svg>
                    {t('splash.ready')}
                  </span>
                )}
              </div>
              <div className="ob-splash-track" aria-hidden="true">
                <div className="ob-splash-fill" />
              </div>
            </div>
          )}
        </section>

        <span className="ob-splash-maker">{t('splash.maker')}</span>
        <span className="ob-splash-version">v{version}</span>
      </div>
    </div>
  );
}
