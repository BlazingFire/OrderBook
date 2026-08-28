/**
 * Global Ctrl+S / Cmd+S (§10: "Global keys: … Ctrl+S save"). A form screen
 * calls `useSaveShortcut(handler)` while it's the thing on screen with
 * something to save; this listens once, app-wide, and calls whichever
 * handler most recently registered — the same "publish, don't prop-drill"
 * shape as `FilterBarSlot`, so no screen needs App.tsx wired through it.
 */

import { createContext, useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

type SaveHandler = () => void;

const SaveShortcutContext = createContext<{
  set: (handler: SaveHandler | null) => void;
  release: (handler: SaveHandler | null) => void;
}>({
  set: () => undefined,
  release: () => undefined,
});

export function SaveShortcutProvider({ children }: { children: ReactNode }) {
  const current = useRef<SaveHandler | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        current.current?.();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const api = useRef({
    set(handler: SaveHandler | null) {
      current.current = handler;
    },
    /** Release, but only if this handler is still the one registered. */
    release(handler: SaveHandler | null) {
      if (current.current === handler) current.current = null;
    },
  }).current;

  return <SaveShortcutContext.Provider value={api}>{children}</SaveShortcutContext.Provider>;
}

/** Call with the current save action, or `null`/omit while there's nothing savable (e.g. mid-submit). */
export function useSaveShortcut(handler: SaveHandler | null): void {
  const { set, release } = useContext(SaveShortcutContext);
  useEffect(() => {
    set(handler);
    /*
     * Release only what we registered.
     *
     * Screens are hidden rather than unmounted now, and React does not promise
     * the outgoing pane's cleanup runs before the incoming pane's effect — so
     * an unconditional `set(null)` could clear the handler the newly-shown
     * screen had just registered, silently killing its Ctrl+S.
     */
    return () => release(handler);
  });
}
