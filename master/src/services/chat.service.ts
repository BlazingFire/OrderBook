/**
 * The Chatroom (1.3 Phase 6): rooms, messages, tasks, pins, mentions, search.
 *
 * What it is **not** is as important as what it is. Chat never enters the
 * change ring and never writes the activity log except for governance: a room
 * created, renamed, archived, a member added, removed or re-roled, a pin, and a
 * moderator removing somebody else's message. Posts, edits of one's own words,
 * reads and task ticks are not audited, which also keeps chat off the
 * activity-chain's advisory lock. Live updates travel on the change bus's own
 * chat channel (`publishChat`) and are addressed to room members only.
 *
 * Every function names the acting person. A non-member is told a room does not
 * exist, never that it does and is closed to them. Where a rule is a business
 * rule (announcement rooms, the edit window, who may pin) it is enforced here,
 * not by the screens.
 *
 * Lock order: `chat_rooms` row first, then `id_sequences` ('chat_message').
 * Nothing takes them the other way round; keep it that way.
 */

import type {
  ChatMemberRole,
  ChatMessage,
  ChatPerson,
  ChatPostInput,
  ChatPush,
  ChatRecordChip,
  ChatRecordRef,
  ChatRoomDetail,
  ChatRoomInput,
  ChatRoomKind,
  ChatRoomPatch,
  ChatRoomSummary,
  ChatSearchHit,
  ChatSystemEvent,
  ChatTaskRow,
  Permission,
} from '@orderbook/shared';
import {
  CHAT_LIMITS,
  cleanChatPost,
  isChatAccessCapability,
  recordNumber,
  unreadOf,
  directKeyOf,
  withinEditWindow,
} from '@orderbook/shared';

import { actorCan, requirePermission, type ActorContext } from '../domain/actor.js';
import { db } from '../db/knex.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, toErrorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as activityRepo from '../repositories/activity-log.repository.js';
import * as chatRepo from '../repositories/chat.repository.js';
import type { ChatMessageRow, ChatRoomListRow, ChatRoomRow } from '../repositories/chat.repository.js';
import * as identityRepo from '../repositories/identity.repository.js';
import { findActiveUserIdsWithPermission } from '../repositories/user.repository.js';
import type { TransactionContext } from '../repositories/transaction.js';
import * as userRepo from '../repositories/user.repository.js';
import { publishChat } from './change-bus.js';
import * as leadService from './lead.service.js';
import { notify } from './notification.service.js';
import * as orderService from './order.service.js';

const log = createLogger('chat');

// --- Gates ----------------------------------------------------------------------

/** The acting person, or a refusal. Every function starts here. */
function requireChatUser(actor: ActorContext): string {
  requirePermission(actor, 'chat.use');
  // A panel acting as itself has no person to chat as. Its role cannot hold
  // `chat.use`, so this is defence in depth.
  if (!actor.userId) throw new ForbiddenError('chat.use');
  return actor.userId;
}

const isManager = (actor: ActorContext): boolean => actorCan(actor, 'chat.manage');

async function requireMember(actor: ActorContext, roomId: string): Promise<ChatRoomListRow> {
  const userId = requireChatUser(actor);
  const room = await chatRepo.findRoomFor(actor.tenantId, userId, roomId);
  // The same answer for "no such room" and "not yours": never confirm one exists.
  if (!room || !room.myRole) throw new NotFoundError('Room');
  return room;
}

/** A room the person belongs to, or any group when they hold `chat.manage`. */
async function requireVisibleRoom(actor: ActorContext, roomId: string): Promise<ChatRoomListRow> {
  const userId = requireChatUser(actor);
  const room = await chatRepo.findRoomFor(actor.tenantId, userId, roomId);
  if (!room) throw new NotFoundError('Room');
  if (room.myRole) return room;
  if (isManager(actor) && room.kind !== 'direct') return room;
  throw new NotFoundError('Room');
}

/** Room admins, and `chat.manage` holders over any group. */
function canAdminister(actor: ActorContext, room: ChatRoomListRow): boolean {
  if (room.kind === 'direct') return false;
  return room.myRole === 'admin' || isManager(actor);
}

// --- Records the viewer may open -------------------------------------------------

/**
 * A chip as the acting person may see it. What a viewer is not allowed to open
 * (or what is gone) comes back `restricted` with no label and no party, so the
 * room never learns which party a restricted record belongs to.
 */
async function resolveChip(
  chip: ChatRecordChip,
  actor: ActorContext,
  cache: Map<string, Promise<ChatRecordRef>>,
): Promise<ChatRecordRef> {
  const key = `${chip.kind}:${chip.id}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = (async (): Promise<ChatRecordRef> => {
    const restricted: ChatRecordRef = { ...chip, label: null, partyName: null, restricted: true };
    const view: Permission = chip.kind === 'lead' ? 'leads.view' : 'orders.view';
    if (!actorCan(actor, view)) return restricted;
    try {
      const record =
        chip.kind === 'lead'
          ? await leadService.getLead(chip.id, actor)
          : await orderService.getOrder(chip.id, actor);
      return { ...chip, label: recordNumber(record), partyName: record.partyName, restricted: false };
    } catch {
      return restricted;
    }
  })();
  cache.set(key, pending);
  return pending;
}

/** The sender's own check: every chip must be a record the sender can open now. */
async function canonicalChips(chips: readonly ChatRecordChip[], actor: ActorContext): Promise<ChatRecordChip[]> {
  const cache = new Map<string, Promise<ChatRecordRef>>();
  const out: ChatRecordChip[] = [];
  for (const chip of chips) {
    // A record made offline is still named by its temporary id on the sender's panel.
    const id = await identityRepo.resolveId(actor.tenantId, chip.id);
    const resolved = await resolveChip({ kind: chip.kind, id }, actor, cache);
    if (resolved.restricted) throw new ValidationError('validation.chat.refNotFound');
    out.push({ kind: chip.kind, id });
  }
  return out;
}

// --- Hydration -------------------------------------------------------------------

interface HydrateOptions {
  /** Resolve chips for this viewer. Without it they are all `restricted`, ready for the hub to personalise. */
  resolveFor?: ActorContext;
  /** Leave chips out entirely (search hits, task rows, previews). */
  noRefs?: boolean;
}

async function hydrate(rows: readonly ChatMessageRow[], tenantId: string, options: HydrateOptions): Promise<ChatMessage[]> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.authorId) ids.add(row.authorId);
    if (row.taskDoneBy) ids.add(row.taskDoneBy);
    for (const id of row.taskAssignees ?? []) ids.add(id);
  }
  const people = new Map((await chatRepo.listPeopleByIds(tenantId, [...ids])).map((p) => [p.id, p]));
  const person = (id: string | null): ChatPerson | null => (id ? (people.get(id) ?? unknownPerson(id)) : null);

  const cache = new Map<string, Promise<ChatRecordRef>>();
  const out: ChatMessage[] = [];

  for (const row of rows) {
    const deleted = row.deletedAt !== null;
    let refs: ChatRecordRef[] = [];
    if (!deleted && !options.noRefs) {
      refs = options.resolveFor
        ? await Promise.all(row.refs.map((chip) => resolveChip(chip, options.resolveFor as ActorContext, cache)))
        : row.refs.map((chip) => ({ ...chip, label: null, partyName: null, restricted: true }));
    }

    out.push({
      id: row.id,
      roomId: row.roomId,
      seq: row.seq,
      kind: row.kind,
      author: person(row.authorId),
      // The body of a deleted message stays in the table for the record and is never served.
      body: deleted ? '' : row.body,
      refs,
      mentions: deleted ? [] : row.mentions,
      system: row.system ? { event: row.system.event as ChatSystemEvent, params: row.system.params } : null,
      createdAt: row.createdAt,
      editedAt: row.editedAt,
      deletedAt: row.deletedAt,
      pinnedAt: deleted ? null : row.pinnedAt,
      pinnedBy: deleted ? null : row.pinnedBy,
      task:
        row.kind === 'task' && row.taskAssignees && !deleted
          ? {
              assignees: row.taskAssignees.map((id) => person(id) as ChatPerson),
              dueOn: row.taskDueOn,
              doneAt: row.taskDoneAt,
              doneBy: person(row.taskDoneBy),
            }
          : null,
      clientId: row.clientId,
    });
  }
  return out;
}

function unknownPerson(id: string): ChatPerson {
  return { id, displayName: id, avatar: null, tier: 'office' };
}

async function hydrateOne(row: ChatMessageRow, actor: ActorContext): Promise<ChatMessage> {
  return (await hydrate([row], actor.tenantId, { resolveFor: actor }))[0] as ChatMessage;
}

/** A message as it travels on the bus: chips all `restricted`, for the hub to personalise per recipient. */
async function hydrateForPush(row: ChatMessageRow, tenantId: string): Promise<ChatMessage> {
  return (await hydrate([row], tenantId, {}))[0] as ChatMessage;
}

/**
 * Re-resolve a pushed message's chips for one recipient. Called by the hub for
 * every socket, because two members of one room can differ in what they may
 * open.
 */
export async function personalisePush(push: ChatPush, actor: ActorContext): Promise<ChatPush> {
  if (push.kind !== 'message' || push.message.refs.length === 0) return push;
  const cache = new Map<string, Promise<ChatRecordRef>>();
  const refs = await Promise.all(push.message.refs.map((chip) => resolveChip(chip, actor, cache)));
  return { ...push, message: { ...push.message, refs } };
}

// --- Rooms: wire shapes ------------------------------------------------------------

async function summarise(rows: readonly ChatRoomListRow[], actor: ActorContext): Promise<ChatRoomSummary[]> {
  const latest = await chatRepo.latestMessages(rows.map((r) => r.id));
  const previews = new Map(
    (await hydrate(latest, actor.tenantId, { noRefs: true })).map((message) => [message.roomId, message]),
  );

  // A direct chat is named for the other person.
  const directKeys = rows.filter((r) => r.kind === 'direct');
  const others = new Map<string, string>();
  for (const room of directKeys) {
    const other = (room.directKey ?? '').split(':').find((id) => id !== actor.userId);
    if (other) others.set(room.id, other);
  }
  const people = new Map(
    (await chatRepo.listPeopleByIds(actor.tenantId, [...others.values()])).map((p) => [p.id, p]),
  );

  return rows.map((room) => {
    const otherId = others.get(room.id);
    return {
      id: room.id,
      kind: room.kind,
      name: room.name,
      description: room.description,
      announceOnly: room.kind === 'announcement',
      archivedAt: room.archivedAt,
      myRole: room.myRole,
      muted: room.muted,
      lastSeq: room.lastSeq,
      lastReadSeq: room.lastReadSeq,
      unread: room.myRole ? unreadOf(room) : 0,
      mentionUnread: room.mentionUnread,
      memberCount: room.memberCount,
      lastMessageAt: room.lastMessageAt,
      lastMessage: previews.get(room.id) ?? null,
      direct: otherId ? (people.get(otherId) ?? unknownPerson(otherId)) : null,
    };
  });
}

async function summaryOf(roomId: string, actor: ActorContext): Promise<ChatRoomSummary> {
  const row = await chatRepo.findRoomFor(actor.tenantId, actor.userId as string, roomId);
  if (!row) throw new NotFoundError('Room');
  return (await summarise([row], actor))[0] as ChatRoomSummary;
}

// --- Reads -------------------------------------------------------------------------

/** Everyone the acting person may chat with: active people who hold `chat.use`. */
export async function listPeople(actor: ActorContext): Promise<ChatPerson[]> {
  requireChatUser(actor);
  const ids = await findActiveUserIdsWithPermission(actor.tenantId, 'chat.use');
  return (await chatRepo.listPeopleByIds(actor.tenantId, ids)).sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
}

export async function listRooms(
  input: { all?: unknown; includeArchived?: unknown } | null | undefined,
  actor: ActorContext,
): Promise<ChatRoomSummary[]> {
  const userId = requireChatUser(actor);
  const includeArchived = input?.includeArchived === true;
  const rows =
    input?.all === true && isManager(actor)
      ? await chatRepo.listAllGroups(actor.tenantId, userId, { includeArchived })
      : await chatRepo.listRoomsFor(actor.tenantId, userId, { includeArchived });
  return summarise(rows, actor);
}

export async function getRoom(roomId: string, actor: ActorContext): Promise<ChatRoomDetail> {
  const room = await requireVisibleRoom(actor, roomId);
  const [summary] = await summarise([room], actor);
  const members = await chatRepo.listMembers(room.id);
  const people = new Map(
    (await chatRepo.listPeopleByIds(actor.tenantId, members.map((m) => m.userId))).map((p) => [p.id, p]),
  );
  const pinned = room.myRole
    ? await hydrate(await chatRepo.listPinned(room.id), actor.tenantId, { resolveFor: actor })
    : [];

  return {
    ...(summary as ChatRoomSummary),
    members: members.map((m) => ({
      ...(people.get(m.userId) ?? unknownPerson(m.userId)),
      role: m.role,
      lastReadSeq: m.lastReadSeq,
    })),
    pinned,
  };
}

export async function listMessages(
  input: { roomId?: unknown; beforeSeq?: unknown; limit?: unknown } | null | undefined,
  actor: ActorContext,
): Promise<ChatMessage[]> {
  if (typeof input?.roomId !== 'string') throw new NotFoundError('Room');
  const room = await requireMember(actor, input.roomId);

  const beforeSeq =
    typeof input.beforeSeq === 'number' && Number.isInteger(input.beforeSeq) && input.beforeSeq > 0
      ? input.beforeSeq
      : null;
  const limit =
    typeof input.limit === 'number' && Number.isInteger(input.limit)
      ? Math.min(Math.max(input.limit, 1), 100)
      : CHAT_LIMITS.pageSize;

  const rows = await chatRepo.listMessages(room.id, { beforeSeq, limit });
  return hydrate(rows, actor.tenantId, { resolveFor: actor });
}

export async function search(
  input: { q?: unknown; roomId?: unknown } | null | undefined,
  actor: ActorContext,
): Promise<ChatSearchHit[]> {
  const userId = requireChatUser(actor);
  const term = typeof input?.q === 'string' ? input.q.trim() : '';
  if (term.length < CHAT_LIMITS.searchMin) return [];

  const roomId = typeof input?.roomId === 'string' ? input.roomId : null;
  const hits = await chatRepo.searchMessages(actor.tenantId, userId, term, roomId, CHAT_LIMITS.searchMax);
  const messages = await hydrate(
    hits.map((h) => h.message),
    actor.tenantId,
    { noRefs: true },
  );
  return hits.map((hit, index) => ({
    message: messages[index] as ChatMessage,
    roomId: hit.room.id,
    roomName: hit.room.name,
    roomKind: hit.room.kind,
  }));
}

export async function listTasks(
  input: { scope?: unknown; includeDone?: unknown } | null | undefined,
  actor: ActorContext,
): Promise<ChatTaskRow[]> {
  const userId = requireChatUser(actor);
  const scope = input?.scope === 'created' ? 'created' : 'mine';
  const rows = await chatRepo.listTasks(actor.tenantId, userId, scope, input?.includeDone === true);
  const messages = await hydrate(
    rows.map((r) => r.message),
    actor.tenantId,
    { noRefs: true },
  );
  return rows.map((row, index) => ({
    message: messages[index] as ChatMessage,
    roomId: row.room.id,
    roomName: row.room.name,
  }));
}

// --- Fan-out -----------------------------------------------------------------------

async function memberIds(roomId: string): Promise<string[]> {
  return (await chatRepo.listMembers(roomId)).map((m) => m.userId);
}

function emit(tenantId: string, userIds: readonly string[], push: ChatPush): void {
  if (userIds.length > 0) publishChat({ tenantId, userIds: [...new Set(userIds)], push });
}

async function publishMessage(row: ChatMessageRow, tenantId: string, extraUserIds: readonly string[] = []): Promise<void> {
  try {
    const message = await hydrateForPush(row, tenantId);
    emit(tenantId, [...(await memberIds(row.roomId)), ...extraUserIds], {
      kind: 'message',
      roomId: row.roomId,
      message,
    });
  } catch (error) {
    // The write is committed; a failed push costs liveness, not data.
    log.warn(`Could not publish a chat message: ${toErrorMessage(error)}`);
  }
}

async function publishRoom(roomId: string, tenantId: string, extraUserIds: readonly string[] = []): Promise<void> {
  try {
    emit(tenantId, [...(await memberIds(roomId)), ...extraUserIds], { kind: 'room', roomId });
  } catch (error) {
    log.warn(`Could not publish a chat room: ${toErrorMessage(error)}`);
  }
}

// --- Notifications ------------------------------------------------------------------

async function roomLabel(room: ChatRoomRow, authorName: string): Promise<string> {
  return room.kind === 'direct' ? authorName : (room.name ?? '');
}

/** After commit. A failure here never fails the post. */
async function notifyAfterPost(
  tenantId: string,
  room: ChatRoomRow,
  members: readonly chatRepo.ChatMemberRow[],
  row: ChatMessageRow,
  authorName: string,
): Promise<void> {
  try {
    const mutedByUser = new Map(members.map((m) => [m.userId, m.muted]));
    const inRoom = new Set(members.map((m) => m.userId));
    const label = await roomLabel(room, authorName);
    const link = { kind: 'chat' as const, id: room.id, messageId: row.id };

    // A mention reaches the person even in a muted room: it is addressed to them.
    const mentioned = row.mentions.filter((id) => id !== row.authorId && inRoom.has(id));
    if (mentioned.length > 0) {
      await notify(tenantId, mentioned, {
        kind: 'chat.mention',
        params: { name: authorName, room: label },
        link,
        dedupeKey: `chat.mention:${room.id}`,
      });
    }

    if (row.kind === 'task') {
      const assigned = (row.taskAssignees ?? []).filter(
        (id) => id !== row.authorId && inRoom.has(id) && !mutedByUser.get(id),
      );
      if (assigned.length > 0) {
        await notify(tenantId, assigned, {
          kind: 'task.assigned',
          params: { name: authorName, room: label },
          link,
          dedupeKey: `task.assigned:${row.id}`,
        });
      }
    }
  } catch (error) {
    log.warn(`Could not notify for a chat message: ${toErrorMessage(error)}`);
  }
}

// --- Posting ------------------------------------------------------------------------

/**
 * Post a message. Both transports end here: the Master's own browser through
 * `POST /api/chat/rooms/:id/messages`, and an Office through the `chat.post`
 * mutation (`sync.service.ts`), which sets `clientId` to the mutation's id so
 * a resend returns the message it already made.
 */
export async function postMessage(
  roomId: string,
  input: ChatPostInput,
  actor: ActorContext,
): Promise<ChatMessage> {
  const userId = requireChatUser(actor);

  const cleaned = cleanChatPost(input);
  if ('errorKey' in cleaned) throw new ValidationError(cleaned.errorKey);
  const post = cleaned.value;

  if (post.refs.length > 0) requirePermission(actor, 'chat.shareRecords');
  if (post.task) requirePermission(actor, 'chat.tasks');

  // Outside the transaction, to keep the room lock short.
  const refs = await canonicalChips(post.refs, actor);

  const result = await db().transaction(async (trx) => {
    const room = await chatRepo.lockRoom(trx, actor.tenantId, roomId);
    const me = room ? await chatRepo.findMember(roomId, userId, trx) : null;
    if (!room || !me) throw new NotFoundError('Room');

    // A resend: the same post, answered with the message it already made.
    if (post.clientId) {
      const existing = await chatRepo.findMessageByClientId(actor.tenantId, post.clientId, trx);
      if (existing) {
        if (existing.authorId !== userId || existing.roomId !== roomId) throw new NotFoundError('Room');
        return { row: existing, room, fresh: false };
      }
    }

    if (room.archivedAt) throw new ValidationError('validation.chat.roomArchived');
    if (room.kind === 'announcement' && me.role !== 'admin' && !isManager(actor)) {
      throw new ValidationError('validation.chat.announceOnly');
    }

    const members = await chatRepo.listMembers(roomId, trx);
    const memberSet = new Set(members.map((m) => m.userId));

    if (post.task && !post.task.assignees.every((id) => memberSet.has(id))) {
      throw new ValidationError('validation.chat.assigneeNotMember');
    }
    const mentions = post.mentions.filter((id) => memberSet.has(id));

    const seq = await chatRepo.bumpRoomSeq(trx, roomId);
    const id = await identityRepo.allocatePermanentId(actor.tenantId, 'chat_message', trx);
    const row = await chatRepo.insertMessage(trx, {
      id,
      tenantId: actor.tenantId,
      roomId,
      seq,
      authorId: userId,
      kind: post.task ? 'task' : 'text',
      body: post.body,
      refs,
      mentions,
      system: null,
      clientId: post.clientId,
      taskAssignees: post.task?.assignees ?? null,
      taskDueOn: post.task?.dueOn ?? null,
    });
    await chatRepo.setLastRead(trx, roomId, userId, seq);
    return { row, room, fresh: true };
  });

  if (result.fresh) {
    await publishMessage(result.row, actor.tenantId);
    const members = await chatRepo.listMembers(roomId);
    await notifyAfterPost(actor.tenantId, result.room, members, result.row, actor.actorName ?? userId);
  }

  return hydrateOne(result.row, actor);
}

// --- Editing, deleting, pinning, ticking ----------------------------------------------

async function loadOwnMessage(
  messageId: string,
  actor: ActorContext,
  trx: TransactionContext,
): Promise<{ row: ChatMessageRow; room: ChatRoomListRow }> {
  const userId = requireChatUser(actor);
  const row = await chatRepo.findMessage(actor.tenantId, messageId, { forUpdate: true }, trx);
  if (!row) throw new NotFoundError('Message');
  const room = await chatRepo.findRoomFor(actor.tenantId, userId, row.roomId, trx);
  if (!room || (!room.myRole && !(isManager(actor) && room.kind !== 'direct'))) throw new NotFoundError('Message');
  return { row, room };
}

export async function editMessage(
  input: { messageId?: unknown; body?: unknown; mentions?: unknown } | null | undefined,
  actor: ActorContext,
): Promise<ChatMessage> {
  const userId = requireChatUser(actor);
  if (typeof input?.messageId !== 'string') throw new NotFoundError('Message');

  const updated = await db().transaction(async (trx) => {
    const { row, room } = await loadOwnMessage(input.messageId as string, actor, trx);
    if (row.authorId !== userId || row.kind === 'system' || row.deletedAt) {
      throw new ForbiddenError('chat.use');
    }
    if (!room.myRole) throw new NotFoundError('Message');
    if (room.archivedAt) throw new ValidationError('validation.chat.roomArchived');

    const now = await chatRepo.databaseNow(trx);
    if (!withinEditWindow(row.createdAt, now.getTime())) throw new ValidationError('validation.chat.editWindow');

    const cleaned = cleanChatPost({ body: input.body, refs: row.refs, task: row.kind === 'task' ? { assignees: row.taskAssignees ?? [] } : null });
    if ('errorKey' in cleaned) throw new ValidationError(cleaned.errorKey);

    const members = new Set((await chatRepo.listMembers(room.id, trx)).map((m) => m.userId));
    const rawMentions = Array.isArray(input.mentions) ? (input.mentions as unknown[]) : [];
    const mentions = rawMentions.filter((id): id is string => typeof id === 'string' && members.has(id));

    return chatRepo.updateMessageColumns(trx, row.id, { body: cleaned.value.body, mentions, editedAt: now });
  });

  await publishMessage(updated, actor.tenantId);
  return hydrateOne(updated, actor);
}

export async function deleteMessage(messageId: string, actor: ActorContext): Promise<ChatMessage> {
  const userId = requireChatUser(actor);

  const updated = await db().transaction(async (trx) => {
    const { row, room } = await loadOwnMessage(messageId, actor, trx);
    if (row.kind === 'system') throw new ForbiddenError('chat.use');
    if (row.deletedAt) return row;

    const own = row.authorId === userId && !!room.myRole;
    const moderator = canAdminister(actor, room);
    const now = await chatRepo.databaseNow(trx);

    if (own && !withinEditWindow(row.createdAt, now.getTime()) && !moderator) {
      throw new ValidationError('validation.chat.editWindow');
    }
    if (!own && !moderator) throw new ForbiddenError('chat.manage');

    const next = await chatRepo.updateMessageColumns(trx, row.id, {
      deletedAt: now,
      deletedBy: userId,
      pinnedAt: null,
      pinnedBy: null,
    });

    // A moderator removing somebody else's words is governance; deleting your own is not.
    if (!own) {
      await activityRepo.recordActivity(
        {
          tenantId: actor.tenantId,
          entityType: 'chat_message',
          entityId: row.id,
          action: 'removed',
          actorType: actor.actorType,
          actorId: actor.actorId,
          details: { name: room.name ?? '', author: await personName(actor.tenantId, row.authorId) },
        },
        actor,
        trx,
      );
    }
    return next;
  });

  await publishMessage(updated, actor.tenantId);
  return hydrateOne(updated, actor);
}

async function personName(tenantId: string, id: string | null): Promise<string> {
  if (!id) return '';
  const [person] = await chatRepo.listPeopleByIds(tenantId, [id]);
  return person?.displayName ?? id;
}

export async function pinMessage(
  input: { messageId?: unknown; pinned?: unknown } | null | undefined,
  actor: ActorContext,
): Promise<ChatMessage> {
  const userId = requireChatUser(actor);
  if (typeof input?.messageId !== 'string') throw new NotFoundError('Message');
  const pinned = input.pinned === true;

  const updated = await db().transaction(async (trx) => {
    const { row, room } = await loadOwnMessage(input.messageId as string, actor, trx);
    if (!canAdminister(actor, room)) throw new ForbiddenError('chat.manage');
    if (row.deletedAt || row.kind === 'system') throw new ValidationError('validation.chat.notPinnable');
    if (room.archivedAt) throw new ValidationError('validation.chat.roomArchived');
    if ((row.pinnedAt !== null) === pinned) return row;

    const now = await chatRepo.databaseNow(trx);
    const next = await chatRepo.updateMessageColumns(trx, row.id, {
      pinnedAt: pinned ? now : null,
      pinnedBy: pinned ? userId : null,
    });
    await activityRepo.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'chat_message',
        entityId: row.id,
        action: pinned ? 'pinned' : 'unpinned',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: room.name ?? '' },
      },
      actor,
      trx,
    );
    return next;
  });

  await publishMessage(updated, actor.tenantId);
  return hydrateOne(updated, actor);
}

export async function setTaskDone(
  input: { messageId?: unknown; done?: unknown } | null | undefined,
  actor: ActorContext,
): Promise<ChatMessage> {
  const userId = requireChatUser(actor);
  if (typeof input?.messageId !== 'string') throw new NotFoundError('Message');
  const done = input.done === true;

  const { updated, room, changed } = await db().transaction(async (trx) => {
    const { row, room } = await loadOwnMessage(input.messageId as string, actor, trx);
    if (row.kind !== 'task' || row.deletedAt) throw new ValidationError('validation.chat.notTask');

    const allowed =
      (row.taskAssignees ?? []).includes(userId) || row.authorId === userId || canAdminister(actor, room);
    if (!allowed) throw new ForbiddenError('chat.tasks');
    if (!room.myRole && !isManager(actor)) throw new NotFoundError('Message');
    if ((row.taskDoneAt !== null) === done) return { updated: row, room, changed: false };

    const now = await chatRepo.databaseNow(trx);
    const next = await chatRepo.updateMessageColumns(trx, row.id, {
      taskDoneAt: done ? now : null,
      taskDoneBy: done ? userId : null,
    });
    return { updated: next, room, changed: true };
  });

  if (changed) {
    await publishMessage(updated, actor.tenantId);
    if (done && updated.authorId && updated.authorId !== userId) {
      try {
        await notify(actor.tenantId, [updated.authorId], {
          kind: 'task.done',
          params: { name: actor.actorName ?? userId, room: await roomLabel(room, actor.actorName ?? userId) },
          link: { kind: 'chat', id: updated.roomId, messageId: updated.id },
          dedupeKey: `task.done:${updated.id}`,
        });
      } catch (error) {
        log.warn(`Could not notify a finished task: ${toErrorMessage(error)}`);
      }
    }
  }
  return hydrateOne(updated, actor);
}

// --- Reading position, mute -------------------------------------------------------------

export async function markRead(
  input: { roomId?: unknown; seq?: unknown } | null | undefined,
  actor: ActorContext,
): Promise<{ lastReadSeq: number }> {
  const userId = requireChatUser(actor);
  if (typeof input?.roomId !== 'string') throw new NotFoundError('Room');
  const seq = typeof input.seq === 'number' && Number.isFinite(input.seq) ? Math.floor(input.seq) : 0;

  const room = await requireMember(actor, input.roomId);
  const lastReadSeq = await chatRepo.setLastRead(db(), room.id, userId, seq);
  if (lastReadSeq === null) throw new NotFoundError('Room');

  // The "seen by" counts on task cards follow this, so the other members hear of it.
  emit(actor.tenantId, await memberIds(room.id), { kind: 'read', roomId: room.id, userId, seq: lastReadSeq });
  return { lastReadSeq };
}

export async function setMuted(
  input: { roomId?: unknown; muted?: unknown } | null | undefined,
  actor: ActorContext,
): Promise<null> {
  const userId = requireChatUser(actor);
  if (typeof input?.roomId !== 'string') throw new NotFoundError('Room');
  const room = await requireMember(actor, input.roomId);
  await chatRepo.setMuted(room.id, userId, input.muted === true);
  return null;
}

// --- Rooms: creating and changing ------------------------------------------------------

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (name.length === 0) throw new ValidationError('validation.chat.nameRequired');
  if (name.length > CHAT_LIMITS.nameMax) throw new ValidationError('validation.chat.nameTooLong');
  return name;
}

function cleanDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > CHAT_LIMITS.descriptionMax) throw new ValidationError('validation.chat.descriptionTooLong');
  return text === '' ? null : text;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

/** Write a system line into a room's timeline. The caller holds the room lock. */
async function systemLine(
  trx: TransactionContext,
  tenantId: string,
  roomId: string,
  event: ChatSystemEvent,
  params: Record<string, string>,
  actorUserId: string | null,
): Promise<ChatMessageRow> {
  const seq = await chatRepo.bumpRoomSeq(trx, roomId);
  const id = await identityRepo.allocatePermanentId(tenantId, 'chat_message', trx);
  return chatRepo.insertMessage(trx, {
    id,
    tenantId,
    roomId,
    seq,
    authorId: actorUserId,
    kind: 'system',
    body: '',
    refs: [],
    mentions: [],
    system: { event, params },
    clientId: null,
    taskAssignees: null,
    taskDueOn: null,
  });
}

async function governance(
  trx: TransactionContext,
  actor: ActorContext,
  roomId: string,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  await activityRepo.recordActivity(
    {
      tenantId: actor.tenantId,
      entityType: 'chat_room',
      entityId: roomId,
      action,
      actorType: actor.actorType,
      actorId: actor.actorId,
      details,
    },
    actor,
    trx,
  );
}

export async function createRoom(input: ChatRoomInput, actor: ActorContext): Promise<ChatRoomSummary> {
  const userId = requireChatUser(actor);
  if (!actorCan(actor, 'chat.createGroups') && !isManager(actor)) throw new ForbiddenError('chat.createGroups');

  const name = cleanName(input?.name);
  const description = cleanDescription(input?.description);
  const kind: ChatRoomKind = input?.announceOnly === true ? 'announcement' : 'group';

  const holders = new Set(await findActiveUserIdsWithPermission(actor.tenantId, 'chat.use'));
  const invited = [...new Set((input?.memberIds ?? []).filter((id) => typeof id === 'string' && id !== userId))];
  const others = invited.filter((id) => holders.has(id));

  let created: { room: ChatRoomRow; line: ChatMessageRow };
  try {
    created = await db().transaction(async (trx) => {
      const room = await chatRepo.insertRoom(trx, {
        tenantId: actor.tenantId,
        kind,
        name,
        description,
        directKey: null,
        createdBy: userId,
      });
      await chatRepo.upsertMember(trx, { tenantId: actor.tenantId, roomId: room.id, userId, role: 'admin', startAtSeq: 0 });
      for (const id of others) {
        await chatRepo.upsertMember(trx, { tenantId: actor.tenantId, roomId: room.id, userId: id, role: 'member', startAtSeq: 0 });
      }
      const line = await systemLine(trx, actor.tenantId, room.id, 'created', { name }, userId);
      await chatRepo.setLastRead(trx, room.id, userId, line.seq);
      await governance(trx, actor, room.id, 'created', { name });
      return { room, line };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('error.conflict.chatRoomName', { name });
    throw error;
  }

  await publishRoom(created.room.id, actor.tenantId);
  await publishMessage(created.line, actor.tenantId);
  return summaryOf(created.room.id, actor);
}

export async function updateRoom(
  input: { roomId?: unknown; input?: ChatRoomPatch } | null | undefined,
  actor: ActorContext,
): Promise<ChatRoomSummary> {
  const userId = requireChatUser(actor);
  if (typeof input?.roomId !== 'string') throw new NotFoundError('Room');
  const patch = input.input ?? {};
  const roomId = input.roomId;

  const visible = await requireVisibleRoom(actor, roomId);
  if (visible.kind === 'direct') throw new NotFoundError('Room');
  if (!canAdminister(actor, visible)) throw new ForbiddenError('chat.manage');

  let lines: ChatMessageRow[];
  try {
    lines = await db().transaction(async (trx) => {
      const room = await chatRepo.lockRoom(trx, actor.tenantId, roomId);
      if (!room) throw new NotFoundError('Room');

      const columns: Parameters<typeof chatRepo.updateRoomColumns>[2] = {};
      const out: ChatMessageRow[] = [];

      if (patch.name !== undefined) {
        const name = cleanName(patch.name);
        if (name !== room.name) {
          columns.name = name;
        }
      }
      if (patch.description !== undefined) columns.description = cleanDescription(patch.description);

      let nextKind = room.kind;
      if (patch.announceOnly !== undefined) {
        nextKind = patch.announceOnly ? 'announcement' : 'group';
        if (nextKind !== room.kind) columns.kind = nextKind;
      }

      let archiveEvent: 'archived' | 'unarchived' | null = null;
      if (patch.archived !== undefined && patch.archived !== (room.archivedAt !== null)) {
        columns.archivedAt = patch.archived ? new Date() : null;
        columns.archivedBy = patch.archived ? userId : null;
        archiveEvent = patch.archived ? 'archived' : 'unarchived';
      }

      if (Object.keys(columns).length === 0) return out;
      const next = await chatRepo.updateRoomColumns(trx, roomId, columns);
      const name = next.name ?? '';

      if (columns.name !== undefined) out.push(await systemLine(trx, actor.tenantId, roomId, 'renamed', { name, previous: room.name ?? '' }, userId));
      if (columns.kind !== undefined) {
        out.push(await systemLine(trx, actor.tenantId, roomId, nextKind === 'announcement' ? 'announceOn' : 'announceOff', { name }, userId));
      }
      if (archiveEvent) out.push(await systemLine(trx, actor.tenantId, roomId, archiveEvent, { name }, userId));

      if (archiveEvent === 'archived') await governance(trx, actor, roomId, 'archived', { name });
      else if (archiveEvent === 'unarchived') await governance(trx, actor, roomId, 'restored', { name });
      const changedOther = columns.name !== undefined || columns.description !== undefined || columns.kind !== undefined;
      if (changedOther) await governance(trx, actor, roomId, 'updated', { name });
      return out;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('error.conflict.chatRoomName', { name: String(patch.name ?? '') });
    throw error;
  }

  await publishRoom(roomId, actor.tenantId);
  for (const line of lines) await publishMessage(line, actor.tenantId);
  return summaryOf(roomId, actor);
}

/**
 * Add a person, change their role, or take them out (`role: null`). A person
 * may always leave a group themselves; everything else is for room admins and
 * `chat.manage`. Returns the room as the caller now sees it, or null when they
 * have just left and can no longer see it.
 */
export async function setMember(
  input: { roomId?: unknown; userId?: unknown; role?: unknown } | null | undefined,
  actor: ActorContext,
): Promise<ChatRoomDetail | null> {
  const me = requireChatUser(actor);
  if (typeof input?.roomId !== 'string' || typeof input.userId !== 'string') throw new NotFoundError('Room');
  const roomId = input.roomId;
  const targetId = input.userId;
  const role: ChatMemberRole | null = input.role === 'admin' ? 'admin' : input.role === 'member' ? 'member' : null;

  const visible = await requireVisibleRoom(actor, roomId);
  if (visible.kind === 'direct') throw new NotFoundError('Room');
  const leaving = role === null && targetId === me && visible.myRole !== null;
  if (!leaving && !canAdminister(actor, visible)) throw new ForbiddenError('chat.manage');

  if (role !== null) {
    const holders = await findActiveUserIdsWithPermission(actor.tenantId, 'chat.use');
    if (!holders.includes(targetId)) throw new ValidationError('validation.chat.notMember');
  }

  const line = await db().transaction(async (trx) => {
    const room = await chatRepo.lockRoom(trx, actor.tenantId, roomId);
    if (!room) throw new NotFoundError('Room');
    const existing = await chatRepo.findMember(roomId, targetId, trx);
    const [target] = await chatRepo.listPeopleByIds(actor.tenantId, [targetId], trx);
    const targetName = target?.displayName ?? targetId;
    const name = room.name ?? '';

    if (role === null) {
      if (!existing) return null;
      await chatRepo.deleteMember(trx, roomId, targetId);
      const removed = await systemLine(trx, actor.tenantId, roomId, 'memberRemoved', { member: targetName }, me);
      if (!leaving) await governance(trx, actor, roomId, 'member_removed', { name, member: targetName });
      return removed;
    }

    if (existing && existing.role === role) return null;
    await chatRepo.upsertMember(trx, {
      tenantId: actor.tenantId,
      roomId,
      userId: targetId,
      role,
      startAtSeq: room.lastSeq,
    });
    if (existing) {
      await governance(trx, actor, roomId, 'role_changed', { name, member: targetName });
      return null;
    }
    const added = await systemLine(trx, actor.tenantId, roomId, 'memberAdded', { member: targetName }, me);
    await governance(trx, actor, roomId, 'member_added', { name, member: targetName });
    return added;
  });

  await publishRoom(roomId, actor.tenantId, [targetId]);
  if (line) await publishMessage(line, actor.tenantId, [targetId]);

  if (leaving && !isManager(actor)) return null;
  return getRoom(roomId, actor);
}

/** Find or start a one-to-one chat. Either person finds the same room. */
export async function openDirect(
  input: { userId?: unknown } | null | undefined,
  actor: ActorContext,
): Promise<ChatRoomSummary> {
  const me = requireChatUser(actor);
  requirePermission(actor, 'chat.directMessages');

  const other = typeof input?.userId === 'string' ? input.userId : '';
  if (!other) throw new NotFoundError('Person');
  if (other === me) throw new ValidationError('validation.chat.directSelf');

  const holders = await findActiveUserIdsWithPermission(actor.tenantId, 'chat.use');
  if (!holders.includes(other)) throw new NotFoundError('Person');

  const key = directKeyOf(me, other);
  let room = await chatRepo.findRoomByDirectKey(actor.tenantId, key);
  let made = false;

  if (!room) {
    try {
      room = await db().transaction(async (trx) => {
        const created = await chatRepo.insertRoom(trx, {
          tenantId: actor.tenantId,
          kind: 'direct',
          name: null,
          description: null,
          directKey: key,
          createdBy: me,
        });
        await chatRepo.upsertMember(trx, { tenantId: actor.tenantId, roomId: created.id, userId: me, role: 'member', startAtSeq: 0 });
        await chatRepo.upsertMember(trx, { tenantId: actor.tenantId, roomId: created.id, userId: other, role: 'member', startAtSeq: 0 });
        return created;
      });
      made = true;
    } catch (error) {
      // Two people opening the same chat at once: the second finds the first's.
      if (!isUniqueViolation(error)) throw error;
      room = await chatRepo.findRoomByDirectKey(actor.tenantId, key);
    }
  }
  if (!room) throw new NotFoundError('Room');

  if (made) await publishRoom(room.id, actor.tenantId);
  return summaryOf(room.id, actor);
}

// --- Asking for a right ------------------------------------------------------------------

/**
 * Tell the people who edit roles that this person wants a chat right they lack.
 * One unread request per person and right at a time.
 */
export async function requestAccess(
  input: { capability?: unknown; note?: unknown } | null | undefined,
  actor: ActorContext,
): Promise<{ notified: number }> {
  const userId = requireChatUser(actor);
  if (!isChatAccessCapability(input?.capability)) throw new ValidationError('validation.chat.capabilityUnknown');
  const capability = input.capability;
  if (actorCan(actor, capability)) return { notified: 0 };

  const editors = (await findActiveUserIdsWithPermission(actor.tenantId, 'roles.edit')).filter((id) => id !== userId);
  if (editors.length === 0) return { notified: 0 };

  const user = await userRepo.findById(actor.tenantId, userId);
  await notify(actor.tenantId, editors, {
    kind: 'access.requested',
    params: { name: actor.actorName ?? userId, capability },
    link: user?.roleId ? { kind: 'role', id: user.roleId } : null,
    dedupeKey: `access.requested:${userId}:${capability}`,
  });
  return { notified: editors.length };
}
