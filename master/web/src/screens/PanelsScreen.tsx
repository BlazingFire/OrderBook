/**
 * The Office Panels module: the fleet, the pairing flow, and everything that
 * happened across it.
 *
 * Three sections rather than one list, because they answer different
 * questions — "is everything up?", "how do I add one?", "what has been going
 * on?" — and only the first is looked at daily. Opening the pairing section is
 * what allows a panel to join at all, so that window closes itself the moment
 * the section is left; a screen that quietly kept the network open would be
 * the wrong default for a system whose whole premise is a private LAN.
 *
 * Double-clicking a panel opens its own administration screen
 * (`PanelDetailScreen`), matching the Leads list's open-on-double-click
 * convention (`ui/DataTable.tsx`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityLogEntry, OfficePanelWithPresence } from '@orderbook/shared';

import { api } from '../api';
import { formatBytes, formatDateTime } from '../format';
import { t } from '../i18n/strings';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { StatusPill } from '../ui/DataDisplay';
import { DataTable, type DataTableColumn } from '../ui/DataTable';
import { FormField, Input } from '../ui/Form';
import { Modal } from '../ui/Modal';
import { ConflictBanner, EmptyState } from '../ui/States';
import { Tabs, type TabItem } from '../ui/Tabs';
import { ActivityTable } from './PanelDetailScreen';

type Section = 'all' | 'pairing' | 'activity';

interface Props {
  panels: OfficePanelWithPresence[];
  /** The signed-in caller's own resolved permissions. */
  permissions: string[];
  /** Bumped by the live socket whenever data changes. */
  revision: number;
  onRefresh: () => void;
  onOpenPanel: (panelId: string) => void;
}

export function PanelsScreen({ panels, permissions, revision, onRefresh, onOpenPanel }: Props) {
  const canManage = permissions.includes('panels.manage');
  const canViewLogs = permissions.includes('logs.view');

  const [section, setSection] = useState<Section>('all');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<OfficePanelWithPresence | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState<OfficePanelWithPresence | null>(null);
  const previousPanelCount = useRef(panels.length);

  const stopWaiting = useCallback(async () => {
    setWaiting(false);
    await api.closePairingWindow().catch(() => {});
  }, []);

  // A panel appearing while we wait is the success signal — the list is pushed
  // live over the socket, so no polling is needed here.
  useEffect(() => {
    if (waiting && panels.length > previousPanelCount.current) void stopWaiting();
    previousPanelCount.current = panels.length;
  }, [panels.length, waiting, stopWaiting]);

  // Leaving this screen must not leave the network open to new panels. Nor must
  // leaving the *section*: the window is opened from here and nothing else
  // would ever close it.
  useEffect(() => {
    if (section !== 'pairing' && waiting) void stopWaiting();
  }, [section, waiting, stopWaiting]);

  useEffect(() => {
    return () => {
      void api.closePairingWindow().catch(() => {});
    };
  }, []);

  async function startWaiting() {
    setError(null);
    try {
      await api.openPairingWindow();
      setWaiting(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('panels.add.startFailed'));
    }
  }

  async function submitRename() {
    const target = renaming;
    const name = renameValue.trim();
    setRenaming(null);
    if (!target || !name) return;
    try {
      await api.renamePanel(target.id, name);
      onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('panels.rename.failed'));
    }
  }

  async function confirmRevokePanel() {
    const target = confirmRevoke;
    setConfirmRevoke(null);
    if (!target) return;
    try {
      await api.revokePanel(target.id);
      onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('panels.revoke.failed'));
    }
  }

  const columns: DataTableColumn<OfficePanelWithPresence>[] = [
    {
      key: 'status',
      header: t('panels.table.status'),
      width: '120px',
      render: (panel) =>
        panel.status === 'revoked' ? (
          <StatusPill tone="default">{t('panels.status.removed')}</StatusPill>
        ) : panel.isConnected ? (
          <StatusPill tone="ok">{t('panels.status.connected')}</StatusPill>
        ) : (
          <StatusPill tone="offline">{t('panels.status.offline')}</StatusPill>
        ),
    },
    {
      key: 'name',
      header: t('panels.table.name'),
      width: '1fr',
      render: (panel) => (
        <span>
          {panel.name}
          {panel.notes && <span className="ob-small"> · {panel.notes}</span>}
        </span>
      ),
    },
    {
      key: 'machine',
      header: t('panels.table.machine'),
      width: '160px',
      render: (panel) => (
        <span className="ob-small">{panel.device.hostname ?? t('panel.field.unknown')}</span>
      ),
    },
    {
      key: 'address',
      header: t('panels.table.address'),
      width: '140px',
      render: (panel) => <span className="ob-small">{panel.lanIp ?? '—'}</span>,
    },
    {
      key: 'storage',
      header: t('panels.table.storage'),
      width: '110px',
      align: 'right',
      render: (panel) => (
        <span className="ob-small">
          {panel.device.storageBytes === null ? '—' : formatBytes(panel.device.storageBytes)}
        </span>
      ),
    },
    {
      key: 'lastSeen',
      header: t('panels.table.lastSeen'),
      width: '150px',
      render: (panel) => <span className="ob-small">{formatDateTime(panel.lastSeenAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: canManage ? '190px' : '0px',
      render: (panel) =>
        canManage && panel.status !== 'revoked' ? (
          <div style={{ display: 'flex', gap: 'var(--s-6)', justifyContent: 'flex-end', width: '100%' }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setRenameValue(panel.name);
                setRenaming(panel);
              }}
            >
              {t('panels.action.rename')}
            </Button>
            <Button variant="danger" size="sm" onClick={() => setConfirmRevoke(panel)}>
              {t('panels.action.remove')}
            </Button>
          </div>
        ) : null,
    },
  ];

  const sections: TabItem[] = [
    { id: 'all', label: t('panels.section.all') },
    ...(canManage ? [{ id: 'pairing', label: t('panels.section.pairing') }] : []),
    { id: 'activity', label: t('panels.section.activity') },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      {error && <ConflictBanner>{error}</ConflictBanner>}

      <FleetSummary panels={panels} />
      <Tabs tabs={sections} activeId={section} onChange={(id) => setSection(id as Section)} />

      {section === 'all' && (
        <Card padded={false}>
          <div style={{ padding: 'var(--s-16) var(--s-16) 0' }}>
            <h2 className="ob-title" style={{ margin: '0 0 var(--s-4)' }}>
              {t('panels.list.title')}
            </h2>
            <p className="ob-small" style={{ margin: '0 0 var(--s-12)' }}>
              {t('panels.list.hint')}
            </p>
          </div>
          {panels.length === 0 ? (
            <EmptyState title={t('panels.empty.title')} description={t('panels.empty.description')} />
          ) : (
            <div style={{ padding: '0 var(--s-16) var(--s-16)' }}>
              <DataTable
                columns={columns}
                rows={panels}
                rowKey={(panel) => panel.id}
                onRowOpen={(panel) => onOpenPanel(panel.id)}
              />
            </div>
          )}
        </Card>
      )}

      {section === 'pairing' && canManage && (
        <Card>
          <h2 className="ob-title" style={{ margin: '0 0 var(--s-12)' }}>
            {t('panels.add.title')}
          </h2>
          {waiting ? (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
                <span className="ob-body-strong">{t('panels.add.waitingTitle')}</span>
                <span className="ob-small">{t('panels.add.waitingBody')}</span>
              </div>
              <Button
                variant="secondary"
                style={{ marginTop: 'var(--s-12)' }}
                onClick={() => void stopWaiting()}
              >
                {t('panels.add.cancel')}
              </Button>
            </>
          ) : (
            <>
              <p className="ob-small" style={{ marginTop: 0 }}>
                {t('panels.add.description')}
              </p>
              <Button variant="primary" icon="plus" onClick={() => void startWaiting()}>
                {t('panels.add.action')}
              </Button>
            </>
          )}
        </Card>
      )}

      {section === 'activity' && <FleetActivity canViewLogs={canViewLogs} revision={revision} />}

      <Modal
        open={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title={renaming ? t('panels.rename.title', { name: renaming.name }) : ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRenaming(null)}>
              {t('panels.rename.cancel')}
            </Button>
            <Button variant="primary" disabled={!renameValue.trim()} onClick={() => void submitRename()}>
              {t('panels.rename.save')}
            </Button>
          </>
        }
      >
        <FormField label={t('panels.rename.label')}>
          {(id) => (
            <Input
              id={id}
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              autoFocus
            />
          )}
        </FormField>
      </Modal>

      <Modal
        open={Boolean(confirmRevoke)}
        onClose={() => setConfirmRevoke(null)}
        title={confirmRevoke ? t('panels.revoke.title', { name: confirmRevoke.name }) : ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmRevoke(null)}>
              {t('panels.revoke.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void confirmRevokePanel()}>
              {t('panels.action.remove')}
            </Button>
          </>
        }
      >
        <p className="ob-body">{t('panels.revoke.body')}</p>
      </Modal>
    </div>
  );
}

/**
 * The four figures worth knowing before reading any row.
 *
 * A revoked panel counts in neither "connected" nor "offline": it is not a
 * machine that might come back, and putting it in the offline figure would
 * make a tidy fleet look permanently degraded.
 */
function FleetSummary({ panels }: { panels: OfficePanelWithPresence[] }) {
  const live = panels.filter((panel) => panel.status !== 'revoked');
  const connected = live.filter((panel) => panel.isConnected);
  const pending = connected.reduce(
    (total, panel) => total + (panel.runtime?.pendingMutations ?? 0),
    0,
  );

  const figures = [
    { label: t('panels.summary.total'), value: live.length },
    { label: t('panels.summary.connected'), value: connected.length },
    { label: t('panels.summary.offline'), value: live.length - connected.length },
    { label: t('panels.summary.pending'), value: pending },
  ];

  return (
    <div className="ob-panel-figures">
      {figures.map((figure) => (
        <Card key={figure.label}>
          <div className="ob-eyebrow">{figure.label}</div>
          <div className="ob-data" style={{ fontSize: '20px' }}>
            {figure.value}
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Everything every panel has done, newest first. */
function FleetActivity({ canViewLogs, revision }: { canViewLogs: boolean; revision: number }) {
  const [entries, setEntries] = useState<ActivityLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canViewLogs) return;
    void api
      .logs({ actorType: 'office_panel', limit: 50 })
      .then((page) => {
        setEntries(page.items);
        setError(null);
      })
      .catch((caught: unknown) => {
        setEntries([]);
        setError(caught instanceof Error ? caught.message : t('panels.activity.error'));
      });
  }, [canViewLogs, revision]);

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
      <div style={{ padding: 'var(--s-16) var(--s-16) 0' }}>
        <h2 className="ob-title" style={{ margin: '0 0 var(--s-12)' }}>
          {t('panels.activity.title')}
        </h2>
      </div>
      {error && <ConflictBanner>{error}</ConflictBanner>}
      <ActivityTable entries={entries} />
    </Card>
  );
}
