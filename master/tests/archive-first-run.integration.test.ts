/**
 * Magic restore: a blank Master, as on a new PC, restores a backup-everything
 * zip from the first-run screen's routes (`setup.routes.ts`), and afterwards
 * people sign in as before and the Office panels stay paired.
 *
 * The blank Master is made with the developer reset, which drops the schema
 * and re-migrates, so the role and stage ids `fixtures.ts` captured at
 * `setupDatabase()` are stale afterwards. Nothing here runs `resetData()` past
 * that point, and the next file's `setupDatabase()` captures afresh, as in
 * `developer.integration.test.ts`.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { BackupJobStatus } from '@orderbook/shared';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../src/config/index.js';
import { db } from '../src/db/knex.js';
import { createApp } from '../src/http/app.js';
import * as panelRepo from '../src/repositories/office-panel.repository.js';
import { exportArchive } from '../src/services/archive-export.service.js';
import * as catalog from '../src/services/catalog.service.js';
import { resetAllData } from '../src/services/developer.service.js';
import { isSetupComplete } from '../src/services/setup.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setUpFirstRun, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

/** Poll the first-run job route, as the screen does, until the job ends. */
async function waitForJob(app: Express, id: string): Promise<BackupJobStatus> {
  for (let tries = 0; tries < 600; tries += 1) {
    const { body } = await request(app).get('/api/setup/archive/job').expect(200);
    const job = body as BackupJobStatus | null;
    if (job?.id === id && job.finishedAt) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The restore did not finish in a minute');
}

describe.skipIf(!canRunIntegrationTests)('Magic restore at first run (integration)', () => {
  let app: Express;
  let folder: string;
  let avatar: string;

  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
    await resetData();
    folder = await mkdtemp(path.join(os.tmpdir(), 'ob-archive-first-run-'));
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
    if (avatar) await rm(avatar, { force: true });
    await teardownDatabase();
  });

  it('restores a backup onto a blank Master; sign-in and the pairing work as before', async () => {
    const setup = await setUpFirstRun('Magic Ceramics');
    const actor = await testActor();
    await catalog.createParty({ name: 'Magic Traders' }, actor);

    const panelId = randomUUID();
    await panelRepo.insertPanel({
      id: panelId,
      tenant_id: actor.tenantId,
      name: 'Front desk',
      device_code: 'A',
      secret_hash: 'scrypt$kept-as-is',
      master_proof_key: 'proof-key-kept-as-is',
      lan_ip: '192.168.1.20',
      status: 'active',
      paired_at: new Date(),
    });

    avatar = path.join(config.imagesDir, actor.tenantId, 'avatars', `magic-${Date.now()}.webp`);
    const avatarBytes = randomBytes(900);
    await mkdir(path.dirname(avatar), { recursive: true });
    await writeFile(avatar, avatarBytes);

    const identityBefore = await db()('master_config')
      .first<{ master_unique_id: string; pairing_password_hash: string }>('master_unique_id', 'pairing_password_hash');
    const exported = await exportArchive({ folder, actor });

    // The new PC: nothing set up, no photos.
    await resetAllData();
    expect(await isSetupComplete()).toBe(false);

    const preview = await request(app).post('/api/setup/archive/preview').send({ path: exported.path }).expect(200);
    expect(preview.body).toMatchObject({ company: 'Magic Ceramics', counts: { parties: 1 } });

    const started = await request(app).post('/api/setup/archive/restore').send({ path: exported.path }).expect(202);
    expect(started.body).toMatchObject({ kind: 'restore' });
    const job = await waitForJob(app, started.body.id as string);
    expect(job).toMatchObject({ phase: 'done' });

    // Set up, under the old name, and the main Server Master signs in as before.
    const status = await request(app).get('/api/setup/status').expect(200);
    expect(status.body).toMatchObject({ setupComplete: true, companyName: 'Magic Ceramics' });
    const agent = request.agent(app);
    await agent.post('/api/auth/sign-in').send({ username: setup.username, password: setup.password }).expect(200);
    const parties = await agent.get('/api/parties').expect(200);
    expect(JSON.stringify(parties.body)).toContain('Magic Traders');

    // Paired as before: the same Master identity, pairing password and panel proof key.
    const identityAfter = await db()('master_config')
      .first<{ master_unique_id: string; pairing_password_hash: string }>('master_unique_id', 'pairing_password_hash');
    expect(identityAfter).toEqual(identityBefore);
    expect(await db()('office_panels').where({ id: panelId }).first()).toMatchObject({
      status: 'active',
      secret_hash: 'scrypt$kept-as-is',
      master_proof_key: 'proof-key-kept-as-is',
    });
    expect(await readFile(avatar)).toEqual(avatarBytes);

    // A second Magic restore is refused now that this Master is set up.
    const again = await request(app).post('/api/setup/archive/restore').send({ path: exported.path }).expect(409);
    expect(again.body.messageKey).toBe('error.conflict.alreadySetUp');
  });
});
