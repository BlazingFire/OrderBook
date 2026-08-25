/**
 * One Office Panel, administered.
 *
 * Reached by double-clicking a row on the Office Panels screen — the same
 * open-on-double-click convention the Leads list uses (`ui/DataTable.tsx`).
 *
 * Everything here is about a PC on the other side of the LAN that the Master
 * cannot reach: an Office Panel serves its own API on loopback, so nothing
 * shown under "the PC it runs on" was discovered — the panel volunteered it
 * over the socket. That has two consequences the screen has to be honest
 * about, and both drive the layout:
 *
 *  · A panel that is switched off shows its **last** report, dated. Blanks are
 *    labelled "not reported yet" rather than rendered as zero — a disk shown as
 *    0 bytes free is a decision somebody would act on.
 *  · Anything that *changes* the panel — reissuing its secret, moving its
 *    files — needs the panel on the other end to do the work, so those controls
 *    say why they are unavailable rather than failing when pressed.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ActivityLogEntry, OfficePanelDetail, Role } from '@orderbook/shared';

import { api, ApiError } from '../api';
import { formatBytes, formatDateTime } from '../format';
import { t } from '../i18n/strings';
import { Button } from '../ui/Button';
import { Card, Section } from '../ui/Card';
import { IdField, KeyValueList, StatusPill } from '../ui/DataDisplay';
import { DataTable, type DataTableColumn } from '../ui/DataTable';
import { FormField, Input, Switch, Textarea, Select } from '../ui/Form';
import { Modal } from '../ui/Modal';
import { ConflictBanner, EmptyState, SkeletonRows } from '../ui/States';
import { Tabs, type TabItem } from '../ui/Tabs';
import { useToast } from '../ui/Toast';

type Tab = 'overview' | 'credentials' | 'storage' | 'access' | 'activity';

interface Props {
  panelId: string;
  /** The signed-in caller's own resolved permissions. */
  permissions: string[];
  /** Bumped by the live socket, so a panel connecting refreshes this screen. */
  revision: number;
  onBack: () => void;
  /** Called after a change the list behind this screen also has to reflect. */
  onChanged: () => void;
}

/** "Not reported yet" — never an em dash on its own, which reads as "zero". */
function reported(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return t('panel.field.unknown');
  return String(value);
}

function bytesOrUnknown(value: number | null): string {
  return value === null ? t('panel.field.unknown') : formatBytes(value);
}

/** `win32` is Node's word, not a person's. */
function platformName(platform: string | null, osVersion: string | null): string {
  if (!platform) return t('panel.field.unknown');
  const friendly =
    platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform;
  return osVersion ? `${friendly} · ${osVersion}` : friendly;
}

export function PanelDetailScreen({ panelId, permissions, revision, onBack, onChanged }: Props) {
  const toast = useToast();
  const canManage = permissions.includes('panels.manage');
  const canViewLogs = permissions.includes('logs.view');

  const [tab, setTab] = useState<Tab>('overview');
  const [panel, setPanel] = useState<OfficePanelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPanel(await api.panel(panelId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('panel.load.failed'));
    }
  }, [panelId]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  /**
   * Every save funnels through here so one place owns the busy flag, the error
   * banner and the reload — a screen with five independent save buttons is
   * otherwise five chances to leave one of the three behind.
   */
  const run = useCallback(
    async (operation: () => Promise<unknown>, failure: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await operation();
        await load();
        onChanged();
        return true;
      } catch (caught) {
        setError(caught instanceof ApiError || caught instanceof Error ? caught.message : failure);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged],
  );

  if (!panel) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
        {error && <ConflictBanner>{error}</ConflictBanner>}
        <Card>
          <SkeletonRows rows={4} />
        </Card>
      </div>
    );
  }

  const tabs: TabItem[] = [
    { id: 'overview', label: t('panel.tab.overview') },
    { id: 'credentials', label: t('panel.tab.credentials') },
    { id: 'storage', label: t('panel.tab.storage') },
    { id: 'access', label: t('panel.tab.access') },
    { id: 'activity', label: t('panel.tab.activity') },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      {error && <ConflictBanner>{error}</ConflictBanner>}

      <PanelHeader
        panel={panel}
        busy={busy}
        canManage={canManage}
        onBack={onBack}
        onRefresh={() =>
          void run(async () => {
            const fresh = await api.refreshPanel(panel.id);
            toast.push(t('panel.action.refreshed', { name: fresh.name }), { tone: 'ok' });
          }, t('panel.load.failed'))
        }
      />

      <Tabs tabs={tabs} activeId={tab} onChange={(id) => setTab(id as Tab)} />

      {tab === 'overview' && <OverviewTab panel={panel} canManage={canManage} busy={busy} run={run} />}
      {tab === 'credentials' && (
        <CredentialsTab panel={panel} canManage={canManage} busy={busy} run={run} />
      )}
      {tab === 'storage' && <StorageTab panel={panel} canManage={canManage} busy={busy} run={run} />}
      {tab === 'access' && <AccessTab panel={panel} canManage={canManage} busy={busy} run={run} />}
      {tab === 'activity' && <ActivityTab panelId={panel.id} canViewLogs={canViewLogs} revision={revision} />}
    </div>
  );
}

// --- Header ----------------------------------------------------------------

function PanelHeader({
  panel,
  busy,
  canManage,
  onBack,
  onRefresh,
}: {
  panel: OfficePanelDetail;
  busy: boolean;
  canManage: boolean;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const presence =
    panel.status === 'revoked' ? (
      <StatusPill tone="default">{t('panel.status.removed')}</StatusPill>
    ) : panel.isConnected ? (
      <StatusPill tone="ok">{t('panel.status.connected')}</StatusPill>
    ) : (
      <StatusPill tone="offline">{t('panel.status.offline')}</StatusPill>
    );

  const since = panel.isConnected
    ? t('panel.status.connectedSince', { when: formatDateTime(panel.runtime?.connectedSince ?? null) })
    : panel.lastSeenAt
      ? t('panel.status.lastSeen', { when: formatDateTime(panel.lastSeenAt) })
      : t('panel.status.neverSeen');

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--s-12)', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <button
            type="button"
            className="ob-btn ob-btn--ghost ob-btn--sm"
            style={{ marginLeft: 'calc(var(--s-8) * -1)' }}
            onClick={onBack}
          >
            ← {t('panel.back')}
          </button>
          <h2 className="ob-title" style={{ margin: 'var(--s-4) 0 var(--s-4)' }}>
            {panel.name}
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)', flexWrap: 'wrap' }}>
            {presence}
            <span className="ob-small">{since}</span>
            <span className="ob-small ob-mono">{panel.deviceCode}</span>
          </div>
        </div>

        {canManage && (
          <Button
            variant="secondary"
            icon="sync"
            busy={busy}
            disabled={!panel.isConnected}
            title={panel.isConnected ? undefined : t('panel.refresh.offline')}
            onClick={onRefresh}
          >
            {t('panel.action.refresh')}
          </Button>
        )}
      </div>
    </Card>
  );
}

// --- Overview --------------------------------------------------------------

type Runner = (operation: () => Promise<unknown>, failure: string) => Promise<boolean>;

function OverviewTab({
  panel,
  canManage,
  busy,
  run,
}: {
  panel: OfficePanelDetail;
  canManage: boolean;
  busy: boolean;
  run: Runner;
}) {
  const [name, setName] = useState(panel.name);
  const [notes, setNotes] = useState(panel.notes ?? '');

  // A push from another administrator, or this panel reconnecting, replaces
  // what the form is showing — but only for the fields the reader has not
  // touched, which is what comparing against the saved value achieves.
  useEffect(() => setName(panel.name), [panel.name]);
  useEffect(() => setNotes(panel.notes ?? ''), [panel.notes]);

  const device = panel.device;
  const dirty = name.trim() !== panel.name || notes.trim() !== (panel.notes ?? '');

  return (
    <div className="ob-panel-grid">
      <Card>
        <Section title={t('panel.overview.identity')}>
          {canManage ? (
            <>
              <FormField label={t('panel.field.name')}>
                {(id) => (
                  <Input id={id} value={name} onChange={(event) => setName(event.target.value)} />
                )}
              </FormField>
              <FormField label={t('panel.field.notes')} hint={t('panel.field.notesHint')}>
                {(id) => (
                  <Textarea
                    id={id}
                    rows={2}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                )}
              </FormField>
              <Button
                variant="primary"
                busy={busy}
                disabled={!dirty || !name.trim()}
                onClick={() =>
                  void run(
                    () => api.updatePanel(panel.id, { name: name.trim(), notes: notes.trim() || null }),
                    t('panel.save.failed'),
                  )
                }
              >
                {t('common.save')}
              </Button>
            </>
          ) : (
            <KeyValueList
              items={[
                { label: t('panel.field.name'), value: panel.name },
                { label: t('panel.field.notes'), value: panel.notes ?? t('panel.field.unknown') },
              ]}
            />
          )}

          <KeyValueList
            items={[
              { label: t('panel.field.deviceCode'), value: <IdField value={panel.deviceCode} /> },
              { label: t('panel.field.panelId'), value: <IdField value={panel.id} /> },
              { label: t('panel.field.paired'), value: formatDateTime(panel.pairedAt) },
            ]}
          />
          <p className="ob-small" style={{ margin: 0 }}>
            {t('panel.field.deviceCodeHint')}
          </p>
        </Section>
      </Card>

      <Card>
        <Section title={t('panel.overview.machine')}>
          {device.reportedAt ? (
            <p className="ob-small" style={{ marginTop: 0 }}>
              {t('panel.overview.reportedAt', { when: formatDateTime(device.reportedAt) })}
            </p>
          ) : (
            <p className="ob-small" style={{ marginTop: 0 }}>
              {t('panel.overview.neverReported')}
            </p>
          )}
          <KeyValueList
            items={[
              { label: t('panel.field.hostname'), value: reported(device.hostname) },
              {
                label: t('panel.field.platform'),
                value: platformName(device.platform, device.osVersion),
              },
              { label: t('panel.field.appVersion'), value: reported(device.appVersion) },
              { label: t('panel.field.nodeVersion'), value: reported(device.nodeVersion) },
              { label: t('panel.field.startedAt'), value: formatDateTime(device.startedAt) },
            ]}
          />
        </Section>
      </Card>

      <Card>
        <Section title={t('panel.overview.link')}>
          <KeyValueList
            items={[
              { label: t('panel.field.address'), value: panel.lanIp ?? t('panel.field.unknown') },
              {
                label: t('panel.field.localPort'),
                value: device.localPort ? `http://localhost:${device.localPort}` : t('panel.field.unknown'),
              },
              {
                label: t('panel.field.pendingMutations'),
                value: reported(panel.runtime?.pendingMutations ?? null),
              },
              {
                label: t('panel.field.snapshotAt'),
                value: panel.runtime?.lastSnapshotAt
                  ? formatDateTime(panel.runtime.lastSnapshotAt)
                  : t('panel.field.unknown'),
              },
              {
                label: t('panel.field.signedInUser'),
                value: panel.runtime?.signedInUsername ?? t('panel.field.nobody'),
              },
            ]}
          />
        </Section>
      </Card>

      <Card>
        <Section title={t('panel.overview.work')}>
          <KeyValueList
            items={[
              { label: t('panel.field.leads'), value: <span className="ob-data">{panel.work.leads}</span> },
              { label: t('panel.field.orders'), value: <span className="ob-data">{panel.work.orders}</span> },
              { label: t('panel.field.lastAction'), value: formatDateTime(panel.work.lastActionAt) },
            ]}
          />
        </Section>
      </Card>
    </div>
  );
}

// --- Credentials -----------------------------------------------------------

function CredentialsTab({
  panel,
  canManage,
  busy,
  run,
}: {
  panel: OfficePanelDetail;
  canManage: boolean;
  busy: boolean;
  run: Runner;
}) {
  const [confirming, setConfirming] = useState(false);
  const [issued, setIssued] = useState<{ secret: string; delivered: boolean } | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <Card>
        <Section title={t('panel.credentials.title')}>
          <p className="ob-small" style={{ marginTop: 0 }}>
            {t('panel.credentials.description')}
          </p>

          <KeyValueList
            items={[
              { label: t('panel.field.panelId'), value: <IdField value={panel.id} /> },
              { label: t('panel.field.deviceCode'), value: <IdField value={panel.deviceCode} /> },
              {
                label: t('panel.credentials.secretLabel'),
                value: (
                  <span className="ob-small">
                    <span className="ob-mono">••••••••••••••••</span> — {t('panel.credentials.secretStored')}
                  </span>
                ),
              },
              {
                label: t('panel.field.paired'),
                value: panel.secretRotatedAt
                  ? t('panel.credentials.rotatedAt', { when: formatDateTime(panel.secretRotatedAt) })
                  : t('panel.credentials.neverRotated'),
              },
            ]}
          />

          {canManage && panel.status !== 'revoked' && (
            <Button variant="secondary" busy={busy} onClick={() => setConfirming(true)}>
              {t('panel.credentials.rotate')}
            </Button>
          )}
        </Section>
      </Card>

      <Card>
        <Section title={t('panel.credentials.pairing.title')}>
          <p className="ob-small" style={{ margin: 0 }}>
            {t('panel.credentials.pairing.description')}
          </p>
        </Section>
      </Card>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('panel.credentials.rotate.title', { name: panel.name })}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={() =>
                void run(async () => {
                  const rotation = await api.rotatePanelSecret(panel.id);
                  setConfirming(false);
                  setIssued({ secret: rotation.panelSecret, delivered: rotation.delivered });
                }, t('panel.credentials.rotate.failed'))
              }
            >
              {t('panel.credentials.rotate.confirm')}
            </Button>
          </>
        }
      >
        <p className="ob-body">
          {panel.isConnected
            ? t('panel.credentials.rotate.connected')
            : t('panel.credentials.rotate.offline')}
        </p>
      </Modal>

      {/*
        Shown once and never again — the plaintext is not stored, so there is no
        "show it to me again". The only way back is another reissue.
      */}
      <Modal
        open={issued !== null}
        onClose={() => setIssued(null)}
        title={t('panel.credentials.new.title', { name: panel.name })}
        footer={
          <Button variant="primary" onClick={() => setIssued(null)}>
            {t('panel.credentials.new.close')}
          </Button>
        }
      >
        <p className="ob-body-strong">{t('panel.credentials.new.once')}</p>
        {issued && (
          <>
            <div style={{ margin: 'var(--s-12) 0' }}>
              <IdField value={issued.secret} />
            </div>
            <p className="ob-small" style={{ margin: 0 }}>
              {issued.delivered
                ? t('panel.credentials.new.delivered')
                : t('panel.credentials.new.undelivered')}
            </p>
          </>
        )}
      </Modal>
    </div>
  );
}

// --- Storage ---------------------------------------------------------------

function StorageTab({
  panel,
  canManage,
  busy,
  run,
}: {
  panel: OfficePanelDetail;
  canManage: boolean;
  busy: boolean;
  run: Runner;
}) {
  const [moving, setMoving] = useState(false);
  const [target, setTarget] = useState('');
  const [moveExisting, setMoveExisting] = useState(true);
  /**
   * The outcome stays on screen rather than becoming a toast: it names a folder
   * on another PC that somebody now has to go and delete, and that is not a
   * sentence to show for four seconds and take away.
   */
  const [moved, setMoved] = useState<{ files: number; to: string; from: string } | null>(null);

  const device = panel.device;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      {moved && (
        <div className="ob-banner ob-banner--offline" role="status">
          <span style={{ flex: 1 }}>
            <span className="ob-body-strong">
              {t('panel.storage.change.done', { count: moved.files, path: moved.to })}
            </span>
            <br />
            {t('panel.storage.change.oldFolder', { path: moved.from })}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setMoved(null)}>
            {t('action.dismiss')}
          </Button>
        </div>
      )}

      <Card>
        <Section title={t('panel.storage.title')}>
          <p className="ob-small" style={{ marginTop: 0 }}>
            {t('panel.storage.description')}
          </p>

          <KeyValueList
            items={[
              {
                label: t('panel.storage.path'),
                value: device.dataDir ? <IdField value={device.dataDir} /> : t('panel.field.unknown'),
              },
              {
                label: t('panel.storage.images'),
                value: device.imagesDir ? (
                  <span className="ob-mono ob-small">{device.imagesDir}</span>
                ) : (
                  t('panel.field.unknown')
                ),
              },
              { label: t('panel.storage.used'), value: bytesOrUnknown(device.storageBytes) },
              { label: t('panel.storage.free'), value: bytesOrUnknown(device.diskFreeBytes) },
              { label: t('panel.storage.total'), value: bytesOrUnknown(device.diskTotalBytes) },
              {
                label: t('panel.storage.cachedImages'),
                value: reported(panel.runtime?.cachedImages ?? null),
              },
            ]}
          />

          {canManage && (
            <>
              <Button
                variant="secondary"
                disabled={!panel.isConnected}
                onClick={() => {
                  setTarget(device.dataDir ?? '');
                  setMoving(true);
                }}
              >
                {t('panel.storage.change')}
              </Button>
              {!panel.isConnected && (
                <p className="ob-small" style={{ margin: 0 }}>
                  {t('panel.storage.offline')}
                </p>
              )}
            </>
          )}
        </Section>
      </Card>

      <Modal
        open={moving}
        onClose={() => setMoving(false)}
        title={t('panel.storage.change.title', { name: panel.name })}
        footer={
          <>
            <Button variant="secondary" onClick={() => setMoving(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!target.trim()}
              onClick={() =>
                void run(async () => {
                  const result = await api.setPanelStoragePath(panel.id, {
                    path: target.trim(),
                    moveExisting,
                  });
                  setMoving(false);
                  setMoved({
                    files: result.filesMoved,
                    to: result.dataDir,
                    from: result.previousDataDir,
                  });
                }, t('panel.storage.change.failed'))
              }
            >
              {t('panel.storage.change.confirm')}
            </Button>
          </>
        }
      >
        <p className="ob-small" style={{ marginTop: 0 }}>
          {t('panel.storage.change.description')}
        </p>
        <FormField label={t('panel.storage.change.label')} hint={t('panel.storage.change.hint')}>
          {(id) => (
            <Input
              id={id}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              autoFocus
              spellCheck={false}
            />
          )}
        </FormField>
        <Switch
          checked={moveExisting}
          onChange={setMoveExisting}
          label={t('panel.storage.change.move')}
        />
        <p className="ob-small" style={{ marginBottom: 0 }}>
          {t('panel.storage.change.moveHint')}
        </p>
      </Modal>
    </div>
  );
}

// --- Access ----------------------------------------------------------------

function AccessTab({
  panel,
  canManage,
  busy,
  run,
}: {
  panel: OfficePanelDetail;
  canManage: boolean;
  busy: boolean;
  run: Runner;
}) {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [roleId, setRoleId] = useState(panel.roleId ?? '');

  useEffect(() => setRoleId(panel.roleId ?? ''), [panel.roleId]);

  useEffect(() => {
    if (!canManage) return;
    // A caller who may manage panels but not read roles still gets the rest of
    // the tab; the picker simply does not appear.
    void api
      .roles()
      .then(setRoles)
      .catch(() => setRoles(null));
  }, [canManage]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <Card>
        <Section title={t('panel.access.title')}>
          <p className="ob-small" style={{ marginTop: 0 }}>
            {t('panel.access.description')}
          </p>

          {canManage && roles ? (
            <>
              <FormField
                label={t('panel.access.role')}
                hint={panel.role.isFallback ? t('panel.access.fallbackHint') : undefined}
              >
                {(id) => (
                  <Select id={id} value={roleId} onChange={(event) => setRoleId(event.target.value)}>
                    <option value="">{t('panel.access.fallback')}</option>
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
              <Button
                variant="primary"
                busy={busy}
                disabled={(roleId || null) === panel.roleId}
                onClick={() =>
                  void run(
                    () => api.updatePanel(panel.id, { roleId: roleId || null }),
                    t('panel.save.failed'),
                  )
                }
              >
                {t('panel.access.save')}
              </Button>
            </>
          ) : (
            <KeyValueList
              items={[
                {
                  label: t('panel.access.role'),
                  value: panel.role.isFallback ? t('panel.access.fallback') : panel.role.name,
                },
              ]}
            />
          )}

          <KeyValueList
            items={[
              {
                label: t('panel.access.tier'),
                // Same tone rule as the Roles table (`AccessScreen.tsx`), so a
                // tier means the same colour wherever it is shown.
                value: (
                  <StatusPill
                    tone={
                      panel.role.tier === 'admin'
                        ? 'conflict'
                        : panel.role.tier === 'management'
                          ? 'accent'
                          : 'default'
                    }
                  >
                    {panel.role.tier}
                  </StatusPill>
                ),
              },
              {
                label: t('panel.access.permissions'),
                value: t('panel.access.permissionCount', { count: panel.role.permissions.length }),
              },
            ]}
          />

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-4)' }}>
            {panel.role.permissions.map((permission) => (
              <StatusPill key={permission}>{permission}</StatusPill>
            ))}
          </div>
        </Section>
      </Card>
    </div>
  );
}

// --- Activity --------------------------------------------------------------

function ActivityTab({
  panelId,
  canViewLogs,
  revision,
}: {
  panelId: string;
  canViewLogs: boolean;
  revision: number;
}) {
  const [entries, setEntries] = useState<ActivityLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canViewLogs) return;
    void api
      .panelActivity(panelId)
      .then((result) => {
        setEntries(result.entries);
        setError(null);
      })
      .catch((caught: unknown) => {
        setEntries([]);
        setError(caught instanceof Error ? caught.message : t('panels.activity.error'));
      });
  }, [panelId, canViewLogs, revision]);

  if (!canViewLogs) {
    return (
      <Card>
        <EmptyState
          title={t('panels.activity.empty.title')}
          description={t('panels.activity.denied', { permission: 'logs.view' })}
        />
      </Card>
    );
  }

  return (
    <Card padded={false}>
      {error && <ConflictBanner>{error}</ConflictBanner>}
      <ActivityTable entries={entries} />
    </Card>
  );
}

export function ActivityTable({ entries }: { entries: ActivityLogEntry[] | null }) {
  if (entries === null) {
    return (
      <div style={{ padding: 'var(--s-16)' }}>
        <SkeletonRows rows={4} />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        title={t('panels.activity.empty.title')}
        description={t('panels.activity.empty.description')}
      />
    );
  }

  const columns: DataTableColumn<ActivityLogEntry>[] = [
    {
      key: 'when',
      header: t('panels.activity.column.when'),
      width: '170px',
      render: (entry) => <span className="ob-small">{formatDateTime(entry.createdAt)}</span>,
    },
    {
      key: 'what',
      header: t('panels.activity.column.what'),
      width: '1fr',
      // The catalogue token lives on the server (`shared/src/i18n/activity.ts`)
      // and this bundle deliberately imports no values from `shared`, so the
      // raw pair is rendered rather than a half-translated sentence.
      render: (entry) => (
        <span>
          {entry.entityType} · {entry.action}
        </span>
      ),
    },
    {
      key: 'who',
      header: t('panels.activity.column.who'),
      width: '180px',
      render: (entry) => <span className="ob-small">{entry.actor.name ?? entry.actor.type}</span>,
    },
  ];

  return (
    <div style={{ padding: '0 var(--s-16) var(--s-16)' }}>
      <DataTable columns={columns} rows={entries} rowKey={(entry) => entry.id} />
    </div>
  );
}
