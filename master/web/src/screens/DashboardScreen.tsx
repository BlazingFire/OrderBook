/**
 * The Master's dashboard: a row of figures, then the stage bars, the due
 * follow-ups and the Office panels.
 *
 * Every figure comes from `DashboardSummary`, which the server builds per
 * person and leaves a figure **out** of when they hold none of the keys behind
 * it (`dashboard.service.ts`). A tile therefore draws only when its figure is
 * there - `0` would be a claim about data this person may not see. The panel
 * tiles and list are `panels.manage`, the Office panels being that module's.
 * Counts only: this software carries no money anywhere.
 *
 * "Offline over an hour" is worked out here from the panel list, so a panel
 * that dropped off a minute ago and is reconnecting does not count. Print jobs
 * waiting and unread messages come in as props from the screens that own
 * them, and draw only when given.
 *
 * The follow-ups list is one small read (`leads.view` only, refetched when a
 * lead changes), and a row opens that lead.
 */

import { useEffect, useState } from 'react';
import type { DashboardSummary, Lead, OfficePanelWithPresence } from '@orderbook/shared';

import { api } from '../api';
import {
  Button,
  Card,
  EmptyState,
  Skeleton,
  StatTile,
  StatTileSkeleton,
  rem,
  t,
} from '@orderbook/ui';

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
  /** Print jobs waiting, from the Printroom; no tile when absent. */
  printPending?: number;
  /** Unread chat messages, from the Chatroom; no tile when absent. */
  chatUnread?: number;
}

export function DashboardScreen({
  summary,
  panels,
  canManagePanels,
  canViewLeads,
  revision,
  onNavigate,
  onOpenLead,
  printPending,
  chatUnread,
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
  const leadCount = summary?.leadCount;
  const dueCount = summary?.followUpsDueCount;
  const openOrderCount = summary?.openOrderCount;
  const convertedToday = summary?.convertedTodayCount;
  const dispatchedToday = summary?.dispatchedTodayCount;
  const dispatchedCount = summary?.dispatchedThisWeekCount;
  const stages = [...(summary?.pipelineBreakdown ?? [])].sort((a, b) => a.sequence - b.sequence);
  const stagedLeads = stages.reduce((sum, stage) => sum + stage.leadCount, 0);
  const pipelineMax = Math.max(1, ...stages.map((stage) => stage.leadCount));
  const count = (value: number) => value.toLocaleString('en-IN');

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
            <StatTileSkeleton />
            <StatTileSkeleton />
            <StatTileSkeleton />
            <StatTileSkeleton />
            <StatTileSkeleton />
          </>
        ) : (
          <>
            {leadCount !== undefined && (
              <StatTile
                icon="leads"
                label={t('dashboard.leads.title')}
                value={count(leadCount)}
                note={
                  (dueCount ?? 0) > 0
                    ? t('dashboard.leads.due', { count: dueCount ?? 0 })
                    : t('dashboard.leads.noneDue')
                }
                onClick={() => onNavigate('leads')}
              />
            )}
            {convertedToday !== undefined && (
              <StatTile
                icon="check"
                label={t('dashboard.stat.convertedToday')}
                value={count(convertedToday)}
                note={t('dashboard.stat.convertedToday.note')}
                onClick={() => onNavigate('orders')}
              />
            )}
            {dispatchedToday !== undefined && (
              <StatTile
                icon="upload"
                label={t('dashboard.stat.dispatchedToday')}
                value={count(dispatchedToday)}
                note={t('dashboard.stat.dispatchedToday.note')}
              />
            )}
            {dueCount !== undefined && (
              <StatTile
                icon="calendar"
                label={t('dashboard.stat.followUpsDue')}
                value={count(dueCount)}
                note={t('dashboard.stat.followUpsDue.note')}
                onClick={() => onNavigate('leads')}
              />
            )}
            {canManagePanels && (
              <StatTile
                icon="server"
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
            {openOrderCount !== undefined && (
              <StatTile
                icon="orders"
                label={t('dashboard.orders.title')}
                value={count(openOrderCount)}
                onClick={() => onNavigate('orders')}
              />
            )}
            {dispatchedCount !== undefined && (
              <StatTile
                icon="upload"
                label={t('dashboard.dispatched.title')}
                value={count(dispatchedCount)}
                note={
                  dispatchedCount === 0
                    ? t('dashboard.dispatched.none')
                    : dispatchedCount === 1
                      ? t('dashboard.dispatched.unitOne')
                      : t('dashboard.dispatched.unitMany')
                }
              />
            )}
            {conflictCount !== undefined && (
              <StatTile
                icon="conflicts"
                label={t('dashboard.stat.conflicts')}
                value={count(conflictCount)}
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
              <StatTile
                icon="sync"
                label={t('dashboard.stat.pendingSync')}
                value={count(pendingCount)}
                note={t('dashboard.stat.pendingSync.note')}
                tone={pendingCount > 0 ? 'offline' : undefined}
              />
            )}
            {printPending !== undefined && (
              <StatTile label={t('dashboard.stat.printPending')} value={count(printPending)} />
            )}
            {chatUnread !== undefined && (
              <StatTile label={t('dashboard.stat.chatUnread')} value={count(chatUnread)} />
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
