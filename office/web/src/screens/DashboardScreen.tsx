/**
 * Dashboard, rebuilt around the mockup in 07-UI-SPEC §9. Admin-tier people
 * land here; Office and Management land on Basic Home.
 *
 * Four stat tiles (`StatTile`), then two columns: the lead pipeline with its
 * per-stage bars beside recent activity, and follow-ups underneath the
 * pipeline. Every figure is derived from the panel's already-synced
 * `LocalView`, the same arithmetic the old screen used — only the arrangement
 * changed, so tiles are still gated by the permissions the sidebar uses to
 * hide their screens.
 *
 * Recent activity reads from the leads' and orders' own timelines: the Master
 * writes a system entry on every move, conversion and dispatch, and the
 * snapshot carries those timelines, so no new endpoint and no `/api/logs`
 * call is needed. A log-driven feed would be the spec's card 8, but `logs`
 * is Master-online-only on the Office panel — it must fail hard offline —
 * and the timelines already in memory answer the same question with the
 * panel's own offline entries included.
 *
 * The pipeline breakdown (`view.dashboard.pipelineBreakdown`) names the
 * stages and counts the leads in each.
 */

import type { Notice } from '@orderbook/shared';

import type { LocalView } from '../api';
import { todayForNotices } from '../noticeReads';
import {
  Card,
  DashboardTile,
  Donut,
  DrillCard,
  EmptyState,
  NoticeDashboardCard,
  RecordNumber,
  StageBars,
  Timeline,
  formatDateTime,
  recordNumberText,
  rem,
  t,
} from '@orderbook/ui';

type DashboardTab = 'leads' | 'orders' | 'conflicts' | 'parties' | 'products';

interface Props {
  view: LocalView;
  /** Whether the Master is out of reach — the figures are then a picture of the past. */
  linkDown: boolean;
  /** The footer's sync state and its words, so this card never says more than the footer does. */
  railState: 'synced' | 'syncing' | 'offline' | 'offlinePending' | 'conflict';
  syncLabel: string;
  onNavigate: (tab: DashboardTab) => void;
  onOpenLead: (id: string) => void;
  /** Print jobs waiting, from the Printroom; no tile when absent (neither Printroom right). */
  printPending?: number;
  /** Unread chat messages, from the Chatroom; no tile when absent (no `chat.use`). */
  chatUnread?: number;
  /** This person's notices with the reads made here counted; no card when absent (no `notices.view`). */
  notices?: Notice[];
  onOpenNotices?: () => void;
}

/** Local calendar date as `YYYY-MM-DD`, matching `Lead.followUpDate`'s format. */
function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Midnight on this week's Monday, local time. */
function startOfWeek(): Date {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

interface ActivityItem {
  id: string;
  text: string;
  when: string;
  sortKey: string;
  tone: 'ok' | 'offline' | 'default';
}

function describeActivity(
  view: LocalView,
  canViewLeads: boolean,
  canViewOrders: boolean,
): ActivityItem[] {
  const items: ActivityItem[] = [];

  if (canViewLeads) {
    for (const lead of view.leads) {
      const offline = !lead.sync.hlc;
      for (const entry of lead.timeline) {
        const tone = entry.kind === 'remark' ? 'default' : offline ? 'offline' : 'default';
        const when = entry.createdAt;
        if (entry.kind === 'remark') {
          // A typed note is somebody's words, not a stock fact — show whose.
          items.push({
            id: `lead-${lead.id}-${entry.id}`,
            text: entry.actorName ? `${entry.message} · ${entry.actorName}` : entry.message,
            when,
            sortKey: when,
            tone,
          });
          continue;
        }
        // `Converted to order OR…` is written by the convert path; anything else
        // is a stage move and reads as one. Either way the actor rides along,
        // the way the board's own history shows it.
        const match = /^Converted to order (\S+)\s*$/.exec(entry.message);
        const base = match?.[1]
          ? t('dashboard.activity.convertedOrder', {
              orderId: match[1],
              leadId: recordNumberText(lead),
            })
          : entry.message;
        items.push({
          id: `lead-${lead.id}-${entry.id}`,
          text: entry.actorName ? `${base} · ${entry.actorName}` : base,
          when,
          sortKey: when,
          tone,
        });
      }
      if (offline) {
        // The temporary id's head is the panel's device code — the only name
        // an offline lead's origin has until the Master promotes it.
        const device = lead.sync.temporaryId?.slice(0, 6) ?? lead.id.slice(0, 6);
        items.push({
          id: `lead-offline-${lead.id}`,
          text: t('dashboard.activity.leadSavedOffline', { device }),
          when: lead.createdAt,
          sortKey: lead.createdAt,
          tone: 'offline',
        });
      }
    }
  }

  if (canViewOrders) {
    for (const order of view.orders) {
      for (const entry of order.timeline) {
        if (entry.kind === 'remark') {
          items.push({
            id: `order-${order.id}-${entry.id}`,
            text: entry.actorName ? `${entry.message} · ${entry.actorName}` : entry.message,
            when: entry.createdAt,
            sortKey: entry.createdAt,
            tone: 'default',
          });
          continue;
        }
        // `Dispatched — …` is written by the dispatch path; a move into a
        // terminal stage reads the same way, with the stage named. The actor
        // rides along, the way the detail screens show it.
        const dispatch = /^Dispatched\b/.exec(entry.message);
        const moved = /^Moved from .* to (.+)\s*$/.exec(entry.message);
        const stage = dispatch
          ? (view.pipelines
              .find((pipeline) => pipeline.kind === 'order')
              ?.stages.find((candidate) => candidate.id === entry.toStageId)?.name ??
            order.stageName)
          : moved?.[1];
        const line =
          stage !== undefined
            ? t('dashboard.activity.orderReady', { orderId: recordNumberText(order), stage })
            : entry.message;
        items.push({
          id: `order-${order.id}-${entry.id}`,
          text: entry.actorName ? `${line} · ${entry.actorName}` : line,
          when: entry.createdAt,
          sortKey: entry.createdAt,
          tone: stage !== undefined ? 'ok' : 'default',
        });
      }
    }
  }

  return items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
}

export function DashboardScreen({
  view,
  linkDown,
  railState,
  syncLabel,
  onNavigate,
  onOpenLead,
  printPending,
  chatUnread,
  notices,
  onOpenNotices,
}: Props) {
  const canViewLeads = view.permissions.includes('leads.view');
  const canViewOrders = view.permissions.includes('orders.view');
  const canViewConflicts = view.permissions.includes('sync.resolveConflicts');
  // Notices are not records: a company with no leads or orders yet still gets them.
  const noticeCard =
    notices && onOpenNotices ? (
      <NoticeDashboardCard notices={notices} today={todayForNotices()} onOpen={onOpenNotices} />
    ) : null;
  const nothingYet = view.leads.length === 0 && view.orders.length === 0;
  if (nothingYet) {
    return (
      <div
        className="ob-measure-wide"
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}
      >
        {noticeCard}
        <EmptyState
          title={t('dashboard.empty.title')}
          description={t('dashboard.empty.description')}
        />
      </div>
    );
  }

  const today = todayIso();
  const weekStart = startOfWeek();

  const openLeads = view.leads.filter((lead) => !lead.convertedOrderId);
  const dueToday = openLeads.filter((lead) => lead.followUpDate === today).length;
  // Everything whose date has arrived, not only today's: a follow-up missed on
  // Friday is still owed on Monday, and a card that quietly forgets it is worse
  // than no card at all.
  const followUpsDue = openLeads.filter(
    (lead) => lead.followUpDate !== null && lead.followUpDate <= today,
  );

  const openOrders = view.orders.filter((order) => !order.dispatchedAt);
  const boxesOpen = openOrders.reduce(
    (sum, order) => sum + order.items.reduce((s, item) => s + item.quantity, 0),
    0,
  );

  const dispatchedThisWeek = view.orders.filter(
    (order) => order.dispatchedAt !== null && new Date(order.dispatchedAt) >= weekStart,
  );
  const dispatchedPieces = dispatchedThisWeek.reduce(
    (sum, order) => sum + order.items.reduce((s, item) => s + item.quantity, 0),
    0,
  );
  const dispatchedUnit =
    dispatchedThisWeek.length === 1
      ? t('dashboard.dispatched.unitOne')
      : t('dashboard.dispatched.unitMany');

  const openConflicts = view.conflicts.filter((conflict) => !conflict.resolvedAt).length;
  const pendingCount = view.pendingCount;

  /*
   * Follows the footer: offline is offline, and catching up after a reconnect
   * is not yet synced. Read off the local queue alone, this card said "All
   * synced" with the Master out of reach and nothing queued.
   */
  const offline = railState === 'offline' || railState === 'offlinePending';
  const syncValue =
    openConflicts > 0
      ? t('dashboard.sync.toReview', { count: openConflicts })
      : offline
        ? syncLabel
        : pendingCount > 0
          ? t('dashboard.sync.pending', { count: pendingCount })
          : railState === 'syncing'
            ? syncLabel
            : t('dashboard.sync.allSynced');
  const syncNote =
    openConflicts > 0
      ? t('dashboard.sync.conflictNote')
      : pendingCount > 0
        ? t('dashboard.sync.pendingNote')
        : offline || railState === 'syncing'
          ? null
          : t('dashboard.sync.allSyncedNote');
  const syncTone =
    openConflicts > 0 ? 'conflict' : offline || pendingCount > 0 ? 'offline' : undefined;

  // Already ordered by the Master, but the sequence is the contract, not the
  // array order.
  const stages = [...(view.dashboard?.pipelineBreakdown ?? [])].sort(
    (a, b) => a.sequence - b.sequence,
  );
  const stagedLeads = stages.reduce((sum, stage) => sum + stage.leadCount, 0);
  const asOf = view.dashboard?.asOf ?? null;

  const activity = describeActivity(view, canViewLeads, canViewOrders).slice(0, 5);

  return (
    <div
      className="ob-measure-wide"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}
    >
      {noticeCard}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fit, minmax(${rem(200)}, 1fr))`,
          gap: 'var(--s-12)',
        }}
      >
        {canViewLeads && (
          <DashboardTile
            icon="leads"
            accent="blue"
            label={t('dashboard.leads.title')}
            value={openLeads.length.toLocaleString('en-IN')}
            note={
              dueToday > 0
                ? t('dashboard.leads.dueToday', { count: dueToday })
                : t('dashboard.leads.noneDueToday')
            }
            trend={openLeads.slice(0, 12).map((_, index) => openLeads.length - index)}
            onClick={() => onNavigate('leads')}
          />
        )}

        {canViewOrders && (
          <DashboardTile
            icon="orders"
            accent="violet"
            label={t('dashboard.orders.title')}
            value={openOrders.length.toLocaleString('en-IN')}
            note={
              boxesOpen > 0
                ? t('dashboard.orders.boxesOpen', {
                    count: boxesOpen.toLocaleString('en-IN'),
                  })
                : t('dashboard.orders.noneOpen')
            }
            onClick={() => onNavigate('orders')}
          />
        )}

        {canViewOrders && (
          <DashboardTile
            icon="upload"
            accent="teal"
            label={t('dashboard.dispatched.title')}
            value={
              <>
                {dispatchedPieces.toLocaleString('en-IN')}{' '}
                <span className="ob-data" style={{ color: 'var(--fg-secondary)' }}>
                  {t('unit.pieces')}
                </span>
              </>
            }
            note={
              dispatchedThisWeek.length === 0
                ? t('dashboard.dispatched.none')
                : t('dashboard.dispatched.countOnly', {
                    count: dispatchedThisWeek.length,
                    unit: dispatchedUnit,
                  })
            }
          />
        )}

        {printPending !== undefined && (
          <DashboardTile
            icon="print"
            accent="blue"
            label={t('dashboard.stat.printPending')}
            value={printPending.toLocaleString('en-IN')}
          />
        )}

        {chatUnread !== undefined && (
          <DashboardTile
            icon="chat"
            accent="violet"
            label={t('dashboard.stat.chatUnread')}
            value={chatUnread.toLocaleString('en-IN')}
          />
        )}

        <DashboardTile
          icon="sync"
          accent={syncTone === 'conflict' ? 'red' : syncTone === 'offline' ? 'amber' : 'green'}
          label={t('dashboard.sync.title')}
          value={syncValue}
          note={
            linkDown && asOf ? t('dashboard.asOf.stale', { when: formatDateTime(asOf) }) : syncNote
          }
          onClick={canViewConflicts ? () => onNavigate('conflicts') : undefined}
        />
      </div>

      <Donut
        title={t('dashboard.status.title')}
        total={(openLeads.length + openOrders.length).toLocaleString('en-IN')}
        slices={[
          ...(canViewLeads && openLeads.length > 0
            ? [{ id: 'leads', label: t('dashboard.leads.title'), value: openLeads.length, color: 'var(--glaze-50)' }]
            : []),
          ...(canViewOrders && openOrders.length > 0
            ? [{ id: 'orders', label: t('dashboard.orders.title'), value: openOrders.length, color: '#6d4dbb' }]
            : []),
          ...(canViewOrders && dispatchedThisWeek.length > 0
            ? [{ id: 'dispatched', label: t('dashboard.dispatched.title'), value: dispatchedThisWeek.length, color: '#0f766e' }]
            : []),
        ]}
        onSelect={(id) => {
          if (id === 'leads') onNavigate('leads');
          else onNavigate('orders');
        }}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fit, minmax(${rem(320)}, 1fr))`,
          gap: 'var(--s-12)',
          alignItems: 'start',
        }}
      >
        {canViewLeads &&
          (stages.length === 0 || stagedLeads === 0 ? (
            <Card>
              <EmptyState
                title={t('dashboard.pipeline.emptyTitle')}
                description={t('dashboard.pipeline.emptyDescription')}
              />
            </Card>
          ) : (
            <StageBars
              title={t('dashboard.pipeline.title')}
              stages={stages.map((stage) => ({ id: stage.stageId, label: stage.stageName, count: stage.leadCount }))}
              onOpen={() => onNavigate('leads')}
            />
          ))}

        <Card>
          <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
            {t('dashboard.activity.title')}
          </div>
          {activity.length === 0 ? (
            <EmptyState
              title={t('dashboard.activity.emptyTitle')}
              description={t('dashboard.activity.emptyDescription')}
            />
          ) : (
            <Timeline
              entries={activity.map((item) => ({
                id: item.id,
                label: item.text,
                when: item.when === item.sortKey ? formatRelativeDay(item.when) : item.when,
                tone: item.tone,
              }))}
            />
          )}
        </Card>
      </div>

      {canViewLeads && (
        <DrillCard
          title={t('dashboard.followUp.title')}
          rows={followUpsDue.slice(0, 8).map((lead) => ({
            id: lead.id,
            title: (
              <>
                <RecordNumber record={lead} small /> {lead.partyName}
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
      )}

      {/* An offline panel is showing the past. Say so, rather than letting the
          figures pass for current. */}
      {asOf && (
        <div className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
          {linkDown
            ? t('dashboard.asOf.stale', { when: formatDateTime(asOf) })
            : t('dashboard.asOf', { when: formatDateTime(asOf) })}
        </div>
      )}
    </div>
  );
}

/** "Today 11:45" for this week's entries, the full timestamp otherwise. */
function formatRelativeDay(iso: string): string {
  const when = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWhen = new Date(when.getFullYear(), when.getMonth(), when.getDate());
  const daysAgo = Math.round((startOfToday.getTime() - startOfWhen.getTime()) / 86_400_000);
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (daysAgo <= 0) return t('dashboard.activity.today', { time });
  if (daysAgo === 1) return t('dashboard.activity.yesterday', { time });
  return formatDateTime(iso);
}
