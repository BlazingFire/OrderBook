/**
 * `product_images.source_checksum`: the sha256 of the bytes a photo was uploaded from.
 *
 * `checksum` hashes the stored `master.webp`, which the upload re-encodes, so it
 * matches only a photo written back as that file (the product backup zip's own
 * export). A jpg or png a person put in the zip hashed to something else on every
 * later read, and the same zip reported it "replaced" and uploaded it again each
 * time. The restore now reads a photo as unchanged when its file hashes to either
 * (`product-zip.service.ts`, `planPhotos`).
 *
 * Additive only (`migration-data-safety.test.ts`): a nullable column, no backfill.
 * A row from before it keeps null; its export is still its master, which `checksum`
 * matches. `down()` drops it — allowed there, never in `up()`.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE product_images ADD COLUMN IF NOT EXISTS source_checksum TEXT NULL');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE product_images DROP COLUMN IF EXISTS source_checksum');
}
