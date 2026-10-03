/**
 * In-process publish/subscribe for data changes.
 *
 * Services publish here after a successful write; the realtime layer
 * subscribes and fans out over Socket.IO. This indirection is what keeps
 * services free of any Socket.IO knowledge — they describe *what* changed, not
 * *who* needs telling.
 */

import { EventEmitter } from 'node:events';
import type {
  ChatPush,
  DataChangedEvent,
  PrintJobSummary,
  SyncConflict,
  UserNotification,
} from '@orderbook/shared';

import { actorUserId, type ActorContext } from '../domain/actor.js';
import * as changeRing from '../realtime/change-ring.js';

const emitter = new EventEmitter();
const CHANGE_EVENT = 'change';
const CONFLICT_EVENT = 'conflict';
const NOTIFICATION_EVENT = 'notification';
const CHAT_EVENT = 'chat';
const PRINT_EVENT = 'print';

emitter.setMaxListeners(50);

export function publishChange(event: DataChangedEvent): void {
  /*
   * Recorded here rather than in the hub's subscription, and the difference is
   * not cosmetic: the ring is a record of what *changed*, not of what was
   * broadcast. Recording on the broadcast side would mean a change published
   * with no hub running — every integration suite, and the window between a
   * service writing and the realtime layer starting — was never in the ring,
   * and a panel's cursor would then skip it in silence.
   *
   * It also stamps `event.seq` in place before anything is emitted, so the
   * number the ring holds and the number every recipient sees are the same by
   * construction.
   */
  changeRing.record(event);
  emitter.emit(CHANGE_EVENT, event);
}

/** Who made a change, spread into `publishChange` by the lead and order writes. */
export function actorStamp(actor: ActorContext): Pick<DataChangedEvent, 'actorUserId' | 'actorName'> {
  return { actorUserId: actorUserId(actor), actorName: actor.actorName };
}

export function onChange(listener: (event: DataChangedEvent) => void): () => void {
  emitter.on(CHANGE_EVENT, listener);
  return () => emitter.off(CHANGE_EVENT, listener);
}

/**
 * A merge shadowed somebody's value.
 *
 * Kept on its own channel rather than folded into `data:changed`, because a
 * conflict is addressed to a *person* — it needs surfacing in the UI as
 * something to look at, not merely applied to a cached row.
 */
export function publishConflict(conflict: SyncConflict): void {
  emitter.emit(CONFLICT_EVENT, conflict);
}

export function onConflict(listener: (conflict: SyncConflict) => void): () => void {
  emitter.on(CONFLICT_EVENT, listener);
  return () => emitter.off(CONFLICT_EVENT, listener);
}

/** A stored notification and the one person it is for. */
export type AddressedNotification = UserNotification & { tenantId: string; userId: string };

/**
 * A notification was stored for one person. Like a conflict it is addressed,
 * so it has its own channel, and it never enters the change ring: a panel that
 * missed it reads it from the list when the bell opens.
 */
export function publishNotification(notification: AddressedNotification): void {
  emitter.emit(NOTIFICATION_EVENT, notification);
}

export function onNotification(
  listener: (notification: AddressedNotification) => void,
): () => void {
  emitter.on(NOTIFICATION_EVENT, listener);
  return () => emitter.off(NOTIFICATION_EVENT, listener);
}

/** A chat push and the people it is for. */
export interface AddressedChatPush {
  tenantId: string;
  /** The room's members (and anybody just removed from it). */
  userIds: string[];
  push: ChatPush;
}

/**
 * Something happened in a chat room. Like a notification it is addressed, and
 * it has its own channel for a reason that matters more here: chat must never
 * touch the change ring (a panel's cursor would then replay every message) or
 * the activity chain.
 */
export function publishChat(event: AddressedChatPush): void {
  emitter.emit(CHAT_EVENT, event);
}

export function onChat(listener: (event: AddressedChatPush) => void): () => void {
  emitter.on(CHAT_EVENT, listener);
  return () => emitter.off(CHAT_EVENT, listener);
}

/** A Printroom job was sent or changed, and which company it belongs to. */
export interface PrintJobEvent {
  tenantId: string;
  job: PrintJobSummary;
}

/**
 * A job entered or moved through the queue. Live only, like chat: it never
 * touches the change ring or the activity chain (the audit entries for a job are
 * written by the service, inside the change). The hub addresses it per
 * recipient: the sender, and every holder of `print.station`.
 */
export function publishPrintJob(event: PrintJobEvent): void {
  emitter.emit(PRINT_EVENT, event);
}

export function onPrintJob(listener: (event: PrintJobEvent) => void): () => void {
  emitter.on(PRINT_EVENT, listener);
  return () => emitter.off(PRINT_EVENT, listener);
}
