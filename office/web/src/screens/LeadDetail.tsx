/**
 * One lead in full: its lines, its history, and the two things a person does to
 * it — move it along, or convert it (docs/LEAD_GENERATION_FLOW.md §4, §5).
 *
 * The stage `select` here is not a duplicate of the board's drag: dragging is
 * mouse-only, and this is the path that works with a keyboard.
 */

import { useState } from 'react';
import type { Lead } from '@orderbook/shared';

import { api, type LocalView } from '../api';
import { Field } from '../components/Field';
import { formatDateTime, formatMoney } from '../format';

interface Props {
  lead: Lead;
  view: LocalView;
  canConvert: boolean;
  onClose: () => void;
  onError: (message: string) => void;
}

export function LeadDetail({ lead, view, canConvert, onClose, onError }: Props) {
  const [remark, setRemark] = useState('');
  const [dispatchLabel, setDispatchLabel] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [busy, setBusy] = useState(false);

  const pipeline = view.pipelines.find((candidate) => candidate.kind === 'lead');
  const stages = [...(pipeline?.stages ?? [])].sort((a, b) => a.sequence - b.sequence);

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

  const missingPackaging = lead.items.filter((item) => !item.packaging?.trim());

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>
          {lead.partyName} <span className="muted">{lead.id}</span>
        </h2>
        <button className="secondary" onClick={onClose}>
          Back to board
        </button>
      </div>

      {lead.incomplete && (
        <div className="error">
          Missing required information: {lead.missingFields.join(', ')}. The lead is saved — fill
          this in when you can.
        </div>
      )}

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
                {lead.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {item.productName}
                      <div className="muted">
                        {item.code}
                        {item.size ? ` · ${item.size}` : ''}
                        {item.grade ? ` · ${item.grade}` : ''}
                      </div>
                    </td>
                    <td>
                      {item.packaging || <span className="chip incomplete">not chosen</span>}
                    </td>
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

            {lead.totalAmount !== undefined && (
              <div className="row right" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
                <strong>Total {formatMoney(lead.totalAmount)}</strong>
              </div>
            )}
          </div>

          <div className="card">
            <h3 className="section-title">History</h3>
            {lead.timeline.length === 0 ? (
              <p className="muted">Nothing recorded yet.</p>
            ) : (
              <ul className="timeline">
                {lead.timeline.map((entry) => (
                  <li key={entry.id} className={entry.kind}>
                    <div>{entry.message}</div>
                    <div className="when">
                      {formatDateTime(entry.createdAt)}
                      {entry.actorName ? ` · ${entry.actorName}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <input
                value={remark}
                placeholder="Add a note…"
                onChange={(event) => setRemark(event.target.value)}
              />
              <button
                disabled={busy || !remark.trim()}
                onClick={() =>
                  void run(async () => {
                    await api.addLeadRemark(lead.id, remark.trim());
                    setRemark('');
                  }, 'Could not add the note')
                }
              >
                Add
              </button>
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <h3 className="section-title">Stage</h3>
            <Field label="Move this lead to">
              {(id) => (
                <select
                  id={id}
                  value={lead.stageId}
                  disabled={busy || Boolean(lead.convertedOrderId)}
                  onChange={(event) =>
                    void run(
                      () => api.setLeadStage(lead.id, event.target.value),
                      'Could not move the lead',
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

            <dl style={{ margin: 0, fontSize: 14 }}>
              <Detail label="Source" value={lead.sourcePlatform ?? '—'} />
              <Detail label="Follow up" value={lead.followUpDate ?? '—'} />
              <Detail label="Party rates" value={lead.partyWiseMode ? 'Yes' : 'No'} />
              <Detail label="Created" value={formatDateTime(lead.createdAt)} />
            </dl>

            {lead.notes && <p style={{ marginBottom: 0 }}>{lead.notes}</p>}
          </div>

          <div className="card">
            <h3 className="section-title">Convert to order</h3>

            {lead.convertedOrderId ? (
              <p>
                <span className="chip converted">converted</span> This lead became order{' '}
                <strong>{lead.convertedOrderId}</strong>.
              </p>
            ) : (
              <>
                <p className="muted" style={{ marginTop: 0 }}>
                  Creates an order with these lines copied exactly as they stand, and reserves the
                  stock for each colour.
                </p>

                {missingPackaging.length > 0 && (
                  <div className="error">
                    Choose packaging for {missingPackaging.map((i) => i.productName).join(', ')}{' '}
                    first — it is never filled in automatically.
                  </div>
                )}

                <Field label="Dispatch address label">
                  {(id) => (
                    <input
                      id={id}
                      value={dispatchLabel}
                      onChange={(event) => setDispatchLabel(event.target.value)}
                    />
                  )}
                </Field>

                <Field label="Expected dispatch date">
                  {(id) => (
                    <input
                      id={id}
                      type="date"
                      value={expectedDate}
                      onChange={(event) => setExpectedDate(event.target.value)}
                    />
                  )}
                </Field>

                <button
                  disabled={busy || !canConvert || missingPackaging.length > 0}
                  onClick={() =>
                    void run(async () => {
                      await api.convertLead(lead.id, {
                        dispatchAddressLabel: dispatchLabel.trim() || null,
                        expectedDispatchDate: expectedDate || null,
                      });
                      onClose();
                    }, 'Could not convert the lead')
                  }
                >
                  Convert to order
                </button>

                {!canConvert && (
                  <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
                    Your role does not include <code>lead.convert</code>.
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

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', padding: '3px 0' }}>
      <dt className="muted">{label}</dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </div>
  );
}
