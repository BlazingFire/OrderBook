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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutationResult, SearchHit } from '@orderbook/shared';

import { api, type ConnectionInfo, type LocalView, type PanelSession } from './api';
import { t } from './i18n/strings';
import { AddLeadScreen } from './screens/AddLeadScreen';
import { CatalogScreen } from './screens/CatalogScreen';
import { ConflictsScreen } from './screens/ConflictsScreen';
import { ConnectionScreen } from './screens/ConnectionScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { LeadBoardScreen } from './screens/LeadBoardScreen';
import { OrderBoardScreen } from './screens/OrderBoardScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SignInScreen } from './screens/SignInScreen';
import { AppShell, type NavGroup, type NavItem } from './ui/AppShell';
import { BusyMark } from './ui/BusyMark';
import { FilterBarOutlet, FilterBarProvider } from './ui/FilterBarSlot';
import { SaveShortcutProvider } from './ui/SaveShortcutSlot';
import { GalleryScreen } from './ui/GalleryScreen';
import { Icon } from './ui/icons';
import { Splash } from './ui/Splash';
import { ToastProvider, useToast } from './ui/Toast';

type Tab = 'dashboard' | 'leads' | 'orders' | 'parties' | 'products' | 'conflicts' | 'settings';

/**
 * How often the shell re-asks this panel's own server while it is still
 * coming up. The launcher opens the browser as soon as it has started the
 * server, so the first request can easily land before anything is listening.
 */
const BOOTSTRAP_RETRY_MS = 2000;

function readHash(): string {
  return window.location.hash.replace(/^#/, '');
}

export function App() {
  return (
    <ToastProvider>
      <OfficePanel />
    </ToastProvider>
  );
}

function OfficePanel() {
  const toast = useToast();

  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  /** True once this panel's own server has failed to answer at least once. */
  const [bootFailed, setBootFailed] = useState(false);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [session, setSession] = useState<PanelSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [view, setView] = useState<LocalView | null>(null);
  const [rejections, setRejections] = useState<MutationResult[]>([]);

  const [tab, setTab] = useState<Tab>('dashboard');
  const [addingLead, setAddingLead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flushing, setFlushing] = useState(false);

  // Shell chrome state.
  const [route, setRoute] = useState(readHash);
  const [collapsed, setCollapsed] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  const [syncPopover, setSyncPopover] = useState(false);

  // Universal search ('/', 180ms debounce, FTS-backed on the Master).
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searchFailedOffline, setSearchFailedOffline] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  const refreshConnection = useCallback(async () => {
    try {
      setConnection(await api.connection());
      setBootFailed(false);
    } catch {
      setConnection(null);
      // This panel's own server did not answer. Before, that left `connection`
      // null forever and the shell below rendered "Starting…" with no message
      // and no retry — so a browser opened a moment too early after a launch
      // never recovered on its own.
      setBootFailed(true);
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

  useEffect(() => {
    void refreshConnection();
    void refreshSession();
  }, [refreshConnection, refreshSession, bootAttempt]);

  // Keep asking while this panel's server is still coming up. It listens
  // within a second of launch normally, but the launcher opens the browser
  // straight away and a cold Node start on a shop PC is not instant.
  useEffect(() => {
    if (!bootFailed) return;
    const timer = window.setTimeout(() => setBootAttempt((attempt) => attempt + 1), BOOTSTRAP_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [bootFailed, bootAttempt]);

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

    source.addEventListener('snapshot', (event) => {
      setView(JSON.parse((event as MessageEvent).data) as LocalView);
      void refreshSyncState();
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
    setAddingLead(false);
    setHits(null);
    setTerm('');
  }

  function runSearch(next: string): void {
    setTerm(next);
    window.clearTimeout(debounceRef.current);
    if (!next.trim()) {
      setHits(null);
      setSearchFailedOffline(false);
      return;
    }
    debounceRef.current = window.setTimeout(async () => {
      try {
        setHits(await api.search(next.trim()));
        setSearchFailedOffline(false);
      } catch {
        setHits(null);
        setSearchFailedOffline(true);
      }
    }, 180);
  }

  // Global keys: `/` focuses search; Esc closes innermost overlay first (§10).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typingTarget =
        document.activeElement instanceof HTMLElement &&
        (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) ||
          document.activeElement.isContentEditable);
      if (event.key === '/' && !typingTarget) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'Escape') {
        if (hits !== null || term !== '') {
          setHits(null);
          setTerm('');
        } else if (syncPopover) {
          setSyncPopover(false);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hits, term, syncPopover]);

  if (!connection || !sessionChecked || !splashDone) {
    return (
      <>
        {!splashDone && <Splash wordmark={t('app.name')} onDone={() => setSplashDone(true)} />}
        {bootFailed ? (
          <StartupWaiting
            attempt={bootAttempt}
            onRetry={() => {
              setBootFailed(false);
              setBootAttempt((attempt) => attempt + 1);
            }}
          />
        ) : (
          (!connection || !sessionChecked) && (
            <div style={{ padding: 'var(--s-40)', color: 'var(--fg-secondary)' }}>{t('shell.starting')}</div>
          )
        )}
      </>
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
          can('leads.view')
            ? { id: 'leads', label: t('nav.leads'), icon: 'leads' as const }
            : null,
          can('orders.view') ? { id: 'orders', label: t('nav.orders'), icon: 'orders' as const } : null,
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
          can('parties.view') ? { id: 'parties', label: t('nav.parties'), icon: 'parties' as const } : null,
        ] satisfies Array<NavItem | null>
      ).filter((item): item is NonNullable<typeof item> => item !== null),
    },
    {
      // Per-machine appearance and device info — nothing here is gated by a
      // permission, so this group has exactly one item, always.
      label: t('nav.system'),
      items: [{ id: 'settings', label: t('nav.settings'), icon: 'settings' as const }],
    },
  ];

  // Map sidebar ids back onto the tabs the screens know.
  const idToTab: Record<string, Tab> = {
    dashboard: 'dashboard',
    leads: 'leads',
    orders: 'orders',
    parties: 'parties',
    products: 'products',
    conflicts: 'conflicts',
    settings: 'settings',
  };

  /** Shared by the sidebar and by in-content links (e.g. the Dashboard's stat cards). */
  function goToTab(id: string): void {
    // Clear a stale #/gallery so the hash and the state agree; replaceState
    // does not fire hashchange, the setRoute below is the source of truth.
    if (readHash()) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setRoute('');
    setAddingLead(false);
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
      : (groups.flatMap((group) => group.items).find((item) => item.id === activeId)?.label ?? t('app.panel'));

  const lastSynced = connection.lastSyncedAt ? new Date(connection.lastSyncedAt).toLocaleString() : '—';

  const topbar = (
    <>
      <h1 className="ob-title" style={{ marginRight: 'var(--s-4)' }}>
        {activeLabel}
      </h1>

      <span style={{ flex: 1 }} />

      <div className="ob-search">
        <input
          ref={searchRef}
          className="ob-input"
          value={term}
          onChange={(event) => runSearch(event.target.value)}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          autoComplete="off"
        />
        <kbd>/</kbd>
        {term.trim() !== '' && (hits !== null || searchFailedOffline) && (
          <div className="ob-popover" style={{ left: 0, right: 0, top: 'calc(var(--ctl-h-md) + var(--s-4))', padding: 'var(--s-4)' }}>
            {searchFailedOffline ? (
              <p className="ob-small" style={{ padding: 'var(--s-8)' }}>
                {t('search.failedOffline')}
              </p>
            ) : hits !== null && hits.length === 0 ? (
              <p className="ob-small" style={{ padding: 'var(--s-8)' }}>
                {t('search.noResults', { term })}
              </p>
            ) : (
              (hits ?? []).map((hit) => (
                <button
                  key={`${hit.kind}:${hit.id}`}
                  type="button"
                  onClick={() => {
                    setHits(null);
                    setTerm('');
                    searchRef.current?.blur();
                  }}
                  className="ob-navitem"
                  style={{ borderRadius: 'var(--r-sm)' }}
                >
                  <Icon
                    name={hit.kind === 'product' ? 'products' : hit.kind === 'party' ? 'parties' : 'orders'}
                  />
                  <span>{hit.title}</span>
                  {hit.subtitle && <span className="count">{hit.subtitle}</span>}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {!addingLead && route !== 'gallery' && can('leads.create') && (
        <button
          className="ob-btn ob-btn--primary"
          disabled={!view}
          onClick={() => setAddingLead(true)}
        >
          {t('action.newLead')}
        </button>
      )}

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
      {connection.companyName && <span>{`${t('footer.company')} · ${connection.companyName}`}</span>}
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
      <span className="ob-mono" style={{ fontSize: '10.5px', color: 'var(--fg-tertiary)' }}>
        {t('footer.version')}
      </span>
    </>
  );

  const overlays = (
    <>
      {syncPopover && (
        <>
          {/* Click-away shim keeps the popover honest without a portal. */}
          <div style={{ position: 'absolute', inset: 0, zIndex: 'var(--z-popover)' }} onClick={() => setSyncPopover(false)} />
          <div className="ob-popover" style={{ left: 'var(--s-12)', bottom: 'calc(var(--shell-footer-h) + var(--s-8))', width: 300, padding: 'var(--s-16)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
              <span className="ob-body-strong">{syncLabel}</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="ob-icon-btn" aria-label={t('action.close')} title={t('action.close')} onClick={() => setSyncPopover(false)}>
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
              <dd className="ob-mono" style={{ fontSize: '11.5px' }}>
                {connection.masterHost ?? '—'}
              </dd>
            </dl>
            <div style={{ display: 'flex', gap: 'var(--s-8)', marginTop: 'var(--s-12)', paddingTop: 'var(--s-8)', borderTop: '1px solid var(--line)' }}>
              <button className="ob-btn ob-btn--secondary ob-btn--sm" disabled={flushing || pendingCount === 0} aria-busy={flushing} onClick={() => void flush()}>
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
        <div className="ob-banner ob-banner--conflict" role="alert" style={{ position: 'absolute', right: 'var(--s-20)', bottom: 'calc(var(--shell-footer-h) + var(--s-8))', zIndex: 'var(--z-toast)' }}>
          <span>{error}</span>
          <span style={{ flex: 1 }} />
          <button className="ob-icon-btn" aria-label={t('action.dismiss')} title={t('action.dismiss')} onClick={() => setError(null)}>
            <Icon name="close" size={10} />
          </button>
        </div>
      )}
    </>
  );

  const content = (() => {
    if (route === 'gallery') return <GalleryScreen />;

    if (addingLead && view) {
      return (
        <AddLeadScreen
          view={view}
          canEditRate={can('field.saleRate.edit')}
          onSaved={() => {
            setAddingLead(false);
            setTab('leads');
            toast.push('Lead saved on this machine — it syncs when the Master is reachable');
          }}
          onCancel={() => setAddingLead(false)}
        />
      );
    }

    // Per-machine, not per-sync: available even before the first snapshot
    // arrives, unlike everything below it.
    if ((idToTab[activeId] ?? activeId) === 'settings') {
      return (
        <SettingsScreen
          connection={connection}
          session={session}
          pendingCount={pendingCount}
          openConflicts={openConflicts}
        />
      );
    }

    if (!view) {
      return (
        <div className="ob-empty">
          <BusyMark size={48} label="" />
          <h3>{activeLabel}</h3>
          <p>{t('shell.waitingFirstSync')}</p>
        </div>
      );
    }

    switch (idToTab[activeId] ?? activeId) {
      case 'dashboard':
        return <DashboardScreen view={view} onNavigate={goToTab} />;
      case 'leads':
        return (
          <LeadBoardScreen
            view={view}
            canConvert={can('lead.convert')}
            onError={setError}
            onAddLead={can('leads.create') ? () => setAddingLead(true) : undefined}
          />
        );
      case 'orders':
        return <OrderBoardScreen view={view} canDispatch={can('orders.dispatch')} onError={setError} />;
      case 'conflicts':
        return (
          <ConflictsScreen
            conflicts={view.conflicts}
            canResolve={can('sync.resolveConflicts')}
            onError={setError}
            onResolved={() => void flush()}
          />
        );
      case 'parties':
      case 'products':
        return <CatalogScreen view={view} tab={activeId as 'parties' | 'products'} />;
      default:
        // Every tab is behind a permission, so a role with none reaches this.
        // Said plainly rather than shown as an empty list.
        return (
          <div className="ob-empty">
            <h3>{activeLabel}</h3>
            <p>{t('shell.noModules')}</p>
          </div>
        );
    }
  })();

  return (
    <SaveShortcutProvider>
      <FilterBarProvider>
        <AppShell
          groups={groups}
          activeId={activeId}
          onNavigate={goToTab}
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

/**
 * Shown while this panel's own local server is not answering yet.
 *
 * Not an error screen: the ordinary cause is a browser opened a second too
 * early by the launcher, and it clears itself. The advice sharpens once
 * retrying has plainly not worked.
 */
function StartupWaiting({ attempt, onRetry }: { attempt: number; onRetry: () => void }) {
  const stillWaiting = attempt > 5;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--s-12)',
        minHeight: '100vh',
        padding: 'var(--s-40)',
        textAlign: 'center',
      }}
    >
      <BusyMark size={32} />
      <h1 className="ob-title" style={{ margin: 0 }}>
        {t('startup.waiting.title')}
      </h1>
      <p className="ob-small" style={{ margin: 0, maxWidth: 420 }}>
        {stillWaiting ? t('startup.waiting.slow') : t('startup.waiting.body')}
      </p>
      <button type="button" className="ob-btn ob-btn--secondary" onClick={onRetry}>
        {t('action.retryNow')}
      </button>
    </div>
  );
}
