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
 */

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { NavItem } from './AppShell';

export interface SubNavState {
  /** The nav item these sit under. */
  parentId: string;
  items: NavItem[];
  /** Which of `items` is the current page. */
  activeId: string;
  /**
   * Leaving the operation — the shell calls this before navigating elsewhere.
   * Returns false to stay put, which is how an editor holding an unsaved draft
   * gets to ask about it instead of being closed out from under the operator.
   */
  onExit: () => boolean;
}

const SetSubNavContext = createContext<(state: SubNavState | null) => void>(() => undefined);
const SubNavContext = createContext<SubNavState | null>(null);

export function SubNavProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SubNavState | null>(null);
  return (
    <SetSubNavContext.Provider value={setState}>
      <SubNavContext.Provider value={state}>{children}</SubNavContext.Provider>
    </SetSubNavContext.Provider>
  );
}

/** Read by the shell to nest the operation under its module. */
export function useSubNavState(): SubNavState | null {
  return useContext(SubNavContext);
}

/** Call from a screen with the operation it currently has open, or null for none. */
export function useSubNav(state: SubNavState | null): void {
  const set = useContext(SetSubNavContext);

  // Contents, not identity. `onExit` is deliberately excluded: it closes over
  // state setters, which are stable for the life of the screen, and including a
  // freshly-allocated arrow in the key would defeat the whole point.
  const signature = state
    ? `${state.parentId}|${state.activeId}|${state.items.map((item) => `${item.id}:${item.label}:${item.icon}`).join(',')}`
    : '';

  // `state` is deliberately absent from the dependency list: the signature is
  // what decides whether anything actually changed, and the effect always sees
  // the current render's `state` through its closure.
  useEffect(() => {
    set(state);
  }, [signature, set]);

  // Mount/unmount only: a screen that goes away takes its sub-entry with it,
  // even if its last render published one.
  useEffect(() => () => set(null), [set]);
}
