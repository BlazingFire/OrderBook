/**
 * Office Panel shell.
 *
 * Subscribes to this panel's server-sent event stream. The stream carries the
 * panel's **merged view** — the Master's snapshot with locally queued work
 * applied — so a lead saved while offline appears immediately and simply stops
 * being marked pending once it syncs.
 *
 * Presentation follows 6-UI-DESIGN.md: presence rail, collapsible sidebar,
 * topbar with universal search, status footer, splash on cold start. There is
 * deliberately no "cannot save while disconnected" state anywhere — saving
 * offline is the normal path, so the chrome reports the connection instead of
 * gating on it.
 */

import { Activity, useCallback, useEffect, useRef, useState } from 'react';
import {
  applyChangeToSnapshot,
  isRoleTier,
  LONG_OFFLINE_MS,
  matchesRecordSearch,
  recordNumber,
  offeredReportKinds,
  REPORT_ENTITIES,
  REPORT_META,
  reportsOffered,
  resolveCompanyFeatures,
} from '@orderbook/shared';
import type {
  ChatRecordChip,
  ChatRecordRef,
  DataChangedEvent,
  MessageKey,
  MutationResult,
  RecordPresence,
  ReportKind,
  UserNotification,
} from '@orderbook/shared';

import {
  ApiError,
  api,
  desktopBridge,
  type ConnectionInfo,
  type LocalView,
  type PanelSession,
} from './api';
import {
  AppShell,
  adoptDefaultLocale,
  BasicHome,
  BP_NARROW,
  BusyMark,
  ChatroomScreen,
  ReportsScreen,
  Clock,
  FilterBarOutlet,
  FilterBarProvider,
  formatDateTime,
  formatElapsed,
  GalleryScreen,
  Icon,
  IconButton,
  KeyboardOverlays,
  KeyboardProvider,
  landingScreen,
  lazyScreen,
  NotificationBell,
  notificationText,
  PaletteButton,
  apiErrorText,
  ConfirmProvider,
  onSessionEnded,
  ResetProvider,
  ScreenHost,
  Splash,
  SubNavProvider,
  ToastProvider,
  TopbarTitle,
  translator,
  flattenNav,
  graftSubNav,
  loadSidebarMode,
  rem,
  storeSidebarMode,
  t,
  useChatUnread,
  useClearSubNav,
  useMediaQuery,
  useResetGate,
  useSettingsTab,
  useSubNavState,
  useToast,
  splitSubPage,
  withSubPages,
  type ChatPage,
  type ChatRecordOption,
  type LocalNotice,
  type NavGroup,
  type NavItem,
  type NotificationTransport,
  type ScreenSpec,
  type SidebarMode,
  type SubPage,
} from '@orderbook/ui';
import { dispatchChat, officeChatTransport } from './chatTransport';
import { searchLocalView } from './localSearch';
import { presenceChannel } from './presence';
import { reportsTransport } from './reportsTransport';
import { AddLeadScreen } from './screens/AddLeadScreen';
import { CatalogScreen } from './screens/CatalogScreen';
import { BrandsScreen, MainProductsScreen } from './screens/MainProductsScreen';
import { ConnectionScreen } from './screens/ConnectionScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { LeadBoardScreen } from './screens/LeadBoardScreen';
import { OrderBoardScreen } from './screens/OrderBoardScreen';
import { SignInScreen } from './screens/SignInScreen';
import { SETTINGS_TAB_IDS } from './settingsTabs';

/*
 * Screens most people open rarely, loaded on first visit rather than at
 * start-up (`ScreenHost` shows the loading mark meanwhile). Basic Home and the
 * daily screens above stay in the first bundle.
 */
const ConflictsScreen = lazyScreen(() => import('./screens/ConflictsScreen'), 'ConflictsScreen');
const PartyAccessScreen = lazyScreen(
  () => import('./screens/PartyAccessScreen'),
  'PartyAccessScreen',
);
const SettingsScreen = lazyScreen(() => import('./screens/SettingsScreen'), 'SettingsScreen');
const LogsScreen = lazyScreen(() => import('./screens/LogsScreen'), 'LogsScreen');
const UpdatesScreen = lazyScreen(() => import('./screens/UpdatesScreen'), 'UpdatesScreen');

type Tab =
  | 'basicHome'
  | 'dashboard'
  | 'leads'
  | 'orders'
  | 'parties'
  | 'partyAccess'
  | 'products'
  | 'conflicts'
  | 'chatroom'
  | 'reports'
  | 'settings'
  | 'logs'
  | 'updates'
  /* A screen, not a mode: as a boolean it was cleared by `goToTab`, so
     switching tab silently discarded a half-filled lead. */
  | 'addLead';

/**
 * The route the location hash names, without the `#/` in front of it.
 *
 * The footer link writes `#/gallery`, so the slash is part of the hash. Taking
 * off only the `#` read that as `/gallery`, which names nothing — and the
 * `hashchange` the link itself causes then closed the gallery its own click
 * had just opened.
 */
function readHash(): string {
  return window.location.hash.replace(/^#\/?/, '');
}

/** The cold-start steps the splash reports, in the order they run. */
const BOOT_STEPS = ['server', 'session', 'assets'] as const;

/** Past this, this PC's clock and the Master's disagree enough to say so (1.3). */
const CLOCK_SKEW_BANNER_MS = 2 * 60_000;

/** The bell reads the signed-in person's notices from the Master, through this panel. */
const notificationTransport: NotificationTransport = {
  list: () => api.notifications(),
  markRead: (which) => api.markNotificationsRead(which),
};

/** "10:42" today, the full date and time on an earlier day. */
function offlineSinceText(since: number): string {
  const at = new Date(since);
  return at.toDateString() === new Date().toDateString()
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : formatDateTime(at.toISOString());
}

/**
 * A ceiling on every boot call, so a panel server that accepts the socket and
 * then never answers ends in a reason and a Retry rather than an endless
 * "Starting…".
 *
 * ponytail: races rather than aborts, so the original request stays in flight
 * until it settles. Harmless for boot reads; thread an `AbortSignal` through
 * `api` if a boot step ever writes.
 */
function withTimeout<T>(work: Promise<T>, ms = 10_000): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new ApiError(t('splash.error.timeout'), 'timeout')), ms);
    }),
  ]);
}

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SubNavProvider>
          <ResetProvider>
            <OfficePanel />
          </ResetProvider>
        </SubNavProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function OfficePanel() {
  const toast = useToast();
  // For the event stream below, which must not reopen whenever this changes.
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [session, setSession] = useState<PanelSession | null>(null);
  /** Why this window is at the sign-in screen, when it did not sign out itself. */
  const [signInNotice, setSignInNotice] = useState<MessageKey | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [view, setView] = useState<LocalView | null>(null);
  const [rejections, setRejections] = useState<MutationResult[]>([]);
  // An option-list change forces a snapshot, so a new `optionLists` array is
  // this panel's word that sources or brands may have moved; Settings → Leads
  // and Products → Brands reload on it, as the Master's do on its
  // `option_list` revision.
  const [optionListsRevision, setOptionListsRevision] = useState(0);
  useEffect(() => setOptionListsRevision((count) => count + 1), [view?.optionLists]);
  // Bumped on every snapshot and every applied change. The Reports screen re-reads on it: a
  // count fingerprint misses a lead that changed stage, an order that was dispatched, an edit.
  const [viewRevision, setViewRevision] = useState(0);

  // Set to the person's landing screen at sign-in and on the boot restore.
  const [tab, setTab] = useState<Tab>('basicHome');
  /*
   * Which sub-page each module is showing, keyed by module. A screen's tabs
   * are offered from the sidebar too, and both controls read from here so
   * they never disagree. Settings keeps its own remembered tab (per machine,
   * validated against the tabs this panel has) through the same hook the
   * desktop menu's "Developer" request already lands in.
   */
  const [subKeys, setSubKeys] = useState<Record<string, string>>({});
  const [settingsTab, setSettingsTab] = useSettingsTab(
    'ob.settings.tab.office',
    SETTINGS_TAB_IDS,
    'appearance',
  );
  const [error, setError] = useState<string | null>(null);
  const [flushing, setFlushing] = useState(false);

  // Shell chrome state.
  const [route, setRoute] = useState(readHash);
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
  const [splashDone, setSplashDone] = useState(false);
  const [syncPopover, setSyncPopover] = useState(false);
  // Cold start: how many boot steps are behind us, and why we stopped if we did.
  const [bootStep, setBootStep] = useState(0);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);

  /*
   * One counter per screen, and the visible screen's veto over being reset.
   *
   * Declared **here**, above every early return, because that is what the rules
   * of hooks require: this component returns early for the splash, for an
   * unpaired panel and for a signed-out one, so a hook below those returns is
   * called on some renders and not others. React counts them, and the render
   * after signing in threw "rendered more hooks than during the previous
   * render" — which the error boundary caught, so the whole panel showed
   * "Something went wrong" the instant anybody signed in.
   */
  const [resetNonce, setResetNonce] = useState<Record<string, number>>({});
  const askReset = useResetGate();

  /*
   * The record a screen currently has open, published by that screen and read
   * here so the sidebar can nest an entry for it under its module (§8). The
   * shell does not need to know what the record *is*, only where it belongs
   * and how to leave it. Same rules-of-hooks reason as the two above for
   * sitting here rather than beside the code that uses them.
   */
  const subNav = useSubNavState(route === 'gallery' ? null : tab);
  const clearSubNav = useClearSubNav();

  /*
   * Which lead and which order are open, held here rather than inside their
   * boards: the Dashboard's panes open a record on a screen that is mounted
   * but hidden, and one id passed down each way is smaller than an imperative
   * handle into a hidden screen. Parties and products are never opened from
   * anywhere but their own list, so their ids stay local to `CatalogScreen`.
   */
  const [openLeadId, setOpenLeadId] = useState<string | null>(null);
  /** Temporary id → permanent id, for each provisional lead the Master numbered this session. */
  const [numberedIds, setNumberedIds] = useState<Record<string, string>>({});
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  /** The chat room open as a sub-screen, and the record being shared; both are the signed-in person's, so cleared with the session. */
  const [chatOpen, setChatOpen] = useState<{ id: string; seq?: number } | null>(null);
  const [chatShare, setChatShare] = useState<ChatRecordChip | null>(null);
  /** Bumped when the sidebar picks a Chatroom page, so a settings sub-screen left open closes. */
  const [chatResetNonce, setChatResetNonce] = useState(0);
  /*
   * Bumped each time somebody *asks* for the New lead form — the sidebar
   * entry, the topbar button, Ctrl+Shift+N. The form reads it to put the
   * cursor on the party picker when it is blank, and to leave a half-typed
   * lead exactly where it was when it is not.
   */
  const [newLeadNonce, setNewLeadNonce] = useState(0);

  /*
   * Moves when the event stream comes back after a drop, and when the link to
   * the Master does: anything that lists live data from the Master (the bell
   * now) reads it again then. Bumped from inside the stream's listeners, never
   * a dependency of the stream itself, which must stay one per session.
   */
  const [streamEpoch, setStreamEpoch] = useState(0);
  /** Moves with each notice pushed to the signed-in person, so the bell re-reads. */
  const [noticeRevision, setNoticeRevision] = useState(0);

  /*
   * An hour without the Master. One timer to the hour mark, re-armed when the
   * episode changes; the panel's server keeps `disconnectedSince` for as long
   * as the link stays down, so one value is one episode.
   */
  const disconnectedSince = connection?.disconnectedSince ?? null;
  const [longOffline, setLongOffline] = useState(false);
  useEffect(() => {
    setLongOffline(false);
    const since = disconnectedSince ? Date.parse(disconnectedSince) : NaN;
    if (!Number.isFinite(since)) return;
    const due = since + LONG_OFFLINE_MS - Date.now();
    if (due <= 0) {
      setLongOffline(true);
      return;
    }
    const timer = setTimeout(() => setLongOffline(true), due);
    return () => clearTimeout(timer);
  }, [disconnectedSince]);

  /*
   * One system notification and taskbar flash per episode, from the desktop
   * shell. In a browser tab there is no shell, and the banner and the bell say
   * it alone. The ref outlives a re-run of the effect, so a remount does not
   * notify twice.
   */
  const notifiedEpisode = useRef<string | null>(null);
  useEffect(() => {
    if (!longOffline || !disconnectedSince || notifiedEpisode.current === disconnectedSince) return;
    notifiedEpisode.current = disconnectedSince;
    void desktopBridge()
      ?.notify?.({
        title: t('office.link.offlineLongTitle'),
        body: t('office.link.offlineLong', {
          duration: formatElapsed(Date.now() - Date.parse(disconnectedSince)),
        }),
      })
      .catch(() => undefined);
  }, [longOffline, disconnectedSince]);

  // The Master was found at a new address and this panel moved with it: say so once.
  const rediscoveredFrom = connection?.rediscoveredFrom ?? null;
  const toastedMove = useRef<string | null>(null);
  useEffect(() => {
    if (!rediscoveredFrom || toastedMove.current === rediscoveredFrom) return;
    toastedMove.current = rediscoveredFrom;
    const to = connection?.masterHost
      ? `${connection.masterHost}:${connection.masterPort ?? ''}`
      : '—';
    toast.push(t('office.link.rediscovered', { from: rediscoveredFrom, to }), { tone: 'info' });
    // Only a new move is news; the address it moved to arrives in the same frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rediscoveredFrom]);

  // Stable, or every boot-step render would hand Splash a new callback and
  // restart its hold timer.
  const markSplashDone = useCallback(() => setSplashDone(true), []);

  const refreshConnection = useCallback(async () => {
    try {
      setConnection(await api.connection());
    } catch {
      // A momentary blip talking to this panel's own server. Blanking the
      // connection here threw a running app back to the splash with nothing to
      // act on, so the last known state stands — `state` and `hasNetworkLink`
      // already model being disconnected. The initial read is the boot
      // sequence's job, and it reports its own failure.
    }
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      setSession((await api.session()).session);
    } catch {
      // A round trip that did not complete is not a sign-out. This runs on
      // every reconnect, and reading a dropped request as "nobody is signed
      // in" threw a working panel back to the sign-in screen while its own
      // server still held the session — the same mistake `refreshConnection`
      // above already avoids. `/api/session` always answers, so only an answer
      // of `null` signs anybody out.
    } finally {
      setSessionChecked(true);
    }
  }, []);

  /*
   * The session can end without this window doing anything: the Master
   * deactivates the account, the panel's pairing is revoked, or the person
   * changes their own password on the Master — which invalidates every session
   * they hold. `api.ts` publishes it from the single place every request passes
   * through; all this has to do is stop rendering a signed-in shell and say why.
   */
  useEffect(
    () =>
      onSessionEnded((reason) => {
        setSession(null);
        // What `signOut` clears too: whoever signs in next at this window
        // starts afresh. The screen stayed, and the next person started on it
        // — the Conflicts page, which stays offered while it is the open one,
        // for somebody with no refusals and no right to adjudicate, or a view
        // of the last person's parties until the first snapshot replaced it.
        // Signing in sets the next person's own landing screen.
        setView(null);
        setTab('basicHome');
        setChatOpen(null);
        setChatShare(null);
        setSignInNotice(reason);
      }),
    [],
  );

  const refreshSyncState = useCallback(async () => {
    try {
      const state = await api.syncState();
      setRejections(state.rejections);
    } catch {
      // The panel's own server is unreachable — the connection call will say
      // so; there is nothing useful to say twice.
    }
  }, []);

  // Cold start. Each step reports itself to the splash on the way past, and a
  // step that fails leaves a message there rather than an endless wait — which
  // is what "stuck on the starting screen" was: a failed first read left
  // `connection` null forever behind a gate that only ever checked for null.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setBootError(null);
      setBootStep(0);

      try {
        const info = await withTimeout(api.connection());
        if (cancelled) return;
        setConnection(info);
        setBootStep(1);

        try {
          const { session: restored, defaultLocale } = await withTimeout(api.session());
          if (cancelled) return;
          // Behind the splash, before the shell first renders. Unlike the
          // Master's, this endpoint needs no session, so the sign-in screen
          // gets the deployment's language too. Writes once — see
          // `adoptDefaultLocale`.
          adoptDefaultLocale(defaultLocale);
          setSession(restored);
          // Office and Management start on Basic Home, Admin on the Dashboard.
          // Only here and at sign-in: `refreshSession` runs on every reconnect
          // and must leave the open screen alone.
          if (restored) setTab(landingScreen(restored.roleTier));
        } catch {
          // Nobody signed in, or a session the Master no longer honours. That
          // is the sign-in screen, not a failure to start.
          if (cancelled) return;
          setSession(null);
        }
        setSessionChecked(true);
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

  // Sync state sits behind the sign-in gate, so asking for it before anybody
  // has signed in earns a 401 whose only effect is a red line in the console.
  //
  // Keyed on *whether* somebody is signed in, not on the session object:
  // `refreshSession()` stores a fresh object on every reconnect, and the
  // stream below calls it the moment it connects. Keyed on the object, each
  // connect closed the stream and opened a new one, which connected, which
  // refreshed the session — a loop of about sixteen reopen-and-resync rounds a
  // second against the panel's own server and the Master behind it.
  const signedIn = session !== null;

  // The Chatroom's unread figure for the sidebar row; asks for nothing without `chat.use`.
  const chatUnread = useChatUnread(
    officeChatTransport,
    signedIn && (session?.permissions.includes('chat.use') ?? false),
  );

  useEffect(() => {
    if (!signedIn) return;
    void refreshSyncState();
  }, [signedIn, refreshSyncState]);

  // One event stream per signed-in session.
  useEffect(() => {
    if (!signedIn) return;

    const source = new EventSource('/api/events');

    /** Everything a fresh link or a reopened stream may have missed. */
    const catchUp = (): void => {
      setStreamEpoch((epoch) => epoch + 1);
      // Chat has no replay: whatever was said while the stream was away is read again.
      dispatchChat({ kind: 'resync' });
      void refreshConnection();
      void refreshSyncState();
      // The link coming back is when the Master gets to re-check who this
      // is; a since-deactivated user learns about it here.
      void refreshSession();
    };

    /*
     * Status frames also carry the link's finer state (catching up, the
     * network, the clock), so a connected panel sends several. Only the move
     * *to* connected is a reconnect.
     */
    let lastState: ConnectionInfo['state'] | undefined;
    source.addEventListener('status', (event) => {
      const status = JSON.parse((event as MessageEvent).data) as Partial<ConnectionInfo>;
      setConnection((current) => (current ? { ...current, ...status } : current));
      if (status.state === 'connected' && lastState !== 'connected') catchUp();
      // Off the Master, who is on a record is no longer known.
      if (status.state && status.state !== 'connected') presenceChannel.reset();
      if (status.state) lastState = status.state;
    });

    // The stream to this panel's own server dropped and the browser reopened
    // it: frames sent meanwhile are gone, so read again what they would have said.
    let dropped = false;
    source.addEventListener('error', () => {
      dropped = true;
    });
    source.addEventListener('open', () => {
      if (!dropped) return;
      dropped = false;
      catchUp();
    });

    // A notice for the person signed in here (the server drops anyone else's).
    source.addEventListener('notification', (event) => {
      const notice = JSON.parse((event as MessageEvent).data) as UserNotification;
      setNoticeRevision((count) => count + 1);
      void desktopBridge()
        ?.notify?.({ title: t('notification.title'), body: notificationText(notice) })
        .catch(() => undefined);
    });

    // Chat for the person signed in here (the server drops anyone else's).
    source.addEventListener('chat', (event) => {
      dispatchChat(JSON.parse((event as MessageEvent).data));
    });


    // Who else is on the record open here (the server drops anyone else's frames).
    source.addEventListener('presence', (event) => {
      presenceChannel.push(JSON.parse((event as MessageEvent).data) as RecordPresence);
    });

    /*
     * A provisional pending order got its number. One open on the board stays
     * open under its permanent id (`numberedIds`). The toast is only for a
     * number no waiting save already named; the bell's entry, for one saved
     * long ago, comes from the Master.
     */
    source.addEventListener('numbered', (event) => {
      const numbered = JSON.parse((event as MessageEvent).data) as {
        temporaryId: string;
        permanentId: string;
        poNumber?: string;
        announced: boolean;
      };
      setNumberedIds((current) => ({ ...current, [numbered.temporaryId]: numbered.permanentId }));
      if (!numbered.announced && numbered.poNumber) {
        toastRef.current.push(t('lead.numbered.toast', { number: numbered.poNumber }));
      }
    });

    source.addEventListener('snapshot', (event) => {
      setView(JSON.parse((event as MessageEvent).data) as LocalView);
      setViewRevision((count) => count + 1);
      void refreshSyncState();
    });

    /*
     * The small per-record frame, applied in place.
     *
     * The server has been sending this since the Office panel got a change
     * feed; nothing here listened for it, so a lead somebody else edited did
     * not appear until the next whole-view push. Applying it here is what makes
     * the frame worth sending — routing it into a full snapshot push instead
     * would put back the amplifier the server side just removed.
     */
    source.addEventListener('change', (event) => {
      const change = JSON.parse((event as MessageEvent).data) as DataChangedEvent;
      if (REPORT_ENTITIES.includes(change.entity)) setViewRevision((count) => count + 1);
      setView((current) => {
        if (!current) return current;

        // A shallow copy is enough: `applyChangeToSnapshot` replaces whole
        // arrays rather than pushing into them, so React sees a new reference
        // for exactly the collections that moved.
        const next = { ...current };
        applyChangeToSnapshot(next, change);
        return next;
      });
    });

    source.addEventListener('conflict', () => {
      void refreshSyncState();
    });

    return () => source.close();
  }, [signedIn, refreshConnection, refreshSession, refreshSyncState]);

  // Hash routing: #/gallery is the one extra place a user can land.
  useEffect(() => {
    const onHash = () => setRoute(readHash());
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

  async function flush(): Promise<void> {
    setFlushing(true);
    try {
      const outcome = await api.flush();
      setRejections(outcome.rejections);
      if (outcome.rejections.length > 0) {
        /*
         * Told to everybody, not only to an admin.
         *
         * This was gated on `sync.resolveConflicts`, which sits at the admin
         * tier — so the one notification that a write had been thrown away was
         * withheld from exactly the shop-floor staff whose writes get thrown
         * away. The route to the screen is open too: the sidebar offers
         * Conflicts to anybody holding refusals (see its entry below), because
         * the refusals section there is a person's own work and dismissing it
         * is not an adjudication. Before that entry was widened, this action
         * set a tab nobody without the permission had in their sidebar, and
         * `activeId` fell back to the Dashboard.
         */
        toast.push(translator().tCount('sync.changesRefused', outcome.rejections.length), {
          tone: 'error',
          action: { label: t('action.reviewRefusals'), onClick: showConflicts },
        });
      }
    } catch (caught) {
      const message = apiErrorText(caught, 'sync.couldNotSync');
      setError(message);
      toast.push(message, { tone: 'error' });
    } finally {
      setFlushing(false);
    }
  }

  /*
   * To the Conflicts page, from the refusal toast or the sync popover.
   *
   * Not through `goToTab`: the toast's action is the closure of the render
   * that ran `flush`, whose sidebar did not yet offer Conflicts to somebody
   * holding their first refusals, so that check would refuse it. Both are
   * reachable with the gallery open — the footer is on every screen — so the
   * gallery is left the way `goToTab` leaves it; setting the tab alone left
   * the person on the gallery with the page changed underneath it.
   */
  function showConflicts(): void {
    setSyncPopover(false);
    if (readHash())
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setRoute('');
    setTab('conflicts');
  }

  async function signOut(): Promise<void> {
    await api.signOut();
    setSession(null);
    setView(null);
    setTab('basicHome');
    setChatOpen(null);
    setChatShare(null);
  }

  /*
   * Escape closes the sync popover.
   *
   * `/` used to live here too, focusing a topbar search box; it is
   * `palette.search` now, resolved by `KeyboardProvider` against the same
   * bindings as every other chord. The popover keeps its own Escape because it
   * is not a `[role="dialog"]` and so `useOverlay` never sees it.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && syncPopover) setSyncPopover(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [syncPopover]);

  // The splash owns the whole cold start now — the minimum hold, the boot
  // itself, and anything that went wrong with it. There is no second
  // "Starting…" screen behind it to get stranded on.
  if (!splashDone || !connection || !sessionChecked || bootStep < BOOT_STEPS.length || bootError) {
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
    return (
      <SignInScreen
        connection={connection}
        notice={signInNotice}
        onSignedIn={(next) => {
          setSignInNotice(null);
          setSession(next);
          setTab(landingScreen(next.roleTier));
        }}
      />
    );
  }

  const permissions = session.permissions;
  const can = (permission: string): boolean => permissions.includes(permission);
  // The session names the tier as text; the report rules take the tiers there are.
  const tier = isRoleTier(session.roleTier) ? session.roleTier : 'office';

  /** Where this person lands: Basic Home for Office and Management, else the Dashboard. */
  const landing = landingScreen(session.roleTier);

  const openConflicts = (view?.conflicts ?? []).filter((conflict) => !conflict.resolvedAt).length;
  const pendingCount = view?.pendingCount ?? 0;

  // ---- Presence rail (§7): conflict review > offline pending > syncing > synced.
  const linkDown = connection.state === 'disconnected' || !connection.hasNetworkLink;
  let railState: 'synced' | 'syncing' | 'offline' | 'offlinePending' | 'conflict';
  if (openConflicts > 0 && can('sync.resolveConflicts')) railState = 'conflict';
  else if (linkDown || connection.state === 'unpaired' || connection.state === 'connecting')
    railState = pendingCount > 0 ? 'offlinePending' : 'offline';
  // Connected, but what was missed is still coming in: not "Synced" yet.
  else if (connection.catchingUp) railState = 'syncing';
  else railState = flushing || pendingCount > 0 ? 'syncing' : 'synced';

  const syncLabel =
    railState === 'conflict'
      ? t('sync.conflictReview', { count: openConflicts })
      : railState === 'offlinePending'
        ? t('sync.offlinePending', { count: pendingCount })
        : railState === 'offline'
          ? t('sync.offline')
          : railState === 'syncing'
            ? connection.catchingUp
              ? t('sync.catchingUp')
              : t('sync.syncing', { count: pendingCount })
            : t('sync.synced');

  const railDotColour =
    railState === 'conflict'
      ? 'var(--state-conflict)'
      : railState === 'offline' || railState === 'offlinePending'
        ? 'var(--state-offline)'
        : railState === 'syncing'
          ? 'var(--accent)'
          : 'var(--line-strong)';

  // ---- Sidebar modules: absent, not greyed, when the role lacks `view`.

  /*
   * The sub-pages each module offers from the sidebar: its views, slices or
   * tabs, exactly as the screen itself offers them. A module absent from here
   * is a single page and gets no fold. Orders folds into its pipeline stages,
   * read off the snapshot, so the sidebar names whatever the company calls
   * them.
   */
  const orderStages = [
    ...(view?.pipelines.find((pipeline) => pipeline.kind === 'order')?.stages ?? []),
  ].sort((a, b) => a.sequence - b.sequence);

  const subPages: Record<string, SubPage[]> = {
    // New lead is a thing you do to the Leads module, so it is Leads' second
    // page rather than a module of its own; Board stays a toggle on the list.
    leads: [
      { key: 'list', label: t('lead.board.tab.list'), icon: 'orders' },
      ...(can('leads.create')
        ? [{ key: 'new', label: t('lead.add.title'), icon: 'plus' as const }]
        : []),
    ],
    orders: [
      { key: 'all', label: t('orders.filter.allStages'), icon: 'orders' },
      ...orderStages.map((stage) => ({
        key: `stage:${stage.id}`,
        label: stage.name,
        icon: 'chevron-right' as const,
      })),
    ],
    chatroom: [
      { key: 'rooms', label: t('chat.sub.rooms'), icon: 'chat' },
      { key: 'tasks', label: t('chat.sub.tasks'), icon: 'task' },
      ...(can('chat.createGroups') || can('chat.manage')
        ? [{ key: 'groups', label: t('chat.sub.groups'), icon: 'parties' as const }]
        : []),
    ],
    // One page per kind on offer, in tab order.
    reports: offeredReportKinds(tier, view?.features, permissions).map((kind) => ({
      key: kind,
      label: t(REPORT_META[kind].titleToken),
      icon: REPORT_META[kind].icon,
    })),
    partyAccess: [
      { key: 'all', label: t('partyAccess.filter.all'), icon: 'parties' },
      { key: 'restricted', label: t('partyAccess.filter.restricted'), icon: 'shield' },
      { key: 'open', label: t('partyAccess.filter.open'), icon: 'eye' },
    ],
    // The catalogue's three levels (docs/catalogue/CATALOGUE_MODEL.md §1),
    // the everyday list first.
    products: [
      { key: 'sub', label: t('catalog.nav.subProducts'), icon: 'products' },
      { key: 'main', label: t('catalog.nav.mainProducts'), icon: 'inventory' },
      { key: 'brands', label: t('catalog.nav.brands'), icon: 'edit' },
    ],
    settings: SETTINGS_TAB_IDS.map((id) => ({
      key: id,
      label: t(`settings.tab.${id}`),
      icon: 'settings' as const,
    })),
  };

  /** The sub-page a module is showing: the chosen one, else its first. */
  const subKeyOf = (module: string): string =>
    module === 'settings'
      ? settingsTab
      : module === 'leads'
        ? tab === 'addLead'
          ? 'new'
          : 'list'
        : (subKeys[module] ?? subPages[module]?.[0]?.key ?? '');

  /** The New lead form, with the cursor placed only when the form is blank. */
  function openNewLead(): void {
    setTab('addLead');
    setNewLeadNonce((current) => current + 1);
  }

  function selectSubPage(module: string, key: string): void {
    if (module === 'settings') setSettingsTab(key);
    else if (module === 'leads') {
      if (key === 'new') openNewLead();
      else setTab('leads');
    } else if (module === 'chatroom') {
      // A page picked in the sidebar leaves any open room or share sheet.
      setChatOpen(null);
      setChatShare(null);
      setChatResetNonce((current) => current + 1);
      setSubKeys((current) => ({ ...current, chatroom: key }));
    } else setSubKeys((current) => ({ ...current, [module]: key }));
  }

  /** Hangs each module's sub-pages, then the open record's entry, under it. */
  const nest = (items: NavItem[]): NavItem[] => graftSubNav(withSubPages(items, subPages), subNav);

  /*
   * The sidebar, in the order `OFFICE_NAV` declares (`keys-nav-order.test.ts`
   * reads this literal to prove it). Basic Home's tiles are built from these
   * same groups, so a module without a row has no tile.
   */
  const groups: NavGroup[] = [
    {
      label: t('nav.work'),
      items: (
        [
          // Basic Home and the Dashboard are always present, unlike the rest of
          // this group: they only gather what the screens below already show,
          // so they need no permission of their own beyond being signed in.
          { id: 'basicHome', label: t('nav.basicHome'), icon: 'home' as const },
          { id: 'dashboard', label: t('nav.dashboard'), icon: 'dashboard' as const },
          can('leads.view') ? { id: 'leads', label: t('nav.leads'), icon: 'leads' as const } : null,
          can('orders.view')
            ? { id: 'orders', label: t('nav.orders'), icon: 'orders' as const }
            : null,
          /*
           * Resolving merge conflicts needs `sync.resolveConflicts`, but the
           * screen also lists this person's own refused writes, which are
           * theirs to read and dismiss (`ConflictsScreen`'s header). So it is
           * offered while any are waiting, counting them, and stays offered
           * while it is the open screen: dismissing the last refusal must not
           * pull the page out from under the person who dismissed it.
           */
          can('sync.resolveConflicts')
            ? {
                id: 'conflicts',
                label: t('nav.conflicts'),
                icon: 'conflicts' as const,
                count: openConflicts > 0 ? openConflicts : undefined,
              }
            : rejections.length > 0 || tab === 'conflicts'
              ? {
                  id: 'conflicts',
                  label: t('nav.conflicts'),
                  icon: 'conflicts' as const,
                  count: rejections.length > 0 ? rejections.length : undefined,
                }
              : null,
          can('chat.use')
            ? {
                id: 'chatroom',
                label: t('nav.chatroom'),
                icon: 'chat' as const,
                count: chatUnread.total > 0 ? chatUnread.total : undefined,
              }
            : null,
          // The permission and the company's switch for this person's tier. The
          // Master enforces both on every request; this only decides whether to
          // draw the row, so it is offered before the first snapshot too.
          reportsOffered(tier, view?.features, permissions)
            ? { id: 'reports', label: t('nav.reports'), icon: 'report' as const }
            : null,
        ] satisfies Array<NavItem | null>
      ).filter((item): item is NonNullable<typeof item> => item !== null),
    },
    {
      label: t('nav.catalogue'),
      items: (
        [
          can('products.view')
            ? { id: 'products', label: t('nav.products'), icon: 'products' as const }
            : null,
          can('parties.view')
            ? { id: 'parties', label: t('nav.parties'), icon: 'parties' as const }
            : null,
          // Either key opens it: `party.assign` to redraw the map,
          // `party.accessAll` to read it. Both are admin/management tier, so
          // this never appears for the office-tier role an unattended panel
          // falls back to.
          can('party.assign') || can('party.accessAll')
            ? { id: 'partyAccess', label: t('nav.partyAccess'), icon: 'shield' as const }
            : null,
        ] satisfies Array<NavItem | null>
      ).filter((item): item is NonNullable<typeof item> => item !== null),
    },
    {
      // Per-machine appearance, device info and this machine's version are
      // always present. The activity log needs `logs.view`, and is read from
      // the Master, so it fails like any other forward while offline.
      label: t('nav.system'),
      items: (
        [
          { id: 'settings', label: t('nav.settings'), icon: 'settings' as const },
          can('logs.view') ? { id: 'logs', label: t('nav.logs'), icon: 'eye' as const } : null,
          { id: 'updates', label: t('nav.updates'), icon: 'sync' as const },
        ] satisfies Array<NavItem | null>
      ).filter((item): item is NonNullable<typeof item> => item !== null),
    },
  ].map((group) => ({ ...group, items: nest(group.items) }));

  // Map sidebar ids back onto the tabs the screens know.
  const idToTab: Record<string, Tab> = {
    basicHome: 'basicHome',
    dashboard: 'dashboard',
    leads: 'leads',
    orders: 'orders',
    parties: 'parties',
    partyAccess: 'partyAccess',
    products: 'products',
    conflicts: 'conflicts',
    chatroom: 'chatroom',
    reports: 'reports',
    settings: 'settings',
    logs: 'logs',
    updates: 'updates',
  };

  /** Shared by the sidebar and by in-content links (e.g. the Dashboard's stat cards). */
  /*
   * One counter per screen; bumping it re-keys that screen inside
   * `ScreenHost` and React remounts it. The deliberate way to throw away a
   * draft, now that navigating away no longer does.
   */

  async function resetActiveScreen(): Promise<void> {
    if (route === 'gallery') return;
    // Awaited now: asking is a themed dialog rather than a renderer-blocking
    // `window.confirm`, so the answer arrives a turn later.
    if (!(await askReset())) return;
    // Same identity `activeScreenId` uses: the screen that published the entry,
    // not the sidebar item the entry hangs under.
    const id =
      subNav || tab === 'addLead'
        ? tab
        : (idToTab[splitSubPage(activeId)?.module ?? activeId] ?? activeId);
    // The registry deliberately keeps entries across a screen being hidden, so
    // remounting the screen is not enough — the entry has to be dropped here.
    clearSubNav(id);
    setOpenLeadId((current) => (id === 'leads' ? null : current));
    setOpenOrderId((current) => (id === 'orders' ? null : current));
    setResetNonce((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
  }

  function goToTab(id: string): void {
    // Already here. Selecting the open record's own entry is not a navigation.
    if (subNav?.items.some((item) => item.id === id)) return;
    /*
     * Only somewhere the sidebar offers this person. The sidebar is not the
     * only way in — Alt+N and the palette's nav commands come through here for
     * every screen in `OFFICE_NAV`, and so do the Dashboard's links and a
     * search hit — and without this a role with no `leads.view` reached the
     * lead board by pressing what is now Alt+3. The Master still refuses what the role may
     * not do; this keeps the panel from drawing the screen at all.
     */
    if (!offered(id)) return;
    // Clear a stale #/gallery so the hash and the state agree; replaceState
    // does not fire hashchange, the setRoute below is the source of truth.
    if (readHash())
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setRoute('');
    // A sub-page is its module's screen, showing that page.
    const sub = splitSubPage(id);
    if (sub && subPages[sub.module]?.some((page) => page.key === sub.key)) {
      selectSubPage(sub.module, sub.key);
      if (sub.module !== 'leads' && idToTab[sub.module]) setTab(idToTab[sub.module]);
      return;
    }
    if (idToTab[id]) setTab(idToTab[id]);
  }

  /** Opens a chat room (from the bell, or from the Chatroom itself). */
  function openChatRoom(room: { id: string; seq?: number } | null): void {
    setChatShare(null);
    setChatOpen(room);
    if (room) goToTab('chatroom');
  }

  /** "Share in chat" on a record: the Chatroom's share sheet, with that record ready. */
  const shareInChat = can('chat.use') && can('chat.shareRecords')
    ? (chip: ChatRecordChip): void => {
        setChatOpen(null);
        setChatShare(chip);
        goToTab('chatroom');
      }
    : undefined;

  /** A chip or bell entry opens the record in its own board; a record this panel's view lacks is fetched there. */
  function openChatRecord(record: ChatRecordRef): void {
    if (record.kind === 'lead') {
      if (!offered('leads')) return void toast.push(t('nav.recordNotAvailable'), { tone: 'info' });
      setOpenLeadId(record.id);
      goToTab('leads');
    } else {
      if (!offered('orders')) return void toast.push(t('nav.recordNotAvailable'), { tone: 'info' });
      setOpenOrderId(record.id);
      goToTab('orders');
    }
  }

  /** The composer's record picker: this panel's own pending and final orders, so it works with no link. */
  async function findChatRecords(term: string): Promise<ChatRecordOption[]> {
    const found: ChatRecordOption[] = [];
    for (const lead of view?.leads ?? []) {
      if (matchesRecordSearch(lead, term)) {
        found.push({ kind: 'lead', id: lead.id, label: recordNumber(lead), partyName: lead.partyName });
      }
    }
    for (const order of view?.orders ?? []) {
      if (matchesRecordSearch(order, term)) {
        found.push({ kind: 'order', id: order.id, label: recordNumber(order), partyName: order.partyName });
      }
    }
    return found.slice(0, 20);
  }

  const activeId = subNav
    ? subNav.activeId
    : route === 'gallery'
      ? 'gallery'
      : // `addLead` is deliberately absent from the sidebar (reached only via
        // the "New lead" button), so it can never satisfy the sidebar-membership
        // check below — that used to fall through to the first sidebar item
        // (Dashboard) and silently discard the switch to Add Lead.
        tab === 'addLead'
        ? 'leads.new'
        : subPages[tab]?.length
          ? `${tab}.${subKeyOf(tab)}`
          : groups.some((group) => group.items.some((item) => item.id === idToTab[tab]))
            ? tab
            : landing;

  const flatItems = groups.flatMap((group) => flattenNav(group.items));
  /** Whether the sidebar offers this person the screen — navigation's gate and the palette's. */
  function offered(id: string): boolean {
    return flatItems.some((item) => item.id === id);
  }
  const activeLabel =
    route === 'gallery' && !subNav
      ? t('footer.designSystem')
      : (flatItems.find((item) => item.id === activeId)?.label ?? t('app.panel'));

  const lastSynced = connection.lastSyncedAt
    ? new Date(connection.lastSyncedAt).toLocaleString()
    : '—';

  // ---- The link's own notices (1.3): read at render, so each says how things stand now.
  const offlineSince = disconnectedSince ? Date.parse(disconnectedSince) : NaN;
  const skewMs = connection.clockSkewMs ?? null;
  const skewShown = skewMs !== null && Math.abs(skewMs) > CLOCK_SKEW_BANNER_MS;
  const skewText =
    skewMs === null
      ? ''
      : skewMs > 0
        ? t('office.sync.clockAhead', { duration: formatElapsed(skewMs) })
        : t('office.sync.clockBehind', { duration: formatElapsed(-skewMs) });

  /*
   * The bell's own entry for an hour offline. The Master cannot keep it, being
   * the one out of reach, so it lives here for as long as the episode does.
   */
  const localNotices: LocalNotice[] =
    longOffline && Number.isFinite(offlineSince)
      ? [
          {
            id: 'local:offlineLong',
            text: t('office.link.offlineLongTitle'),
            createdAt: new Date(offlineSince + LONG_OFFLINE_MS).toISOString(),
          },
        ]
      : [];

  const banners = [
    longOffline && Number.isFinite(offlineSince) ? (
      <div key="offline" className="ob-banner ob-banner--offline" role="status">
        <Icon name="warning" />
        <span className="ob-body-strong">{t('office.link.offlineLongTitle')}</span>
        <span>{`${t('office.sync.offlineSince')} ${offlineSinceText(offlineSince)}`}</span>
      </div>
    ) : null,
    connection.notRecognised && connection.state !== 'connected' ? (
      <div key="notRecognised" className="ob-banner ob-banner--conflict" role="alert">
        <Icon name="warning" />
        <span>{t('office.link.notRecognised', { host: connection.masterHost ?? '—' })}</span>
      </div>
    ) : null,
    connection.rediscoveryRefused && connection.state !== 'connected' ? (
      <div key="refused" className="ob-banner ob-banner--conflict" role="alert">
        <Icon name="shield" />
        <span>
          {t('office.link.rediscoveryRefused', { address: connection.rediscoveryRefused })}
        </span>
      </div>
    ) : null,
    skewShown ? (
      <div key="skew" className="ob-banner" role="status">
        <Icon name="warning" />
        <span>{t('office.link.clockSkew', { duration: formatElapsed(Math.abs(skewMs ?? 0)) })}</span>
      </div>
    ) : null,
  ].filter((banner) => banner !== null);

  const banner =
    banners.length > 0 ? (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-8)',
          padding: 'var(--s-8) var(--s-20) 0',
        }}
      >
        {banners}
      </div>
    ) : undefined;

  const topbar = (
    <>
      <TopbarTitle groups={groups} activeId={activeId} fallback={activeLabel} />

      <span style={{ flex: 1 }} />

      <PaletteButton />

      {tab !== 'addLead' && route !== 'gallery' && can('leads.create') && (
        <button className="ob-btn ob-btn--primary" disabled={!view} onClick={openNewLead}>
          {t('action.newLead')}
        </button>
      )}

      <IconButton
        icon="reset"
        label={t('screen.reset')}
        title={t('screen.resetHint')}
        onClick={() => void resetActiveScreen()}
      />

      <NotificationBell
        transport={notificationTransport}
        revision={streamEpoch + noticeRevision}
        local={localNotices}
        // A pending order numbered after an offline save opens on the board.
        onOpen={(link) => {
          if (link.kind === 'chat') openChatRoom({ id: link.id });
          else if (link.kind === 'lead') {
            setOpenLeadId(link.id);
            setTab('leads');
          }
        }}
      />

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
      {connection.companyName && (
        <span>{`${t('footer.company')} · ${connection.companyName}`}</span>
      )}
      <span>
        {t('footer.signedInAs', { name: session.displayName, role: session.roleName })}
        {session.offline ? ` · ${t('footer.offlineSignIn')}` : ''}
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

  const overlays = (
    <>
      <KeyboardOverlays
        subscribeMenu={(handler) =>
          desktopBridge()?.onMenuCommand?.((id) => {
            handler(id);
          })
        }
        searchRecords={async (term) => {
          try {
            return { hits: await api.search(term) };
          } catch {
            // Offline is this panel's normal state, not an error path: fall back
            // to the snapshot in memory and say on screen that that is what
            // these results are.
            return { hits: view ? searchLocalView(view, term) : [], offline: true };
          }
        }}
        onOpenRecord={(hit) => {
          // The sub-product list, not whichever Products page was last open.
          if (hit.kind === 'product') goToTab('products.sub');
          else if (hit.kind === 'party') goToTab('parties');
          else if (hit.kind === 'lead_line') goToTab('leads');
          else goToTab('orders');
        }}
      />
      {syncPopover && (
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
              <span className="ob-body-strong">{syncLabel}</span>
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
              <dd className="ob-data">{pendingCount}</dd>
              {rejections.length > 0 && (
                <>
                  <dt>{t('sync.refusedChanges')}</dt>
                  <dd className="ob-data" style={{ color: 'var(--state-conflict)' }}>
                    {rejections.length}
                  </dd>
                </>
              )}
              <dt>{t('sync.lastSuccessful')}</dt>
              <dd>{lastSynced}</dd>
              <dt>{t('sync.pairedServer')}</dt>
              <dd className="ob-mono" style={{ fontSize: rem(11.5) }}>
                {connection.masterHost ?? '—'}
              </dd>
              {Number.isFinite(offlineSince) && (
                <>
                  <dt>{t('office.sync.offlineSince')}</dt>
                  <dd>
                    {`${offlineSinceText(offlineSince)} (${formatElapsed(Date.now() - offlineSince)})`}
                  </dd>
                </>
              )}
              {skewShown && (
                <>
                  <dt>{t('office.sync.clockSkew')}</dt>
                  <dd>{skewText}</dd>
                </>
              )}
            </dl>
            <div
              style={{
                display: 'flex',
                gap: 'var(--s-8)',
                marginTop: 'var(--s-12)',
                paddingTop: 'var(--s-8)',
                borderTop: '1px solid var(--line)',
              }}
            >
              <button
                className="ob-btn ob-btn--secondary ob-btn--sm"
                disabled={flushing || pendingCount === 0}
                aria-busy={flushing}
                onClick={() => void flush()}
              >
                {flushing ? <BusyMark size={12} label="" /> : null}
                {flushing ? t('sync.flushing') : t('sync.flushNow')}
              </button>
              {can('sync.resolveConflicts') && openConflicts > 0 && (
                <button
                  className="ob-btn ob-btn--ghost ob-btn--sm"
                  style={{ color: 'var(--accent)' }}
                  onClick={showConflicts}
                >
                  {t('action.reviewConflicts')}
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {error && (
        <div
          className="ob-banner ob-banner--conflict"
          role="alert"
          style={{
            position: 'absolute',
            right: 'var(--s-20)',
            bottom: 'calc(var(--shell-footer-h) + var(--s-8))',
            zIndex: 'var(--z-toast)',
          }}
        >
          <span>{error}</span>
          <span style={{ flex: 1 }} />
          <button
            className="ob-icon-btn"
            aria-label={t('action.dismiss')}
            title={t('action.dismiss')}
            onClick={() => setError(null)}
          >
            <Icon name="close" size={10} />
          </button>
        </div>
      )}
    </>
  );

  /*
   * Two tiers, because this panel's screens are not interchangeable.
   *
   * `updates` and `settings` read the connection rather than the merged view,
   * so they work before the first snapshot ever arrives — which is exactly
   * when an operator needs them. Basic Home reads only the sidebar, so it is
   * here too: it is where most people land, and it must not wait on a sync. Everything else takes a non-null `LocalView`.
   * `ScreenHost` renders all visited screens at once, so a null view must
   * never reach the second tier; the gate stays outside the host.
   *
   * `addLead` is a screen here rather than a mode, which is what stops a
   * half-filled lead being thrown away by navigating to another tab.
   */
  const alwaysAvailable: ScreenSpec[] = [
    {
      id: 'basicHome',
      render: () => (
        <BasicHome
          groups={groups}
          onOpen={goToTab}
          onNewLead={can('leads.create') ? openNewLead : undefined}
        />
      ),
    },
    {
      id: 'updates',
      render: () => <UpdatesScreen connection={connection} permissions={permissions} />,
    },
    { id: 'logs', render: () => <LogsScreen permissions={permissions} /> },
    {
      // Reads live through the Master and posts through the outbox, so it needs
      // no snapshot: with no link it keeps what it holds, says so, and a post
      // waits in the queue.
      id: 'chatroom',
      render: () => (
        <ChatroomScreen
          transport={officeChatTransport}
          page={subKeyOf('chatroom') as ChatPage}
          viewer={{ id: session.userId, permissions, tier: session.roleTier }}
          openRoom={chatOpen}
          onOpenRoom={setChatOpen}
          share={chatShare}
          onShareDone={(roomId) => {
            setChatShare(null);
            if (roomId) setChatOpen({ id: roomId });
          }}
          resetNonce={chatResetNonce}
          onOpenRecord={openChatRecord}
          findRecords={findChatRecords}
        />
      ),
    },
    {
      // Online-only through the Master, so it needs no snapshot: with the Master
      // out of reach the screen says so (the proxy answers 503) and a fresh
      // snapshot re-reads whatever is on screen.
      id: 'reports',
      render: () => (
        <ReportsScreen
          transport={reportsTransport}
          revision={viewRevision}
          online={connection.state === 'connected'}
          kind={subKeyOf('reports') as ReportKind}
          onKindChange={(kind) => selectSubPage('reports', kind)}
        />
      ),
    },
    {
      id: 'settings',
      render: () => (
        <SettingsScreen
          connection={connection}
          session={session}
          pendingCount={pendingCount}
          openConflicts={openConflicts}
          tab={settingsTab}
          onTabChange={setSettingsTab}
          followUpDays={view ? resolveCompanyFeatures(view.features).followUpDefaultDays : null}
          sourcesRevision={optionListsRevision}
        />
      ),
    },
  ];

  const needsView: ScreenSpec[] = view
    ? [
        {
          id: 'dashboard',
          render: () => (
            <DashboardScreen
              view={view}
              linkDown={linkDown}
              railState={railState}
              syncLabel={syncLabel}
              onNavigate={goToTab}
              onOpenLead={(id) => {
                setOpenLeadId(id);
                setTab('leads');
              }}
              chatUnread={can('chat.use') ? chatUnread.total : undefined}
            />
          ),
        },
        {
          id: 'leads',
          render: () => (
            <LeadBoardScreen
              view={view}
              openId={openLeadId}
              onOpenId={setOpenLeadId}
              canConvert={can('lead.convert')}
              canPreviewPdf={can('leads.export')}
              canEdit={can('leads.edit')}
              onError={setError}
              onAddLead={can('leads.create') ? openNewLead : undefined}
              onShareInChat={shareInChat}
              userId={session?.userId ?? null}
              numberedIds={numberedIds}
            />
          ),
        },
        {
          id: 'orders',
          render: () => (
            <OrderBoardScreen
              view={view}
              openId={openOrderId}
              onOpenId={setOpenOrderId}
              canDispatch={can('orders.dispatch')}
              canExport={can('orders.export')}
              canEdit={can('orders.edit')}
              onError={setError}
              userId={session?.userId ?? null}
              stageId={
                subKeyOf('orders').startsWith('stage:')
                  ? subKeyOf('orders').slice('stage:'.length)
                  : null
              }
              onStageChange={(stageId) =>
                selectSubPage('orders', stageId === null ? 'all' : `stage:${stageId}`)
              }
              onShareInChat={shareInChat}
            />
          ),
        },
        {
          id: 'conflicts',
          render: () => (
            <ConflictsScreen
              conflicts={view.conflicts}
              rejections={rejections}
              canResolve={can('sync.resolveConflicts')}
              onError={setError}
              onResolved={() => void refreshSyncState()}
            />
          ),
        },
        {
          id: 'partyAccess',
          render: () => (
            <PartyAccessScreen
              permissions={permissions}
              revision={view.pendingCount ?? 0}
              restriction={subKeyOf('partyAccess') as 'all' | 'open' | 'restricted'}
              onRestrictionChange={(next) => selectSubPage('partyAccess', next)}
            />
          ),
        },
        // Two entries sharing one screen: the sidebar has separate Parties and
        // Products items, and each keeps its own state.
        { id: 'parties', render: () => <CatalogScreen view={view} tab="parties" /> },
        {
          id: 'products',
          // One screen id, three sidebar pages. Each page sits in its own
          // `<Activity>` so switching between them keeps each one's search,
          // filters and open record, as `ScreenHost` does between modules.
          render: () => (
            <>
              <Activity mode={subKeyOf('products') === 'sub' ? 'visible' : 'hidden'}>
                <CatalogScreen view={view} tab="products" canImport={can('products.bulk')} />
              </Activity>
              <Activity mode={subKeyOf('products') === 'main' ? 'visible' : 'hidden'}>
                <MainProductsScreen view={view} />
              </Activity>
              <Activity mode={subKeyOf('products') === 'brands' ? 'visible' : 'hidden'}>
                <BrandsScreen view={view} revision={optionListsRevision} />
              </Activity>
            </>
          ),
        },
        {
          id: 'addLead',
          render: () => (
            <AddLeadScreen
              view={view}
              focusNonce={newLeadNonce}
              onSaved={(id, queued) => {
                setTab('leads');
                /*
                 * A saved lead is done with, so the form starts over — the
                 * same remount the Reset button does, minus the question.
                 * `ScreenHost` keeps the screen mounted while hidden, which
                 * is what keeps a half-typed lead across a tab switch; it also
                 * kept the lead just saved, so the next "New lead" opened on
                 * it and one more Save queued it a second time.
                 */
                clearSubNav('addLead');
                setResetNonce((current) => ({ ...current, addLead: (current.addLead ?? 0) + 1 }));
                // Named by its number when the Master answered in time;
                // Provisional otherwise, until the `numbered` frame arrives.
                if (queued?.status === 'rejected') {
                  void refreshSyncState();
                  toast.push(translator().tCount('sync.changesRefused', 1), {
                    tone: 'error',
                    action: { label: t('action.reviewRefusals'), onClick: showConflicts },
                  });
                } else if (queued?.status === 'numbered') {
                  toast.push(
                    t('lead.add.savedOnline', { id: queued.poNumber ?? queued.permanentId ?? id }),
                  );
                } else {
                  toast.push(t('lead.add.savedProvisional'));
                }
              }}
              onCancel={() => setTab('leads')}
            />
          ),
        },
      ]
    : [];

  const screens = [...alwaysAvailable, ...needsView];
  /*
   * The screen to mount when a nested entry is showing is the screen that
   * *published* it, which is `tab` — the registry is keyed by it.
   *
   * It used to be the entry's `parentId`, which is the same thing for a record
   * open inside its own list but not for New lead: that publishes under Leads
   * so the sidebar highlights Leads, and resolving the parent mounted the lead
   * board on top of the form somebody was typing into.
   */
  const activeScreenId =
    subNav || tab === 'addLead'
      ? tab
      : (idToTab[splitSubPage(activeId)?.module ?? activeId] ?? activeId);
  const known = screens.some((screen) => screen.id === activeScreenId);

  const content =
    route === 'gallery' ? (
      <div className="ob-pane">
        <GalleryScreen />
      </div>
    ) : known ? (
      <ScreenHost screens={screens} activeId={activeScreenId} resetNonce={resetNonce} />
    ) : (
      <div className="ob-pane">
        <div className="ob-empty">
          {view ? null : <BusyMark size={48} label="" />}
          <h3>{activeLabel}</h3>
          {/* Before the first snapshot every data screen is unavailable; after
              it, an unknown id means a role with no modules at all. */}
          <p>{view ? t('shell.noModules') : t('shell.waitingFirstSync')}</p>
        </div>
      </div>
    );

  return (
    <KeyboardProvider
      panel="office"
      userId={session?.userId ?? null}
      onNavigate={goToTab}
      canNavigate={offered}
      shellCommands={{
        'view.reset': () => void resetActiveScreen(),
        // As on the Master: the shell swallows F5, so this is what hands the key
        // back rather than a second, different meaning for it.
        'view.refresh': () => window.location.reload(),
        // A new record on this panel is a lead. Absent rather than inert when
        // the role cannot create one — the palette then simply does not offer it.
        'record.new': can('leads.create') ? openNewLead : null,
      }}
    >
      <FilterBarProvider>
        <AppShell
          groups={groups}
          activeId={activeId}
          onNavigate={goToTab}
          homeId={landing}
          collapsed={collapsed}
          onToggleCollapsed={toggleSidebar}
          topbar={topbar}
          banner={banner}
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
