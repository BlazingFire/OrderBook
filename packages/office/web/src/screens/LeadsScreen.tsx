/**
 * Leads and Orders tabs. Promoting a lead to an order happens here — the same
 * record changes status, it is not copied anywhere.
 */

import { useState } from 'react';
import type { Lead, LeadStatus } from '@orderbook/shared';

import { api } from '../api';
import { formatDateTime, formatMoney } from '../format';

interface Props {
  leads: Lead[];
  view: 'leads' | 'orders';
  onError: (message: string) => void;
}

export function LeadsScreen({ leads, view, onError }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const visible = leads.filter((lead) =>
    view === 'leads' ? lead.status === 'new' || lead.status === 'verified' : lead.status === 'order',
  );

  async function move(lead: Lead, status: LeadStatus) {
    setBusyId(lead.id);
    try {
      await api.setLeadStatus(lead.id, status);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not update the lead');
    } finally {
      setBusyId(null);
    }
  }

  if (visible.length === 0) {
    return (
      <div className="card">
        <p className="muted">
          {view === 'leads' ? 'No open leads. Press “Add Lead” to create one.' : 'No orders yet.'}
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Number</th>
            <th>Party</th>
            <th>Products</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Created</th>
            {view === 'leads' && <th />}
          </tr>
        </thead>
        <tbody>
          {visible.map((lead) => (
            <tr key={lead.id}>
              <td>{lead.leadNumber}</td>
              <td>{lead.partyName}</td>
              <td>
                {lead.items.map((item) => (
                  <div key={item.id} className="muted">
                    {item.productName} × {item.quantityBoxes ?? '—'}
                  </div>
                ))}
              </td>
              <td>{formatMoney(lead.totalAmount)}</td>
              <td>
                <span className={`badge ${lead.status}`}>{lead.status}</span>
              </td>
              <td>{formatDateTime(lead.createdAt)}</td>
              {view === 'leads' && (
                <td>
                  <div className="row">
                    {/* Verification is a deliberate step before an order exists,
                        so the two transitions are separate buttons. */}
                    {lead.status === 'new' && (
                      <button disabled={busyId === lead.id} onClick={() => move(lead, 'verified')}>
                        Mark verified
                      </button>
                    )}
                    {lead.status === 'verified' && (
                      <button disabled={busyId === lead.id} onClick={() => move(lead, 'order')}>
                        Move to Orders
                      </button>
                    )}
                    <button
                      className="secondary"
                      disabled={busyId === lead.id}
                      onClick={() => move(lead, 'cancelled')}
                    >
                      Cancel
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
