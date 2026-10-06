/**
 * What to send a panel that says it already has everything up to sequence N.
 *
 * A reconnect costs a `buildSnapshot`: six paged services at 500 rows each plus
 * variants, pipelines, option lists, custom fields, a hundred conflicts, a full
 * dashboard and the grants. Right for a panel that has been off for a week,
 * absurd for one whose Wi-Fi dropped for ninety seconds.
 *
 * The rule that keeps this honest: **it answers with a snapshot whenever it
 * cannot prove a delta is complete.** A wrong snapshot is impossible; a wrong
 * delta is a panel quietly missing rows, with nothing anywhere to say so.
 * Three things force the fallback, and none of them is an error:
 *
 *  - the cursor names a different boot of the Master, so the ring it refers to
 *    no longer exists;
 *  - the ring has evicted something at or before the cursor;
 *  - any buffered event is one a panel cannot apply — `party_variant` is the
 *    sharp case, because those are the names and specs agreed with each party
 *    and a dropped one means staff entering a party-wise line from a stale
 *    record with no error anywhere.
 *
 * Every surviving event then passes the **same** `mayReceive` the live fan-out
 * uses. Replaying without it would hand every Office Panel the whole staff list
 * and every role's complete permission array — the disclosure the live path
 * refuses by name.
 */

import {
  PANEL_IRRELEVANT_ENTITIES,
  PANEL_PROTOCOL_VERSION,
  REPLAYABLE_ENTITIES,
  type ChangedEntity,
  type SyncDelta,
  type SyncDeltaCursor,
} from '@orderbook/shared';

import type { ActorContext } from '../domain/actor.js';
import { appVersion } from '../lib/app-version.js';
import { peekHlc } from '../repositories/identity.repository.js';
import * as partyAccessRepo from '../repositories/party-access.repository.js';
import { BOOT_ID, currentSeq, since } from '../realtime/change-ring.js';
import { PARTY_SCOPED_ENTITIES, mayReceive, partyIdOfChange } from '../realtime/fan-out.js';
import * as dashboardService from './dashboard.service.js';

const REPLAYABLE = new Set<ChangedEntity>(REPLAYABLE_ENTITIES);
const IRRELEVANT = new Set<ChangedEntity>(PANEL_IRRELEVANT_ENTITIES);

/**
 * The changes a panel missed, or `null` when it must be sent a snapshot.
 *
 * `null` rather than a thrown error or a union: the caller's fallback is the
 * thing it was going to do anyway, and making that the shape means a new reason
 * to fall back cannot be forgotten at a call site.
 */
export async function buildDelta(
  cursor: SyncDeltaCursor,
  actor: ActorContext,
): Promise<SyncDelta | null> {
  if (cursor.bootId !== BOOT_ID) return null;

  const buffered = since(cursor.lastSeq);
  if (!buffered) return null;

  // An event the panel cannot apply and cannot be told about later. See the
  // header — this is the check that stops the delta diverging in silence.
  const applicable = buffered.filter((event) => !IRRELEVANT.has(event.entity));
  if (applicable.some((event) => !REPLAYABLE.has(event.entity))) return null;

  // Fail closed, as the live fan-out does (`hub.ts`): a party-scoped change
  // that names no party cannot be checked against anyone's grants, and empty
  // grants read as "open to everyone". The panel gets a snapshot instead,
  // which is built through each service's own scope.
  if (applicable.some((event) => PARTY_SCOPED_ENTITIES.has(event.entity) && !partyIdOfChange(event))) {
    return null;
  }

  // One grants lookup per distinct party in the range, not per event.
  const grantsByParty = new Map<string, Array<{ userId: string; level: 'view' | 'manage' }>>();
  for (const event of applicable) {
    const partyId = partyIdOfChange(event);
    if (!partyId || grantsByParty.has(partyId)) continue;
    grantsByParty.set(partyId, await partyAccessRepo.grantsForParty(actor.tenantId, partyId));
  }

  const events = applicable.filter((event) => {
    const partyId = partyIdOfChange(event);
    return mayReceive(actor, event, partyId ? (grantsByParty.get(partyId) ?? []) : []);
  });

  // A role can be edited and a grant can be written while a panel is switched
  // off, and neither arrives as a replayable event — `role` and `user` are
  // withheld from panels outright. So both ride along on every delta, exactly
  // as they ride along on every snapshot.
  const [grants, serverHlc, dashboard] = await Promise.all([
    partyAccessRepo.grantsForUser(actor.tenantId, actor.userId),
    peekHlc(),
    dashboardService.getDashboardSummary(actor),
  ]);

  return {
    bootId: BOOT_ID,
    seq: currentSeq(),
    events,
    permissions: [...(actor.permissions?.permissions ?? [])],
    partyGrants: grants,
    dashboard,
    serverHlc,
    serverTime: new Date().toISOString(),
    serverVersion: appVersion(),
    protocol: PANEL_PROTOCOL_VERSION,
  };
}
