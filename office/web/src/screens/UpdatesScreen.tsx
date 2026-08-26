/**
 * App update — what this panel is running, and whether it matches the Master.
 *
 * The Master is the reference version, reported in every snapshot it sends, so
 * this screen can answer the only question that matters on a panel: am I the
 * same as the machine everyone else syncs through? A mismatch is never an
 * error and never blocks anything — a panel a version behind keeps taking
 * orders, because a shop floor stopping over a version number would be a worse
 * failure than the drift it was reporting.
 */

import type { ConnectionInfo } from '../api';

import { formatDateTime } from '../format';
import { t } from '../i18n/strings';
import { Card, Section } from '../ui/Card';
import { StatusPill } from '../ui/DataDisplay';

export function UpdatesScreen({ connection }: { connection: ConnectionInfo }) {
  const mine = __APP_VERSION__;
  const master = connection.masterVersion;
  const known = master !== null;
  const matches = known && master === mine;

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
              <dd className="ob-mono">{known ? master : t('updates.unknown')}</dd>
            </div>
            <div>
              <dt>{t('updates.statusLabel')}</dt>
              <dd>
                {!known ? (
                  <StatusPill tone="default">{t('updates.unknown')}</StatusPill>
                ) : matches ? (
                  <StatusPill tone="ok">{t('updates.upToDate')}</StatusPill>
                ) : (
                  <StatusPill tone="offline">{t('updates.behind')}</StatusPill>
                )}
              </dd>
            </div>
            <div>
              <dt>{t('sync.lastSuccessful')}</dt>
              <dd>{formatDateTime(connection.lastSyncedAt)}</dd>
            </div>
          </dl>
        </Card>
      </Section>

      <Section title={t('updates.howTitle')}>
        <Card>
          <p className="ob-body" style={{ marginTop: 0 }}>
            {!known
              ? t('updates.panel.unknownBody')
              : matches
                ? t('updates.panel.matchBody')
                : t('updates.panel.behindBody', { version: master })}
          </p>
          <p className="ob-small" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
            {t('updates.howHint')}
          </p>
        </Card>
      </Section>
    </div>
  );
}
