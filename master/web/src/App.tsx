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
  MessageKey,
  OfficePanelWithPresence,
  RecycleBinEntityType,
  ReportKind,
  ServerToClientEvents,
  SignedInUser,
} from '@orderbook/shared';
import {
  RECYCLE_BIN_ENTITIES,
  RESTORE_PERMISSION,
  resolveCompanyFeatures,
} from '@orderbook/shared';

import { ApiError, api, desktopBridge } from './api';
import {
  adoptDefaultLocale,
  AppShell,
  Avatar,
  BP_NARROW,
  Clock,
  FilterBarOutlet,
  FilterBarProvider,
  GalleryScreen,
  Icon,
  IconButton,
  KeyboardOverlays,
  KeyboardProvider,
  PaletteButton,
  ConfirmProvider,
  onSessionEnded,
  ResetProvider,
  ScreenHost,
  Splash,
  SubNavProvider,
  ToastProvider,
  TopbarActionsOutlet,
  TopbarActionsProvider,
  flattenNav,
  graftSubNav,
  loadSidebarMode,
  requestSettingsTab,
  rem,
  storeSidebarMode,
  t,
  useClearSubNav,
  useMediaQuery,
  useResetGate,
  useSettingsTab,
  useSubNavState,
  splitSubPage,
  withSubPages,
  type NavGroup,
  type NavItem,
  type ScreenSpec,
  type SidebarMode,
  type SubPage,
} from '@orderbook/ui';
import { AccessScreen } from './screens/AccessScreen';
import { ConflictsScreen } from './screens/ConflictsScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { FieldsScreen } from './screens/FieldsScreen';
import { PartyAccessScreen } from './screens/PartyAccessScreen';
import { FirstRunScreen } from './screens/FirstRunScreen';
import { IntegrationsScreen } from './screens/IntegrationsScreen';
import { InventoryScreen } from './screens/InventoryScreen';
import { LeadsOrdersScreen } from './screens/LeadsOrdersScreen';
import { LogsScreen } from './screens/LogsScreen';
import { PanelsScreen } from './screens/PanelsScreen';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import { PartiesScreen } from './screens/PartiesScreen';
import { RecycleBinScreen } from './screens/RecycleBinScreen';
import { ReportsScreen } from './screens/ReportsScreen';
import { SETTINGS_TAB_IDS, SettingsScreen } from './screens/SettingsScreen';
import { UpdatesScreen } from './screens/UpdatesScreen';
import { SignInScreen } from './screens/SignInScreen';

type Phase = 'loading' | 'first-run' | 'signed-out' | 'ready';
type Tab =
  | 'dashboard'
  | 'panels'
  | 'orders'
  | 'parties'
  | 'inventory'
  | 'reports'
  | 'access'
  | 'partyAccess'
  | 'fields'
  | 'integrations'
  | 'logs'
  | 'recycleBin'
  | 'conflicts'
  | 'settings'
  | 'updates';
type Route = '' | 'gallery';
type RecycleBinType = RecycleBinEntityType | '';

/**
 * Which entities each screen's data is derived from.
 *
 * There used to be one counter and a six-entity allow-list in front of it, so
 * a change to an option list or a custom field moved nothing — those screens
 * simply never refetched — while a change to a lead made the Fields screen
 * refetch for no reason. A counter per entity fixes
 * both directions at once.
 *
 * Every key here is read by a screen below; a key nobody reads is a refresh
 * that silently never happens, which is what `access` was. `catalog` is the
 * one event a bulk import or the catalogue seed publishes in place of a
 * `product` per row (`ChangedEntity`), so it goes wherever `product` does —
 * except the Recycle Bin, since an import creates and updates but never
 * deletes. The Bin follows `option_list` and `custom_field` because its field
 * value and field definition branches are deleted and restored as those.
 */
const SCREEN_ENTITIES: Record<string, readonly string[]> = {
  records: ['lead', 'order', 'party', 'product', 'catalog', 'stock', 'reservation'],
  /** Leads & orders' stage picker, apart from `records` so a lead edit does not re-read it. */
  stages: ['pipeline'],
  /** `product_category` and `option_list` feed its Product filter and brand chips. */
  inventory: ['stock', 'product', 'catalog', 'reservation', 'product_category', 'option_list'],
  reports: ['lead', 'order', 'party', 'stock'],
  fields: ['option_list', 'custom_field', 'pipeline'],
  access: ['user', 'role'],
  partyAccess: ['party'],
  parties: ['party'],
  recycleBin: ['lead', 'order', 'party', 'product', 'role', 'user', 'option_list', 'custom_field'],
  conflicts: ['sync_conflict'],
  /** Settings' company rows, and apart from them the lead sources on its Leads tab. */
  settings: ['setting'],
  leadSources: ['option_list'],
};

/** One number that moves when any of the named entities does. */
function revisionOf(revisions: Record<string, number>, key: string): number {
  return (SCREEN_ENTITIES[key] ?? []).reduce(
    (total, entity) => total + (revisions[entity] ?? 0),
    0,
  );
}

/** The cold-start steps the splash reports, in the order they run. */
const BOOT_STEPS = ['server', 'session', 'assets'] as const;

/**
 * The route the location hash names, without the `#/` in front of it.
 *
 * The footer link writes `#/gallery`, so the slash is part of the hash. Taking
 * off only the `#` read that as `/gallery`, which is not `'gallery'` — and the
 * `hashchange` the link itself causes then closed the gallery its own click
 * had just opened.
 */
function readHash(): string {
  return window.location.hash.replace(/^#\/?/, '');
}

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SubNavProvider>
          <TopbarActionsProvider>
            <ResetProvider>
              <MasterPanel />
            </ResetProvider>
          </TopbarActionsProvider>
        </SubNavProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function MasterPanel() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  /** Why this window is at the sign-in screen, when it did not sign out itself. */
  const [signInNotice, setSignInNotice] = useState<MessageKey | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');
  /*
   * Which sub-page each module is showing, keyed by module. A screen's tabs
   * are offered from the sidebar too, and both controls read from here so
   * they never disagree. Settings keeps its own remembered tab (per machine,
   * validated against the tabs this panel has) through the same hook the
   * desktop menu's "Developer" request already lands in.
   */
  const [subKeys, setSubKeys] = useState<Record<string, string>>({});
  const [settingsTab, setSettingsTab] = useSettingsTab(
    'ob.settings.tab.master',
    SETTINGS_TAB_IDS,
    // The company settings, not the theme picker. Settings is reached from a
    // nav entry gated on `settings.manage`, so whoever opens it came to change
    // something the company decides — and landed on a per-desk preference.
    // `SettingsPage` falls back to the first tab for anyone without that
    // permission, and a remembered tab still wins for anyone who has chosen.
    'company',
  );

  const [panels, setPanels] = useState<OfficePanelWithPresence[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  // Incremented on every relevant change so screens that fetch their own data
  // know to refetch, without this shell having to model their state for them.
  const [revisions, setRevisions] = useState<Record<string, number>>({});

  // Shell chrome state.
  const [splashDone, setSplashDone] = useState(false);
  // Cold start: how many boot steps are behind us, and why we stopped if we did.
  const [bootStep, setBootStep] = useState(0);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [route, setRoute] = useState<Route>(readHash() === 'gallery' ? 'gallery' : '');
  /*
   * Three states, not two. 'auto' follows the window — which is what makes
   * 1024x768 usable without the operator having to do anything — while 'open'
   * and 'closed' are a deliberate override that sticks across restarts. The
   * shell still takes a plain boolean; resolving it here keeps `AppShell`
   * unaware that any of this exists.
   */
  const narrow = useMediaQuery(BP_NARROW);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => loadSidebarMode());
  const collapsed = sidebarMode === 'auto' ? narrow : sidebarMode === 'closed';

  function toggleSidebar(): void {
    // Toggling from 'auto' commits to the opposite of what auto currently
    // shows, which is what the click appears to promise.
    const next: SidebarMode = collapsed ? 'open' : 'closed';
    setSidebarMode(next);
    storeSidebarMode(next);
  }
  const [syncPopover, setSyncPopover] = useState(false);

  /*
   * A screen that has opened a large operation — the role editor, a person's
   * editor — publishes it here, and it hangs off its own module in the sidebar
   * (§8). The shell does not need to know what the operation *is*, only where
   * it belongs and how to leave it.
   *
   * One counter per screen sits beside it. Bumping it changes that screen's key
   * inside `ScreenHost`, so React remounts it — a total reset with no
   * cooperation needed from the screen itself.
   *
   * All four are declared **here**, above every early return, because that is
   * what the rules of hooks require. This component returns early for the
   * splash, for first run and for a signed-out session, so hooks below those
   * returns are called on some renders and not others: signing in went from N
   * hooks to N+4 and React threw "rendered more hooks than during the previous
   * render". The error boundary caught it, so the Master showed "Something went
   * wrong on this screen" the moment anybody signed in.
   */
  const subNav = useSubNavState(route === 'gallery' ? null : tab);
  const [resetNonce, setResetNonce] = useState<Record<string, number>>({});
  const askReset = useResetGate();
  const clearSubNav = useClearSubNav();

  // Cold start. Each step reports itself to the splash on the way past, and a
  // step that fails leaves a message there rather than an endless wait — which
  // is what "stuck on the starting screen" was: an unhandled rejection here
  // pinned `phase` on 'loading' with no way out but a reload.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setBootError(null);
      setBootStep(0);

      try {
        const { setupComplete } = await api.setupStatus();
        if (cancelled) return;
        setBootStep(1);

        if (!setupComplete) {
          setPhase('first-run');
        } else {
          try {
            const me = await api.me();
            if (cancelled) return;
            // Behind the splash, before the shell first renders: a fresh
            // browser profile on a Hindi deployment paints in Hindi rather
            // than starting English and staying there. Writes once — see
            // `adoptDefaultLocale`.
            adoptDefaultLocale(me.defaultLocale);
            setUser(me.user);
            setSessionToken(me.sessionToken);
            setPhase('ready');
          } catch {
            // No session, or one the server no longer honours. That is the
            // sign-in screen, not a failure to start.
            if (cancelled) return;
            setPhase('signed-out');
          }
        }
        setBootStep(2);

        // Waited on deliberately: painting the shell in a fallback face and
        // reflowing into Inter a moment later is worse than one more frame of
        // splash. Already resolved on a warm start.
        await document.fonts.ready;
        if (cancelled) return;
        setBootStep(3);
      } catch (caught) {
        if (cancelled) return;
        // A *coded* `ApiError` carries a message meant for a reader — our own
        // 'timeout', or something the server explained. Everything else is a
        // transport failure or an unstructured 500, whose message is the
        // generic `error.requestFailed` and helps nobody.
        setBootError(
          caught instanceof ApiError && caught.code !== 'internal_error'
            ? caught.message
            : t('splash.error.unreachable'),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bootAttempt]);

  /*
   * The session can end without this window doing anything: an administrator
   * deactivates the account, the server restarts, or — the common one — this
   * person changes their own password, which invalidates every session they
   * hold including this one. `api.ts` publishes it from the single place every
   * request passes through; all this has to do is stop rendering a signed-in
   * shell and say why.
   */
  useEffect(
    () =>
      onSessionEnded((reason) => {
        setUser(null);
        setSessionToken(null);
        // Whoever signs in next at this window starts on the Dashboard, as
        // after `signOut` — see there.
        setTab('dashboard');
        setSignInNotice(reason);
        setPhase('signed-out');
      }),
    [],
  );

  /*
   * Permissions and feature switches ride on the signed-in user; a company
   * setting that changes either is re-read rather than waited out to a reload.
   *
   * Declared above the socket effect on purpose. That effect's dependency
   * array is evaluated during render, so a `const` below it would be read in
   * its temporal dead zone — a crash on every render, not a stale value.
   */
  const refreshUser = useCallback(() => {
    void api
      .me()
      .then((me) => setUser(me.user))
      .catch(() => undefined);
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
    const bump = (entity: string): void =>
      setRevisions((current) => ({ ...current, [entity]: (current[entity] ?? 0) + 1 }));

    // Every entity, unconditionally. The old allow-list is what made a per-entity
    // counter pointless for exactly the screens that most needed one.
    socket.on('data:changed', (event) => {
      bump(event.entity);
      // A company switch is not a row any screen counts — it rides on the
      // signed-in user as `features`, and until now only *this* browser's own
      // save refreshed it. A second administrator's flip left this one drawing
      // the old shape with no way to notice.
      if (event.entity === 'setting') refreshUser();
    });

    // A merge shadowed somebody's value; the conflicts screen and the dashboard
    // counter both need to move. It arrives on its own channel, so it gets a
    // synthetic key rather than riding on some other entity's counter.
    socket.on('sync:conflict', () => bump('sync_conflict'));

    return () => {
      socket.close();
    };
  }, [phase, sessionToken, refreshUser]);

  // Stable, or every boot-step render would hand Splash a new callback and
  // restart its hold timer.
  const markSplashDone = useCallback(() => setSplashDone(true), []);

  /*
   * The company's switches, every absence resolved to the setting's own
   * declared fallback, once, here. A Master built before a switch existed sends
   * a `features` without it, so the panels coalesce at their edge and pass
   * plain values inward — a shared screen never has to know it might be
   * missing, and no screen writes its own `?? true` to drift from `settings.ts`.
   */
  const companyFeatures = resolveCompanyFeatures(user?.features);

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
    /*
     * The screen is not the next person's. `ScreenHost` draws `tab` whether or
     * not the sidebar offers it — `navigate` is what keeps an unoffered screen
     * out of `tab` — and signing in again renders this same component, so the
     * tab an administrator signed out from was the first screen a salesperson
     * signing in after them saw: Office panels, under a title naming nothing.
     */
    setTab('dashboard');
  }

  // The splash owns the whole cold start now — the minimum hold, the boot
  // itself, and anything that went wrong with it. There is no second
  // "Starting…" screen behind it to get stranded on.
  if (!splashDone || bootStep < BOOT_STEPS.length || bootError) {
    return (
      <Splash
        wordmark={t('app.name')}
        progress={bootStep / BOOT_STEPS.length}
        label={t(`splash.step.${BOOT_STEPS[bootStep] ?? 'ready'}`)}
        error={bootError}
        retryLabel={t('action.retryNow')}
        onRetry={() => setBootAttempt((attempt) => attempt + 1)}
        onDone={markSplashDone}
      />
    );
  }

  if (phase === 'first-run') {
    return <FirstRunScreen onComplete={() => setPhase('signed-out')} />;
  }

  if (phase === 'signed-out' || !user) {
    return (
      <SignInScreen
        notice={signInNotice}
        onSignedIn={(signedInUser, token) => {
          setUser(signedInUser);
          setSessionToken(token);
          setSignInNotice(null);
          setPhase('ready');
        }}
      />
    );
  }

  // ---- Presence rail (§4.8): the Master's aggregate across its panels.
  const openConflicts = summary?.openConflictCount ?? 0;
  const pendingSync = summary?.pendingSyncCount ?? 0;
  const offlinePanels = panels.filter((panel) => !panel.isConnected).length;
  const canManageRoles =
    user.permissions.includes('roles.view') || user.permissions.includes('users.manage');
  const canManagePanels = user.permissions.includes('panels.manage');
  const canManageSettings = user.permissions.includes('settings.manage');
  const canManageApi = user.permissions.includes('api.manage');
  const canViewFields = user.permissions.includes('fields.view');
  // Either key opens the screen: `party.assign` to redraw the map,
  // `party.accessAll` to read it. Somebody trusted with the whole book should
  // be able to see how it is divided without also being able to change it.
  const canViewPartyAccess =
    user.permissions.includes('party.assign') || user.permissions.includes('party.accessAll');
  // Parties are read by anyone who can reach a lead — the list is the same
  // book the Office Panel browses. Creating and editing are gated inside the
  // screen on their own permissions.
  const canViewParties = user.permissions.includes('parties.view');
  const canViewLogs = user.permissions.includes('logs.view');
  const canViewRecycleBin = user.permissions.includes('recycleBin.view');
  const canViewReports = user.permissions.includes('reports.view');

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
    canViewParties ? { id: 'parties', label: t('nav.master.parties'), icon: 'parties' } : null,
    {
      id: 'inventory',
      label: t('nav.master.inventory'),
      icon: 'inventory',
      count:
        summary?.lowStockCount && summary.lowStockCount > 0 ? summary.lowStockCount : undefined,
    },
    // Reports sit under Work rather than Admin: a report is something a manager
    // produces during the day, not a setting anyone administers.
    canViewReports ? { id: 'reports', label: t('nav.master.reports'), icon: 'calendar' } : null,
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
    canViewPartyAccess
      ? { id: 'partyAccess', label: t('nav.master.partyAccess'), icon: 'parties' }
      : null,
    canViewFields ? { id: 'fields', label: t('nav.master.fields'), icon: 'filter' } : null,
    canViewLogs ? { id: 'logs', label: t('nav.master.logs'), icon: 'eye' } : null,
    canViewRecycleBin
      ? { id: 'recycleBin', label: t('nav.master.recycleBin'), icon: 'trash' }
      : null,
    canManageApi
      ? { id: 'integrations', label: t('nav.master.integrations'), icon: 'server' }
      : null,
    canManageSettings
      ? { id: 'settings', label: t('nav.master.settings'), icon: 'settings' }
      : null,
    // Visible to everyone: which version a machine runs is not privileged
    // information, and the person asked to read it out is rarely an admin.
    { id: 'updates', label: t('nav.updates'), icon: 'sync' },
  ];

  async function resetActiveScreen(): Promise<void> {
    if (route === 'gallery') return;
    // Awaited now: asking is a themed dialog rather than a renderer-blocking
    // `window.confirm`, so the answer arrives a turn later.
    if (!(await askReset())) return;
    // The screen is going away, so its sidebar entry must go with it — the
    // registry deliberately does not clear itself on teardown any more.
    clearSubNav(tab);
    setResetNonce((current) => ({ ...current, [tab]: (current[tab] ?? 0) + 1 }));
  }

  /*
   * The sub-pages each module offers from the sidebar: its tabs, views or
   * slices, exactly as the screen itself offers them. A module absent from
   * here is a single page and gets no fold. Permission-gated tabs are gated
   * here the same way, so the sidebar never offers a page the screen would
   * refuse to show.
   */
  const subPages: Record<string, SubPage[]> = {
    orders: [
      { key: 'leads', label: t('leadsOrders.tab.leads'), icon: 'leads' },
      { key: 'orders', label: t('leadsOrders.tab.orders'), icon: 'orders' },
      { key: 'converted', label: t('leadsOrders.tab.converted'), icon: 'check' },
    ],
    inventory: [
      { key: 'all', label: t('inventory.filter.all'), icon: 'inventory' },
      { key: 'low', label: t('inventory.filter.lowOnly'), icon: 'warning' },
    ],
    reports: [
      { key: 'dispatches', label: t('reports.tab.dispatches'), icon: 'upload' },
      { key: 'lead-outcomes', label: t('reports.tab.leadOutcomes'), icon: 'leads' },
      { key: 'top-parties', label: t('reports.tab.topParties'), icon: 'parties' },
    ],
    access: [
      ...(user.permissions.includes('users.manage')
        ? [{ key: 'users', label: t('access.tab.users'), icon: 'parties' as const }]
        : []),
      ...(user.permissions.includes('roles.view')
        ? [{ key: 'roles', label: t('access.tab.roles'), icon: 'shield' as const }]
        : []),
    ],
    partyAccess: [
      { key: 'all', label: t('partyAccess.filter.all'), icon: 'parties' },
      { key: 'restricted', label: t('partyAccess.filter.restricted'), icon: 'shield' },
      { key: 'open', label: t('partyAccess.filter.open'), icon: 'eye' },
    ],
    fields: [
      { key: 'values', label: t('fields.tab.values'), icon: 'filter' },
      { key: 'definitions', label: t('fields.tab.definitions'), icon: 'edit' },
      { key: 'stages', label: t('fields.tab.stages'), icon: 'orders' },
    ],
    recycleBin: [
      { key: 'all', label: t('recycleBin.filter.allTypes'), icon: 'trash' },
      ...RECYCLE_BIN_ENTITIES.filter((branch) =>
        user.permissions.includes(RESTORE_PERMISSION[branch]),
      ).map((branch) => ({
        key: branch,
        label: t(`recycleBin.entity.${branch}`),
        icon: 'trash' as const,
      })),
    ],
    integrations: [
      { key: 'keys', label: t('integrations.tab.keys'), icon: 'shield' },
      { key: 'connectors', label: t('integrations.tab.connectors'), icon: 'server' },
    ],
    settings: SETTINGS_TAB_IDS.map((id) => ({
      key: id,
      label: t(`settings.tab.${id}`),
      icon: 'settings' as const,
    })),
  };

  /** The sub-page a module is showing: the chosen one, else its first. */
  const subKeyOf = (module: string): string =>
    module === 'settings' ? settingsTab : (subKeys[module] ?? subPages[module]?.[0]?.key ?? '');

  function selectSubPage(module: string, key: string): void {
    if (module === 'settings') setSettingsTab(key);
    else setSubKeys((current) => ({ ...current, [module]: key }));
  }

  const nest = (items: Array<NavItem | null>): NavItem[] =>
    graftSubNav(
      withSubPages(
        items.filter((item): item is NavItem => item !== null),
        subPages,
      ),
      subNav,
    );

  const groups: NavGroup[] = [
    { label: t('nav.master.work'), items: nest(workItems) },
    { label: t('nav.master.admin'), items: nest(adminItems) },
  ];

  const activeId = subNav
    ? subNav.activeId
    : route === 'gallery'
      ? 'gallery'
      : subPages[tab]?.length
        ? `${tab}.${subKeyOf(tab)}`
        : tab;
  const flatItems = groups.flatMap((group) => flattenNav(group.items));
  /** Whether the sidebar offers this person the screen — navigation's gate and the palette's. */
  function offered(id: string): boolean {
    return flatItems.some((item) => item.id === id);
  }
  const activeLabel =
    route === 'gallery' && !subNav
      ? t('footer.designSystem')
      : (flatItems.find((item) => item.id === activeId)?.label ?? t('app.panel'));

  /**
   * Leaving wherever we are. An open operation gets asked first: it may hold an
   * unsaved draft, and it answers false to keep the operator where they are
   * rather than discarding it on the way out.
   */
  function navigate(id: string): void {
    // Already here. Selecting the open operation's own entry is a no-op, not a
    // reason to ask about discarding its draft.
    if (subNav?.items.some((item) => item.id === id)) return;
    /*
     * Only somewhere the sidebar offers this person. The sidebar is not the
     * only way in: Alt+N and the palette's nav commands arrive here for every
     * screen in `MASTER_NAV`, admin screens included, and without this a role
     * with no `panels.manage` opened Office panels with Alt+6. The server still
     * refuses the calls; this keeps the panel from drawing the screen at all.
     */
    if (!offered(id)) return;
    openScreen(id);
  }

  /**
   * Shows a screen without asking whether the sidebar offers it — for the one
   * caller entitled to that, the desktop menu's Developer entry (see below).
   */
  function openScreen(id: string): void {
    /*
     * No "are you sure" on the way out any more. Leaving an open editor used
     * to unmount it and throw its draft away, so the shell had to ask; now the
     * screen stays exactly as it was and is still there when you come back.
     * The deliberate discard is the Reset button.
     */
    if (id === 'gallery') return;
    if (readHash())
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setRoute('');
    // A sub-page is its module's screen, showing that page.
    const sub = splitSubPage(id);
    if (sub && subPages[sub.module]?.some((page) => page.key === sub.key)) {
      selectSubPage(sub.module, sub.key);
      setTab(sub.module as Tab);
      return;
    }
    setTab(id as Tab);
  }

  const topbar = (
    <>
      <h1 className="ob-title" style={{ marginRight: 'var(--s-4)' }}>
        {activeLabel}
      </h1>
      <span style={{ flex: 1 }} />
      {/* The screen's own control sits inside the app-wide ones: Search and
          Sign out mean the same thing on every screen, this does not. */}
      <TopbarActionsOutlet />
      <IconButton
        icon="reset"
        label={t('screen.reset')}
        title={t('screen.resetHint')}
        onClick={() => void resetActiveScreen()}
      />
      <PaletteButton />
      {/* Beside Sign out, because the two are the same kind of thing — what you
          do with your own account — and the topbar is on every screen. */}
      <button className="ob-btn ob-btn--ghost" onClick={() => setChangingPassword(true)}>
        {t('action.changePassword')}
      </button>
      <button className="ob-btn ob-btn--ghost" onClick={() => void signOut()}>
        {t('action.signOut')}
      </button>
    </>
  );

  const footer = (
    <>
      <button
        type="button"
        className="ob-footer-sync"
        style={{ color: 'inherit' }}
        onClick={() => setSyncPopover((open) => !open)}
      >
        <span className="dot" style={{ background: railDotColour }} />
        {syncLabel}
      </button>
      <span style={{ flex: 1 }} />
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-6)' }}>
        <Avatar name={user.displayName} avatar={user.avatar} size="xs" />
        {t('footer.signedInAs', { name: user.username, role: user.roleName })}
      </span>
      <a
        href="#/gallery"
        onClick={() => setRoute('gallery')}
        style={{ color: 'var(--fg-tertiary)' }}
      >
        {t('footer.designSystem')}
      </a>
      <span className="ob-mono" style={{ fontSize: rem(10.5), color: 'var(--fg-tertiary)' }}>
        v{__APP_VERSION__}
      </span>
      <Clock />
    </>
  );

  const syncOverlay = syncPopover && (
    <>
      {/* Click-away shim keeps the popover honest without a portal. */}
      <div
        // One below the popover it backs, not level with it: the popover now
        // carries `--z-popover` itself, and a shim at the same level painted
        // over it and ate every click inside.
        style={{ position: 'absolute', inset: 0, zIndex: 'calc(var(--z-popover) - 1)' }}
        onClick={() => setSyncPopover(false)}
      />
      <div
        className="ob-popover"
        style={{
          left: 'var(--s-12)',
          bottom: 'calc(var(--shell-footer-h) + var(--s-8))',
          width: rem(300),
          padding: 'var(--s-16)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
          <span className="ob-body-strong">{t(popoverTitleKey)}</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="ob-icon-btn"
            aria-label={t('action.close')}
            title={t('action.close')}
            onClick={() => setSyncPopover(false)}
          >
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
          <div
            style={{
              marginTop: 'var(--s-12)',
              paddingTop: 'var(--s-8)',
              borderTop: '1px solid var(--line)',
            }}
          >
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

  /*
   * Every screen, not just the current one.
   *
   * `ScreenHost` keeps the ones you have visited mounted and hides the rest,
   * so a tab you come back to still holds its filters, its scroll position and
   * its half-typed form. This was a `switch (tab)` returning a single element,
   * which unmounted the outgoing screen and threw all of that away.
   */
  const screens: ScreenSpec[] = [
    {
      id: 'dashboard',
      render: () => (
        <DashboardScreen
          summary={summary}
          panels={panels}
          onOpenConflicts={() => setTab('conflicts')}
        />
      ),
    },
    { id: 'panels', render: () => <PanelsScreen panels={panels} onRefresh={refreshPanels} /> },
    {
      id: 'parties',
      render: () => (
        <PartiesScreen revision={revisionOf(revisions, 'parties')} permissions={user.permissions} />
      ),
    },
    {
      id: 'orders',
      render: () => (
        <LeadsOrdersScreen
          revision={revisionOf(revisions, 'records')}
          stagesRevision={revisionOf(revisions, 'stages')}
          permissions={user.permissions}
          packagingRequired={companyFeatures.packagingRequiredOnConvert}
          view={subKeyOf('orders') as 'leads' | 'orders' | 'converted'}
          onViewChange={(view) => selectSubPage('orders', view)}
        />
      ),
    },
    {
      id: 'inventory',
      render: () => (
        <InventoryScreen
          revision={revisionOf(revisions, 'inventory')}
          filter={subKeyOf('inventory') as 'all' | 'low'}
          onFilterChange={(filter) => selectSubPage('inventory', filter)}
          freeToSell={companyFeatures.freeToSell}
          adjustmentNoteRequired={companyFeatures.adjustmentNoteRequired}
        />
      ),
    },
    {
      id: 'reports',
      render: () => (
        <ReportsScreen
          revision={revisionOf(revisions, 'reports')}
          permissions={user.permissions}
          kind={subKeyOf('reports') as ReportKind}
          onKindChange={(kind) => selectSubPage('reports', kind)}
        />
      ),
    },
    {
      id: 'access',
      render: () => (
        <AccessScreen
          revision={revisionOf(revisions, 'access')}
          permissions={user.permissions}
          currentUserId={user.id}
          currentUserTier={user.roleTier}
          tab={subKeyOf('access') as 'users' | 'roles'}
          onTabChange={(next) => selectSubPage('access', next)}
        />
      ),
    },
    {
      id: 'partyAccess',
      render: () => (
        <PartyAccessScreen
          permissions={user.permissions}
          revision={revisionOf(revisions, 'partyAccess')}
          restriction={subKeyOf('partyAccess') as 'all' | 'open' | 'restricted'}
          onRestrictionChange={(next) => selectSubPage('partyAccess', next)}
        />
      ),
    },
    {
      id: 'fields',
      render: () => (
        <FieldsScreen
          permissions={user.permissions}
          revision={revisionOf(revisions, 'fields')}
          tab={subKeyOf('fields') as 'values' | 'definitions' | 'stages'}
          onTabChange={(next) => selectSubPage('fields', next)}
        />
      ),
    },
    { id: 'logs', render: () => <LogsScreen permissions={user.permissions} /> },
    {
      id: 'recycleBin',
      render: () => (
        <RecycleBinScreen
          permissions={user.permissions}
          revision={revisionOf(revisions, 'recycleBin')}
          type={(subKeyOf('recycleBin') === 'all' ? '' : subKeyOf('recycleBin')) as RecycleBinType}
          onTypeChange={(next) => selectSubPage('recycleBin', next === '' ? 'all' : next)}
        />
      ),
    },
    {
      id: 'conflicts',
      render: () => (
        <ConflictsScreen
          revision={revisionOf(revisions, 'conflicts')}
          canResolve={user.permissions.includes('sync.resolveConflicts')}
        />
      ),
    },
    {
      id: 'updates',
      render: () => <UpdatesScreen panels={panels} permissions={user.permissions} />,
    },
    {
      id: 'integrations',
      render: () => (
        <IntegrationsScreen
          canManage={canManageApi}
          tab={subKeyOf('integrations') as 'keys' | 'connectors'}
          onTabChange={(next) => selectSubPage('integrations', next)}
        />
      ),
    },
    {
      id: 'settings',
      render: () => (
        <SettingsScreen
          tab={settingsTab}
          onTabChange={setSettingsTab}
          onSaved={refreshUser}
          permissions={user.permissions}
          settingsRevision={revisionOf(revisions, 'settings')}
          sourcesRevision={revisionOf(revisions, 'leadSources')}
        />
      ),
    },
  ];

  /*
   * The gallery is a separate `route`, not a `Tab`, and is reachable only by
   * URL — so it stays outside the host rather than becoming a screen that can
   * never be navigated to and would sit mounted for ever once visited.
   */
  const content =
    route === 'gallery' ? (
      <div className="ob-pane">
        <GalleryScreen />
      </div>
    ) : (
      <ScreenHost screens={screens} activeId={tab} resetNonce={resetNonce} />
    );

  const overlays = (
    <>
      <KeyboardOverlays
        subscribeMenu={(handler) =>
          desktopBridge()?.onMenuCommand?.((id) => {
            /*
             * `settings.developer` is not a keyboard command and never will be
             * — there is no chord for it — so it is answered here rather than
             * in the palette's own whitelist, which only knows `COMMANDS`.
             *
             * The Settings *nav entry* needs `settings.manage`; the Settings
             * *screen* does not, and neither does developer mode, which is
             * guarded by a password precisely so it does not depend on a
             * permission somebody could hand out. So the screen opens for
             * anyone the shell's menu asks — through `openScreen`, because
             * `navigate` refuses what the sidebar does not offer — the tabs
             * they may not see are absent from it, and the sidebar simply
             * highlights nothing.
             */
            if (id === 'settings.developer') {
              openScreen('settings');
              requestSettingsTab('developer');
              return;
            }
            handler(id);
          })
        }
        searchRecords={async (term) => ({ hits: await api.search(term) })}
        onOpenRecord={(hit) => {
          // Route the hit to the screen that owns it — which is exactly what
          // `parent_type`/`parent_id` on a line-item hit are for.
          if (hit.kind === 'lead_line' || hit.kind === 'order_line') setTab('orders');
          else if (hit.kind === 'product') setTab('inventory');
        }}
      />
      {syncOverlay}
      <ChangePasswordDialog open={changingPassword} onClose={() => setChangingPassword(false)} />
    </>
  );

  return (
    <KeyboardProvider
      panel="master"
      userId={user?.id ?? null}
      onNavigate={navigate}
      canNavigate={offered}
      shellCommands={{
        'view.reset': () => void resetActiveScreen(),
        // F5 is swallowed by the desktop shell so it cannot bypass the panel;
        // binding it here gives the key back its ordinary meaning, and in a
        // browser tab this does exactly what the browser would have done.
        'view.refresh': () => window.location.reload(),
      }}
    >
      <FilterBarProvider>
        <AppShell
          groups={groups}
          activeId={activeId}
          onNavigate={navigate}
          collapsed={collapsed}
          onToggleCollapsed={toggleSidebar}
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
    </KeyboardProvider>
  );
}
