/**
 * The operator scripts, checked against what their names and the docs say
 * they do.
 *
 * Each of these once disagreed with its own name, silently:
 *
 * - `npm run migrate -- --status` at the root **applied** pending migrations.
 *   The root script re-ran the workspace script without forwarding its
 *   arguments, so `--status` landed on the inner `npm run` as an npm option
 *   and never reached `migrate-cli.ts`.
 * - `reload:catalog` was the same command as `wipe:business`: it wiped and
 *   loaded nothing, because the flag that loads the catalogue was passed by
 *   no script.
 * - `seed:sample` printed its party-wise records as "party-wise rates" after
 *   the software stopped carrying money at all.
 *
 * Reads the files, in the `packaging-invariants.test.ts` style. Running the
 * scripts is `operator-cli.integration.test.ts`'s job.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function scriptsOf(packageJson: string): Record<string, string> {
  return (
    JSON.parse(readFileSync(path.join(ROOT, packageJson), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
}

const ROOT_SCRIPTS = scriptsOf('package.json');
const MASTER_SCRIPTS = scriptsOf(path.join('master', 'package.json'));

/** `tsx <file> [flags…]`, split. */
function tsxCommand(script: string | undefined): { runner: string; file: string; flags: string[] } {
  const [runner = '', file = '', ...flags] = (script ?? '').trim().split(/\s+/);
  return { runner, file, flags };
}

describe('npm run migrate', () => {
  it('forwards its arguments to the workspace, so `-- --status` lists rather than applies', () => {
    // The trailing `--` is the whole fix: without it npm reads `--status` as
    // one of its own options on the inner `npm run`.
    expect(ROOT_SCRIPTS.migrate).toBe('npm run migrate --workspace @orderbook/master --');
    expect(tsxCommand(MASTER_SCRIPTS.migrate)).toEqual({
      runner: 'tsx',
      file: 'src/db/migrate-cli.ts',
      flags: [],
    });
  });
});

describe('the business-data scripts (catalog-reload-cli.ts)', () => {
  const CLI = 'src/services/catalog-reload-cli.ts';

  it('reload:catalog wipes and then loads the Swisware catalogue', () => {
    expect(tsxCommand(MASTER_SCRIPTS['reload:catalog'])).toEqual({
      runner: 'tsx',
      file: CLI,
      flags: ['--with-catalog'],
    });
  });

  it('wipe:business only wipes', () => {
    expect(tsxCommand(MASTER_SCRIPTS['wipe:business'])).toEqual({
      runner: 'tsx',
      file: CLI,
      flags: [],
    });
  });

  it('seed:parties wipes and then creates the sample parties', () => {
    expect(tsxCommand(MASTER_SCRIPTS['seed:parties'])).toEqual({
      runner: 'tsx',
      file: CLI,
      flags: ['--with-parties'],
    });
  });
});

describe('what the operator CLIs print', () => {
  const MONEY = /\b(rates?|prices?|pricing|money|amounts?|paise|rupees?)\b/i;

  const cliFiles = ['db', 'services'].flatMap((dir) =>
    readdirSync(path.join(ROOT, 'master', 'src', dir))
      .filter((name) => name.endsWith('-cli.ts'))
      .map((name) => path.join('master', 'src', dir, name)),
  );

  it('finds the CLIs', () => {
    expect(cliFiles.length).toBeGreaterThanOrEqual(5);
  });

  it.each(cliFiles)('%s says nothing about money', (file) => {
    const lines = readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n')
      .filter((line) => MONEY.test(line));
    expect(lines).toEqual([]);
  });
});
