/**
 * The Party Access screen exists twice, and must stay identical.
 *
 * The shared components now live in `@orderbook/ui`, but each panel still
 * owns its own `api` client and the two differ — Office's writes queue into
 * an outbox and return a `QueuedResult`, the Master's do not. A *screen* that
 * imports `{ api, ApiError }` therefore cannot move into the package, so this
 * one is shared between the panels by being duplicated. That is survivable;
 * what is not is the copies quietly diverging, because the next edit then
 * lands on one of them and nobody notices until a person on the other panel
 * reports that a control is missing.
 *
 * This is not hypothetical. Within a day of Party Access landing, the two
 * files had already drifted in four places — an export button on one side
 * only, an `ApiError` getter that existed on one client, and two comment
 * blocks each explaining the divergence to the other. The divergences were
 * removed by giving the Office panel the missing export route and the missing
 * getter; this test is what keeps them removed.
 *
 * Reads the source rather than importing it, in the style of
 * `credential-invariants.test.ts` — importing would prove the two modules
 * export the same names, not that the files are the same file.
 *
 * **When this fails**, do not edit one side to match. Work out which copy has
 * the change you wanted, copy that file over the other, and make sure whatever
 * the other panel needed to support it (a route, a client wrapper) exists on
 * both sides.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const COPIES = [
  path.join(REPO_ROOT, 'master', 'web', 'src', 'screens', 'PartyAccessScreen.tsx'),
  path.join(REPO_ROOT, 'office', 'web', 'src', 'screens', 'PartyAccessScreen.tsx'),
];

/**
 * Line endings are normalised before comparing. Git is configured to check
 * these files out with CRLF on Windows, and a difference nobody typed is not
 * a divergence anybody needs telling about.
 */
function read(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

describe('the Party Access screen is one screen in two places', () => {
  it('is byte-identical across both panels', () => {
    const [master, office] = COPIES.map(read);

    // Asserted as a line-array rather than one string: a whole-file mismatch
    // reports as two 400-line blobs, and the first job on a failure is finding
    // *which* line moved.
    expect(office?.split('\n')).toEqual(master?.split('\n'));
  });

  it('says so in its own header, so the rule is visible without this test', () => {
    const [master] = COPIES.map(read);
    expect(master).toContain('byte-identical');
  });
});
