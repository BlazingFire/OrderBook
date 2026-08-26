/**
 * App update — what this Master is running, and which panels are behind it.
 *
 * There is no "check for updates" button and there will not be one: the shop
 * network has no internet, which is the premise the whole product is built on.
 * The Master is the reference version, and the useful question is not "is there
 * something newer out there" but "which machines on this floor disagree with
 * this one" — which is answerable here, without walking to any of them.
 *
 * A panel volunteers its version in the device report it sends over the socket
 * it already holds, so an offline panel still shows the version it had when it
 * was last seen. That is deliberately not blanked: "offline, last seen on
 * 0.1.0" is the answer somebody needs before they walk over.
 */

import type { OfficePanelWithPresence } from '@orderbook/shared';

import { formatDateTime } from '../format';
import { t } from '../i18n/strings';
import { Card, Section } from '../ui/Card';
import { StatusPill } from '../ui/DataDisplay';
import { DataTable, type DataTableColumn } from '../ui/DataTable';
import { EmptyState } from '../ui/States';

export function UpdatesScreen({ panels }: { panels: OfficePanelWithPresence[] }) {
  const master = __APP_VERSION__;
  const live = panels.filter((panel) => panel.status !== 'revoked');
  const behind = live.filter((panel) => panel.device.appVersion !== null && panel.device.appVersion !== master);
  const unknown = live.filter((panel) => panel.device.appVersion === null);

  const columns: DataTableColumn<OfficePanelWithPresence>[] = [
    {
      key: 'status',
      header: t('panels.table.status'),
      width: '120px',
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
      width: '140px',
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
      width: '160px',
      render: (panel) =>
        panel.device.appVersion === null ? null : panel.device.appVersion === master ? (
          <StatusPill tone="ok">{t('updates.upToDate')}</StatusPill>
        ) : (
          <StatusPill tone="offline">{t('updates.behind')}</StatusPill>
        ),
    },
    {
      key: 'lastSeen',
      header: t('panels.table.lastSeen'),
      width: '170px',
      render: (panel) => <span className="ob-small">{formatDateTime(panel.lastSeenAt)}</span>,
    },
  ];

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
              <dd style={behind.length > 0 ? { color: 'var(--state-offline)' } : undefined}>{behind.length}</dd>
            </div>
          </dl>
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
        <DataTable
          columns={columns}
          rows={live}
          rowKey={(panel) => panel.id}
          empty={<EmptyState title={t('panels.empty.title')} description={t('panels.empty.description')} />}
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
