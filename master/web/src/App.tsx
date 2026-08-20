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
import { DashboardScreen } from './screens/DashboardScreen';
import { FirstRunScreen } from './screens/FirstRunScreen';
import { InventoryScreen } from './screens/InventoryScreen';
import { OrdersScreen } from './screens/OrdersScreen';
import { PanelsScreen } from './screens/PanelsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SignInScreen } from './screens/SignInScreen';

type Phase = 'loading' | 'first-run' | 'signed-out' | 'ready';
type Tab = 'dashboard' | 'panels' | 'orders' | 'inventory' | 'settings';

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');

  const [panels, setPanels] = useState<OfficePanelWithPresence[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  // Incremented on every lead change so screens that fetch their own data know
  // to refetch, without this shell having to model their state for them.
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
      // Stock changes when an order is placed, so both views refresh together.
      if (event.entity === 'lead' || event.entity === 'stock') {
        setDataRevision((value) => value + 1);
      }
    });

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

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px 16px 60px' }}>
      <header className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>OrderBook — Master Panel</h1>
        <div className="row">
          <span className="muted">Signed in as {user.username}</span>
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
        <TabButton current={tab} value="settings" onSelect={setTab}>
          Settings
        </TabButton>
      </nav>

      {tab === 'dashboard' && <DashboardScreen summary={summary} panels={panels} />}
      {tab === 'panels' && <PanelsScreen panels={panels} onRefresh={refreshPanels} />}
      {tab === 'orders' && <OrdersScreen revision={dataRevision} />}
      {tab === 'inventory' && <InventoryScreen revision={dataRevision} />}
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
