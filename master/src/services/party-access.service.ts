/**
 * Party Access — reading and editing who may reach each party.
 *
 * Two audiences share this file. The Party Access screen calls
 * `listAssignments` / `replaceAssignments`; every other service calls
 * `requirePartyAccess` before touching a lead, an order or a party, which is
 * the single write-side gate for the whole feature.
 *
 * Assignments are **not** offline-editable. Like Fields, the Office Panel
 * forwards these commands live and fails 503 when the Master is unreachable: a
 * grant set has no field-level merge to fall back on, and merging two
 * administrators' offline edits would produce a union neither of them
 * approved — the same reasoning that put role permissions in one JSONB column
 * (`docs/ROLES_AND_USERS.md` §5).
 */

import type {
  AssignablePerson,
  Paginated,
  PartyAccessEntry,
  PartyAccessInput,
  PartyAccessLevel,
  PartyAccessQuery,
  PartyAccessRow,
} from '@orderbook/shared';

import { assertVersionMatches } from '../domain/access.js';
import { actorCan, actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { clampPaging } from '../domain/paging.js';
import { assertPartyAccess, levelFor, resolvePartyScope } from '../domain/party-scope.js';
import { db } from '../db/knex.js';
import { toCsv } from '../lib/csv.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as partyAccessRepo from '../repositories/party-access.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import { publishChange } from './change-bus.js';

const PAGING = { defaultLimit: 50, maxLimit: 200 };

/**
 * Reading the assignment table needs one of the two keys.
 *
 * `party.accessAll` alone is enough on purpose: somebody trusted with the whole
 * book should be able to see how it is divided without also being trusted to
 * redraw it.
 */
function requireCanRead(actor: ActorContext): void {
  if (actorCan(actor, 'party.assign') || actorCan(actor, 'party.accessAll')) return;
  throw new ForbiddenError('party.assign');
}

export async function listAssignments(
  query: PartyAccessQuery,
  actor: ActorContext,
): Promise<Paginated<PartyAccessRow>> {
  requireCanRead(actor);

  // The administrator's own view of the book is not itself party-scoped — that
  // is what `requireCanRead` just established — so the underlying list is read
  // unscoped and the `userId` / `restriction` filters do the narrowing.
  const page = await partyRepo.listPartiesForAccess(actor.tenantId, {
    search: query.search,
    userId: query.userId,
    restriction: query.restriction,
    ...clampPaging(query, PAGING),
  });

  const grants = await partyAccessRepo.grantsForParties(
    actor.tenantId,
    page.items.map((party) => party.id),
  );

  return {
    ...page,
    items: page.items.map((party) => {
      const assignees = grants.get(party.id) ?? [];
      return {
        partyId: party.id,
        partyCode: party.partyCode,
        partyName: party.name,
        city: party.city,
        version: party.version,
        isRestricted: assignees.length > 0,
        assignees,
      };
    }),
  };
}

export async function assignmentsForParty(
  partyId: string,
  actor: ActorContext,
): Promise<PartyAccessRow> {
  requireCanRead(actor);

  const party = await partyRepo.findPartyById(actor.tenantId, partyId);
  if (!party) throw new NotFoundError('Party');

  const grants = await partyAccessRepo.grantsForParties(actor.tenantId, [partyId]);
  const assignees = grants.get(partyId) ?? [];

  return {
    partyId: party.id,
    partyCode: party.partyCode,
    partyName: party.name,
    city: party.city,
    version: party.sync.version,
    isRestricted: assignees.length > 0,
    assignees,
  };
}

/**
 * Replace a party's whole grant set.
 *
 * `expectedVersion` is checked against the party's own `version` under a row
 * lock taken **inside** the transaction, not read before it. Every older
 * entity in this codebase reads the stored version first and then opens the
 * transaction, which is a real check-then-act race under two concurrent saves;
 * Fields fixed that for itself and this follows Fields, not the older shape.
 */
export async function replaceAssignments(
  partyId: string,
  input: PartyAccessInput,
  actor: ActorContext,
): Promise<PartyAccessRow> {
  requirePermission(actor, 'party.assign');

  const entries = normaliseEntries(input.entries);
  await assertUsersAreLive(actor, entries);

  await db().transaction(async (trx) => {
    // Stamped before the party's row lock, never after it: every other write
    // takes `master_clock`'s lock first (`updateParty`, the offline merge), and
    // holding the party while waiting for the clock deadlocked (`40P01`)
    // against an edit of the same party holding the clock while it waited for
    // the party. A refusal below rolls the stamp back with everything else.
    const hlc = await nextHlc(trx);

    const locked = await partyRepo.lockParty(actor.tenantId, partyId, trx);
    if (!locked) throw new NotFoundError('Party');

    assertVersionMatches(locked.version, input.expectedVersion);

    await partyAccessRepo.replaceGrants(
      actor.tenantId,
      partyId,
      entries,
      actorUserId(actor),
      trx,
    );

    await partyRepo.touchParty(actor.tenantId, partyId, hlc, trx);

    // Inside the transaction, not after it: an assignment change that is not
    // recorded is indistinguishable from one that never happened, and this is
    // precisely the kind of change somebody will later need to account for.
    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'party',
        entityId: partyId,
        action: 'access_changed',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: {
          name: locked.name,
          assignees: entries.map((entry) => `${entry.userId}:${entry.level}`),
        },
      },
      actor,
      trx,
    );
  });

  const row = await assignmentsForParty(partyId, actor);

  // Panels cache the party list; a party that has just become restricted has to
  // disappear from the screens of everyone it was not assigned to, and the
  // per-recipient filter in the realtime hub is what decides who still gets it.
  const party = await partyRepo.findPartyById(actor.tenantId, partyId);
  if (party) publishChange({ entity: 'party', action: 'updated', id: partyId, payload: party });

  return row;
}

const CSV_HEADERS = ['Party code', 'Party', 'Access', 'Person', 'Username', 'Level'] as const;

/**
 * The assignment table as a CSV: one line per (party, assignee), and one line
 * for each open party so the export is the whole book rather than only its
 * restricted half — "who is *not* restricted" is half the question an
 * administrator is asking.
 *
 * Returns `{ csv, rowCount }` rather than rows, matching `log.service`'s and
 * `report.service`'s exports — that shared shape is what lets the Office Panel
 * serve this file through its existing `forwardCsv` helper instead of needing
 * a second download path of its own.
 */
export async function exportRows(
  actor: ActorContext,
): Promise<{ csv: string; rowCount: number }> {
  requireCanRead(actor);
  /*
   * Enforced here, not only on the Master's own HTTP route.
   *
   * `party-access.routes.ts` guards this with `needs('parties.export')`; the
   * socket command `partyAccess:export` — which is the path an Office panel
   * takes — called the service directly and inherited nothing. A whole-company
   * CSV of who can see which customer is exactly the kind of thing that
   * permission exists for, and it was one transport away from being ungated.
   */
  requirePermission(actor, 'parties.export');

  const rows: unknown[][] = [];

  /*
   * Paged to the end, not one page called the whole thing.
   *
   * This asked for `PAGING.maxLimit` — 200 — once, with no loop, while its own
   * doc comment above promised "the whole book". A shop with more than 200
   * parties got a silently truncated file, and `rowCount` counted the truncated
   * rows, so nothing downstream could notice either. An export that is wrong
   * and says it is complete is worse than one that fails.
   *
   * Bounded by the `total` the repository already returns, so it terminates
   * even if a page comes back short or empty.
   */
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  let parties = 0;

  while (parties < total) {
    const page = await listAssignments({ limit: PAGING.maxLimit, offset }, actor);
    total = page.total;

    if (page.items.length === 0) break;

    for (const party of page.items) {
      if (party.assignees.length === 0) {
        rows.push([party.partyCode, party.partyName, 'open', '', '', '']);
        continue;
      }

      for (const assignee of party.assignees) {
        rows.push([
          party.partyCode,
          party.partyName,
          'restricted',
          assignee.displayName,
          assignee.username,
          assignee.level,
        ]);
      }
    }

    parties += page.items.length;
    offset += page.items.length;
  }

  return { csv: toCsv([...CSV_HEADERS], rows), rowCount: rows.length };
}

/**
 * The people an administrator can assign, for the editor's picker.
 *
 * Its own endpoint rather than reusing `GET /api/access/users`, for two
 * reasons. That one requires `users.manage`, so a screen about parties would
 * have silently depended on a staff-directory permission; and the Office Panel
 * has no route to it at all, so the same screen could not have worked on both
 * panels. Deactivated and deleted accounts are excluded — offering somebody who
 * cannot sign in produces a grant nobody can exercise.
 */
export async function assignablePeople(actor: ActorContext): Promise<AssignablePerson[]> {
  requirePermission(actor, 'party.assign');

  const users = await userRepo.listUsers(actor.tenantId);

  return users
    .filter((user) => user.isActive)
    .map((user) => ({
      id: user.id,
      displayName: user.displayName,
      username: user.username,
      roleName: user.roleName,
      roleTier: user.roleTier,
      avatar: user.avatar,
    }));
}

// --- The write-side gate every other service calls -------------------------

/** What this caller may do on this party. */
async function levelForParty(
  partyId: string,
  actor: ActorContext,
): Promise<PartyAccessLevel | 'none'> {
  const scope = resolvePartyScope(actor);
  if (scope.seesAll) return 'manage';

  const grants = await partyAccessRepo.grantsForParty(actor.tenantId, partyId);
  return levelFor(scope, grants);
}

/**
 * Refuse unless the caller may act on the party at `required`.
 *
 * Called from `lead.service`, `order.service` and `catalog.service` before any
 * mutation, and from their read-one paths. Deliberately a service-layer check
 * rather than a route guard: an Office Panel reaches the same functions over
 * Socket.IO, so a guard mounted on the Express route would enforce nothing for
 * the panel that does most of the writing.
 */
export async function requirePartyAccess(
  partyId: string,
  required: PartyAccessLevel,
  actor: ActorContext,
): Promise<void> {
  assertPartyAccess(await levelForParty(partyId, actor), required);
}

// --- Helpers ---------------------------------------------------------------

/**
 * De-duplicate by user, last entry winning, and sort.
 *
 * Two grants for one person would make "what may they do here" ambiguous; the
 * unique index would refuse the insert anyway, and a 500 from a constraint is a
 * worse answer than resolving it here.
 */
function normaliseEntries(entries: readonly PartyAccessEntry[]): PartyAccessEntry[] {
  const byUser = new Map<string, PartyAccessLevel>();

  for (const entry of entries) {
    if (entry.level !== 'view' && entry.level !== 'manage') {
      throw new ValidationError('validation.partyAccess.levelInvalid');
    }
    byUser.set(entry.userId, entry.level);
  }

  return [...byUser.entries()]
    .map(([userId, level]) => ({ userId, level }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

/**
 * Every named person must exist, be live, and belong to this company.
 *
 * `party_access.user_id` carries no foreign key — a restored user has to come
 * back holding their parties — so this is the only thing standing between a
 * typo and a grant that silently belongs to nobody.
 */
async function assertUsersAreLive(
  actor: ActorContext,
  entries: readonly PartyAccessEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  for (const entry of entries) {
    const user = await userRepo.findById(actor.tenantId, entry.userId);
    if (!user || !user.isActive) {
      throw new ValidationError('validation.partyAccess.userUnknown', { userId: entry.userId });
    }
  }
}
