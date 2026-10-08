/**
 * The notice board against a real database (Oct 2026).
 *
 * The rules under test, stated once: a notice is read by its audience (everybody, or the roles
 * named) and nobody else; an expired one leaves the board but stays with the managers; reading
 * is recorded once per person and never reveals a notice the person cannot see; writing needs
 * `notices.manage`; a removed notice comes back from the Recycle Bin; and a change is announced
 * with its audience and nothing of its text.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { noticeToday } from '@orderbook/shared';

import { config } from '../src/config/index.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { resetChangeRing, since } from '../src/realtime/change-ring.js';
import * as logService from '../src/services/log.service.js';
import * as noticeService from '../src/services/notice.service.js';
import * as recycleBin from '../src/services/recycle-bin.service.js';
import * as roleService from '../src/services/role.service.js';
import { buildSnapshot } from '../src/services/snapshot.service.js';
import * as userService from '../src/services/user.service.js';

interface Person {
  actor: ActorContext;
  userId: string;
  roleId: string;
}

let admin: ActorContext;

/** A person holding the keys named, in a role of their own, so the audience can name it. */
async function person(
  name: string,
  permissions: string[],
  tier: 'office' | 'admin' = 'office',
): Promise<Person> {
  // `noticeBoard: false`: the keys named are exactly the keys held (a new role is otherwise given notices.view).
  const role = await roleService.createRole(
    { name: `Role ${name}`, tier, permissions, noticeBoard: false },
    admin,
  );
  const { user } = await userService.createUser(
    { username: name, displayName: name, roleId: role.id },
    admin,
  );
  const actor = await testActor({
    actorId: user.id,
    userId: user.id,
    actorName: name,
    permissions: { roleId: role.id, roleName: role.name, tier, permissions },
  });
  return { actor, userId: user.id, roleId: role.id };
}

/** A calendar day in the company's own time zone, which is the day a notice's last day is read in. */
const day = (offset: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return noticeToday(date, config.locale.timeZone);
};

describe.skipIf(!canRunIntegrationTests)('the notice board (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  let manager: Person;
  let sales: Person;
  let dispatch: Person;

  beforeEach(async () => {
    await resetData();
    resetChangeRing();
    admin = await testActor();
    manager = await person(
      'manager',
      ['notices.view', 'notices.manage', 'recycleBin.view', 'recycleBin.viewAll'],
      'admin',
    );
    sales = await person('sales', ['notices.view']);
    dispatch = await person('dispatch', ['notices.view']);
  });

  const titles = async (who: Person): Promise<string[]> =>
    (await noticeService.listBoard(who.actor)).notices.map((notice) => notice.title);

  describe('audience', () => {
    it('NB-1: a notice for everybody is on every reader’s board', async () => {
      await noticeService.createNotice({ title: 'Holiday', body: 'Closed Monday' }, manager.actor);

      expect(await titles(sales)).toEqual(['Holiday']);
      expect(await titles(dispatch)).toEqual(['Holiday']);
    });

    it('NB-2: a notice for a role is on that role’s board and nobody else’s', async () => {
      await noticeService.createNotice(
        { title: 'Sales target', body: 'x', audience: { kind: 'roles', roleIds: [sales.roleId] } },
        manager.actor,
      );

      expect(await titles(sales)).toEqual(['Sales target']);
      expect(await titles(dispatch)).toEqual([]);
    });

    it('NB-3: the snapshot carries only the reader’s own notices', async () => {
      await noticeService.createNotice({ title: 'For all', body: '' }, manager.actor);
      await noticeService.createNotice(
        { title: 'Sales only', body: '', audience: { kind: 'roles', roleIds: [sales.roleId] } },
        manager.actor,
      );

      const forSales = (await buildSnapshot(sales.actor)).notices
        ?.map((notice) => notice.title)
        .sort();
      const forDispatch = (await buildSnapshot(dispatch.actor)).notices?.map(
        (notice) => notice.title,
      );

      expect(forSales).toEqual(['For all', 'Sales only']);
      expect(forDispatch).toEqual(['For all']);
    });

    it('NB-4: a role that does not exist cannot be an audience', async () => {
      await expect(
        noticeService.createNotice(
          { title: 'x', body: '', audience: { kind: 'roles', roleIds: ['RL0000000000'] } },
          manager.actor,
        ),
      ).rejects.toMatchObject({ messageKey: 'validation.notice.audienceUnknownRole' });
    });
  });

  describe('expiry, priority and pins', () => {
    it('NB-5: a notice past its last day leaves the board but stays with the managers', async () => {
      await noticeService.createNotice(
        { title: 'Old', body: '', showUntil: day(-1) },
        manager.actor,
      );
      await noticeService.createNotice(
        { title: 'Today', body: '', showUntil: day(0) },
        manager.actor,
      );

      expect(await titles(sales)).toEqual(['Today']);

      const all = await noticeService.listManage(manager.actor);
      expect(all.map((notice) => [notice.title, notice.expired]).sort()).toEqual([
        ['Old', true],
        ['Today', false],
      ]);
    });

    it('NB-6: pinned first, then important, then newest', async () => {
      await noticeService.createNotice({ title: 'plain old', body: '' }, manager.actor);
      await noticeService.createNotice(
        { title: 'important', body: '', priority: 'important' },
        manager.actor,
      );
      await noticeService.createNotice({ title: 'pinned', body: '', pinned: true }, manager.actor);
      await noticeService.createNotice({ title: 'plain new', body: '' }, manager.actor);

      expect(await titles(sales)).toEqual(['pinned', 'important', 'plain new', 'plain old']);
    });
  });

  describe('reading', () => {
    it('NB-7: reading is recorded once per person and lowers only their unread count', async () => {
      const a = await noticeService.createNotice({ title: 'A', body: '' }, manager.actor);
      await noticeService.createNotice({ title: 'B', body: '' }, manager.actor);

      expect((await noticeService.listBoard(sales.actor)).unreadCount).toBe(2);

      await noticeService.markRead({ ids: [a.id] }, sales.actor);
      await noticeService.markRead({ ids: [a.id] }, sales.actor);

      const mine = await noticeService.listBoard(sales.actor);
      expect(mine.unreadCount).toBe(1);
      expect(mine.notices.find((notice) => notice.id === a.id)?.readByMe).toBe(true);
      expect((await noticeService.listBoard(dispatch.actor)).unreadCount).toBe(2);
    });

    it('NB-8: marking read with no ids reads the whole board', async () => {
      await noticeService.createNotice({ title: 'A', body: '' }, manager.actor);
      await noticeService.createNotice({ title: 'B', body: '' }, manager.actor);

      expect(await noticeService.markRead({}, sales.actor)).toEqual({ unreadCount: 0 });
    });

    it('NB-9: an id the person cannot see is ignored, and says nothing about it', async () => {
      const hidden = await noticeService.createNotice(
        { title: 'Sales only', body: '', audience: { kind: 'roles', roleIds: [sales.roleId] } },
        manager.actor,
      );

      const answer = await noticeService.markRead(
        { ids: [hidden.id, 'not-a-uuid'] },
        dispatch.actor,
      );

      expect(answer).toEqual({ unreadCount: 0 });
      const rows = await db()('notice_reads').where({ user_id: dispatch.userId });
      expect(rows).toEqual([]);
    });

    it('NB-10: a manager sees who has read it and who has not, and only people in the audience', async () => {
      const notice = await noticeService.createNotice(
        { title: 'Sales only', body: '', audience: { kind: 'roles', roleIds: [sales.roleId] } },
        manager.actor,
      );
      await noticeService.markRead({}, sales.actor);

      const { readers } = await noticeService.getReaders(notice.id, manager.actor);

      expect(readers.map((reader) => [reader.displayName, reader.readAt !== null])).toEqual([
        ['sales', true],
      ]);
      const listed = (await noticeService.listManage(manager.actor)).find(
        (n) => n.id === notice.id,
      );
      expect(listed).toMatchObject({
        readCount: 1,
        audienceSize: 1,
        audienceRoleNames: ['Role sales'],
      });
    });
  });

  describe('permissions', () => {
    it('NB-11: writing, the manage list, readers and audiences need notices.manage', async () => {
      const notice = await noticeService.createNotice({ title: 'x', body: '' }, manager.actor);

      await expect(
        noticeService.createNotice({ title: 'y', body: '' }, sales.actor),
      ).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(
        noticeService.updateNotice(notice.id, { expectedVersion: 1, title: 'z' }, sales.actor),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(noticeService.deleteNotice(notice.id, sales.actor)).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(noticeService.listManage(sales.actor)).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(noticeService.getReaders(notice.id, sales.actor)).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(noticeService.listAudienceRoles(sales.actor)).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('NB-12: reading needs notices.view; without it the snapshot simply has none', async () => {
      await noticeService.createNotice({ title: 'x', body: '' }, manager.actor);
      const blind = await person('blind', ['leads.view']);

      await expect(noticeService.listBoard(blind.actor)).rejects.toMatchObject({ statusCode: 403 });
      await expect(noticeService.markRead({}, blind.actor)).rejects.toMatchObject({
        statusCode: 403,
      });
      expect((await buildSnapshot(blind.actor)).notices).toEqual([]);
    });

    it('NB-13: the audience picker lists the live roles by name', async () => {
      const roles = await noticeService.listAudienceRoles(manager.actor);
      expect(roles.map((role) => role.name)).toEqual(
        expect.arrayContaining(['Role dispatch', 'Role manager', 'Role sales']),
      );
      expect(roles.every((role) => typeof role.id === 'string')).toBe(true);
    });
  });

  describe('writing', () => {
    it('NB-14: refuses a bad title, text, priority, date and an empty audience', async () => {
      const refused = async (input: Record<string, unknown>) =>
        noticeService
          .createNotice({ title: 'ok', body: '', ...input } as never, manager.actor)
          .catch((e) => e);

      expect((await refused({ title: '   ' })).messageKey).toBe('validation.notice.titleRequired');
      expect((await refused({ title: 'x'.repeat(121) })).messageKey).toBe(
        'validation.notice.titleTooLong',
      );
      expect((await refused({ body: 'x'.repeat(4001) })).messageKey).toBe(
        'validation.notice.bodyTooLong',
      );
      expect((await refused({ priority: 'urgent' })).messageKey).toBe(
        'validation.notice.priorityInvalid',
      );
      expect((await refused({ showUntil: '2026-02-31' })).messageKey).toBe(
        'validation.notice.dateInvalid',
      );
      expect((await refused({ audience: { kind: 'roles', roleIds: [] } })).messageKey).toBe(
        'validation.notice.audienceEmpty',
      );
    });

    it('NB-15: an edit made from a stale version is refused, and a good one raises the version', async () => {
      const notice = await noticeService.createNotice({ title: 'v1', body: '' }, manager.actor);

      const edited = await noticeService.updateNotice(
        notice.id,
        { expectedVersion: 1, title: 'v2' },
        manager.actor,
      );
      expect(edited).toMatchObject({ title: 'v2', version: 2 });

      await expect(
        noticeService.updateNotice(notice.id, { expectedVersion: 1, title: 'v3' }, manager.actor),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('NB-16: an edit may change the audience, and the old audience stops seeing it', async () => {
      const notice = await noticeService.createNotice(
        { title: 'Moves', body: '', audience: { kind: 'roles', roleIds: [sales.roleId] } },
        manager.actor,
      );

      await noticeService.updateNotice(
        notice.id,
        { expectedVersion: 1, audience: { kind: 'roles', roleIds: [dispatch.roleId] } },
        manager.actor,
      );

      expect(await titles(sales)).toEqual([]);
      expect(await titles(dispatch)).toEqual(['Moves']);
    });

    it('NB-17: ids that are not notice ids are not found, not database errors', async () => {
      await expect(noticeService.deleteNotice('nope', manager.actor)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(noticeService.getReaders('nope', manager.actor)).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });

  describe('removal and the Recycle Bin', () => {
    it('NB-18: a removed notice leaves every board, is in the Bin, and comes back from it', async () => {
      const notice = await noticeService.createNotice({ title: 'Gone', body: '' }, manager.actor);

      await noticeService.deleteNotice(notice.id, manager.actor);
      expect(await titles(sales)).toEqual([]);
      expect((await noticeService.listManage(manager.actor)).map((n) => n.id)).toEqual([]);

      const bin = await recycleBin.listBin(
        { types: ['notice'], limit: 25 } as never,
        manager.actor,
      );
      expect(bin.items.map((entry) => [entry.entityType, entry.label])).toEqual([
        ['notice', 'Gone'],
      ]);

      await recycleBin.restoreEntity(
        { entityType: 'notice', id: notice.id } as never,
        manager.actor,
      );
      expect(await titles(sales)).toEqual(['Gone']);
    });

    it('NB-19: somebody without notices.manage cannot restore one', async () => {
      const notice = await noticeService.createNotice({ title: 'Gone', body: '' }, manager.actor);
      await noticeService.deleteNotice(notice.id, manager.actor);

      await expect(
        recycleBin.restoreEntity({ entityType: 'notice', id: notice.id } as never, sales.actor),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe('change events', () => {
    it('NB-20: a change is announced with its audience and none of its text', async () => {
      await noticeService.createNotice(
        {
          title: 'Secret title',
          body: 'Secret text',
          audience: { kind: 'roles', roleIds: [sales.roleId] },
        },
        manager.actor,
      );

      const event = (since(0) ?? []).find((entry) => entry.entity === 'notice');
      expect(event).toMatchObject({
        action: 'created',
        payload: { audience: { kind: 'roles', roleIds: [sales.roleId] } },
      });
      expect(JSON.stringify(event)).not.toContain('Secret');
    });

    it('NB-21: an edit that moves the audience is announced to the old and the new one', async () => {
      const notice = await noticeService.createNotice(
        { title: 'Moves', body: '', audience: { kind: 'roles', roleIds: [sales.roleId] } },
        manager.actor,
      );
      resetChangeRing();

      await noticeService.updateNotice(
        notice.id,
        { expectedVersion: 1, audience: { kind: 'roles', roleIds: [dispatch.roleId] } },
        manager.actor,
      );

      const event = (since(0) ?? []).find((entry) => entry.entity === 'notice');
      const roleIds = (
        event?.payload as { audience: { roleIds: string[] } }
      ).audience.roleIds.sort();
      expect(roleIds).toEqual([sales.roleId, dispatch.roleId].sort());
    });
  });

  describe('rework: the log, malformed input, the audience a reader sees, new roles', () => {
    it('NB-22: the Activity log hides notice rows from everybody who cannot manage notices', async () => {
      const auditor = await person('auditor', ['logs.view', 'notices.view']);
      const notice = await noticeService.createNotice(
        {
          title: 'Secret restructure',
          body: '',
          audience: { kind: 'roles', roleIds: [sales.roleId] },
        },
        manager.actor,
      );
      await noticeService.updateNotice(
        notice.id,
        { expectedVersion: 1, pinned: true },
        manager.actor,
      );

      const seenBy = async (who: Person) =>
        (await logService.listLogs({ entityType: 'notice' } as never, who.actor)).items.length;

      expect(await seenBy(auditor)).toBe(0);
      expect(
        JSON.stringify((await logService.listLogs({} as never, auditor.actor)).items),
      ).not.toContain('Secret restructure');

      const managerWithLogs = await person(
        'managerlogs',
        ['logs.view', 'notices.view', 'notices.manage'],
        'admin',
      );
      expect(await seenBy(managerWithLogs)).toBeGreaterThan(0);
    });

    it('NB-23: malformed input is a 400 on create and on edit, never a 500, and never stored as something else', async () => {
      const notice = await noticeService.createNotice({ title: 'ok', body: '' }, manager.actor);
      const malformed = [
        { title: { a: 1 } },
        { title: 5 },
        { title: 'x', body: ['x'] },
        { title: 'x', pinned: 'yes' },
        { title: 'x', audience: { kind: 'roles' } },
        { title: 'x', audience: { kind: 'roles', roleIds: [5] } },
        { title: 'x', audience: { kind: 'everyone-else' } },
        { title: 'x', audience: 'all' },
        { title: 'x', showUntil: 20261031 },
      ];

      for (const body of malformed) {
        await expect(
          noticeService.createNotice(body, manager.actor),
          JSON.stringify(body),
        ).rejects.toMatchObject({
          statusCode: 400,
          messageKey: 'validation.notice.malformed',
        });
        await expect(
          noticeService.updateNotice(notice.id, { expectedVersion: 1, ...body }, manager.actor),
          JSON.stringify(body),
        ).rejects.toMatchObject({ statusCode: 400, messageKey: 'validation.notice.malformed' });
      }
      await expect(noticeService.createNotice(null, manager.actor)).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(noticeService.createNotice([1], manager.actor)).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(
        noticeService.updateNotice(notice.id, { expectedVersion: '1' }, manager.actor),
      ).rejects.toMatchObject({ statusCode: 400 });

      // Nothing got stored by the refused ones: one notice, untouched.
      const all = await noticeService.listManage(manager.actor);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ title: 'ok', version: 1, audience: { kind: 'all' } });
    });

    it('NB-24: a reader is told only whether a notice is for everybody or for their own role', async () => {
      await noticeService.createNotice(
        {
          title: 'Two roles',
          body: '',
          audience: { kind: 'roles', roleIds: [sales.roleId, dispatch.roleId] },
        },
        manager.actor,
      );

      const forSales = (await noticeService.listBoard(sales.actor)).notices[0];
      expect(forSales?.audience).toEqual({ kind: 'roles', roleIds: [sales.roleId] });
      const snapshotCopy = (await buildSnapshot(dispatch.actor)).notices?.[0];
      expect(snapshotCopy?.audience).toEqual({ kind: 'roles', roleIds: [dispatch.roleId] });
      expect(JSON.stringify(forSales)).not.toContain(dispatch.roleId);

      const forManager = (await noticeService.listManage(manager.actor))[0];
      expect(forManager?.audience).toEqual({
        kind: 'roles',
        roleIds: expect.arrayContaining([sales.roleId, dispatch.roleId]),
      });
    });

    it('NB-26: a panel acting as itself reads only the notices for everybody, and cannot record a read', async () => {
      await noticeService.createNotice({ title: 'For all', body: '' }, manager.actor);
      await noticeService.createNotice(
        { title: 'Sales only', body: '', audience: { kind: 'roles', roleIds: [sales.roleId] } },
        manager.actor,
      );
      // The panel's own actor: the sales role's permissions, nobody signed in.
      const panel: ActorContext = {
        ...sales.actor,
        actorType: 'office_panel',
        actorId: 'OP1',
        userId: null,
      };

      expect((await noticeService.listBoard(panel)).notices.map((n) => n.title)).toEqual([
        'For all',
      ]);
      expect((await buildSnapshot(panel)).notices?.map((n) => n.title)).toEqual(['For all']);
      await expect(noticeService.markRead({}, panel)).rejects.toMatchObject({
        statusCode: 409,
        messageKey: 'error.conflict.noNoticeReader',
      });
    });

    it('NB-25: a role made later reads the board by default, unless the caller says otherwise', async () => {
      const made = await roleService.createRole(
        { name: 'Later', tier: 'office', permissions: ['leads.view'] },
        admin,
      );
      expect(made.permissions).toEqual(['leads.view', 'notices.view']);

      const without = await roleService.createRole(
        { name: 'No board', tier: 'office', permissions: ['leads.view'], noticeBoard: false },
        admin,
      );
      expect(without.permissions).toEqual(['leads.view']);

      // Editing a role never gives it back what an administrator took away.
      const edited = await roleService.updateRole(
        made.id,
        {
          name: 'Later',
          tier: 'office',
          permissions: ['leads.view'],
          expectedVersion: made.sync.version,
        },
        admin,
      );
      expect(edited.permissions).toEqual(['leads.view']);
    });
  });

  describe('placement: Basic Home and sign-in (2026-10-08)', () => {
    it('NB-27: a notice shows in both places unless told otherwise, and the reader and snapshot say where', async () => {
      await noticeService.createNotice({ title: 'Both', body: '' }, manager.actor);
      await noticeService.createNotice(
        { title: 'Home only', body: '', showAtSignIn: false },
        manager.actor,
      );
      await noticeService.createNotice(
        { title: 'Sign-in only', body: '', showOnHome: false },
        manager.actor,
      );

      const placed = (notices: Array<{ title: string; showOnHome?: boolean; showAtSignIn?: boolean }>) =>
        Object.fromEntries(
          notices.map((notice) => [notice.title, [notice.showOnHome, notice.showAtSignIn]]),
        );
      const expected = {
        Both: [true, true],
        'Home only': [true, false],
        'Sign-in only': [false, true],
      };
      expect(placed((await noticeService.listBoard(sales.actor)).notices)).toEqual(expected);
      expect(placed((await buildSnapshot(sales.actor)).notices ?? [])).toEqual(expected);
      expect(placed(await noticeService.listManage(manager.actor))).toEqual(expected);
    });

    it('NB-28: refuses a notice shown in neither place, on create and on an edit that sends one alone', async () => {
      await expect(
        noticeService.createNotice(
          { title: 'Nowhere', body: '', showOnHome: false, showAtSignIn: false },
          manager.actor,
        ),
      ).rejects.toMatchObject({ statusCode: 400, messageKey: 'validation.notice.placementEmpty' });

      const notice = await noticeService.createNotice(
        { title: 'Home only', body: '', showAtSignIn: false },
        manager.actor,
      );
      // Only the other one is sent: with the stored one already off, that is neither.
      await expect(
        noticeService.updateNotice(notice.id, { expectedVersion: 1, showOnHome: false }, manager.actor),
      ).rejects.toMatchObject({ statusCode: 400, messageKey: 'validation.notice.placementEmpty' });
      await expect(
        noticeService.updateNotice(notice.id, { expectedVersion: 1, showOnHome: 'no' }, manager.actor),
      ).rejects.toMatchObject({ statusCode: 400, messageKey: 'validation.notice.malformed' });

      // Swapping both in one edit is fine.
      const swapped = await noticeService.updateNotice(
        notice.id,
        { expectedVersion: 1, showOnHome: false, showAtSignIn: true },
        manager.actor,
      );
      expect(swapped).toMatchObject({ showOnHome: false, showAtSignIn: true, version: 2 });
    });
  });
});
