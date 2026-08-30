/**
 * App update — install a new build, and see which panels are behind this one.
 *
 * This screen used to argue, at length, that a "check for updates" button
 * should not exist. That was right while nothing could be installed: there was
 * no packaged build, so a button could only ever have lied. Now there is one,
 * and the argument has changed rather than been abandoned — **nothing here
 * reaches the internet**. An operator copies a setup file into the releases
 * folder on this PC; this screen reads that folder. The premise the product is
 * built on is intact.
 *
 * Two things happen here, and they are different jobs:
 *  - **This Master** installs its own new build, from the folder.
 *  - **Office panels** are told what they are running against this Master, and
 *    pull the office build from it themselves. Nobody walks to five PCs.
 *
 * A panel volunteers its version in the device report it sends over the socket
 * it already holds, so an offline panel still shows the version it had when it
 * was last seen. Deliberately not blanked: "offline, last seen on 1.0.0" is
 * the answer somebody needs before walking over.
 *
 * The install itself belongs to the desktop shell — a web page cannot run a
 * setup file, and the server cannot either without an installer replacing the
 * program files underneath a live request. When there is no shell (a plain
 * browser tab, or development) the screen shows the path instead of a button
 * that would do nothing.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  OfficePanelWithPresence,
  ReleaseManifest,
  UpdateAvailability,
} from '@orderbook/shared';
import { standing } from '@orderbook/shared';

import { api, desktopBridge } from '../api';
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Section,
  StatusPill,
  formatDateTime,
  rem,
  t,
  type DataTableColumn,
} from '@orderbook/ui';

type Phase = 'idle' | 'verifying' | 'launching' | 'failed';

export function UpdatesScreen({
  panels,
  permissions,
}: {
  panels: OfficePanelWithPresence[];
  permissions: string[];
}) {
  const master = __APP_VERSION__;
  const live = panels.filter((panel) => panel.status !== 'revoked');
  const behind = live.filter((panel) => standing(panel.device.appVersion, master) === 'behind');
  const unknown = live.filter((panel) => panel.device.appVersion === null);

  const [status, setStatus] = useState<{
    master: UpdateAvailability;
    office: UpdateAvailability;
  } | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [readyPath, setReadyPath] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.updateStatus();
      setStatus({ master: next.master, office: next.office });
    } catch {
      // A broken releases folder must not take the screen down with it — the
      // panel table below is the half somebody may have come here for.
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const install = async (): Promise<void> => {
    setPhase('verifying');
    setFailure(null);
    try {
      const { path } = await api.prepareMasterUpdate();
      setReadyPath(path);

      const shell = desktopBridge();
      if (!shell) {
        // No window to quit — show the path so the operator can run it.
        setPhase('idle');
        return;
      }

      setPhase('launching');
      if (!(await shell.applyUpdate())) {
        setPhase('failed');
        setFailure(t('updates.launchRefused'));
      }
      // On success this process is about to be replaced; there is nothing to
      // render afterwards and no state worth setting.
    } catch (caught) {
      setPhase('failed');
      setFailure(caught instanceof Error ? caught.message : t('updates.installFailed'));
    }
  };

  const columns: DataTableColumn<OfficePanelWithPresence>[] = [
    {
      key: 'status',
      header: t('panels.table.status'),
      width: rem(120),
      render: (panel) =>
        panel.isConnected ? (
          <StatusPill tone="ok">{t('panels.status.connected')}</StatusPill>
        ) : (
          <StatusPill tone="offline">{t('panels.status.offline')}</StatusPill>
        ),
    },
    { key: 'name', header: t('panels.table.name'), width: '1fr', render: (panel) => panel.name },
    {
      key: 'version',
      header: t('updates.table.version'),
      width: rem(140),
      render: (panel) =>
        panel.device.appVersion === null ? (
          <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
            {t('updates.unknown')}
          </span>
        ) : (
          <span className="ob-mono">{panel.device.appVersion}</span>
        ),
    },
    {
      key: 'match',
      header: '',
      width: rem(160),
      render: (panel) => <StandingPill version={panel.device.appVersion} reference={master} />,
    },
    {
      key: 'lastSeen',
      header: t('panels.table.lastSeen'),
      width: rem(170),
      render: (panel) => <span className="ob-small">{formatDateTime(panel.lastSeenAt)}</span>,
    },
  ];

  const offer = status?.master.available ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-24)' }}>
      <Section title={t('updates.thisMachine')}>
        <Card>
          <dl className="ob-detail-grid">
            <div>
              <dt>{t('updates.masterVersion')}</dt>
              <dd className="ob-mono">{master}</dd>
            </div>
            <div>
              <dt>{t('updates.panelsTracked')}</dt>
              <dd>{live.length}</dd>
            </div>
            <div>
              <dt>{t('updates.panelsBehind')}</dt>
              <dd style={behind.length > 0 ? { color: 'var(--state-offline)' } : undefined}>
                {behind.length}
              </dd>
            </div>
          </dl>

          <UpdateOffer
            offer={offer}
            availability={status?.master ?? null}
            canInstall={permissions.includes('settings.manage')}
            phase={phase}
            failure={failure}
            readyPath={readyPath}
            onInstall={() => void install()}
          />
        </Card>
      </Section>

      <Section title={t('updates.panelsTitle')}>
        <p className="ob-small" style={{ margin: 0 }}>
          {behind.length > 0
            ? t('updates.someBehind', { count: behind.length, version: master })
            : unknown.length > 0
              ? t('updates.someUnknown', { count: unknown.length })
              : t('updates.allMatch', { version: master })}
        </p>
        {status?.office.available ? (
          <p className="ob-small" style={{ margin: 0 }}>
            {t('updates.officeReady', { version: status.office.available.version })}
          </p>
        ) : null}
        <DataTable
          columns={columns}
          rows={live}
          rowKey={(panel) => panel.id}
          empty={
            <EmptyState
              title={t('panels.empty.title')}
              description={t('panels.empty.description')}
            />
          }
        />
      </Section>

      <Section title={t('updates.howTitle')}>
        <Card>
          <p className="ob-body" style={{ marginTop: 0 }}>
            {t('updates.howBody')}
          </p>
          <p className="ob-small" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
            {t('updates.howHint')}
          </p>
        </Card>
      </Section>
    </div>
  );
}

function StandingPill({ version, reference }: { version: string | null; reference: string }) {
  switch (standing(version, reference)) {
    case 'unknown':
      return null;
    case 'same':
      return <StatusPill tone="ok">{t('updates.upToDate')}</StatusPill>;
    case 'behind':
      return <StatusPill tone="offline">{t('updates.behind')}</StatusPill>;
    case 'ahead':
      // Not impossible and worth naming: a panel updated before the Master was.
      return <StatusPill tone="accent">{t('updates.ahead')}</StatusPill>;
  }
}

/**
 * The offer, and the one sentence the whole feature turns on: **your data
 * stays**. Somebody about to replace the software their business runs on is
 * asking exactly that, and leaving it unsaid is how an update never gets
 * installed.
 */
export function UpdateOffer({
  offer,
  availability,
  canInstall,
  phase,
  failure,
  readyPath,
  onInstall,
}: {
  offer: ReleaseManifest | null;
  availability: UpdateAvailability | null;
  canInstall: boolean;
  phase: Phase;
  failure: string | null;
  readyPath: string | null;
  onInstall: () => void;
}) {
  if (!offer) {
    return (
      <p className="ob-small" style={{ margin: 'var(--s-12) 0 0', color: 'var(--fg-tertiary)' }}>
        {availability?.reason === 'noFolder'
          ? t('updates.noFolder')
          : availability?.reason === 'noRelease'
            ? t('updates.noRelease')
            : t('updates.upToDateBody')}
      </p>
    );
  }

  return (
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
            busy={phase === 'verifying' || phase === 'launching'}
            onClick={onInstall}
          >
            {phase === 'verifying'
              ? t('updates.verifying')
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
  );
}
