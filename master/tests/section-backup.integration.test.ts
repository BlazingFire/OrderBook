/**
 * The Backup and Restore buttons of Products, Orders and Parties: what was deleted or changed
 * since comes back exactly, a second restore changes nothing, nothing outside the file is
 * touched, a preview writes nothing, and another Master's file never overwrites by id.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The company a set-up Master has; these tests never run first-time setup.
vi.mock('../src/services/setup.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getIdentity: async () => ({ companyName: 'Test Co', masterUniqueId: 'm-1', tenantId: actor.tenantId }),
}));

import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

import { config } from '../src/config/index.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { createZipWriter, openZipReader } from '../src/lib/archive-zip.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import { exportSection, restoreSection } from '../src/services/section-backup.service.js';
import { startJob } from '../src/services/backup-job.js';

let actor: ActorContext;

describe.skipIf(!canRunIntegrationTests)('section backup and restore (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  async function catalogue() {
    const main = await catalog.createCategory({ code: 'PAN', name: 'ORISSA PAN' }, actor);
    const first = await catalog.createProduct(
      { categoryId: main.id, code: 'PAN-0001', name: '20" PAN', colours: ['White', 'Ivory'], weightKg: 9.5, printSide: 'left' },
      actor,
    );
    const second = await catalog.createProduct({ categoryId: main.id, code: 'PAN-0002', name: 'CITYPAN' }, actor);
    return { main, first, second };
  }

  /** The same backup as another Master's file: another company, its ids its own. */
  async function asOtherMaster(file: string): Promise<string> {
    const reader = await openZipReader(file);
    const manifest = JSON.parse(await reader.readText('manifest.json', 1e6)) as Record<string, unknown>;
    const data = (await reader.readText('data.json', 1e8)).replaceAll('PR0000', 'PR9000').replaceAll('PC0000', 'PC9000').replaceAll('PT0000', 'PT9000');
    reader.close();
    const out = path.join(os.tmpdir(), `other-${randomUUID()}.zip`);
    const writer = createZipWriter(out);
    await writer.appendEntry('manifest.json', [JSON.stringify({ ...manifest, tenantId: randomUUID() })]);
    await writer.appendEntry('data.json', [data]);
    await writer.finalize();
    return out;
  }

  it('puts products back: changed, binned and photos, and then has nothing to do', async () => {
    const { main, first, second } = await catalogue();
    const imageId = randomUUID();
    const folder = path.join(config.imagesDir, actor.tenantId, imageId);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'master.webp'), 'photo');
    await db()('product_images').insert({
      id: imageId, tenant_id: actor.tenantId, product_id: first.id, is_primary: true, sequence: 0,
      width: 1, height: 1, checksum: 'c1', blurhash: 'b', byte_size: 5,
    });
    const backup = await exportSection('products', actor);
    expect(backup.fileName).toMatch(/^OrderBook-Products-.+\.zip$/);

    await catalog.updateProduct(first.id, { weightKg: 1, colours: ['Pink'] }, actor);
    await catalog.deleteProduct(second.id, actor);
    await db()('product_images').where({ id: imageId }).delete();
    await fs.rm(folder, { recursive: true });
    const extra = await catalog.createProduct({ categoryId: main.id, code: 'PAN-0009', name: 'NEW' }, actor);

    const preview = await restoreSection('products', backup.path, false, actor);
    expect(preview).toMatchObject({ added: 0, changed: 2, unchanged: 1, photos: 1, skipped: [], sameCompany: true });
    expect((await catalog.getProduct(first.id, actor)).weightKg).toBe(1);

    await restoreSection('products', backup.path, true, actor);
    const back = await catalog.getProduct(first.id, actor);
    expect(back).toMatchObject({ weightKg: 9.5, colours: ['White', 'Ivory'], code: 'PAN-0001' });
    expect(back.sync.version).toBeGreaterThan(2);
    expect((await catalog.getProduct(second.id, actor)).code).toBe('PAN-0002');
    expect((await catalog.getProduct(extra.id, actor)).name).toBe('NEW');
    expect(await fs.readFile(path.join(folder, 'master.webp'), 'utf8')).toBe('photo');

    expect(await restoreSection('products', backup.path, false, actor)).toMatchObject({ added: 0, changed: 0, photos: 0, unchanged: 3 });
    expect((await fs.readdir(path.join(config.dataDir, 'backups'))).some((name) => name.startsWith('pre-section-restore-'))).toBe(true);
    // The next code and id are new ones.
    const next = await catalog.createProduct({ categoryId: main.id, name: 'AFTER' }, actor);
    expect(next.code).toBe('PAN-0010');
  });

  it("matches another Master's products by code and gives new ones its own ids", async () => {
    const { first, second } = await catalogue();
    const other = await asOtherMaster((await exportSection('products', actor)).path);
    expect(await restoreSection('products', other, false, actor)).toMatchObject({ sameCompany: false, added: 0, changed: 0, unchanged: 3 });

    await catalog.deleteProduct(second.id, actor);
    await catalog.updateProduct(first.id, { weightKg: 1 }, actor);
    expect(await restoreSection('products', other, true, actor)).toMatchObject({ added: 1, changed: 1 });
    expect((await catalog.getProduct(first.id, actor)).weightKg).toBe(9.5);
    const row = await db()('products').where({ code: 'PAN-0002' }).whereNull('deleted_at').first('id');
    expect(row?.id).not.toBe(second.id);
    expect(String(row?.id)).not.toMatch(/^PR9/);
  });

  it('puts parties back with their own codes, and matches another Master by name and phone', async () => {
    const party = await catalog.createParty({ name: 'Nakoda', phone: '1', city: 'Surat' }, actor);
    const backup = await exportSection('parties', actor);
    const other = await asOtherMaster(backup.path);
    await catalog.updateParty(party.id, { city: 'Bhuj' }, actor);
    expect(await restoreSection('parties', backup.path, true, actor)).toMatchObject({ added: 0, changed: 1 });
    expect(await catalog.getParty(party.id, actor)).toMatchObject({ city: 'Surat', partyCode: party.partyCode });
    expect(await restoreSection('parties', other, true, actor)).toMatchObject({ added: 0, changed: 0, unchanged: 1 });
    await catalog.deleteParty(party.id, actor);
    expect(await restoreSection('parties', other, true, actor)).toMatchObject({ added: 1 });
    const made = await db()('parties').where({ name: 'Nakoda' }).whereNull('deleted_at').first('id', 'party_code', 'created_by_user_id');
    expect(made?.created_by_user_id).toBeNull();
    expect(made?.id).not.toBe(party.id);
    expect(made?.party_code).not.toBe(party.partyCode);
  });

  it('puts orders back with their numbers, lines and history, and never reuses a number', async () => {
    const { first } = await catalogue();
    const party = await catalog.createParty({ name: 'Nakoda' }, actor);
    const line = { productId: first.id, quantity: 3, colour: 'Ivory', packaging: 'Box', grade: 'A' };
    const open = await leads.createLead({ partyId: party.id, items: [line] }, actor);
    const won = await leads.createLead({ partyId: party.id, items: [line] }, actor);
    const order = await orders.convertLead({ leadId: won.id }, actor);
    const backup = await exportSection('orders', actor);

    await leads.updateLead(open.id, { items: [{ ...line, quantity: 9 }] }, actor);
    // Gone for good, as Start fresh leaves them.
    await db()('leads').where({ id: won.id }).update({ converted_order_id: null });
    await db()('orders').where({ id: order.id }).delete();
    await db()('leads').where({ id: won.id }).delete();
    await db()('line_items').whereIn('parent_id', [won.id, order.id]).delete();

    expect(await restoreSection('orders', backup.path, false, actor)).toMatchObject({ added: 2, changed: 1, skipped: [] });
    await restoreSection('orders', backup.path, true, actor);
    expect((await leads.getLead(open.id, actor)).items[0]?.quantity).toBe(3);
    expect(await leads.getLead(won.id, actor)).toMatchObject({ poNumber: won.poNumber, convertedOrderId: order.id });
    expect((await orders.getOrder(order.id, actor)).items).toMatchObject([{ colour: 'Ivory', quantity: 3, grade: 'A' }]);
    expect(await restoreSection('orders', backup.path, false, actor)).toMatchObject({ added: 0, changed: 0, unchanged: 3 });

    const next = await leads.createLead({ partyId: party.id, items: [line] }, actor);
    expect([open.poNumber, won.poNumber]).not.toContain(next.poNumber);
  });

  it('leaves out an order whose party is gone, and says which section to restore first', async () => {
    const { first } = await catalogue();
    const party = await catalog.createParty({ name: 'Nakoda' }, actor);
    const lead = await leads.createLead({ partyId: party.id, items: [{ productId: first.id, quantity: 1 }] }, actor);
    const backup = await exportSection('orders', actor);
    await leads.deleteLead(lead.id, actor);
    await catalog.deleteParty(party.id, actor);
    expect(await restoreSection('orders', backup.path, true, actor)).toMatchObject({
      added: 0, changed: 0, skipped: [{ label: lead.poNumber, reason: 'parties' }],
    });
  });

  it('refuses the wrong file, a person without the permission, and a Master busy with a backup', async () => {
    await catalogue();
    const products = (await exportSection('products', actor)).path;
    await expect(restoreSection('parties', products, true, actor)).rejects.toMatchObject({ messageKey: 'validation.sectionBackup.otherSection' });
    const orderFile = await asOtherMaster((await exportSection('orders', actor)).path);
    await expect(restoreSection('orders', orderFile, true, actor)).rejects.toMatchObject({ messageKey: 'validation.sectionBackup.otherCompany' });
    const junk = path.join(os.tmpdir(), `junk-${randomUUID()}.zip`);
    await fs.writeFile(junk, 'not a zip');
    await expect(restoreSection('products', junk, true, actor)).rejects.toMatchObject({ messageKey: 'validation.sectionBackup.notABackup' });
    const clerk = await actorWith(['products.view', 'parties.view', 'orders.view']);
    await expect(exportSection('products', clerk)).rejects.toThrow();
    await expect(restoreSection('products', products, true, clerk)).rejects.toThrow();

    let finish = (): void => undefined;
    const { finished } = startJob('backup', () => new Promise<void>((resolve) => { finish = resolve; }));
    await expect(restoreSection('products', products, true, actor)).rejects.toThrow();
    finish();
    await finished;
  });
});
