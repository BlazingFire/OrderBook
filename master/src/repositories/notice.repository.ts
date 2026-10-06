/**
 * The notice board's tables: `notices`, `notice_audiences` and `notice_reads` (Oct 2026).
 *
 * All SQL for them lives here. A function that changes rows takes the caller's
 * `TransactionContext`; reads take a runner and default to the pool. Every query names the
 * company, so a caller can only reach its own rows.
 *
 * "Today" is always the company's business day: `(now() AT TIME ZONE tz)::date`, never the
 * host's, so a notice that says "until 31 October" is gone on 1 November where the shop is.
 */

import type { NoticePriority } from '@orderbook/shared';
import type { Knex } from 'knex';

import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { toRequiredIso } from './mappers.js';
import type { TransactionContext } from './transaction.js';

type Runner = Knex | Knex.Transaction;

export interface NoticeRow {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  priority: NoticePriority;
  pinned: boolean;
  showUntil: string | null;
  audienceAll: boolean;
  /** Role ids, in a stable order; empty when the notice is for everybody. */
  roleIds: string[];
  authorId: string | null;
  authorName: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Whether the user asked about has read it; false when no user was asked about. */
  readByMe: boolean;
  /** Past its last day, in the company's time zone. */
  expired: boolean;
  readCount: number;
  audienceSize: number;
  deletedAt: string | null;
}

/** The viewer: who is reading and as which role. Both null for a panel with nobody signed in. */
export interface Reader {
  userId: string | null;
  roleId: string | null;
}

const TZ = (): string => config.locale.timeZone;

/** The columns of a notice row, with its derived figures. `?` bindings: viewer id, time zone (twice), tenant id. */
function selectNotices(runner: Runner, viewerId: string | null) {
  return runner('notices as n')
    .leftJoin('users as au', 'au.id', 'n.author_id')
    .select(
      'n.id',
      'n.tenant_id',
      'n.title',
      'n.body',
      'n.priority',
      'n.pinned',
      runner.raw('n.show_until::text AS show_until'),
      'n.audience_all',
      'n.author_id',
      'au.display_name as author_name',
      'n.version',
      'n.created_at',
      'n.updated_at',
      'n.deleted_at',
      runner.raw(
        `COALESCE(ARRAY(SELECT a.role_id FROM notice_audiences a WHERE a.notice_id = n.id ORDER BY a.role_id), '{}') AS role_ids`,
      ),
      runner.raw(
        'EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.user_id = ?) AS read_by_me',
        [viewerId ?? ''],
      ),
      runner.raw(
        `(n.show_until IS NOT NULL AND n.show_until < (now() AT TIME ZONE ?)::date) AS expired`,
        [TZ()],
      ),
      runner.raw(
        `(SELECT count(*) FROM notice_reads r WHERE r.notice_id = n.id)::int AS read_count`,
      ),
      runner.raw(
        `(SELECT count(*) FROM users u
           WHERE u.tenant_id = n.tenant_id AND u.is_active AND u.deleted_at IS NULL
             AND (n.audience_all OR u.role_id IN (SELECT a.role_id FROM notice_audiences a WHERE a.notice_id = n.id))
         )::int AS audience_size`,
      ),
    );
}

interface RawRow {
  id: string;
  tenant_id: string;
  title: string;
  body: string;
  priority: NoticePriority;
  pinned: boolean;
  show_until: string | null;
  audience_all: boolean;
  author_id: string | null;
  author_name: string | null;
  version: number;
  created_at: unknown;
  updated_at: unknown;
  deleted_at: unknown;
  role_ids: string[];
  read_by_me: boolean;
  expired: boolean;
  read_count: number;
  audience_size: number;
}

function map(row: RawRow): NoticeRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title,
    body: row.body,
    priority: row.priority,
    pinned: row.pinned,
    showUntil: row.show_until,
    audienceAll: row.audience_all,
    roleIds: row.role_ids ?? [],
    authorId: row.author_id,
    authorName: row.author_name,
    version: row.version,
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
    readByMe: row.read_by_me,
    expired: row.expired,
    readCount: row.read_count,
    audienceSize: row.audience_size,
    deletedAt: row.deleted_at ? toRequiredIso(row.deleted_at) : null,
  };
}

async function run(query: Knex.QueryBuilder): Promise<NoticeRow[]> {
  return ((await query) as RawRow[]).map(map);
}

/** Notices meant for a reader: not deleted, not expired, in their audience. Pinned and newest first. */
export async function listForReader(
  tenantId: string,
  reader: Reader,
  runner: Runner = db(),
): Promise<NoticeRow[]> {
  const query = selectNotices(runner, reader.userId)
    .where('n.tenant_id', tenantId)
    .whereNull('n.deleted_at')
    .whereRaw('(n.show_until IS NULL OR n.show_until >= (now() AT TIME ZONE ?)::date)', [TZ()])
    .where((audience) => {
      audience.where('n.audience_all', true);
      if (reader.roleId) {
        audience.orWhereExists(
          runner('notice_audiences as a')
            .select(runner.raw('1'))
            .whereRaw('a.notice_id = n.id')
            .where('a.role_id', reader.roleId),
        );
      }
    })
    .orderBy([
      { column: 'n.pinned', order: 'desc' },
      { column: 'n.priority', order: 'asc' }, // 'important' sorts before 'normal'
      { column: 'n.created_at', order: 'desc' },
      { column: 'n.id', order: 'asc' },
    ]);

  return run(query);
}

/** Every notice for a manager, expired ones included, deleted ones left out. */
export async function listAll(tenantId: string, runner: Runner = db()): Promise<NoticeRow[]> {
  const query = selectNotices(runner, null)
    .where('n.tenant_id', tenantId)
    .whereNull('n.deleted_at')
    .orderBy([
      { column: 'n.pinned', order: 'desc' },
      { column: 'n.priority', order: 'asc' },
      { column: 'n.created_at', order: 'desc' },
      { column: 'n.id', order: 'asc' },
    ]);

  return run(query);
}

export async function findById(
  tenantId: string,
  id: string,
  options: { includeDeleted?: boolean; viewerId?: string | null } = {},
  runner: Runner = db(),
): Promise<NoticeRow | null> {
  const query = selectNotices(runner, options.viewerId ?? null).where({
    'n.tenant_id': tenantId,
    'n.id': id,
  });
  if (!options.includeDeleted) query.whereNull('n.deleted_at');

  const [row] = await run(query);
  return row ?? null;
}

export interface NoticeInsert {
  tenantId: string;
  title: string;
  body: string;
  priority: NoticePriority;
  pinned: boolean;
  showUntil: string | null;
  audienceAll: boolean;
  roleIds: readonly string[];
  authorId: string | null;
}

export async function insert(input: NoticeInsert, trx: TransactionContext): Promise<string> {
  const [row] = await trx('notices')
    .insert({
      tenant_id: input.tenantId,
      title: input.title,
      body: input.body,
      priority: input.priority,
      pinned: input.pinned,
      show_until: input.showUntil,
      audience_all: input.audienceAll,
      author_id: input.authorId,
    })
    .returning<Array<{ id: string }>>('id');

  await setAudience((row as { id: string }).id, input.audienceAll ? [] : input.roleIds, trx);
  return (row as { id: string }).id;
}

async function setAudience(
  noticeId: string,
  roleIds: readonly string[],
  trx: TransactionContext,
): Promise<void> {
  await trx('notice_audiences').where({ notice_id: noticeId }).delete();
  if (roleIds.length === 0) return;

  await trx('notice_audiences').insert(
    roleIds.map((roleId) => ({ notice_id: noticeId, role_id: roleId })),
  );
}

export interface NoticePatch {
  title?: string;
  body?: string;
  priority?: NoticePriority;
  pinned?: boolean;
  showUntil?: string | null;
  audienceAll?: boolean;
  roleIds?: readonly string[];
}

/** Changes a notice and raises its version. Resolves to false when the version moved under us. */
export async function update(
  tenantId: string,
  id: string,
  expectedVersion: number,
  patch: NoticePatch,
  trx: TransactionContext,
): Promise<boolean> {
  const columns: Record<string, unknown> = {};
  if (patch.title !== undefined) columns.title = patch.title;
  if (patch.body !== undefined) columns.body = patch.body;
  if (patch.priority !== undefined) columns.priority = patch.priority;
  if (patch.pinned !== undefined) columns.pinned = patch.pinned;
  if (patch.showUntil !== undefined) columns.show_until = patch.showUntil;
  if (patch.audienceAll !== undefined) columns.audience_all = patch.audienceAll;

  const changed = await trx('notices')
    .where({ tenant_id: tenantId, id, version: expectedVersion })
    .whereNull('deleted_at')
    .update({ ...columns, version: trx.raw('version + 1'), updated_at: trx.fn.now() });
  if (changed === 0) return false;

  if (patch.audienceAll !== undefined || patch.roleIds !== undefined) {
    await setAudience(id, patch.audienceAll ? [] : (patch.roleIds ?? []), trx);
  }
  return true;
}

export async function softDelete(
  tenantId: string,
  id: string,
  deletedBy: string | null,
  trx: TransactionContext,
): Promise<boolean> {
  const changed = await trx('notices')
    .where({ tenant_id: tenantId, id })
    .whereNull('deleted_at')
    .update({
      deleted_at: trx.fn.now(),
      deleted_by: deletedBy,
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    });
  return changed > 0;
}

export async function restore(
  tenantId: string,
  id: string,
  trx: TransactionContext,
): Promise<boolean> {
  const changed = await trx('notices')
    .where({ tenant_id: tenantId, id })
    .whereNotNull('deleted_at')
    .update({
      deleted_at: null,
      deleted_by: null,
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    });
  return changed > 0;
}

/** Records reads once each. Returns how many were new. */
export async function markRead(
  userId: string,
  noticeIds: readonly string[],
  runner: Runner = db(),
): Promise<number> {
  if (noticeIds.length === 0) return 0;

  const result = await runner.raw(
    `INSERT INTO notice_reads (notice_id, user_id)
     SELECT unnest(?::uuid[]), ?
     ON CONFLICT (notice_id, user_id) DO NOTHING`,
    [noticeIds as string[], userId],
  );
  return (result as { rowCount?: number }).rowCount ?? 0;
}

/** Everybody a notice is for (active, not deleted), with when each read it. */
export async function readers(
  tenantId: string,
  noticeId: string,
  runner: Runner = db(),
): Promise<Array<{ userId: string; displayName: string; readAt: string | null }>> {
  const rows = await runner('users as u')
    .join('notices as n', function join() {
      this.on('n.tenant_id', 'u.tenant_id');
    })
    .leftJoin('notice_reads as r', function join() {
      this.on('r.notice_id', 'n.id').andOn('r.user_id', 'u.id');
    })
    .where({ 'n.tenant_id': tenantId, 'n.id': noticeId, 'u.is_active': true })
    .whereNull('u.deleted_at')
    .where((audience) => {
      audience
        .where('n.audience_all', true)
        .orWhereExists(
          runner('notice_audiences as a')
            .select(runner.raw('1'))
            .whereRaw('a.notice_id = n.id')
            .whereRaw('a.role_id = u.role_id'),
        );
    })
    .orderByRaw('r.read_at IS NULL, lower(u.display_name)')
    .select<Array<{ id: string; display_name: string; read_at: unknown }>>(
      'u.id',
      'u.display_name',
      'r.read_at',
    );

  return rows.map((row) => ({
    userId: row.id,
    displayName: row.display_name,
    readAt: row.read_at ? toRequiredIso(row.read_at) : null,
  }));
}

/** Names of roles, for a manager's view of an audience. Order follows `roleIds`. */
export async function roleNames(
  tenantId: string,
  roleIds: readonly string[],
  runner: Runner = db(),
): Promise<Map<string, string>> {
  if (roleIds.length === 0) return new Map();

  const rows = await runner('roles')
    .where({ tenant_id: tenantId })
    .whereIn('id', [...roleIds])
    .select<Array<{ id: string; name: string }>>('id', 'name');
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** The live roles of this company, by name: what a notice can be addressed to. */
export async function listRoles(
  tenantId: string,
  runner: Runner = db(),
): Promise<Array<{ id: string; name: string }>> {
  return runner('roles')
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .orderByRaw('lower(name)')
    .select<Array<{ id: string; name: string }>>('id', 'name');
}

/** Of these ids, the ones that are live roles of this company. */
export async function liveRoleIds(
  tenantId: string,
  roleIds: readonly string[],
  runner: Runner = db(),
): Promise<Set<string>> {
  if (roleIds.length === 0) return new Set();

  const rows = await runner('roles')
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .whereIn('id', [...roleIds])
    .select<Array<{ id: string }>>('id');
  return new Set(rows.map((row) => row.id));
}
