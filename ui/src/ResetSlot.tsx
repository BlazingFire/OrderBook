/**
 * The manual "start this screen over" action.
 *
 * Screens now keep their state indefinitely, which is the point — but it means
 * there has to be a deliberate way to clear one. The shell owns a nonce per
 * screen; bumping it changes that screen's `key` and React remounts it. Total
 * reset, and no screen has to implement anything.
 *
 * The one thing a screen may want is a say in *whether* it happens, because
 * resetting a half-filled Add Lead form throws away real work. A screen
 * registers a guard; the shell asks it first. Same ref shape as
 * `SaveShortcutSlot`, for the same reason: the guard is rebuilt every render
 * and must not be a dependency of anything.
 */

import { createContext, useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/** Return false to refuse the reset — typically after asking the operator. */
type ResetGuard = () => boolean;

interface ResetApi {
  set: (guard: ResetGuard | null) => void;
  release: (guard: ResetGuard | null) => void;
  /** True if the reset may proceed. */
  ask: () => boolean;
}

const ResetContext = createContext<ResetApi>({
  set: () => undefined,
  release: () => undefined,
  ask: () => true,
});

export function ResetProvider({ children }: { children: ReactNode }) {
  const current = useRef<ResetGuard | null>(null);

  const api = useRef<ResetApi>({
    set(guard) {
      current.current = guard;
    },
    // Release only what we registered: screens are hidden rather than
    // unmounted, so cleanup order between the outgoing and incoming pane is
    // not guaranteed.
    release(guard) {
      if (current.current === guard) current.current = null;
    },
    ask() {
      return current.current ? current.current() : true;
    },
  }).current;

  return <ResetContext.Provider value={api}>{children}</ResetContext.Provider>;
}

/**
 * Call from a screen that has something worth confirming before it is thrown
 * away. Screens with nothing at stake register nothing.
 */
export function useResetGuard(guard: ResetGuard | null): void {
  const { set, release } = useContext(ResetContext);
  useEffect(() => {
    set(guard);
    return () => release(guard);
  });
}

/** The shell's side: ask the visible screen, then reset it if it agrees. */
export function useResetGate(): () => boolean {
  const { ask } = useContext(ResetContext);
  return ask;
}
