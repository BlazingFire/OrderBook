/**
 * How many Printroom jobs are waiting, for the nav row, the Dashboard and the Basic Home tile.
 *
 * Kept apart from `PrintroomScreen.tsx` so the shell can use it from its first render without
 * loading the screen (see `chatUnread.ts`).
 */

import { useEffect, useRef, useState } from 'react';

import type { PrintroomTransport } from './printroomModel.js';

/** A burst of pushes is folded into one read of the list. */
const REFRESH_MS = 400;

/**
 * How many jobs are waiting for paper, for the nav row, the Dashboard and the
 * Basic Home tile. Re-read a moment after any push and after a reconnect.
 * `enabled` is false for somebody holding neither Printroom right, who must not
 * even ask.
 */
export function usePrintWaiting(transport: PrintroomTransport, enabled: boolean): number {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const [waiting, setWaiting] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setWaiting(0);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const read = (): void => {
      void transportRef.current.listJobs({ status: 'waiting', limit: 1 }).then(
        (page) => {
          if (!cancelled) setWaiting(page.waitingCount);
        },
        () => undefined,
      );
    };
    const later = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(read, REFRESH_MS);
    };
    read();
    const unsubscribe = transportRef.current.subscribe(later);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled]);

  return waiting;
}
