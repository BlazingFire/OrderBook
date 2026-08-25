/**
 * The migration registry guard, landed before the first of five new
 * migrations in `docs/backend-modules/`.
 *
 * `master/src/db/migrations/index.ts` is a hand-maintained array, not a
 * directory scan (its own header explains why). That means a migration file
 * that is written but never added to the array is a silent no-op: nothing
 * turns red, the schema simply is not there, and the first symptom is a query
 * failing against a missing column at runtime — probably on the shop PC. With
 * five files landing across this batch against one hand-maintained array,
 * this is the single most likely way to lose a day.
 *
 * Reads the source, in the `credential-invariants.test.ts` style, rather than
 * importing the registry — importing would prove the array is *syntactically*
 * a list of migrations, not that it matches the directory on disk.
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

function filesOnDisk(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.ts') && file !== 'index.ts')
    .map((file) => file.replace(/\.ts$/, ''))
    .sort();
}

function registrySource(): string {
  return readFileSync(path.join(MIGRATIONS_DIR, 'index.ts'), 'utf8');
}

/** Every `name: '...'` entry in the `migrations` array, in the order written. */
function namesInArray(source: string): string[] {
  const arrayBody = source.slice(source.indexOf('export const migrations'));
  return [...arrayBody.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1] as string);
}

describe('the migration registry matches the directory', () => {
  it('lists every migration file on disk, and nothing else', () => {
    const onDisk = filesOnDisk();
    const listed = namesInArray(registrySource()).sort();

    expect(listed).toEqual(onDisk);
  });

  it('imports every file it lists — a name with no matching import is not really registered', () => {
    const source = registrySource();
    for (const name of namesInArray(source)) {
      expect(source.includes(`./${name}.js`)).toBe(true);
    }
  });

  /**
   * `20260309` was given its slot before `20260310`/`20260311` were claimed by
   * concurrent work, but it grants permissions for keys those modules mint, so
   * it has to run after them. It has already been applied in the last position
   * on a real installation, which is what makes this permanent: renaming the
   * file to restore ascending order would make Knex see an unrun migration and
   * apply it a second time.
   */
  const DELIBERATELY_LAST = ['20260309000000_new_module_permission_grant'];

  it('is in ascending timestamp order — the array is read start to end, and Knex applies in that order', () => {
    const names = namesInArray(registrySource());
    const timestamps = names.filter((name) => !DELIBERATELY_LAST.includes(name)).map((name) => name.slice(0, 14));
    const sorted = [...timestamps].sort();
    expect(timestamps).toEqual(sorted);
  });

  it('keeps the deliberately-reordered migrations pinned to the end, where they have already run', () => {
    const names = namesInArray(registrySource());
    expect(names.slice(-DELIBERATELY_LAST.length)).toEqual(DELIBERATELY_LAST);
  });

  it('every filename on disk starts with a 14-digit timestamp', () => {
    for (const name of filesOnDisk()) {
      expect(name.slice(0, 14)).toMatch(/^\d{14}$/);
    }
  });
});
