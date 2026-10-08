/**
 * The notice board (Oct 2026): what the Master does with notices.
 *
 * Who may do what, in one place:
 *  - `notices.view` reads the board (the notices meant for the reader's role, not expired) and
 *    records reads. Held by every role.
 *  - `notices.manage` writes notices, sees every notice (expired ones too), the audience's role
 *    names and who has read what.
 *
 * The audience is decided by the reader's **role**, taken from the connection or session, never
 * from a request. A notice for some roles is not in the list, the snapshot, the unread count or
 * the change events of anybody else; and `markRead` for a notice the person cannot see is
 * ignored, not answered, so an id says nothing about whether it exists.
 *
 * A change is published as one `notice` event whose payload names only the audience (before and
 * after): the title and body never ride the change ring. It is snapshot-forcing, so a panel in
 * the audience pulls its own scoped snapshot.
 */

import {
  compareNotices,
  noticeProblem,
  type Notice,
  type NoticeAudience,
  type NoticeAudienceRole,
  type NoticeBoard,
  type NoticeInput,
  type NoticeProblem,
  type NoticeReaders,
  type NoticeUpdate,
} from '@orderbook/shared';

import { db } from '../db/knex.js';
import { actorCan, actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { assertVersionMatches } from '../domain/access.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as noticeRepo from '../repositories/notice.repository.js';
import { publishChange } from './change-bus.js';

/** A notice id is a UUID; anything else is not a notice (and must not reach the database as one). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertNoticeId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID.test(id)) throw new NotFoundError('Notice');
}

/**
 * Who is reading. Only a person has a role to be addressed by: a panel acting as itself (nobody
 * signed in, or not yet re-attached) is a reader of nothing but the notices for everybody.
 */
function readerOf(actor: ActorContext): noticeRepo.Reader {
  const userId = actorUserId(actor);
  return { userId, roleId: userId ? (actor.permissions?.roleId ?? null) : null };
}

/**
 * What a reader sees of a notice: nothing about who else has read it, and of its audience only
 * whether it is for everybody or for their own role (never the other roles it names).
 */
function forReader(row: noticeRepo.NoticeRow, viewerRoleId: string | null = null): Notice {
  return {
    id: row.id,
    tenantId: row.tenantId,
    title: row.title,
    body: row.body,
    priority: row.priority,
    pinned: row.pinned,
    showUntil: row.showUntil,
    showOnHome: row.showOnHome,
    showAtSignIn: row.showAtSignIn,
    audience: row.audienceAll
      ? { kind: 'all' }
      : {
          kind: 'roles',
          roleIds:
            viewerRoleId !== null && row.roleIds.includes(viewerRoleId) ? [viewerRoleId] : [],
        },
    authorId: row.authorId,
    authorName: row.authorName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    readByMe: row.readByMe,
  };
}

function forManager(row: noticeRepo.NoticeRow, names: Map<string, string>): Notice {
  return {
    ...forReader(row),
    // The manager sees the whole audience.
    audience: audienceOf(row),
    readByMe: undefined,
    audienceRoleNames: row.roleIds.map((id) => names.get(id) ?? id),
    expired: row.expired,
    readCount: row.readCount,
    audienceSize: row.audienceSize,
  };
}

function audienceOf(row: Pick<noticeRepo.NoticeRow, 'audienceAll' | 'roleIds'>): NoticeAudience {
  return row.audienceAll ? { kind: 'all' } : { kind: 'roles', roleIds: row.roleIds };
}

/** Both the old and the new audience: everybody who may need to hear of a change or a removal. */
function unionAudience(
  before: NoticeAudience | null,
  after: NoticeAudience | null,
): NoticeAudience {
  if (!before || !after) return before ?? after ?? { kind: 'all' };
  if (before.kind === 'all' || after.kind === 'all') return { kind: 'all' };
  return { kind: 'roles', roleIds: [...new Set([...before.roleIds, ...after.roleIds])] };
}

const PROBLEM_KEY = {
  title_required: 'validation.notice.titleRequired',
  title_too_long: 'validation.notice.titleTooLong',
  body_too_long: 'validation.notice.bodyTooLong',
  bad_priority: 'validation.notice.priorityInvalid',
  bad_date: 'validation.notice.dateInvalid',
  audience_empty: 'validation.notice.audienceEmpty',
  audience_too_big: 'validation.notice.audienceTooBig',
  no_placement: 'validation.notice.placementEmpty',
} as const satisfies Record<NoticeProblem, string>;

/**
 * The request body as a notice input, or a 400. Types are checked before anything is read from
 * them: a title that is not text, an audience of an unknown kind or without its roles, a pin that
 * is not true or false, answer the refusal below and never a 500 (and an unknown audience kind is
 * never stored as an empty list of roles).
 */
function parseInput(
  body: unknown,
  mode: 'create' | 'update',
): Partial<NoticeInput> & { expectedVersion?: number } {
  const bad = (): never => {
    throw new ValidationError('validation.notice.malformed');
  };
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad();
  const raw = body as Record<string, unknown>;

  const out: Partial<NoticeInput> & { expectedVersion?: number } = {};
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string') return bad();
    out.title = raw.title;
  } else if (mode === 'create') {
    out.title = '';
  }
  if (raw.body !== undefined) {
    if (typeof raw.body !== 'string') return bad();
    out.body = raw.body;
  }
  if (raw.priority !== undefined) {
    if (typeof raw.priority !== 'string') return bad();
    out.priority = raw.priority as NoticeInput['priority'];
  }
  if (raw.pinned !== undefined) {
    if (typeof raw.pinned !== 'boolean') return bad();
    out.pinned = raw.pinned;
  }
  for (const key of ['showOnHome', 'showAtSignIn'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') return bad();
    out[key] = raw[key];
  }
  if (raw.showUntil !== undefined && raw.showUntil !== null) {
    if (typeof raw.showUntil !== 'string') return bad();
    out.showUntil = raw.showUntil;
  } else if (raw.showUntil === null) {
    out.showUntil = null;
  }
  if (raw.audience !== undefined) {
    const audience = raw.audience as { kind?: unknown; roleIds?: unknown } | null;
    if (typeof audience !== 'object' || audience === null) return bad();
    if (audience.kind === 'all') {
      out.audience = { kind: 'all' };
    } else if (audience.kind === 'roles') {
      if (
        !Array.isArray(audience.roleIds) ||
        audience.roleIds.some((id) => typeof id !== 'string' || !id)
      )
        return bad();
      out.audience = { kind: 'roles', roleIds: audience.roleIds as string[] };
    } else {
      return bad();
    }
  }
  if (raw.expectedVersion !== undefined) {
    if (typeof raw.expectedVersion !== 'number' || !Number.isInteger(raw.expectedVersion))
      return bad();
    out.expectedVersion = raw.expectedVersion;
  }
  return out;
}

function assertValid(input: Partial<NoticeInput>, mode: 'create' | 'update'): void {
  const problem = noticeProblem(input, mode);
  if (problem)
    throw new ValidationError(PROBLEM_KEY[problem], {
      max: problem === 'body_too_long' ? 4000 : 120,
    });
}

/** Every role named must be a live role of this company, and each is named once. */
async function assertRoles(
  actor: ActorContext,
  audience: NoticeAudience | undefined,
): Promise<string[]> {
  if (!audience || audience.kind === 'all') return [];

  const ids = [...new Set(audience.roleIds)];
  const live = await noticeRepo.liveRoleIds(actor.tenantId, ids);
  if (ids.some((id) => !live.has(id)))
    throw new ValidationError('validation.notice.audienceUnknownRole');
  return ids;
}

// --- Reading ---------------------------------------------------------------------

export async function listBoard(actor: ActorContext): Promise<NoticeBoard> {
  requirePermission(actor, 'notices.view');

  const reader = readerOf(actor);
  const rows = await noticeRepo.listForReader(actor.tenantId, reader);
  const notices = rows.map((row) => forReader(row, reader.roleId));
  return { notices, unreadCount: notices.filter((notice) => !notice.readByMe).length };
}

/** The reader's list for a snapshot: empty without the right, rather than an error. */
export async function snapshotNotices(actor: ActorContext): Promise<Notice[]> {
  if (!actorCan(actor, 'notices.view')) return [];
  const reader = readerOf(actor);
  return (await noticeRepo.listForReader(actor.tenantId, reader)).map((row) =>
    forReader(row, reader.roleId),
  );
}

export async function listManage(actor: ActorContext): Promise<Notice[]> {
  requirePermission(actor, 'notices.manage');

  const rows = await noticeRepo.listAll(actor.tenantId);
  const names = await noticeRepo.roleNames(
    actor.tenantId,
    rows.flatMap((row) => row.roleIds),
  );
  return rows.map((row) => forManager(row, names)).sort(compareNotices);
}

/** The roles a notice can be addressed to. */
export async function listAudienceRoles(actor: ActorContext): Promise<NoticeAudienceRole[]> {
  requirePermission(actor, 'notices.manage');
  return noticeRepo.listRoles(actor.tenantId);
}

export async function getReaders(id: string, actor: ActorContext): Promise<NoticeReaders> {
  requirePermission(actor, 'notices.manage');
  assertNoticeId(id);

  const row = await noticeRepo.findById(actor.tenantId, id);
  if (!row) throw new NotFoundError('Notice');
  return { noticeId: id, readers: await noticeRepo.readers(actor.tenantId, id) };
}

// --- Reads -----------------------------------------------------------------------

/**
 * Records that the person has read these notices (all of the board when `ids` is omitted) and
 * answers how many are still unread. Ids that are not on this person's board are ignored, so the
 * answer never says whether a notice exists; reading twice changes nothing.
 */
export async function markRead(
  input: { ids?: string[] },
  actor: ActorContext,
): Promise<{ unreadCount: number }> {
  requirePermission(actor, 'notices.view');

  const reader = readerOf(actor);
  // A read belongs to a person. Counting it for nobody would answer 200 and record nothing.
  if (!reader.userId) throw new ConflictError('error.conflict.noNoticeReader');
  const board = await noticeRepo.listForReader(actor.tenantId, reader);

  if (reader.userId) {
    const visible = new Set(board.map((row) => row.id));
    const wanted =
      input.ids === undefined
        ? [...visible]
        : [...new Set(input.ids)].filter((id) => UUID.test(id) && visible.has(id));
    await noticeRepo.markRead(reader.userId, wanted);
  }

  const after = reader.userId ? await noticeRepo.listForReader(actor.tenantId, reader) : board;
  return { unreadCount: after.filter((row) => !row.readByMe).length };
}

// --- Writing ---------------------------------------------------------------------

export async function createNotice(body: unknown, actor: ActorContext): Promise<Notice> {
  requirePermission(actor, 'notices.manage');
  const input = parseInput(body, 'create') as NoticeInput;
  assertValid(input, 'create');
  const roleIds = await assertRoles(actor, input.audience);

  const id = await db().transaction(async (trx) => {
    const created = await noticeRepo.insert(
      {
        tenantId: actor.tenantId,
        title: input.title.trim(),
        body: input.body ?? '',
        priority: input.priority ?? 'normal',
        pinned: input.pinned ?? false,
        showUntil: input.showUntil ?? null,
        // An older panel's editor sends neither: shown in both places, as every notice was.
        showOnHome: input.showOnHome ?? true,
        showAtSignIn: input.showAtSignIn ?? true,
        audienceAll: !input.audience || input.audience.kind === 'all',
        roleIds,
        authorId: actorUserId(actor),
      },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'notice',
        entityId: created,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { title: input.title.trim() },
      },
      actor,
      trx,
    );
    return created;
  });

  const row = await noticeRepo.findById(actor.tenantId, id);
  if (!row) throw new Error('Notice disappeared immediately after insert');

  publishChange({
    entity: 'notice',
    action: 'created',
    id,
    payload: { audience: audienceOf(row) },
  });
  return forManager(row, await noticeRepo.roleNames(actor.tenantId, row.roleIds));
}

export async function updateNotice(
  id: string,
  body: unknown,
  actor: ActorContext,
): Promise<Notice> {
  requirePermission(actor, 'notices.manage');
  assertNoticeId(id);
  const input = parseInput(body, 'update') as NoticeUpdate;
  assertValid(input, 'update');

  const existing = await noticeRepo.findById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Notice');
  assertVersionMatches(existing.version, input.expectedVersion);
  // An edit may send one placement alone (or neither): the one it leaves out is the stored one,
  // and the pair still has to keep the notice somewhere.
  assertValid(
    {
      showOnHome: input.showOnHome ?? existing.showOnHome,
      showAtSignIn: input.showAtSignIn ?? existing.showAtSignIn,
    },
    'update',
  );

  const roleIds = await assertRoles(actor, input.audience);
  const audienceChanged = input.audience !== undefined;

  await db().transaction(async (trx) => {
    const ok = await noticeRepo.update(
      actor.tenantId,
      id,
      input.expectedVersion,
      {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.showUntil !== undefined ? { showUntil: input.showUntil } : {}),
        ...(input.showOnHome !== undefined ? { showOnHome: input.showOnHome } : {}),
        ...(input.showAtSignIn !== undefined ? { showAtSignIn: input.showAtSignIn } : {}),
        ...(audienceChanged ? { audienceAll: input.audience?.kind === 'all', roleIds } : {}),
      },
      trx,
    );
    // Somebody saved between the read above and here: the same refusal as a stale edit.
    if (!ok) assertVersionMatches(existing.version + 1, input.expectedVersion);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'notice',
        entityId: id,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { title: input.title?.trim() ?? existing.title },
      },
      actor,
      trx,
    );
  });

  const row = await noticeRepo.findById(actor.tenantId, id);
  if (!row) throw new NotFoundError('Notice');

  publishChange({
    entity: 'notice',
    action: 'updated',
    id,
    payload: { audience: unionAudience(audienceOf(existing), audienceOf(row)) },
  });
  return forManager(row, await noticeRepo.roleNames(actor.tenantId, row.roleIds));
}

export async function deleteNotice(id: string, actor: ActorContext): Promise<{ id: string }> {
  requirePermission(actor, 'notices.manage');
  assertNoticeId(id);

  const existing = await noticeRepo.findById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Notice');

  await db().transaction(async (trx) => {
    await noticeRepo.softDelete(actor.tenantId, id, actorUserId(actor), trx);
    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'notice',
        entityId: id,
        action: 'deleted',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { title: existing.title },
      },
      actor,
      trx,
    );
  });

  publishChange({
    entity: 'notice',
    action: 'deleted',
    id,
    payload: { audience: audienceOf(existing) },
  });
  return { id };
}

/** From the Recycle Bin: put a deleted notice back. */
export async function restoreNotice(id: string, actor: ActorContext): Promise<Notice> {
  requirePermission(actor, 'notices.manage');
  assertNoticeId(id);

  const existing = await noticeRepo.findById(actor.tenantId, id, { includeDeleted: true });
  if (!existing || !existing.deletedAt) throw new NotFoundError('Notice');

  await db().transaction(async (trx) => {
    await noticeRepo.restore(actor.tenantId, id, trx);
    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'notice',
        entityId: id,
        action: 'restored',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { title: existing.title },
      },
      actor,
      trx,
    );
  });

  const row = await noticeRepo.findById(actor.tenantId, id);
  if (!row) throw new NotFoundError('Notice');

  publishChange({
    entity: 'notice',
    action: 'restored',
    id,
    payload: { audience: audienceOf(row) },
  });
  return forManager(row, await noticeRepo.roleNames(actor.tenantId, row.roleIds));
}
