/**
 * Per-user notifications: the bell on both panels (1.3).
 *
 * A notification is stored on the Master for one person and follows them to
 * whichever panel they sign in on. The kinds grow phase by phase; each has one
 * `notification.<kind>` message key that renders it from `params`.
 */

import type { MessageParams } from '../i18n/keys.js';
import type { IsoTimestamp, OfficePanelWithPresence, Uuid } from './entities.js';

export const NOTIFICATION_KINDS = [
  'panel.offlineLong',
  // A pending order saved offline got its number (Phase 4).
  'lead.numbered',
  // Somebody else deleted or changed a new order you own or created.
  'lead.deleted',
  'lead.edited',
  // The Chatroom (Phase 6): somebody @mentioned you, handed you a task, ticked
  // one you set, or asked for a chat right.
  'chat.mention',
  'task.assigned',
  'task.done',
  'access.requested',
  // The Printroom (Phase 7): somebody else printed a note you sent.
  'print.printed',
  // The daily automatic backup, to the Server Masters: the drive was missing, or the backup failed.
  'backup.autoSkipped',
  'backup.autoFailed',
  // Data safety, to the Server Masters: no backup for a week, a restore a shutdown
  // interrupted (the data from before it is back), and a disk nearly full.
  'backup.stale',
  'backup.restoreInterrupted',
  'storage.lowDisk',
  // A newer OrderBook build is published (1.4): to everyone, once per version.
  'update.available',
  // The Master is about to restart for its nightly update (1.4): Offices will drop and reconnect.
  'update.installing',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export function isNotificationKind(value: unknown): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly unknown[]).includes(value);
}

/** Where opening a notification takes the reader. */
export type NotificationLink =
  | { kind: 'panel'; id: string }
  /** A pending order, by its permanent id. */
  | { kind: 'lead'; id: string }
  /** A chat room, and the message in it when there is one. */
  | { kind: 'chat'; id: string; messageId?: string }
  /** A role in the roles editor. */
  | { kind: 'role'; id: string }
  /** A Printroom job. */
  | { kind: 'print'; id: string }
  /** The App update screen; `id` is the version on offer. */
  | { kind: 'update'; id: string };

export interface UserNotification {
  id: Uuid;
  kind: NotificationKind;
  params: MessageParams;
  link: NotificationLink | null;
  createdAt: IsoTimestamp;
  readAt: IsoTimestamp | null;
}

/**
 * How long a panel may be away before it counts as offline for a long time:
 * the Office's banner, the Master's Panels badge and the Master's notice all
 * use this one figure. The owner fixed it at one hour, so it is not a setting.
 */
export const LONG_OFFLINE_MS = 3_600_000;

/**
 * Whether an active panel has been out of touch for `LONG_OFFLINE_MS` or more.
 * A panel that has never been seen is not counted: it was paired and never
 * started, which is a different problem from one that went quiet.
 */
export function isLongOffline(panel: OfficePanelWithPresence, nowMs: number): boolean {
  if (panel.isConnected || panel.status !== 'active' || !panel.lastSeenAt) return false;
  const seen = Date.parse(panel.lastSeenAt);
  return Number.isFinite(seen) && nowMs - seen >= LONG_OFFLINE_MS;
}
