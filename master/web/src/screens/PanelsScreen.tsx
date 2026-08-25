/**
 * Connected Office Panels, plus the "Add Office Panel" flow.
 *
 * Opening this screen's pairing window is what allows a panel to join, so the
 * waiting state is explicit and closes itself when the operator leaves.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OfficePanelWithPresence } from '@orderbook/shared';

import { api } from '../api';
import { formatDateTime } from '../format';
import { t } from '../i18n/strings';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { StatusPill } from '../ui/DataDisplay';
import { DataTable, type DataTableColumn } from '../ui/DataTable';
import { FormField, Input } from '../ui/Form';
import { Modal } from '../ui/Modal';
import { ConflictBanner, EmptyState } from '../ui/States';

interface Props {
  panels: OfficePanelWithPresence[];
  onRefresh: () => void;
}

export function PanelsScreen({ panels, onRefresh }: Props) {
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

  // Leaving this screen must not leave the network open to new panels.
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
      render: (panel) => <span>{panel.name}</span>,
    },
    {
      key: 'address',
      header: t('panels.table.address'),
      width: '150px',
      render: (panel) => <span className="ob-small">{panel.lanIp ?? '—'}</span>,
    },
    {
      key: 'paired',
      header: t('panels.table.paired'),
      width: '150px',
      render: (panel) => <span className="ob-small">{formatDateTime(panel.pairedAt)}</span>,
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
      width: '190px',
      render: (panel) =>
        panel.status !== 'revoked' ? (
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
            <Button variant="secondary" style={{ marginTop: 'var(--s-12)' }} onClick={() => void stopWaiting()}>
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
            <DataTable columns={columns} rows={panels} rowKey={(panel) => panel.id} />
          </div>
        )}
      </Card>

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
