/**
 * The calls the Master's notice screens make (`master/web/src/api.ts`), against the real routes: the
 * paths, the bodies, the answers the views read, and the conflict the editor shows. A screen test with a
 * fake fetch cannot notice that a route moved; this can.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { canRunIntegrationTests } from './helpers/db.js';
import { FIRST_RUN_ACCOUNTS, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { createApp } from '../src/http/app.js';
import { resetRateLimits } from '../src/http/middleware/api-key-rate-limit.js';
import { closePairingWindow } from '../src/services/panel.service.js';
import * as roles from '../src/services/role.service.js';
import * as users from '../src/services/user.service.js';

let app: Express;
const MAIN = FIRST_RUN_ACCOUNTS[0]!;

async function admin() {
  const agent = request.agent(app);
  await agent.post('/api/auth/sign-in').send({ username: MAIN.username, password: MAIN.password }).expect(200);
  return agent;
}

async function reader(username: string, permissions: string[]) {
  const setup = await testActor();
  const role = await roles.createRole({ name: `Role ${username}`, tier: 'office', permissions }, setup);
  await users.createUser({ username, displayName: username, roleId: role.id, password: 'correct-horse' }, setup);
  const agent = request.agent(app);
  await agent.post('/api/auth/sign-in').send({ username, password: 'correct-horse' }).expect(200);
  return { agent, roleId: role.id };
}

describe.skipIf(!canRunIntegrationTests)('the notice screens against the Master (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
  });
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    closePairingWindow();
    resetRateLimits();
    await request(app).post('/api/setup/initialize').send({ companyName: 'Shree Ceramics', accounts: FIRST_RUN_ACCOUNTS }).expect(201);
  });

  it('writes, lists, edits against a version, pins, reads and deletes the way the screens ask', async () => {
    const manager = await admin();
    const { agent: sales, roleId } = await reader('sales', ['notices.view']);

    // The audience picker's roles.
    const audiences = await manager.get('/api/notices/audiences').expect(200);
    expect(audiences.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: roleId, name: 'Role sales' })]));

    // Create: what NoticeManageView sends.
    const created = await manager
      .post('/api/notices')
      .send({ title: 'Closed Friday', body: 'Line one\nLine two', priority: 'important', pinned: false, showUntil: null, audience: { kind: 'roles', roleIds: [roleId] } })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({ title: 'Closed Friday', priority: 'important', version: 1 });

    // The reader's board: the shape NoticeBoardView reads.
    const board = await sales.get('/api/notices').expect(200);
    expect(board.body.unreadCount).toBe(1);
    expect(board.body.notices[0]).toMatchObject({ id, readByMe: false, body: 'Line one\nLine two' });
    await sales.get('/api/notices/manage').expect(403);

    // The manager's list carries role names and counts.
    const listed = await manager.get('/api/notices/manage').expect(200);
    expect(listed.body[0]).toMatchObject({ id, audienceRoleNames: ['Role sales'], readCount: 0 });

    // Pin from the list: the partial update the screen sends, against the version it saw.
    const pinned = await manager.patch(`/api/notices/${id}`).send({ pinned: true, expectedVersion: 1 }).expect(200);
    expect(pinned.body).toMatchObject({ pinned: true, version: 2 });

    // A second edit from the stale version is the conflict the editor shows.
    const stale = await manager.patch(`/api/notices/${id}`).send({ title: 'Too late', expectedVersion: 1 }).expect(409);
    expect(stale.body.error).toBe('conflict');

    // Reading: one id, then everything (no ids), and the count the board shows.
    expect((await sales.post('/api/notices/read').send({ ids: [id] }).expect(200)).body).toEqual({ unreadCount: 0 });
    expect((await sales.post('/api/notices/read').send({}).expect(200)).body).toEqual({ unreadCount: 0 });

    // Who has read it: everybody in the audience, with the time or null.
    const readers = await manager.get(`/api/notices/${id}/readers`).expect(200);
    expect(readers.body.noticeId).toBe(id);
    expect(readers.body.readers).toEqual(expect.arrayContaining([expect.objectContaining({ displayName: 'sales', readAt: expect.any(String) })]));

    // Delete: gone from the board and the list, with the id back.
    expect((await manager.delete(`/api/notices/${id}`).expect(200)).body).toEqual({ id });
    expect((await sales.get('/api/notices').expect(200)).body.notices).toHaveLength(0);
    expect((await manager.get('/api/notices/manage').expect(200)).body).toHaveLength(0);
  });
});
