/**
 * The Updating screen and the "Update finished" card (1.5), shared by both
 * panels.
 *
 * From the moment Install now is pressed the panel covers itself with one
 * screen that says which step it is on (of how many), the bar for the whole
 * update, how long it has been going and roughly how long is left. The
 * download step carries the real bytes, speed and time left from
 * `UpdateProgress`; a step with nothing to measure says so rather than
 * inventing a percentage. The install itself runs after this window has
 * closed, where no page can watch it, so its time is the one this PC took last
 * time (the shell measures it) or a stated default.
 *
 * After the restart the card is the proof: from which version to which, when
 * it started, when it was ready and how long that took — or, if the PC came
 * back on the old version, that the update did not install.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  finishedUpdateNotice,
  formatClock,
  formatEta,
  updateRunFraction,
  updateSecondsLeft,
  updateStepStates,
  type DesktopBridge,
  type FinishedUpdateNotice,
  type MessageKey,
  type UpdateDownloadProgress,
  type UpdateStepId,
  type UpdateStepState,
} from '@orderbook/shared';

import { BusyMark } from './BusyMark.js';
import { Button } from './Button.js';
import { formatDateTime } from './format.js';
import { t } from './i18n.js';
import { Icon } from './icons.js';
import { ProgressBar } from './TopProgress.js';
import { UpdateProgress } from './UpdateProgress.js';

const bridge = (): Partial<DesktopBridge> | undefined =>
  (window as unknown as { orderbook?: Partial<DesktopBridge> }).orderbook;

const STEP_LABEL: Record<UpdateStepId, MessageKey> = {
  download: 'updates.run.step.download',
  verify: 'updates.run.step.verify',
  save: 'updates.run.step.save',
  close: 'updates.run.step.close',
  install: 'updates.run.step.install',
  restart: 'updates.run.step.restart',
};

const STATE_LABEL: Record<UpdateStepState, MessageKey> = {
  done: 'updates.run.state.done',
  active: 'updates.run.state.active',
  pending: 'updates.run.state.pending',
  failed: 'updates.run.state.failed',
};

/** A clock that ticks once a second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/**
 * How long the install took on this PC last time, from the shell's record, or
 * `null` (never timed, a browser tab, or a shell older than 1.5).
 */
export function useInstallSeconds(): number | null {
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    bridge()
      ?.getUpdateRun?.()
      .then((run) => {
        if (live) setSeconds(run?.installSeconds ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return seconds;
}

export interface UpdateRun {
  version: string;
  steps: readonly UpdateStepId[];
  current: UpdateStepId;
  /** `Date.now()` when Install now was pressed. */
  startedAt: number;
  /** When the shell accepted the hand-over: the window is about to close. */
  handedOverAt: number | null;
  /** Why it stopped, if it did. Nothing was changed by then. */
  failure: string | null;
}

/** What a screen keeps while an update runs, and the moves it makes. */
export function useUpdateRun(steps: readonly UpdateStepId[]) {
  const [run, setRun] = useState<UpdateRun | null>(null);
  return {
    run,
    start: (version: string) =>
      setRun({
        version,
        steps,
        current: steps[0] ?? 'install',
        startedAt: Date.now(),
        handedOverAt: null,
        failure: null,
      }),
    step: (current: UpdateStepId) => setRun((now) => (now ? { ...now, current } : now)),
    handedOver: () =>
      setRun((now) => (now ? { ...now, current: 'install', handedOverAt: Date.now() } : now)),
    fail: (failure: string) => setRun((now) => (now ? { ...now, failure } : now)),
    clear: () => setRun(null),
  };
}

export function UpdateRunScreen({
  run,
  download,
  installSeconds,
  onClose,
}: {
  run: UpdateRun;
  /** The download's figures, for the panel whose first step is the download. */
  download?: UpdateDownloadProgress | null;
  installSeconds: number | null;
  /** Shown once it has stopped: back to the Updates screen. */
  onClose: () => void;
}) {
  const failed = run.failure !== null;
  const now = useNow(!failed);
  const states = updateStepStates(run.steps, run.current, failed);
  const at = run.steps.indexOf(run.current);
  const fraction = updateRunFraction(run.steps, run.current, download);

  let left = updateSecondsLeft({ current: run.current, download, installSeconds });
  if (left !== null && run.handedOverAt !== null) {
    left = Math.max(0, left - Math.floor((now - run.handedOverAt) / 1000));
  }
  const installTime = formatEta(
    installSeconds ?? updateSecondsLeft({ current: 'install', installSeconds: null }),
  );

  // Focus moves to Close when it stops, so Enter takes the person back.
  const failureRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failed) failureRef.current?.querySelector('button')?.focus();
  }, [failed]);

  const hint = (id: UpdateStepId): ReactNode => {
    switch (id) {
      case 'download':
        return download && download.phase !== 'idle' ? (
          <UpdateProgress progress={download} />
        ) : null;
      case 'verify':
        return t('updates.run.step.verifyHint');
      case 'save':
        return t('updates.run.step.saveHint');
      case 'close':
        return t('updates.run.step.closeHint');
      case 'install':
        return installSeconds !== null
          ? t('updates.run.step.installMeasured', { time: installTime })
          : t('updates.run.step.installHint', { time: installTime });
      case 'restart':
        return t('updates.run.step.restartHint');
    }
  };

  // On the body, so no screen's own layout can clip or shift it.
  return createPortal(
    <div
      className="ob-updaterun"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ob-updaterun-title"
    >
      <div className="ob-updaterun-panel">
        <div className="ob-updaterun-head">
          <span className="ob-updaterun-mark" aria-hidden="true">
            <Icon name="update" size={22} />
          </span>
          <div>
            <h1 id="ob-updaterun-title" className="ob-title" style={{ margin: 0 }}>
              {t('updates.run.title', { version: run.version })}
            </h1>
            <p
              className="ob-small"
              style={{ margin: 0, color: 'var(--fg-secondary)' }}
              aria-live="polite"
            >
              {t('updates.run.stepOf', { step: at + 1, total: run.steps.length })} ·{' '}
              {t(STEP_LABEL[run.current], { version: run.version })}
            </p>
          </div>
        </div>

        <ProgressBar
          value={fraction}
          label={t('updates.run.title', { version: run.version })}
          tone={failed ? 'conflict' : 'default'}
          detail={`${Math.round(fraction * 100)} %`}
        />

        <div className="ob-updaterun-clock ob-small" data-testid="update-run-clock">
          <span>{t('updates.run.elapsed', { time: formatClock(now - run.startedAt) })}</span>
          {failed ? null : (
            <span>
              {left === null
                ? t('updates.run.leftUnknown')
                : t('updates.run.left', { time: formatEta(left) })}
            </span>
          )}
        </div>

        <ol className="ob-updaterun-steps">
          {run.steps.map((id, index) => {
            const state = states[index] ?? 'pending';
            return (
              <li
                key={id}
                className={`ob-updaterun-step ob-updaterun-step--${state}`}
                data-state={state}
              >
                <span className="ob-updaterun-dot" aria-hidden="true">
                  {state === 'done' ? (
                    <Icon name="check" size={14} />
                  ) : state === 'active' ? (
                    <BusyMark size={14} label="" />
                  ) : state === 'failed' ? (
                    <Icon name="close" size={14} />
                  ) : (
                    index + 1
                  )}
                </span>
                <div className="ob-updaterun-text">
                  <span className="ob-body-strong">
                    {t(STEP_LABEL[id], { version: run.version })}
                    <span className="sr-only"> — {t(STATE_LABEL[state])}</span>
                  </span>
                  {state === 'active' || (state === 'pending' && id === 'install') ? (
                    <div className="ob-small ob-updaterun-hint">{hint(id)}</div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>

        {run.handedOverAt !== null ? (
          <p className="ob-body ob-updaterun-note" role="status">
            {t('updates.run.handedOver', { version: run.version, time: installTime })}
          </p>
        ) : null}

        {failed ? (
          <div className="ob-updaterun-failure" role="alert" ref={failureRef}>
            <p className="ob-body-strong" style={{ margin: 0 }}>
              {t('updates.run.failedTitle')}
            </p>
            <p className="ob-small" style={{ margin: 0 }}>
              {run.failure}
            </p>
            <div>
              <Button variant="secondary" onClick={onClose}>
                {t('updates.run.close')}
              </Button>
            </div>
          </div>
        ) : (
          <p className="ob-small" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
            {t('updates.run.keepOn')}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

const LAST_VERSION_KEY = 'ob.updates.lastVersion';
const SEEN_KEY = 'ob.updates.finishedSeen';

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked storage: the card may show once more. Never worth an error.
  }
}

function readSeen(): string[] {
  try {
    const parsed: unknown = JSON.parse(readStorage(SEEN_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * The card after an update (1.5): mounted once per window beside the app, it
 * shows the shell's record of the last update the first time this version
 * starts, and stays until OK. Not a dialog, so it never stacks on the sign-in
 * notices; it sits under the splash until the splash has gone.
 */
export function UpdateFinishedCard({ running }: { running: string }) {
  // Read before this mount writes the new version, once (StrictMode runs effects twice).
  const [lastSeenVersion] = useState(() => readStorage(LAST_VERSION_KEY));
  const [notice, setNotice] = useState<FinishedUpdateNotice | null>(null);

  useEffect(() => {
    let live = true;
    writeStorage(LAST_VERSION_KEY, running);
    const decide = (
      shell: Awaited<ReturnType<NonNullable<DesktopBridge['getUpdateRun']>>> | null,
    ) => {
      if (!live) return;
      setNotice(
        finishedUpdateNotice({
          running,
          shell: shell?.last ?? null,
          lastSeenVersion,
          seen: readSeen(),
        }),
      );
    };
    const ask = bridge()?.getUpdateRun;
    if (!ask) decide(null);
    else ask().then(decide, () => decide(null));
    return () => {
      live = false;
    };
  }, [running, lastSeenVersion]);

  if (!notice) return null;

  const dismiss = (): void => {
    writeStorage(SEEN_KEY, JSON.stringify([...readSeen(), notice.key].slice(-10)));
    setNotice(null);
  };

  const ok = notice.outcome === 'updated';
  return (
    <section
      className={`ob-updatedone ${ok ? 'ob-updatedone--ok' : 'ob-updatedone--failed'}`}
      role="status"
      aria-labelledby="ob-updatedone-title"
    >
      <div className="ob-updatedone-head">
        <span className="ob-updatedone-mark" aria-hidden="true">
          <Icon name={ok ? 'check' : 'warning'} size={16} />
        </span>
        <h2 id="ob-updatedone-title" className="ob-body-strong" style={{ margin: 0 }}>
          {ok ? t('updates.finished.title') : t('updates.finished.notInstalledTitle')}
        </h2>
      </div>
      <p className="ob-small" style={{ margin: 0 }}>
        {ok
          ? notice.from
            ? t('updates.finished.body', { from: notice.from, to: notice.to })
            : t('updates.finished.bodyNoFrom', { to: notice.to })
          : t('updates.finished.notInstalledBody', { to: notice.to, running })}
      </p>
      {ok && notice.startedAt && notice.finishedAt ? (
        <dl className="ob-updatedone-times ob-small" data-testid="update-finished-times">
          <dt>{t('updates.finished.started')}</dt>
          <dd>{formatDateTime(notice.startedAt)}</dd>
          <dt>{t('updates.finished.ready')}</dt>
          <dd>{formatDateTime(notice.finishedAt)}</dd>
          {notice.seconds !== null ? (
            <>
              <dt>{t('updates.finished.took')}</dt>
              <dd>{formatEta(notice.seconds)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {ok ? (
        <p className="ob-small" style={{ margin: 0, color: 'var(--fg-secondary)' }}>
          {t('updates.finished.dataKept')}
        </p>
      ) : null}
      <div>
        <Button variant="primary" size="sm" onClick={dismiss}>
          {t('updates.finished.ok')}
        </Button>
      </div>
    </section>
  );
}
