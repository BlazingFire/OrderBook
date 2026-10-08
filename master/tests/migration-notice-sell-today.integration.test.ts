/**
 * `20261018000000_notice_sell_today`: every notice already up stays a notice (kind `notice`, no
 * products, no auto-close, no first day), a second run changes nothing, and the constraints keep
 * out a kind or an auto-close the Master would never write. Reading and writing the columns is
 * `sell-today.integration.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { down, up } from '../src/db/migrations/20261018000000_notice_sell_today.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testTenantId } from './helpers/fixtures.js';

async function insertNotice(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db()('notices')
    .insert({ tenant_id: await testTenantId(), title, ...extra })
    .returning<Array<{ id: string }>>('id');
  return (row as { id: string }).id;
}

async function columnsOf(id: string) {
  const row = await db()('notices')
    .where({ id })
    .first('kind', 'product_ids', 'auto_close_seconds', db().raw('show_from::text AS show_from'));
  if (!row) throw new Error(`notice ${id} is gone`);
  return row as { kind: string; product_ids: unknown; auto_close_seconds: number | null; show_from: string | null };
}

describe.skipIf(!canRunIntegrationTests)('"Sell today" columns (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(async () => {
    // Whatever happened above, leave the schema as the other suites expect it.
    await up(db());
    await teardownDatabase();
  });
  beforeEach(resetData);

  it('keeps a notice that was already up a notice', async () => {
    // The table as the previous release left it, one notice on it.
    await down(db());
    const id = await insertNotice('Up before the update');

    await up(db());

    expect(await columnsOf(id)).toEqual({
      kind: 'notice',
      product_ids: [],
      auto_close_seconds: null,
      show_from: null,
    });
  });

  it('runs twice without complaint or change, and keeps out what the Master never writes', async () => {
    await up(db());
    await up(db());

    const id = await insertNotice('Entry', {
      kind: 'sellToday',
      product_ids: JSON.stringify(['PR-1']),
      auto_close_seconds: 15,
      show_from: '2026-10-08',
    });
    await up(db());
    expect(await columnsOf(id)).toEqual({
      kind: 'sellToday',
      product_ids: ['PR-1'],
      auto_close_seconds: 15,
      show_from: '2026-10-08',
    });

    await expect(insertNotice('Odd kind', { kind: 'banner' })).rejects.toThrow(/notices_kind/);
    await expect(insertNotice('Too quick', { auto_close_seconds: 3 })).rejects.toThrow(/notices_auto_close/);
    await expect(insertNotice('Not a list', { product_ids: JSON.stringify({ id: 'PR-1' }) })).rejects.toThrow(
      /notices_product_ids/,
    );
  });
});
