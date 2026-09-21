/**
 * Explicit migration registry.
 *
 * Knex can discover migrations by scanning a directory, but that requires the
 * runtime to load the files itself — which means the extension has to be `.ts`
 * under tsx, `.js` after a build, and the directory path has to resolve in both
 * layouts. Importing them here instead makes the set of migrations, and their
 * order, a compile-time fact: a migration that is not in this list does not
 * exist, and the bundler/compiler follows the imports like any other code.
 *
 * Add new migrations to the end of the array. Never reorder or edit an entry
 * that has already run on a real installation.
 */

import type { Knex } from 'knex';

import * as initialSchema from './20260101000000_initial_schema.js';
import * as stockMovementNotes from './20260201000000_stock_movement_notes.js';
import * as tenancyAccessAndSync from './20260301000000_tenancy_access_and_sync.js';
import * as leadOrderRebuild from './20260302000000_lead_order_rebuild.js';
import * as rolesAndUsers from './20260303000000_roles_and_users.js';
import * as roleTierCeilingRepair from './20260304000000_role_tier_ceiling_repair.js';
import * as softDeleteColumns from './20260305000000_soft_delete_columns.js';
import * as fieldValuesAndStageOrdering from './20260306000000_field_values_and_stage_ordering.js';
import * as productImagesPipeline from './20260307000000_product_images_pipeline.js';
import * as documentTemplatesAndExports from './20260308000000_document_templates_and_exports.js';
import * as newModulePermissionGrant from './20260309000000_new_module_permission_grant.js';
import * as activityLogActorName from './20260310000000_activity_log_actor_name.js';
import * as storagePermissionGrant from './20260311000000_storage_permission_grant.js';
import * as officePanelAdministration from './20260312000000_office_panel_administration.js';
import * as userAvatars from './20260312000000_user_avatars.js';
import * as panelAppVersion from './20260313000000_panel_app_version.js';
import * as partyAccess from './20260313000000_party_access.js';
import * as settingsAndPasswordVault from './20260314000000_settings_and_password_vault.js';
import * as productTradeAttributes from './20260315000000_product_trade_and_ceramic_attributes.js';
import * as publicApiAndConnectors from './20260316000000_public_api_and_connectors.js';
import * as aiAssistant from './20260317000000_ai_assistant.js';
import * as documentLayoutV2 from './20260318000000_document_layout_v2.js';
import * as productsBulkPermissionGrant from './20260319000000_products_bulk_permission_grant.js';
import * as productVariantCodes from './20260320000000_product_variant_codes.js';
import * as lineItemVariantCodes from './20260321000000_line_item_variant_codes.js';
import * as productColourPolicyAndLineCategory from './20260322000000_product_colour_policy_and_line_category.js';
import * as dropDocumentDesigner from './20260322000000_drop_document_designer.js';
import * as productVariants from './20260323000000_product_variants.js';

export interface Migration {
  name: string;
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

export const migrations: Migration[] = [
  { name: '20260101000000_initial_schema', ...initialSchema },
  { name: '20260201000000_stock_movement_notes', ...stockMovementNotes },
  { name: '20260301000000_tenancy_access_and_sync', ...tenancyAccessAndSync },
  { name: '20260302000000_lead_order_rebuild', ...leadOrderRebuild },
  { name: '20260303000000_roles_and_users', ...rolesAndUsers },
  { name: '20260304000000_role_tier_ceiling_repair', ...roleTierCeilingRepair },
  { name: '20260305000000_soft_delete_columns', ...softDeleteColumns },
  {
    name: '20260306000000_field_values_and_stage_ordering',
    ...fieldValuesAndStageOrdering,
  },
  { name: '20260307000000_product_images_pipeline', ...productImagesPipeline },
  {
    name: '20260308000000_document_templates_and_exports',
    ...documentTemplatesAndExports,
  },
  { name: '20260310000000_activity_log_actor_name', ...activityLogActorName },
  { name: '20260311000000_storage_permission_grant', ...storagePermissionGrant },
  {
    name: '20260312000000_office_panel_administration',
    ...officePanelAdministration,
  },
  { name: '20260312000000_user_avatars', ...userAvatars },
  /*
   * Restored, not new. `dev` ran this before the branches merged, and Knex
   * refuses to start when a *completed* migration is missing from this list —
   * so deleting it locked every pre-merge database out of its own data. Its
   * `up` is a no-op on any database that met `20260312` first. See the file.
   */
  { name: '20260313000000_panel_app_version', ...panelAppVersion },
  // Ascending, and deliberately *before* the reordered `20260309` below: Party
  // Access grants its own two keys rather than relying on that one's frozen
  // list, so there is no ordering dependency between them and no reason to add
  // a second exception to the array's one rule.
  { name: '20260313000000_party_access', ...partyAccess },
  {
    name: '20260314000000_settings_and_password_vault',
    ...settingsAndPasswordVault,
  },
  {
    name: '20260315000000_product_trade_and_ceramic_attributes',
    ...productTradeAttributes,
  },
  {
    name: '20260316000000_public_api_and_connectors',
    ...publicApiAndConnectors,
  },
  {
    name: '20260317000000_ai_assistant',
    ...aiAssistant,
  },
  {
    name: '20260318000000_document_layout_v2',
    ...documentLayoutV2,
  },
  {
    name: '20260319000000_products_bulk_permission_grant',
    ...productsBulkPermissionGrant,
  },
  {
    name: '20260320000000_product_variant_codes',
    ...productVariantCodes,
  },
  {
    name: '20260321000000_line_item_variant_codes',
    ...lineItemVariantCodes,
  },
  // The v1.1.0 line's colour rule and line category snapshot. It has run on
  // installations that took that line, so it stays listed; the variant
  // restructure below supersedes `colour_policy` and drops the column.
  {
    name: '20260322000000_product_colour_policy_and_line_category',
    ...productColourPolicyAndLineCategory,
  },
  // Category -> product model -> variant. Wipes the tile-era product master
  // (owner's decision, 2026-09-19) and re-keys lines and stock by variant.
  {
    name: '20260323000000_product_variants',
    ...productVariants,
  },
  // Stage 7 of `docs/backend-modules/` — pinned after every timestamp above,
  // not last by timestamp. Its `20260309` slot was reserved before
  // `20260310`/`20260311` were claimed by concurrent work; what matters is
  // that it runs after every module whose keys it grants, and array order is
  // what Knex follows here.
  {
    name: '20260309000000_new_module_permission_grant',
    ...newModulePermissionGrant,
  },
  // Drops the PDF Designer's tables and strips its five keys. It has to sit
  // *after* the `20260309` grant, which still hands those keys out (a
  // migration is a frozen fact): on a fresh database the grant would
  // otherwise re-add them the moment this had removed them, and the shipped
  // roles would carry keys the product cannot enforce or display. `20260308`
  // and `20260318` above stay listed: they have run on real installations,
  // and a completed migration missing from this array stops the Master from
  // starting at all.
  {
    name: '20260322000000_drop_document_designer',
    ...dropDocumentDesigner,
  },
];

/** Adapts the registry to the interface Knex's migrator expects. */
export class RegistryMigrationSource implements Knex.MigrationSource<Migration> {
  async getMigrations(): Promise<Migration[]> {
    return migrations;
  }

  getMigrationName(migration: Migration): string {
    return migration.name;
  }

  async getMigration(migration: Migration): Promise<Knex.Migration> {
    return { up: migration.up, down: migration.down };
  }
}
