/**
 * Read-only view of every lead and order on the Master. Day-to-day entry
 * happens on the Office Panels; this is where the owner sees all of it.
 */

import { useEffect, useState } from 'react';
import type { Lead, LeadStatus } from '@orderbook/shared';

import { api } from '../api';
import { formatDateTime, formatMoney } from '../format';

type Filter = 'leads' | 'orders' | 'all';

const FILTER_STATUSES: Record<Filter, LeadStatus[] | undefined> = {
  leads: ['new', 'verified'],
  orders: ['order'],
  all: undefined,
};

interface Props {
  /** Bumped by the live socket whenever lead data changes, to trigger a refetch. */
  revision: number;
}

export function OrdersScreen({ revision }: Props) {
  const [filter, setFilter] = useState<Filter>('leads');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    api
      .leads(FILTER_STATUSES[filter])
      .then((page) => {
        if (!cancelled) setLeads(page.items);
      })
      .catch(() => {
        if (!cancelled) setLeads([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filter, revision]);

  return (
    <div>
      <h2>Leads &amp; Orders</h2>

      <div className="row" style={{ marginBottom: 12 }}>
        <button
          className={filter === 'leads' ? '' : 'secondary'}
          onClick={() => setFilter('leads')}
        >
          Open leads
        </button>
        <button
          className={filter === 'orders' ? '' : 'secondary'}
          onClick={() => setFilter('orders')}
        >
          Orders
        </button>
        <button className={filter === 'all' ? '' : 'secondary'} onClick={() => setFilter('all')}>
          All
        </button>
      </div>

      <div className="card">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : leads.length === 0 ? (
          <p className="muted">Nothing here yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Party</th>
                <th>Products</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
