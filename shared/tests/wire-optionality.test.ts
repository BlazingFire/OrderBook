/**
 * A field added to a type that crosses the Master/Office boundary must be
 * optional.
 *
 * This product is rolled out by copying installers between PCs by hand
 * (`docs/TESTING_PLAN.md`), so a Master and a panel on different versions is the
 * *normal* state of a shop mid-update, not an edge case. Nothing on that
 * boundary validates a payload's shape: `office/src/http/app.ts` forwards
 * Master answers straight into `res.json(...)`, and `office/web/src/api.ts`
 * casts the result. So a field the sending Master does not know about arrives
 * as `undefined` regardless of what the type says.
 *
 * `d52bdef` added four **required** fields to a type the (since removed)
 * assistant screen read. A 1.0.2 Master sent a truthy object without them, the
 * screen rendered and read `.length` off `undefined` — and because
 * `ui/src/ErrorBoundary.tsx` is mounted app-wide, that did not degrade one tab,
 * it replaced the **entire Office panel** with the crash screen.
 *
 * `SyncSnapshot` already applies the rule to `partyGrants`, `bootId`, `seq` and
 * `serverVersion`, each with a comment saying why — and comments are what the
 * last agent read past, which is why this is a test.
 *
 * ## The shape of the check
 *
 * Source text, not types: `tsc` cannot tell a field that was always required
 * from one added last week, and that distinction is the whole rule. Each guarded
 * type below pins the fields a 1.0.2 sender is known to have populated. Anything
 * else in the interface must carry a `?`.
 *
 * **Adding a name to a `sinceAlways` list is not the way to make this pass.**
 * Those lists describe what older installations already send; they are history,
 * and history does not gain entries. A new field gets a `?`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Guarded {
  file: string;
  type: string;
  /** Fields a pre-1.0.3 sender already populated, so they may stay required. */
  sinceAlways: string[];
}

const GUARDED: Guarded[] = [
  {
    file: 'src/protocol/socket.ts',
    type: 'SyncSnapshot',
    sinceAlways: [
      'parties',
      'products',
      'categories',
      'partyVariants',
      'leads',
      'orders',
      'stock',
      'pipelines',
      'optionLists',
      'customFields',
      'conflicts',
      'dashboard',
      'permissions',
      'serverHlc',
      'serverTime',
    ],
  },
  {
    /*
     * `CompanyFeatures` crosses the boundary twice — inside
     * `SyncSnapshot.features` and inside `SignedInUser.features` — and neither
     * crossing validates anything: the Office forwards the Master's answer and
     * the browser casts it.
     *
     * Guarded from the day it held one field, so the next switch cannot be
     * declared required by hand and argued about afterwards. `freeToSell` is
     * genuine history: it is what a 1.0.2 Master already sends.
     */
    file: 'src/domain/entities.ts',
    type: 'CompanyFeatures',
    sinceAlways: ['freeToSell'],
  },
];

/** The property names an interface declares, and whether each is optional. */
function fieldsOf(source: string, typeName: string): Array<{ name: string; optional: boolean }> {
  const start = source.search(new RegExp(`export interface ${typeName}\\s*\\{`));
  if (start < 0) return [];

  const open = source.indexOf('{', start);
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return [];

  const body = source
    .slice(open + 1, close)
    // Comments carry `?` and `:` of their own.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  return [...body.matchAll(/^\s*(\w+)(\??)\s*:/gm)].map((match) => ({
    name: match[1]!,
    optional: match[2] === '?',
  }));
}

describe('types crossing the Master/Office boundary', () => {
  for (const guard of GUARDED) {
    const source = readFileSync(path.join(HERE, '..', guard.file), 'utf8');
    const fields = fieldsOf(source, guard.type);

    it(`${guard.type}: the interface was found and has fields`, () => {
      // Without this a rename turns the whole check into a silent pass.
      expect(fields.length).toBeGreaterThan(0);
    });

    it(`${guard.type}: every field beyond the 1.0.2 core is optional`, () => {
      const required = fields
        .filter((field) => !field.optional && !guard.sinceAlways.includes(field.name))
        .map((field) => field.name);

      expect(required).toEqual([]);
    });

    it(`${guard.type}: every pinned field still exists`, () => {
      // The other direction: if a `sinceAlways` name is gone, the list is stale
      // and is quietly widening what the check permits.
      const names = new Set(fields.map((field) => field.name));
      expect(guard.sinceAlways.filter((name) => !names.has(name))).toEqual([]);
    });
  }

  it('the field scanner is not fooled by a comment containing a colon', () => {
    const sample = `export interface Example {
  /** Live free memory, in GB: read once. */
  a: number;
  b?: string;
}`;
    expect(fieldsOf(sample, 'Example')).toEqual([
      { name: 'a', optional: false },
      { name: 'b', optional: true },
    ]);
  });
});
