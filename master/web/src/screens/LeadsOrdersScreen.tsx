/**
 * The owner's view of every lead and order.
 *
 * Read-mostly by design: leads are raised on the Office Panels, and the
 * Master's API has no endpoint to create one (docs/LEAD_GENERATION_FLOW.md §2).
 * What the owner can do here is progress a record, convert a lead, and dispatch
 * an order — the decisions that belong to whoever is watching the whole board.
 */

import { useEffect, useState } from 'react';
import type { Lead, LineItem, Order, PartyScopeFilter, Pipeline } from '@orderbook/shared';

import { api } from '../api';
import { formatDateTime, formatMoney } from '../format';
import { t } from '../i18n/strings';
import { Button } from '../ui/Button';
import { StatusPill } from '../ui/DataDisplay';
import { DataTable, type DataTableColumn } from '../ui/DataTable';
import { Select } from '../ui/Form';
import { ConflictBanner, EmptyState, SkeletonRows } from '../ui/States';
import { useFilterBar } from '../ui/FilterBarSlot';
import { Segmented, Tabs, type TabItem } from '../ui/Tabs';

type View = 'leads' | 'orders' | 'converted';

interface Props {
  /** Bumped by the live socket whenever lead or order data changes. */
  revision: number;
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
  const lines = items.map(
    (item) =>
      `${item.productName} ×${item.totalQuantity}${item.packaging ? ` · ${item.packaging}` : ''}`,
  );
  return { text: lines.join(', '), title: lines.join('\n') };
}

export function LeadsOrdersScreen({ revision }: Props) {
  const [view, setView] = useState<View>('leads');
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

  useEffect(() => {
    void api.pipelines().then(setPipelines).catch(() => setPipelines([]));
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
        if (!cancelled) setError(caught instanceof Error ? caught.message : t('leadsOrders.error.load'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [view, scope, revision]);

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
      width: '120px',
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
      width: '130px',
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
            style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {summary.text}
          </span>
        );
      },
    },
    {
      key: 'weight',
      header: t('leadsOrders.orders.column.weight'),
      width: '110px',
      align: 'right',
      // Same convention as the Office Panel's order board: a manually entered
      // weight is marked, because it is the one number here nobody derived.
      render: (order) => (
        <span
          title={order.weightSource === 'manual' ? t('leadsOrders.orders.weightManual') : undefined}
          style={{ color: order.weightSource === 'manual' ? 'var(--fg-secondary)' : undefined }}
        >
          {order.weightSource === 'manual' ? (order.totalWeightKgOverride ?? 0) : order.totalWeightKg}{' '}
          {t('leadsOrders.unit.kg')}
          {order.weightSource === 'manual' ? '*' : ''}
        </span>
      ),
    },
    {
      key: 'amount',
      header: t('leadsOrders.orders.column.amount'),
      width: '120px',
      align: 'right',
      render: (order) => formatMoney(order.totalAmount ?? null),
    },
    {
      key: 'stage',
      header: t('leadsOrders.orders.column.stage'),
      width: '170px',
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
      width: '240px',
      render: (order) => (
        <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
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
        </div>
      ),
    },
  ];

  const leadColumns: DataTableColumn<Lead>[] = [
    {
      key: 'id',
      header: t('leadsOrders.leads.column.lead'),
      width: '190px',
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
            style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {summary.text}
          </span>
        );
      },
    },
    {
      key: 'amount',
      header: t('leadsOrders.leads.column.amount'),
      width: '120px',
      align: 'right',
      render: (lead) => formatMoney(lead.totalAmount ?? null),
    },
    {
      key: 'stage',
      header: t('leadsOrders.leads.column.stage'),
      width: '170px',
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
      width: '160px',
      render: (lead) => <span className="ob-small">{formatDateTime(lead.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: '200px',
      render: (lead) => {
        const missingPackaging = lead.items.some((item) => !item.packaging?.trim());
        return (
          <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
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
        <Tabs tabs={tabItems} activeId={view} onChange={(id) => setView(id as View)} />
      </div>

      {error && <ConflictBanner>{error}</ConflictBanner>}

      {loading ? (
        <SkeletonRows columns={view === 'orders' ? 8 : 7} />
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
    </div>
  );
}
