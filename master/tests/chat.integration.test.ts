/**
 * The Chatroom (1.3 Phase 6): rooms, posting, the five-minute window, tasks,
 * pins, mentions, record chips resolved per viewer, requests for a right, the
 * REST surface, and the migration's grant.
 *
 * Real services on a real database, because most of what matters is a
 * transaction (the gap-free sequence under concurrent posts), a lock order, or
 * a per-person answer to the same stored row.
 */

import type { ChatMessage, Permission } from '@orderbook/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  createTestProduct,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { createApp } from '../src/http/app.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/lib/errors.js';
import * as identityRepo from '../src/repositories/identity.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import * as chat from '../src/services/chat.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import * as partyAccess from '../src/services/party-access.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';
import * as chatroomMigration from '../src/db/migrations/20261005000000_chatroom.js';

let admin: ActorContext;
let tenantId: string;

const PASSWORD = 'correct-horse';

/** What an ordinary chat user holds: the switch, and sight of orders so chips can be opened. */
const BASIC: Permission[] = ['chat.use', 'leads.view', 'orders.view'];
const SHARER: Permission[] = [...BASIC, 'chat.shareRecords', 'chat.createGroups'];

interface Person {
  id: string;
  username: string;
  actor: ActorContext;
}

/** A real user with a real role (notifications and fan-out read the role), and the actor that role resolves to. */
async function person(
  username: string,
  permissions: Permission[] = BASIC,
  tier: 'office' | 'management' | 'admin' = 'office',
): Promise<Person> {
  const role = await roleService.createRole({ name: `Role ${username}`, tier, permissions }, admin);
  const { user } = await userService.createUser(
    { username, displayName: username, roleId: role.id, password: PASSWORD },
    admin,
  );
  const actor = { ...(await actorWith(permissions)), actorId: user.id, userId: user.id, actorName: username };
  return { id: user.id, username, actor };
}

/** A group `owner` creates and `others` are added to. */
async function group(owner: Person, others: Person[], name = 'Dispatch desk', announceOnly = false) {
  const created = await chat.createRoom(
    { name, announceOnly, memberIds: others.map((other) => other.id) },
    owner.actor,
  );
  return created.id;
}

async function notices(userId: string): Promise<Array<{ kind: string; params: Record<string, unknown> }>> {
  return db()('user_notifications').where({ user_id: userId }).orderBy('created_at').select('kind', 'params');
}

async function agePost(messageId: string, minutes = 6): Promise<void> {
  await db()('chat_messages')
    .where({ id: messageId })
    .update({ created_at: db().raw(`now() - interval '${minutes} minutes'`) });
}

async function activityActions(): Promise<string[]> {
  const rows = await db()('activity_log')
    .whereIn('entity_type', ['chat_room', 'chat_message'])
    .orderBy('created_at')
    .select('entity_type', 'action');
  return rows.map((row: { entity_type: string; action: string }) => `${row.entity_type}.${row.action}`);
}

describe.skipIf(!canRunIntegrationTests)('chatroom (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
    tenantId = await testTenantId();
  });

  describe('rooms and membership', () => {
    it('a creator becomes the room admin, the room opens with a system line, and the creation is audited', async () => {
      const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
      const bina = await person('bina');
      const roomId = await group(asha, [bina]);

      const detail = await chat.getRoom(roomId, asha.actor);
      expect(detail.myRole).toBe('admin');
      expect(detail.members.map((member) => [member.displayName, member.role])).toEqual([
        ['asha', 'admin'],
        ['bina', 'member'],
      ]);

      const messages = await chat.listMessages({ roomId }, bina.actor);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ seq: 1, kind: 'system', system: { event: 'created' } });
      expect(await activityActions()).toEqual(['chat_room.created']);
    });

    it('needs chat.createGroups (or chat.manage) to create one, and refuses a name already in use', async () => {
      const plain = await person('plain');
      await expect(chat.createRoom({ name: 'Nope' }, plain.actor)).rejects.toThrow(ForbiddenError);

      const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
      await group(asha, [], 'Sales');
      await expect(chat.createRoom({ name: 'sales' }, asha.actor)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('tells a non-member the room does not exist, whatever they ask', async () => {
      const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
      const outsider = await person('outsider');
      const roomId = await group(asha, []);

      await expect(chat.getRoom(roomId, outsider.actor)).rejects.toThrow(NotFoundError);
      await expect(chat.listMessages({ roomId }, outsider.actor)).rejects.toThrow(NotFoundError);
      await expect(chat.postMessage(roomId, { body: 'hi' }, outsider.actor)).rejects.toThrow(NotFoundError);
      await expect(chat.markRead({ roomId, seq: 1 }, outsider.actor)).rejects.toThrow(NotFoundError);
      await expect(chat.setMuted({ roomId, muted: true }, outsider.actor)).rejects.toThrow(NotFoundError);
    });

    it('lets a room admin add, re-role and remove people, audits it, and lets a member leave', async () => {
      const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
      const bina = await person('bina');
      const chetan = await person('chetan');
      const roomId = await group(asha, [bina]);

      await chat.setMember({ roomId, userId: chetan.id, role: 'member' }, asha.actor);
      await chat.setMember({ roomId, userId: bina.id, role: 'admin' }, asha.actor);
      await expect(
        chat.setMember({ roomId, userId: asha.id, role: 'member' }, chetan.actor),
      ).rejects.toThrow(ForbiddenError);

      // Anybody may leave; nobody else's departure is theirs to decide.
      expect(await chat.setMember({ roomId, userId: chetan.id, role: null }, chetan.actor)).toBeNull();
      await chat.setMember({ roomId, userId: bina.id, role: null }, asha.actor);
      await expect(chat.getRoom(roomId, bina.actor)).rejects.toThrow(NotFoundError);

      expect(await activityActions()).toEqual([
        'chat_room.created',
        'chat_room.member_added',
        'chat_room.role_changed',
        'chat_room.member_removed',
      ]);
    });

    it('opens a direct chat once, from either side, and not with yourself', async () => {
      const asha = await person('asha', [...BASIC, 'chat.directMessages']);
      const bina = await person('bina', [...BASIC, 'chat.directMessages']);
      const plain = await person('plain');

      const first = await chat.openDirect({ userId: bina.id }, asha.actor);
      const second = await chat.openDirect({ userId: bina.id }, asha.actor);
      const fromBina = await chat.openDirect({ userId: asha.id }, bina.actor);
      expect(second.id).toBe(first.id);
      expect(fromBina.id).toBe(first.id);
      expect(first.direct?.displayName).toBe('bina');
      expect(fromBina.direct?.displayName).toBe('asha');

      await expect(chat.openDirect({ userId: asha.id }, asha.actor)).rejects.toThrow(ValidationError);
      await expect(chat.openDirect({ userId: bina.id }, plain.actor)).rejects.toThrow(ForbiddenError);
    });
  });

  describe('posting', () => {
    it('numbers messages gap-free under twenty concurrent posts', async () => {
      const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
      const bina = await person('bina');
      const roomId = await group(asha, [bina]);

      const posted = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          chat.postMessage(roomId, { body: `message ${index}` }, index % 2 === 0 ? asha.actor : bina.actor),
        ),
      );
      expect(new Set(posted.map((message) => message.seq)).size).toBe(20);

      const all = await chat.listMessages({ roomId, limit: 100 }, asha.actor);
      expect(all.map((message) => message.seq)).toEqual(Array.from({ length: 21 }, (_, index) => index + 1));
    });

    it('answers a resend with the message it already made', async () => {
      const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
      const roomId = await group(asha, []);

      const first = await chat.postMessage(roomId, { body: 'once', clientId: 'mutation-1' }, asha.actor);
      const again = await chat.postMessage(roomId, { body: 'once', clientId: 'mutation-1' }, asha.actor);
      expect(again.id).toBe(first.id);
      expect(await db()('chat_messages').where({ room_id: roomId, kind: 'text' }).count({ n: '*' })).toEqual([
        { n: '1' },
      ]);
    });

    it('keeps an announcement group to its admins', async () => {
      const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
      const bina = await person('bina');
      const roomId = await group(asha, [bina], 'Notices', true);

      await expect(chat.postMessage(roomId, { body: 'hello' }, bina.actor)).rejects.toMatchObject({
        messageKey: 'validation.chat.announceOnly',
      });
      expect((await chat.postMessage(roomId, { body: 'Closed on Monday' }, asha.actor)).body).toBe('Closed on Monday');
    });

    it('refuses a post in an archived group, and an empty or over-long one', async () => {
      const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
      const roomId = await group(asha, []);

      await expect(chat.postMessage(roomId, { body: '   ' }, asha.actor)).rejects.toMatchObject({
        messageKey: 'validation.chat.bodyRequired',
      });
      await expect(chat.postMessage(roomId, { body: 'x'.repeat(4001) }, asha.actor)).rejects.toMatchObject({
        messageKey: 'validation.chat.bodyTooLong',
      });

      await chat.updateRoom({ roomId, input: { archived: true } }, asha.actor);
      await expect(chat.postMessage(roomId, { body: 'late' }, asha.actor)).rejects.toMatchObject({
        messageKey: 'validation.chat.roomArchived',
      });
      expect(await activityActions()).toEqual(['chat_room.created', 'chat_room.archived']);
    });

    it('refuses every service without chat.use, naming the key', async () => {
      const nobody = await person('nobody', ['leads.view']);
      const roomId = '00000000-0000-0000-0000-000000000000';
      const attempts: Array<Promise<unknown>> = [
        chat.listPeople(nobody.actor),
        chat.listRooms({}, nobody.actor),
        chat.getRoom(roomId, nobody.actor),
        chat.listMessages({ roomId }, nobody.actor),
        chat.postMessage(roomId, { body: 'hi' }, nobody.actor),
        chat.editMessage({ messageId: 'CM0000000001', body: 'x' }, nobody.actor),
        chat.deleteMessage('CM0000000001', nobody.actor),
        chat.pinMessage({ messageId: 'CM0000000001', pinned: true }, nobody.actor),
        chat.setTaskDone({ messageId: 'CM0000000001', done: true }, nobody.actor),
        chat.markRead({ roomId, seq: 1 }, nobody.actor),
        chat.setMuted({ roomId, muted: true }, nobody.actor),
        chat.createRoom({ name: 'x' }, nobody.actor),
        chat.updateRoom({ roomId, input: {} }, nobody.actor),
        chat.setMember({ roomId, userId: nobody.id, role: 'member' }, nobody.actor),
        chat.openDirect({ userId: nobody.id }, nobody.actor),
        chat.search({ q: 'hello' }, nobody.actor),
        chat.listTasks({}, nobody.actor),
        chat.requestAccess({ capability: 'chat.tasks' }, nobody.actor),
      ];
      for (const attempt of attempts) {
        await expect(attempt).rejects.toMatchObject({ code: 'forbidden', details: { permission: 'chat.use' } });
      }
    });
  });

  describe('editing, deleting and pinning', () => {
    it('lets an author change or delete their message for five minutes only', async () => {
      const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
      const roomId = await group(asha, []);
      const message = await chat.postMessage(roomId, { body: 'first draft' }, asha.actor);

      const edited = await chat.editMessage({ messageId: message.id, body: 'second draft' }, asha.actor);
      expect(edited.body).toBe('second draft');
      expect(edited.editedAt).not.toBeNull();

      await agePost(message.id);
      await expect(chat.editMessage({ messageId: message.id, body: 'too late' }, asha.actor)).rejects.toMatchObject({
        messageKey: 'validation.chat.editWindow',
      });

      // A room admin moderating their own old words may still remove them; a plain member may not.
      const bina = await person('bina');
      await chat.setMember({ roomId, userId: bina.id, role: 'member' }, asha.actor);
      const theirs = await chat.postMessage(roomId, { body: 'mine' }, bina.actor);
      await agePost(theirs.id);
      await expect(chat.deleteMessage(theirs.id, bina.actor)).rejects.toMatchObject({
        messageKey: 'validation.chat.editWindow',
      });
    });

    it('keeps a deleted body in the table and never serves it, auditing only a moderator\'s removal', async () => {
      const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
      const bina = await person('bina');
      const roomId = await group(asha, [bina]);

      const own = await chat.postMessage(roomId, { body: 'oops' }, bina.actor);
      const removedByAuthor = await chat.deleteMessage(own.id, bina.actor);
      expect(removedByAuthor).toMatchObject({ body: '', deletedAt: expect.any(String) });
      expect(await activityActions()).toEqual(['chat_room.created']);

      const other = await chat.postMessage(roomId, { body: 'rude words' }, bina.actor);
      await chat.deleteMessage(other.id, asha.actor);
      expect(await activityActions()).toEqual(['chat_room.created', 'chat_message.removed']);

      const row = await db()('chat_messages').where({ id: other.id }).first();
      expect(row.body).toBe('rude words');
      const served = await chat.listMessages({ roomId }, bina.actor);
      expect(served.find((message) => message.id === other.id)).toMatchObject({ body: '', refs: [] });

      // A plain member cannot remove somebody else's.
      const third = await chat.postMessage(roomId, { body: 'fine' }, asha.actor);
      await expect(chat.deleteMessage(third.id, bina.actor)).rejects.toThrow(ForbiddenError);
    });

    it('lets only room admins pin, audits it, and shows the pin on the room', async () => {
      const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
      const bina = await person('bina');
      const roomId = await group(asha, [bina]);
      const message = await chat.postMessage(roomId, { body: 'Rates are fixed' }, bina.actor);

      await expect(chat.pinMessage({ messageId: message.id, pinned: true }, bina.actor)).rejects.toThrow(ForbiddenError);
      const pinned = await chat.pinMessage({ messageId: message.id, pinned: true }, asha.actor);
      expect(pinned.pinnedAt).not.toBeNull();
      expect((await chat.getRoom(roomId, bina.actor)).pinned.map((item) => item.id)).toEqual([message.id]);

      await chat.pinMessage({ messageId: message.id, pinned: false }, asha.actor);
      expect((await chat.getRoom(roomId, bina.actor)).pinned).toEqual([]);
      expect(await activityActions()).toEqual(['chat_room.created', 'chat_message.pinned', 'chat_message.unpinned']);
    });
  });

  describe('tasks, mentions and notifications', () => {
    it('gives a task to room members, lets an assignee tick it and tells the author', async () => {
      const asha = await person('asha', [...BASIC, 'chat.createGroups', 'chat.tasks'], 'management');
      const bina = await person('bina');
      const chetan = await person('chetan');
      const outsider = await person('outsider');
      const roomId = await group(asha, [bina, chetan]);

      await expect(
        chat.postMessage(roomId, { body: 'Dispatch it', task: { assignees: [outsider.id] } }, asha.actor),
      ).rejects.toMatchObject({ messageKey: 'validation.chat.assigneeNotMember' });
      await expect(
        chat.postMessage(roomId, { body: 'Dispatch it', task: { assignees: [bina.id] } }, bina.actor),
      ).rejects.toThrow(ForbiddenError);

      const task = await chat.postMessage(
        roomId,
        { body: 'Dispatch the Morbi order', task: { assignees: [bina.id], dueOn: '2026-11-02' } },
        asha.actor,
      );
      expect(task.task).toMatchObject({ dueOn: '2026-11-02', doneAt: null });
      expect((await notices(bina.id)).map((row) => row.kind)).toEqual(['task.assigned']);
      expect(await notices(chetan.id)).toEqual([]);

      await expect(chat.setTaskDone({ messageId: task.id, done: true }, chetan.actor)).rejects.toThrow(ForbiddenError);
      const done = await chat.setTaskDone({ messageId: task.id, done: true }, bina.actor);
      expect(done.task?.doneBy?.id).toBe(bina.id);
      expect((await notices(asha.id)).map((row) => row.kind)).toEqual(['task.done']);

      const mine = await chat.listTasks({ scope: 'mine', includeDone: true }, bina.actor);
      expect(mine.map((row) => row.message.id)).toEqual([task.id]);
      expect(await chat.listTasks({ scope: 'mine' }, bina.actor)).toEqual([]);
    });

    it('notifies a mention even in a muted room, a task only outside one, and counts both as unread', async () => {
      const asha = await person('asha', [...BASIC, 'chat.createGroups', 'chat.tasks'], 'management');
      const bina = await person('bina');
      const roomId = await group(asha, [bina]);
      await chat.setMuted({ roomId, muted: true }, bina.actor);

      await chat.postMessage(roomId, { body: 'hey @bina', mentions: [bina.id] }, asha.actor);
      await chat.postMessage(roomId, { body: 'for you', task: { assignees: [bina.id] } }, asha.actor);

      expect((await notices(bina.id)).map((row) => row.kind)).toEqual(['chat.mention']);

      const [summary] = await chat.listRooms({}, bina.actor);
      expect(summary).toMatchObject({ muted: true, lastSeq: 3, lastReadSeq: 0, unread: 3, mentionUnread: 1 });

      const read = await chat.markRead({ roomId, seq: 99 }, bina.actor);
      expect(read.lastReadSeq).toBe(3);
      expect((await chat.listRooms({}, bina.actor))[0]).toMatchObject({ unread: 0, mentionUnread: 0 });
    });

    it('lets people ask for a right they lack, once, and tells those who edit roles', async () => {
      const editor = await person('editor', ['chat.use', 'roles.edit'], 'admin');
      const asha = await person('asha');

      expect(await chat.requestAccess({ capability: 'chat.tasks' }, asha.actor)).toEqual({ notified: 1 });
      await chat.requestAccess({ capability: 'chat.tasks' }, asha.actor);
      const rows = await notices(editor.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'access.requested', params: { name: 'asha', capability: 'chat.tasks' } });

      await expect(chat.requestAccess({ capability: 'chat.manage' as never }, asha.actor)).rejects.toThrow(
        ValidationError,
      );
      // Already holding it asks nobody.
      const holder = await person('holder', [...BASIC, 'chat.tasks']);
      expect(await chat.requestAccess({ capability: 'chat.tasks' }, holder.actor)).toEqual({ notified: 0 });
    });
  });

  describe('record chips', () => {
    async function restrictedLead() {
      const party = await catalog.createParty({ name: 'Closed Traders' }, admin);
      const { product, variant } = await createTestProduct(admin, { name: 'Glazed Tile' });
      const lead = await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, variantId: variant.id, quantity: 3, packaging: 'carton' }] },
        admin,
      );
      return { party, lead };
    }

    it('shows the record to a viewer who may open it and "restricted" to one who may not, never naming the party', async () => {
      const { party, lead } = await restrictedLead();
      const insider = await person('insider', SHARER, 'management');
      const outsider = await person('outsider', BASIC);
      await partyAccess.replaceAssignments(
        party.id,
        { entries: [{ userId: insider.id, level: 'manage' }], expectedVersion: party.sync.version },
        admin,
      );
      const roomId = await group(insider, [outsider]);
      // Only the insider's own room membership: the outsider is added by the room creator.
      const posted = await chat.postMessage(roomId, { body: 'Look at this', refs: [{ kind: 'lead', id: lead.id }] }, insider.actor);

      expect(posted.refs[0]).toMatchObject({ kind: 'lead', id: lead.id, restricted: false, partyName: 'Closed Traders' });
      // The chip is labelled as everywhere else (`recordNumber`): the PO number once the lead has one.
      expect(lead.poNumber).toMatch(/^PO\//);
      expect(posted.refs[0]).toMatchObject({ label: lead.poNumber });

      const seenByInsider = await chat.listMessages({ roomId }, insider.actor);
      const seenByOutsider = await chat.listMessages({ roomId }, outsider.actor);
      const chipFor = (messages: ChatMessage[]) => messages.find((message) => message.id === posted.id)?.refs[0];

      expect(chipFor(seenByInsider)).toMatchObject({ restricted: false, partyName: 'Closed Traders' });
      expect(chipFor(seenByOutsider)).toEqual({ kind: 'lead', id: lead.id, label: null, partyName: null, restricted: true });

      // What is stored carries neither a label nor a party.
      const stored = await db()('chat_messages').where({ id: posted.id }).first();
      expect(stored.refs).toEqual([{ kind: 'lead', id: lead.id }]);
    });

    it('refuses a chip the sender cannot open, or without chat.shareRecords, or past five', async () => {
      const { party, lead } = await restrictedLead();
      const insider = await person('insider', SHARER, 'management');
      const stranger = await person('stranger', SHARER, 'management');
      await partyAccess.replaceAssignments(
        party.id,
        { entries: [{ userId: insider.id, level: 'manage' }], expectedVersion: party.sync.version },
        admin,
      );
      const roomId = await group(stranger, []);

      await expect(
        chat.postMessage(roomId, { body: 'x', refs: [{ kind: 'lead', id: lead.id }] }, stranger.actor),
      ).rejects.toMatchObject({ messageKey: 'validation.chat.refNotFound' });

      const noShare = await person('noshare', [...BASIC, 'chat.createGroups'], 'management');
      const ownRoom = await group(noShare, [], 'Mine');
      await expect(
        chat.postMessage(ownRoom, { body: 'x', refs: [{ kind: 'lead', id: lead.id }] }, noShare.actor),
      ).rejects.toThrow(ForbiddenError);

      const refs = Array.from({ length: 6 }, (_, index) => ({ kind: 'order' as const, id: `OD00000000${index}` }));
      await expect(chat.postMessage(roomId, { body: 'x', refs }, stranger.actor)).rejects.toMatchObject({
        messageKey: 'validation.chat.tooManyRefs',
      });
    });

    it('resolves a record made offline through its temporary id, and shares a final order too', async () => {
      const { lead } = await restrictedLead();
      const order = await orders.convertLead({ leadId: lead.id }, admin);
      const sharer = await person('sharer', SHARER, 'management');
      const roomId = await group(sharer, []);

      await db().transaction(async (trx) => {
        await identityRepo.recordIdMapping(
          { tenantId, entity: 'order', temporaryId: 'A3F9K2000000123', permanentId: order.id, deviceCode: 'A3F9K2' },
          trx,
        );
      });
      const posted = await chat.postMessage(
        roomId,
        { body: '', refs: [{ kind: 'order', id: 'A3F9K2000000123' }] },
        sharer.actor,
      );
      expect(posted.refs[0]).toMatchObject({ kind: 'order', id: order.id, restricted: false });
    });
  });

  describe('search and administration', () => {
    it('searches only the rooms the person is in, needs two letters and leaves deleted messages out', async () => {
      const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
      const bina = await person('bina');
      const shared = await group(asha, [bina], 'Shared');
      const closed = await group(asha, [], 'Closed');
      await chat.postMessage(shared, { body: 'the pallet is ready' }, asha.actor);
      await chat.postMessage(closed, { body: 'the pallet is secret' }, asha.actor);
      const gone = await chat.postMessage(shared, { body: 'pallet removed' }, asha.actor);
      await chat.deleteMessage(gone.id, asha.actor);

      const hits = await chat.search({ q: 'pallet' }, bina.actor);
      expect(hits.map((hit) => hit.message.body)).toEqual(['the pallet is ready']);
      expect(await chat.search({ q: 'p' }, bina.actor)).toEqual([]);
      expect(await chat.search({ q: '100%_' }, bina.actor)).toEqual([]);
    });

    it('lets chat.manage see every group and add themselves, but not read until they do', async () => {
      const asha = await person('asha', [...BASIC, 'chat.createGroups'], 'management');
      const boss = await person('boss', [...BASIC, 'chat.manage', 'chat.createGroups'], 'admin');
      const roomId = await group(asha, [], 'Private');
      await chat.postMessage(roomId, { body: 'secret' }, asha.actor);

      expect((await chat.listRooms({ all: true }, boss.actor)).map((room) => room.name)).toEqual(['Private']);
      expect(await chat.listRooms({}, boss.actor)).toEqual([]);
      expect((await chat.getRoom(roomId, boss.actor)).myRole).toBeNull();
      await expect(chat.listMessages({ roomId }, boss.actor)).rejects.toThrow(NotFoundError);

      await chat.setMember({ roomId, userId: boss.id, role: 'member' }, boss.actor);
      expect((await chat.listMessages({ roomId }, boss.actor)).length).toBeGreaterThan(0);
      expect(await activityActions()).toContain('chat_room.member_added');
    });

    it('names a direct chat for the other person and keeps it out of the group list', async () => {
      const asha = await person('asha', [...BASIC, 'chat.directMessages']);
      const bina = await person('bina', [...BASIC, 'chat.directMessages']);
      await chat.openDirect({ userId: bina.id }, asha.actor);
      const boss = await person('boss', [...BASIC, 'chat.manage'], 'admin');

      expect(await chat.listRooms({ all: true }, boss.actor)).toEqual([]);
      expect((await chat.listRooms({}, bina.actor))[0]?.direct?.displayName).toBe('asha');
    });
  });

  describe('the migration\'s grant', () => {
    it('hands office and management roles chat.use and chat.shareRecords, and admin roles all six, once', async () => {
      const officeRole = await roleService.createRole({ name: 'Plain office', tier: 'office', permissions: ['leads.view'] }, admin);
      const managerRole = await roleService.createRole(
        { name: 'Plain manager', tier: 'management', permissions: ['leads.view'] },
        admin,
      );
      const adminRole = await roleService.createRole({ name: 'Plain admin', tier: 'admin', permissions: ['leads.view'] }, admin);

      await chatroomMigration.up(db());
      await chatroomMigration.up(db());

      const stored = async (id: string): Promise<string[]> =>
        ((await db()('roles').where({ id }).first('permissions')).permissions as string[]).filter((key) =>
          key.startsWith('chat.'),
        );
      expect(await stored(officeRole.id)).toEqual(['chat.shareRecords', 'chat.use']);
      expect(await stored(managerRole.id)).toEqual(['chat.shareRecords', 'chat.use']);
      expect(await stored(adminRole.id)).toEqual([
        'chat.createGroups',
        'chat.directMessages',
        'chat.manage',
        'chat.shareRecords',
        'chat.tasks',
        'chat.use',
      ]);
    });
  });

  describe('REST', () => {
    it('guards every route with a session and chat.use, and posts over HTTP', async () => {
      const app = createApp();
      await person('nobody', ['leads.view']);
      await person('asha', [...BASIC, 'chat.createGroups'], 'management');

      await request(app).get('/api/chat/rooms').expect(401);

      const denied = request.agent(app);
      await denied.post('/api/auth/sign-in').send({ username: 'nobody', password: PASSWORD }).expect(200);
      const refused = await denied.get('/api/chat/rooms').expect(403);
      expect(refused.body.details).toMatchObject({ permission: 'chat.use' });

      const agent = request.agent(app);
      await agent.post('/api/auth/sign-in').send({ username: 'asha', password: PASSWORD }).expect(200);
      const created = await agent.post('/api/chat/rooms').send({ name: 'Over HTTP' }).expect(201);
      const posted = await agent
        .post(`/api/chat/rooms/${created.body.id}/messages`)
        .send({ body: 'hello over the wire' })
        .expect(201);
      expect(posted.body).toMatchObject({ body: 'hello over the wire', seq: 2 });

      const page = await agent.get(`/api/chat/rooms/${created.body.id}/messages`).query({ limit: 1 }).expect(200);
      expect(page.body).toHaveLength(1);
      expect(page.body[0].seq).toBe(2);
      const older = await agent.get(`/api/chat/rooms/${created.body.id}/messages`).query({ before: 2 }).expect(200);
      expect(older.body.map((message: ChatMessage) => message.seq)).toEqual([1]);
    });
  });
});
