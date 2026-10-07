/**
 * Loading feedback: the thin strip along the top of the working area, and the
 * one determinate bar the product has.
 *
 * The owner asked for loading bars (2026-10-01), which overrides the older
 * rule that the busy mark is the only thing that moves. Both still stop when
 * motion is off or the window is in the background (`base.css`).
 *
 * One module-level counter, fed by both panels' `request()` through
 * `trackLoad` and by every lazy screen's Suspense fallback through
 * `LoadingMark`. The strip shows only after 300 ms of continuous work, so a
 * quick read never flickers it. The SSE stream and the socket are not counted:
 * they are always open and would keep it showing for ever.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { t } from './i18n.js';

let pending = 0;
const listeners = new Set<() => void>();

function change(delta: number): void {
  const before = pending > 0;
  pending = Math.max(0, pending + delta);
  if (before !== pending > 0) for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const busy = (): boolean => pending > 0;

/** Counts `work` as in flight until it settles, and hands it back unchanged. */
export function trackLoad<T>(work: Promise<T>): Promise<T> {
  change(1);
  // `finally` on the returned chain, so a rejection still reaches the caller
  // and the count still drops.
  return work.finally(() => change(-1));
}

/** The strip. AppShell renders it as the first child of `.ob-main`. */
export function TopProgress() {
  const active = useSyncExternalStore(subscribe, busy, busy);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!active) {
      setShown(false);
      return undefined;
    }
    const timer = setTimeout(() => setShown(true), 300);
    return () => clearTimeout(timer);
  }, [active]);

  if (!active || !shown) return null;
  return (
    <div className="ob-topprogress" role="progressbar" aria-label={t('common.loading')}>
      <div className="ob-topprogress-bar" />
    </div>
  );
}

/**
 * Counts as loading for as long as it is mounted. The Suspense fallback for a
 * lazy screen, so its first load drives the same strip as a request.
 */
export function LoadingMark() {
  useEffect(() => {
    change(1);
    return () => change(-1);
  }, []);
  return <span className="sr-only">{t('common.loading')}</span>;
}

/** What a bar says by its colour: working, held up while offline, failed, or finished. */
export type ProgressTone = 'default' | 'offline' | 'conflict' | 'ok';

/**
 * The determinate bar, for imports, exports, backups and updates: `value` from 0 to 1, or
 * `null` while the size of the job is not known yet (then the indeterminate sweep). The
 * Feedback artboard: what is happening on the left, the figure on the right, a 6 px track
 * under them, and a fill that moves by `scaleX` only, so a moving bar never re-lays out the
 * row. There is no other ProgressBar; reuse this one.
 */
export function ProgressBar({
  value,
  label,
  detail,
  tone = 'default',
}: {
  value: number | null;
  /** What is happening; also the bar's accessible name. */
  label?: string;
  /** The figure on the right: "41.2 of 64.0 MB", "152 of 400 products", a place. */
  detail?: ReactNode;
  tone?: ProgressTone;
}) {
  const fraction = value === null ? null : Math.min(1, Math.max(0, value));
  const percent = fraction === null ? null : Math.round(fraction * 100);
  return (
    <div className={`ob-progress-wrap ob-progress--${tone}`}>
      {(label || detail) && (
        <div className="ob-progress-head">
          {label && <span className="ob-progress-label">{label}</span>}
          {detail && <span className="ob-progress-detail">{detail}</span>}
        </div>
      )}
      <div
        className="ob-progress"
        role="progressbar"
        aria-label={label ?? t('common.loading')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        {fraction === null ? (
          <div className="ob-progress-fill--indeterminate" />
        ) : (
          <div className="ob-progress-fill" style={{ transform: `scaleX(${fraction})` }} />
        )}
      </div>
    </div>
  );
}
