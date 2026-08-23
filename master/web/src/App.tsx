/**
 * Master Panel shell: decides which of the three phases the app is in
 * (first-run setup → sign-in → the panel itself) and owns the live socket
 * connection that keeps every screen current.
 */

import { useCallback, useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  DashboardSummary,
  OfficePanelWithPresence,
  ServerToClientEvents,
  User,
} from '@orderbook/shared';

import { api } from './api';
import { SearchBox } from './components/SearchBox';
import { ConflictsScreen } from './screens/ConflictsScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { FirstRunScreen } from './screens/FirstRunScreen';
import { InventoryScreen } from './screens/InventoryScreen';
import { LeadsOrdersScreen } from './screens/LeadsOrdersScreen';
import { PanelsScreen } from './screens/PanelsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SignInScreen } from './screens/SignInScreen';

type Phase = 'loading' | 'first-run' | 'signed-out' | 'ready';
type Tab = 'dashboard' | 'panels' | 'orders' | 'inventory' | 'conflicts' | 'settings';

/** Entities whose changes should make the data screens refetch. */
const REFRESHING_ENTITIES = new Set(['lead', 'order', 'stock', 'reservation', 'sync_conflict']);

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');

  const [panels, setPanels] = useState<OfficePanelWithPresence[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  // Incremented on every relevant change so screens that fetch their own data
  // know to refetch, without this shell having to model their state for them.
  const [dataRevision, setDataRevision] = useState(0);

  useEffect(() => {
    void (async () => {
      const { setupComplete } = await api.setupStatus();
      if (!setupComplete) {
        setPhase('first-run');
        return;
      }

      try {
        const me = await api.me();
        setUser(me.user);
        setSessionToken(me.sessionToken);
        setPhase('ready');
      } catch {
        setPhase('signed-out');
      }
    })();
  }, []);

  // One socket for the whole session, opened once signed in.
  useEffect(() => {
    if (phase !== 'ready' || !sessionToken) return;

    const socket: Socket<ServerToClientEvents> = io({
      auth: { kind: 'master-admin', sessionToken },
      transports: ['websocket'],
    });

    socket.on('panels:changed', setPanels);
    socket.on('dashboard:changed', setSummary);
    socket.on('data:changed', (event) => {
      if (REFRESHING_ENTITIES.has(event.entity)) setDataRevision((value) => value + 1);
    });
    // A merge shadowed somebody's value; the conflicts screen and the dashboard
    // counter both need to move.
    socket.on('sync:conflict', () => setDataRevision((value) => value + 1));

    return () => {
      socket.close();
    };
  }, [phase, sessionToken]);

  const refreshPanels = useCallback(() => {
    void api.panels().then((result) => setPanels(result.panels));
  }, []);

  async function signOut() {
    await api.signOut();
    setUser(null);
    setSessionToken(null);
    setPhase('signed-out');
  }

  if (phase === 'loading') return <div style={{ padding: 40 }}>Loading…</div>;

  if (phase === 'first-run') {
    return <FirstRunScreen onComplete={() => setPhase('signed-out')} />;
  }

  if (phase === 'signed-out' || !user) {
    return (
      <SignInScreen
        onSignedIn={(signedInUser, token) => {
          setUser(signedInUser);
          setSessionToken(token);
          setPhase('ready');
        }}
      />
    );
  }

  const openConflicts = summary?.openConflictCount ?? 0;

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '20px 16px 60px' }}>
      <header className="row" style={{ justifyContent: 'space-between', marginBottom: 16, gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>OrderBook — Master Panel</h1>

        <div className="row" style={{ gap: 12 }}>
          <SearchBox
            onOpen={(hit) => {
              // Route the hit to the screen that owns it — which is exactly what
              // `parent_type`/`parent_id` on a line-item hit are for.
              if (hit.kind === 'lead_line' || hit.kind === 'order_line') setTab('orders');
              else if (hit.kind === 'product') setTab('inventory');
            }}
          />
          <span className="muted">
            {user.username} · {user.roleName}
          </span>
          <button className="secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="row" style={{ marginBottom: 20 }}>
        <TabButton current={tab} value="dashboard" onSelect={setTab}>
          Dashboard
        </TabButton>
        <TabButton current={tab} value="panels" onSelect={setTab}>
          Office Panels
        </TabButton>
        <TabButton current={tab} value="orders" onSelect={setTab}>
          Leads &amp; Orders
        </TabButton>
        <TabButton current={tab} value="inventory" onSelect={setTab}>
          Inventory
          {summary && summary.lowStockCount > 0 ? ` (${summary.lowStockCount} low)` : ''}
        </TabButton>
        <TabButton current={tab} value="conflicts" onSelect={setTab}>
          Conflicts{openConflicts > 0 ? ` (${openConflicts})` : ''}
        </TabButton>
        <TabButton current={tab} value="settings" onSelect={setTab}>
          Settings
        </TabButton>
      </nav>

      {tab === 'dashboard' && (
        <DashboardScreen
          summary={summary}
          panels={panels}
          onOpenConflicts={() => setTab('conflicts')}
        />
      )}
      {tab === 'panels' && <PanelsScreen panels={panels} onRefresh={refreshPanels} />}
      {tab === 'orders' && <LeadsOrdersScreen revision={dataRevision} />}
      {tab === 'inventory' && <InventoryScreen revision={dataRevision} />}
      {tab === 'conflicts' && <ConflictsScreen revision={dataRevision} />}
      {tab === 'settings' && <SettingsScreen />}
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
