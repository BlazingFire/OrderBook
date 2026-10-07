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

import { useCallback, useEffect, useState, type ComponentProps } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  ChatRecordChip,
  ChatRecordRef,
  DashboardSummary,
  MessageKey,
  OfficePanelWithPresence,
  Pipeline,
  RecycleBinEntityType,
  ReportKind,
  ServerToClientEvents,
  SignedInUser,
} from '@orderbook/shared';
import {
  isLongOffline,
  recordNumber,
  offeredReportKinds,
  RECYCLE_BIN_ENTITIES,
  REPORT_ENTITIES,
  REPORT_META,
  reportsOffered,
  canRestoreBinType,
  resolveCompanyFeatures,
  SERVER_MASTER_TIER,
} from '@orderbook/shared';

import { ApiError, api, desktopBridge, invalidateReads, requestCache } from './api';
import { todayForNotices } from './noticeToday';
import { useNotices } from './useNotices';
import { dispatchChat, masterChatTransport } from './chatTransport';
import { attachPrintSocket, dispatchPrint, masterPrintroomTransport } from './printroomTransport';
import { presenceChannel } from './presence';
import { optionListTransport, reportsTransport } from './transports';
import {
  AppShell,
  Avatar,
  BasicHome,
  cardNotices,
  NoticeDashboardCard,
  SignInNotices,
  createBurstBatcher,
  BP_NARROW,
  PrintStationRunner,
  FilterBarOutlet,
  FilterBarProvider,
  Icon,
  IconButton,
  KeyboardOverlays,
  landingScreen,
  lazyScreen,
  KeyboardProvider,
  NotificationBell,
  PRESENCE_TAB_ID,
  recordNumberText,
  notificationText,
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
  TopbarTitle,
  flattenNav,
  graftSubNav,
  loadSidebarMode,
  rem,
  storeSidebarMode,
  t,
  useChatUnread,
  usePrintWaiting,
  useClearSubNav,
  useMediaQuery,
  useToast,
  useResetGate,
  useSettingsTab,
  useSubNavState,
  splitSubPage,
  withSubPages,
  type CatalogListsPage,
  type ChatPage,
  type PrintPage,
  type ChatRecordOption,
  type NavGroup,
  type NavItem,
  type NotificationTransport,
  type ScreenSpec,
  type SidebarMode,
  type SubPage,
  NAV_ICONS,
  setCreatedPartiesPrivate,
  useConfirm,
  requestSettingsTab,
} from '@orderbook/ui';
/** The real components are loaded on first visit (below); these are only for their prop types. */
import type {
  CatalogListsScreen as CatalogListsScreenImpl,
  ChatroomScreen as ChatroomScreenImpl,
  PrintroomScreen as PrintroomScreenImpl,
  ReportsScreen as ReportsScreenImpl,
} from '@orderbook/ui';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import { DashboardScreen } from './screens/DashboardScreen';
import { NoticeBoardScreen } from './screens/NoticeBoardScreen';
import { NoticeManageScreen } from './screens/NoticeManageScreen';
import { FirstRunScreen } from './screens/FirstRunScreen';
import { LeadEntry } from './screens/LeadEntry';
import { LeadsScreen } from './screens/LeadsScreen';
import { OrdersScreen } from './screens/OrdersScreen';
import { PartiesScreen } from './screens/PartiesScreen';
import { ProductsScreen, type ProductsPage } from './screens/ProductsScreen';
import { SignInScreen } from './screens/SignInScreen';
import { SETTINGS_TAB_IDS, settingsTabIdsFor } from './settingsTabs';

/*
 * Screens most people open rarely, loaded on first visit rather than at
 * start-up (`ScreenHost` shows the loading mark meanwhile). The landing and
 * daily screens above stay in the first bundle, so signing in and the daily
 * path never wait on a fetch.
 */
const AccessScreen = lazyScreen(() => import('./screens/AccessScreen'), 'AccessScreen');
const ChatroomScreen = lazyScreen<
  'ChatroomScreen',
  ComponentProps<typeof ChatroomScreenImpl>
>(
  () => import('@orderbook/ui/lazy/ChatroomScreen'),
  'ChatroomScreen',
);
const PrintroomScreen = lazyScreen<
  'PrintroomScreen',
  ComponentProps<typeof PrintroomScreenImpl>
>(
  () => import('@orderbook/ui/lazy/PrintroomScreen'),
  'PrintroomScreen',
);
const ReportsScreen = lazyScreen<
  'ReportsScreen',
  ComponentProps<typeof ReportsScreenImpl>
>(
  () => import('@orderbook/ui/lazy/ReportsScreen'),
  'ReportsScreen',
);
const GalleryScreen = lazyScreen<
  'GalleryScreen',
  object
>(
  () => import('@orderbook/ui/lazy/GalleryScreen'),
  'GalleryScreen',
);
const CatalogListsScreen = lazyScreen<
  'CatalogListsScreen',
  ComponentProps<typeof CatalogListsScreenImpl>
>(
  () => import('@orderbook/ui/lazy/CatalogListsScreen'),
  'CatalogListsScreen',
);
const ConflictsScreen = lazyScreen(() => import('./screens/ConflictsScreen'), 'ConflictsScreen');
const FieldsScreen = lazyScreen(() => import('./screens/FieldsScreen'), 'FieldsScreen');
const IntegrationsScreen = lazyScreen(
  () => import('./screens/IntegrationsScreen'),
  'IntegrationsScreen',
);
const LogsScreen = lazyScreen(() => import('./screens/LogsScreen'), 'LogsScreen');
const PanelsScreen = lazyScreen(() => import('./screens/PanelsScreen'), 'PanelsScreen');
const PartyAccessScreen = lazyScreen(
  () => import('./screens/PartyAccessScreen'),
  'PartyAccessScreen',
);
const RecycleBinScreen = lazyScreen(() => import('./screens/RecycleBinScreen'), 'RecycleBinScreen');
const SettingsScreen = lazyScreen(() => import('./screens/SettingsScreen'), 'SettingsScreen');
const UpdatesScreen = lazyScreen(() => import('./screens/UpdatesScreen'), 'UpdatesScreen');

type Phase = 'loading' | 'first-run' | 'signed-out' | 'ready';
type Tab =
  | 'basicHome'
  | 'dashboard'
  | 'panels'
  | 'leads'
  | 'addLead'
  | 'orders'
  | 'products'
  | 'parties'
  | 'reports'
  | 'access'
  | 'partyAccess'
  | 'lists'
  | 'fields'
  | 'integrations'
  | 'logs'
  | 'recycleBin'
  | 'conflicts'
  | 'chatroom'
  | 'printroom'
  | 'notices'
  | 'noticesManage'
  | 'settings'
  | 'updates';
type Route = '' | 'gallery';
/** The record each list module has open as a sub-screen, by module. */
interface OpenIds {
  leads: string | null;
  orders: string | null;
  parties: string | null;
}
const NO_OPEN_IDS: OpenIds = { leads: null, orders: null, parties: null };
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
/** Screens whose open record publishes a sidebar label; signing out must not leave them for the next user. */
const SUB_NAV_SCREENS = [
  'leads', 'orders', 'parties', 'panels', 'logs', 'access', 'products', 'addLead', 'chatroom', 'printroom',
] as const;

const SCREEN_ENTITIES: Record<string, readonly string[]> = {
  records: ['lead', 'order', 'party', 'party_bulk', 'product', 'catalog', 'option_list'],
  /** Pending and Final Orders stage pages, apart from `records` so a lead edit does not re-read it. */
  stages: ['pipeline'],
  /** The New / Edit pending order form: what `/api/lead-entry` is built from. */
  leadEntry: ['option_list', 'party', 'party_bulk', 'party_variant', 'product', 'catalog', 'setting'],
  /**
   * The Products module, in two slices so a lead edit reads neither: the
   * products and their sub products (`catalog` is the one event a bulk import
   * publishes), and the option lists the brand chips and colour swatches read.
   */
  catalogue: ['product', 'catalog', 'product_category'],
  catalogueLists: ['option_list'],
  reports: REPORT_ENTITIES,
  fields: ['option_list', 'custom_field', 'pipeline'],
  access: ['user', 'role'],
  /** The notice board and its management screen, and the Dashboard card and the sidebar badge built from them. */
  notices: ['notice'],
  partyAccess: ['party', 'party_bulk'],
  parties: ['party', 'party_bulk', 'party_variant'],
  recycleBin: [
    'lead',
    'order',
    'party', 'party_bulk',
    'product',
    'product_category',
    'role',
    'user',
    'option_list',
    'custom_field',
  ],
  conflicts: ['sync_conflict'],
  /** Settings' company rows, and apart from them the lead sources on its Leads tab. */
  settings: ['setting'],
  leadSources: ['option_list'],
};

/**
 * One number that moves when any of the named entities does — and when the
 * socket comes back after a drop (`'*'`), since changes made meanwhile were
 * never pushed and every screen has to read again.
 */
function revisionOf(revisions: Record<string, number>, key: string): number {
  return (SCREEN_ENTITIES[key] ?? []).reduce(
    (total, entity) => total + (revisions[entity] ?? 0),
    revisions['*'] ?? 0,
  );
}

/** Change events inside this window move a screen's revision once (see the `bump` in the socket effect). */
const REVISION_BATCH_MS = 80;

/** How long a refused socket waits before it tries again (the server said no, not nothing). */
const REFUSED_RETRY_MS = 5_000;

/** The bell reads the signed-in person's notices from this server. */
const notificationTransport: NotificationTransport = {
  list: () => api.notifications(),
  markRead: (which) => api.markNotificationsRead(which),
};

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
  // A party this person creates is theirs and the administrators' until shared (the party form says so).
  useEffect(() => {
    setCreatedPartiesPrivate(user !== null && !user.permissions.includes('party.accessAll'));
  }, [user]);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  /** Why this window is at the sign-in screen, when it did not sign out itself. */
  const [signInNotice, setSignInNotice] = useState<MessageKey | null>(null);
  // Set to the person's landing screen at sign-in and on the boot restore.
  const [tab, setTab] = useState<Tab>('basicHome');
  /** The company's name for the footer, from `/api/setup/status`; null until set up. */
  const [companyName, setCompanyName] = useState<string | null>(null);
  /*
   * From the same status read: whether this window is on the Master PC, and
   * whether the installation still owes its owner two Server Masters. Together
   * they decide whether sign-in shows the master-key setup flow first.
   */
  const [onMasterPc, setOnMasterPc] = useState(false);
  const [serverMasterSetupNeeded, setServerMasterSetupNeeded] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  /** Bumped each time New pending order is asked for, so the form can take the cursor when blank. */
  const [newLeadNonce, setNewLeadNonce] = useState(0);
  // Above the early returns: the topbar button, the sub-page and Ctrl+Shift+N all read it.
  const canCreateLead = user?.permissions.includes('leads.create') ?? false;
  /*
   * Which sub-page each module is showing, keyed by module. A screen's tabs
   * are offered from the sidebar too, and both controls read from here so
   * they never disagree. Settings keeps its own remembered tab (per machine,
   * validated against the tabs this panel has) through its own hook.
   */
  const [subKeys, setSubKeys] = useState<Record<string, string>>({});
  /*
   * The record each list module has open as a sub-screen, held here so a search
   * hit or a link from another screen can open one. Declared with the other
   * hooks above the early returns, like every hook in this component.
   */
  const [openIds, setOpenIds] = useState<OpenIds>(NO_OPEN_IDS);
  /** The chat room open as a sub-screen (a notification or a search hit can open one), and the record being shared. */
  const [chatOpen, setChatOpen] = useState<{ id: string; seq?: number } | null>(null);
  const [chatShare, setChatShare] = useState<ChatRecordChip | null>(null);
  /** Bumped when the sidebar picks a Chatroom page, so a settings sub-screen left open closes. */
  const [chatResetNonce, setChatResetNonce] = useState(0);
  /** The Printroom job open as a sub-screen (the bell can open one), and the nonce the sidebar bumps to close it. */
  const [printOpen, setPrintOpen] = useState<string | null>(null);
  const [printResetNonce, setPrintResetNonce] = useState(0);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [settingsTab, setSettingsTab] = useSettingsTab(
    'ob.settings.tab.master',
    SETTINGS_TAB_IDS,
    // The company settings, not the theme picker, for whoever manages them: they
    // came to change something the company decides. Everyone else is shown
    // Appearance instead (`shownSettingsTab`, below), and a remembered tab
    // still wins for anyone who has chosen one their role offers.
    'company',
  );

  const [panels, setPanels] = useState<OfficePanelWithPresence[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  // Incremented on every relevant change so screens that fetch their own data
  // know to refetch, without this shell having to model their state for them.
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  /*
   * Whether this window's socket to the Master server is up. The server is on
   * the same PC or the LAN, but it restarts for an update, and a window left
   * open across that used to go on showing a frozen picture as if live.
   */
  const [linkUp, setLinkUp] = useState(true);
  /** Moves with each notice pushed to this person, so the bell re-reads. */
  const [noticeRevision, setNoticeRevision] = useState(0);

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
        const status = await api.setupStatus();
        if (cancelled) return;
        setCompanyName(status.companyName ?? null);
        setOnMasterPc(status.onMasterPc ?? false);
        setServerMasterSetupNeeded(status.serverMasterSetupNeeded ?? false);
        setBootStep(1);

        if (!status.setupComplete) {
          setPhase('first-run');
        } else {
          try {
            const me = await api.me();
            if (cancelled) return;
            setUser(me.user);
            setSessionToken(me.sessionToken);
            // Office and Management start on Basic Home, Admin on the Dashboard.
            setTab(landingScreen(me.user.roleTier));
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
        // Whoever signs in next at this window starts on their own landing
        // screen, as after `signOut` — see there.
        setTab('basicHome');
        setOpenIds(NO_OPEN_IDS);
        for (const screen of SUB_NAV_SCREENS) clearSubNav(screen);
        setSubKeys({});
        setSignInNotice(reason);
        setPhase('signed-out');
      }),
    [clearSubNav],
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
      // The tab id lets the Master take this tab off any record the moment it closes.
      auth: { kind: 'master-admin', sessionToken, tabId: PRESENCE_TAB_ID },
      transports: ['websocket'],
    });

    socket.on('panels:changed', setPanels);
    socket.on('dashboard:changed', setSummary);
    /*
     * One state update per burst, not per event. A bulk import or a catalogue seed publishes
     * hundreds of change events within a second, and each one used to re-render the shell and
     * start a re-read on every screen that follows the entity. The counters now move once per
     * ~80 ms window, by however many events arrived in it; the cache is dropped at once, since
     * a read started in the window must not be answered from before the change.
     */
    const batch = createBurstBatcher<string>((entities) => {
      const counts = new Map<string, number>();
      for (const entity of entities) counts.set(entity, (counts.get(entity) ?? 0) + 1);
      setRevisions((current) => {
        const next = { ...current };
        for (const [entity, count] of counts) next[entity] = (next[entity] ?? 0) + count;
        return next;
      });
    }, REVISION_BATCH_MS);
    const bump = (entity: string): void => {
      invalidateReads();
      batch.push(entity);
    };

    // Every entity, unconditionally. The old allow-list is what made a per-entity
    // counter pointless for exactly the screens that most needed one.
    socket.on('data:changed', (event) => {
      bump(event.entity);
      // A company switch is not a row any screen counts — it rides on the
      // signed-in user as `features`, and until now only *this* browser's own
      // save refreshed it. A second administrator's flip left this one drawing
      // the old shape with no way to notice.
      if (event.entity === 'setting') refreshUser();
      // Likewise a role or a user: the permissions this window holds ride on
      // the signed-in user, so an edit to either is re-read, and a revoked
      // session lands on sign-in through the 401 path.
      if (event.entity === 'role' || event.entity === 'user') refreshUser();
    });

    // A merge shadowed somebody's value; the conflicts screen and the dashboard
    // counter both need to move. It arrives on its own channel, so it gets a
    // synthetic key rather than riding on some other entity's counter.
    socket.on('sync:conflict', () => bump('sync_conflict'));

    // Chat is addressed to this person's rooms; the Chatroom and the unread badge follow it.
    socket.on('chat:event', (push) => dispatchChat(push));
    // A Printroom job moved (live only). The claim of a station on this PC rides this same socket.
    attachPrintSocket(socket as unknown as Socket);
    socket.on('print:changed', (job) => dispatchPrint({ kind: 'changed', job }));
    // Who else is on the record open here; never stored, never a revision.
    socket.on('presence:changed', (presence) => presenceChannel.push(presence));
    // The faces on the Pending and Final boards' cards (protocol 7).
    socket.on('presence:board', (board) => presenceChannel.pushBoard(board));

    // A notice for this person: the bell re-reads, and the desktop shell (when
    // there is one) puts it in front of somebody whose window is behind another.
    socket.on('notification:new', (notice) => {
      setNoticeRevision((count) => count + 1);
      void desktopBridge()
        ?.notify?.({ title: t('notification.title'), body: notificationText(notice) })
        .catch(() => undefined);
    });

    /*
     * The link itself. socket.io-client comes back on its own after a dropped
     * transport, but not after the server closed the socket on purpose (a
     * restart) nor after it refused the handshake, so both are retried here.
     * Coming back re-reads everything: changes made while down were never
     * pushed to this window.
     */
    let down = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const retryIn = (ms: number): void => {
      if (retry) clearTimeout(retry);
      retry = setTimeout(() => {
        retry = null;
        socket.connect();
      }, ms);
    };
    socket.on('connect', () => {
      setLinkUp(true);
      requestCache.setLive(true);
      if (!down) return;
      down = false;
      bump('*');
      // Chat has no replay: whatever was said while this window was away is read again.
      dispatchChat({ kind: 'resync' });
      dispatchPrint({ kind: 'resync' });
      refreshUser();
      void api
        .panels()
        .then((result) => setPanels(result.panels))
        .catch(() => undefined);
    });
    socket.on('disconnect', (reason) => {
      down = true;
      setLinkUp(false);
      requestCache.setLive(false);
      presenceChannel.reset();
      if (reason === 'io server disconnect') retryIn(1_000);
    });
    socket.on('connect_error', () => {
      down = true;
      setLinkUp(false);
      requestCache.setLive(false);
      // Still active: the transport failed and socket.io-client is retrying.
      if (socket.active) return;
      // Refused. A session that has ended reaches the sign-in screen through
      // the 401 this read gets; anything else is worth another try.
      refreshUser();
      retryIn(REFUSED_RETRY_MS);
    });

    return () => {
      if (retry) clearTimeout(retry);
      batch.dispose();
      requestCache.setLive(false);
      attachPrintSocket(null);
      socket.close();
    };
  }, [phase, sessionToken, refreshUser]);

  // The stage pages and chips of both modules, read once here rather than by
  // each screen. Above the early returns, and only when signed in.
  const stagesRevision = revisionOf(revisions, 'stages');
  useEffect(() => {
    if (phase !== 'ready') return;
    let cancelled = false;
    void api
      .pipelines()
      .then((loaded) => {
        if (!cancelled) setPipelines(loaded);
      })
      .catch(() => {
        if (!cancelled) setPipelines([]);
      });
    return () => {
      cancelled = true;
    };
  }, [phase, stagesRevision]);

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

  /*
   * The Chatroom exists for somebody holding `chat.use` and for nobody else.
   * Its unread figure sits above the early returns like every hook here, and
   * asks for nothing while this window is not signed in.
   */
  const canChat = phase === 'ready' && (user?.permissions.includes('chat.use') ?? false);
  /*
   * The notice board: everybody signed in with `notices.view` reads it, and its management
   * screen belongs to `notices.manage`. The unread figure for the sidebar row is read here
   * (and kept current by the board itself as notices are marked read).
   */
  const canViewNotices = phase === 'ready' && (user?.permissions.includes('notices.view') ?? false);
  const canManageNotices = phase === 'ready' && (user?.permissions.includes('notices.manage') ?? false);
  const noticeBoard = useNotices(revisionOf(revisions, 'notices'), canViewNotices);
  const noticeUnread = noticeBoard.unread;
  const chatUnread = useChatUnread(masterChatTransport, canChat);

  /*
   * The Printroom exists for somebody holding either of its two rights and for
   * nobody else. Its waiting count sits above the early returns like every hook
   * here, and asks for nothing while this window is not signed in.
   */
  const canSendPrint = phase === 'ready' && (user?.permissions.includes('print.send') ?? false);
  const canRunStation = phase === 'ready' && (user?.permissions.includes('print.station') ?? false);
  const canPrintroom = canSendPrint || canRunStation;
  const printWaiting = usePrintWaiting(masterPrintroomTransport, canPrintroom);

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
     * Signing in sets the next person's own landing screen.
     */
    setTab('basicHome');
    setOpenIds(NO_OPEN_IDS);
    for (const screen of SUB_NAV_SCREENS) clearSubNav(screen);
    setSubKeys({});
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
    return (
      <FirstRunScreen
        onMasterPc={onMasterPc}
        onComplete={() => {
          setPhase('signed-out');
          // The name was only just typed in, so the boot read had none.
          void api
            .setupStatus()
            .then((status) => setCompanyName(status.companyName ?? null))
            .catch(() => undefined);
        }}
      />
    );
  }

  if (phase === 'signed-out' || !user) {
    return (
      <SignInScreen
        notice={signInNotice}
        onMasterPc={onMasterPc}
        serverMasterSetupNeeded={serverMasterSetupNeeded}
        onServerMastersSetUp={() => setServerMasterSetupNeeded(false)}
        onSignedIn={(signedInUser, token) => {
          setUser(signedInUser);
          setSessionToken(token);
          setSignInNotice(null);
          setTab(landingScreen(signedInUser.roleTier));
          setPhase('ready');
        }}
      />
    );
  }

  // ---- Presence rail (§4.8): the Master's aggregate across its panels.
  const openConflicts = summary?.openConflictCount ?? 0;
  const pendingSync = summary?.pendingSyncCount ?? 0;
  // Removed panels are not offline, they are gone: only active ones count.
  const offlinePanels = panels.filter((panel) => panel.status === 'active' && !panel.isConnected).length;
  const canManageRoles =
    user.permissions.includes('roles.view') || user.permissions.includes('users.manage');
  const canManagePanels = user.permissions.includes('panels.manage');
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
  // The permission and the company's switch for this person's tier: the Master
  // enforces both on every request, this only decides whether to draw the row.
  const canViewReports = reportsOffered(user.roleTier, user.features, user.permissions);
  const canViewLeads = user.permissions.includes('leads.view');
  const canViewOrders = user.permissions.includes('orders.view');
  const canViewProducts = user.permissions.includes('products.view');
  const canResolveConflicts = user.permissions.includes('sync.resolveConflicts');

  // Panels that have been out of touch for an hour or more (1.3).
  const longOffline = panels.filter((panel) => isLongOffline(panel, Date.now()));

  let railState: 'synced' | 'syncing' | 'offline' | 'offlinePending' | 'conflict';
  // This window's own link first: with it down, every figure below is old.
  if (!linkUp) railState = 'offline';
  else if (openConflicts > 0) railState = 'conflict';
  else if (offlinePanels > 0 && pendingSync > 0) railState = 'offlinePending';
  else if (offlinePanels > 0) railState = 'offline';
  else railState = pendingSync > 0 ? 'syncing' : 'synced';

  const syncLabel = !linkUp
    ? t('master.sync.serverUnreachable')
    : railState === 'conflict'
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

  async function resetActiveScreen(): Promise<void> {
    if (route === 'gallery') return;
    // Awaited now: asking is a themed dialog rather than a renderer-blocking
    // `window.confirm`, so the answer arrives a turn later.
    if (!(await askReset())) return;
    // The screen is going away, so its sidebar entry must go with it — the
    // registry deliberately does not clear itself on teardown any more.
    clearSubNav(shownTab);
    setOpenIds((current) =>
      shownTab === 'leads' || shownTab === 'orders' || shownTab === 'parties'
        ? { ...current, [shownTab]: null }
        : current,
    );
    setResetNonce((current) => ({ ...current, [shownTab]: (current[shownTab] ?? 0) + 1 }));
  }

  /*
   * The sub-pages each module offers from the sidebar: its tabs, views or
   * slices, exactly as the screen itself offers them. A module absent from
   * here is a single page and gets no fold. Permission-gated tabs are gated
   * here the same way, so the sidebar never offers a page the screen would
   * refuse to show.
   */
  const sortedStages = (kind: 'lead' | 'order') =>
    [...(pipelines.find((pipeline) => pipeline.kind === kind)?.stages ?? [])].sort(
      (a, b) => a.sequence - b.sequence,
    );
  const leadStages = sortedStages('lead');
  const orderStages = sortedStages('order');

  // The remembered tab may be one this person's role no longer offers (a
  // manager's company tab on a shared desk): then the first one is showing.
  const settingsTabIds = settingsTabIdsFor(user.permissions);
  const shownSettingsTab = settingsTabIds.includes(settingsTab)
    ? settingsTab
    : (settingsTabIds[0] ?? 'appearance');

  const subPages: Record<string, SubPage[]> = {
    leads: [
      { key: 'list', label: t('lead.board.tab.list'), icon: 'orders' },
      { key: 'converted', label: t('leadsOrders.tab.converted'), icon: 'check' },
      ...(canCreateLead
        ? [{ key: 'new', label: t('lead.add.title'), icon: 'plus' as const }]
        : []),
    ],
    // All stages, then one page per stage - read off the pipeline, so the
    // sidebar names whatever the company calls them.
    orders: [
      { key: 'all', label: t('orders.filter.allStages'), icon: 'orders' },
      ...orderStages.map((stage) => ({
        key: `stage:${stage.id}`,
        label: stage.name,
        icon: 'chevron-right' as const,
      })),
    ],
    // Brands is always offered, as on the Office: without `fields.view` the
    // page says so itself rather than the sidebar quietly dropping it.
    lists: [
      { key: 'grades', label: t('lists.nav.grades'), icon: 'edit' },
      { key: 'packaging', label: t('lists.nav.packaging'), icon: 'edit' },
      { key: 'brands', label: t('lists.nav.brands'), icon: 'edit' },
    ],
    products: [
      { key: 'sub', label: t('catalog.nav.subProducts'), icon: 'products' },
      { key: 'main', label: t('catalog.nav.mainProducts'), icon: 'inventory' },
      { key: 'brands', label: t('catalog.nav.brands'), icon: 'edit' },
      ...(user.permissions.includes('products.delete')
        ? [{ key: 'duplicates', label: t('catalog.nav.duplicates'), icon: 'trash' as const }]
        : []),
      ...(user.permissions.includes('products.edit')
        ? [{ key: 'photos', label: t('catalog.nav.photoImport'), icon: 'upload' as const }]
        : []),
    ],
    reports: offeredReportKinds(user.roleTier, user.features, user.permissions).map((kind) => ({
      key: kind,
      label: t(REPORT_META[kind].titleToken),
      icon: REPORT_META[kind].icon,
    })),
    printroom: [
      { key: 'waiting', label: t('printroom.filter.waiting'), icon: 'print' },
      { key: 'printed', label: t('printroom.filter.printed'), icon: 'task' },
      { key: 'sentByMe', label: t('printroom.filter.mine'), icon: 'upload' },
    ],
    chatroom: [
      { key: 'rooms', label: t('chat.sub.rooms'), icon: 'chat' },
      { key: 'tasks', label: t('chat.sub.tasks'), icon: 'task' },
      ...(user.permissions.includes('chat.createGroups') || user.permissions.includes('chat.manage')
        ? [{ key: 'groups', label: t('chat.sub.groups'), icon: 'parties' as const }]
        : []),
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
        canRestoreBinType(branch, (permission) => user.permissions.includes(permission)),
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
    settings: settingsTabIdsFor(user.permissions).map((id) => ({
      key: id,
      // The Master's storage tab also holds the backups; the Office's does not.
      label: id === 'storage' ? t('settings.tab.storageBackup') : t(`settings.tab.${id}`),
      icon: 'settings' as const,
    })),
  };

  /**
   * The sub-page a module is showing: the chosen one, else its first - also
   * when the chosen one is no longer offered (a stage that was archived).
   */
  const subKeyOf = (module: string): string => {
    if (module === 'settings') return shownSettingsTab;
    if (module === 'leads' && tab === 'addLead') return 'new';
    const pages = subPages[module];
    const chosen = subKeys[module];
    return chosen && pages?.some((page) => page.key === chosen) ? chosen : (pages?.[0]?.key ?? '');
  };

  /** The New pending order form, with the cursor placed only when the form is blank. */
  function openNewLead(): void {
    if (!canCreateLead) return;
    setRoute('');
    setOpenIds((current) => ({ ...current, leads: null }));
    setSubKeys((current) => ({ ...current, leads: 'list' }));
    setTab('addLead');
    setNewLeadNonce((current) => current + 1);
  }

  /** Leaving the New form lands on the Pending list, not a record opened before it. */
  function closeNewLead(): void {
    setOpenIds((current) => ({ ...current, leads: null }));
    setSubKeys((current) => ({ ...current, leads: 'list' }));
    setTab('leads');
  }

  function selectSubPage(module: string, key: string): void {
    if (module === 'settings') setSettingsTab(key);
    else if (module === 'leads' && key === 'new') openNewLead();
    else if (module === 'leads') {
      setSubKeys((current) => ({ ...current, leads: key }));
      setTab('leads');
    } else if (module === 'printroom') {
      // A page picked in the sidebar leaves any open job.
      setPrintOpen(null);
      setPrintResetNonce((current) => current + 1);
      setSubKeys((current) => ({ ...current, printroom: key }));
    } else if (module === 'chatroom') {
      // A page picked in the sidebar leaves any open room or share sheet.
      setChatOpen(null);
      setChatShare(null);
      setChatResetNonce((current) => current + 1);
      setSubKeys((current) => ({ ...current, chatroom: key }));
    } else setSubKeys((current) => ({ ...current, [module]: key }));
  }

  const nest = (items: Array<NavItem | null>): NavItem[] =>
    graftSubNav(
      withSubPages(
        items.filter((item): item is NavItem => item !== null),
        subPages,
      ),
      // The shell's own `leads.new` entry stands for the form; drop the form's grafted twin.
      subNav && tab === 'addLead'
        ? { ...subNav, items: subNav.items.filter((item) => item.id !== 'addLead.new') }
        : subNav,
    );

  /*
   * The sidebar: Work, Catalogue, Admin, System, in the order `MASTER_NAV`
   * declares (`keys-nav-order.test.ts` reads this literal to prove it). A
   * module the role cannot use is absent, not greyed. Basic Home's tiles are
   * built from these same groups, so a module without a row has no tile.
   */
  const groups: NavGroup[] = [
    {
      label: t('nav.work'),
      items: [
        // Basic Home and the Dashboard need nothing beyond being signed in.
        { id: 'basicHome', label: t('nav.basicHome'), icon: NAV_ICONS.basicHome },
        { id: 'dashboard', label: t('nav.master.dashboard'), icon: NAV_ICONS.dashboard },
        canViewLeads ? { id: 'leads', label: t('nav.leads'), icon: NAV_ICONS.leads } : null,
        canViewOrders ? { id: 'orders', label: t('nav.orders'), icon: NAV_ICONS.orders } : null,
        canResolveConflicts
          ? {
              id: 'conflicts',
              label: t('nav.master.conflicts'),
              icon: NAV_ICONS.conflicts,
              count: openConflicts > 0 ? openConflicts : undefined,
            }
          : null,
        canViewNotices
          ? {
              id: 'notices',
              label: t('nav.notices'),
              icon: NAV_ICONS.notices,
              count: noticeUnread && noticeUnread > 0 ? noticeUnread : undefined,
            }
          : null,
        canChat
          ? {
              id: 'chatroom',
              label: t('nav.chatroom'),
              icon: NAV_ICONS.chatroom,
              count: chatUnread.total > 0 ? chatUnread.total : undefined,
            }
          : null,
        canPrintroom
          ? {
              id: 'printroom',
              label: t('nav.printroom'),
              icon: NAV_ICONS.printroom,
              count: printWaiting > 0 ? printWaiting : undefined,
            }
          : null,
        // Under Work rather than Admin: a report is something a manager
        // produces during the day, not a setting anyone administers.
        canViewReports ? { id: 'reports', label: t('nav.reports'), icon: NAV_ICONS.reports } : null,
      ] satisfies Array<NavItem | null>,
    },
    {
      label: t('nav.catalogue'),
      items: [
        canViewProducts ? { id: 'products', label: t('nav.products'), icon: NAV_ICONS.products } : null,
        canViewParties ? { id: 'parties', label: t('nav.master.parties'), icon: NAV_ICONS.parties } : null,
        canViewPartyAccess
          ? { id: 'partyAccess', label: t('nav.master.partyAccess'), icon: NAV_ICONS.partyAccess }
          : null,
        // Everyone reads the three lists; editing is gated inside the page.
        { id: 'lists', label: t('nav.lists'), icon: 'task' },
      ] satisfies Array<NavItem | null>,
    },
    {
      label: t('nav.master.admin'),
      items: [
        canManagePanels ? { id: 'panels', label: t('nav.master.panels'), icon: NAV_ICONS.panels } : null,
        canManageRoles ? { id: 'access', label: t('nav.master.access'), icon: NAV_ICONS.access } : null,
        canManageNotices
          ? { id: 'noticesManage', label: t('nav.noticesManage'), icon: NAV_ICONS.noticesManage }
          : null,
        canViewFields ? { id: 'fields', label: t('nav.master.fields'), icon: NAV_ICONS.fields } : null,
        canViewLogs ? { id: 'logs', label: t('nav.master.logs'), icon: NAV_ICONS.logs } : null,
        canViewRecycleBin
          ? { id: 'recycleBin', label: t('nav.master.recycleBin'), icon: NAV_ICONS.recycleBin }
          : null,
        canManageApi
          ? { id: 'integrations', label: t('nav.master.integrations'), icon: NAV_ICONS.integrations }
          : null,
      ] satisfies Array<NavItem | null>,
    },
    {
      label: t('nav.system'),
      items: [
        // Everyone: Appearance and Shortcuts are per-desk. The company's own tabs
        // are `settings.manage`, gated in the sub-pages above and in the screen.
        { id: 'settings', label: t('nav.master.settings'), icon: NAV_ICONS.settings },
        // Visible to everyone: which version a machine runs is not privileged
        // information, and the person asked to read it out is rarely an admin.
        { id: 'updates', label: t('nav.updates'), icon: NAV_ICONS.updates },
      ] satisfies Array<NavItem | null>,
    },
  ].map((group) => ({ ...group, items: nest(group.items) }));

  const flatItems = groups.flatMap((group) => flattenNav(group.items));
  /** Whether the sidebar offers this person the screen - navigation's gate and the palette's. */
  function offered(id: string): boolean {
    return flatItems.some((item) => item.id === id);
  }
  /** Where this person lands: Basic Home for Office and Management, else the Dashboard. */
  const landing = landingScreen(user.roleTier);
  /*
   * The screen drawn: `tab` while the sidebar offers it, else the landing screen. A
   * role edit can take a screen away from a window that has it open, and the
   * sidebar then offers nothing that matches `tab` - drawing it anyway would
   * leave the person on a screen they may no longer use, under a title naming
   * nothing.
   */
  // Screens that are reached by a button, not the sidebar, so `offered` can never
  // say yes to them: New pending order (Ctrl+Shift+N, the topbar button) for
  // whoever may create one. Keeping the exemption in one place means that tab is
  // not shown as the landing screen.
  const NOT_IN_SIDEBAR: readonly string[] = canCreateLead ? ['addLead'] : [];
  const shownTab: Tab = NOT_IN_SIDEBAR.includes(tab) || offered(tab) ? tab : landing;
  const activeId = subNav && shownTab !== 'addLead'
    ? subNav.activeId
    : route === 'gallery'
      ? 'gallery'
      : // `addLead` is not in the sidebar, so it is named here or it would fall
        // through to a sidebar item and the sidebar would highlight nothing.
        shownTab === 'addLead'
        ? 'leads.new'
        : subPages[shownTab]?.length
        ? `${shownTab}.${subKeyOf(shownTab)}`
        : shownTab;
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
    /*
     * No "are you sure" on the way out: leaving an open editor does not unmount
     * it, so its draft is still there when you come back. The deliberate
     * discard is the Reset button.
     */
    if (id === 'gallery') return;
    if (readHash())
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setRoute('');
    // A sub-page is its module's screen, showing that page.
    const sub = splitSubPage(id);
    if (sub && subPages[sub.module]?.some((page) => page.key === sub.key)) {
      selectSubPage(sub.module, sub.key);
      // Leads sets its own tab: `new` is a different screen from the list.
      if (sub.module !== 'leads') setTab(sub.module as Tab);
      return;
    }
    setTab(id as Tab);
  }

  /** Opens one record of a list module as that module's sub-screen. */
  function openRecord(target: 'leads' | 'orders' | 'parties', id: string): void {
    if (!offered(target)) {
      toast.push(t('nav.recordNotAvailable'), { tone: 'info' });
      return;
    }
    navigate(target);
    setOpenIds((current) => ({ ...current, [target]: id }));
  }

  /** Opens a chat room (from the bell, or from the Chatroom itself). */
  function openChatRoom(room: { id: string; seq?: number } | null): void {
    setChatShare(null);
    setChatOpen(room);
    if (room) navigate('chatroom');
  }

  /** Opens a Printroom job (from the bell). */
  function openPrintJob(id: string): void {
    setPrintOpen(id);
    navigate('printroom');
  }

  /** "Share in chat" on a record: the Chatroom's share sheet, with that record ready. */
  const shareInChat =
    canChat && user.permissions.includes('chat.shareRecords')
      ? (chip: ChatRecordChip): void => {
          setChatOpen(null);
          setChatShare(chip);
          navigate('chatroom');
        }
      : undefined;

  /** The composer's record picker: pending and final orders by number or party, newest first. */
  async function findChatRecords(term: string): Promise<ChatRecordOption[]> {
    const [leads, orders] = await Promise.all([
      api.leads({ search: term || undefined, limit: 8, includeConverted: true }),
      api.orders({ search: term || undefined, limit: 8 }),
    ]);
    return [
      ...leads.items.map((lead) => ({
        kind: 'lead' as const,
        id: lead.id,
        label: recordNumber(lead),
        partyName: lead.partyName,
      })),
      ...orders.items.map((order) => ({
        kind: 'order' as const,
        id: order.id,
        label: recordNumber(order),
        partyName: order.partyName,
      })),
    ];
  }

  const topbar = (
    <>
      <TopbarTitle groups={groups} activeId={activeId} fallback={activeLabel} />
      <span style={{ flex: 1 }} />
      {/* The screen's own control sits inside the app-wide ones: Search and
          Sign out mean the same thing on every screen, this does not. */}
      <TopbarActionsOutlet />
      {shownTab !== 'addLead' && route !== 'gallery' && canCreateLead && (
        <button className="ob-btn ob-btn--primary" onClick={openNewLead}>
          {t('action.newLead')}
        </button>
      )}
      <IconButton
        icon="reset"
        label={t('screen.reset')}
        title={t('screen.resetHint')}
        onClick={() => void resetActiveScreen()}
      />
      <PaletteButton />
      <NotificationBell
        transport={notificationTransport}
        revision={(revisions['*'] ?? 0) + noticeRevision}
        onOpen={(link) => {
          if (link.kind === 'panel') navigate('panels');
          else if (link.kind === 'chat') openChatRoom({ id: link.id });
          else if (link.kind === 'print') openPrintJob(link.id);
          else if (link.kind === 'role') navigate('access');
          else if (link.kind === 'update') navigate('updates');
          else if (link.kind === 'lead') openRecord('leads', link.id);
        }}
      />
      {/* Beside Sign out, because the two are the same kind of thing — what you
          do with your own account — and the topbar is on every screen. */}
      {/* The label is in a span so it can end in an ellipsis when the bar is full. */}
      <button
        className="ob-btn ob-btn--ghost ob-btn--squeeze"
        title={t('action.changePassword')}
        aria-label={t('action.changePassword')}
        onClick={() => setChangingPassword(true)}
      >
        <Icon name="key" size={16} />
        <span>{t('action.changePassword')}</span>
      </button>
      <button className="ob-btn ob-btn--ghost ob-btn--signout" onClick={() => void signOut()}>
        <Icon name="sign-out" size={16} />
        {t('action.signOut')}
      </button>
    </>
  );

  const footer = (
    <>
      <span className="ob-footer-user">
        <Avatar
          name={user.displayName}
          avatar={user.avatar}
          size="sm"
          highlight={user.roleTier === SERVER_MASTER_TIER}
        />
        {user.displayName}
      </span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        className="ob-footer-sync"
        style={{ color: 'inherit' }}
        onClick={() => setSyncPopover((open) => !open)}
      >
        <span className="dot" style={{ background: railDotColour }} />
        {syncLabel}
      </button>
      {companyName && <span>{`${t('footer.company')} · ${companyName}`}</span>}
      <span className="ob-mono" style={{ fontSize: rem(10.5), color: 'var(--fg-tertiary)' }}>
        v{__APP_VERSION__}
      </span>
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
          <span className="ob-body-strong">{linkUp ? t(popoverTitleKey) : syncLabel}</span>
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
          {longOffline.length > 0 && (
            <>
              <dt>{t('panels.offlineLong')}</dt>
              <dd>{longOffline.map((panel) => panel.name).join(', ')}</dd>
            </>
          )}
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
                navigate('conflicts');
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
      id: 'basicHome',
      // Where Office and Management land, so the important and pinned notices are here as well as
      // on the Dashboard; the card draws nothing while there are none.
      render: () => (
        <>
          {canViewNotices && cardNotices(noticeBoard.notices, todayForNotices()).length > 0 && (
            // Inset like the launcher's own sections, so the card lines up with the tiles.
            <div style={{ padding: 'var(--s-8) var(--s-12) 0' }}>
              <NoticeDashboardCard
                notices={noticeBoard.notices}
                today={todayForNotices()}
                onOpen={() => navigate('notices')}
              />
            </div>
          )}
          <BasicHome
            groups={groups}
            onOpen={navigate}
            onNewLead={canCreateLead ? openNewLead : undefined}
          />
        </>
      ),
    },
    {
      id: 'dashboard',
      render: () => (
        <DashboardScreen
          summary={summary}
          panels={panels}
          canManagePanels={canManagePanels}
          canViewLeads={canViewLeads}
          revision={revisionOf(revisions, 'records') + revisionOf(revisions, 'notices')}
          canViewNotices={canViewNotices}
          onNavigate={navigate}
          onOpenLead={(id) => openRecord('leads', id)}
          printPending={canPrintroom ? printWaiting : undefined}
          chatUnread={canChat ? chatUnread.total : undefined}
        />
      ),
    },
    {
      id: 'panels',
      render: () => (
        <PanelsScreen
          panels={panels}
          onRefresh={refreshPanels}
          onOpenSettings={
            user.permissions.includes('settings.manage')
              ? () => {
                  requestSettingsTab('company');
                  navigate('settings');
                }
              : undefined
          }
        />
      ),
    },
    {
      id: 'parties',
      render: () => (
        <PartiesScreen
          revision={revisionOf(revisions, 'parties')}
          recordsRevision={revisionOf(revisions, 'records')}
          permissions={user.permissions}
          openId={openIds.parties}
          onOpenId={(id) => setOpenIds((current) => ({ ...current, parties: id }))}
          onOpenLead={(id) => openRecord('leads', id)}
          onOpenPartyAccess={() => navigate('partyAccess')}
        />
      ),
    },
    {
      id: 'leads',
      render: () => (
        <LeadsScreen
          revision={revisionOf(revisions, 'records')}
          stages={leadStages}
          permissions={user.permissions}
          packagingRequired={companyFeatures.packagingRequiredOnConvert}
          view={subKeys.leads === 'converted' ? 'converted' : 'list'}
          canCreate={canCreateLead}
          onNewLead={openNewLead}
          canCreateParty={user.permissions.includes('parties.create')}
          leadEntryRevision={revisionOf(revisions, 'leadEntry')}
          openId={openIds.leads}
          onOpenId={(id) => setOpenIds((current) => ({ ...current, leads: id }))}
          onOpenOrder={(orderId) => openRecord('orders', orderId)}
          onShareInChat={shareInChat}
          printroom={canSendPrint ? masterPrintroomTransport : undefined}
          userId={user.id}
        />
      ),
    },
    ...(canCreateLead
      ? [
          {
            id: 'addLead',
            render: () => (
              <LeadEntry
                revision={revisionOf(revisions, 'leadEntry')}
                catalogueRevision={revisionOf(revisions, 'catalogue')}
                focusNonce={newLeadNonce}
                canCreateParty={user.permissions.includes('parties.create')}
                onSaved={(id, saved) => {
                  closeNewLead();
                  // A saved lead is done with: the form starts over, as Reset does, minus the question.
                  clearSubNav('addLead');
                  setResetNonce((current) => ({ ...current, addLead: (current.addLead ?? 0) + 1 }));
                  toast.push(t('lead.add.savedOnline', { id: recordNumberText(saved ?? { id }) }));
                }}
                onCancel={closeNewLead}
              />
            ),
          } satisfies ScreenSpec,
        ]
      : []),
    {
      id: 'orders',
      render: () => (
        <OrdersScreen
          revision={revisionOf(revisions, 'records')}
          stages={orderStages}
          permissions={user.permissions}
          stageId={
            subKeyOf('orders').startsWith('stage:') ? subKeyOf('orders').slice('stage:'.length) : null
          }
          onStageChange={(stageId) => selectSubPage('orders', stageId === null ? 'all' : `stage:${stageId}`)}
          openId={openIds.orders}
          onOpenId={(id) => setOpenIds((current) => ({ ...current, orders: id }))}
          onOpenLead={(leadId) => openRecord('leads', leadId)}
          onShareInChat={shareInChat}
          printroom={canSendPrint ? masterPrintroomTransport : undefined}
          userId={user.id}
        />
      ),
    },
    ...(canViewNotices
      ? [
          {
            id: 'notices',
            render: () => (
              <NoticeBoardScreen
                revision={revisionOf(revisions, 'notices')}
                onUnreadChange={noticeBoard.setUnread}
              />
            ),
          } satisfies ScreenSpec,
        ]
      : []),
    ...(canManageNotices
      ? [
          {
            id: 'noticesManage',
            render: () => <NoticeManageScreen revision={revisionOf(revisions, 'notices')} />,
          } satisfies ScreenSpec,
        ]
      : []),
    ...(canPrintroom
      ? [
          {
            id: 'printroom',
            render: () => (
              <PrintroomScreen
                transport={masterPrintroomTransport}
                permissions={{ send: canSendPrint, station: canRunStation }}
                viewerId={user.id}
                desktop={desktopBridge() ?? undefined}
                page={subKeyOf('printroom') as PrintPage}
                openJobId={printOpen}
                onOpenJob={setPrintOpen}
                resetNonce={printResetNonce}
              />
            ),
          } satisfies ScreenSpec,
        ]
      : []),
    ...(canChat
      ? [
          {
            id: 'chatroom',
            render: () => (
              <ChatroomScreen
                transport={masterChatTransport}
                page={subKeyOf('chatroom') as ChatPage}
                viewer={{ id: user.id, permissions: user.permissions, tier: user.roleTier }}
                openRoom={chatOpen}
                onOpenRoom={setChatOpen}
                share={chatShare}
                onShareDone={(roomId) => {
                  setChatShare(null);
                  if (roomId) setChatOpen({ id: roomId });
                }}
                resetNonce={chatResetNonce}
                onOpenRecord={(record: ChatRecordRef) =>
                  openRecord(record.kind === 'lead' ? 'leads' : 'orders', record.id)
                }
                findRecords={findChatRecords}
              />
            ),
          } satisfies ScreenSpec,
        ]
      : []),
    {
      id: 'lists',
      render: () => (
        <CatalogListsScreen
          page={subKeyOf('lists') as CatalogListsPage}
          permissions={user.permissions}
          transport={optionListTransport}
          revision={revisionOf(revisions, 'catalogueLists')}
        />
      ),
    },
    {
      id: 'products',
      render: () => (
        <ProductsScreen
          page={subKeyOf('products') as ProductsPage}
          permissions={user.permissions}
          catalogueRevision={revisionOf(revisions, 'catalogue')}
          listsRevision={revisionOf(revisions, 'catalogueLists')}
        />
      ),
    },
    {
      id: 'reports',
      render: () => (
        <ReportsScreen
          transport={reportsTransport}
          revision={revisionOf(revisions, 'reports')}
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
        <ConflictsScreen revision={revisionOf(revisions, 'conflicts')} />
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
          tab={shownSettingsTab}
          onTabChange={setSettingsTab}
          onSaved={refreshUser}
          permissions={user.permissions}
          settingsRevision={revisionOf(revisions, 'settings')}
          sourcesRevision={revisionOf(revisions, 'leadSources')}
          canChangePairingPassword={onMasterPc && user.roleTier === SERVER_MASTER_TIER}
          onMasterPc={onMasterPc}
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
      <ScreenHost screens={screens} activeId={shownTab} resetNonce={resetNonce} />
    );

  const overlays = (
    <>
      {/* V6: important unread notices, once per sign-in; keyed by person so a new one decides afresh. */}
      {canViewNotices && (
        <SignInNotices
          key={user?.id ?? ''}
          loaded={noticeBoard.loaded}
          notices={noticeBoard.notices}
          today={todayForNotices()}
          onMarkRead={noticeBoard.markRead}
        />
      )}
      <KeyboardOverlays
        subscribeMenu={(handler) =>
          desktopBridge()?.onMenuCommand?.((id) => {
            handler(id);
          })
        }
        searchRecords={async (term) => ({ hits: await api.search(term) })}
        onOpenRecord={(hit) => {
          // Route the hit to the screen that owns it. A line hit's `id` is its
          // parent lead or order, which that screen opens as a sub-screen.
          if (hit.kind === 'lead_line') openRecord('leads', hit.id);
          else if (hit.kind === 'order_line') openRecord('orders', hit.id);
          else if (hit.kind === 'party') openRecord('parties', hit.id);
          // Like the Office, a product hit lands on the list, not on the record.
          else if (hit.kind === 'product') navigate(offered('products.sub') ? 'products.sub' : 'products');
        }}
      />
      {syncOverlay}
      {/* The auto-print station: invisible, and at the top so it keeps working whichever screen is showing. */}
      <PrintStationRunner
        transport={masterPrintroomTransport}
        enabled={canRunStation}
        desktop={desktopBridge() ?? undefined}
        onNotify={(message) => toast.push(message, { tone: 'error' })}
      />
      <ChangePasswordDialog
        open={changingPassword}
        onClose={() => setChangingPassword(false)}
        serverMaster={user.roleTier === SERVER_MASTER_TIER}
      />
    </>
  );

  /** The sign-out chord asks first: a stray press must not drop an open form. */
  async function askSignOut(): Promise<void> {
    const ok = await confirm({
      title: t('signOut.confirm.title'),
      body: t('signOut.confirm.body'),
      confirmLabel: t('action.signOut'),
      tone: 'danger',
    });
    if (ok) await signOut();
  }

  return (
    <KeyboardProvider
      panel="master"
      userId={user?.id ?? null}
      onNavigate={navigate}
      canNavigate={offered}
      shellCommands={{
        'record.new': canCreateLead ? openNewLead : null,
        'session.signOut': () => void askSignOut(),
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
          homeId={landing}
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
