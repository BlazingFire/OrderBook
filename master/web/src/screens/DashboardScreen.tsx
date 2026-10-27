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
import { isLongOffline } from '@orderbook/shared';
import type { DashboardSummary, Lead, Notice, OfficePanelWithPresence } from '@orderbook/shared';

import { api } from '../api';
import { todayForNotices } from '../noticeToday';
import {
  Card,
  DashboardTile,
  Donut,
  DrillCard,
  EmptyState,
  NoticeDashboardCard,
  Skeleton,
  rem,
  StageBars,
  StatTileSkeleton,
  recordNumberText,
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
  onNavigate: (target: 'leads' | 'orders' | 'conflicts' | 'panels' | 'notices') => void;
  /** `notices.view`: the card of important and pinned notices; asked for nothing without it. */
  canViewNotices?: boolean;
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
  canViewNotices,
  onOpenLead,
  printPending,
  chatUnread,
}: Props) {
  const connected = panels.filter((panel) => panel.isConnected).length;
  const active = panels.filter((panel) => panel.status === 'active');
  const loading = summary === null;
  const offlineCount = active.length - connected;
  // Read at render: the panels list re-arrives on every connect and disconnect.
  const longOfflineCount = panels.filter((panel) => isLongOffline(panel, Date.now())).length;

  // The notices worth seeing at a glance; the card draws nothing when there are none.
  const [notices, setNotices] = useState<Notice[]>([]);
  useEffect(() => {
    if (!canViewNotices) return;
    let cancelled = false;
    void api
      .notices()
      .then((board) => {
        if (!cancelled) setNotices(board.notices);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canViewNotices, revision]);

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
  const count = (value: number) => value.toLocaleString('en-IN');
  const donutSlices = [
    leadCount !== undefined ? { id: 'pending', label: t('dashboard.leads.title'), value: leadCount, color: 'var(--glaze-50)' } : null,
    openOrderCount !== undefined ? { id: 'orders', label: t('dashboard.orders.title'), value: openOrderCount, color: '#6d4dbb' } : null,
    dispatchedToday !== undefined ? { id: 'dispatched', label: t('dashboard.stat.dispatchedToday'), value: dispatchedToday, color: '#0f766e' } : null,
    conflictCount !== undefined ? { id: 'conflicts', label: t('dashboard.stat.conflicts'), value: conflictCount, color: 'var(--kiln-red)' } : null,
  ].filter((slice): slice is { id: string; label: string; value: number; color: string } => slice !== null && slice.value > 0);

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
              <DashboardTile
                icon="leads"
                accent="blue"
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
              <DashboardTile
                icon="check"
                accent="green"
                label={t('dashboard.stat.convertedToday')}
                value={count(convertedToday)}
                note={t('dashboard.stat.convertedToday.note')}
                onClick={() => onNavigate('orders')}
              />
            )}
            {dispatchedToday !== undefined && (
              <DashboardTile
                icon="upload"
                accent="teal"
                label={t('dashboard.stat.dispatchedToday')}
                value={count(dispatchedToday)}
                note={t('dashboard.stat.dispatchedToday.note')}
              />
            )}
            {dueCount !== undefined && (
              <DashboardTile
                icon="calendar"
                accent="amber"
                label={t('dashboard.stat.followUpsDue')}
                value={count(dueCount)}
                note={t('dashboard.stat.followUpsDue.note')}
                onClick={() => onNavigate('leads')}
              />
            )}
            {canManagePanels && (
              <DashboardTile
                icon="server"
                accent={active.length > 0 && offlineCount > 0 ? 'amber' : 'blue'}
                label={t('dashboard.stat.panelsOnline')}
                value={`${connected} / ${active.length}`}
                note={
                  active.length === 0
                    ? t('dashboard.stat.panelsOnline.noteNone')
                    : offlineCount === 0
                      ? t('dashboard.stat.panelsOnline.noteAll')
                      : t('dashboard.stat.panelsOnline.noteSome', { count: offlineCount })
                }
              />
            )}
            {canManagePanels && (
              <DashboardTile
                icon="warning"
                accent="red"
                label={t('dashboard.stat.panelsOfflineLong')}
                value={count(longOfflineCount)}
                note={
                  longOfflineCount === 0
                    ? t('dashboard.stat.panelsOfflineLong.noteNone')
                    : t('dashboard.stat.panelsOfflineLong.noteSome')
                }
                onClick={longOfflineCount > 0 ? () => onNavigate('panels') : undefined}
              />
            )}
            {openOrderCount !== undefined && (
              <DashboardTile
                icon="orders"
                accent="violet"
                label={t('dashboard.orders.title')}
                value={count(openOrderCount)}
                onClick={() => onNavigate('orders')}
              />
            )}
            {dispatchedCount !== undefined && (
              <DashboardTile
                icon="upload"
                accent="teal"
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
              <DashboardTile
                icon="conflicts"
                accent="red"
                label={t('dashboard.stat.conflicts')}
                value={count(conflictCount)}
                note={
                  conflictCount > 0
                    ? t('dashboard.stat.conflicts.noteSome')
                    : t('dashboard.stat.conflicts.noteNone')
                }
                onClick={conflictCount > 0 ? () => onNavigate('conflicts') : undefined}
              />
            )}
            {pendingCount !== undefined && (
              <DashboardTile
                icon="sync"
                accent="amber"
                label={t('dashboard.stat.pendingSync')}
                value={count(pendingCount)}
                note={t('dashboard.stat.pendingSync.note')}
              />
            )}
            {printPending !== undefined && (
              <DashboardTile
                icon="print"
                accent="blue"
                label={t('dashboard.stat.printPending')}
                value={count(printPending)}
              />
            )}
            {chatUnread !== undefined && (
              <DashboardTile
                icon="chat"
                accent="violet"
                label={t('dashboard.stat.chatUnread')}
                value={count(chatUnread)}
              />
            )}
          </>
        )}
      </div>

      {!loading && summary?.pipelineBreakdown && (
        <>
          <StageBars
            title={t('dashboard.pipeline.title')}
            stages={stages.map((stage) => ({
              id: stage.stageId,
              label: stage.stageName,
              count: stage.leadCount,
              color: stage.colourHex || undefined,
            }))}
            onOpen={() => onNavigate('leads')}
          />
          {(stages.length === 0 || stagedLeads === 0) && (
            <Card>
              <EmptyState
                title={t('dashboard.pipeline.emptyTitle')}
                description={t('dashboard.pipeline.emptyDescription')}
              />
            </Card>
          )}
          {donutSlices.length > 0 && (leadCount !== undefined || openOrderCount !== undefined) && (
            <Donut
              title={t('dashboard.status.title')}
              total={count((leadCount ?? 0) + (openOrderCount ?? 0))}
              slices={donutSlices}
              onSelect={(id) => {
                if (id === 'pending') onNavigate('leads');
                else if (id === 'orders' || id === 'dispatched') onNavigate('orders');
                else if (id === 'conflicts') onNavigate('conflicts');
              }}
            />
          )}
        </>
      )}

      {canViewNotices && <NoticeDashboardCard notices={notices} today={todayForNotices()} onOpen={() => onNavigate('notices')} />}

      {canViewLeads &&
        (followUps === null ? (
          <Card>
            <Skeleton height="var(--t-body-line)" />
          </Card>
        ) : (
          <DrillCard
            title={t('dashboard.followUp.dueTitle')}
            rows={followUps.map((lead) => ({
              id: lead.id,
              title: (
                <>
                  <span className="ob-mono ob-small">{recordNumberText(lead)} · </span>
                  {lead.partyName}
                </>
              ),
              meta: lead.stageName,
            }))}
            empty={{
              title: t('dashboard.followUp.emptyTitle'),
              description: t('dashboard.followUp.emptyDescription'),
            }}
            onOpen={(id) => onOpenLead(id)}
          />
        ))}

      {canManagePanels &&
        (loading ? (
          <Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
              <Skeleton height="var(--t-body-line)" />
              <Skeleton height="var(--t-body-line)" width="70%" />
            </div>
          </Card>
        ) : (
          <DrillCard
            title={
              active.length === 0
                ? t('nav.master.panels')
                : `${t('nav.master.panels')} — ${t('dashboard.panels.subtitle', { connected, total: active.length })}`
            }
            rows={active.map((panel) => ({
              id: panel.id,
              title: panel.name,
              meta: `${panel.lanIp ?? t('dashboard.panels.addressUnknown')} · ${t('dashboard.panels.deviceLabel', { code: panel.deviceCode })}`,
              badge: (
                <span
                  aria-hidden="true"
                  style={{
                    width: '0.5rem',
                    height: '0.5rem',
                    borderRadius: '50%',
                    flex: 'none',
                    background: panel.isConnected ? 'var(--state-ok)' : 'var(--line-strong)',
                  }}
                />
              ),
            }))}
            empty={{
              title: t('dashboard.panels.empty.title'),
              description: t('dashboard.panels.empty.description'),
            }}
            onOpen={() => onNavigate('panels')}
          />
        ))}
    </div>
  );
}
