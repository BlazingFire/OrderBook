/**
 * What `npm run migrate -- --status` prints.
 *
 * The two halves of Knex's `migrate.list()` answer are different shapes:
 * applied entries are rows read back from `knex_migrations` (`{ name }`), and
 * pending entries are whatever the migration source handed Knex — here the
 * registry's own `Migration` objects (`{ name, up, down }`), with no `file`.
 * Reading `file` printed blank names, and one pending migration came out as
 * `Pending: none`: the single wrong answer an operator checking before an
 * update must never be given. The pending entries below are the registry's
 * real objects, the same references `getNewMigrations` passes through.
 */

import { describe, expect, it } from 'vitest';

import { formatMigrationStatus } from '../src/db/migration-status.js';
import { migrations } from '../src/db/migrations/index.js';

const [first, second, third] = migrations as [
  (typeof migrations)[number],
  (typeof migrations)[number],
  (typeof migrations)[number],
];

describe('migrate --status', () => {
  it('names a single pending migration instead of reporting none', () => {
    const [, pending] = formatMigrationStatus([[{ name: first.name }], [second]]);

    expect(pending).toBe(`Pending (1): ${second.name}`);
  });

  it('names every pending migration, in the order they will run', () => {
    const [, pending] = formatMigrationStatus([[], [first, second, third]]);

    expect(pending).toBe(`Pending (3): ${first.name}, ${second.name}, ${third.name}`);
  });

  it('names the applied ones from the rows Knex read back', () => {
    const [applied] = formatMigrationStatus([[{ name: first.name }, { name: second.name }], []]);

    expect(applied).toBe(`Applied (2): ${first.name}, ${second.name}`);
  });

  it('says none only when there is none', () => {
    expect(formatMigrationStatus([[], []])).toEqual(['Applied (0): none', 'Pending (0): none']);
  });
});
