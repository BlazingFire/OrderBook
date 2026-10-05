/**
 * The Chatroom's unread figures for the nav row, the Dashboard and the Basic Home tile.
 *
 * Kept apart from `ChatroomScreen.tsx` on purpose: the shell needs this hook from its first
 * render, while the screen (and `ChatConversation`, over a thousand lines) is loaded on the
 * first visit to Chatroom. A hook that lived in the screen file pulled the whole screen into
 * the start-up bundle.
 */

import { useEffect, useRef, useState } from 'react';

import { unreadTotals } from './chatModel.js';
import type { ChatTransport } from './chatModel.js';

/** A burst of pushes is folded into one read of the list. */
const REFRESH_MS = 400;

/**
 * Unread figures for the nav row, the Dashboard and the Basic Home tile: the
 * total across rooms that are not muted, and the @-mentions of the viewer.
 * Re-read a moment after any push, and after a reconnect. `enabled` is false
 * for somebody without `chat.use`, who must not even ask.
 */
export function useChatUnread(
  transport: ChatTransport,
  enabled: boolean,
): { total: number; mentions: number } {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const [figures, setFigures] = useState({ total: 0, mentions: 0 });

  useEffect(() => {
    if (!enabled) {
      setFigures({ total: 0, mentions: 0 });
      return;
    }
    let cancelled = false;
    let timer: number | null = null;

    const read = (): void => {
      void transportRef.current.rooms().then(
        (rooms) => {
          if (!cancelled) setFigures(unreadTotals(rooms));
        },
        () => undefined,
      );
    };
    const later = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(read, REFRESH_MS);
    };

    read();
    const unsubscribe = transportRef.current.subscribe((event) => {
      // Somebody else reading a room changes none of this viewer's counts.
      if (event.kind !== 'read') later();
    });
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled]);

  return figures;
}
