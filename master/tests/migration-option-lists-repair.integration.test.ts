/**
 * `20260327000000_option_lists_repair` — `option_lists` level on a database
 * that ran the older of `20260306`'s two bodies.
 *
 * The owner's PC database is one: its catalogue reload failed on
 * `column "created_by" of relation "option_lists" does not exist`. The test
 * cluster migrates with the current body, so the old shape is recreated here —
 * no `created_by` / `updated_by`, and a hex check that refuses uppercase — and
 * the repair is run over it.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { up as repairUp } from '../src/db/migrations/20260327000000_option_lists_repair.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testTenantId } from './helpers/fixtures.js';

async function optionListColumns(): Promise<string[]> {
  const rows = await db()('information_schema.columns')
    .where({ table_schema: 'public', table_name: 'option_lists' })
    .select<Array<{ column_name: string }>>('column_name');
  return rows.map((row) => row.column_name);
}

/** `option_lists` as the older `20260306` body left it. */
async function recreateOldShape(): Promise<void> {
  await db().raw(`
    ALTER TABLE option_lists DROP COLUMN created_by, DROP COLUMN updated_by;
    ALTER TABLE option_lists DROP CONSTRAINT option_lists_hex_format;
    ALTER TABLE option_lists
      ADD CONSTRAINT option_lists_hex_format CHECK (hex IS NULL OR hex ~ '^#[0-9a-f]{6}$');
  `);
}

async function insertColour(value: string, hex: string, createdBy?: string): Promise<void> {
  await db()('option_lists').insert({
    id: randomUUID(),
    tenant_id: await testTenantId(),
    list_key: 'stock.colour',
    value,
    label: value,
    sequence: 1,
    is_active: true,
    hex,
    ...(createdBy === undefined ? {} : { created_by: createdBy, updated_by: createdBy }),
  });
}

describe.skipIf(!canRunIntegrationTests)('option_lists repair migration (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  it('OPT-REP-1: a database from the older body gets the columns and the either-case hex check', async () => {
    try {
      await recreateOldShape();
      expect(await optionListColumns()).not.toContain('created_by');
      // What a reload of the SWISWARE colour range met: uppercase hex refused.
      await expect(insertColour('White', '#FEFEFE')).rejects.toThrow(/option_lists_hex_format/);
      // A colour stored under the old check is lowercase, and must survive.
      await insertColour('Ivory', '#fff4de');

      await repairUp(db());
    } finally {
      // Whatever happened above, leave the shared cluster on the head schema.
      await repairUp(db());
    }

    expect(await optionListColumns()).toEqual(expect.arrayContaining(['created_by', 'updated_by']));
    await insertColour('White', '#FEFEFE', 'user-1');
    const rows = await db()('option_lists')
      .where({ list_key: 'stock.colour' })
      .whereIn('value', ['White', 'Ivory'])
      .select('value', 'hex', 'created_by');
    expect(rows).toEqual(
      expect.arrayContaining([
        { value: 'White', hex: '#FEFEFE', created_by: 'user-1' },
        { value: 'Ivory', hex: '#fff4de', created_by: null },
      ]),
    );
  });

  it('OPT-REP-2: on a database that already has the current shape it changes nothing', async () => {
    await repairUp(db());
    await repairUp(db());

    expect(await optionListColumns()).toEqual(
      expect.arrayContaining([
        'hex',
        'created_by',
        'updated_by',
        'deleted_at',
        'deleted_by',
        'version',
        'created_at',
        'updated_at',
      ]),
    );
    await insertColour('Mint Green', '#D1E5B0', 'user-1');
  });
});
