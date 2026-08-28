/**
 * Lets the active screen put its own control into the topbar's trailing
 * cluster, without the shell needing to know what each screen switches
 * between.
 *
 * A view switcher — Users versus Roles, say — is chrome for the whole screen,
 * not a row in it, so it belongs beside the screen's name rather than stacked
 * above the first card. Trailing, but *inside* the app-wide controls: Search
 * and Sign out stay outermost, because they mean the same thing everywhere and
 * this does not.
 *
 * Same publish-don't-prop-drill shape as `FilterBarSlot`, including the reason
 * its setter and value are two separate contexts: a screen rebuilds its control
 * as fresh JSX every render, so a publisher that also subscribed would
 * re-render in response to its own publish and never reach a fixed point.
 * `TopbarActionsOutlet` is a leaf inside the topbar, never an ancestor of a
 * publisher, so nothing upstream re-renders when a screen publishes.
 */

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

const SetTopbarActionsContext = createContext<(node: ReactNode) => void>(() => undefined);
const TopbarActionsNodeContext = createContext<ReactNode>(null);

export function TopbarActionsProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<ReactNode>(null);
  return (
    <SetTopbarActionsContext.Provider value={setNode}>
      <TopbarActionsNodeContext.Provider value={node}>{children}</TopbarActionsNodeContext.Provider>
    </SetTopbarActionsContext.Provider>
  );
}

/** Renders nothing — not even a divider — when no screen has published one. */
export function TopbarActionsOutlet() {
  const node = useContext(TopbarActionsNodeContext);
  return node ? <div className="ob-topbar-actions">{node}</div> : null;
}

/** Call from a screen with the control it wants in the topbar; null for none. */
export function useTopbarActions(node: ReactNode): void {
  const set = useContext(SetTopbarActionsContext);
  useEffect(() => {
    set(node);
  });
  // Mount/unmount only: clears the slot when this screen goes away, even if its
  // last render published something.
  useEffect(() => () => set(null), [set]);
}
