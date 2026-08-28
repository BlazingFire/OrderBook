/**
 * Lets a screen put a large operation into the sidebar, nested under the module
 * it belongs to (§8).
 *
 * Editing a role means reading a ten-by-six permission matrix, two capability
 * groups and a tier that re-scopes all of them. That is a screen, not a panel —
 * and a screen the operator can be *in* needs to say so somewhere, or there is
 * no way back except a Cancel button and no way to tell, at a glance, what the
 * app is currently showing. So while such an editor is open its own entry
 * appears directly under its module in the sidebar and is the current page.
 *
 * The publish-don't-prop-drill shape is `FilterBarSlot`'s, with one difference
 * that matters: the subscriber here (`App`) is an *ancestor* of the publisher
 * (`AccessScreen`), so re-publishing an equal-but-newly-allocated object on
 * every render would re-render the publisher, which would publish again — a
 * loop with no fixed point. `useSubNav` therefore keys its publish on a
 * signature of the contents rather than on object identity.
 *
 * ## Why this is a registry rather than one value
 *
 * Screens are kept mounted and hidden by `<Activity>` instead of being
 * unmounted, and hiding a pane runs its effect cleanups. The previous version
 * ended with `useEffect(() => () => set(null), [set])` — so navigating away
 * from an open role editor deleted the very sidebar entry this feature exists
 * to show, and coming back found it gone.
 *
 * Entries are therefore held per screen and **never cleared on teardown**.
 * They go away when the screen's own close action says so, or when the shell
 * resets that screen. The shell asks for the entry belonging to whichever
 * screen is currently visible.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { NavItem } from './AppShell.js';

export interface SubNavState {
  /** The nav item these sit under. */
  parentId: string;
  items: NavItem[];
  /** Which of `items` is the current page. */
  activeId: string;
}

interface Registry {
  publish: (screenId: string, state: SubNavState | null) => void;
  entries: ReadonlyMap<string, SubNavState>;
}

const RegistryContext = createContext<Registry>({
  publish: () => undefined,
  entries: new Map(),
});

export function SubNavProvider({ children }: { children: ReactNode }) {
  // A ref so publishing does not depend on render order, plus a version
  // counter to tell React something changed. A plain state Map would make
  // every publish a new object and re-render every consumer.
  const entriesRef = useRef(new Map<string, SubNavState>());
  const [version, setVersion] = useState(0);

  const publish = useCallback((screenId: string, state: SubNavState | null) => {
    const entries = entriesRef.current;
    if (state === null) {
      if (!entries.has(screenId)) return;
      entries.delete(screenId);
    } else {
      entries.set(screenId, state);
    }
    setVersion((current) => current + 1);
  }, []);

  const value = useMemo<Registry>(
    // `version` is the dependency that matters; the ref's contents changed
    // under it.
    () => ({ publish, entries: entriesRef.current }),
    [publish, version],
  );

  return <RegistryContext.Provider value={value}>{children}</RegistryContext.Provider>;
}

/** Read by the shell: the open operation on the screen currently showing. */
export function useSubNavState(screenId: string | null): SubNavState | null {
  const { entries } = useContext(RegistryContext);
  return screenId ? (entries.get(screenId) ?? null) : null;
}

/** Drop a screen's entry — used by the shell when that screen is reset. */
export function useClearSubNav(): (screenId: string) => void {
  const { publish } = useContext(RegistryContext);
  return useCallback((screenId: string) => publish(screenId, null), [publish]);
}

/**
 * Call from a screen with the operation it currently has open, or null.
 *
 * Deliberately has no unmount cleanup: see the note at the top of this file.
 */
export function useSubNav(screenId: string, state: SubNavState | null): void {
  const { publish } = useContext(RegistryContext);

  // Contents, not identity — an equal-but-new object every render would loop.
  const signature = state
    ? `${state.parentId}|${state.activeId}|${state.items.map((item) => `${item.id}:${item.label}:${item.icon}`).join(',')}`
    : '';

  /*
   * The latest state, in a ref, so the effect can read it without depending on
   * it — the same shape `useOverlay` uses for `onClose`, and for the same
   * reason. `state` is a freshly-allocated object every render; listing it as
   * a dependency would publish on every render, which re-renders the
   * subscriber, which re-renders the publisher — a loop with no fixed point.
   * The signature is what decides whether anything actually changed.
   */
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    publish(screenId, latest.current);
  }, [signature, screenId, publish]);
}
