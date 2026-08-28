/**
 * A value that lags behind, so a keystroke does not become a request.
 *
 * One copy, in the shared package. There were two hand-rolled `setTimeout`
 * pairs before it — one in each panel's search box — and both had the same
 * bug waiting in them: the timer is cleared on the next keystroke but not on
 * unmount, so a screen left mid-type fires a request into a component that is
 * gone.
 *
 * 150 ms is the picker's default. Below about 100 ms a fast typist still issues
 * a request per character; above about 250 ms the list visibly lags the caret.
 */

import { useEffect, useState } from 'react';

export const DEBOUNCE_MS = 150;

export function useDebounced<T>(value: T, delay: number = DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return settled;
}
