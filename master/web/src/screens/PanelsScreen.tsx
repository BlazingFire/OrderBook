/**
 * Connected Office Panels, plus the "Add Office Panel" flow.
 *
 * Opening this screen's pairing window is what allows a panel to join, so the
 * waiting state is explicit and closes itself when the operator leaves.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isLongOffline, PANEL_PROTOCOL_VERSION } from '@orderbook/shared';
import type { OfficePanelDetail, OfficePanelWithPresence } from '@orderbook/shared';

import { api } from '../api';
import {
  Button,
  Card,
  ConflictBanner,
  DataTable,
  EditorScreen,
  EmptyState,
  formatElapsed,
  FormField,
  IdField,
  Input,
  Modal,
  StatusPill,
  formatDateTime,
  rem,
  t,
  useSubNav,
  type DataTableColumn,
} from '@orderbook/ui';

interface Props {
  panels: OfficePanelWithPresence[];
  onRefresh: () => void;
}

/**
 * Connected, but on a protocol older than this Master's: it works, and the
 * commands newer than it are refused with "update needed" until it is updated.
 * An Office too old to announce a protocol counts as the first.
 */
function needsUpdate(panel: OfficePanelWithPresence): boolean {
  return panel.runtime !== null && (panel.runtime.protocol ?? 1) < PANEL_PROTOCOL_VERSION;
}

/**
 * The status chips: connected or offline, "Offline for 3 h 5 m" once that
 * has lasted an hour (1.3), and "Update needed" beside either.
 */
function StatusChips({ panel }: { panel: OfficePanelWithPresence }) {
  const now = Date.now();
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 'var(--s-4)' }}>
      {panel.status === 'revoked' ? (
        <StatusPill tone="default">{t('panels.status.removed')}</StatusPill>
      ) : panel.isConnected ? (
        <StatusPill tone="ok">{t('panels.status.connected')}</StatusPill>
      ) : isLongOffline(panel, now) ? (
        <StatusPill tone="offline">
          {t('panels.offlineFor', {
            duration: formatElapsed(now - Date.parse(panel.lastSeenAt ?? '')),
          })}
        </StatusPill>
      ) : (
        <StatusPill tone="offline">{t('panels.status.offline')}</StatusPill>
      )}
      {needsUpdate(panel) && <StatusPill tone="accent">{t('panels.updateNeeded')}</StatusPill>}
    </span>
  );
}

/** Spelled out rather than interpolated, so every key is greppable. */
const STATUS_KEY: Record<OfficePanelWithPresence['status'], string> = {
  pending: 'panels.detail.status.pending',
  active: 'panels.detail.status.active',
  revoked: 'panels.detail.status.revoked',
};

export function PanelsScreen({ panels, onRefresh }: Props) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<OfficePanelWithPresence | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState<OfficePanelWithPresence | null>(null);
  /** Which panel's detail dialog is open, by id rather than by value so the
   *  dialog keeps re-reading the live row as the socket pushes updates. */
  const [openPanelId, setOpenPanelId] = useState<string | null>(null);
  /** The server's fuller account (acting role, work counts); the list row stands in until it arrives. */
  const [detail, setDetail] = useState<OfficePanelDetail | null>(null);
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

  // Leaving this screen must not leave the network open to new panels.
  useEffect(() => {
    return () => {
      void api.closePairingWindow().catch(() => {});
    };
  }, []);

  useEffect(() => {
    setDetail(null);
    if (!openPanelId) return;
    let live = true;
    api
      .panel(openPanelId)
      .then((next) => live && setDetail(next))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [openPanelId]);

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
      width: rem(180),
      render: (panel) => <StatusChips panel={panel} />,
    },
    {
      key: 'name',
      header: t('panels.table.name'),
      width: '1fr',
      render: (panel) => <span>{panel.name}</span>,
    },
    {
      key: 'deviceCode',
      header: t('panels.table.deviceCode'),
      priority: 3,
      width: rem(110),
      render: (panel) => <span className="ob-mono">{panel.deviceCode}</span>,
    },
    {
      key: 'address',
      header: t('panels.table.address'),
      priority: 2,
      width: rem(140),
      render: (panel) => <span className="ob-small">{panel.lanIp ?? '—'}</span>,
    },
    {
      key: 'paired',
      header: t('panels.table.paired'),
      priority: 3,
      width: rem(150),
      render: (panel) => <span className="ob-small">{formatDateTime(panel.pairedAt)}</span>,
    },
    {
      key: 'lastSeen',
      header: t('panels.table.lastSeen'),
      width: rem(150),
      render: (panel) => <span className="ob-small">{formatDateTime(panel.lastSeenAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: rem(110),
      render: (panel) => (
        <div
          style={{ display: 'flex', gap: 'var(--s-6)', justifyContent: 'flex-end', width: '100%' }}
        >
          <Button
            variant="secondary"
            size="sm"
            icon="expand"
            onClick={() => setOpenPanelId(panel.id)}
          >
            {t('panels.action.open')}
          </Button>
        </div>
      ),
    },
  ];

  const openPanel = panels.find((panel) => panel.id === openPanelId) ?? null;

  useSubNav(
    'panels',
    openPanel
      ? {
          parentId: 'panels',
          items: [{ id: 'panels.detail', label: openPanel.name, icon: 'server' }],
          activeId: 'panels.detail',
        }
      : null,
  );

  /**
   * Everything the Master actually knows about a panel: the fields the table
   * has no room for, and the two actions that used to sit on every row and made
   * the list a wall of buttons.
   */
  function renderPanelDetail(panel: OfficePanelWithPresence) {
    return (
      <div className="ob-detail">
        <section className="ob-detail-section">
          <div className="ob-eyebrow">{t('panels.detail.identity')}</div>
          <dl className="ob-detail-grid">
            <div>
              <dt>{t('panels.detail.id')}</dt>
              <dd>
                <IdField value={panel.id} />
              </dd>
            </div>
            <div>
              <dt>{t('panels.table.deviceCode')}</dt>
              <dd className="ob-mono">{panel.deviceCode}</dd>
            </div>
            <div>
              <dt>{t('panels.detail.role')}</dt>
              <dd>
                {detail
                  ? detail.role.isFallback
                    ? t('panels.detail.roleDefault')
                    : detail.role.name
                  : (panel.roleId ?? t('panels.detail.roleDefault'))}
                {detail && (
                  <div className="ob-small">
                    {t('panels.detail.roleSummary', {
                      tier: detail.role.tier,
                      count: detail.role.permissions.length,
                    })}
                  </div>
                )}
              </dd>
            </div>
            <div>
              <dt>{t('panels.detail.statusLabel')}</dt>
              <dd>{t(STATUS_KEY[panel.status])}</dd>
            </div>
          </dl>
        </section>

        <section className="ob-detail-section">
          <div className="ob-eyebrow">{t('panels.detail.network')}</div>
          <dl className="ob-detail-grid">
            <div>
              <dt>{t('panels.detail.connection')}</dt>
              <dd>
                {panel.isConnected
                  ? t('panels.detail.connectionLive')
                  : t('panels.detail.connectionDown')}
              </dd>
            </div>
            <div>
              <dt>{t('panels.table.address')}</dt>
              <dd className="ob-mono">{panel.lanIp ?? '—'}</dd>
            </div>
            <div>
              <dt>{t('panels.table.lastSeen')}</dt>
              <dd>{formatDateTime(panel.lastSeenAt)}</dd>
            </div>
          </dl>
        </section>

        <section className="ob-detail-section">
          <div className="ob-eyebrow">{t('panels.detail.history')}</div>
          <dl className="ob-detail-grid">
            <div>
              <dt>{t('panels.table.paired')}</dt>
              <dd>{formatDateTime(panel.pairedAt)}</dd>
            </div>
            <div>
              <dt>{t('panels.detail.created')}</dt>
              <dd>{formatDateTime(panel.createdAt)}</dd>
            </div>
            <div>
              <dt>{t('panels.detail.updated')}</dt>
              <dd>{formatDateTime(panel.updatedAt)}</dd>
            </div>
          </dl>
        </section>

        {detail && (
          <section className="ob-detail-section">
            <div className="ob-eyebrow">{t('panels.detail.work')}</div>
            <dl className="ob-detail-grid">
              <div>
                <dt>{t('panels.detail.workLeads')}</dt>
                <dd>{detail.work.leads}</dd>
              </div>
              <div>
                <dt>{t('panels.detail.workOrders')}</dt>
                <dd>{detail.work.orders}</dd>
              </div>
              <div>
                <dt>{t('panels.detail.workLast')}</dt>
                <dd>
                  {detail.work.lastActionAt
                    ? formatDateTime(detail.work.lastActionAt)
                    : t('panels.detail.workNone')}
                </dd>
              </div>
            </dl>
          </section>
        )}

        {panel.status === 'revoked' && (
          <p className="ob-small" style={{ margin: 0 }}>
            {t('panels.detail.revokedNote')}
          </p>
        )}
      </div>
    );
  }

  const dialogs = (
    <>
      <Modal
        open={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title={renaming ? t('panels.rename.title', { name: renaming.name }) : ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRenaming(null)}>
              {t('panels.rename.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!renameValue.trim()}
              onClick={() => void submitRename()}
            >
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
    </>
  );

  if (openPanel) {
    return (
      <>
        {error && <ConflictBanner>{error}</ConflictBanner>}
        <EditorScreen
          title={openPanel.name}
          meta={
            <>
              {openPanel.status === 'revoked'
                ? t('panels.status.removed')
                : openPanel.isConnected
                  ? t('panels.detail.connectionLive')
                  : t('panels.detail.connectionDown')}
              <span className="ob-mono ob-small">{openPanel.deviceCode}</span>
            </>
          }
          actions={
            openPanel.status !== 'revoked' && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setRenameValue(openPanel.name);
                    setRenaming(openPanel);
                  }}
                >
                  {t('panels.action.rename')}
                </Button>
                <Button variant="danger" onClick={() => setConfirmRevoke(openPanel)}>
                  {t('panels.action.remove')}
                </Button>
              </>
            )
          }
          onBack={() => {
            setOpenPanelId(null);
            return true;
          }}
          backLabel={t('action.backToList')}
        >
          {renderPanelDetail(openPanel)}
        </EditorScreen>
        {dialogs}
      </>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      {error && <ConflictBanner>{error}</ConflictBanner>}

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

      <Card padded={false}>
        <div style={{ padding: 'var(--s-16) var(--s-16) 0' }}>
          <h2 className="ob-title" style={{ margin: '0 0 var(--s-12)' }}>
            {t('panels.list.title')}
          </h2>
        </div>
        {panels.length === 0 ? (
          <EmptyState title={t('panels.empty.title')} description={t('panels.empty.description')} />
        ) : (
          <div style={{ padding: '0 var(--s-16) var(--s-16)' }}>
            <DataTable
              columns={columns}
              rows={panels}
              rowKey={(panel) => panel.id}
              selectedId={openPanelId ?? undefined}
              onRowOpen={(panel) => setOpenPanelId(panel.id)}
            />
          </div>
        )}
      </Card>

      {dialogs}
    </div>
  );
}
