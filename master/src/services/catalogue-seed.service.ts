/**
 * Loading the printed catalogue (`master/assets/catalogue/swisware-plus-2026.md`)
 * into the product master — `docs/catalogue/CATALOGUE_MODEL.md` §4.
 *
 * One loader, two modes, **one transaction** each: an error halfway leaves the
 * master exactly as it was, never half of each.
 *
 * - **Additive** (`replace: false`) — the /api/developer/load-catalogue route (no screen
 *   since 5a32106) and `npm run seed:catalogue`. Nothing is deleted and nothing existing is
 *   changed: a product (category) is found by its code, or by (brand, name),
 *   before one is created; a sub product already live in its product under the
 *   same name is skipped. A second press writes nothing and says so.
 * - **Replacing** (`replace: true`) — `npm run reload:catalog`, with the Master
 *   stopped. The catalogue-dependent data goes first (`clearCatalogueData`),
 *   then the file lands whole.
 *
 * What lands, per §1–§2: the brands and the colour range as option values
 * (added, brought back from the Recycle Bin, printed hex written); each
 * product as a category with its code, brand and catalogue order; each sub
 * product as a model with **exactly one variant**, coded `CODE-0001…` in
 * catalogue order, its rule stored the way `colourRuleOf` reads it back —
 * `fixed` a labelled variant, `dedicated` an unlabelled one, `selectable`
 * the `multiColour` switch. Weights are left blank: the catalogue prints none,
 * and a guessed weight would be worse than the flag a blank one raises.
 *
 * Bulk inserts, not 549 `createProduct` calls: the service path is one
 * transaction and one activity row per product, and the whole point here is
 * one of each. The rules those calls would apply hold by construction — the
 * parser refuses a duplicate name inside a product, and the codes are drawn
 * free below.
 */

import { readFile } from 'node:fs/promises';

import pg from 'pg';
import type { LoadCatalogueResult } from '@orderbook/shared';

import { config } from '../config/index.js';
import type { ActorContext } from '../domain/actor.js';
import {
  parseCatalogueMarkdown,
  type CatalogueSubProduct,
  type ParsedCatalogue,
} from '../domain/catalogue-markdown.js';
import { db } from '../db/knex.js';
import { ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as customFieldRepo from '../repositories/custom-field.repository.js';
import { allocatePermanentIds, nextHlc } from '../repositories/identity.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import { insertVariantRows } from '../repositories/product-variant.repository.js';
import { permissionSetForRole } from '../repositories/role.repository.js';
import * as settingsRepo from '../repositories/settings.repository.js';
import { resolveDefaultTenantId } from '../repositories/tenant.repository.js';
import type { TransactionContext } from '../repositories/transaction.js';
import { publishChange } from './change-bus.js';

const log = createLogger('catalogue-seed');

/**
 * Where a load of the catalogue this build ships is recorded: a settings row no
 * `SETTINGS` definition names, so no screen shows it (as
 * `internal.cataloguePhotosAttached`). The boot load (`loadShippedCatalogue`)
 * writes `state: 'loading'` before it writes anything and `'done'` once it ends;
 * every load of the printed file below writes `loaded: 'markdown'`, which is what
 * lets the boot's photo attach give that catalogue its shipped photos, once.
 */
export const SHIPPED_CATALOGUE_MARKER = 'internal.shippedCatalogueLoaded';

/** The shipped file, parsed — before anything is touched, so a bad file never reaches a delete. */
export async function readCatalogueFile(
  file: string = config.catalogueFile,
): Promise<ParsedCatalogue> {
  return parseCatalogueMarkdown(await readFile(file, 'utf8'));
}

export async function loadCatalogue(
  catalogue: ParsedCatalogue,
  actor: ActorContext,
  options: { replace: boolean },
): Promise<LoadCatalogueResult> {
  const { tenantId } = actor;

  const result = await db().transaction(async (trx) => {
    const removed = options.replace
      ? await clearCatalogueData(tenantId, trx)
      : { removedLeads: 0, removedOrders: 0 };

    const brands = await upsertOptions(
      tenantId,
      'product.brand',
      catalogue.brands.map((brand) => ({ value: brand, hex: null })),
      trx,
    );
    const colours = await upsertOptions(
      tenantId,
      'stock.colour',
      catalogue.colours.map((colour) => ({ value: colour.name, hex: colour.hex })),
      trx,
    );

    // Products: found by code, then (brand, name); created with code, brand and order.
    const liveBefore = new Set(
      await trx('product_categories')
        .where({ tenant_id: tenantId })
        .whereNull('deleted_at')
        .pluck<string[]>('id'),
    );
    const categoryIds = await productRepo.ensureCategories(
      tenantId,
      catalogue.products.map((product, index) => ({
        name: product.name,
        code: product.code,
        brand: product.brand,
        sortOrder: index + 1,
      })),
      trx,
    );
    const products = [...categoryIds.values()].filter((id) => !liveBefore.has(id)).length;

    // Sub products already there, by (category, name) — additive skips them.
    const present = new Set(
      (
        await trx('products')
          .where({ tenant_id: tenantId })
          .whereNull('deleted_at')
          .whereIn('category_id', [...categoryIds.values()])
          .select<Array<{ category_id: string; name: string }>>('category_id', 'name')
      ).map((row) => `${row.category_id}\u0000${row.name.toLowerCase()}`),
    );
    // Every code any variant has carried, Recycle Bin included: a binned sub
    // product must be able to come back without colliding.
    const takenCodes = new Set(
      (await trx('product_variants').where({ tenant_id: tenantId }).pluck<string[]>('code')).map(
        (code) => code.toLowerCase(),
      ),
    );

    const fresh: Array<{
      categoryId: string;
      code: string;
      position: number;
      sub: CatalogueSubProduct;
    }> = [];
    let skipped = 0;

    for (const product of catalogue.products) {
      const categoryId = categoryIds.get(productRepo.categorySeedKey(product)) as string;
      // Past the end of this product's own numbers, for a position whose code
      // somebody else already holds.
      let overflow = product.subProducts.length;

      product.subProducts.forEach((sub, index) => {
        if (present.has(`${categoryId}\u0000${sub.name.toLowerCase()}`)) {
          skipped += 1;
          return;
        }
        let code = productRepo.subProductCode(product.code, index + 1);
        while (takenCodes.has(code.toLowerCase()))
          code = productRepo.subProductCode(product.code, ++overflow);
        takenCodes.add(code.toLowerCase());
        fresh.push({ categoryId, code, position: index + 1, sub });
      });
    }

    if (fresh.length > 0) {
      const hlc = await nextHlc(trx);
      const productIds = await allocatePermanentIds(tenantId, 'product', fresh.length, trx);
      const variantIds = await allocatePermanentIds(tenantId, 'product_variant', fresh.length, trx);

      await productRepo.insertProductRows(
        fresh.map((row, index) => ({
          id: productIds[index] as string,
          categoryId: row.categoryId,
          input: {
            name: row.sub.name,
            categoryId: row.categoryId,
            size: row.sub.size,
            // §2: the rule is not stored, it is what these two and the label say.
            hasVariants: row.sub.rule === 'fixed',
            multiColour: row.sub.rule === 'selectable',
            sortOrder: row.position,
          },
        })),
        { tenantId, hlc },
        trx,
      );
      await insertVariantRows(
        fresh.map((row, index) => ({
          id: variantIds[index] as string,
          productId: productIds[index] as string,
          input: {
            code: row.code,
            label: row.sub.rule === 'fixed' ? row.sub.colour : null,
            weightKg: null,
          },
          sequence: 1,
        })),
        tenantId,
        trx,
      );
    }

    const counts: LoadCatalogueResult = {
      brands,
      colours,
      products,
      subProducts: fresh.length,
      skipped,
      ...removed,
    };

    // The printed catalogue is in, however it was asked for (the boot, the
    // developer route, `seed:catalogue`, the sample data, `reload:catalog`): the
    // next boot's photo attach may give it the shipped photos, once
    // (`catalogue-photos.service.ts`), and the boot load has nothing left to do.
    await settingsRepo.upsertSetting(
      tenantId,
      SHIPPED_CATALOGUE_MARKER,
      { state: 'done', loaded: 'markdown', at: new Date().toISOString() },
      false,
      1,
      null,
      trx,
    );

    // Two literal call sites rather than a ternary `action`, so
    // `i18n-tokens.test.ts` can see that both have a catalogue token.
    if (options.replace) {
      await activityLog.recordActivity(
        {
          tenantId,
          entityType: 'catalog',
          entityId: tenantId,
          action: 'reloaded',
          actorType: actor.actorType,
          actorId: actor.actorId,
          details: { ...counts },
        },
        actor,
        trx,
      );
    } else if (fresh.length > 0) {
      await activityLog.recordActivity(
        {
          tenantId,
          entityType: 'catalog',
          entityId: tenantId,
          action: 'imported',
          actorType: actor.actorType,
          actorId: actor.actorId,
          details: { count: fresh.length, fileName: 'swisware-plus-2026.md' },
        },
        actor,
        trx,
      );
    }

    return counts;
  });

  // Option lists are cached per tenant, and the upsert above wrote around the
  // cache. The CLI exits and the Master it waits for starts empty; the
  // /api/developer/load-catalogue route runs inside the Master, whose cache this is.
  customFieldRepo.invalidateFieldCache(tenantId);

  // One event for the whole load: every panel refetches its catalogue once.
  // From the CLI this reaches its own empty bus — the Master started
  // afterwards mints a new boot id, which is what refreshes the panels then.
  // A press that only brought back a binned brand or colour still announces:
  // `catalog` refreshes the whole snapshot, option lists included.
  if (options.replace || result.subProducts > 0 || result.brands > 0 || result.colours > 0) {
    publishChange({
      entity: 'catalog',
      action: 'updated',
      id: tenantId,
      payload: { created: result.subProducts, updated: 0, skipped: result.skipped, failed: 0 },
    });
  }

  log.info(
    `Catalogue ${options.replace ? 'reloaded' : 'loaded'}: ${result.products} products and ` +
      `${result.subProducts} sub products created, ${result.skipped} already present`,
  );
  return result;
}

/**
 * The shipped file, loaded additively — the /api/developer/load-catalogue route (no screen since 5a32106),
 * `seed:catalogue` and the sample data. As `actor`, or else the installation's
 * first administrator, so the activity log names somebody.
 */
export async function seedCatalogue(
  options: { actor?: ActorContext } = {},
): Promise<LoadCatalogueResult> {
  const catalogue = await readCatalogueFile();
  const actor = options.actor ?? (await administratorActor(await resolveDefaultTenantId()));
  return loadCatalogue(catalogue, actor, { replace: false });
}

/**
 * The other sessions on this database, by application name or address — what
 * `reload:catalog` refuses on. Asked over its own connection, before the CLI
 * opens its pool, so the only session left out is this one.
 *
 * Any client counts, not only a Master: the Master's pool keeps connections
 * open all day, so a running Master always shows here, and anything else
 * writing while a reload deletes leads is just as unwelcome. The CLI signs in
 * as the Master's own role, so every column here is visible to it.
 */
export async function otherDatabaseClients(connectionUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: connectionUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ who: string }>(
      `SELECT coalesce(nullif(application_name, ''), host(client_addr), 'local') AS who
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND backend_type = 'client backend'
          AND pid <> pg_backend_pid()`,
    );
    return rows.map((row) => row.who);
  } finally {
    await client.end();
  }
}

/**
 * The catalogue and everything that quotes it, children before parents:
 * stock and its ledger, reservations, leads and orders (their lines snapshot
 * sub products that stop existing) with their timelines and sync conflicts,
 * party-wise records, photo rows, variants, sub products and products — plus
 * the connectors' links to products, which would otherwise name a record
 * that no longer exists.
 *
 * **Kept:** parties, party access, people, roles, settings, option lists and
 * the activity log. Ids and the `LD…`/`OR…` counters are not reset either, so
 * an old activity row never points at a new record that took its number.
 * Photo files go at the Master's next boot (`sweepOrphanImageVariants`).
 */
async function clearCatalogueData(
  tenantId: string,
  trx: TransactionContext,
): Promise<{ removedLeads: number; removedOrders: number }> {
  const scoped = (table: string) => trx(table).where({ tenant_id: tenantId });

  await scoped('stock_reservations').delete();
  await scoped('stock_movements').delete();
  await scoped('inventory_stock').delete();
  await scoped('line_items').delete();
  await scoped('timeline_entries').delete();
  // A party survives, and so do the conflicts about it.
  await scoped('sync_conflicts')
    .whereIn('entity', ['lead', 'order', 'product', 'party_variant'])
    .delete();

  // Leads and orders point at each other (`converted_order_id`, `lead_id`),
  // so the cycle is broken before either goes.
  await scoped('leads').update({ converted_order_id: null });
  const removedOrders = await scoped('orders').delete();
  const removedLeads = await scoped('leads').delete();

  await scoped('party_product_variants').delete();
  await scoped('product_images').delete();
  await scoped('api_connector_links').where({ entity: 'product' }).delete();
  await scoped('product_variants').delete();
  await scoped('products').delete();
  await scoped('product_categories').delete();

  return { removedLeads, removedOrders };
}

/**
 * Adds the values the catalogue names that the list lacks, gives each its
 * printed hex, and brings back any somebody switched off or binned. Values
 * are matched exactly — `White` and `white` are two stock keys (`20260306`) —
 * and nothing the catalogue does not name is touched. Answers how many were
 * added or brought back.
 *
 * A value in the Recycle Bin is restored, not inserted again beside it: the
 * unique index skips deleted rows, so a second row would go in and split the
 * value's label and history across two ids.
 */
export async function upsertOptions(
  tenantId: string,
  listKey: string,
  values: ReadonlyArray<{ value: string; hex: string | null }>,
  trx: TransactionContext,
): Promise<number> {
  const existing = await customFieldRepo.listOptionsForKey(
    tenantId,
    listKey,
    { includeDeleted: true },
    trx,
  );
  let sequence = Math.max(0, ...existing.map((option) => option.sequence));
  let added = 0;

  for (const { value, hex } of values) {
    const matches = existing.filter((option) => option.value === value);
    // The live row if there is one, else one from the Bin.
    const hit = matches.find((option) => !option.deletedAt) ?? matches[0];
    if (!hit) {
      sequence += 1;
      await customFieldRepo.insertOption(
        { tenantId, listKey, value, label: value, hex, sequence, createdBy: null },
        trx,
      );
      added += 1;
      continue;
    }

    if (hit.deletedAt) await customFieldRepo.restoreOption(tenantId, hit.id, trx);
    if (hit.deletedAt || !hit.isActive) added += 1;
    if (!hit.isActive || (hex !== null && hit.hex !== hex)) {
      await customFieldRepo.updateOptionColumns(
        tenantId,
        hit.id,
        { isActive: true, ...(hex !== null ? { hex } : {}), updatedBy: null },
        trx,
      );
    }
  }

  return added;
}

/**
 * The installation's first live administrator, as an actor carrying that
 * role's permissions. `systemActor` holds none, and a catalogue somebody
 * loaded should read in the activity log as that somebody's work.
 */
export async function administratorActor(tenantId: string): Promise<ActorContext> {
  const row = await db()('users as u')
    .join('roles as r', 'r.id', 'u.role_id')
    .where('u.tenant_id', tenantId)
    .whereNull('u.deleted_at')
    .andWhere('u.is_active', true)
    .whereIn('r.tier', ['admin', 'server_master'])
    .orderBy('u.created_at', 'asc')
    .first<{ id: string; display_name: string; role_id: string } | undefined>(
      'u.id',
      'u.display_name',
      'u.role_id',
    );
  if (!row) throw new ValidationError('validation.developer.administratorRequired');

  return {
    tenantId,
    actorType: 'user',
    actorId: row.id,
    userId: row.id,
    permissions: await permissionSetForRole(tenantId, row.role_id),
    deviceCode: null,
    actorName: row.display_name,
  };
}
