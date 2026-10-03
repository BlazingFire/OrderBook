/**
 * Who is on each card of a board (1.4 R22): the faces on the Pending and Final
 * order cards and rows.
 *
 * Reads the board once when it opens, then lives on the Master's pushes, each of
 * which is the whole board for this person (so a missed push heals itself). When
 * the link drops nobody is known to be anywhere: the faces go, and the board is
 * read again once the link is back, retrying every few seconds and quietly, since
 * the faces are a courtesy and never an error. `active` is false while the
 * board's screen is hidden, so a hidden screen holds no listener and asks nothing.
 */

import { useEffect, useRef, useState } from 'react';
import type { BoardPresence, PresenceEntry, PresenceRecordKind } from '@orderbook/shared';

import type { PresenceChannel } from './useRecordPresence.js';

const NO_FACES: ReadonlyMap<string, PresenceEntry[]> = new Map();

/**
 * How long a board waits before asking again after its link dropped or a read failed;
 * doubled after each failure up to `BOARD_RETRY_MAX_MS`, so an Office talking to a
 * Master that is too old for the board feed (or one that stays away) asks seldom.
 */
export const BOARD_RETRY_MS = 3_000;
export const BOARD_RETRY_MAX_MS = 30_000;

export function useBoardPresence(
  channel: PresenceChannel | undefined,
  kind: PresenceRecordKind,
  active = true,
): ReadonlyMap<string, PresenceEntry[]> {
  // Held in a ref like every transport here (`no-transport-dep.test.ts`).
  const channelRef = useRef(channel);
  channelRef.current = channel;
  const [state, setState] = useState<{
    kind: PresenceRecordKind;
    faces: ReadonlyMap<string, PresenceEntry[]>;
  }>({ kind, faces: NO_FACES });

  useEffect(() => {
    const current = channelRef.current;
    if (!current || !active || !current.transport.board) return;
    let live = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const later = (): void => {
      if (retry) return;
      retry = setTimeout(load, Math.min(BOARD_RETRY_MS * 2 ** Math.max(0, failures - 1), BOARD_RETRY_MAX_MS));
    };

    const take = (board: BoardPresence | null): void => {
      if (!live) return;
      if (board === null) {
        setState({ kind, faces: NO_FACES });
        failures = 0;
        later();
        return;
      }
      if (board.recordKind !== kind) return;
      failures = 0;
      setState({ kind, faces: new Map(Object.entries(board.records)) });
    };

    function load(): void {
      retry = null;
      current?.transport.board?.(kind).then(take, () => {
        if (!live) return;
        failures += 1;
        later();
      });
    }

    const unsubscribe = current.subscribeBoard(take);
    load();

    return () => {
      live = false;
      unsubscribe();
      if (retry) clearTimeout(retry);
    };
  }, [kind, active]);

  return state.kind === kind ? state.faces : NO_FACES;
}
