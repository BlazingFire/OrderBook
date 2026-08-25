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

const SaveShortcutContext = createContext<{ set: (handler: SaveHandler | null) => void }>({
  set: () => undefined,
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
  }).current;

  return <SaveShortcutContext.Provider value={api}>{children}</SaveShortcutContext.Provider>;
}

/** Call with the current save action, or `null`/omit while there's nothing savable (e.g. mid-submit). */
export function useSaveShortcut(handler: SaveHandler | null): void {
  const { set } = useContext(SaveShortcutContext);
  useEffect(() => {
    set(handler);
    return () => set(null);
  });
}
