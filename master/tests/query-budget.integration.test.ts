/**
 * How many database queries one ordinary request costs.
 *
 * The expensive thing in this product has never been a slow query — every one
 * of them is a primary-key seek. It is amplification: a helper that quietly
 * issues three queries, called once per HTTP request, once per socket connect,
 * once per recipient socket on a scoped change, and once per admin socket per
 * dashboard flush. Nothing in a profiler makes that visible, so the number is
 * pinned here instead.
 *
 * `GET /api/parties` was **five**: three to resolve the session (the user, the
 * role for its permissions, and the same role again for its version) and two to
 * list (a count and a page). It is now three. The assertion is `<= 3` rather
 * than `<= 2` because the two list queries are real work — a paged list needs a
 * total — and an assertion that cannot pass is worse than no assertion.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../src/http/app.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { FIRST_RUN_ACCOUNTS, resetData, setupDatabase, teardownDatabase } from './helpers/fixtures.js';

let app: Express;

describe.skipIf(!canRunIntegrationTests)('query budget (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
  });
  afterAll(teardownDatabase);
  beforeEach(resetData);

  async function signedIn() {
    await request(app)
      .post('/api/setup/initialize')
      .send({ companyName: 'Query Budget Co', accounts: FIRST_RUN_ACCOUNTS })
      .expect(201);

    // The main Server Master, over supertest — loopback, where one may sign in.
    const main = FIRST_RUN_ACCOUNTS[0]!;
    const agent = request.agent(app);
    await agent
      .post('/api/auth/sign-in')
      .send({ username: main.username, password: main.password })
      .expect(200);

    return agent;
  }

  it('answers GET /api/parties in no more than three queries', async () => {
    const agent = await signedIn();

    const response = await agent.get('/api/parties').expect(200);
    const queries = Number(response.headers['x-query-count']);

    expect(Number.isFinite(queries)).toBe(true);
    expect(queries).toBeLessThanOrEqual(3);
  });

  it('costs the session exactly one query, not three', async () => {
    const agent = await signedIn();

    // `/api/health` is the cheapest authenticated-path request there is: it
    // reads nothing from the database itself, so whatever it costs *is* the
    // session resolution. Before `resolveSessionWithPermissions` this was 3.
    const response = await agent.get('/api/health').expect(200);

    expect(Number(response.headers['x-query-count'])).toBeLessThanOrEqual(1);
  });

  it('reports the count on every response, so a regression is visible', async () => {
    const agent = await signedIn();

    const response = await agent.get('/api/products').expect(200);
    expect(response.headers['x-query-count']).toBeDefined();
    expect(response.headers['x-duration-ms']).toBeDefined();
  });
});
