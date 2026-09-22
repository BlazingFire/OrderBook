/**
 * From 1.2.0 on, an update replaces the software and never the data.
 *
 * The installer already keeps its hands off the data directory. The one thing
 * an update still does to a company's records is run migrations on the next
 * boot — and two of the migrations shipped before 1.2.0 truncate whole tables
 * or drop columns wholesale, by the owner's decision at the time. That was
 * acceptable for a product with no customers. It is not any more.
 *
 * So this pins the line. Every migration named after {@link LAST_DESTRUCTIVE}
 * must be **additive**: it may create tables and columns, add indexes and
 * constraints, backfill values and rewrite functions, but it may not truncate
 * a table, drop a table or a column, or delete rows in `up()`. A change that
 * genuinely needs one of those is a change that needs an owner's decision, a
 * verified backup and a written record first — at which point it is added to
 * {@link EXEMPT} with the reason, and this test says so in the diff.
 *
 * Read from source rather than executed, in the `migration-registry.test.ts`
 * style: the question is what the file *says*, and it should be answered
 * without a database.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'db',
  'migrations',
);

/**
 * The last migration allowed to destroy data. Everything up to and including
 * it shipped before the rule existed; everything after it is held to the rule.
 */
const LAST_DESTRUCTIVE = '20260324000000_product_master_trim';

/**
 * Migrations after {@link LAST_DESTRUCTIVE} that are allowed to destroy data
 * anyway. Adding a name here is a decision, not a fix: it needs the owner's
 * sign-off, a `docs/ai-handoffs/` record naming what is lost and why, and the
 * automatic pre-upgrade copy (`cluster-snapshot.ts`) confirmed working on a
 * real installation. Empty on purpose.
 */
const EXEMPT: readonly string[] = [];

/**
 * What "destroys data" means here. SQL first, then the Knex schema-builder
 * spellings of the same. `DROP INDEX`, `DROP CONSTRAINT`, `DROP FUNCTION` and
 * `DROP TRIGGER` are deliberately not in the list — they change structure, not
 * records.
 */
const DESTRUCTIVE =
  /\b(TRUNCATE|DROP\s+TABLE|DROP\s+COLUMN|DROP\s+SCHEMA|DROP\s+DATABASE|DELETE\s+FROM)\b|\.(dropTable|dropTableIfExists|dropColumn|dropColumns|dropSchema|truncate|del|delete)\s*\(/i;

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.ts') && file !== 'index.ts')
    .map((file) => file.replace(/\.ts$/, ''))
    .sort();
}

/** The body of `up()`, with comments removed so prose about a drop is not a drop. */
function upBody(name: string): string {
  const source = readFileSync(path.join(MIGRATIONS_DIR, `${name}.ts`), 'utf8');
  const start = source.search(/export\s+async\s+function\s+up\b/);
  if (start === -1) throw new Error(`${name} has no exported up()`);
  const rest = source.slice(start);
  const end = rest.search(/export\s+async\s+function\s+down\b/);
  const body = end === -1 ? rest : rest.slice(0, end);
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('migrations after 1.2.0 only add', () => {
  it('pins the line to a migration that exists', () => {
    expect(migrationNames()).toContain(LAST_DESTRUCTIVE);
  });

  it('names no exemption that does not exist', () => {
    for (const name of EXEMPT) expect(migrationNames()).toContain(name);
  });

  it('holds every migration after the line to the rule', () => {
    const held = migrationNames().filter(
      (name) => name > LAST_DESTRUCTIVE && !EXEMPT.includes(name),
    );

    const offenders = held
      .map((name) => ({ name, match: DESTRUCTIVE.exec(upBody(name)) }))
      .filter((entry) => entry.match !== null)
      .map((entry) => `${entry.name}: "${entry.match?.[0]}"`);

    expect(
      offenders,
      [
        'A migration after 1.2.0 destroys data in up(). An update must never lose a customer',
        'record: make the change additive, or read the header of this test for what an',
        'exemption requires.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('would catch the shipped migrations that motivated it', () => {
    // The guard is only worth having if the pattern recognises the real thing.
    expect(DESTRUCTIVE.test(upBody('20260323000000_product_variants'))).toBe(true);
    expect(DESTRUCTIVE.test(upBody(LAST_DESTRUCTIVE))).toBe(true);
  });
});
