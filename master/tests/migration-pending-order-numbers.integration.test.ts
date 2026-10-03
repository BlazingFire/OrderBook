/**
 * `20261003000000_pending_order_numbers` — every existing lead back-numbered
 * per financial year, the `po:<fy>` counters set past them, and nothing
 * changed by a second run.
 *
 * Each case makes leads through the service (which numbers them), then takes
 * the numbers and counters away to stand in for a database from before the
 * migration, and runs `up()` itself.
 */

import type { LeadInput } from '@orderbook/shared';
import { financialYearLabel, formatPendingOrderNumber } from '@orderbook/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { up } from '../src/db/migrations/20261003000000_pending_order_numbers.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let actor: ActorContext;
let draft: LeadInput;

/** A lead created at `createdAt`, as a database from before the migration holds it: no number. */
async function oldLead(createdAt: string): Promise<string> {
  const lead = await leads.createLead(draft, actor);
  await db()('leads').where({ id: lead.id }).update({ created_at: createdAt, po_number: null });
  return lead.id;
}

async function numbers(): Promise<Record<string, string | null>> {
  const rows = await db()('leads').select<Array<{ id: string; po_number: string | null }>>('id', 'po_number');
  return Object.fromEntries(rows.map((row) => [row.id, row.po_number]));
}

async function counters(): Promise<Record<string, number>> {
  const rows = await db()('id_sequences')
    .where('entity', 'like', 'po:%')
    .andWhere('tenant_id', actor.tenantId)
    .select<Array<{ entity: string; next_value: string }>>('entity', 'next_value');
  return Object.fromEntries(rows.map((row) => [row.entity, Number(row.next_value)]));
}

describe.skipIf(!canRunIntegrationTests)('pending order numbers migration (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
    const party = await catalog.createParty({ name: 'Numbering Traders' }, actor);
    const product = await catalog.createProduct(
      { categoryName: 'Tiles', variants: [{ code: 'PO-01' }], name: 'Number Tile' },
      actor,
    );
    draft = {
      partyId: party.id,
      items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 1, packaging: 'Box' }],
    };
  });

  it('numbers every lead per financial year in (created_at, id) order, deleted ones too, and seeds the counters', async () => {
    // 31 March 23:59:59 IST, then 1 April 00:00 IST: either side of the turn.
    const lastOfOld = await oldLead('2026-03-31T18:29:59Z');
    const firstOfNew = await oldLead('2026-03-31T18:30:00Z');
    const may = await oldLead('2026-05-01T06:00:00Z');
    const sameInstant = await oldLead('2026-05-01T06:00:00Z');
    const deleted = await oldLead('2026-04-10T06:00:00Z');
    await leads.deleteLead(deleted, actor);
    await db()('id_sequences').where('entity', 'like', 'po:%').delete();

    await up(db());

    expect(await numbers()).toEqual({
      [lastOfOld]: 'PO/2025-26/00001',
      [firstOfNew]: 'PO/2026-27/00001',
      [deleted]: 'PO/2026-27/00002',
      // Created in the same instant: the lower id first.
      [may]: 'PO/2026-27/00003',
      [sameInstant]: 'PO/2026-27/00004',
    });
    expect(await counters()).toEqual({ 'po:2025-26': 2, 'po:2026-27': 5 });
  });

  it('changes nothing when it runs again', async () => {
    await oldLead('2026-03-31T18:29:59Z');
    await oldLead('2026-06-01T06:00:00Z');
    await db()('id_sequences').where('entity', 'like', 'po:%').delete();

    await up(db());
    const once = { numbers: await numbers(), counters: await counters() };
    await up(db());

    expect({ numbers: await numbers(), counters: await counters() }).toEqual(once);
  });

  it('never hands out a number a counter has already passed', async () => {
    const kept = await oldLead('2026-06-01T06:00:00Z');
    const unnumbered = await oldLead('2026-06-02T06:00:00Z');
    await db()('leads').where({ id: kept }).update({ po_number: 'PO/2026-27/00001' });
    // Numbers two to eight went to leads that have since been erased.
    await db()('id_sequences').where('entity', 'like', 'po:%').delete();
    await db()('id_sequences').insert({ tenant_id: actor.tenantId, entity: 'po:2026-27', next_value: 9 });

    await up(db());

    expect((await numbers())[unnumbered]).toBe('PO/2026-27/00009');
    expect((await counters())['po:2026-27']).toBe(10);
  });

  it('lets the next lead continue the series of its own year', async () => {
    await oldLead('2026-03-31T18:29:59Z');
    await oldLead('2026-06-01T06:00:00Z');
    await db()('id_sequences').where('entity', 'like', 'po:%').delete();
    await up(db());
    const before = await counters();

    const next = await leads.createLead(draft, actor);

    const year = financialYearLabel(new Date());
    expect(next.poNumber).toBe(formatPendingOrderNumber(year, before[`po:${year}`] ?? 1));
  });
});
