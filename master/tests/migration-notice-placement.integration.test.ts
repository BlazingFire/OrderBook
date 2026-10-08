/**
 * `20261016000000_notice_placement`: a notice already up when the update lands keeps showing on
 * Basic Home and at sign-in (both columns default true), a new row gets the same, and a second
 * run changes nothing. The reading and writing of the columns are exercised by
 * `notices.integration.test.ts` (NB-27, NB-28).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { down, up } from '../src/db/migrations/20261016000000_notice_placement.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testTenantId } from './helpers/fixtures.js';

async function insertNotice(title: string): Promise<string> {
  const [row] = await db()('notices')
    .insert({ tenant_id: await testTenantId(), title })
    .returning<Array<{ id: string }>>('id');
  return (row as { id: string }).id;
}

async function placementOf(id: string): Promise<{ show_on_home: boolean; show_at_sign_in: boolean }> {
  const row = await db()('notices')
    .where({ id })
    .first<{ show_on_home: boolean; show_at_sign_in: boolean }>('show_on_home', 'show_at_sign_in');
  if (!row) throw new Error(`notice ${id} is gone`);
  return row;
}

describe.skipIf(!canRunIntegrationTests)('notice placement columns (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(async () => {
    // Whatever happened above, leave the schema as the other suites expect it.
    await up(db());
    await teardownDatabase();
  });
  beforeEach(resetData);

  it('shows a notice that was already up in both places', async () => {
    // The database as 1.4.6 left it: the table without the two columns, one notice on it.
    await down(db());
    const id = await insertNotice('Up before the update');

    await up(db());

    expect(await placementOf(id)).toEqual({ show_on_home: true, show_at_sign_in: true });
  });

  it('gives a new row both, and runs twice without complaint or change', async () => {
    await up(db());
    await up(db());

    const id = await insertNotice('Written after');
    expect(await placementOf(id)).toEqual({ show_on_home: true, show_at_sign_in: true });

    await db()('notices').where({ id }).update({ show_at_sign_in: false });
    await up(db());
    expect(await placementOf(id)).toEqual({ show_on_home: true, show_at_sign_in: false });
  });
});
