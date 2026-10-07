/**
 * The download bar for an app update (1.4 R7a): how much has arrived, of how
 * much, at what speed, and how long is left. Shared by both panels' Updates
 * screens; the figures come from `UpdateProgressTracker` in `shared`.
 */

import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatEta, formatSpeed, IDLE_PROGRESS } from '@orderbook/shared';
import type { UpdateDownloadProgress } from '@orderbook/shared';

import { ProgressBar } from './TopProgress.js';
import { t } from './i18n.js';

export function UpdateProgress({ progress }: { progress: UpdateDownloadProgress }) {
  if (progress.phase === 'idle') return null;

  if (progress.phase === 'failed') {
    return (
      <p className="ob-small" role="alert" style={{ margin: 0, color: 'var(--state-conflict)' }}>
        {t('updates.progress.failed', { error: progress.error ?? '' })}
      </p>
    );
  }

  const title =
    progress.phase === 'verifying'
      ? t('updates.progress.verifying')
      : progress.phase === 'done'
        ? t('updates.progress.done', { version: progress.version ?? '' })
        : t('updates.progress.downloading', { version: progress.version ?? '' });

  // The Feedback artboard: what is happening on the left, the figures on the right, the
  // bar under them, green once the file is in.
  return (
    <ProgressBar
      value={progress.totalBytes > 0 ? progress.receivedBytes / progress.totalBytes : null}
      label={title}
      tone={progress.phase === 'done' ? 'ok' : 'default'}
      detail={
        progress.phase === 'downloading' ? (
          <span data-testid="update-progress-figures">
            {t('updates.progress.figures', {
              done: formatBytes(progress.receivedBytes),
              total: formatBytes(progress.totalBytes),
              speed: formatSpeed(progress.bytesPerSecond),
              eta: formatEta(progress.etaSeconds),
            })}
          </span>
        ) : (
          `${progress.percent.toFixed(1)} %`
        )
      }
    />
  );
}

/**
 * Poll a download's progress once a second while `active`, and once more when
 * it stops (so the last figure, and a failure, are shown). `load` may reject:
 * a missed poll keeps the last figure.
 */
export function useDownloadProgress(
  load: () => Promise<UpdateDownloadProgress>,
  active: boolean,
): UpdateDownloadProgress {
  const [progress, setProgress] = useState<UpdateDownloadProgress>(IDLE_PROGRESS);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let stopped = false;
    const tick = (): void => {
      loadRef.current().then(
        (next) => {
          if (!stopped) setProgress(next);
        },
        () => undefined,
      );
    };
    tick();
    if (!active) return () => void (stopped = true);
    const timer = setInterval(tick, 1_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active]);

  return progress;
}
