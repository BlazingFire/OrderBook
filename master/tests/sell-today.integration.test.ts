/**
 * "Sell today" against a real database (2026-10-08).
 *
 * The rules under test: an entry is a `notices` row of its own kind that the board, its unread
 * count and the notice management list never see; it is read by its audience only, on the board
 * read and in the snapshot, with its products resolved to cards (live ones, and none for a reader
 * without `products.view`); writing needs `notices.manage` and is validated (a headline,
 * something to sell, at most a dozen live products, 0 or 5 to 120 seconds, a window that does not
 * end before it starts); a notice edit cannot touch an entry nor an entry edit a notice; delete
 * and the Recycle Bin work as for a notice; and a change is announced with its audience only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { noticeToday } from '@orderbook/shared';

import { config } from '../src/config/index.js';
import type { ActorContext } from '../src/domain/actor.js';
import { resetChangeRing, since } from '../src/realtime/change-ring.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as noticeService from '../src/services/notice.service.js';
import * as recycleBin from '../src/services/recycle-bin.service.js';
import * as roleService from '../src/services/role.service.js';
import { buildSnapshot } from '../src/services/snapshot.service.js';
import * as userService from '../src/services/user.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  createTestProduct,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';

interface Person {
  actor: ActorContext;
  roleId: string;
}

let admin: ActorContext;

async function person(name: string, permissions: string[], tier: 'office' | 'admin' = 'office'): Promise<Person> {
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
  return { actor, roleId: role.id };
}

const day = (offset: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return noticeToday(date, config.locale.timeZone);
};

describe.skipIf(!canRunIntegrationTests)('"Sell today" (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  let manager: Person;
  let sales: Person;
  let dispatch: Person;
  let blind: Person;
  let damru: string;
  let vitrosa: string;

  beforeEach(async () => {
    await resetData();
    resetChangeRing();
    admin = await testActor();
    manager = await person(
      'manager',
      ['notices.view', 'notices.manage', 'products.view', 'recycleBin.view', 'recycleBin.viewAll'],
      'admin',
    );
    sales = await person('sales', ['notices.view', 'products.view']);
    dispatch = await person('dispatch', ['notices.view', 'products.view']);
    blind = await person('blind', ['notices.view']);
    damru = (await createTestProduct(admin, { name: 'DAMRU', code: 'OPT-0001', size: '600 x 400' }))
      .product.id;
    vitrosa = (await createTestProduct(admin, { name: 'VITROSA 41', code: 'TTB-0041' })).product.id;
  });

  const create = (input: Record<string, unknown>, who: Person = manager) =>
    noticeService.createSellToday({ title: 'Push today', ...input }, who.actor);

  it('ST-1: is on the reader’s board read with its product cards, and never among the notices', async () => {
    await noticeService.createNotice({ title: 'A notice', body: '' }, manager.actor);
    const entry = await create({ body: 'Both ranges', productIds: [vitrosa, damru], autoCloseSeconds: 10 });

    expect(entry).toMatchObject({ autoCloseSeconds: 10, productIds: [vitrosa, damru] });
    const board = await noticeService.listBoard(sales.actor);
    expect(board.notices.map((notice) => notice.title)).toEqual(['A notice']);
    expect(board.unreadCount).toBe(1);
    expect(board.sellToday?.map((each) => each.id)).toEqual([entry.id]);
    expect(board.sellToday?.[0]?.products).toEqual([
      { id: vitrosa, name: 'VITROSA 41', code: 'TTB-0041', size: null, mainProduct: 'Test category', image: null },
      { id: damru, name: 'DAMRU', code: 'OPT-0001', size: '600 x 400', mainProduct: 'Test category', image: null },
    ]);
    // The notice management list is notices only; the entries have their own.
    expect((await noticeService.listManage(manager.actor)).map((n) => n.title)).toEqual(['A notice']);
    expect((await noticeService.listSellTodayManage(manager.actor)).map((e) => e.id)).toEqual([entry.id]);
  });

  it('ST-2: reaches its audience only, on the board and in the snapshot', async () => {
    await create({ productIds: [damru], audience: { kind: 'roles', roleIds: [sales.roleId] } });

    expect((await noticeService.listBoard(sales.actor)).sellToday).toHaveLength(1);
    expect((await noticeService.listBoard(dispatch.actor)).sellToday).toEqual([]);
    expect((await buildSnapshot(sales.actor)).sellToday).toHaveLength(1);
    expect((await buildSnapshot(dispatch.actor)).sellToday).toEqual([]);
    // A reader is told the entry is for their own role, not which others.
    expect((await noticeService.listBoard(sales.actor)).sellToday?.[0]?.audience).toEqual({
      kind: 'roles',
      roleIds: [sales.roleId],
    });
  });

  it('ST-3: carries no product cards to a reader without products.view, and drops a deleted product', async () => {
    const entry = await create({ productIds: [damru, vitrosa] });
    expect((await noticeService.listBoard(blind.actor)).sellToday?.[0]?.products).toEqual([]);

    await catalogService.deleteProduct(vitrosa, admin);
    const [seen] = (await noticeService.listBoard(sales.actor)).sellToday ?? [];
    expect(seen?.productIds).toEqual([damru, vitrosa]);
    expect(seen?.products.map((product) => product.id)).toEqual([damru]);
    expect(entry.id).toBe(seen?.id);
  });

  it('ST-4: an entry that starts later is carried already; an ended one leaves readers but not managers', async () => {
    const later = await create({ productIds: [damru], showFrom: day(1), showUntil: day(2) });
    const ended = await create({ productIds: [damru], showFrom: day(-3), showUntil: day(-1) });

    expect((await noticeService.listBoard(sales.actor)).sellToday?.map((e) => e.id)).toEqual([later.id]);
    const managed = await noticeService.listSellTodayManage(manager.actor);
    expect(managed.find((e) => e.id === ended.id)?.expired).toBe(true);
    expect(managed.find((e) => e.id === later.id)?.expired).toBe(false);
  });

  it('ST-5: refuses what it cannot store, naming the problem', async () => {
    const refused = async (input: Record<string, unknown>, messageKey: string) =>
      expect(noticeService.createSellToday(input, manager.actor)).rejects.toMatchObject({ messageKey });

    await refused({ title: '  ', productIds: [damru] }, 'validation.notice.titleRequired');
    await refused({ title: 'Nothing' }, 'validation.sellToday.nothingToSell');
    await refused({ title: 'Bad', productIds: [damru], autoCloseSeconds: 3 }, 'validation.sellToday.autoCloseInvalid');
    await refused({ title: 'Bad', productIds: [damru], autoCloseSeconds: 121 }, 'validation.sellToday.autoCloseInvalid');
    await refused({ title: 'Bad', productIds: [damru], autoCloseSeconds: 7.5 }, 'validation.sellToday.autoCloseInvalid');
    await refused(
      { title: 'Bad', productIds: [damru], showFrom: day(2), showUntil: day(1) },
      'validation.sellToday.datesReversed',
    );
    await refused({ title: 'Bad', productIds: ['PR-nope'] }, 'validation.sellToday.unknownProduct');
    await refused(
      { title: 'Bad', productIds: Array.from({ length: 13 }, (_, i) => `PR-${i}`) },
      'validation.sellToday.tooManyProducts',
    );
    await refused({ title: 'Bad', productIds: damru }, 'validation.sellToday.malformed');
    await refused({ title: 'Bad', productIds: [damru], autoCloseSeconds: '10' }, 'validation.sellToday.malformed');
    // A message alone is something to sell; 0 means "only when closed".
    await expect(create({ body: 'Clear the old stock', autoCloseSeconds: 0 })).resolves.toMatchObject({
      autoCloseSeconds: 0,
      products: [],
    });
    // Writing is the manager's.
    await expect(create({ productIds: [damru] }, sales)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('ST-6: an edit is checked against what it leaves out, and against the version', async () => {
    const entry = await create({ productIds: [damru], showFrom: day(0), showUntil: day(1) });

    await expect(
      noticeService.updateSellToday(entry.id, { showUntil: day(-1), expectedVersion: entry.version }, manager.actor),
    ).rejects.toMatchObject({ messageKey: 'validation.sellToday.datesReversed' });
    await expect(
      noticeService.updateSellToday(entry.id, { productIds: [], expectedVersion: entry.version }, manager.actor),
    ).rejects.toMatchObject({ messageKey: 'validation.sellToday.nothingToSell' });

    const edited = await noticeService.updateSellToday(
      entry.id,
      { productIds: [vitrosa, damru], autoCloseSeconds: 30, expectedVersion: entry.version },
      manager.actor,
    );
    expect(edited).toMatchObject({ productIds: [vitrosa, damru], autoCloseSeconds: 30, version: entry.version + 1 });
    await expect(
      noticeService.updateSellToday(entry.id, { title: 'Stale', expectedVersion: entry.version }, manager.actor),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('ST-7: a notice edit cannot reach an entry, nor an entry edit a notice', async () => {
    const entry = await create({ productIds: [damru] });
    const notice = await noticeService.createNotice({ title: 'Plain', body: '' }, manager.actor);

    await expect(
      noticeService.updateNotice(entry.id, { pinned: true, expectedVersion: entry.version }, manager.actor),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      noticeService.updateSellToday(notice.id, { title: 'x', expectedVersion: notice.version }, manager.actor),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('ST-8: is deleted like a notice, sits in the Recycle Bin as "Sell today", and comes back', async () => {
    const entry = await create({ productIds: [damru] });

    await noticeService.deleteNotice(entry.id, manager.actor);
    expect((await noticeService.listBoard(sales.actor)).sellToday).toEqual([]);
    const bin = await recycleBin.listBin({ types: ['notice'], limit: 25 } as never, manager.actor);
    expect(bin.items.map((item) => [item.label, item.sublabel])).toEqual([['Push today', 'Sell today']]);

    await recycleBin.restoreEntity({ entityType: 'notice', id: entry.id } as never, manager.actor);
    expect((await noticeService.listBoard(sales.actor)).sellToday?.map((e) => e.id)).toEqual([entry.id]);
  });

  it('ST-9: a change is announced as a notice change with its audience and none of its text', async () => {
    await create({
      title: 'Secret push',
      body: 'Secret text',
      productIds: [damru],
      audience: { kind: 'roles', roleIds: [sales.roleId] },
    });

    const event = (since(0) ?? []).find((entry) => entry.entity === 'notice');
    expect(event).toMatchObject({
      action: 'created',
      payload: { audience: { kind: 'roles', roleIds: [sales.roleId] } },
    });
    expect(JSON.stringify(event)).not.toContain('Secret');
  });
});
