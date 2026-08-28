/**
 * Subscribe to a media query.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect`: the first
 * render then reads the *current* match instead of a default that an effect
 * corrects one frame later, so the sidebar cannot flash open on a narrow
 * window before collapsing.
 */

import { useCallback, useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    // Server snapshot: nothing here is server-rendered, but the hook must
    // still answer. "Not narrow" is the honest default for a desktop app.
    () => false,
  );
}
