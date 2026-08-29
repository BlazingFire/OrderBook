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

import { useCallback, useEffect, useState } from 'react';
import { applyChangeToSnapshot } from '@orderbook/shared';
import type { DataChangedEvent, MutationResult } from '@orderbook/shared';

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
  BP_NARROW,
  BusyMark,
  Clock,
  FilterBarOutlet,
  FilterBarProvider,
  GalleryScreen,
  AssistantScreen,
  Icon,
  IconButton,
  KeyboardOverlays,
  KeyboardProvider,
  PaletteButton,
  ResetProvider,
  ScreenHost,
  Splash,
  ToastProvider,
  loadSidebarMode,
  publishAiEvent,
  rem,
  storeSidebarMode,
  t,
  useMediaQuery,
  useResetGate,
  useToast,
  type NavGroup,
  type NavItem,
  type ScreenSpec,
  type SidebarMode,
} from '@orderbook/ui';
import { searchLocalView } from './localSearch';
import { AddLeadScreen } from './screens/AddLeadScreen';
import { CatalogScreen } from './screens/CatalogScreen';
import { PartyAccessScreen } from './screens/PartyAccessScreen';
import { ConflictsScreen } from './screens/ConflictsScreen';
import { ConnectionScreen } from './screens/ConnectionScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { LeadBoardScreen } from './screens/LeadBoardScreen';
import { OrderBoardScreen } from './screens/OrderBoardScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { UpdatesScreen } from './screens/UpdatesScreen';
import { SignInScreen } from './screens/SignInScreen';

type Tab =
  | 'assistant'
  | 'dashboard'
  | 'leads'
  | 'orders'
  | 'parties'
  | 'partyAccess'
  | 'products'
  | 'conflicts'
  | 'settings'
  | 'updates'
  /* A screen, not a mode: as a boolean it was cleared by `goToTab`, so
     switching tab silently discarded a half-filled lead. */
  | 'addLead';

function readHash(): string {
  return window.location.hash.replace(/^#/, '');
}

/** The cold-start steps the splash reports, in the order they run. */
const BOOT_STEPS = ['server', 'session', 'assets'] as const;

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
      <ResetProvider>
        <OfficePanel />
      </ResetProvider>
    </ToastProvider>
  );
}

function OfficePanel() {
  const toast = useToast();

  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [session, setSession] = useState<PanelSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [view, setView] = useState<LocalView | null>(null);
  const [rejections, setRejections] = useState<MutationResult[]>([]);

  const [tab, setTab] = useState<Tab>('dashboard');
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
          const { session: restored } = await withTimeout(api.session());
          if (cancelled) return;
          setSession(restored);
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
        // transport failure or an unstructured 500, whose message is
        // "Request failed" and helps nobody.
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
  useEffect(() => {
    if (!session) return;
    void refreshSyncState();
  }, [session, refreshSyncState]);

  // One event stream per signed-in session.
  useEffect(() => {
    if (!session) return;

    const source = new EventSource('/api/events');

    source.addEventListener('status', (event) => {
      const status = JSON.parse((event as MessageEvent).data) as Partial<ConnectionInfo>;
      setConnection((current) => (current ? { ...current, ...status } : current));
      if (status.state === 'connected') {
        void refreshConnection();
        void refreshSyncState();
        // The link coming back is when the Master gets to re-check who this
        // is; a since-deactivated user learns about it here.
        void refreshSession();
      }
    });

    /*
     * The assistant's tokens, on the stream this browser already has open.
     * `MasterConnection` re-emits exactly one `ai:event` listener into it, so
     * nothing here is attached or removed per run.
     */
    source.addEventListener('ai', (event) => {
      publishAiEvent(JSON.parse((event as MessageEvent).data));
    });

    source.addEventListener('snapshot', (event) => {
      setView(JSON.parse((event as MessageEvent).data) as LocalView);
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
  }, [session, refreshConnection, refreshSession, refreshSyncState]);

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
      if (outcome.rejections.length > 0 && can('sync.resolveConflicts')) {
        toast.push(`${outcome.rejections.length} change(s) were refused`, {
          tone: 'error',
          action: { label: t('action.reviewConflicts'), onClick: () => setTab('conflicts') },
        });
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not sync';
      setError(message);
      toast.push(message, { tone: 'error' });
    } finally {
      setFlushing(false);
    }
  }

  async function signOut(): Promise<void> {
    await api.signOut();
    setSession(null);
    setView(null);
    setTab('dashboard');
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
    return <SignInScreen connection={connection} onSignedIn={setSession} />;
  }

  const permissions = session.permissions;
  const can = (permission: string): boolean => permissions.includes(permission);

  const openConflicts = (view?.conflicts ?? []).filter((conflict) => !conflict.resolvedAt).length;
  const pendingCount = view?.pendingCount ?? 0;

  // ---- Presence rail (§7): conflict review > offline pending > syncing > synced.
  const linkDown = connection.state === 'disconnected' || !connection.hasNetworkLink;
  let railState: 'synced' | 'syncing' | 'offline' | 'offlinePending' | 'conflict';
  if (openConflicts > 0 && can('sync.resolveConflicts')) railState = 'conflict';
  else if (linkDown || connection.state === 'unpaired' || connection.state === 'connecting')
    railState = pendingCount > 0 ? 'offlinePending' : 'offline';
  else railState = flushing || pendingCount > 0 ? 'syncing' : 'synced';

  const syncLabel =
    railState === 'conflict'
      ? t('sync.conflictReview', { count: openConflicts })
      : railState === 'offlinePending'
        ? t('sync.offlinePending', { count: pendingCount })
        : railState === 'offline'
          ? t('sync.offline')
          : railState === 'syncing'
            ? t('sync.syncing', { count: pendingCount })
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
  const groups: NavGroup[] = [
    {
      label: t('nav.work'),
      items: (
        [
          // Always present, unlike the rest of this group: it only aggregates
          // what the screens below already show, so it needs no permission of
          // its own beyond being signed in.
          { id: 'dashboard', label: t('nav.dashboard'), icon: 'dashboard' as const },
          can('leads.view') ? { id: 'leads', label: t('nav.leads'), icon: 'leads' as const } : null,
          can('orders.view')
            ? { id: 'orders', label: t('nav.orders'), icon: 'orders' as const }
            : null,
          can('sync.resolveConflicts')
            ? {
                id: 'conflicts',
                label: t('nav.conflicts'),
                icon: 'conflicts' as const,
                count: openConflicts > 0 ? openConflicts : undefined,
              }
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
      // Per-machine appearance and device info — nothing here is gated by a
      // permission, so this group has exactly one item, always.
      label: t('nav.system'),
      items: (
        [
          // Absent rather than disabled, like every other permission-gated
          // entry: a greyed tab for a permission somebody will never hold is a
          // permanent tease.
          can('ai.use')
            ? { id: 'assistant', label: t('nav.assistant'), icon: 'eye' as const }
            : null,
          { id: 'settings', label: t('nav.settings'), icon: 'settings' as const },
          { id: 'updates', label: t('nav.updates'), icon: 'sync' as const },
        ] satisfies Array<NavItem | null>
      ).filter((item): item is NonNullable<typeof item> => item !== null),
    },
  ];

  // Map sidebar ids back onto the tabs the screens know.
  const idToTab: Record<string, Tab> = {
    assistant: 'assistant',
    dashboard: 'dashboard',
    leads: 'leads',
    orders: 'orders',
    parties: 'parties',
    partyAccess: 'partyAccess',
    products: 'products',
    conflicts: 'conflicts',
    settings: 'settings',
    updates: 'updates',
  };

  /** Shared by the sidebar and by in-content links (e.g. the Dashboard's stat cards). */
  /*
   * One counter per screen; bumping it re-keys that screen inside
   * `ScreenHost` and React remounts it. The deliberate way to throw away a
   * draft, now that navigating away no longer does.
   */

  function resetActiveScreen(): void {
    if (route === 'gallery') return;
    if (!askReset()) return;
    const id = idToTab[activeId] ?? activeId;
    setResetNonce((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
  }

  function goToTab(id: string): void {
    // Clear a stale #/gallery so the hash and the state agree; replaceState
    // does not fire hashchange, the setRoute below is the source of truth.
    if (readHash())
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setRoute('');
    if (idToTab[id]) setTab(idToTab[id]);
  }

  const activeId =
    route === 'gallery'
      ? 'gallery'
      : groups.some((group) => group.items.some((item) => item.id === idToTab[tab]))
        ? tab
        : (groups.flatMap((group) => group.items)[0]?.id ?? '');

  const activeLabel =
    route === 'gallery'
      ? t('footer.designSystem')
      : (groups.flatMap((group) => group.items).find((item) => item.id === activeId)?.label ??
        t('app.panel'));

  const lastSynced = connection.lastSyncedAt
    ? new Date(connection.lastSyncedAt).toLocaleString()
    : '—';

  const topbar = (
    <>
      <h1 className="ob-title" style={{ marginRight: 'var(--s-4)' }}>
        {activeLabel}
      </h1>

      <span style={{ flex: 1 }} />

      <PaletteButton />

      {tab !== 'addLead' && route !== 'gallery' && can('leads.create') && (
        <button
          className="ob-btn ob-btn--primary"
          disabled={!view}
          onClick={() => setTab('addLead')}
        >
          {t('action.newLead')}
        </button>
      )}

      <IconButton
        icon="reset"
        label={t('screen.reset')}
        title={t('screen.resetHint')}
        onClick={resetActiveScreen}
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
        subscribeMenu={(handler) => desktopBridge()?.onMenuCommand?.(handler)}
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
          if (hit.kind === 'product') goToTab('products');
          else if (hit.kind === 'party') goToTab('parties');
          else if (hit.kind === 'lead_line') goToTab('leads');
          else goToTab('orders');
        }}
      />
      {syncPopover && (
        <>
          {/* Click-away shim keeps the popover honest without a portal. */}
          <div
            style={{ position: 'absolute', inset: 0, zIndex: 'var(--z-popover)' }}
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
                  onClick={() => {
                    setSyncPopover(false);
                    setRoute('');
                    setTab('conflicts');
                  }}
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
   * when an operator needs them. Everything else takes a non-null `LocalView`.
   * `ScreenHost` renders all visited screens at once, so a null view must
   * never reach the second tier; the gate stays outside the host.
   *
   * `addLead` is a screen here rather than a mode, which is what stops a
   * half-filled lead being thrown away by navigating to another tab.
   */
  const alwaysAvailable: ScreenSpec[] = [
    {
      id: 'assistant',
      render: () => (
        <AssistantScreen
          transport={{
            status: api.aiStatus,
            listRuns: api.aiRuns,
            ask: api.aiAsk,
            cancel: api.aiCancel,
          }}
        />
      ),
    },
    {
      id: 'updates',
      render: () => <UpdatesScreen connection={connection} permissions={permissions} />,
    },
    {
      id: 'settings',
      render: () => (
        <SettingsScreen
          connection={connection}
          session={session}
          pendingCount={pendingCount}
          openConflicts={openConflicts}
        />
      ),
    },
  ];

  const needsView: ScreenSpec[] = view
    ? [
        { id: 'dashboard', render: () => <DashboardScreen view={view} onNavigate={goToTab} /> },
        {
          id: 'leads',
          render: () => (
            <LeadBoardScreen
              view={view}
              canConvert={can('lead.convert')}
              onError={setError}
              onAddLead={can('leads.create') ? () => setTab('addLead') : undefined}
            />
          ),
        },
        {
          id: 'orders',
          render: () => (
            <OrderBoardScreen view={view} canDispatch={can('orders.dispatch')} onError={setError} />
          ),
        },
        {
          id: 'conflicts',
          render: () => (
            <ConflictsScreen
              conflicts={view.conflicts}
              canResolve={can('sync.resolveConflicts')}
              onError={setError}
              onResolved={() => void flush()}
            />
          ),
        },
        {
          id: 'partyAccess',
          render: () => (
            <PartyAccessScreen permissions={permissions} revision={view.pendingCount ?? 0} />
          ),
        },
        // Two entries sharing one screen: the sidebar has separate Parties and
        // Products items, and each keeps its own state.
        { id: 'parties', render: () => <CatalogScreen view={view} tab="parties" /> },
        { id: 'products', render: () => <CatalogScreen view={view} tab="products" /> },
        {
          id: 'addLead',
          render: () => (
            <AddLeadScreen
              view={view}
              canEditRate={can('field.saleRate.edit')}
              onSaved={() => {
                setTab('leads');
                toast.push('Lead saved on this machine — it syncs when the Master is reachable');
              }}
              onCancel={() => setTab('leads')}
            />
          ),
        },
      ]
    : [];

  const screens = [...alwaysAvailable, ...needsView];
  const activeScreenId = idToTab[activeId] ?? activeId;
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
      shellCommands={{
        'view.reset': resetActiveScreen,
        // As on the Master: the shell swallows F5, so this is what hands the key
        // back rather than a second, different meaning for it.
        'view.refresh': () => window.location.reload(),
        // A new record on this panel is a lead. Absent rather than inert when
        // the role cannot create one — the palette then simply does not offer it.
        'record.new': can('leads.create') ? () => setTab('addLead') : null,
      }}
    >
      <FilterBarProvider>
        <AppShell
          groups={groups}
          activeId={activeId}
          onNavigate={goToTab}
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
