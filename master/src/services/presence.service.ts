/**
 * Live presence on pending and final orders (rule 3).
 *
 * Who is beating comes from the actor, which the hub builds from the panel's
 * socket and the Master route from the session; the payload only names the
 * tab and the record. Every beat re-reads the record through `getLead` /
 * `getOrder`, so the module permission and party scope apply exactly as on
 * opening it, and a person who loses access drops off on their next beat.
 *
 * In memory only: never written to the database, the change ring or the
 * activity log.
 */

import type { DataChangedEvent, PresenceRecordKind, RecordPresence } from '@orderbook/shared';

import { actorUserId, type ActorContext } from '../domain/actor.js';
import { UnauthorizedError, ValidationError } from '../lib/errors.js';
import { createPresenceStore, type PresenceChange } from '../realtime/presence-store.js';
import * as userRepo from '../repositories/user.repository.js';
import * as leadService from './lead.service.js';
import * as orderService from './order.service.js';

const store = createPresenceStore();

const TAB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RECORD_ID = 40;

/** A tab id is safe to put in a connection key: letters, digits, `-` and `_`, at most 64. */
export function isPresenceTabId(value: unknown): value is string {
  return typeof value === 'string' && TAB_ID.test(value);
}

/**
 * One beat from one tab. `connPrefix` is where the tab lives, built by the
 * caller from what it trusts: `panel:<panelId>:` or `admin:<userId>:`.
 */
export async function beat(
  actor: ActorContext,
  connPrefix: string,
  input: unknown,
): Promise<RecordPresence | null> {
  const parsed = parseBeat(input);
  const connKey = `${connPrefix}${parsed.tabId}`;
  const ticket = store.ticket();

  if (!parsed.recordKind) {
    store.leave(connKey);
    return null;
  }

  const userId = actorUserId(actor);
  if (!userId) {
    store.leave(connKey);
    throw new UnauthorizedError();
  }

  const record = await visibleRecord(parsed.recordKind, parsed.recordId, actor).catch(
    (error: unknown) => {
      store.leave(connKey);
      throw error;
    },
  );
  const target = {
    tenantId: actor.tenantId,
    recordKind: parsed.recordKind,
    recordId: record.id,
    partyId: record.partyId,
  };

  // The person's name and picture are read once per join, not on every beat.
  let viewer = store.viewerOn(connKey, target);
  if (viewer?.userId !== userId) {
    const user = await userRepo.findById(actor.tenantId, userId);
    if (!user) throw new UnauthorizedError();
    viewer = { userId, displayName: user.displayName, avatar: user.avatar, tier: user.roleTier };
  }

  // The tab left, or its socket closed, while this beat was reading.
  if (store.leftSince(connKey, ticket)) return null;
  return store.beat(connKey, target, viewer, parsed.editing);
}

/**
 * Take every tab of one connection off its record: a panel's socket closed, or
 * the person signed in on it changed. `prefix` ends in `:` so it names exactly
 * one connection.
 */
export function dropConnections(prefix: string): void {
  store.dropPrefix(prefix);
}

/** Take one tab off its record: a Master browser tab's socket closed. */
export function leaveConnection(connKey: string): void {
  store.leave(connKey);
}

/** A lead or order was saved or deleted: tell whoever has it open who did it. */
export function noteWrite(event: DataChangedEvent): void {
  if (event.entity !== 'lead' && event.entity !== 'order') return;
  // Only the lead and order writes stamp who made them.
  if (event.actorUserId === undefined) return;
  const tenantId = (event.payload as { tenantId?: unknown } | null)?.tenantId;
  if (typeof tenantId !== 'string') return;

  store.noteWrite(
    { tenantId, recordKind: event.entity, recordId: event.id },
    {
      userId: event.actorUserId,
      displayName: event.actorName ?? null,
      at: new Date().toISOString(),
      action: event.action,
    },
  );
}

export function onPresenceChange(listener: (change: PresenceChange) => void): () => void {
  return store.onChange(listener);
}

/** Test seam: forget everyone and every pending push. */
export function resetPresence(): void {
  store.clear();
}

async function visibleRecord(
  kind: PresenceRecordKind,
  id: string,
  actor: ActorContext,
): Promise<{ id: string; partyId: string }> {
  return kind === 'lead' ? leadService.getLead(id, actor) : orderService.getOrder(id, actor);
}

function parseBeat(
  input: unknown,
):
  | { tabId: string; recordKind?: undefined; recordId?: undefined; editing: boolean }
  | { tabId: string; recordKind: PresenceRecordKind; recordId: string; editing: boolean } {
  const invalid = () => new ValidationError('validation.presence.invalid');
  if (!input || typeof input !== 'object') throw invalid();
  const body = input as Record<string, unknown>;

  if (!isPresenceTabId(body.tabId)) throw invalid();
  if (body.editing !== undefined && typeof body.editing !== 'boolean') throw invalid();
  const editing = body.editing === true;

  if (body.recordKind === undefined && body.recordId === undefined) {
    return { tabId: body.tabId, editing };
  }
  if (body.recordKind !== 'lead' && body.recordKind !== 'order') throw invalid();
  if (
    typeof body.recordId !== 'string' ||
    !body.recordId ||
    body.recordId.length > MAX_RECORD_ID
  ) {
    throw invalid();
  }
  return { tabId: body.tabId, recordKind: body.recordKind, recordId: body.recordId, editing };
}
