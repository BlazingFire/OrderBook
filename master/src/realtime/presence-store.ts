/**
 * Who has which pending or final order open, in memory only.
 *
 * Pure: no database, no sockets. `presence.service.ts` decides who may beat
 * and fills in the person; the hub turns the debounced change callbacks into
 * `presence:changed` pushes. Nothing here is ever stored or logged.
 *
 * Each open tab is one entry, keyed by its connection key: `panel:<panelId>:<tabId>`
 * for a tab on an Office, `admin:<userId>:<tabId>` for a Master browser tab.
 * A key sits on at most one record. `view` merges entries of the same person,
 * so two tabs of one person show as one avatar, editing if either is.
 *
 * Expiry needs no timer: every beat sweeps first, and everyone still on a
 * record beats every ten seconds, so a tab that vanished without leaving is
 * dropped, and the others told, within about ten seconds of its TTL.
 */

import {
  PRESENCE_TTL_MS,
  type PresenceEntry,
  type PresenceLastWrite,
  type PresenceRecordKind,
  type RecordPresence,
} from '@orderbook/shared';

/** How long a burst of joins, leaves and saves on one record is gathered into one push. */
export const PRESENCE_DEBOUNCE_MS = 100;

export interface PresenceTarget {
  tenantId: string;
  recordKind: PresenceRecordKind;
  recordId: string;
  /** For re-checking each recipient's party access on fan-out. */
  partyId: string;
}

export type PresenceViewer = Omit<PresenceEntry, 'editing' | 'since'>;

/** One record on a board: who is on it, and the party that decides who may be told. */
export interface BoardRecord {
  recordId: string;
  partyId: string;
  entries: PresenceEntry[];
}

/** One debounced change, for the hub to fan out. */
export interface PresenceChange extends PresenceTarget {
  presence: RecordPresence;
  /** The people still on the record, the only ones the push goes to. */
  userIds: string[];
}

interface TabEntry extends PresenceViewer {
  editing: boolean;
  since: number;
  lastBeat: number;
}

interface RecordState extends PresenceTarget {
  tabs: Map<string, TabEntry>;
  /** Set by a save and sent once, on the next push only. */
  lastWrite?: PresenceLastWrite;
}

export interface PresenceStore {
  /** Put a tab on a record (leaving any other), or refresh it. Answers the record's view. */
  beat(connKey: string, target: PresenceTarget, viewer: PresenceViewer, editing: boolean): RecordPresence;
  /** The viewer a tab beat as, when it is still on this record. */
  viewerOn(connKey: string, target: Omit<PresenceTarget, 'partyId'>): PresenceViewer | null;
  leave(connKey: string): void;
  /** Take every tab whose key starts with `prefix` off its record. */
  dropPrefix(prefix: string): void;
  /** Taken before a beat's awaits, and handed to `leftSince` after them. */
  ticket(): number;
  /** True when the tab left, or its connection dropped, after `ticket` was taken. */
  leftSince(connKey: string, ticket: number): boolean;
  /** Every record of one kind somebody has open right now, expired tabs dropped first. */
  board(tenantId: string, recordKind: PresenceRecordKind): BoardRecord[];
  /** Drop every tab that has stopped beating, telling the listeners about the records it empties. */
  sweep(): void;
  /** Mark a save for the people on the record; ignored when nobody is on it. */
  noteWrite(target: Omit<PresenceTarget, 'partyId'>, write: PresenceLastWrite): void;
  onChange(listener: (change: PresenceChange) => void): () => void;
  /**
   * A board changed: somebody joined, left, started or stopped editing, or timed
   * out. Unlike `onChange` this also fires when the last person leaves a record,
   * because a card has to lose its avatar then. Not debounced beyond the record's
   * own 100 ms; the hub throttles it per board.
   */
  onBoardChange(listener: (tenantId: string, recordKind: PresenceRecordKind) => void): () => void;
  /** Drop every pending push; for tests and shutdown. */
  clear(): void;
}

export function createPresenceStore(options: {
  now?: () => number;
  ttlMs?: number;
  debounceMs?: number;
} = {}): PresenceStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PRESENCE_TTL_MS;
  const debounceMs = options.debounceMs ?? PRESENCE_DEBOUNCE_MS;

  const records = new Map<string, RecordState>();
  /** Which record each connection key is on. */
  const byConn = new Map<string, string>();
  const timers = new Map<string, NodeJS.Timeout>();
  const listeners = new Set<(change: PresenceChange) => void>();
  const boardListeners = new Set<(tenantId: string, recordKind: PresenceRecordKind) => void>();
  /*
   * Recent leaves and drops, by connection key or by prefix (ending in `:`).
   * A beat reads the record and the person before it lands, so without these
   * a beat still in flight when its tab left would put the tab back on the
   * record until the TTL. Kept one TTL, which no beat's reads come near.
   */
  const left = new Map<string, { seq: number; at: number }>();
  let seq = 0;
  const markLeft = (key: string): void => {
    seq += 1;
    left.set(key, { seq, at: now() });
  };

  const keyOf = (target: Omit<PresenceTarget, 'partyId'>): string =>
    `${target.tenantId}:${target.recordKind}:${target.recordId}`;

  function view(record: RecordState): RecordPresence {
    const people = new Map<string, PresenceEntry>();
    for (const tab of record.tabs.values()) {
      const seen = people.get(tab.userId);
      const since = new Date(tab.since).toISOString();
      if (!seen) {
        people.set(tab.userId, {
          userId: tab.userId,
          displayName: tab.displayName,
          avatar: tab.avatar,
          tier: tab.tier,
          editing: tab.editing,
          since,
        });
        continue;
      }
      seen.editing = seen.editing || tab.editing;
      if (since < seen.since) seen.since = since;
    }
    const entries = [...people.values()].sort((a, b) =>
      a.since === b.since ? a.userId.localeCompare(b.userId) : a.since < b.since ? -1 : 1,
    );
    return { recordKind: record.recordKind, recordId: record.recordId, entries };
  }

  /** Trailing debounce per record: the push carries the state at the end of the burst. */
  function schedule(key: string): void {
    if (timers.has(key)) return;
    const timer = setTimeout(() => {
      timers.delete(key);
      const record = records.get(key);
      if (!record) return;
      const presence = view(record);
      if (record.lastWrite) presence.lastWrite = record.lastWrite;
      record.lastWrite = undefined;
      if (record.tabs.size === 0) records.delete(key);
      const userIds = presence.entries.map((entry) => entry.userId);
      const { tenantId, recordKind, recordId, partyId } = record;
      for (const listener of boardListeners) listener(tenantId, recordKind);
      if (userIds.length === 0) return;
      for (const listener of listeners) {
        listener({ tenantId, recordKind, recordId, partyId, presence, userIds });
      }
    }, debounceMs);
    timer.unref?.();
    timers.set(key, timer);
  }

  function remove(connKey: string): void {
    const key = byConn.get(connKey);
    if (!key) return;
    byConn.delete(connKey);
    const record = records.get(key);
    if (record?.tabs.delete(connKey)) schedule(key);
  }

  function sweep(at: number): void {
    for (const [key, record] of records) {
      let changed = false;
      for (const [connKey, tab] of record.tabs) {
        if (at - tab.lastBeat < ttlMs) continue;
        record.tabs.delete(connKey);
        byConn.delete(connKey);
        changed = true;
      }
      if (changed) schedule(key);
      else if (record.tabs.size === 0 && !timers.has(key)) records.delete(key);
    }
    for (const [key, mark] of left) {
      if (at - mark.at >= ttlMs) left.delete(key);
    }
  }

  return {
    beat(connKey, target, viewer, editing) {
      const at = now();
      sweep(at);

      const key = keyOf(target);
      if (byConn.get(connKey) !== key) remove(connKey);

      let record = records.get(key);
      if (!record) {
        record = { ...target, tabs: new Map() };
        records.set(key, record);
      }
      record.partyId = target.partyId;

      const previous = record.tabs.get(connKey);
      // Another person on the same key (an Office whose user changed without
      // the hub hearing of it yet) starts a fresh entry.
      const same = previous && previous.userId === viewer.userId;
      record.tabs.set(connKey, {
        ...viewer,
        editing,
        since: same ? previous.since : at,
        lastBeat: at,
      });
      byConn.set(connKey, key);
      if (!same || previous.editing !== editing) schedule(key);

      return view(record);
    },

    viewerOn(connKey, target) {
      const key = keyOf(target);
      if (byConn.get(connKey) !== key) return null;
      const tab = records.get(key)?.tabs.get(connKey);
      if (!tab || now() - tab.lastBeat >= ttlMs) return null;
      return { userId: tab.userId, displayName: tab.displayName, avatar: tab.avatar, tier: tab.tier };
    },

    leave(connKey) {
      markLeft(connKey);
      remove(connKey);
    },

    dropPrefix(prefix) {
      markLeft(prefix);
      for (const connKey of [...byConn.keys()]) {
        if (connKey.startsWith(prefix)) remove(connKey);
      }
    },

    ticket: () => seq,

    leftSince(connKey, ticket) {
      for (const [key, mark] of left) {
        if (mark.seq <= ticket) continue;
        if (key === connKey || (key.endsWith(':') && connKey.startsWith(key))) return true;
      }
      return false;
    },

    board(tenantId, recordKind) {
      sweep(now());
      const out: BoardRecord[] = [];
      for (const record of records.values()) {
        if (record.tenantId !== tenantId || record.recordKind !== recordKind) continue;
        const entries = view(record).entries;
        if (entries.length > 0) out.push({ recordId: record.recordId, partyId: record.partyId, entries });
      }
      return out;
    },

    sweep() {
      sweep(now());
    },

    noteWrite(target, write) {
      const key = keyOf(target);
      const record = records.get(key);
      if (!record || record.tabs.size === 0) return;
      record.lastWrite = write;
      schedule(key);
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onBoardChange(listener) {
      boardListeners.add(listener);
      return () => boardListeners.delete(listener);
    },

    clear() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      records.clear();
      byConn.clear();
      left.clear();
    },
  };
}
