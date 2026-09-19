/**
 * Dashboard (6-UI-DESIGN.md, Dashboard.dc.html) — the landing screen.
 *
 * Built entirely from the panel's already-synced `LocalView`: no new endpoint
 * and no aggregate the Master doesn't already send. Every figure here is
 * something another screen in this panel already shows in full — this is
 * just the first thing a person sees when they open the panel, so cards are
 * gated by the same permissions the sidebar uses to hide those screens.
 *
 * The counters are derived from the snapshot rather than read off
 * `view.dashboard`, deliberately: the snapshot is patched in place by the
 * `change` SSE frames, so it is *fresher* than that summary, which only moves
 * on a whole-snapshot push. Two numbers for one figure on one screen is worse
 * than a little arithmetic. What the summary is used for is what this panel
 * cannot derive — the stage breakdown with its names, order and colours, and
 * the `asOf` stamp that lets an offline panel say how old its figures are.
 *
 * The two panes at the bottom are the shortcut the screen exists for: the open
 * leads and open orders somebody would otherwise navigate to, with a row click
 * opening that record's own sub-screen directly.
 */

import type { ReactNode } from 'react';
import type { Lead, Order } from '@orderbook/shared';

import type { LocalView } from '../api';
import {
  Card,
  DataTable,
  EmptyState,
  InsightCards,
  Section,
  formatDateTime,
  formatMoney,
  rem,
  t,
  type DataTableColumn,
} from '@orderbook/ui';

import { api } from '../api';

type DashboardTab = 'leads' | 'orders' | 'conflicts' | 'parties' | 'products';

interface Props {
  view: LocalView;
  /** Whether the Master is out of reach — the figures are then a picture of the past. */
  linkDown: boolean;
  onNavigate: (tab: DashboardTab) => void;
  onOpenLead: (id: string) => void;
  onOpenOrder: (id: string) => void;
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

/** Newest first, on a copy — `view.leads` and `view.orders` are the live snapshot. */
function newestFirst<T extends { updatedAt: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * How many rows a pane shows.
 *
 * Well under `DataTable`'s virtualization threshold on purpose: above it the
 * table measures the nearest `.ob-pane` as its scroller, which inside a
 * half-width card is the wrong element. Raising this past ~50 means checking
 * that path first.
 */
const PANE_ROWS = 8;

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

export function DashboardScreen({ view, linkDown, onNavigate, onOpenLead, onOpenOrder }: Props) {
  const canViewLeads = view.permissions.includes('leads.view');
  const canViewOrders = view.permissions.includes('orders.view');
  const canViewParties = view.permissions.includes('parties.view');
  const canViewProducts = view.permissions.includes('products.view');
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
  ).length;

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
  // `totalAmount` is absent, not null, on every order alike when the role
  // lacks `field.saleRate.view` (§9.1) — treat that as "cannot be summed",
  // never as zero.
  const dispatchedAmount = dispatchedThisWeek.some((order) => order.totalAmount === undefined)
    ? undefined
    : dispatchedThisWeek.reduce((sum, order) => sum + (order.totalAmount ?? 0), 0);
  const dispatchedUnit =
    dispatchedThisWeek.length === 1
      ? t('dashboard.dispatched.unitOne')
      : t('dashboard.dispatched.unitMany');

  const lowStock = view.stock.filter((level) => level.isLow).length;

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

  const leadColumns: DataTableColumn<Lead>[] = [
    { key: 'party', header: t('lead.list.col.party'), render: (lead) => lead.partyName },
    {
      key: 'stage',
      header: t('lead.list.col.stage'),
      width: rem(104),
      priority: 2,
      render: (lead) => <span className="ob-small">{lead.stageName}</span>,
    },
    {
      key: 'followUp',
      header: t('lead.list.col.followUp'),
      width: rem(96),
      priority: 3,
      render: (lead) => (
        <span
          className="ob-small"
          style={{
            color:
              lead.followUpDate !== null && lead.followUpDate <= today
                ? 'var(--state-conflict)'
                : undefined,
          }}
        >
          {lead.followUpDate ?? '—'}
        </span>
      ),
    },
    {
      key: 'amount',
      header: t('lead.list.col.amount'),
      width: rem(96),
      align: 'right',
      render: (lead) => formatMoney(lead.totalAmount ?? null),
      redactedReason: (lead) =>
        lead.totalAmount === undefined ? 'field.saleRate.view' : undefined,
    },
  ];

  const orderColumns: DataTableColumn<Order>[] = [
    { key: 'party', header: t('orders.column.party'), render: (order) => order.partyName },
    {
      key: 'stage',
      header: t('orders.column.stage'),
      width: rem(104),
      priority: 2,
      render: (order) => <span className="ob-small">{order.stageName}</span>,
    },
    {
      key: 'qty',
      header: t('orders.column.qty'),
      width: rem(72),
      align: 'right',
      priority: 3,
      render: (order) =>
        order.items.reduce((sum, item) => sum + item.quantity, 0).toLocaleString('en-IN'),
    },
    {
      key: 'amount',
      header: t('orders.column.amount'),
      width: rem(96),
      align: 'right',
      render: (order) => formatMoney(order.totalAmount ?? null),
      redactedReason: (order) =>
        order.totalAmount === undefined ? 'field.saleRate.view' : undefined,
    },
  ];

  return (
    <div
      className="ob-measure-wide"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}
    >
      {/* Nothing at all on a quiet day, and the figures on it are SQL rather
          than anything a model produced. */}
      <InsightCards load={api.aiInsights} />

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

        {canViewLeads && (
          <StatCard
            label={t('dashboard.stat.followUpsDue')}
            value={followUpsDue.toLocaleString('en-IN')}
            valueColor={followUpsDue > 0 ? 'var(--state-conflict)' : undefined}
            note={
              followUpsDue > 0
                ? t('dashboard.stat.followUpsDue.noteSome')
                : t('dashboard.stat.followUpsDue.noteNone')
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
                : dispatchedAmount === undefined
                  ? t('dashboard.dispatched.countOnly', {
                      count: dispatchedThisWeek.length,
                      unit: dispatchedUnit,
                    })
                  : t('dashboard.dispatched.summary', {
                      amount: formatMoney(dispatchedAmount),
                      count: dispatchedThisWeek.length,
                      unit: dispatchedUnit,
                    })
            }
          />
        )}

        {/* Absent, not zero, for a role that cannot see stock at all: the
            snapshot simply carries no levels for them, and "0 low" would be a
            claim about the business rather than about the reader. */}
        {canViewProducts && view.stock.length > 0 && (
          <StatCard
            label={t('dashboard.stat.lowStock')}
            value={lowStock.toLocaleString('en-IN')}
            valueColor={lowStock > 0 ? 'var(--state-offline)' : undefined}
            note={
              lowStock > 0
                ? t('dashboard.stat.lowStock.noteSome')
                : t('dashboard.stat.lowStock.noteNone')
            }
            onClick={() => onNavigate('products')}
          />
        )}

        {canViewParties && (
          <StatCard
            label={t('nav.parties')}
            value={view.parties.length.toLocaleString('en-IN')}
            note={t('dashboard.stat.parties.note')}
            onClick={() => onNavigate('parties')}
          />
        )}

        {canViewProducts && (
          <StatCard
            label={t('nav.products')}
            value={view.products.length.toLocaleString('en-IN')}
            // The snapshot holds one page of a large catalogue, so this is the
            // working set rather than the count — say which.
            note={
              view.productsComplete
                ? t('dashboard.stat.products.note')
                : t('dashboard.stat.products.partial')
            }
            onClick={() => onNavigate('products')}
          />
        )}

        <StatCard
          label={t('dashboard.sync.title')}
          value={syncValue}
          valueColor={syncColor}
          note={syncNote}
          borderColor={syncColor}
          onClick={canViewConflicts ? () => onNavigate('conflicts') : undefined}
        />
      </div>

      {/* The one figure this panel cannot derive: stage names, their order and
          their colours, over leads the snapshot may not carry. */}
      {canViewLeads && stages.length > 0 && (
        <Card>
          <Section title={t('dashboard.pipeline.title')}>
            <div
              style={{
                display: 'flex',
                height: rem(8),
                borderRadius: 'var(--r-md)',
                overflow: 'hidden',
                background: 'var(--bg-sunken)',
              }}
            >
              {stagedLeads > 0 &&
                stages.map((stage) => (
                  <div
                    key={stage.stageId}
                    style={{
                      flex: stage.leadCount,
                      background: stage.colourHex ?? 'var(--line-strong)',
                    }}
                    title={`${stage.stageName} · ${stage.leadCount}`}
                  />
                ))}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-8) var(--s-16)' }}>
              {stages.map((stage) => (
                <span
                  key={stage.stageId}
                  className="ob-small"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-6)' }}
                >
                  <span
                    style={{
                      width: rem(8),
                      height: rem(8),
                      borderRadius: '50%',
                      background: stage.colourHex ?? 'var(--line-strong)',
                    }}
                  />
                  {stage.stageName}
                  <span style={{ color: 'var(--fg-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                    {stage.leadCount.toLocaleString('en-IN')}
                  </span>
                </span>
              ))}
            </div>
          </Section>
        </Card>
      )}

      {/* Half and half — and one full-width pane rather than a dangling gap for
          a role holding only one of the two permissions. */}
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
            <Section
              title={t('dashboard.leads.title')}
              action={
                <button className="ob-btn ob-btn--ghost" onClick={() => onNavigate('leads')}>
                  {t('dashboard.pane.viewAll')}
                </button>
              }
            >
              <DataTable
                columns={leadColumns}
                rows={newestFirst(openLeads).slice(0, PANE_ROWS)}
                rowKey={(lead) => lead.id}
                onRowOpen={(lead) => onOpenLead(lead.id)}
                openOn="click"
                empty={<EmptyState title={t('dashboard.pane.leads.empty')} />}
              />
            </Section>
          </Card>
        )}

        {canViewOrders && (
          <Card>
            <Section
              title={t('dashboard.orders.title')}
              action={
                <button className="ob-btn ob-btn--ghost" onClick={() => onNavigate('orders')}>
                  {t('dashboard.pane.viewAll')}
                </button>
              }
            >
              <DataTable
                columns={orderColumns}
                rows={newestFirst(openOrders).slice(0, PANE_ROWS)}
                rowKey={(order) => order.id}
                onRowOpen={(order) => onOpenOrder(order.id)}
                openOn="click"
                empty={<EmptyState title={t('dashboard.pane.orders.empty')} />}
              />
            </Section>
          </Card>
        )}
      </div>

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
