/**
 * Per-user notifications: the bell on both panels (1.3).
 *
 * `notify` is called only after the caller's own transaction has committed, so
 * a notice never names something that was rolled back. It writes on the pool,
 * never through a caller's transaction, and it touches neither the change ring
 * nor the activity log: a notice is delivered live on the change bus's own
 * notification channel, and a panel that missed it reads the list when the
 * bell opens.
 *
 * A person only ever reads and marks their own notices. There is no
 * permission for it; the signed-in person is the whole check.
 */

import type { MessageParams, NotificationKind, NotificationLink, UserNotification } from '@orderbook/shared';
import { isNotificationKind } from '@orderbook/shared';
import { validate as isUuid } from 'uuid';

import type { ActorContext } from '../domain/actor.js';
import { toErrorMessage, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as notificationRepo from '../repositories/notification.repository.js';
import * as partyAccessRepo from '../repositories/party-access.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import { publishNotification } from './change-bus.js';

const log = createLogger('notifications');

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
/** More ids than anybody can hold (the pruner keeps 500 each) are not looked at. */
const MAX_MARK_IDS = 500;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface NotificationInput {
  kind: NotificationKind;
  params: MessageParams;
  link?: NotificationLink | null;
  /**
   * While an unread notice with this key exists for a person, another one with
   * the same key is not added for them.
   */
  dedupeKey?: string;
}

/**
 * Store a notice for each named person and push it to wherever they are signed
 * in. Never call it inside a transaction: it is for after the commit.
 */
export async function notify(
  tenantId: string,
  userIds: readonly string[],
  input: NotificationInput,
): Promise<void> {
  if (!isNotificationKind(input.kind)) throw new Error(`Unknown notification kind ${String(input.kind)}`);
  const recipients = [...new Set(userIds)];
  if (recipients.length === 0) return;

  const added = await notificationRepo.insertNotifications(tenantId, recipients, {
    kind: input.kind,
    params: input.params,
    link: input.link ?? null,
    dedupeKey: input.dedupeKey ?? null,
  });

  for (const { userId, notification } of added) {
    publishNotification({ ...notification, tenantId, userId });
  }
}

/**
 * Whether this person may open a lead on this party: a notice names the party,
 * so only someone who could open the lead hears of it.
 */
export async function mayOpenLead(tenantId: string, userId: string, partyId: string): Promise<boolean> {
  const viewers = await userRepo.findActiveUserIdsWithPermission(tenantId, 'leads.view');
  if (!viewers.includes(userId)) return false;
  const grants = await partyAccessRepo.grantsForParty(tenantId, partyId);
  if (grants.length === 0 || grants.some((grant) => grant.userId === userId)) return true;
  return (await userRepo.findActiveUserIdsWithPermission(tenantId, 'party.accessAll')).includes(userId);
}

/** The acting person's newest notices and how many are unread. Nobody signed in: none. */
export async function listNotifications(
  input: { limit?: unknown; before?: unknown } | null | undefined,
  actor: ActorContext,
): Promise<{ items: UserNotification[]; unreadCount: number }> {
  const userId = actor.userId;
  if (!userId) return { items: [], unreadCount: 0 };

  const limit =
    typeof input?.limit === 'number' && Number.isInteger(input.limit)
      ? Math.min(Math.max(input.limit, 1), MAX_PAGE)
      : DEFAULT_PAGE;

  let before: string | null = null;
  if (input?.before !== undefined && input.before !== null && input.before !== '') {
    const ms = typeof input.before === 'string' ? Date.parse(input.before) : Number.NaN;
    if (!Number.isFinite(ms)) throw new ValidationError('validation.cursor.malformed');
    before = new Date(ms).toISOString();
  }

  const [items, unreadCount] = await Promise.all([
    notificationRepo.listForUser(actor.tenantId, userId, { limit, before }),
    notificationRepo.countUnread(actor.tenantId, userId),
  ]);
  return { items, unreadCount };
}

/**
 * Mark some (`ids`) or all (`all: true`) of the acting person's notices read.
 * Ids that are not theirs, or not ids at all, simply match nothing.
 */
export async function markRead(
  input: { ids?: unknown; all?: unknown } | null | undefined,
  actor: ActorContext,
): Promise<{ unreadCount: number }> {
  const userId = actor.userId;
  if (!userId) return { unreadCount: 0 };

  const which =
    input?.all === true
      ? 'all'
      : Array.isArray(input?.ids)
        ? input.ids
            .filter((id): id is string => typeof id === 'string' && isUuid(id))
            .slice(0, MAX_MARK_IDS)
        : [];

  await notificationRepo.markRead(actor.tenantId, userId, which);
  return { unreadCount: await notificationRepo.countUnread(actor.tenantId, userId) };
}

/** Prune once now and then every six hours. Returns the way to stop it. */
export function startNotificationPruner(): () => void {
  const run = (): void => {
    void notificationRepo
      .prune()
      .then((removed) => {
        if (removed > 0) log.info(`Pruned ${removed} old notification(s)`);
      })
      .catch((error: unknown) =>
        log.warn(`Could not prune notifications: ${toErrorMessage(error)}`),
      );
  };

  run();
  const timer = setInterval(run, PRUNE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
