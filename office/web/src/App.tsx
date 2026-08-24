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

import { api, type ConnectionInfo, type LocalView, type PanelSession } from './api';
import { SyncStatus } from './components/SyncStatus';
import { AddLeadScreen } from './screens/AddLeadScreen';
import { CatalogScreen } from './screens/CatalogScreen';
import { ConflictsScreen } from './screens/ConflictsScreen';
import { ConnectionScreen } from './screens/ConnectionScreen';
import { LeadBoardScreen } from './screens/LeadBoardScreen';
import { OrderBoardScreen } from './screens/OrderBoardScreen';
import { SignInScreen } from './screens/SignInScreen';

type Tab = 'leads' | 'orders' | 'parties' | 'products' | 'conflicts';

export function App() {
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [session, setSession] = useState<PanelSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
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

  const refreshSession = useCallback(async () => {
    try {
      setSession((await api.session()).session);
    } catch {
      setSession(null);
    } finally {
      setSessionChecked(true);
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
    void refreshSession();
  }, [refreshConnection, refreshSession]);

  // Sync state sits behind the sign-in gate, so asking for it before anybody has
  // signed in earns a 401 whose only effect is a red line in the console.
  useEffect(() => {
    if (!session) return;
    void refreshSyncState();
  }, [session, refreshSyncState]);

  // One event stream per signed-in session. The stream carries this panel's
  // data, so it is behind the same gate the rest of the API is — opening it
  // before somebody has signed in would just be answered with a 401.
  useEffect(() => {
    if (!session) return;

    const source = new EventSource('/api/events');

    source.addEventListener('status', (event) => {
      const status = JSON.parse((event as MessageEvent).data) as Partial<ConnectionInfo>;
      setConnection((current) => (current ? { ...current, ...status } : current));
      if (status.state === 'connected') {
        void refreshConnection();
        void refreshSyncState();
        // The link coming back is when the Master gets to re-check who this is.
        // If it has since deactivated them, the panel's session is already gone
        // and this is how the screen finds out.
        void refreshSession();
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
  }, [session, refreshConnection, refreshSession, refreshSyncState]);

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

  async function signOut(): Promise<void> {
    await api.signOut();
    setSession(null);
    setView(null);
    setTab('leads');
    setAddingLead(false);
  }

  if (!connection || !sessionChecked) return <div style={{ padding: 40 }}>Starting…</div>;

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

  // Pairing says this machine may talk to the Master. Signing in says who is
  // doing the talking — and until somebody has, there is nothing to show.
  if (!session) {
    return <SignInScreen connection={connection} onSignedIn={setSession} />;
  }

  // The session's set, not the snapshot's: signing in offline means there is no
  // fresh snapshot to read them from, and the cached set is exactly what the
  // panel is enforcing locally.
  const permissions = session.permissions;
  const can = (permission: string): boolean => permissions.includes(permission);

  // Which tabs this person actually has. `tab` defaults to 'leads', so somebody
  // without `leads.view` would otherwise land on a blank panel and conclude the
  // app was broken rather than that they lack the permission.
  const visibleTabs: Tab[] = (
    [
      ['leads', 'leads.view'],
      ['orders', 'orders.view'],
      ['parties', 'parties.view'],
      ['products', 'products.view'],
      ['conflicts', 'sync.resolveConflicts'],
    ] as const
  )
    .filter(([, permission]) => can(permission))
    .map(([name]) => name);

  const activeTab = visibleTabs.includes(tab) ? tab : visibleTabs[0];
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

        <div className="row" style={{ gap: 10 }}>
          <span className="muted">
            {session.displayName} · {session.roleName}
            {/*
              Worth saying out loud: these permissions were cached at the last
              online sign-in, so an administrator's change made while this panel
              was unreachable is not reflected yet.
            */}
            {session.offline ? ' · signed in offline' : ''}
          </span>
          <button className="secondary" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
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
          canEditRate={can('field.saleRate.edit')}
          onSaved={() => {
            setAddingLead(false);
            setTab('leads');
          }}
          onCancel={() => setAddingLead(false)}
        />
      ) : (
        <>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
            {/*
              Absent, not greyed. A module somebody's role does not include
              should not appear at all — `roles-ui.md` §11's second gate is
              exactly this, and the Master's own shell already does it. The
              services fail closed regardless, so this is the affordance rather
              than the rule.
            */}
            <nav className="row">
              {can('leads.view') && (
                <TabButton current={activeTab} value="leads" onSelect={setTab}>
                  Leads
                </TabButton>
              )}
              {can('orders.view') && (
                <TabButton current={activeTab} value="orders" onSelect={setTab}>
                  Orders
                </TabButton>
              )}
              {can('parties.view') && (
                <TabButton current={activeTab} value="parties" onSelect={setTab}>
                  Parties
                </TabButton>
              )}
              {can('products.view') && (
                <TabButton current={activeTab} value="products" onSelect={setTab}>
                  Products
                </TabButton>
              )}
              {can('sync.resolveConflicts') && (
                <TabButton current={activeTab} value="conflicts" onSelect={setTab}>
                  Conflicts{openConflicts > 0 ? ` (${openConflicts})` : ''}
                </TabButton>
              )}
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
          ) : activeTab === 'leads' ? (
            <LeadBoardScreen view={view} canConvert={can('lead.convert')} onError={setError} />
          ) : activeTab === 'orders' ? (
            <OrderBoardScreen
              view={view}
              canDispatch={can('orders.dispatch')}
              onError={setError}
            />
          ) : activeTab === 'conflicts' ? (
            <ConflictsScreen
              conflicts={view.conflicts}
              canResolve={can('sync.resolveConflicts')}
              onError={setError}
              onResolved={() => void flush()}
            />
          ) : activeTab === 'parties' || activeTab === 'products' ? (
            <CatalogScreen view={view} tab={activeTab} />
          ) : (
            // Every tab is behind a permission, so a role with none of them
            // reaches this. Said plainly rather than shown as an empty list,
            // which reads as "the company has no data".
            <div className="card">
              <p className="muted">
                Your role does not include access to any of this panel&apos;s screens. Ask an
                administrator if you think that is wrong.
              </p>
            </div>
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
