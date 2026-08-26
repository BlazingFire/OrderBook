/**
 * Profile pictures for people (`avatar_*` on `users`).
 *
 * Stored the way product images are: the derived variants live as files under
 * the images directory, keyed by a per-upload id, and the row keeps only what a
 * client needs to render a placeholder and build a URL. Nothing image-shaped
 * goes in Postgres — a shop PC's database should stay small enough to back up
 * over a LAN in one go.
 *
 * `avatar_id` is a plain uuid column rather than a foreign key into
 * `product_images`: an avatar is not a product image, shares none of its
 * gallery semantics (caption, primary flag, sequence), and reusing that table
 * would mean every product-image query had to learn to exclude them.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.uuid('avatar_id').nullable();
    table.text('avatar_blurhash').nullable();
    // Square, so one number describes the stored `full` variant.
    table.integer('avatar_size').nullable();
    table.integer('avatar_byte_size').nullable();
    table.timestamp('avatar_uploaded_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('avatar_id');
    table.dropColumn('avatar_blurhash');
    table.dropColumn('avatar_size');
    table.dropColumn('avatar_byte_size');
    table.dropColumn('avatar_uploaded_at');
  });
}
