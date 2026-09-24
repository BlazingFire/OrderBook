/**
 * The HTTP surface an Office Panel's server uses for image bytes.
 *
 * These two routes exist so image traffic stops riding the Socket.IO command
 * channel, whose `maxHttpBufferSize` had to be set by the largest photo anybody
 * might drag in — a per-frame ceiling that applied to every sync push and every
 * command on the connection.
 *
 * What is worth pinning is the authentication, because it is the part that
 * looks finished when it is not. A route that verified only the panel's pairing
 * secret would run uploads as the panel's own fallback role, changing who may
 * upload and putting the machine's name in the audit trail instead of the
 * person's. So a **presented and refused** acting token is a 401, never a
 * silent downgrade.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../src/http/app.js';
import * as panelService from '../src/services/panel.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase } from './helpers/fixtures.js';

let app: Express;

describe.skipIf(!canRunIntegrationTests)('the panel image routes (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
  });
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    panelService.closePairingWindow();
  });

  it('refuses a request carrying no panel credentials at all', async () => {
    const response = await request(app).get('/api/panel/images/whatever/thumb').expect(401);

    // Named, so a panel can tell "you are not paired" from "your person is not
    // signed in" and act on the difference.
    expect(response.body.error).toBe('unauthorized');
  });

  it('refuses a wrong panel secret', async () => {
    await request(app)
      .get('/api/panel/images/whatever/thumb')
      .set('x-orderbook-panel-id', '00000000-0000-4000-8000-000000000000')
      .set('x-orderbook-panel-secret', 'not-the-secret')
      .expect(401);
  });

  it('refuses an upload with no credentials rather than running it as nobody', async () => {
    await request(app)
      .post('/api/panel/products/PR0000000001/images')
      .attach('file', Buffer.from('not-really-an-image'), 'photo.jpg')
      .expect(401);
  });

  it('refuses before the route reads anything — the guard sits in front of the router', async () => {
    // With no file either, the handler's own first check would answer 400: a
    // 401 naming the pairing means `requirePanel` ran before the upload was
    // parsed, not merely that the handler found no actor afterwards.
    const response = await request(app).post('/api/panel/products/PR0000000001/images').expect(401);
    expect(response.body.messageKey).toBe('error.unauthorized.panelCredentialsInvalid');
  });
});
