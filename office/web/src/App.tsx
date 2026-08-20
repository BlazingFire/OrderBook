/**
 * Office Panel shell.
 *
 * Subscribes to this panel's server-sent event stream, which mirrors the live
 * link to the Master: connection status and data changes both arrive there, so
 * every screen stays current without polling.
 */

import { useCallback, useEffect, useState } from 'react';
import type { DataChangedEvent, Lead, Party, Product, SyncSnapshot } from '@orderbook/shared';

import { api, type ConnectionInfo } from './api';
import { AddLeadScreen } from './screens/AddLeadScreen';
import { CatalogScreen } from './screens/CatalogScreen';
import { ConnectionScreen } from './screens/ConnectionScreen';
import { LeadsScreen } from './screens/LeadsScreen';

type Tab = 'leads' | 'orders' | 'parties' | 'products';

export function App() {
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [snapshot, setSnapshot] = useState<SyncSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>('leads');
  const [addingLead, setAddingLead] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshConnection = useCallback(async () => {
    try {
      setConnection(await api.connection());
    } catch {
      setConnection(null);
    }
  }, []);

  useEffect(() => {
    void refreshConnection();
  }, [refreshConnection]);

  // One event stream for the life of the page. EventSource reconnects on its
  // own, so a Master restart heals without the operator reloading anything.
  useEffect(() => {
    const source = new EventSource('/api/events');

    source.addEventListener('status', (event) => {
      const status = JSON.parse((event as MessageEvent).data) as Partial<ConnectionInfo>;
      setConnection((current) => (current ? { ...current, ...status } : current));
      // A newly-paired panel needs the rest of its connection details too.
      if (status.state === 'connected') void refreshConnection();
    });

    source.addEventListener('snapshot', (event) => {
      setSnapshot(JSON.parse((event as MessageEvent).data) as SyncSnapshot);
    });

    source.addEventListener('change', (event) => {
      const change = JSON.parse((event as MessageEvent).data) as DataChangedEvent;
      setSnapshot((current) => (current ? applyChange(current, change) : current));
    });

    return () => source.close();
  }, [refreshConnection]);

  if (!connection) return <div style={{ padding: 40 }}>Starting…</div>;

  if (!connection.isPaired) {
    return (
      <ConnectionScreen
        connection={connection}
        onConnected={() => {
          void refreshConnection();
        }}
      />
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px 16px 60px' }}>
      <header className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>
          OrderBook — Office Panel
          {connection.companyName ? <span className="muted"> · {connection.companyName}</span> : null}
        </h1>
        <div className="row">
          <span className={`dot ${connection.state === 'connected' ? 'on' : 'off'}`} />
          <span className="muted">
            {connection.state === 'connected'
              ? `Connected to Master (${connection.masterHost})`
              : connection.state === 'connecting'
                ? 'Connecting to Master…'
                : 'Master offline — reconnecting'}
          </span>
        </div>
      </header>

      {connection.state !== 'connected' && (
        <div className="error">
          Not connected to the Master Panel. New leads cannot be saved until the connection returns.
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {addingLead && snapshot ? (
        <AddLeadScreen
          snapshot={snapshot}
          onSaved={() => {
            setAddingLead(false);
            setTab('leads');
          }}
          onCancel={() => setAddingLead(false)}
        />
      ) : (
        <>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
            <nav className="row">
              <TabButton current={tab} value="leads" onSelect={setTab}>
                Leads
              </TabButton>
              <TabButton current={tab} value="orders" onSelect={setTab}>
                Orders
              </TabButton>
              <TabButton current={tab} value="parties" onSelect={setTab}>
                Parties
              </TabButton>
              <TabButton current={tab} value="products" onSelect={setTab}>
                Products
              </TabButton>
            </nav>
            <button
              onClick={() => setAddingLead(true)}
              disabled={!snapshot || connection.state !== 'connected'}
            >
              + Add Lead
            </button>
          </div>

          {!snapshot ? (
            <div className="card">
              <p className="muted">Waiting for data from the Master Panel…</p>
            </div>
          ) : tab === 'leads' || tab === 'orders' ? (
            <LeadsScreen leads={snapshot.leads} view={tab} onError={setError} />
          ) : (
            <CatalogScreen snapshot={snapshot} view={tab} />
          )}
        </>
      )}
    </div>
  );
}

function applyChange(snapshot: SyncSnapshot, change: DataChangedEvent): SyncSnapshot {
  switch (change.entity) {
    case 'lead':
      return { ...snapshot, leads: upsert(snapshot.leads, change.payload as Lead) };
    case 'party':
      return { ...snapshot, parties: upsert(snapshot.parties, change.payload as Party) };
    case 'product':
      return { ...snapshot, products: upsert(snapshot.products, change.payload as Product) };
    default:
      return snapshot;
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) return [item, ...list];
  const next = [...list];
  next[index] = item;
  return next;
}

function TabButton({
  current,
  value,
  onSelect,
  children,
}: {
  current: Tab;
  value: Tab;
  onSelect: (tab: Tab) => void;
  children: React.ReactNode;
}) {
  return (
    <button className={current === value ? '' : 'secondary'} onClick={() => onSelect(value)}>
      {children}
    </button>
  );
}
