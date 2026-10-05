/**
 * Bad numbers, ids and strings in a request are the caller's mistake: 4xx,
 * never a 500 (1.4.3 R18). Each case below came back 500 before.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { canRunIntegrationTests } from './helpers/db.js';
import { FIRST_RUN_ACCOUNTS, resetData, setupDatabase, teardownDatabase } from './helpers/fixtures.js';
import { createApp } from '../src/http/app.js';
import { closePairingWindow } from '../src/services/panel.service.js';

let app: Express;
const MAIN = FIRST_RUN_ACCOUNTS[0]!;

async function signedIn() {
  await request(app)
    .post('/api/setup/initialize')
    .send({ companyName: 'Shree Ceramics', accounts: FIRST_RUN_ACCOUNTS })
    .expect(201);
  const agent = request.agent(app);
  await agent.post('/api/auth/sign-in').send({ username: MAIN.username, password: MAIN.password }).expect(200);
  return agent;
}

describe.skipIf(!canRunIntegrationTests)('bad request input (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
  });
  afterAll(teardownDatabase);
  beforeEach(async () => {
    closePairingWindow();
    await resetData();
  });

  it('BAD-1: a non-numeric or infinite limit/offset is a 400, an absurd one is clamped', async () => {
    const agent = await signedIn();

    for (const query of ['limit=abc', 'offset=abc', 'limit=1e999', 'offset=1.5']) {
      const reply = await agent.get(`/api/leads?${query}`);
      expect(reply.status, query).toBe(400);
      expect(reply.body.messageKey, query).toBe('validation.query.badNumber');
    }
    await agent.get('/api/leads?limit=999999999&offset=-5').expect(200);
    expect((await agent.get('/api/logs?limit=x')).status).toBe(400);
    expect((await agent.get('/api/notifications?limit=x')).status).toBe(400);
  });

  it('BAD-2: a non-numeric conflict id is a 400', async () => {
    const agent = await signedIn();

    const reply = await agent.post('/api/conflicts/abc/resolve').send({ action: 'keepWinner' });

    expect(reply.status).toBe(400);
  });

  it('BAD-3: an id that is not a uuid, and a NUL in a string, reach PostgreSQL and still come back 400', async () => {
    const agent = await signedIn();

    const badId = await agent.get('/api/panels/not-a-uuid/activity');
    expect(badId.status).toBe(400);
    expect(badId.body.messageKey).toBe('validation.request.badInput');

    const nul = await agent.post('/api/parties').send({ name: 'Sharma\u0000Tiles' });
    expect(nul.status).toBe(400);
  });

  it('BAD-4: a malformed percent-escape in a path is a 400, in a query string it is read leniently', async () => {
    const agent = await signedIn();

    for (const path of ['/api/orders/%E0%A4%A', '/api/leads/%', '/api/panels/%E0%A4%A/activity']) {
      const reply = await agent.get(path);
      expect(reply.status, path).toBe(400);
      expect(reply.body.messageKey, path).toBe('validation.request.badInput');
    }
    expect((await agent.get('/api/leads?search=%E0%A4%A')).status).toBe(200);
  });
});
