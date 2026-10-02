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

/**
 * The determinate bar, for imports, exports and backups: `value` from 0 to 1,
 * or `null` while the size of the job is not known yet. Built on the splash
 * bar's track and fill. There is no other ProgressBar; reuse this one.
 */
export function ProgressBar({ value, label }: { value: number | null; label?: string }) {
  const percent = value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="ob-progress-wrap">
      <div
        className="ob-progress"
        role="progressbar"
        aria-label={label ?? t('common.loading')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        {percent === null ? (
          <div className="ob-progress-fill--indeterminate" />
        ) : (
          <div className="ob-progress-fill" style={{ width: `${percent}%` }} />
        )}
      </div>
      {label && <span className="ob-small">{label}</span>}
    </div>
  );
}
