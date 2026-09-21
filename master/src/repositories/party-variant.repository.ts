/**
 * Party-specific product variants — the name and spec agreed with one customer,
 * used when a lead is in `partyWiseMode` (docs/LEAD_GENERATION_FLOW.md §3.1).
 */

import type { PartyProductVariant, PartyProductVariantInput } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import type { PartyScope } from '../domain/party-scope.js';
import { applyPartyScope } from './party-access.repository.js';
import { allocatePermanentId } from './identity.repository.js';
import { mapPartyProductVariant } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'party_product_variants';

type Runner = Knex | Knex.Transaction;

export async function listForParty(
  tenantId: string,
  partyId: string,
  runner: Runner = db(),
): Promise<PartyProductVariant[]> {
  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId, party_id: partyId })
    .orderBy('product_id')
    .select('*');
  return rows.map(mapPartyProductVariant);
}

/**
 * Every variant in the tenant.
 *
 * Goes into the panel's offline snapshot: a panel with no link still has to
 * build a party-wise line, and it cannot ask for one party's variants at that
 * point. The set is small — variants exist only where a price was negotiated.
 */
/**
 * Every variant the caller may see — scoped, because a variant is a negotiated
 * price for one named party and is exactly as private as that party.
 *
 * This one is easy to miss: it feeds the Office Panel's offline snapshot
 * directly rather than through a service, so an unscoped version would leave
 * another party's records sitting on a panel's disk no screen ever asked for.
 */
export async function listAll(
  tenantId: string,
  scope: PartyScope,
  runner: Runner = db(),
): Promise<PartyProductVariant[]> {
  const query = runner(TABLE).where({ tenant_id: tenantId });

  applyPartyScope(query, tenantId, `${TABLE}.party_id`, scope, { level: 'view' });

  const rows = await query.orderBy(['party_id', 'product_id']).select('*');
  return rows.map(mapPartyProductVariant);
}

async function findVariant(
  tenantId: string,
  partyId: string,
  productId: string,
  runner: Runner = db(),
): Promise<PartyProductVariant | null> {
  const row = await runner(TABLE)
    .where({ tenant_id: tenantId, party_id: partyId, product_id: productId })
    .first();
  return row ? mapPartyProductVariant(row) : null;
}

export async function upsertVariant(
  context: { tenantId: string; hlc: string; temporaryId?: string | null },
  input: PartyProductVariantInput,
  trx: TransactionContext,
): Promise<PartyProductVariant> {
  const existing = await findVariant(context.tenantId, input.partyId, input.productId, trx);
  const id = existing?.id ?? (await allocatePermanentId(context.tenantId, 'party_variant', trx));

  const columns = {
    alias: input.alias ?? null,
    size: input.size ?? null,
    weight_kg: input.weightKg ?? null,
    packaging: input.packaging ?? null,
    hlc: context.hlc,
  };

  if (existing) {
    await trx(TABLE)
      .where({ tenant_id: context.tenantId, id })
      .update({ ...columns, version: trx.raw('version + 1'), updated_at: trx.fn.now() });
  } else {
    await trx(TABLE).insert({
      id,
      tenant_id: context.tenantId,
      party_id: input.partyId,
      product_id: input.productId,
      ...columns,
      temporary_id: context.temporaryId ?? null,
    });
  }

  const saved = await findVariant(context.tenantId, input.partyId, input.productId, trx);
  if (!saved) throw new Error('Variant disappeared immediately after upsert');
  return saved;
}
