/**
 * Live presence: who else has a pending or final order open right now.
 *
 * Held in the Master's memory only. Nothing here is stored, logged or put in
 * the change ring; a Master restart forgets it, and the next beat from each
 * open screen (every `PRESENCE_BEAT_MS`) builds it again.
 */

import type { IsoTimestamp, RecordId, UserAvatar } from '../domain/entities.js';
import type { RoleTier } from '../domain/permissions.js';
import type { ChangeAction } from './socket.js';

export type PresenceRecordKind = 'lead' | 'order';

/** How often an open record screen says it is still there. */
export const PRESENCE_BEAT_MS = 10_000;
/** How long the Master keeps a tab that has stopped beating. */
export const PRESENCE_TTL_MS = 30_000;

/**
 * What a record screen sends while it is open. `tabId` names the browser tab,
 * so two tabs of one person count once. Leaving out `recordKind` and
 * `recordId` means "this tab left". Who is sending is never in here: the
 * Master takes that from the socket or the session.
 */
export interface PresenceBeat {
  tabId: string;
  recordKind?: PresenceRecordKind;
  recordId?: RecordId;
  editing?: boolean;
}

/** One person on a record. Several tabs of one person merge into one entry. */
export interface PresenceEntry {
  userId: RecordId;
  displayName: string;
  avatar: UserAvatar | null;
  /** For the Server Master badge. */
  tier: RoleTier;
  /** True when any of their tabs is editing the record. */
  editing: boolean;
  since: IsoTimestamp;
}

/** Somebody saved or deleted the record while others had it open. */
export interface PresenceLastWrite {
  userId: RecordId | null;
  displayName: string | null;
  at: IsoTimestamp;
  action: ChangeAction;
}

/** Everyone on one record. */
export interface RecordPresence {
  recordKind: PresenceRecordKind;
  recordId: RecordId;
  entries: PresenceEntry[];
  /** Only on the push that follows a save, for the "Reload theirs / Keep mine" notice. */
  lastWrite?: PresenceLastWrite;
}
