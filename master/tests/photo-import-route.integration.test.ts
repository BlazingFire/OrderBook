/**
 * The product photo route as the bulk photo import uses it
 * (`master/web/src/screens/PhotoImportScreen.tsx`): a signed-in Master user
 * posts a file with no crop at all, and the whole picture is kept.
 *
 * The browser cannot send a crop rect for a photo it has not decoded, and the
 * size it would decode is not the size sharp sees after EXIF orientation, so
 * "no crop" has to mean "whole frame" on the server. A request naming only
 * part of a crop is still a mistake and still refused.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import { config } from '../src/config/index.js';
import { createApp } from '../src/http/app.js';
import * as catalog from '../src/services/catalog.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let app: Express;
let admin: ActorContext;
let tenantImagesDir: string;

async function agentWith(permissions: string[], username: string) {
  const role = await roleService.createRole({ name: `Role ${username}`, tier: 'management', permissions }, admin);
  await userService.createUser({ username, displayName: username, roleId: role.id, password: 'correct-horse' }, admin);
  const agent = request.agent(app);
  await agent.post('/api/auth/sign-in').send({ username, password: 'correct-horse' }).expect(200);
  return agent;
}

const editor = () => agentWith(['products.view', 'products.edit'], 'kavya');

describe.skipIf(!canRunIntegrationTests)('the bulk photo import upload (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
    const { testTenantId } = await import('./helpers/fixtures.js');
    tenantImagesDir = path.join(config.imagesDir, await testTenantId());
  });
  afterAll(async () => {
    await rm(tenantImagesDir, { recursive: true, force: true });
    await teardownDatabase();
  });
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  it('keeps the whole picture when no crop is sent', async () => {
    const product = await catalog.createProduct(
      { categoryName: 'Basins', variants: [{ code: 'BAS-0001' }], name: 'Oval Basin' },
      admin,
    );
    const photo = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#c08040' } })
      .jpeg()
      .toBuffer();

    const response = await (await editor())
      .post(`/api/products/${product.id}/images`)
      .attach('file', photo, 'BAS-0001.jpg')
      .expect(201);

    expect(response.body.images).toHaveLength(1);
    expect(response.body.images[0]).toMatchObject({ width: 640, height: 480, isPrimary: true });
  });

  it('keeps the whole picture the right way up for a phone photo stored on its side', async () => {
    const product = await catalog.createProduct(
      { categoryName: 'Basins', variants: [{ code: 'BAS-0002' }], name: 'Round Basin' },
      admin,
    );
    // Stored 640×480 with EXIF orientation 6: it shows 480×640. A rect the
    // browser measured the other way round would be refused or cut it.
    const photo = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#4080c0' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const response = await (await editor())
      .post(`/api/products/${product.id}/images`)
      .attach('file', photo, 'BAS-0002.jpg')
      .expect(201);

    expect(response.body.images[0]).toMatchObject({ width: 480, height: 640 });
  });

  it('still refuses a crop with only some of its edges', async () => {
    const product = await catalog.createProduct(
      { categoryName: 'Basins', variants: [{ code: 'BAS-0003' }], name: 'Square Basin' },
      admin,
    );
    const photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } })
      .jpeg()
      .toBuffer();

    await (await editor())
      .post(`/api/products/${product.id}/images`)
      .field('cropX', '0')
      .attach('file', photo, 'BAS-0003.jpg')
      .expect(400);
  });

  it('needs products.edit, as one photo does', async () => {
    const product = await catalog.createProduct(
      { categoryName: 'Basins', variants: [{ code: 'BAS-0004' }], name: 'Corner Basin' },
      admin,
    );
    const photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } })
      .jpeg()
      .toBuffer();

    await (await agentWith(['products.view'], 'ravi'))
      .post(`/api/products/${product.id}/images`)
      .attach('file', photo, 'BAS-0004.jpg')
      .expect(403);
  });
});
