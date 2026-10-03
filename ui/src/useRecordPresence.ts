/**
 * Live presence for an open record (1.3 rule 3): says "I have this open" to the
 * Master every `PRESENCE_BEAT_MS` and hands back everyone else on it.
 *
 * Each panel makes one channel (`createPresenceChannel`) over its own way of
 * reaching the Master — the Master web posts `/api/presence` and hears
 * `presence:changed` on its socket; the Office posts to its own server, which
 * forwards, and hears the `presence` SSE frame — and feeds pushes into it.
 *
 * Beats run only while the record's screen is showing: a screen `ScreenHost`
 * hides runs its effect cleanups, and a hidden browser tab stops too. Leaving
 * sends a beat with no record, deferred one tick so a screen that takes over
 * the same tab in the same commit cancels it rather than racing it. A
 * provisional record (a temporary id) is never beaten: the Master has not
 * heard of it. Nothing here is stored or logged anywhere.
 */

import { useEffect, useRef, useState } from 'react';
import { PRESENCE_BEAT_MS, isTemporaryId } from '@orderbook/shared';
import type {
  PresenceBeat,
  PresenceEntry,
  PresenceLastWrite,
  PresenceRecordKind,
  RecordPresence,
} from '@orderbook/shared';

export interface PresenceTransport {
  /** One beat. `keepalive` is for the one sent while the page unloads. */
  beat(beat: PresenceBeat, keepalive?: boolean): Promise<RecordPresence | null>;
}

export interface PresenceChannel {
  transport: PresenceTransport;
  /** A push from the Master. */
  push(presence: RecordPresence): void;
  /** The link dropped: who was on what is no longer known. */
  reset(): void;
  subscribe(listener: (presence: RecordPresence | null) => void): () => void;
}

export function createPresenceChannel(transport: PresenceTransport): PresenceChannel {
  const listeners = new Set<(presence: RecordPresence | null) => void>();
  return {
    transport,
    push: (presence) => listeners.forEach((listener) => listener(presence)),
    reset: () => listeners.forEach((listener) => listener(null)),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * This page's tab, so two tabs of one person are two places on the Master.
 *
 * `getRandomValues`, not `randomUUID`: the panels are served over plain http
 * on the LAN, which is not a secure context, and `randomUUID` is undefined
 * there.
 */
export const PRESENCE_TAB_ID = (() => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
})();

export interface RecordPresenceState {
  entries: PresenceEntry[];
  /** The last save or delete somebody made while this record was open here. */
  lastWrite: PresenceLastWrite | null;
}

const NOBODY: RecordPresenceState = { entries: [], lastWrite: null };

/** A leave waiting one tick, cancelled when another screen beats first. */
let pendingLeave: ReturnType<typeof setTimeout> | null = null;

export function useRecordPresence(
  channel: PresenceChannel | undefined,
  target: { recordKind: PresenceRecordKind; recordId: string } | null,
  editing = false,
): RecordPresenceState {
  // Held in a ref like every transport here (`no-transport-dep.test.ts`).
  const channelRef = useRef(channel);
  channelRef.current = channel;

  const recordKind = target?.recordKind ?? null;
  const recordId = target?.recordId ?? null;
  const key = recordKind && recordId ? `${recordKind}:${recordId}` : null;
  const [state, setState] = useState<RecordPresenceState & { key: string | null }>({
    ...NOBODY,
    key: null,
  });

  useEffect(() => {
    const current = channelRef.current;
    if (!current || !recordKind || !recordId || isTemporaryId(recordId)) return;
    const here = `${recordKind}:${recordId}`;
    let live = true;

    const take = (presence: RecordPresence | null): void => {
      if (!live) return;
      if (presence === null) {
        setState({ ...NOBODY, key: here });
        return;
      }
      if (presence.recordKind !== recordKind || presence.recordId !== recordId) return;
      setState((previous) => ({
        key: here,
        entries: presence.entries,
        // The beat's own answer never carries one; keep what a push said.
        lastWrite: presence.lastWrite ?? (previous.key === here ? previous.lastWrite : null),
      }));
    };

    const beat = (): void => {
      if (document.visibilityState === 'hidden') return;
      if (pendingLeave) {
        clearTimeout(pendingLeave);
        pendingLeave = null;
      }
      current.transport
        .beat({ tabId: PRESENCE_TAB_ID, recordKind, recordId, editing })
        .then((presence) => presence && take(presence), () => take(null));
    };
    const leave = (keepalive = false): void => {
      current.transport.beat({ tabId: PRESENCE_TAB_ID }, keepalive).catch(() => undefined);
    };

    const unsubscribe = current.subscribe(take);
    const timer = setInterval(beat, PRESENCE_BEAT_MS);
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') leave();
      else beat();
    };
    const onPageHide = (): void => leave(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    beat();

    return () => {
      live = false;
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      if (pendingLeave) clearTimeout(pendingLeave);
      pendingLeave = setTimeout(() => {
        pendingLeave = null;
        leave();
      }, 0);
    };
  }, [recordKind, recordId, editing]);

  return state.key === key ? state : NOBODY;
}
