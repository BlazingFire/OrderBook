/**
 * The order pipeline — a separate workflow from the lead's
 * (docs/LEAD_GENERATION_FLOW.md §5.1, §6).
 *
 * The one action here that moves real stock is Dispatch: it consumes the
 * order's reservations and writes the signed ledger entries. Everything before
 * that only holds stock aside.
 */

import { useState } from 'react';
import type { Order } from '@orderbook/shared';

import { api, type LocalView } from '../api';
import { Field } from '../components/Field';
import { KanbanBoard } from '../components/KanbanBoard';
import { formatDateTime, formatMoney } from '../format';

interface Props {
  view: LocalView;
  canDispatch: boolean;
  onError: (message: string) => void;
}

export function OrderBoardScreen({ view, canDispatch, onError }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);

  const pipeline = view.pipelines.find((candidate) => candidate.kind === 'order');
  const openOrder = view.orders.find((order) => order.id === openId) ?? null;

  if (!pipeline) {
    return (
      <div className="card">
        <p className="muted">Waiting for the pipeline configuration from the Master Panel…</p>
      </div>
    );
  }

  async function move(order: Order, stageId: string): Promise<void> {
    try {
      await api.setOrderStage(order.id, stageId);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not move the order');
    }
  }

  if (openOrder) {
    return (
      <OrderDetail
        order={openOrder}
        view={view}
        canDispatch={canDispatch}
        onClose={() => setOpenId(null)}
        onError={onError}
      />
    );
  }

  return (
    <KanbanBoard
      stages={pipeline.stages}
      items={view.orders}
      onMove={(order, stageId) => void move(order, stageId)}
      onOpen={(order) => setOpenId(order.id)}
      isLocked={(order) => Boolean(view.orders.find((o) => o.id === order.id)?.dispatchedAt)}
      emptyMessage="No orders at this stage."
      renderCard={(order) => (
        <>
          <div className="board-card-title">
            {order.partyName}
            {!order.sync.hlc && <span className="chip pending">not synced</span>}
            {order.dispatchedAt && <span className="chip converted">dispatched</span>}
          </div>
          <div className="board-card-meta">
            {order.id} · {order.items.length} product{order.items.length === 1 ? '' : 's'}
            {order.totalAmount !== undefined && ` · ${formatMoney(order.totalAmount)}`}
          </div>
          <div className="board-card-meta">
            {order.weightSource === 'manual'
              ? `${order.totalWeightKgOverride ?? 0} kg (manual)`
              : `${order.totalWeightKg} kg`}
          </div>
        </>
      )}
    />
  );
}

function OrderDetail({
  order,
  view,
  canDispatch,
  onClose,
  onError,
}: {
  order: Order;
  view: LocalView;
  canDispatch: boolean;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [note, setNote] = useState('');
  const [override, setOverride] = useState(
    order.totalWeightKgOverride === null ? '' : String(order.totalWeightKgOverride),
  );
  const [busy, setBusy] = useState(false);

  const pipeline = view.pipelines.find((candidate) => candidate.kind === 'order');
  const stages = [...(pipeline?.stages ?? [])].sort((a, b) => a.sequence - b.sequence);
  const active = order.reservations.filter((reservation) => reservation.status === 'active');

  async function run(action: () => Promise<unknown>, failure: string): Promise<void> {
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>
          {order.partyName} <span className="muted">{order.id}</span>
        </h2>
        <button className="secondary" onClick={onClose}>
          Back to board
        </button>
      </div>

      <div className="split">
        <div className="stack">
          <div className="card">
            <h3 className="section-title">Products</h3>
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Packaging</th>
                  <th>Colours</th>
                  <th className="right">Boxes</th>
                  <th className="right">Line total</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {item.productName}
                      <div className="muted">{item.code}</div>
                    </td>
                    <td>{item.packaging ?? '—'}</td>
                    <td>
                      {item.quantities.map((quantity) => (
                        <div key={quantity.id} className="muted">
                          {quantity.colour} × {quantity.quantity}
                        </div>
                      ))}
                    </td>
                    <td className="right num">{item.totalQuantity}</td>
                    <td className="right num">
                      {item.lineTotal === undefined ? '—' : formatMoney(item.lineTotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3 className="section-title">Stock held for this order</h3>
            {order.reservations.length === 0 ? (
              <p className="muted">No reservations.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Colour</th>
                    <th className="right">Boxes</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {order.reservations.map((reservation) => (
                    <tr key={reservation.id}>
                      <td>{reservation.productName}</td>
                      <td>{reservation.colour}</td>
                      <td className="right num">{reservation.quantity}</td>
                      <td>
                        <span className="chip">{reservation.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <h3 className="section-title">History</h3>
            <ul className="timeline">
              {order.timeline.map((entry) => (
                <li key={entry.id} className={entry.kind}>
                  <div>{entry.message}</div>
                  <div className="when">{formatDateTime(entry.createdAt)}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <h3 className="section-title">Stage</h3>
            <Field label="Move this order to">
              {(id) => (
                <select
                  id={id}
                  value={order.stageId}
                  disabled={busy || Boolean(order.dispatchedAt)}
                  onChange={(event) =>
                    void run(
                      () => api.setOrderStage(order.id, event.target.value),
                      'Could not move the order',
                    )
                  }
                >
                  {stages.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {stage.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <p className="muted" style={{ marginBottom: 0 }}>
              From lead <strong>{order.leadId ?? '—'}</strong>
            </p>
          </div>

          <div className="card">
            <h3 className="section-title">Weight</h3>
            <p style={{ marginTop: 0 }}>
              Computed from the lines: <strong className="num">{order.totalWeightKg} kg</strong>
            </p>

            <Field label="Override (leave blank to use the computed figure)">
              {(id) => (
                <input
                  id={id}
                  type="number"
                  min="0"
                  step="0.001"
                  className="num"
                  value={override}
                  onChange={(event) => setOverride(event.target.value)}
                  onBlur={() =>
                    void run(
                      () =>
                        api.updateOrder(order.id, {
                          totalWeightKgOverride: override === '' ? null : Number(override),
                        }),
                      'Could not save the weight',
                    )
                  }
                />
              )}
            </Field>

            <p className="muted" style={{ marginBottom: 0 }}>
              Showing the {order.weightSource} figure.
            </p>
          </div>

          <div className="card">
            <h3 className="section-title">Dispatch</h3>

            {order.dispatchedAt ? (
              <p>
                <span className="chip converted">dispatched</span>{' '}
                {formatDateTime(order.dispatchedAt)}
              </p>
            ) : (
              <>
                <p className="muted" style={{ marginTop: 0 }}>
                  Takes {active.length} reservation{active.length === 1 ? '' : 's'} off the stock
                  ledger. This cannot be undone from here.
                </p>

                <Field label="Note">
                  {(id) => (
                    <input
                      id={id}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="e.g. lorry AB-12"
                    />
                  )}
                </Field>

                <button
                  disabled={busy || !canDispatch}
                  onClick={() =>
                    void run(async () => {
                      await api.dispatchOrder(order.id, note.trim() || null);
                      onClose();
                    }, 'Could not dispatch the order')
                  }
                >
                  Mark dispatched
                </button>

                {!canDispatch && (
                  <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
                    Your role does not include <code>orders.dispatch</code>.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
