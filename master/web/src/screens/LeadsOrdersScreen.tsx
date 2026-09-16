/**
 * The owner's view of every lead and order.
 *
 * Leads are raised on the Office Panels and, since the hierarchy flow, on the
 * Master itself under Leads & orders › New lead. What the owner can do here is
 * progress a record, convert a lead, and dispatch an order — the decisions
 * that belong to whoever is watching the whole board.
 *
 * **Delete lives here too**, under `leads.delete` / `orders.delete`. The routes
 * and the permissions shipped long ago; `api.deleteLead` and `api.deleteOrder`
 * simply had no caller in either panel, so four of the Recycle Bin's nine
 * entity types could never reach the bin in the first place. A delete is soft —
 * the record goes to the Recycle Bin and can be restored — and the server
 * refuses it with a 409 when something live still points at the record, which
 * is rendered as the reason rather than as a generic failure.
 */

import { useEffect, useState } from 'react';
import type { Lead, LineItem, Order, PartyScopeFilter, Pipeline } from '@orderbook/shared';

import { ApiError, api } from '../api';
import {
  Button,
  ConfirmDialog,
  ConflictBanner,
  DataTable,
  EmptyState,
  IconButton,
  Segmented,
  Select,
  SkeletonTable,
  StatusPill,
  Tabs,
  formatDateTime,
  formatMoney,
  rem,
  t,
  useFilterBar,
  type DataTableColumn,
  type TabItem,
} from '@orderbook/ui';

type View = 'leads' | 'orders' | 'converted';

interface Props {
  /** Bumped by the live socket whenever lead or order data changes. */
  revision: number;
  /** The signed-in caller's own resolved permissions. */
  permissions: string[];
  /** Which list is showing — chosen here or from the sidebar's sub-pages. */
  view: View;
  onViewChange: (view: View) => void;
}

/**
 * A table row is one line tall (`--row-h`) and clips what overflows, so a
 * record's lines are summarised onto that line with the full list on hover
 * rather than stacked into a height the cell does not have.
 *
 * The cell it renders into sits in a `1fr` grid track, so the summary is given
 * a zero flex basis: a `nowrap` run of text that keeps its intrinsic width
 * widens the track it is in, and since each row is its own grid, that row's
 * later columns would then stand out of line with every other row's.
 */
function summariseItems(items: LineItem[]): { text: string; title: string } {
  const lines = items.map((item) => {
    const colours = item.quantities.map((entry) => `${entry.colour} ×${entry.quantity}`).join(', ');
    const main = item.categoryName ? `${item.categoryName} › ` : '';
    const pack = item.packaging ? ` · ${item.packaging}` : '';
    const short = `${main}${item.productName} ×${item.totalQuantity}${pack}`;
    const full = [main + item.productName, colours || null, item.packaging, item.grade]
      .filter(Boolean)
      .join(' · ');
    return { short, full };
  });
  return { text: lines.map((line) => line.short).join(', '), title: lines.map((line) => line.full).join('\n') };
}

export function LeadsOrdersScreen({ revision, permissions, view, onViewChange }: Props) {
  // Off with the company's pricing switch, or without the role's key: no
  // Amount column at all, rather than one reading "—" top to bottom.
  const showMoney = permissions.includes('field.saleRate.view');
  /**
   * "All" is everything this person may see — which, for somebody without
   * `party.accessAll`, already excludes other people's parties, so it is never
   * a way around the scope. "My parties" narrows further to the parties they
   * are explicitly assigned to, hiding the unclaimed ones.
   */
  const [scope, setScope] = useState<PartyScopeFilter>('all');
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** The record a delete is being confirmed for, and which list it came from. */
  const [pendingDelete, setPendingDelete] = useState<{
    kind: 'lead' | 'order';
    id: string;
    label: string;
  } | null>(null);

  const canDeleteLeads = permissions.includes('leads.delete');
  const canDeleteOrders = permissions.includes('orders.delete');

  useEffect(() => {
    void api
      .pipelines()
      .then(setPipelines)
      .catch(() => setPipelines([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const load = async (): Promise<void> => {
      try {
        if (view === 'orders') {
          const page = await api.orders({ scope });
          if (!cancelled) setOrders(page.items);
        } else {
          const page = await api.leads({ includeConverted: view === 'converted', scope });
          if (!cancelled) {
            setLeads(
              view === 'converted'
                ? page.items.filter((lead) => lead.convertedOrderId)
                : page.items,
            );
          }
        }
      } catch (caught) {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : t('leadsOrders.error.load'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [view, scope, revision]);

  /**
   * A refused delete is usually not a failure to report as one. The server
   * answers 409 with `blockedBy` naming what still points at the record —
   * `live_reference` for a line item, `stock_on_hand` for reserved stock,
   * `dispatched` for an order already gone out — and the operator needs that,
   * not "could not delete".
   */
  function deleteFailureMessage(caught: unknown, fallback: string): string {
    if (caught instanceof ApiError && caught.isConflict) {
      const labels = caught.blockedBy
        .map((blocker) => (blocker as { label?: string }).label)
        .filter((label): label is string => Boolean(label));
      return labels.length > 0
        ? t('leadsOrders.delete.blocked', { items: labels.slice(0, 3).join(', ') })
        : t('error.conflict.blockedByLiveReferences');
    }
    return caught instanceof Error ? caught.message : fallback;
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    const { kind, id } = pendingDelete;

    setBusyId(id);
    setError(null);
    try {
      await (kind === 'lead' ? api.deleteLead(id) : api.deleteOrder(id));
      setPendingDelete(null);
      // The list is rebuilt from the server rather than spliced: a delete can
      // cascade, and a spliced list would show the cascade's other victims
      // until something else happened to refetch.
      if (kind === 'lead') setLeads((current) => current.filter((lead) => lead.id !== id));
      else setOrders((current) => current.filter((order) => order.id !== id));
    } catch (caught) {
      setError(deleteFailureMessage(caught, t('leadsOrders.delete.failed')));
      setPendingDelete(null);
    } finally {
      setBusyId(null);
    }
  }

  const leadStages = pipelines.find((pipeline) => pipeline.kind === 'lead')?.stages ?? [];
  const orderStages = pipelines.find((pipeline) => pipeline.kind === 'order')?.stages ?? [];

  async function run(id: string, action: () => Promise<unknown>, failure: string): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failure);
    } finally {
      setBusyId(null);
    }
  }

  /*
   * The scope toggle lives in the shell's filter strip, beside where the other
   * list filters go, rather than up beside the Tabs — it narrows the rows, which
   * is what that strip is for, and crowding it against the tab group made two
   * unrelated controls read as one segmented switch.
   */
  useFilterBar(
    <Segmented<PartyScopeFilter>
      value={scope}
      onChange={setScope}
      options={[
        { value: 'all', label: t('partyAccess.scope.all') },
        { value: 'assigned', label: t('partyAccess.scope.assigned') },
      ]}
    />,
  );

  const tabItems: TabItem[] = [
    { id: 'leads', label: t('leadsOrders.tab.leads') },
    { id: 'orders', label: t('leadsOrders.tab.orders') },
    { id: 'converted', label: t('leadsOrders.tab.converted') },
  ];

  const orderColumns: DataTableColumn<Order>[] = [
    {
      key: 'id',
      header: t('leadsOrders.orders.column.order'),
      width: rem(120),
      render: (order) => (
        <span className="ob-mono" style={{ color: 'var(--fg-secondary)' }}>
          {order.id}
        </span>
      ),
    },
    {
      key: 'party',
      header: t('leadsOrders.orders.column.party'),
      render: (order) => order.partyName,
    },
    {
      key: 'lead',
      header: t('leadsOrders.orders.column.fromLead'),
      width: rem(130),
      render: (order) =>
        order.leadId ? (
          <span className="ob-mono" style={{ color: 'var(--fg-tertiary)' }}>
            {order.leadId}
          </span>
        ) : (
          <span style={{ color: 'var(--fg-tertiary)' }}>—</span>
        ),
    },
    {
      key: 'products',
      header: t('leadsOrders.orders.column.products'),
      render: (order) => {
        const summary = summariseItems(order.items);
        return (
          <span
            className="ob-small"
            title={summary.title}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {summary.text}
          </span>
        );
      },
    },
    {
      key: 'weight',
      header: t('leadsOrders.orders.column.weight'),
      width: rem(110),
      align: 'right',
      // Same convention as the Office Panel's order board: a manually entered
      // weight is marked, because it is the one number here nobody derived.
      render: (order) => (
        <span
          title={order.weightSource === 'manual' ? t('leadsOrders.orders.weightManual') : undefined}
          style={{ color: order.weightSource === 'manual' ? 'var(--fg-secondary)' : undefined }}
        >
          {order.weightSource === 'manual'
            ? (order.totalWeightKgOverride ?? 0)
            : order.totalWeightKg}{' '}
          {t('leadsOrders.unit.kg')}
          {order.weightSource === 'manual' ? '*' : ''}
        </span>
      ),
    },
    ...(showMoney
      ? [
          {
            key: 'amount',
            header: t('leadsOrders.orders.column.amount'),
            width: rem(120),
            align: 'right',
            render: (order: Order) => formatMoney(order.totalAmount ?? null),
          } satisfies DataTableColumn<Order>,
        ]
      : []),
    {
      key: 'stage',
      header: t('leadsOrders.orders.column.stage'),
      width: rem(170),
      render: (order) => (
        <Select
          value={order.stageId}
          aria-label={t('leadsOrders.orders.column.stage')}
          disabled={busyId === order.id || Boolean(order.dispatchedAt)}
          onChange={(event) =>
            void run(
              order.id,
              () => api.setOrderStage(order.id, event.target.value),
              t('leadsOrders.error.moveOrder'),
            )
          }
        >
          {orderStages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </Select>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: rem(280),
      render: (order) => (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--s-8)',
            justifyContent: 'flex-end',
            width: '100%',
          }}
        >
          {order.dispatchedAt ? (
            <StatusPill tone="ok">
              {t('leadsOrders.orders.dispatched', { when: formatDateTime(order.dispatchedAt) })}
            </StatusPill>
          ) : (
            <Button
              variant="primary"
              size="sm"
              busy={busyId === order.id}
              onClick={() =>
                void run(
                  order.id,
                  () => api.dispatchOrder(order.id),
                  t('leadsOrders.error.dispatch'),
                )
              }
            >
              {t('leadsOrders.orders.dispatch')}
            </Button>
          )}
          {/* Absent, not greyed, without the permission — the house rule. */}
          {canDeleteOrders && (
            <IconButton
              icon="trash"
              label={t('leadsOrders.delete.order')}
              disabled={busyId === order.id}
              onClick={() =>
                setPendingDelete({ kind: 'order', id: order.id, label: order.id })
              }
            />
          )}
        </div>
      ),
    },
  ];

  const leadColumns: DataTableColumn<Lead>[] = [
    {
      key: 'id',
      header: t('leadsOrders.leads.column.lead'),
      width: rem(190),
      render: (lead) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-6)' }}>
          <span className="ob-mono" style={{ color: 'var(--fg-secondary)' }}>
            {lead.id}
          </span>
          {lead.incomplete && (
            <StatusPill tone="conflict">{t('leadsOrders.leads.incomplete')}</StatusPill>
          )}
        </span>
      ),
    },
    {
      key: 'party',
      header: t('leadsOrders.leads.column.party'),
      render: (lead) => lead.partyName,
    },
    {
      key: 'products',
      header: t('leadsOrders.leads.column.products'),
      render: (lead) => {
        const summary = summariseItems(lead.items);
        return (
          <span
            className="ob-small"
            title={summary.title}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {summary.text}
          </span>
        );
      },
    },
    ...(showMoney
      ? [
          {
            key: 'amount',
            header: t('leadsOrders.leads.column.amount'),
            width: rem(120),
            align: 'right',
            render: (lead: Lead) => formatMoney(lead.totalAmount ?? null),
          } satisfies DataTableColumn<Lead>,
        ]
      : []),
    {
      key: 'stage',
      header: t('leadsOrders.leads.column.stage'),
      width: rem(170),
      render: (lead) =>
        lead.convertedOrderId ? (
          <StatusPill tone="ok">{t('leadsOrders.leads.converted')}</StatusPill>
        ) : (
          <Select
            value={lead.stageId}
            aria-label={t('leadsOrders.leads.column.stage')}
            disabled={busyId === lead.id}
            onChange={(event) =>
              void run(
                lead.id,
                () => api.setLeadStage(lead.id, event.target.value),
                t('leadsOrders.error.moveLead'),
              )
            }
          >
            {leadStages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </Select>
        ),
    },
    {
      key: 'created',
      header: t('leadsOrders.leads.column.created'),
      width: rem(160),
      render: (lead) => <span className="ob-small">{formatDateTime(lead.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: rem(240),
      render: (lead) => {
        const missingPackaging = lead.items.some((item) => !item.packaging?.trim());
        return (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--s-8)',
              justifyContent: 'flex-end',
              width: '100%',
            }}
          >
            {lead.convertedOrderId ? (
              <span className="ob-small">
                {t('leadsOrders.leads.convertedOrder', { id: lead.convertedOrderId })}
              </span>
            ) : (
              <Button
                variant="primary"
                size="sm"
                busy={busyId === lead.id}
                disabled={missingPackaging}
                title={missingPackaging ? t('leadsOrders.leads.convertBlocked') : undefined}
                onClick={() =>
                  void run(lead.id, () => api.convertLead(lead.id), t('leadsOrders.error.convert'))
                }
              >
                {t('leadsOrders.leads.convert')}
              </Button>
            )}
            {canDeleteLeads && (
              <IconButton
                icon="trash"
                label={t('leadsOrders.delete.lead')}
                disabled={busyId === lead.id}
                onClick={() =>
                  setPendingDelete({ kind: 'lead', id: lead.id, label: lead.id })
                }
              />
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 className="ob-title" style={{ margin: 0 }}>
          {t('leadsOrders.title')}
        </h1>
        <Tabs tabs={tabItems} activeId={view} onChange={(id) => onViewChange(id as View)} />
      </div>

      {error && <ConflictBanner>{error}</ConflictBanner>}

      {loading ? (
        // Two column arrays, two element types: a ternary between them has no
        // single `T` for TypeScript to infer, so the branch happens outside the
        // prop rather than inside it.
        view === 'orders' ? (
          <SkeletonTable columns={orderColumns} />
        ) : (
          <SkeletonTable columns={leadColumns} />
        )
      ) : view === 'orders' ? (
        <DataTable
          columns={orderColumns}
          rows={orders}
          rowKey={(order) => order.id}
          empty={
            <EmptyState
              title={t('leadsOrders.orders.empty.title')}
              description={t('leadsOrders.orders.empty.description')}
            />
          }
        />
      ) : (
        <DataTable
          columns={leadColumns}
          rows={leads}
          rowKey={(lead) => lead.id}
          empty={
            <EmptyState
              title={
                view === 'converted'
                  ? t('leadsOrders.leads.empty.converted.title')
                  : t('leadsOrders.leads.empty.open.title')
              }
              description={
                view === 'converted' ? undefined : t('leadsOrders.leads.empty.open.description')
              }
            />
          }
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        tone="danger"
        busy={busyId !== null}
        title={
          pendingDelete?.kind === 'order'
            ? t('leadsOrders.delete.order.title', { id: pendingDelete.label })
            : t('leadsOrders.delete.lead.title', { id: pendingDelete?.label ?? '' })
        }
        body={t('leadsOrders.delete.body')}
        confirmLabel={t('common.delete')}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
