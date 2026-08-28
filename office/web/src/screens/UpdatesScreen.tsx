/**
 * App update — what this panel is running, and installing a newer build from
 * the Master.
 *
 * This screen used to say only "you differ from the Master, ask whoever looks
 * after it". Now it can do something about it: the office build is published
 * once on the Master, and each panel pulls its own copy over the office
 * network. Nobody walks to five PCs with a USB stick, which in practice was
 * the difference between panels being updated and panels not being updated.
 *
 * **Still nothing reaches the internet.** The Master is the only thing this
 * asks, over the LAN it is already paired to — the premise the product is
 * built on is intact.
 *
 * A mismatch is never an error and never blocks anything. A panel a version
 * behind keeps taking orders, because a shop floor stopping over a version
 * number would be a worse failure than the drift it was reporting. The update
 * happens when a person chooses it, never in the middle of somebody's order.
 *
 * The install belongs to the desktop shell — a web page cannot run a setup
 * file. Without a shell (a plain browser tab, or development) the screen shows
 * the downloaded path rather than a button that would do nothing.
 */

import { useCallback, useEffect, useState } from 'react';
import type { UpdateAvailability } from '@orderbook/shared';
import { standing } from '@orderbook/shared';

import { api, ApiError, desktopBridge, type ConnectionInfo } from '../api';
import { Button, Card, Section, StatusPill, formatDateTime, t } from '@orderbook/ui';

type Phase = 'idle' | 'downloading' | 'launching' | 'failed';

export function UpdatesScreen({
  connection,
  permissions,
}: {
  connection: ConnectionInfo;
  permissions: string[];
}) {
  const mine = __APP_VERSION__;
  const master = connection.masterVersion;
  const against = standing(mine, master);

  const [availability, setAvailability] = useState<UpdateAvailability | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [readyPath, setReadyPath] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAvailability(await api.updateAvailable());
    } catch {
      // Offline, or the Master has published nothing. Either way the panel
      // keeps working, and the version figures above are still worth showing.
      setAvailability(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const install = async (): Promise<void> => {
    setPhase('downloading');
    setFailure(null);
    try {
      const { path } = await api.downloadUpdate();
      setReadyPath(path);

      const shell = desktopBridge();
      if (!shell) {
        setPhase('idle');
        return;
      }

      setPhase('launching');
      if (!(await shell.applyUpdate(path))) {
        setPhase('failed');
        setFailure(t('updates.launchRefused'));
      }
    } catch (caught) {
      setPhase('failed');
      setFailure(
        caught instanceof ApiError || caught instanceof Error
          ? caught.message
          : t('updates.installFailed'),
      );
    }
  };

  const offer = availability?.available ?? null;
  const canInstall = permissions.includes('settings.manage');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-24)' }}>
      <Section title={t('updates.thisPanel')}>
        <Card>
          <dl className="ob-detail-grid">
            <div>
              <dt>{t('updates.panelVersion')}</dt>
              <dd className="ob-mono">{mine}</dd>
            </div>
            <div>
              <dt>{t('updates.masterVersion')}</dt>
              <dd className="ob-mono">{master ?? t('updates.unknown')}</dd>
            </div>
            <div>
              <dt>{t('updates.statusLabel')}</dt>
              <dd>
                {against === 'unknown' ? (
                  <StatusPill tone="default">{t('updates.unknown')}</StatusPill>
                ) : against === 'same' ? (
                  <StatusPill tone="ok">{t('updates.upToDate')}</StatusPill>
                ) : against === 'behind' ? (
                  <StatusPill tone="offline">{t('updates.behind')}</StatusPill>
                ) : (
                  <StatusPill tone="accent">{t('updates.ahead')}</StatusPill>
                )}
              </dd>
            </div>
            <div>
              <dt>{t('sync.lastSuccessful')}</dt>
              <dd>{formatDateTime(connection.lastSyncedAt)}</dd>
            </div>
          </dl>

          {offer ? (
            <div
              style={{
                marginTop: 'var(--s-12)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--s-8)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
                <StatusPill tone="accent">{t('updates.readyLabel')}</StatusPill>
                <span className="ob-body-strong ob-mono">{offer.version}</span>
                <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
                  {formatDateTime(offer.releasedAt)}
                </span>
              </div>

              {offer.notes ? (
                <p className="ob-small" style={{ margin: 0 }}>
                  {offer.notes}
                </p>
              ) : null}

              <p className="ob-small" style={{ margin: 0 }}>
                {t('updates.dataStays')}
              </p>

              {failure ? (
                <p className="ob-small" style={{ margin: 0, color: 'var(--state-conflict)' }}>
                  {failure}
                </p>
              ) : null}

              {readyPath && !desktopBridge() ? (
                <p className="ob-small" style={{ margin: 0 }}>
                  {t('updates.runByHand')} <span className="ob-mono">{readyPath}</span>
                </p>
              ) : null}

              {canInstall ? (
                <div>
                  <Button
                    variant="primary"
                    busy={phase === 'downloading' || phase === 'launching'}
                    onClick={() => void install()}
                  >
                    {phase === 'downloading'
                      ? t('updates.downloading')
                      : phase === 'launching'
                        ? t('updates.launching')
                        : t('updates.installNow')}
                  </Button>
                </div>
              ) : (
                <p className="ob-small" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
                  {t('updates.needsPermission')}
                </p>
              )}
            </div>
          ) : null}
        </Card>
      </Section>

      <Section title={t('updates.howTitle')}>
        <Card>
          <p className="ob-body" style={{ marginTop: 0 }}>
            {offer
              ? t('updates.panel.offerBody', { version: offer.version })
              : against === 'unknown'
                ? t('updates.panel.unknownBody')
                : against === 'behind'
                  ? t('updates.panel.behindBody', { version: master ?? '' })
                  : t('updates.panel.matchBody')}
          </p>
          <p className="ob-small" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
            {t('updates.howHint')}
          </p>
        </Card>
      </Section>
    </div>
  );
}
