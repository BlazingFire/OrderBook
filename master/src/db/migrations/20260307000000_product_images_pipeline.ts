/**
 * Product image pipeline (`7-IMAGE-PIPELINE.md`, ported for this repo's plain
 * Express/React stack — the source doc assumes an Electron renderer reading
 * files straight off local disk; here every variant is served through a
 * permission-gated HTTP route instead, see `master/src/services/image.service.ts`).
 *
 * `product_images` has existed since `20260101000000_initial_schema` but has
 * never had a single line of application code pointed at it (`HANDOFF.md`:
 * "schema and static route exist, no upload UI") — it is therefore safe to
 * treat as permanently empty and reshape directly, no data migration needed.
 * `file_path` is dropped: a variant's path is now a deterministic function of
 * its id (`<uploadsDir>/images/<tenantId>/<id>/<variant>.webp`), not a stored
 * string. The four new NOT NULL columns need no default for the same reason.
 *
 * `id` deliberately stays a plain UUID rather than joining the `LD`/`PR`/…
 * text-id scheme (`shared/src/sync/ids.ts`): images are uploaded online-only,
 * directly against the Master (like Fields' `option_list_item` rows), never
 * minted offline, so they need no temporary-id promotion path.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE product_images
      DROP COLUMN file_path,
      ADD COLUMN caption    TEXT,
      ADD COLUMN sequence   INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN width      INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN height     INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN checksum   TEXT NOT NULL DEFAULT '',
      ADD COLUMN blurhash   TEXT NOT NULL DEFAULT '',
      ADD COLUMN byte_size  INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE product_images ALTER COLUMN width      DROP DEFAULT;
    ALTER TABLE product_images ALTER COLUMN height     DROP DEFAULT;
    ALTER TABLE product_images ALTER COLUMN checksum   DROP DEFAULT;
    ALTER TABLE product_images ALTER COLUMN blurhash   DROP DEFAULT;
    ALTER TABLE product_images ALTER COLUMN byte_size  DROP DEFAULT;

    CREATE INDEX idx_product_images_product_seq ON product_images(product_id, sequence);
  `);
}

/**
 * Deliberately empty — same reasoning as `20260305`/`20260306`: by the time
 * anyone rolls back, real photo files may already sit on disk under paths
 * this migration's forward half made possible, and there is no `file_path`
 * value to reconstruct for them.
 */
export async function down(_knex: Knex): Promise<void> {
  // no-op
}
