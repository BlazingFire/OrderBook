/**
 * Dashboard (6-UI-DESIGN.md, Dashboard.dc.html) — the landing screen.
 *
 * Built entirely from the panel's already-synced `LocalView`: no new endpoint
 * and no aggregate the Master doesn't already send. Every figure here is
 * something another screen in this panel already shows in full — this is
 * just the first thing a person sees when they open the panel, so cards are
 * gated by the same permissions the sidebar uses to hide those screens.
 */

import type { ReactNode } from 'react';

import type { LocalView } from '../api';
import { Card, EmptyState, formatMoney, t } from '@orderbook/ui';

type DashboardTab = 'leads' | 'orders' | 'conflicts';

interface Props {
  view: LocalView;
  onNavigate: (tab: DashboardTab) => void;
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

export function DashboardScreen({ view, onNavigate }: Props) {
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
  const dispatchedBoxes = dispatchedThisWeek.reduce(
    (sum, order) => sum + order.items.reduce((s, item) => s + item.totalQuantity, 0),
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

  return (
    <div
      className="ob-measure-wide"
      style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--s-12)' }}
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
              {dispatchedBoxes.toLocaleString('en-IN')}{' '}
              <span className="ob-data" style={{ color: 'var(--fg-secondary)' }}>
                {t('unit.boxes')}
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

      <StatCard
        label={t('dashboard.sync.title')}
        value={syncValue}
        valueColor={syncColor}
        note={syncNote}
        borderColor={syncColor}
        onClick={canViewConflicts ? () => onNavigate('conflicts') : undefined}
      />
    </div>
  );
}
