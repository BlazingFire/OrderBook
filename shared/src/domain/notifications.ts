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
  'lead.numbered',
  // The daily automatic backup, to the Server Masters: the drive was missing, or the backup failed.
  'backup.autoSkipped',
  'backup.autoFailed',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export function isNotificationKind(value: unknown): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly unknown[]).includes(value);
}

/** Where opening a notification takes the reader. */
export interface NotificationLink {
  /** `panel`: an Office panel. `lead`: a pending order, by its permanent id. */
  kind: 'panel' | 'lead';
  id: string;
}

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
