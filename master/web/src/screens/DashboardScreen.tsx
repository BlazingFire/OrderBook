/**
 * Master-appropriate dashboard (docs/UI_REDESIGN.md §4.8, §8 Phase 2 item 8):
 * panels online, aggregate sync health (conflicts + pending), low stock — not
 * the lead/order pipeline tiles the mockup shows, since that content belongs
 * to Office's own dashboard, built separately.
 */

import type { ReactNode } from 'react';
import type { DashboardSummary, OfficePanelWithPresence } from '@orderbook/shared';

import { Card, EmptyState, Skeleton, t } from '@orderbook/ui';

interface Props {
  summary: DashboardSummary | null;
  panels: OfficePanelWithPresence[];
  onOpenConflicts: () => void;
}

export function DashboardScreen({ summary, panels, onOpenConflicts }: Props) {
  const connected = panels.filter((panel) => panel.isConnected).length;
  const active = panels.filter((panel) => panel.status === 'active');
  const loading = summary === null;

  const conflictCount = summary?.openConflictCount ?? 0;
  const pendingCount = summary?.pendingSyncCount ?? 0;
  const lowStockCount = summary?.lowStockCount ?? 0;
  const offlineCount = active.length - connected;

  return (
    <div
      className="ob-measure-wide"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--s-12)' }}>
        {loading ? (
          <>
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
          </>
        ) : (
          <>
            <StatCard
              label={t('dashboard.stat.panelsOnline')}
              value={`${connected} / ${active.length}`}
              note={
                active.length === 0
                  ? t('dashboard.stat.panelsOnline.noteNone')
                  : offlineCount === 0
                    ? t('dashboard.stat.panelsOnline.noteAll')
                    : t('dashboard.stat.panelsOnline.noteSome', { count: offlineCount })
              }
              tone={active.length > 0 && offlineCount > 0 ? 'offline' : undefined}
            />
            <StatCard
              label={t('dashboard.stat.conflicts')}
              value={conflictCount}
              note={
                conflictCount > 0
                  ? t('dashboard.stat.conflicts.noteSome')
                  : t('dashboard.stat.conflicts.noteNone')
              }
              tone={conflictCount > 0 ? 'conflict' : undefined}
              onClick={conflictCount > 0 ? onOpenConflicts : undefined}
            />
            <StatCard
              label={t('dashboard.stat.pendingSync')}
              value={pendingCount}
              note={t('dashboard.stat.pendingSync.note')}
              tone={pendingCount > 0 ? 'offline' : undefined}
            />
            <StatCard
              label={t('dashboard.stat.lowStock')}
              value={lowStockCount}
              note={
                lowStockCount > 0
                  ? t('dashboard.stat.lowStock.noteSome')
                  : t('dashboard.stat.lowStock.noteNone')
              }
              tone={lowStockCount > 0 ? 'offline' : undefined}
            />
          </>
        )}
      </div>

      <Card>
        <div className="ob-body-strong" style={{ marginBottom: 'var(--s-12)' }}>
          {t('nav.master.panels')}
          {!loading && ` — ${t('dashboard.panels.subtitle', { connected, total: active.length })}`}
        </div>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
            <Skeleton height="var(--t-body-line)" />
            <Skeleton height="var(--t-body-line)" width="70%" />
          </div>
        ) : active.length === 0 ? (
          <EmptyState
            title={t('dashboard.panels.empty.title')}
            description={t('dashboard.panels.empty.description')}
          />
        ) : (
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--s-8)',
            }}
          >
            {active.map((panel) => (
              <li
                key={panel.id}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    flex: 'none',
                    background: panel.isConnected ? 'var(--state-ok)' : 'var(--line-strong)',
                  }}
                />
                <span className="ob-body">{panel.name}</span>
                <span className="ob-small">
                  {panel.lanIp ?? t('dashboard.panels.addressUnknown')} ·{' '}
                  {t('dashboard.panels.deviceLabel', { code: panel.deviceCode })}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="ob-small" style={{ marginTop: 'var(--s-12)', marginBottom: 0 }}>
          {t('dashboard.panels.footerNote')}
        </p>
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  note,
  tone,
  onClick,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'conflict' | 'offline';
  onClick?: () => void;
}) {
  const toneColour =
    tone === 'conflict'
      ? 'var(--state-conflict)'
      : tone === 'offline'
        ? 'var(--state-offline)'
        : undefined;
  const body = (
    <>
      <div className="ob-eyebrow">{label}</div>
      <div
        className="ob-display"
        style={{ marginTop: 'var(--s-6)', color: toneColour, fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </div>
      {note && (
        <div className="ob-small" style={{ marginTop: 'var(--s-2)' }}>
          {note}
        </div>
      )}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className="ob-card ob-card--pad"
        style={{
          textAlign: 'left',
          width: '100%',
          font: 'inherit',
          color: 'inherit',
          cursor: 'pointer',
        }}
        onClick={onClick}
      >
        {body}
      </button>
    );
  }

  return <Card>{body}</Card>;
}

function StatSkeleton() {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
        <Skeleton width="60%" height="var(--t-eyebrow-line)" />
        <Skeleton width="40%" height="var(--t-display-line)" />
        <Skeleton width="80%" height="var(--t-small-line)" />
      </div>
    </Card>
  );
}
