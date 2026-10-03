/**
 * `POST /api/panel/prove`: how a panel that found its Master at a new address
 * checks it is the same Master before sending it the panel secret.
 *
 * The proof is computed here exactly as the Office computes it
 * (`shared/src/protocol/discovery.ts`), from nothing but the secret it holds:
 * a Master that answers anything else would be refused by every panel.
 */

import { createHmac, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MASTER_PROOF_CONTEXT, masterProofMessage } from '@orderbook/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { createApp } from '../src/http/app.js';
import { dumpTable } from '../src/repositories/backup.repository.js';
import * as panels from '../src/services/panel.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setUpFirstRun, setupDatabase, teardownDatabase, testTenantId } from './helpers/fixtures.js';

/** The Office's side of the check, from the panel secret and the address it contacted. */
function officeExpects(panelSecret: string, nonce: string, host = '127.0.0.1', port = masterPort()): string {
  const proofKey = createHmac('sha256', panelSecret).update(MASTER_PROOF_CONTEXT).digest();
  return createHmac('sha256', proofKey).update(masterProofMessage(nonce, host, port)).digest('hex');
}

const freshNonce = (): string => randomBytes(16).toString('hex');

/** A real listener, so the request arrives at a known address and port. */
let app: Server;
const masterPort = (): number => (app.address() as AddressInfo).port;

describe.skipIf(!canRunIntegrationTests)('the Master proof for panel rediscovery (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    app = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => app.once('listening', () => resolve()));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await teardownDatabase();
  });
  beforeEach(async () => {
    await resetData();
    panels.closePairingWindow();
  });

  async function pairOne() {
    await setUpFirstRun();
    panels.openPairingWindow();
    return panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, null);
  }

  it('answers with the proof the Office derives from its own secret', async () => {
    const paired = await pairOne();
    const nonce = freshNonce();

    const response = await request(app)
      .post('/api/panel/prove')
      .send({ panelId: paired.panelId, nonce })
      .expect(200);

    expect(response.body).toEqual({ proof: officeExpects(paired.panelSecret, nonce) });
    // A different nonce, a different proof: nothing an eavesdropper can replay.
    const other = await request(app).post('/api/panel/prove').send({ panelId: paired.panelId, nonce: freshNonce() });
    expect(other.body.proof).not.toBe(response.body.proof);
  });

  it('answers for the address it was reached at, so a relay at another address is refused', async () => {
    const paired = await pairOne();
    const nonce = freshNonce();

    // A device at 192.168.1.99 forwards the Office's nonce here and returns the answer.
    const relayed = await request(app).post('/api/panel/prove').send({ panelId: paired.panelId, nonce }).expect(200);

    expect(relayed.body.proof).not.toBe(officeExpects(paired.panelSecret, nonce, '192.168.1.99', masterPort()));
    expect(relayed.body.proof).toBe(officeExpects(paired.panelSecret, nonce));
  });

  it('is a 404 for a panel paired before the key existed, until it connects once', async () => {
    const paired = await pairOne();
    await db()('office_panels').where({ id: paired.panelId }).update({ master_proof_key: null });
    const nonce = freshNonce();

    await request(app).post('/api/panel/prove').send({ panelId: paired.panelId, nonce }).expect(404);

    // The next connect carries the secret, and the Master keeps the key it derives.
    await panels.authenticatePanel(paired.panelId, paired.panelSecret);
    const response = await request(app).post('/api/panel/prove').send({ panelId: paired.panelId, nonce }).expect(200);
    expect(response.body.proof).toBe(officeExpects(paired.panelSecret, nonce));
  });

  it('is a 404 for a panel it does not know or has revoked, and a 400 for a malformed nonce', async () => {
    const paired = await pairOne();

    await request(app)
      .post('/api/panel/prove')
      .send({ panelId: '00000000-0000-4000-8000-000000000000', nonce: freshNonce() })
      .expect(404);
    await request(app).post('/api/panel/prove').send({ panelId: 'not-a-uuid', nonce: freshNonce() }).expect(404);
    await request(app).post('/api/panel/prove').send({ panelId: paired.panelId, nonce: 'short' }).expect(400);

    await panels.revokePanel(paired.panelId);
    await request(app).post('/api/panel/prove').send({ panelId: paired.panelId, nonce: freshNonce() }).expect(404);
  });

  it('follows a reissued secret', async () => {
    const paired = await pairOne();
    const rotation = await panels.rotatePanelSecret(await testTenantId(), paired.panelId);
    const nonce = freshNonce();

    const response = await request(app).post('/api/panel/prove').send({ panelId: paired.panelId, nonce }).expect(200);

    expect(response.body.proof).toBe(officeExpects(rotation.panelSecret, nonce));
  });

  it('keeps the proof key out of a backup', async () => {
    await pairOne();

    const rows = await dumpTable('office_panels', null, true);

    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('master_proof_key');
    expect(rows[0]).toHaveProperty('secret_hash');
  });
});
