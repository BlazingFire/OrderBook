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
  AutoUpdateStatus,
  MessageKey,
  OfficePanelWithPresence,
  ReleaseManifest,
  UpdateAvailability,
  UpdateStatusResponse,
} from '@orderbook/shared';
import { standing } from '@orderbook/shared';

import { api, desktopBridge } from '../api';
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  FormField,
  Input,
  Section,
  StatusPill,
  Switch,
  UpdateProgress,
  apiErrorText,
  formatDateTime,
  rem,
  t,
  useSaveAllBeforeUpdate,
  useToast,
  type DataTableColumn,
} from '@orderbook/ui';

type Phase = 'idle' | 'verifying' | 'launching' | 'failed';

/** How often the screen re-reads while a download runs, and while it does not. */
const POLL_BUSY_MS = 2_000;
const POLL_IDLE_MS = 30_000;

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

  const [status, setStatus] = useState<UpdateStatusResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const saveAll = useSaveAllBeforeUpdate();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [readyPath, setReadyPath] = useState<string | null>(null);
  /**
   * What to do instead, for a build that cannot install over itself — the
   * standalone `.exe`, or a Linux copy not started from an AppImage (in a
   * shipped build the `.deb`, which only the package manager can replace).
   * The shell says so up front rather than after a click. A browser tab or a
   * shell older than 1.2.0 answers nothing, which reads as an installed build.
   */
  const [byHand, setByHand] = useState<MessageKey | null>(null);

  useEffect(() => {
    const shell = desktopBridge();
    if (!shell?.getShellSettings) return;
    shell
      .getShellSettings()
      .then((settings) =>
        setByHand(
          settings.standalone === true
            ? 'updates.standaloneBody'
            : settings.systemPackage === true
              ? 'updates.systemPackageBody'
              : null,
        ),
      )
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    try {
      setStatus(await api.updateStatus());
    } catch {
      // A broken releases folder must not take the screen down with it — the
      // panel table below is the half somebody may have come here for.
      setStatus(null);
    }
  }, []);

  // Re-read without a reload (1.4 R6): every 30 s, and every 2 s while a build
  // is coming down so the progress bar moves.
  const busyDownloading = ['downloading', 'verifying'].some(
    (phase) => status?.download.master.phase === phase || status?.download.office.phase === phase,
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), busyDownloading ? POLL_BUSY_MS : POLL_IDLE_MS);
    return () => clearInterval(timer);
  }, [load, busyDownloading]);

  /** Check now: GitHub is asked straight away, not at the next poll. */
  const checkNow = async (): Promise<void> => {
    setChecking(true);
    try {
      const next = await api.checkForUpdates();
      setStatus(next);
      if (!next.master.available && !['downloading', 'verifying'].includes(next.download.master.phase)) {
        toast.push(t('updates.checkedNone'), { tone: 'ok' });
      }
    } catch (caught) {
      toast.push(apiErrorText(caught, 'error.requestFailed'), { tone: 'error' });
    } finally {
      setChecking(false);
    }
  };

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

      // Save all (1.4 R7b): whatever is open and can be saved is, and what cannot
      // is named. Declining the last question leaves everything as it was.
      if (!(await saveAll())) {
        setPhase('idle');
        return;
      }

      setPhase('launching');
      // Signed out before the window closes (R7c). The server's stop would end
      // the session anyway; doing it here means a refused install shows the
      // sign-in screen rather than a window that looks signed in and is not.
      await api.signOut().catch(() => undefined);
      setSignedOut(true);
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

          <div
            style={{
              marginTop: 'var(--s-12)',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--s-12)',
              flexWrap: 'wrap',
            }}
          >
            <Button variant="secondary" busy={checking} onClick={() => void checkNow()}>
              {checking ? t('updates.checking') : t('updates.checkNow')}
            </Button>
            <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
              {status?.lastCheckedAt
                ? t('updates.lastChecked', { time: formatDateTime(status.lastCheckedAt) })
                : t('updates.notCheckedYet')}
            </span>
            {desktopBridge()?.openLogFolder ? (
              <Button variant="ghost" onClick={() => void desktopBridge()?.openLogFolder?.()}>
                {t('updates.openLogFolder')}
              </Button>
            ) : null}
          </div>

          {status ? (
            <div style={{ marginTop: 'var(--s-12)', display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
              <UpdateProgress progress={status.download.master} />
            </div>
          ) : null}

          <UpdateOffer
            offer={offer}
            availability={status?.master ?? null}
            canInstall={permissions.includes('settings.manage')}
            byHand={byHand}
            phase={phase}
            failure={failure}
            readyPath={readyPath}
            onInstall={() => void install()}
          />

          {signedOut && phase === 'failed' ? (
            <div style={{ marginTop: 'var(--s-8)' }}>
              <Button variant="secondary" onClick={() => window.location.reload()}>
                {t('updates.signInAgain')}
              </Button>
            </div>
          ) : null}
        </Card>
      </Section>

      {permissions.includes('settings.manage') && status ? (
        <AutoUpdateSection
          status={status.auto}
          running={master}
          onSaved={(auto) => setStatus((current) => (current ? { ...current, auto } : current))}
        />
      ) : null}

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
        {status ? <UpdateProgress progress={status.download.office} /> : null}
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
function UpdateOffer({
  offer,
  availability,
  canInstall,
  byHand,
  phase,
  failure,
  readyPath,
  onInstall,
}: {
  offer: ReleaseManifest | null;
  availability: UpdateAvailability | null;
  canInstall: boolean;
  byHand: MessageKey | null;
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

      {byHand ? (
        <p className="ob-small" style={{ margin: 0 }}>
          {t(byHand)}
        </p>
      ) : canInstall ? (
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

/**
 * The nightly update (1.4 R8): on by default, at 23:00. The Master prepares the
 * newest build, takes a copy of its data, installs it with nobody at the
 * keyboard and starts again; the server serves the Offices as soon as it is up,
 * and the window shows the sign-in screen for whoever comes in next.
 */
function AutoUpdateSection({
  status,
  running,
  onSaved,
}: {
  status: AutoUpdateStatus;
  running: string;
  onSaved: (status: AutoUpdateStatus) => void;
}) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(status.enabled);
  const [time, setTime] = useState(status.time);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.saveAutoUpdate({ enabled, time }));
      toast.push(t('updates.auto.saved'), { tone: 'ok' });
    } catch (caught) {
      setError(apiErrorText(caught, 'error.requestFailed'));
    } finally {
      setSaving(false);
    }
  }

  const run = status.lastRun;
  const runText = !run
    ? t('updates.auto.never')
    : run.outcome === 'installing'
      ? run.version === running
        ? t('updates.auto.updated', { version: run.version ?? '', at: formatDateTime(run.at) })
        : t('updates.auto.waiting', { version: run.version ?? '', at: formatDateTime(run.at) })
      : run.outcome === 'skipped'
        ? t('updates.auto.skipped', { at: formatDateTime(run.at) })
        : t('updates.auto.failed', {
            at: formatDateTime(run.at),
            reason: run.message ? t(run.message.messageKey as MessageKey, run.message.params) : '',
          });

  return (
    <Section title={t('updates.auto.title')}>
      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
          <p className="ob-small" style={{ margin: 0 }}>
            {t('updates.auto.help')}
          </p>
          <p className="ob-small" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
            {runText}
          </p>
          <Switch checked={enabled} onChange={setEnabled} label={t('updates.auto.enabled')} />
          <FormField label={t('updates.auto.time')}>
            {(id) => (
              <Input
                id={id}
                type="time"
                value={time}
                disabled={!enabled}
                onChange={(event) => setTime(event.target.value)}
              />
            )}
          </FormField>
          {error ? (
            <p className="ob-small" role="alert" style={{ margin: 0, color: 'var(--state-conflict)' }}>
              {error}
            </p>
          ) : null}
          <div>
            <Button variant="primary" busy={saving} onClick={() => void save()}>
              {t('updates.auto.save')}
            </Button>
          </div>
        </div>
      </Card>
    </Section>
  );
}
