/**
 * Office Panel shell.
 *
 * Subscribes to this panel's server-sent event stream. The stream carries the
 * panel's **merged view** — the Master's snapshot with locally queued work
 * applied — so a lead saved while offline appears immediately and simply stops
 * being marked pending once it syncs.
 *
 * Note what is missing compared with the previous version: there is no longer a
 * "cannot save while disconnected" state. Saving offline is the normal path
 * now, so the shell reports the connection rather than gating on it.
 */

import { useCallback, useEffect, useState } from 'react';
import type { MutationResult } from '@orderbook/shared';

import { api, type ConnectionInfo, type LocalView } from './api';
import { SyncStatus } from './components/SyncStatus';
import { AddLeadScreen } from './screens/AddLeadScreen';
import { CatalogScreen } from './screens/CatalogScreen';
import { ConflictsScreen } from './screens/ConflictsScreen';
import { ConnectionScreen } from './screens/ConnectionScreen';
import { LeadBoardScreen } from './screens/LeadBoardScreen';
import { OrderBoardScreen } from './screens/OrderBoardScreen';

type Tab = 'leads' | 'orders' | 'parties' | 'products' | 'conflicts';

export function App() {
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [view, setView] = useState<LocalView | null>(null);
  const [rejections, setRejections] = useState<MutationResult[]>([]);
  const [tab, setTab] = useState<Tab>('leads');
  const [addingLead, setAddingLead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flushing, setFlushing] = useState(false);

  const refreshConnection = useCallback(async () => {
    try {
      setConnection(await api.connection());
    } catch {
      setConnection(null);
    }
  }, []);

  const refreshSyncState = useCallback(async () => {
    try {
      const state = await api.syncState();
      setRejections(state.rejections);
    } catch {
      // The panel's own server is unreachable — the page will report that via
      // the connection call; there is nothing useful to say twice.
    }
  }, []);

  useEffect(() => {
    void refreshConnection();
    void refreshSyncState();
  }, [refreshConnection, refreshSyncState]);

  // One event stream for the life of the page. EventSource reconnects on its
  // own, so a Master restart heals without the operator reloading anything.
  useEffect(() => {
    const source = new EventSource('/api/events');

    source.addEventListener('status', (event) => {
      const status = JSON.parse((event as MessageEvent).data) as Partial<ConnectionInfo>;
      setConnection((current) => (current ? { ...current, ...status } : current));
      if (status.state === 'connected') {
        void refreshConnection();
        void refreshSyncState();
      }
    });

    // The server sends the merged view, so this replaces state wholesale rather
    // than patching it — the merge already happened where the outbox lives.
    source.addEventListener('snapshot', (event) => {
      setView(JSON.parse((event as MessageEvent).data) as LocalView);
      void refreshSyncState();
    });

    source.addEventListener('conflict', () => {
      void refreshSyncState();
    });

    return () => source.close();
  }, [refreshConnection, refreshSyncState]);

  async function flush(): Promise<void> {
    setFlushing(true);
    try {
      const outcome = await api.flush();
      setRejections(outcome.rejections);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not sync');
    } finally {
      setFlushing(false);
    }
  }

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

  const permissions = view?.permissions ?? [];
  const can = (permission: string): boolean => permissions.includes(permission);
  const openConflicts = (view?.conflicts ?? []).filter((conflict) => !conflict.resolvedAt).length;

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '20px 16px 60px' }}>
      <header className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>
          OrderBook — Office Panel
          {connection.companyName ? (
            <span className="muted"> · {connection.companyName}</span>
          ) : null}
        </h1>
      </header>

      <SyncStatus
        connection={connection}
        pendingCount={view?.pendingCount ?? 0}
        rejections={rejections}
        onFlush={() => void flush()}
        busy={flushing}
      />

      {error && (
        <div className="error" onClick={() => setError(null)} role="alert">
          {error}
        </div>
      )}

      {addingLead && view ? (
        <AddLeadScreen
          view={view}
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
              <TabButton current={tab} value="conflicts" onSelect={setTab}>
                Conflicts{openConflicts > 0 ? ` (${openConflicts})` : ''}
              </TabButton>
            </nav>

            {/* No longer gated on the connection — offline saving is the point. */}
            <button onClick={() => setAddingLead(true)} disabled={!view || !can('leads.create')}>
              + Add Lead
            </button>
          </div>

          {!view ? (
            <div className="card">
              <p className="muted">
                Waiting for the first sync with the Master Panel. Once it has happened, this panel
                keeps working whether or not the Master is reachable.
              </p>
            </div>
          ) : tab === 'leads' ? (
            <LeadBoardScreen view={view} canConvert={can('lead.convert')} onError={setError} />
          ) : tab === 'orders' ? (
            <OrderBoardScreen
              view={view}
              canDispatch={can('orders.dispatch')}
              onError={setError}
            />
          ) : tab === 'conflicts' ? (
            <ConflictsScreen
              conflicts={view.conflicts}
              canResolve={can('sync.resolveConflicts')}
              onError={setError}
              onResolved={() => void flush()}
            />
          ) : (
            <CatalogScreen view={view} tab={tab} />
          )}
        </>
      )}
    </div>
  );
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
