/**
 * The Chatroom's tables: `chat_rooms`, `chat_members` and `chat_messages`
 * (1.3 Phase 6, migration #5).
 *
 * All SQL for them lives here. A function that changes rows takes the caller's
 * `TransactionContext`; reads take a runner and default to the pool. Every
 * query names the company, so a caller can only reach its own rows, and none
 * of them selects a credential: people are read through `CHAT_PERSON_COLUMNS`,
 * which has no `password_hash`.
 *
 * The rows come back raw (`ChatRoomRow`, `ChatMessageRow`). Turning them into
 * wire types needs the people they name and the records their chips point at,
 * and that is the service's job, because only it knows who is looking.
 */

import type { ChatMemberRole, ChatMessageKind, ChatPerson, ChatRoomKind, UserAvatar } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { mapUserAvatar, toIso, toIsoDate, toRequiredIso } from './mappers.js';
import type { TransactionContext } from './transaction.js';

type Runner = Knex | Knex.Transaction;
type Row = Record<string, unknown>;

// --- Row shapes ---------------------------------------------------------------

export interface ChatRoomRow {
  id: string;
  tenantId: string;
  kind: ChatRoomKind;
  name: string | null;
  description: string | null;
  directKey: string | null;
  lastSeq: number;
  lastMessageAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  archivedBy: string | null;
}

/** A room as one person sees it: their membership and their counts. */
export interface ChatRoomListRow extends ChatRoomRow {
  myRole: ChatMemberRole | null;
  muted: boolean;
  lastReadSeq: number;
  mentionUnread: number;
  memberCount: number;
}

export interface ChatMemberRow {
  roomId: string;
  userId: string;
  role: ChatMemberRole;
  muted: boolean;
  lastReadSeq: number;
  joinedAt: string;
}

export interface ChatMessageRow {
  id: string;
  tenantId: string;
  roomId: string;
  seq: number;
  authorId: string | null;
  kind: ChatMessageKind;
  body: string;
  refs: Array<{ kind: 'lead' | 'order'; id: string }>;
  mentions: string[];
  system: { event: string; params: Record<string, string> } | null;
  clientId: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  pinnedAt: string | null;
  pinnedBy: string | null;
  taskAssignees: string[] | null;
  taskDueOn: string | null;
  taskDoneAt: string | null;
  taskDoneBy: string | null;
}

// --- Mapping ------------------------------------------------------------------

function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapRoom(row: Row): ChatRoomRow {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    kind: row.kind as ChatRoomKind,
    name: (row.name as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    directKey: (row.direct_key as string | null) ?? null,
    lastSeq: Number(row.last_seq ?? 0),
    lastMessageAt: toIso(row.last_message_at),
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
    archivedAt: toIso(row.archived_at),
    archivedBy: (row.archived_by as string | null) ?? null,
  };
}

function mapListRoom(row: Row): ChatRoomListRow {
  return {
    ...mapRoom(row),
    myRole: (row.my_role as ChatMemberRole | null) ?? null,
    muted: Boolean(row.muted),
    lastReadSeq: Number(row.last_read_seq ?? 0),
    mentionUnread: Number(row.mention_unread ?? 0),
    memberCount: Number(row.member_count ?? 0),
  };
}

function mapMember(row: Row): ChatMemberRow {
  return {
    roomId: String(row.room_id),
    userId: String(row.user_id),
    role: row.role as ChatMemberRole,
    muted: Boolean(row.muted),
    lastReadSeq: Number(row.last_read_seq ?? 0),
    joinedAt: toRequiredIso(row.joined_at),
  };
}

export function mapMessageRow(row: Row): ChatMessageRow {
  const assignees = row.task_assignees === null || row.task_assignees === undefined ? null : jsonArray<string>(row.task_assignees);
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    roomId: String(row.room_id),
    seq: Number(row.seq),
    authorId: (row.author_id as string | null) ?? null,
    kind: row.kind as ChatMessageKind,
    body: String(row.body ?? ''),
    refs: jsonArray(row.refs),
    mentions: jsonArray<string>(row.mentions),
    system: (row.system as ChatMessageRow['system']) ?? null,
    clientId: (row.client_id as string | null) ?? null,
    createdAt: toRequiredIso(row.created_at),
    editedAt: toIso(row.edited_at),
    deletedAt: toIso(row.deleted_at),
    deletedBy: (row.deleted_by as string | null) ?? null,
    pinnedAt: toIso(row.pinned_at),
    pinnedBy: (row.pinned_by as string | null) ?? null,
    taskAssignees: assignees,
    taskDueOn: toIsoDate(row.task_due_on),
    taskDoneAt: toIso(row.task_done_at),
    taskDoneBy: (row.task_done_by as string | null) ?? null,
  };
}

// --- People -------------------------------------------------------------------

/** Never `u.*`: the credential column stays out of every chat query. */
const CHAT_PERSON_COLUMNS = [
  'u.id',
  'u.display_name',
  'u.username',
  'u.avatar_id',
  'u.avatar_blurhash',
  'u.avatar_size',
  'u.avatar_byte_size',
  'u.avatar_uploaded_at',
  'r.tier as role_tier',
] as const;

function mapPerson(row: Row): ChatPerson {
  const avatar: UserAvatar | null = mapUserAvatar(row);
  return {
    id: String(row.id),
    displayName: String(row.display_name ?? row.username ?? row.id),
    avatar,
    tier: String(row.role_tier ?? 'office'),
  };
}

/** The named people, deleted or not: an author's name still renders after they leave. */
export async function listPeopleByIds(
  tenantId: string,
  ids: readonly string[],
  runner: Runner = db(),
): Promise<ChatPerson[]> {
  if (ids.length === 0) return [];
  const rows = await runner('users as u')
    .leftJoin('roles as r', 'r.id', 'u.role_id')
    .where('u.tenant_id', tenantId)
    .whereIn('u.id', [...new Set(ids)])
    .select(...CHAT_PERSON_COLUMNS);
  return rows.map(mapPerson);
}

// --- Rooms --------------------------------------------------------------------

export async function insertRoom(
  trx: TransactionContext,
  row: {
    tenantId: string;
    kind: ChatRoomKind;
    name: string | null;
    description: string | null;
    directKey: string | null;
    createdBy: string;
  },
): Promise<ChatRoomRow> {
  const [created] = await trx('chat_rooms')
    .insert({
      tenant_id: row.tenantId,
      kind: row.kind,
      name: row.name,
      description: row.description,
      direct_key: row.directKey,
      created_by: row.createdBy,
    })
    .returning('*');
  return mapRoom(created as Row);
}

export async function findRoom(
  tenantId: string,
  roomId: string,
  runner: Runner = db(),
): Promise<ChatRoomRow | null> {
  const row = await runner('chat_rooms').where({ tenant_id: tenantId, id: roomId }).first();
  return row ? mapRoom(row as Row) : null;
}

/** Take the room's row lock: posting, and everything that numbers its messages, goes through here. */
export async function lockRoom(
  trx: TransactionContext,
  tenantId: string,
  roomId: string,
): Promise<ChatRoomRow | null> {
  const row = await trx('chat_rooms').where({ tenant_id: tenantId, id: roomId }).forUpdate().first();
  return row ? mapRoom(row as Row) : null;
}

export async function findRoomByDirectKey(
  tenantId: string,
  directKey: string,
  runner: Runner = db(),
): Promise<ChatRoomRow | null> {
  const row = await runner('chat_rooms').where({ tenant_id: tenantId, direct_key: directKey }).first();
  return row ? mapRoom(row as Row) : null;
}

/** Next number for the room. The caller holds the room lock. */
export async function bumpRoomSeq(trx: TransactionContext, roomId: string): Promise<number> {
  const [row] = await trx('chat_rooms')
    .where({ id: roomId })
    .update({ last_seq: trx.raw('last_seq + 1'), last_message_at: trx.fn.now() })
    .returning('last_seq');
  return Number((row as Row).last_seq);
}

export async function updateRoomColumns(
  trx: TransactionContext,
  roomId: string,
  patch: Partial<{
    name: string | null;
    description: string | null;
    kind: ChatRoomKind;
    archivedAt: Date | null;
    archivedBy: string | null;
  }>,
): Promise<ChatRoomRow> {
  const set: Row = { updated_at: trx.fn.now() };
  if ('name' in patch) set.name = patch.name;
  if ('description' in patch) set.description = patch.description;
  if ('kind' in patch) set.kind = patch.kind;
  if ('archivedAt' in patch) set.archived_at = patch.archivedAt;
  if ('archivedBy' in patch) set.archived_by = patch.archivedBy;
  const [row] = await trx('chat_rooms').where({ id: roomId }).update(set).returning('*');
  return mapRoom(row as Row);
}

const ROOM_LIST_SELECT = `
  r.*,
  m.role AS my_role,
  COALESCE(m.muted, false) AS muted,
  COALESCE(m.last_read_seq, 0) AS last_read_seq,
  (SELECT count(*) FROM chat_members cm WHERE cm.room_id = r.id) AS member_count,
  CASE WHEN m.user_id IS NULL THEN 0 ELSE (
    SELECT count(*) FROM chat_messages x
     WHERE x.room_id = r.id AND x.seq > m.last_read_seq AND x.deleted_at IS NULL
       AND x.mentions @> to_jsonb(?::text)
  ) END AS mention_unread`;

/** The rooms a person belongs to, newest activity first. */
export async function listRoomsFor(
  tenantId: string,
  userId: string,
  options: { includeArchived?: boolean } = {},
  runner: Runner = db(),
): Promise<ChatRoomListRow[]> {
  const query = runner('chat_rooms as r')
    .join('chat_members as m', function join() {
      this.on('m.room_id', '=', 'r.id').andOn('m.user_id', '=', runner.raw('?', [userId]));
    })
    .where('r.tenant_id', tenantId)
    .select(runner.raw(ROOM_LIST_SELECT, [userId]))
    .orderByRaw('COALESCE(r.last_message_at, r.created_at) DESC, r.id');
  if (!options.includeArchived) query.whereNull('r.archived_at');
  return (await query).map((row) => mapListRoom(row as Row));
}

/** Every group in the company (never a direct chat), with the caller's own membership when they have one. */
export async function listAllGroups(
  tenantId: string,
  userId: string,
  options: { includeArchived?: boolean } = {},
  runner: Runner = db(),
): Promise<ChatRoomListRow[]> {
  const query = runner('chat_rooms as r')
    .leftJoin('chat_members as m', function join() {
      this.on('m.room_id', '=', 'r.id').andOn('m.user_id', '=', runner.raw('?', [userId]));
    })
    .where('r.tenant_id', tenantId)
    .where('r.kind', '<>', 'direct')
    .select(runner.raw(ROOM_LIST_SELECT, [userId]))
    .orderByRaw('COALESCE(r.last_message_at, r.created_at) DESC, r.id');
  if (!options.includeArchived) query.whereNull('r.archived_at');
  return (await query).map((row) => mapListRoom(row as Row));
}

/** One room as one person sees it, or null when there is no such room. */
export async function findRoomFor(
  tenantId: string,
  userId: string,
  roomId: string,
  runner: Runner = db(),
): Promise<ChatRoomListRow | null> {
  const row = await runner('chat_rooms as r')
    .leftJoin('chat_members as m', function join() {
      this.on('m.room_id', '=', 'r.id').andOn('m.user_id', '=', runner.raw('?', [userId]));
    })
    .where({ 'r.tenant_id': tenantId, 'r.id': roomId })
    .select(runner.raw(ROOM_LIST_SELECT, [userId]))
    .first();
  return row ? mapListRoom(row as Row) : null;
}

/** The newest readable message of each room, for the list's preview line. */
export async function latestMessages(
  roomIds: readonly string[],
  runner: Runner = db(),
): Promise<ChatMessageRow[]> {
  if (roomIds.length === 0) return [];
  const result = await runner.raw(
    `SELECT DISTINCT ON (room_id) *
       FROM chat_messages
      WHERE room_id = ANY(?::uuid[]) AND deleted_at IS NULL AND kind <> 'system'
      ORDER BY room_id, seq DESC`,
    [[...roomIds]],
  );
  return (result.rows as Row[]).map(mapMessageRow);
}

// --- Members ------------------------------------------------------------------

export async function listMembers(roomId: string, runner: Runner = db()): Promise<ChatMemberRow[]> {
  const rows = await runner('chat_members').where({ room_id: roomId }).orderBy('joined_at').orderBy('user_id');
  return rows.map((row) => mapMember(row as Row));
}

export async function findMember(
  roomId: string,
  userId: string,
  runner: Runner = db(),
): Promise<ChatMemberRow | null> {
  const row = await runner('chat_members').where({ room_id: roomId, user_id: userId }).first();
  return row ? mapMember(row as Row) : null;
}

/** Add a person, or change the role of one already in. A new member starts caught up. */
export async function upsertMember(
  trx: TransactionContext,
  row: { tenantId: string; roomId: string; userId: string; role: ChatMemberRole; startAtSeq: number },
): Promise<void> {
  await trx('chat_members')
    .insert({
      room_id: row.roomId,
      tenant_id: row.tenantId,
      user_id: row.userId,
      role: row.role,
      last_read_seq: row.startAtSeq,
    })
    .onConflict(['room_id', 'user_id'])
    .merge({ role: row.role });
}

export async function deleteMember(trx: TransactionContext, roomId: string, userId: string): Promise<void> {
  await trx('chat_members').where({ room_id: roomId, user_id: userId }).delete();
}

/** Move a member's read position forward, never past the room's last message and never back. */
export async function setLastRead(
  runner: Runner,
  roomId: string,
  userId: string,
  seq: number,
): Promise<number | null> {
  const result = await runner.raw(
    `UPDATE chat_members m
        SET last_read_seq = GREATEST(m.last_read_seq, LEAST(?::bigint, r.last_seq))
       FROM chat_rooms r
      WHERE m.room_id = ? AND m.user_id = ? AND r.id = m.room_id
      RETURNING m.last_read_seq`,
    [seq, roomId, userId],
  );
  const row = (result.rows as Row[])[0];
  return row ? Number(row.last_read_seq) : null;
}

export async function setMuted(roomId: string, userId: string, muted: boolean): Promise<boolean> {
  const count = await db()('chat_members').where({ room_id: roomId, user_id: userId }).update({ muted });
  return count > 0;
}

// --- Messages -----------------------------------------------------------------

export async function insertMessage(
  trx: TransactionContext,
  row: {
    id: string;
    tenantId: string;
    roomId: string;
    seq: number;
    authorId: string | null;
    kind: ChatMessageKind;
    body: string;
    refs: unknown[];
    mentions: string[];
    system: { event: string; params: Record<string, string> } | null;
    clientId: string | null;
    taskAssignees: string[] | null;
    taskDueOn: string | null;
  },
): Promise<ChatMessageRow> {
  const [created] = await trx('chat_messages')
    .insert({
      id: row.id,
      tenant_id: row.tenantId,
      room_id: row.roomId,
      seq: row.seq,
      author_id: row.authorId,
      kind: row.kind,
      body: row.body,
      refs: JSON.stringify(row.refs),
      mentions: JSON.stringify(row.mentions),
      system: row.system ? JSON.stringify(row.system) : null,
      client_id: row.clientId,
      task_assignees: row.taskAssignees ? JSON.stringify(row.taskAssignees) : null,
      task_due_on: row.taskDueOn,
    })
    .returning('*');
  return mapMessageRow(created as Row);
}

export async function findMessage(
  tenantId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
  runner: Runner = db(),
): Promise<ChatMessageRow | null> {
  const query = runner('chat_messages').where({ tenant_id: tenantId, id });
  if (options.forUpdate) query.forUpdate();
  const row = await query.first();
  return row ? mapMessageRow(row as Row) : null;
}

export async function findMessageByClientId(
  tenantId: string,
  clientId: string,
  runner: Runner = db(),
): Promise<ChatMessageRow | null> {
  const row = await runner('chat_messages').where({ tenant_id: tenantId, client_id: clientId }).first();
  return row ? mapMessageRow(row as Row) : null;
}

/** Up to `limit` messages older than `beforeSeq` (or the newest), oldest first. */
export async function listMessages(
  roomId: string,
  options: { beforeSeq?: number | null; limit: number },
  runner: Runner = db(),
): Promise<ChatMessageRow[]> {
  const query = runner('chat_messages').where({ room_id: roomId });
  if (options.beforeSeq) query.where('seq', '<', options.beforeSeq);
  const rows = await query.orderBy('seq', 'desc').limit(options.limit);
  return rows.reverse().map((row) => mapMessageRow(row as Row));
}

export async function listPinned(roomId: string, runner: Runner = db()): Promise<ChatMessageRow[]> {
  const rows = await runner('chat_messages')
    .where({ room_id: roomId })
    .whereNotNull('pinned_at')
    .whereNull('deleted_at')
    .orderBy('pinned_at', 'desc');
  return rows.map((row) => mapMessageRow(row as Row));
}

export async function updateMessageColumns(
  trx: TransactionContext,
  id: string,
  patch: Partial<{
    body: string;
    mentions: string[];
    editedAt: Date;
    deletedAt: Date | null;
    deletedBy: string | null;
    pinnedAt: Date | null;
    pinnedBy: string | null;
    taskDoneAt: Date | null;
    taskDoneBy: string | null;
  }>,
): Promise<ChatMessageRow> {
  const set: Row = {};
  if ('body' in patch) set.body = patch.body;
  if ('mentions' in patch) set.mentions = JSON.stringify(patch.mentions ?? []);
  if ('editedAt' in patch) set.edited_at = patch.editedAt;
  if ('deletedAt' in patch) set.deleted_at = patch.deletedAt;
  if ('deletedBy' in patch) set.deleted_by = patch.deletedBy;
  if ('pinnedAt' in patch) set.pinned_at = patch.pinnedAt;
  if ('pinnedBy' in patch) set.pinned_by = patch.pinnedBy;
  if ('taskDoneAt' in patch) set.task_done_at = patch.taskDoneAt;
  if ('taskDoneBy' in patch) set.task_done_by = patch.taskDoneBy;
  const [row] = await trx('chat_messages').where({ id }).update(set).returning('*');
  return mapMessageRow(row as Row);
}

/** The database's own clock, so the five-minute window never trusts a panel's. */
export async function databaseNow(runner: Runner = db()): Promise<Date> {
  const result = await runner.raw('SELECT now() AS now');
  return (result.rows as Array<{ now: Date }>)[0]!.now;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Messages in the person's own rooms that contain the text, newest first. */
export async function searchMessages(
  tenantId: string,
  userId: string,
  term: string,
  roomId: string | null,
  limit: number,
  runner: Runner = db(),
): Promise<Array<{ message: ChatMessageRow; room: ChatRoomRow }>> {
  const query = runner('chat_messages as x')
    .join('chat_rooms as r', 'r.id', 'x.room_id')
    .join('chat_members as m', function join() {
      this.on('m.room_id', '=', 'r.id').andOn('m.user_id', '=', runner.raw('?', [userId]));
    })
    .where('x.tenant_id', tenantId)
    .whereNull('x.deleted_at')
    .where('x.kind', '<>', 'system')
    .whereRaw(`x.body ILIKE ? ESCAPE '\\'`, [`%${escapeLike(term)}%`])
    .orderBy('x.created_at', 'desc')
    .orderBy('x.id', 'desc')
    .limit(limit)
    .select(runner.raw('x.*'), runner.raw('to_jsonb(r.*) AS room_json'));
  if (roomId) query.where('x.room_id', roomId);

  const rows = (await query) as Row[];
  return rows.map((row) => ({
    message: mapMessageRow(row),
    room: mapRoom(row.room_json as Row),
  }));
}

/** Tasks in the person's rooms: assigned to them (`mine`) or set by them (`created`). */
export async function listTasks(
  tenantId: string,
  userId: string,
  scope: 'mine' | 'created',
  includeDone: boolean,
  runner: Runner = db(),
): Promise<Array<{ message: ChatMessageRow; room: ChatRoomRow }>> {
  const query = runner('chat_messages as x')
    .join('chat_rooms as r', 'r.id', 'x.room_id')
    .join('chat_members as m', function join() {
      this.on('m.room_id', '=', 'r.id').andOn('m.user_id', '=', runner.raw('?', [userId]));
    })
    .where('x.tenant_id', tenantId)
    .where('x.kind', 'task')
    .whereNull('x.deleted_at')
    .orderByRaw('(x.task_done_at IS NOT NULL), x.task_due_on NULLS LAST, x.created_at DESC')
    .limit(200)
    .select(runner.raw('x.*'), runner.raw('to_jsonb(r.*) AS room_json'));
  if (scope === 'mine') query.whereRaw('x.task_assignees @> to_jsonb(?::text)', [userId]);
  else query.where('x.author_id', userId);
  if (!includeDone) query.whereNull('x.task_done_at');

  const rows = (await query) as Row[];
  return rows.map((row) => ({
    message: mapMessageRow(row),
    room: mapRoom(row.room_json as Row),
  }));
}
