/**
 * Load the Swisware catalogue into the product master.
 *
 * Everything goes through the ordinary catalogue service, as an
 * administrator: what lands is exactly what a person typing the catalogue in
 * would have produced — categories, models, variants, activity entries — and
 * nothing bypasses a rule. Weights are left blank on purpose
 * (`swisware-catalogue.ts` explains why) and show up flagged until entered.
 *
 * Idempotent by model: a model whose codes are all already live is skipped,
 * so a second press changes nothing and reports what it left alone. A model
 * some of whose codes exist is skipped too, rather than half-created — the
 * administrator has been editing it, and the catalogue must not undo that.
 */

import type { LoadCatalogueResult } from '@orderbook/shared';

import type { ActorContext } from '../domain/actor.js';
import { catalogueTotals, SWISWARE_CATALOGUE, SWISWARE_COLOURS } from '../domain/swisware-catalogue.js';
import { db } from '../db/knex.js';
import { ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { ensureCategories } from '../repositories/product.repository.js';
import { findLiveVariantsByCodes } from '../repositories/product-variant.repository.js';
import { permissionSetForRole } from '../repositories/role.repository.js';
import { resolveDefaultTenantId } from '../repositories/tenant.repository.js';
import * as catalog from './catalog.service.js';
import { publishChange } from './change-bus.js';
import * as fields from './fields.service.js';

const log = createLogger('catalogue-seed');

export interface SeedCatalogueOptions {
  /** Who the catalogue is entered as. Defaults to the installation's first administrator. */
  actor?: ActorContext;
}

export async function seedCatalogue(options: SeedCatalogueOptions = {}): Promise<LoadCatalogueResult> {
  const tenantId = options.actor?.tenantId ?? (await resolveDefaultTenantId());
  const actor = options.actor ?? (await administratorActor(tenantId));

  const result: LoadCatalogueResult = { categories: 0, products: 0, variants: 0, skipped: 0 };

  // The variant palette, so the swatch beside a colour has a hex to draw.
  const existingColours = new Set(
    (await fields.listOptionListsUnguarded(tenantId))
      .filter((item) => item.listKey === 'stock.colour')
      .map((item) => item.value.trim().toLowerCase()),
  );
  for (const colour of SWISWARE_COLOURS) {
    if (existingColours.has(colour.value.toLowerCase())) continue;
    await fields.createValue(
      { listKey: 'stock.colour', value: colour.value, label: colour.value, hex: colour.hex },
      actor,
    );
  }

  // Categories in one pass, then the models — each a product create.
  const before = new Set((await catalog.listCategories(actor)).map((category) => category.name.toLowerCase()));
  await db().transaction((trx) =>
    ensureCategories(
      tenantId,
      SWISWARE_CATALOGUE.map((category) => category.name),
      trx,
    ),
  );
  result.categories = SWISWARE_CATALOGUE.filter((category) => !before.has(category.name.toLowerCase())).length;

  const live = await findLiveVariantsByCodes(
    tenantId,
    SWISWARE_CATALOGUE.flatMap((category) =>
      category.models.flatMap((model) => model.variants.map((variant) => variant.code)),
    ),
  );

  for (const category of SWISWARE_CATALOGUE) {
    for (const model of category.models) {
      const present = model.variants.some((variant) => live.has(variant.code.toLowerCase()));
      if (present) {
        result.skipped += 1;
        continue;
      }

      await catalog.createProduct(
        {
          name: model.name,
          categoryName: category.name,
          size: model.size ?? null,
          multiColour: model.multiColour ?? category.multiColour ?? false,
          hasVariants: model.variants.length > 1 || model.variants[0]?.label !== null,
          variants: model.variants.map((variant, index) => ({
            code: variant.code,
            label: variant.label,
            weightKg: null,
            sequence: index + 1,
          })),
        },
        actor,
      );
      result.products += 1;
      result.variants += model.variants.length;
    }
  }

  if (result.products > 0) {
    await db().transaction((trx) =>
      activityLog.recordActivity(
        {
          tenantId,
          entityType: 'catalog',
          entityId: tenantId,
          action: 'imported',
          actorType: actor.actorType,
          actorId: actor.actorId,
          details: { count: result.products, fileName: 'Swisware catalogue' },
        },
        actor,
        trx,
      ),
    );
    publishChange({
      entity: 'catalog',
      action: 'updated',
      id: tenantId,
      payload: { created: result.products, updated: 0, skipped: result.skipped, failed: 0 },
    });
  }

  const totals = catalogueTotals();
  log.info(
    `Swisware catalogue: ${result.products} of ${totals.products} models loaded (${result.variants} variants), ${result.skipped} already present`,
  );

  return result;
}

/**
 * The installation's first live administrator, as an actor carrying that
 * role's permissions. `systemActor` holds none, so it cannot create a
 * product; and a catalogue somebody loaded should read in the activity log
 * as that somebody's work.
 */
async function administratorActor(tenantId: string): Promise<ActorContext> {
  const row = await db()('users as u')
    .join('roles as r', 'r.id', 'u.role_id')
    .where('u.tenant_id', tenantId)
    .whereNull('u.deleted_at')
    .andWhere('u.is_active', true)
    .andWhere('r.tier', 'admin')
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
