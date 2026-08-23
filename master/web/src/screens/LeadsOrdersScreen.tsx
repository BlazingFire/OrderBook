/**
 * The owner's view of every lead and order.
 *
 * Read-mostly by design: leads are raised on the Office Panels, and the
 * Master's API has no endpoint to create one (docs/LEAD_GENERATION_FLOW.md §2).
 * What the owner can do here is progress a record, convert a lead, and dispatch
 * an order — the decisions that belong to whoever is watching the whole board.
 */

import { useEffect, useState } from 'react';
import type { Lead, Order, Pipeline } from '@orderbook/shared';

import { api } from '../api';
import { formatDateTime, formatMoney } from '../format';

type View = 'leads' | 'orders' | 'converted';

interface Props {
  /** Bumped by the live socket whenever lead or order data changes. */
  revision: number;
}

export function LeadsOrdersScreen({ revision }: Props) {
  const [view, setView] = useState<View>('leads');
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
          const page = await api.orders();
          if (!cancelled) setOrders(page.items);
        } else {
          const page = await api.leads({ includeConverted: view === 'converted' });
          if (!cancelled) {
            setLeads(
              view === 'converted'
                ? page.items.filter((lead) => lead.convertedOrderId)
                : page.items,
            );
          }
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [view, revision]);

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

  return (
    <div>
      <h2>Leads &amp; Orders</h2>

      <div className="row" style={{ marginBottom: 12 }}>
        <button className={view === 'leads' ? '' : 'secondary'} onClick={() => setView('leads')}>
          Open leads
        </button>
        <button className={view === 'orders' ? '' : 'secondary'} onClick={() => setView('orders')}>
          Orders
        </button>
        <button
          className={view === 'converted' ? '' : 'secondary'}
          onClick={() => setView('converted')}
        >
          Converted leads
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="card">
          <p className="muted">Loading…</p>
        </div>
      ) : view === 'orders' ? (
        <div className="card">
          {orders.length === 0 ? (
            <p className="muted">No orders yet. They appear here once a lead is converted.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Party</th>
                  <th>From lead</th>
                  <th>Products</th>
                  <th className="right">Weight</th>
                  <th className="right">Amount</th>
                  <th>Stage</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td>{order.id}</td>
                    <td>{order.partyName}</td>
                    <td className="muted">{order.leadId ?? '—'}</td>
                    <td>
                      {order.items.map((item) => (
                        <div key={item.id} className="muted">
                          {item.productName} ×{item.totalQuantity}
                        </div>
                      ))}
                    </td>
                    <td className="right num">
                      {order.weightSource === 'manual'
                        ? `${order.totalWeightKgOverride ?? 0} kg`
                        : `${order.totalWeightKg} kg`}
                      <div className="muted">{order.weightSource}</div>
                    </td>
                    <td className="right num">
                      {order.totalAmount === undefined ? '—' : formatMoney(order.totalAmount)}
                    </td>
                    <td>
                      <select
                        value={order.stageId}
                        disabled={busyId === order.id || Boolean(order.dispatchedAt)}
                        onChange={(event) =>
                          void run(
                            order.id,
                            () => api.setOrderStage(order.id, event.target.value),
                            'Could not move the order',
                          )
                        }
                      >
                        {orderStages.map((stage) => (
                          <option key={stage.id} value={stage.id}>
                            {stage.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {order.dispatchedAt ? (
                        <span className="chip converted">
                          dispatched {formatDateTime(order.dispatchedAt)}
                        </span>
                      ) : (
                        <button
                          disabled={busyId === order.id}
                          onClick={() =>
                            void run(
                              order.id,
                              () => api.dispatchOrder(order.id),
                              'Could not dispatch the order',
                            )
                          }
                        >
                          Dispatch
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="card">
          {leads.length === 0 ? (
            <p className="muted">
              {view === 'converted'
                ? 'No converted leads yet.'
                : 'No open leads. Office Panels raise them.'}
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Party</th>
                  <th>Products</th>
                  <th className="right">Amount</th>
                  <th>Stage</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id}>
                    <td>
                      {lead.id}
                      {lead.incomplete && (
                        <div>
                          <span className="chip incomplete">incomplete</span>
                        </div>
                      )}
                    </td>
                    <td>{lead.partyName}</td>
                    <td>
                      {lead.items.map((item) => (
                        <div key={item.id} className="muted">
                          {item.productName} ×{item.totalQuantity}
                          {item.packaging ? ` · ${item.packaging}` : ''}
                        </div>
                      ))}
                    </td>
                    <td className="right num">
                      {lead.totalAmount === undefined ? '—' : formatMoney(lead.totalAmount)}
                    </td>
                    <td>
                      {lead.convertedOrderId ? (
                        <span className="chip converted">converted</span>
                      ) : (
                        <select
                          value={lead.stageId}
                          disabled={busyId === lead.id}
                          onChange={(event) =>
                            void run(
                              lead.id,
                              () => api.setLeadStage(lead.id, event.target.value),
                              'Could not move the lead',
                            )
                          }
                        >
                          {leadStages.map((stage) => (
                            <option key={stage.id} value={stage.id}>
                              {stage.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>{formatDateTime(lead.createdAt)}</td>
                    <td>
                      {lead.convertedOrderId ? (
                        <span className="muted">order {lead.convertedOrderId}</span>
                      ) : (
                        <button
                          disabled={
                            busyId === lead.id ||
                            lead.items.some((item) => !item.packaging?.trim())
                          }
                          title={
                            lead.items.some((item) => !item.packaging?.trim())
                              ? 'Every line needs packaging before this can become an order'
                              : undefined
                          }
                          onClick={() =>
                            void run(
                              lead.id,
                              () => api.convertLead(lead.id),
                              'Could not convert the lead',
                            )
                          }
                        >
                          Convert to order
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
