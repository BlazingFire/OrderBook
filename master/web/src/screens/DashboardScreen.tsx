/**
 * The Master's dashboard: the Office's cards plus the ones only the Master has.
 *
 * Every figure comes from `DashboardSummary`, which the server builds per
 * person and leaves a figure **out** of when they hold none of the keys behind
 * it (`dashboard.service.ts`). A card therefore draws only when its figure is
 * there - `0` would be a claim about data this person may not see. The panels
 * card and list are `panels.manage`, the Office panels being that module's.
 *
 * Pending Orders, Final Orders, Dispatched this week and the stage bars are the
 * Office's four, from the same summary; "Open board" goes to the Pending Orders
 * module. The follow-ups list is one small read (`leads.view` only, refetched
 * when a lead changes), and a row opens that lead.
 *
 * Not ported: the Office's recent-activity box. The summary carries no timeline,
 * and the Activity log is the Master's place for it.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { DashboardSummary, Lead, OfficePanelWithPresence } from '@orderbook/shared';

import { api } from '../api';
import { Button, Card, EmptyState, Skeleton, rem, t } from '@orderbook/ui';

interface Props {
  summary: DashboardSummary | null;
  panels: OfficePanelWithPresence[];
  /** `panels.manage`: the panels card and list. */
  canManagePanels: boolean;
  /** `leads.view`: the follow-ups list, the only read this screen makes itself. */
  canViewLeads: boolean;
  /** Moves when a lead, order or party changes, so the follow-ups list re-reads. */
  revision: number;
  onNavigate: (target: 'leads' | 'orders' | 'conflicts') => void;
  onOpenLead: (id: string) => void;
}

export function DashboardScreen({
  summary,
  panels,
  canManagePanels,
  canViewLeads,
  revision,
  onNavigate,
  onOpenLead,
}: Props) {
  const connected = panels.filter((panel) => panel.isConnected).length;
  const active = panels.filter((panel) => panel.status === 'active');
  const loading = summary === null;
  const offlineCount = active.length - connected;

  const [followUps, setFollowUps] = useState<Lead[] | null>(null);
  useEffect(() => {
    if (!canViewLeads) return;
    let cancelled = false;
    void api
      .leads({ followUpDueOnly: true, limit: 8 })
      .then((page) => {
        if (!cancelled) setFollowUps(page.items);
      })
      .catch(() => {
        if (!cancelled) setFollowUps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [canViewLeads, revision]);

  const conflictCount = summary?.openConflictCount;
  const pendingCount = summary?.pendingSyncCount;
  const lowStockCount = summary?.lowStockCount;
  const leadCount = summary?.leadCount;
  const dueCount = summary?.followUpsDueCount ?? 0;
  const openOrderCount = summary?.openOrderCount;
  const dispatchedCount = summary?.dispatchedThisWeekCount;
  const stages = [...(summary?.pipelineBreakdown ?? [])].sort((a, b) => a.sequence - b.sequence);
  const stagedLeads = stages.reduce((sum, stage) => sum + stage.leadCount, 0);
  const pipelineMax = Math.max(1, ...stages.map((stage) => stage.leadCount));

  return (
    <div
      className="ob-measure-wide"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fit, minmax(${rem(200)}, 1fr))`,
          gap: 'var(--s-12)',
        }}
      >
        {loading ? (
          <>
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
          </>
        ) : (
          <>
            {leadCount !== undefined && (
              <StatCard
                label={t('dashboard.leads.title')}
                value={leadCount.toLocaleString('en-IN')}
                note={
                  dueCount > 0
                    ? t('dashboard.leads.due', { count: dueCount })
                    : t('dashboard.leads.noneDue')
                }
                onClick={() => onNavigate('leads')}
              />
            )}
            {openOrderCount !== undefined && (
              <StatCard
                label={t('dashboard.orders.title')}
                value={openOrderCount.toLocaleString('en-IN')}
                onClick={() => onNavigate('orders')}
              />
            )}
            {dispatchedCount !== undefined && (
              <StatCard
                label={t('dashboard.dispatched.title')}
                value={dispatchedCount.toLocaleString('en-IN')}
                note={
                  dispatchedCount === 0
                    ? t('dashboard.dispatched.none')
                    : dispatchedCount === 1
                      ? t('dashboard.dispatched.unitOne')
                      : t('dashboard.dispatched.unitMany')
                }
              />
            )}
            {canManagePanels && (
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
            )}
            {conflictCount !== undefined && (
              <StatCard
                label={t('dashboard.stat.conflicts')}
                value={conflictCount}
                note={
                  conflictCount > 0
                    ? t('dashboard.stat.conflicts.noteSome')
                    : t('dashboard.stat.conflicts.noteNone')
                }
                tone={conflictCount > 0 ? 'conflict' : undefined}
                onClick={conflictCount > 0 ? () => onNavigate('conflicts') : undefined}
              />
            )}
            {pendingCount !== undefined && (
              <StatCard
                label={t('dashboard.stat.pendingSync')}
                value={pendingCount}
                note={t('dashboard.stat.pendingSync.note')}
                tone={pendingCount > 0 ? 'offline' : undefined}
              />
            )}
            {lowStockCount !== undefined && (
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
            )}
          </>
        )}
      </div>

      {!loading && summary?.pipelineBreakdown && (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
            <div className="ob-eyebrow" style={{ flex: 1 }}>
              {t('dashboard.pipeline.title')}
            </div>
            <Button variant="ghost" onClick={() => onNavigate('leads')}>
              {t('dashboard.pipeline.openBoard')}
            </Button>
          </div>
          {stages.length === 0 || stagedLeads === 0 ? (
            <div style={{ marginTop: 'var(--s-12)' }}>
              <EmptyState
                title={t('dashboard.pipeline.emptyTitle')}
                description={t('dashboard.pipeline.emptyDescription')}
              />
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--s-8)',
                marginTop: 'var(--s-12)',
              }}
            >
              {stages.map((stage) => (
                <div
                  key={stage.stageId}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `${rem(120)} 1fr ${rem(40)}`,
                    alignItems: 'center',
                    gap: 'var(--s-8)',
                  }}
                >
                  <span className="ob-small" style={{ color: 'var(--fg-secondary)' }}>
                    {stage.stageName}
                  </span>
                  <span
                    style={{
                      display: 'block',
                      height: rem(8),
                      borderRadius: 'var(--r-md)',
                      background: 'var(--bg-sunken)',
                      overflow: 'hidden',
                    }}
                  >
                    <span
                      style={{
                        display: 'block',
                        height: '100%',
                        width: `${Math.round((stage.leadCount / pipelineMax) * 100)}%`,
                        background: 'var(--accent)',
                        borderRadius: 'var(--r-md)',
                      }}
                    />
                  </span>
                  <span
                    className="ob-data ob-small"
                    style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {stage.leadCount.toLocaleString('en-IN')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {canViewLeads && (
        <Card>
          <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
            {t('dashboard.followUp.dueTitle')}
          </div>
          {followUps === null ? (
            <Skeleton height="var(--t-body-line)" />
          ) : followUps.length === 0 ? (
            <EmptyState
              title={t('dashboard.followUp.emptyTitle')}
              description={t('dashboard.followUp.emptyDescription')}
            />
          ) : (
            <div className="ob-lines">
              {followUps.map((lead) => (
                <FollowUpRow key={lead.id} lead={lead} onOpen={() => onOpenLead(lead.id)} />
              ))}
            </div>
          )}
        </Card>
      )}

      {canManagePanels && (
        <Card>
          <div className="ob-body-strong" style={{ marginBottom: 'var(--s-12)' }}>
            {t('nav.master.panels')}
            {!loading &&
              ` — ${t('dashboard.panels.subtitle', { connected, total: active.length })}`}
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
                      width: rem(6),
                      height: rem(6),
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
      )}
    </div>
  );
}

/** One due follow-up, as the Office draws it; the whole row opens the lead. */
function FollowUpRow({ lead, onOpen }: { lead: Lead; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="ob-line"
      style={{
        width: '100%',
        textAlign: 'left',
        background: 'none',
        border: 'none',
        borderTop: '1px solid var(--line)',
        cursor: 'pointer',
        font: 'inherit',
        color: 'inherit',
        paddingLeft: 0,
        paddingRight: 0,
      }}
      onClick={onOpen}
    >
      <span className="ob-line-body">
        <span className="ob-line-head">
          <span className="ob-mono ob-small">{lead.id}</span>
          <span className="ob-body-strong">{lead.partyName}</span>
        </span>
      </span>
      <span className="ob-line-figures" style={{ flexDirection: 'row', gap: 'var(--s-12)' }}>
        <span className="ob-small" style={{ color: 'var(--fg-secondary)' }}>
          {lead.stageName}
        </span>
      </span>
    </button>
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
