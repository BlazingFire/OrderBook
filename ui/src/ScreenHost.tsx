/**
 * Keeps every screen you have visited alive, so coming back to a tab shows
 * what you left rather than a fresh one.
 *
 * The panels used to render exactly one screen — a `switch (tab)` returning a
 * single element — so navigating away unmounted it and threw away everything
 * it held: filters, scroll position, an open drawer, a half-typed form, a
 * pagination cursor. The Access screen alone carries 41 `useState`s and the
 * Fields screen 50. Coming back re-fetched all of it and started over.
 *
 * `<Activity mode="hidden">` is what makes this affordable. It keeps the
 * component's state and its DOM but **runs its effect cleanups**, so a hidden
 * screen has no live subscriptions, no timers and no polling — and the four
 * slot providers (filter bar, keyboard commands, sub-nav, topbar actions) see it
 * withdraw exactly as if it had unmounted. A hand-rolled `display:none`
 * wrapper would have kept every hidden screen fully live, which is worse than
 * the problem it solves. See `ui/tests/activity-spike.test.tsx` for the
 * behaviour actually verified.
 *
 * Two consequences are load-bearing and handled elsewhere:
 *  · a hidden pane's DOM is still in the document, so `useOverlay` filters its
 *    `[role="dialog"]` query by visibility, or a hidden screen's open dialog
 *    steals Escape from the visible one;
 *  · effect teardown no longer means "gone for good", so `useSubNav` keeps a
 *    registry per screen rather than clearing itself on cleanup.
 *
 * ## Low memory
 *
 * Every screen kept alive costs memory, and the shop's oldest PCs have 4 GB.
 * So the host keeps at most `liveBudget()` screens: 4 on a machine reporting
 * 4 GB or less, or reporting nothing (`navigator.deviceMemory` only exists in
 * a secure context, and the Master is opened over plain LAN http), else 8.
 * Past that, the screen visited longest ago is unmounted and starts fresh
 * when somebody returns to it. Never evicted: the screen on show, `addLead`,
 * `settings` (its rows keep unsaved drafts inline and publish no sidebar
 * entry), and any screen holding a sidebar entry (an open record, a draft, an
 * editor), since that entry is exactly the work an eviction would lose.
 *
 * A hidden screen is also frozen (`Frozen`): the shell re-renders on every
 * sync tick and keystroke in the topbar, and a hidden screen has nothing to
 * show for it. It catches up with its props the moment it is shown again.
 *
 * Rarely visited screens arrive through `lazyScreen`, so each pane sits in a
 * Suspense boundary whose fallback drives the loading strip.
 */

import { Activity, Suspense, lazy, memo, useRef, useState } from 'react';
import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';

import { useSubNavHeld } from './SubNavSlot';
import { LoadingMark } from './TopProgress';

export interface ScreenSpec {
  id: string;
  render: () => ReactNode;
}

/** Screens kept alive whatever the budget, besides the one on show. */
const ALWAYS_LIVE = new Set(['addLead', 'settings']);

/** How many screens to keep alive on this machine. Read per render: cheap, and a test can stub it. */
export function liveBudget(): number {
  const memory =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as { deviceMemory?: number }).deviceMemory;
  return memory === undefined || memory <= 4 ? 4 : 8;
}

/**
 * Drops the least recently shown screens until `order` fits the budget,
 * skipping the pinned ones. `order` runs oldest first.
 */
function evict(order: string[], budget: number, pinned: (id: string) => boolean): string[] {
  const kept = [...order];
  for (let index = 0; kept.length > budget && index < kept.length;) {
    if (pinned(kept[index] as string)) index += 1;
    else kept.splice(index, 1);
  }
  return kept;
}

export function ScreenHost({
  screens,
  activeId,
  resetNonce = {},
}: {
  screens: ScreenSpec[];
  activeId: string;
  /** Bump a screen's entry to remount it — see `ResetSlot`. */
  resetNonce?: Record<string, number>;
}) {
  const held = useSubNavHeld();
  // Oldest first; the screen on show is always last.
  const [visited, setVisited] = useState<readonly string[]>(() => [activeId]);

  /*
   * Updated during render, not in an effect.
   *
   * An effect would commit a frame in which the newly-selected screen is not
   * in `visited` and therefore renders nothing — a blank flash on the first
   * visit to each of the fourteen master tabs and nine office ones. React
   * re-renders before painting when state is set during render, so this
   * costs a render pass and no frame.
   */
  if (
    visited[visited.length - 1] !== activeId &&
    screens.some((screen) => screen.id === activeId)
  ) {
    setVisited(
      evict(
        [
          ...visited.filter((id) => id !== activeId && screens.some((screen) => screen.id === id)),
          activeId,
        ],
        liveBudget(),
        (id) => id === activeId || ALWAYS_LIVE.has(id) || held.has(id),
      ),
    );
  }

  return (
    <>
      {screens
        .filter((screen) => visited.includes(screen.id))
        .map((screen) => (
          <Activity
            // The nonce is part of the key, so bumping it is a remount and
            // therefore a total reset with no per-screen cooperation.
            key={`${screen.id}:${resetNonce[screen.id] ?? 0}`}
            mode={screen.id === activeId ? 'visible' : 'hidden'}
          >
            <ScreenPane active={screen.id === activeId}>
              <Suspense fallback={<LoadingMark />}>
                <Frozen active={screen.id === activeId} render={screen.render} />
              </Suspense>
            </ScreenPane>
          </Activity>
        ))}
    </>
  );
}

/**
 * Renders a screen, and skips re-rendering it while it is hidden.
 *
 * `render` is a fresh closure on every shell render, so without this every
 * hidden screen would be rebuilt each time the shell re-rendered. Its effects
 * are already torn down by `<Activity>`; this stops the render work as well.
 */
const Frozen = memo(
  function Frozen({ render }: { active: boolean; render: () => ReactNode }) {
    return <>{render()}</>;
  },
  (_previous, next) => !next.active,
);

const CHUNK_RELOAD_KEY = 'ob.chunkReload';
const CHUNK_RELOAD_GAP_MS = 60_000;

/**
 * A screen loaded on first visit rather than at start-up:
 * `lazyScreen(() => import('./screens/LogsScreen.js'), 'LogsScreen')`.
 *
 * A LAN browser tab left open across a Master update asks for a chunk the new
 * build no longer has. That failure reloads the page once, which fetches the
 * new build; a second failure within a minute is a real one and reaches the
 * ErrorBoundary instead of reloading for ever.
 */
export function lazyScreen<K extends string, P extends object>(
  load: () => Promise<Record<K, ComponentType<P>>>,
  name: K,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() =>
    load().then(
      (loaded) => {
        try {
          sessionStorage.removeItem(CHUNK_RELOAD_KEY);
        } catch {
          // Storage blocked: nothing to clear.
        }
        return { default: loaded[name] };
      },
      (error: unknown) => {
        let reloading = false;
        try {
          // A time, not a flag: after the reload the panel lands on a screen
          // that is not lazy, so nothing may clear it before the next update
          // reaches this tab. A minute apart is a new update, not a loop.
          const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0);
          if (!(Date.now() - last < CHUNK_RELOAD_GAP_MS)) {
            sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
            reloading = true;
          }
        } catch {
          // Without storage there is no way to tell a second failure from the
          // first, so do not reload at all.
        }
        if (!reloading) throw error;
        window.location.reload();
        // Stay suspended until the reload takes the page away.
        return new Promise<never>(() => undefined);
      },
    ),
  );
}

/**
 * One screen's scroll container, which remembers where it was.
 *
 * `<Activity>` preserves state but not the DOM's own scroll offset, and the
 * ref survives the hide — so the position is captured on the way out and put
 * back on the way in.
 */
function ScreenPane({ active, children }: { active: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  const wasActive = useRef(active);

  if (wasActive.current !== active) {
    if (active) {
      // Restore after this commit paints, or the element is still hidden and
      // assigning `scrollTop` silently does nothing.
      queueMicrotask(() => {
        if (ref.current) ref.current.scrollTop = offset.current;
      });
    } else if (ref.current) {
      offset.current = ref.current.scrollTop;
    }
    wasActive.current = active;
  }

  return (
    <div className="ob-pane" ref={ref}>
      {children}
    </div>
  );
}
