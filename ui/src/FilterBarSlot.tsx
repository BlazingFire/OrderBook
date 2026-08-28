/**
 * Lets the active list screen publish its own filter bar (§8's 40px strip
 * under the topbar, list screens only) without the shell needing to know
 * what each screen's filters look like, and without prop-drilling a setter
 * through App.tsx for every screen. A screen calls `useFilterBar(<...>)`;
 * `FilterBarOutlet` renders whatever the currently-mounted screen published.
 *
 * **The setter and the value are two separate contexts on purpose.** A screen
 * builds its filter bar as a fresh JSX element every render, so publishing it
 * always changes the provider's state. If publishers also subscribed to that
 * state they would re-render in response to their own publish, build another
 * new element, and publish again — a loop with no fixed point, which React
 * reports as "Maximum update depth exceeded" and which pins a CPU core on
 * every list screen in both panels. Splitting the contexts means a publisher
 * subscribes only to `SetFilterBarContext`, whose value is a `useState` setter
 * and therefore referentially stable for the life of the provider.
 */

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface FilterBarApi {
  set: (node: ReactNode) => void;
  /** Clear, but only if this node is still the one showing. */
  release: (node: ReactNode) => void;
}

const SetFilterBarContext = createContext<FilterBarApi>({
  set: () => undefined,
  release: () => undefined,
});
const FilterBarNodeContext = createContext<ReactNode>(null);

export function FilterBarProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<ReactNode>(null);

  // Stable for the life of the provider, so a publisher subscribing to it
  // never re-renders in response to its own publish.
  const api = useRef<FilterBarApi>({
    set: (next) => setNode(next),
    release: (owned) => setNode((current) => (current === owned ? null : current)),
  }).current;

  return (
    <SetFilterBarContext.Provider value={api}>
      <FilterBarNodeContext.Provider value={node}>{children}</FilterBarNodeContext.Provider>
    </SetFilterBarContext.Provider>
  );
}

/** Renders nothing when no mounted screen has published a filter bar — the
 * 40px strip exists only for list screens, never as an empty gap (§8). */
export function FilterBarOutlet() {
  const node = useContext(FilterBarNodeContext);
  return node ? <div className="ob-filterbar">{node}</div> : null;
}

/** Call from a screen with the filter bar content it wants shown; pass null for none. */
export function useFilterBar(node: ReactNode): void {
  const { set, release } = useContext(SetFilterBarContext);
  useEffect(() => {
    set(node);
  });
  /*
   * Clear only if this screen still owns the strip.
   *
   * Screens are hidden rather than unmounted now, and React does not promise
   * that the outgoing pane's cleanup runs before the incoming pane's effect.
   * An unconditional `set(null)` therefore raced: hide-then-show left the bar
   * correct, show-then-hide wiped the bar the *new* screen had just published.
   */
  useEffect(() => () => release(node), [release, node]);
}
