/**
 * What happens between "paired" and the sign-in screen: this PC gets the company's
 * data from the Master for the first time.
 *
 * Until now the screen after a pairing was the sign-in form, with the first sync
 * going on invisibly behind it and a stale "Master not reachable" line on top. This
 * shows the three steps (paired, connected, data received) as they happen, says what
 * is wrong when the Master cannot be reached, warns when its version differs from
 * this PC's, and says plainly when a different Master than before was joined.
 *
 * It never blocks: "Continue" is available as soon as there is something to continue
 * to, because the sign-in screen works offline for anybody who has signed in before.
 */

import { useEffect, useState } from 'react';
import { standing } from '@orderbook/shared';

import type { ConnectionInfo, PairResult } from '../api';
import { ConnectionUnpair } from '../components/ConnectionUnpair';
import { Button, Card, ProgressBar, SaveTextButton, rem, t } from '@orderbook/ui';

interface Props {
  connection: ConnectionInfo;
  result: PairResult | null;
  onContinue: () => void;
  onLeft: () => void;
}

/** After this many seconds without the data, say it is slow and offer to carry on. */
const SLOW_AFTER_S = 20;
/** The pause on "ready" before moving on by itself, when there is nothing to read. */
const READY_HOLD_MS = 1200;

export function SetupScreen({ connection, result, onContinue, onLeft }: Props) {
  const company = connection.companyName ?? result?.companyName ?? t('connection.scan.defaultName');
  const connected = connection.state === 'connected';
  const received = connected && !connection.catchingUp && connection.lastSyncedAt !== null;
  const unreachable = connection.state === 'disconnected';

  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (received) return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [received]);

  const against = standing(__APP_VERSION__, connection.masterVersion);
  const versionNote =
    against === 'behind'
      ? t('connection.test.masterNewer', {
          master: connection.masterVersion ?? '',
          mine: __APP_VERSION__,
        })
      : against === 'ahead'
        ? t('connection.test.masterOlder', {
            master: connection.masterVersion ?? '',
            mine: __APP_VERSION__,
          })
        : null;

  const notes = [
    result?.newMaster ? t('connection.setup.newMaster') : null,
    result?.parkedChanges ? t('connection.setup.parked', { count: result.parkedChanges }) : null,
    versionNote,
  ].filter((note): note is string => note !== null);

  // Nothing to read and nothing wrong: go on by itself, after a moment to see it worked.
  useEffect(() => {
    if (!received || notes.length > 0) return;
    const timer = window.setTimeout(onContinue, READY_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [received, notes.length, onContinue]);

  const step = received ? 3 : connected ? 2 : 1;
  const label = received
    ? t('connection.setup.ready', { company })
    : connected
      ? t('connection.setup.receiving', { company })
      : t('connection.setup.connecting', { company });

  return (
    <div style={{ maxWidth: rem(520), margin: '0 auto', padding: 'var(--s-56) var(--s-16)' }}>
      <h1 className="ob-display" style={{ marginBottom: 'var(--s-16)' }}>
        {t('connection.setup.title')}
      </h1>

      <Card>
        <p className="ob-body-strong" role="status" style={{ marginBottom: 'var(--s-12)' }}>
          {label}
        </p>
        <ProgressBar value={step / 3} />

        {unreachable ? (
          <div
            className="ob-banner ob-banner--conflict"
            role="alert"
            style={{ marginTop: 'var(--s-16)' }}
          >
            <span>{t('connection.setup.failed', { reason: connection.lastError ?? '—' })}</span>
          </div>
        ) : null}

        {!received && !unreachable && seconds >= SLOW_AFTER_S ? (
          <p className="ob-small" style={{ marginTop: 'var(--s-12)' }}>
            {t('connection.setup.slow')}
          </p>
        ) : null}

        {notes.map((note) => (
          <div
            key={note}
            className="ob-banner ob-banner--offline"
            role="status"
            style={{ marginTop: 'var(--s-12)' }}
          >
            <span>{note}</span>
          </div>
        ))}

        <div
          style={{
            display: 'flex',
            gap: 'var(--s-8)',
            marginTop: 'var(--s-16)',
            alignItems: 'center',
          }}
        >
          <Button variant="primary" onClick={onContinue}>
            {t('connection.setup.continue')}
          </Button>
          <SaveTextButton
            title={t('saveText.title.officeSetup')}
            slug="office-setup"
            sections={[
              {
                heading: t('saveText.section.master'),
                values: [
                  { label: t('saveText.label.company'), value: company },
                  ...(connection.masterHost
                    ? [
                        {
                          label: t('saveText.label.address'),
                          value: connection.masterPort ? `${connection.masterHost}:${connection.masterPort}` : connection.masterHost,
                        },
                      ]
                    : []),
                  ...(connection.masterVersion
                    ? [{ label: t('saveText.label.masterVersion'), value: connection.masterVersion }]
                    : []),
                ],
              },
              {
                heading: t('saveText.section.thisPanel'),
                values: [
                  { label: t('saveText.label.panelName'), value: connection.panelName },
                  ...(connection.deviceCode ? [{ label: t('saveText.label.deviceCode'), value: connection.deviceCode }] : []),
                ],
              },
            ]}
          />
          {/* Nobody is signed in here: the server allows leaving only when the Master cannot be reached. */}
          {connection.state !== 'connected' || connection.notRecognised ? (
            <ConnectionUnpair company={company} onDone={onLeft} canDiscard={false} />
          ) : null}
        </div>
      </Card>
    </div>
  );
}
