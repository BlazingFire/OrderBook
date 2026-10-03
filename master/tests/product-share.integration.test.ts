/**
 * Create product share (1.4 D3, R16) against a real database: who may ask, which
 * products make it onto the sheet, and the route and socket command around it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import { ForbiddenError, ValidationError } from '../src/lib/errors.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as fieldsService from '../src/services/fields.service.js';
import { customFieldLabeler, productSharePdf } from '../src/services/product-share.service.js';

let actor: ActorContext;

function pageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;
}

describe.skipIf(!canRunIntegrationTests)('product share (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  async function makeProducts(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const created = await catalogService.createProduct(
        { name: `Model ${index}`, categoryName: 'Tiles', variants: [{ code: `M-${index}` }] } as never,
        actor,
      );
      ids.push(created.id);
    }
    return ids;
  }

  it('builds a PDF of 3 pages for 9 products, in the order chosen', async () => {
    const ids = await makeProducts(9);
    const { fileName, bytes } = await productSharePdf([...ids].reverse(), actor);
    expect(fileName).toMatch(/^product-share-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(bytes)).toBe(3);
  });

  it('needs products.view, and nothing more', async () => {
    const ids = await makeProducts(1);
    await expect(productSharePdf(ids, await actorWith(['parties.view']))).rejects.toThrow(ForbiddenError);
    const viewer = await actorWith(['products.view']);
    expect((await productSharePdf(ids, viewer)).bytes.length).toBeGreaterThan(0);
  });

  it('skips a product that has gone, and refuses an empty or unknown selection', async () => {
    const ids = await makeProducts(2);
    const mixed = await productSharePdf([ids[0]!, 'PR-GONE', ids[1]!], actor);
    expect(pageCount(mixed.bytes)).toBe(1);

    await expect(productSharePdf([], actor)).rejects.toThrow(ValidationError);
    await expect(productSharePdf(['PR-GONE'], actor)).rejects.toThrow(ValidationError);
    await expect(productSharePdf('PR1' as never, actor)).rejects.toThrow(ValidationError);
  });

  it('names a custom field by its label, not its key', async () => {
    await fieldsService.createDefinition(
      { entity: 'product', key: 'finish_type', label: 'Surface finish', fieldType: 'text' } as never,
      actor,
    );
    const labelOf = await customFieldLabeler(actor.tenantId);
    expect(labelOf('finish_type')).toBe('Surface finish');
    expect(labelOf('never_defined')).toBe('never_defined');
  });

  it('refuses a selection past the cap', async () => {
    const ids = Array.from({ length: 401 }, (_, index) => `PR${index}`);
    await expect(productSharePdf(ids, actor)).rejects.toThrow(ValidationError);
  });
});
