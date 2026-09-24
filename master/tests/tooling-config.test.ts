/**
 * The repository's own tooling configuration names things that exist.
 *
 * Both of these drifted the quiet way, by the thing they named going away or
 * never arriving, and neither failed anything:
 *
 * - `eslint.config.js` turns the untranslated-JSX rule to `'error'` for a list
 *   of swept files. Three of the five were deleted with the PDF Designer, and a
 *   `files` glob that matches nothing is not an error — the block just applies
 *   to less than it says, which is exactly how a sweep erodes unnoticed.
 * - `npm run test:coverage` asks Vitest for the `v8` provider, whose package
 *   was never installed, so the script failed on its first line for anybody
 *   who ran it.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface FlatConfig {
  files?: string[];
  rules?: Record<string, unknown>;
}

describe('eslint.config.js', () => {
  it('holds the untranslated-JSX rule to files that exist', async () => {
    // A variable specifier, so this is a plain runtime import of the config
    // ESLint itself loads, not a module for the type checker to resolve.
    const specifier = pathToFileURL(path.join(ROOT, 'eslint.config.js')).href;
    const config = (await import(specifier)).default as FlatConfig[];

    const swept = config.filter(
      (entry) => entry.rules?.['orderbook-i18n/no-untranslated-jsx-text'] === 'error',
    );
    expect(swept).not.toHaveLength(0);

    for (const entry of swept) {
      for (const file of entry.files ?? []) {
        // The list is of files, one per sweep; a glob here would hide the
        // same drift this checks for.
        expect(file, 'a swept entry is a glob').not.toMatch(/[*?{]/);
        expect(existsSync(path.join(ROOT, file)), `${file} is swept but does not exist`).toBe(true);
      }
    }
  });
});

describe('npm run test:coverage', () => {
  it('has its coverage provider installed, at the version of Vitest it runs under', () => {
    const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
    expect(scripts['test:coverage']).toContain('--coverage');

    const provider = /provider: '(\w+)'/.exec(
      readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8'),
    )?.[1];
    expect(provider, 'vitest.config.ts names no coverage provider').toBeTruthy();

    // `@vitest/coverage-<provider>` peer-depends on the exact Vitest version,
    // and Vitest refuses a provider from another release.
    const installed = (name: string): string | null => {
      const manifest = path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json');
      return existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : null;
    };

    expect(installed(`@vitest/coverage-${provider}`)).toBe(installed('vitest'));
  });
});
