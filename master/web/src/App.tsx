/**
 * Master Panel shell: decides which of the three phases the app is in
 * (first-run setup → sign-in → the panel itself) and owns the live socket
 * connection that keeps every screen current.
 *
 * Presentation follows 6-UI-DESIGN.md via the same `ui/` foundation the Office
 * Panel uses — presence rail, grouped sidebar, topbar with universal search,
 * status footer, cold-start splash. The rail's meaning is the Master's own
 * (docs/UI_REDESIGN.md §4.8): an aggregate across its office panels — open
 * conflicts, unreachable panels, changes waiting to reach the Master — rather
 * than a static "Synced", which would be a lie on the machine that *is* the
 * server.
 */

import { useCallback, useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  DashboardSummary,
  OfficePanelWithPresence,
  ServerToClientEvents,
  SignedInUser,
} from '@orderbook/shared';

import { api } from './api';
import { t } from './i18n/strings';
import { SearchBox } from './components/SearchBox';
import { AccessScreen } from './screens/AccessScreen';
import { ConflictsScreen } from './screens/ConflictsScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { FirstRunScreen } from './screens/FirstRunScreen';
import { InventoryScreen } from './screens/InventoryScreen';
import { LeadsOrdersScreen } from './screens/LeadsOrdersScreen';
import { PanelsScreen } from './screens/PanelsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SignInScreen } from './screens/SignInScreen';
import { AppShell, type NavGroup, type NavItem } from './ui/AppShell';
import { FilterBarOutlet, FilterBarProvider } from './ui/FilterBarSlot';
import { SaveShortcutProvider } from './ui/SaveShortcutSlot';
import { GalleryScreen } from './ui/GalleryScreen';
import { Icon } from './ui/icons';
import { Splash } from './ui/Splash';
import { ToastProvider } from './ui/Toast';

type Phase = 'loading' | 'first-run' | 'signed-out' | 'ready';
type Tab = 'dashboard' | 'panels' | 'orders' | 'inventory' | 'access' | 'conflicts' | 'settings';
type Route = '' | 'gallery';

/** Entities whose changes should make the data screens refetch. */
const REFRESHING_ENTITIES = new Set(['lead', 'order', 'stock', 'reservation', 'sync_conflict']);

function readHash(): string {
  return window.location.hash.replace(/^#/, '');
}

export function App() {
  return (
    <ToastProvider>
      <MasterPanel />
    </ToastProvider>
  );
}

function MasterPanel() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');

  const [panels, setPanels] = useState<OfficePanelWithPresence[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  // Incremented on every relevant change so screens that fetch their own data
  // know to refetch, without this shell having to model their state for them.
  const [dataRevision, setDataRevision] = useState(0);

  // Shell chrome state.
  const [splashDone, setSplashDone] = useState(false);
  const [route, setRoute] = useState<Route>(readHash() === 'gallery' ? 'gallery' : '');
  const [collapsed, setCollapsed] = useState(false);
  const [syncPopover, setSyncPopover] = useState(false);

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

  // Hash routing: #/gallery is the one extra place a user can land.
  useEffect(() => {
    const onHash = () => setRoute(readHash() === 'gallery' ? 'gallery' : '');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Looping animations (rail highlight, busy mark) stop on blur (§5).
  useEffect(() => {
    const root = document.documentElement;
    const onBlur = () => {
      root.dataset.windowBlur = 'true';
    };
    const onFocus = () => {
      root.dataset.windowBlur = 'false';
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      delete root.dataset.windowBlur;
    };
  }, []);

  async function signOut() {
    await api.signOut();
    setUser(null);
    setSessionToken(null);
    setPhase('signed-out');
    setRoute('');
  }

  if (!splashDone) {
    return <Splash wordmark={t('app.name')} onDone={() => setSplashDone(true)} />;
  }

  if (phase === 'loading')
    return <div style={{ padding: 'var(--s-40)', color: 'var(--fg-secondary)' }}>{t('shell.starting')}</div>;

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

  // ---- Presence rail (§4.8): the Master's aggregate across its panels.
  const openConflicts = summary?.openConflictCount ?? 0;
  const pendingSync = summary?.pendingSyncCount ?? 0;
  const offlinePanels = panels.filter((panel) => !panel.isConnected).length;
  const canManageRoles = user.permissions.includes('roles.view') || user.permissions.includes('users.manage');
  const canManagePanels = user.permissions.includes('panels.manage');
  const canManageSettings = user.permissions.includes('settings.manage');

  let railState: 'synced' | 'syncing' | 'offline' | 'offlinePending' | 'conflict';
  if (openConflicts > 0) railState = 'conflict';
  else if (offlinePanels > 0 && pendingSync > 0) railState = 'offlinePending';
  else if (offlinePanels > 0) railState = 'offline';
  else railState = pendingSync > 0 ? 'syncing' : 'synced';

  const syncLabel =
    railState === 'conflict'
      ? t('sync.conflictReview', { count: openConflicts })
      : railState === 'offlinePending'
        ? t('sync.offlinePending', { count: offlinePanels, pending: pendingSync })
        : railState === 'offline'
          ? t('sync.offline', { count: offlinePanels })
          : railState === 'syncing'
            ? t('sync.syncing', { count: pendingSync })
            : t('sync.synced');

  const railDotColour =
    railState === 'conflict'
      ? 'var(--state-conflict)'
      : railState === 'offline' || railState === 'offlinePending'
        ? 'var(--state-offline)'
        : railState === 'syncing'
          ? 'var(--accent)'
          : 'var(--line-strong)';

  const popoverTitleKey =
    railState === 'conflict'
      ? 'sync.popoverTitle.conflict'
      : railState === 'offlinePending'
        ? 'sync.popoverTitle.offlinePending'
        : railState === 'offline'
          ? 'sync.popoverTitle.offline'
          : railState === 'syncing'
            ? 'sync.popoverTitle.syncing'
            : 'sync.popoverTitle.synced';

  // ---- Sidebar modules. Absent, not greyed, when the role cannot use them.
  const workItems: Array<NavItem | null> = [
    { id: 'dashboard', label: t('nav.master.dashboard'), icon: 'dashboard' },
    { id: 'orders', label: t('nav.master.leadsOrders'), icon: 'orders' },
    {
      id: 'inventory',
      label: t('nav.master.inventory'),
      icon: 'inventory',
      count: summary?.lowStockCount && summary.lowStockCount > 0 ? summary.lowStockCount : undefined,
    },
    {
      id: 'conflicts',
      label: t('nav.master.conflicts'),
      icon: 'conflicts',
      count: openConflicts > 0 ? openConflicts : undefined,
    },
  ];

  const adminItems: Array<NavItem | null> = [
    canManagePanels ? { id: 'panels', label: t('nav.master.panels'), icon: 'server' } : null,
    canManageRoles ? { id: 'access', label: t('nav.master.access'), icon: 'shield' } : null,
    canManageSettings ? { id: 'settings', label: t('nav.master.settings'), icon: 'settings' } : null,
  ];

  const groups: NavGroup[] = [
    { label: t('nav.master.work'), items: workItems.filter((item): item is NavItem => item !== null) },
    { label: t('nav.master.admin'), items: adminItems.filter((item): item is NavItem => item !== null) },
  ];

  const activeId =
    route === 'gallery' ? 'gallery' : tab;
  const activeLabel =
    route === 'gallery'
      ? t('footer.designSystem')
      : (groups.flatMap((group) => group.items).find((item) => item.id === activeId)?.label ??
        t('app.panel'));

  const topbar = (
    <>
      <h1 className="ob-title" style={{ marginRight: 'var(--s-4)' }}>
        {activeLabel}
      </h1>
      <span style={{ flex: 1 }} />
      <SearchBox
        onOpen={(hit) => {
          // Route the hit to the screen that owns it — which is exactly what
          // `parent_type`/`parent_id` on a line-item hit are for.
          if (hit.kind === 'lead_line' || hit.kind === 'order_line') setTab('orders');
          else if (hit.kind === 'product') setTab('inventory');
        }}
      />
      <button className="ob-btn ob-btn--ghost" onClick={() => void signOut()}>
        {t('action.signOut')}
      </button>
    </>
  );

  const footer = (
    <>
      <button type="button" className="ob-footer-sync" style={{ color: 'inherit' }} onClick={() => setSyncPopover((open) => !open)}>
        <span className="dot" style={{ background: railDotColour }} />
        {syncLabel}
      </button>
      <span style={{ flex: 1 }} />
      <span>{t('footer.signedInAs', { name: user.username, role: user.roleName })}</span>
      <a href="#/gallery" onClick={() => setRoute('gallery')} style={{ color: 'var(--fg-tertiary)' }}>
        {t('footer.designSystem')}
      </a>
      <span className="ob-mono" style={{ fontSize: '10.5px', color: 'var(--fg-tertiary)' }}>
        {t('footer.version')}
      </span>
    </>
  );

  const overlays = syncPopover && (
    <>
      {/* Click-away shim keeps the popover honest without a portal. */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 'var(--z-popover)' }} onClick={() => setSyncPopover(false)} />
      <div
        className="ob-popover"
        style={{ left: 'var(--s-12)', bottom: 'calc(var(--shell-footer-h) + var(--s-8))', width: 300, padding: 'var(--s-16)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
          <span className="ob-body-strong">{t(popoverTitleKey)}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="ob-icon-btn" aria-label={t('action.close')} title={t('action.close')} onClick={() => setSyncPopover(false)}>
            <Icon name="close" size={10} />
          </button>
        </div>
        <dl className="ob-kv" style={{ marginTop: 'var(--s-8)' }}>
          <dt>{t('sync.pendingChanges')}</dt>
          <dd className="ob-data">{pendingSync}</dd>
          <dt>{t('sync.panelsOnline')}</dt>
          <dd className="ob-data">
            {panels.length - offlinePanels}/{panels.length}
          </dd>
          <dt>{t('sync.lowStock')}</dt>
          <dd className="ob-data">{summary?.lowStockCount ?? 0}</dd>
        </dl>
        {openConflicts > 0 && (
          <div style={{ marginTop: 'var(--s-12)', paddingTop: 'var(--s-8)', borderTop: '1px solid var(--line)' }}>
            <button
              className="ob-btn ob-btn--ghost ob-btn--sm"
              style={{ color: 'var(--accent)' }}
              onClick={() => {
                setSyncPopover(false);
                setRoute('');
                setTab('conflicts');
              }}
            >
              {t('action.reviewConflicts')}
            </button>
          </div>
        )}
      </div>
    </>
  );

  const content = (() => {
    if (route === 'gallery') return <GalleryScreen />;

    switch (tab) {
      case 'dashboard':
        return (
          <DashboardScreen
            summary={summary}
            panels={panels}
            onOpenConflicts={() => setTab('conflicts')}
          />
        );
      case 'panels':
        return <PanelsScreen panels={panels} onRefresh={refreshPanels} />;
      case 'orders':
        return <LeadsOrdersScreen revision={dataRevision} />;
      case 'inventory':
        return <InventoryScreen revision={dataRevision} />;
      case 'access':
        return (
          <AccessScreen
            permissions={user.permissions}
            currentUserId={user.id}
            currentUserTier={user.roleTier}
          />
        );
      case 'conflicts':
        return (
          <ConflictsScreen revision={dataRevision} canResolve={user.permissions.includes('sync.resolveConflicts')} />
        );
      case 'settings':
        return <SettingsScreen />;
    }
  })();

  return (
    <SaveShortcutProvider>
      <FilterBarProvider>
        <AppShell
          groups={groups}
          activeId={activeId}
          onNavigate={(id) => {
            if (id === 'gallery') return;
            if (readHash()) window.history.replaceState(null, '', window.location.pathname + window.location.search);
            setRoute('');
            setTab(id as Tab);
          }}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((value) => !value)}
          topbar={topbar}
          filterbar={<FilterBarOutlet />}
          footer={footer}
          rail={railState}
          railLabel={syncLabel}
          onRailClick={() => setSyncPopover((open) => !open)}
          overlays={overlays}
        >
          {content}
        </AppShell>
      </FilterBarProvider>
    </SaveShortcutProvider>
  );
}
