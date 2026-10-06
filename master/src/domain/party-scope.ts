/**
 * Row-level party scoping, bound to an actor.
 *
 * A party with no assignment is open to everyone; a party with assignments is
 * reachable only by the people named on it, at `view` or `manage`. Holders of
 * `party.accessAll` bypass all of it. Those three sentences are the whole
 * feature, and this module is where they are decided — the SQL that expresses
 * them lives in `repositories/party-access.repository.ts`, because Knex types
 * never leave the repository layer.
 *
 * Pure: no database, no framework. The scope is resolved once per service call
 * from the `ActorContext` and handed down, rather than each repository asking
 * about permissions itself, so exactly one place decides what a caller may see.
 */

import type { PartyAccessLevel } from '@orderbook/shared';

import { ForbiddenError } from '../lib/errors.js';
import { actorCan, actorUserId, type ActorContext } from './actor.js';

/**
 * Who is asking, and whether the assignment table applies to them.
 *
 * One shape rather than a union, because `userId` is needed even when
 * `seesAll` is true: an administrator's "My parties" toggle still means *mine*,
 * and it would have nothing to filter on otherwise.
 *
 * A `userId` of `null` is an Office Panel acting as itself with nobody signed
 * in. It needs no special case — nothing can be assigned to nobody, so the
 * predicate collapses to "unassigned parties only", which is exactly right.
 * Showing such a panel nothing instead would break the unattended paths that
 * work today for no gain: an unassigned party was never secret.
 */
export interface PartyScope {
  /** Holds `party.accessAll` — the assignment table does not narrow them. */
  seesAll: boolean;
  userId: string | null;
}

/**
 * For internal reads that must fetch the row regardless of who is asking —
 * a conversion looking up the lead it is about to copy, a delete looking up
 * what it is about to remove — where the *service* then decides access and
 * wants to answer 403 rather than 404.
 *
 * A named constant rather than an optional parameter, deliberately. The same
 * trap already bit `expectedVersion` in this codebase: made optional, every
 * caller silently disabled the guard by omission. Requiring the scope means an
 * unscoped read has to say so, and `grep UNSCOPED_PARTY_ACCESS` lists them.
 */
export const UNSCOPED_PARTY_ACCESS: PartyScope = { seesAll: true, userId: null };

/**
 * The person whose `manage` grant a freshly created party must carry, or null when it stays open.
 *
 * A real user who does not hold `party.accessAll` owns what they create: nobody else without that key can
 * see it until an administrator shares it. Somebody who already sees every party (an administrator), and an
 * actor that is not a person (a panel with nobody signed in, the system, a connector), leave the party
 * open, as before.
 */
export function creatorGrantee(actor: ActorContext): string | null {
  const userId = actorUserId(actor);
  if (!userId) return null;
  return actorCan(actor, 'party.accessAll') ? null : userId;
}

export function resolvePartyScope(actor: ActorContext): PartyScope {
  return {
    seesAll: actorCan(actor, 'party.accessAll'),
    userId: actorUserId(actor),
  };
}

/**
 * What one person may do on one party, given the grants that exist for it.
 *
 * `manage` for an unrestricted party is the rule stated at the top: with nobody
 * assigned, the party belongs to the company rather than to anyone, and
 * everyone's own module permissions decide the rest.
 */
export function levelFor(
  scope: PartyScope,
  grants: ReadonlyArray<{ userId: string; level: PartyAccessLevel }>,
): PartyAccessLevel | 'none' {
  if (scope.seesAll) return 'manage';
  if (grants.length === 0) return 'manage';

  return grants.find((grant) => grant.userId === scope.userId)?.level ?? 'none';
}

/**
 * Refuse an action on a party the caller may not reach at that level.
 *
 * Two distinct messages, because "not yours at all" and "yours to read but not
 * to change" send an operator to two different people. Both name
 * `party.accessAll` as the missing permission — it is the key that would have
 * made the action possible, and this codebase promises a 403 that names one
 * rather than a control that silently does nothing.
 *
 * Naming `leads.edit` here instead would be actively misleading: the caller
 * holds it, and an administrator sent to the permission grid would find the box
 * already ticked.
 */
export function assertPartyAccess(
  granted: PartyAccessLevel | 'none',
  required: PartyAccessLevel,
): void {
  if (granted === 'manage') return;
  if (granted === 'view' && required === 'view') return;

  throw new ForbiddenError(
    'party.accessAll',
    granted === 'view' ? 'error.forbidden.partyViewOnly' : 'error.forbidden.partyNotAssigned',
  );
}
