/**
 * Dashboard — the landing screen, rebuilt around the mockup in 07-UI-SPEC §9.
 *
 * Four stat cards, then two columns: the lead pipeline with its per-stage
 * bars beside recent activity, and follow-ups underneath the pipeline. Every
 * figure is derived from the panel's already-synced `LocalView`, the same
 * arithmetic the old screen used — only the arrangement changed, so cards are
 * still gated by the permissions the sidebar uses to hide their screens.
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

import type { ReactNode } from 'react';
import type { Lead } from '@orderbook/shared';

import type { LocalView } from '../api';
import {
  Card,
  EmptyState,
  Timeline,
  formatDateTime,
  rem,
  t,
} from '@orderbook/ui';

type DashboardTab = 'leads' | 'orders' | 'conflicts' | 'parties' | 'products';

interface Props {
  view: LocalView;
  /** Whether the Master is out of reach — the figures are then a picture of the past. */
  linkDown: boolean;
  onNavigate: (tab: DashboardTab) => void;
  onOpenLead: (id: string) => void;
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

function StatCard({
  label,
  value,
  valueColor,
  note,
  onClick,
  borderColor,
}: {
  label: string;
  value: ReactNode;
  valueColor?: string;
  note?: ReactNode;
  onClick?: () => void;
  borderColor?: string;
}) {
  const body = (
    <>
      <div className="ob-eyebrow">{label}</div>
      <div
        className="ob-display"
        style={{ marginTop: 'var(--s-6)', color: valueColor, fontVariantNumeric: 'tabular-nums' }}
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
        style={{ display: 'block', width: '100%', textAlign: 'left', borderColor }}
        onClick={onClick}
      >
        {body}
      </button>
    );
  }

  return <Card style={{ borderColor }}>{body}</Card>;
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
          ? t('dashboard.activity.convertedOrder', { orderId: match[1], leadId: lead.id })
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
          ? view.pipelines
              .find((pipeline) => pipeline.kind === 'order')
              ?.stages.find((candidate) => candidate.id === entry.toStageId)?.name ??
            order.stageName
          : moved?.[1];
        const line =
          stage !== undefined
            ? t('dashboard.activity.orderReady', { orderId: order.id, stage })
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

export function DashboardScreen({ view, linkDown, onNavigate, onOpenLead }: Props) {
  const canViewLeads = view.permissions.includes('leads.view');
  const canViewOrders = view.permissions.includes('orders.view');
  const canViewConflicts = view.permissions.includes('sync.resolveConflicts');
  const nothingYet = view.leads.length === 0 && view.orders.length === 0 && view.stock.length === 0;
  if (nothingYet) {
    return (
      <EmptyState
        title={t('dashboard.empty.title')}
        description={t('dashboard.empty.description')}
      />
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
  const boxesReserved = openOrders.reduce(
    (sum, order) =>
      sum +
      order.reservations
        .filter((reservation) => reservation.status === 'active')
        .reduce((s, reservation) => s + reservation.quantity, 0),
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

  const syncValue =
    openConflicts > 0
      ? t('dashboard.sync.toReview', { count: openConflicts })
      : pendingCount > 0
        ? t('dashboard.sync.pending', { count: pendingCount })
        : t('dashboard.sync.allSynced');
  const syncNote =
    openConflicts > 0
      ? t('dashboard.sync.conflictNote')
      : pendingCount > 0
        ? t('dashboard.sync.pendingNote')
        : t('dashboard.sync.allSyncedNote');
  const syncColor =
    openConflicts > 0
      ? 'var(--state-conflict)'
      : pendingCount > 0
        ? 'var(--state-offline)'
        : undefined;

  // Already ordered by the Master, but the sequence is the contract, not the
  // array order.
  const stages = [...(view.dashboard?.pipelineBreakdown ?? [])].sort(
    (a, b) => a.sequence - b.sequence,
  );
  const stagedLeads = stages.reduce((sum, stage) => sum + stage.leadCount, 0);
  const asOf = view.dashboard?.asOf ?? null;

  const pipelineMax = Math.max(1, ...stages.map((stage) => stage.leadCount));

  const activity = describeActivity(view, canViewLeads, canViewOrders).slice(0, 5);

  return (
    <div
      className="ob-measure-wide"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fit, minmax(${rem(200)}, 1fr))`,
          gap: 'var(--s-12)',
        }}
      >
        {canViewLeads && (
          <StatCard
            label={t('dashboard.leads.title')}
            value={openLeads.length.toLocaleString('en-IN')}
            note={
              dueToday > 0
                ? t('dashboard.leads.dueToday', { count: dueToday })
                : t('dashboard.leads.noneDueToday')
            }
            onClick={() => onNavigate('leads')}
          />
        )}

        {canViewOrders && (
          <StatCard
            label={t('dashboard.orders.title')}
            value={openOrders.length.toLocaleString('en-IN')}
            note={
              boxesReserved > 0
                ? t('dashboard.orders.boxesReserved', {
                    count: boxesReserved.toLocaleString('en-IN'),
                  })
                : t('dashboard.orders.noneReserved')
            }
            onClick={() => onNavigate('orders')}
          />
        )}

        {canViewOrders && (
          <StatCard
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

        <StatCard
          label={t('dashboard.sync.title')}
          value={syncValue}
          valueColor={syncColor}
          note={
            linkDown && asOf
              ? t('dashboard.asOf.stale', { when: formatDateTime(asOf) })
              : syncNote
          }
          borderColor={syncColor}
          onClick={canViewConflicts ? () => onNavigate('conflicts') : undefined}
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fit, minmax(${rem(320)}, 1fr))`,
          gap: 'var(--s-12)',
          alignItems: 'start',
        }}
      >
        {canViewLeads && (
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
              <div className="ob-eyebrow" style={{ flex: 1 }}>
                {t('dashboard.pipeline.title')}
              </div>
              <button className="ob-btn ob-btn--ghost" onClick={() => onNavigate('leads')}>
                {t('dashboard.pipeline.openBoard')}
              </button>
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
                      gridTemplateColumns: `${rem(88)} 1fr ${rem(24)} ${rem(96)}`,
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
        <Card>
          <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
            {t('dashboard.followUp.title')}
          </div>
          {followUpsDue.length === 0 ? (
            <EmptyState
              title={t('dashboard.followUp.emptyTitle')}
              description={t('dashboard.followUp.emptyDescription')}
            />
          ) : (
            <div className="ob-lines">
              {followUpsDue.slice(0, 8).map((lead) => (
                <FollowUpRow key={lead.id} lead={lead} onOpen={() => onOpenLead(lead.id)} />
              ))}
            </div>
          )}
        </Card>
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
