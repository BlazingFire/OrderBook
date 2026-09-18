/**
 * The packaging configuration, checked against itself.
 *
 * `tools/release.mjs` and the two `electron-builder.yml` files are three
 * documents that have to agree, and nothing compiled them together. When they
 * drifted, they drifted silently and in the one direction nobody notices from
 * Windows:
 *
 * - `TARGETS[*].postgres` named the right `@embedded-postgres` package for
 *   each OS, was documented as the thing that stops a Mac build shipping a
 *   database it cannot start, and **was never read** — `vendorPostgres()`
 *   hardcoded `windows-x64` in the source path, the error text and the hint.
 * - `TARGETS.linux` asked electron-builder for `--linux` and then looked for
 *   an `AppImage` filename, while neither panel's yml had a `linux:` block at
 *   all. The build fails, but only for whoever runs `--os linux`, which on a
 *   Windows-only CI is nobody.
 *
 * Both of those are statements a test can check by reading, which is what this
 * file does. Running the builds would be better and is not available: a macOS
 * target only builds on macOS by electron-builder's own refusal.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const RELEASE = readFileSync(path.join(ROOT, 'tools', 'release.mjs'), 'utf8');

const PANELS = ['master', 'office'] as const;

/** Source lines with comment lines dropped — a mention in prose is not a use. */
function code(source: string): string[] {
  return source.split('\n').filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
  });
}

/**
 * The `postgres:` array declared for each `--os` name, read out of the source.
 *
 * Importing `release.mjs` is not an option: it runs the release at import time
 * from `process.argv`. Reading it is the same technique as
 * `credential-invariants.test.ts`, for the same reason.
 */
function declaredTargets(): Record<string, { ext: string; postgres: string[] }> {
  const block = RELEASE.slice(RELEASE.indexOf('const TARGETS = {'), RELEASE.indexOf('\n};', RELEASE.indexOf('const TARGETS = {')));
  const targets: Record<string, { ext: string; postgres: string[] }> = {};

  for (const match of block.matchAll(/^ {2}(\w+): \{$/gm)) {
    const name = match[1] as string;
    const rest = block.slice(match.index ?? 0);
    const ext = /ext: '([^']+)'/.exec(rest)?.[1];
    const postgres = /postgres: \[([^\]]*)\]/.exec(rest)?.[1];
    expect(ext, `${name} declares no ext`).toBeTruthy();
    expect(postgres, `${name} declares no postgres`).toBeDefined();
    targets[name] = {
      ext: ext as string,
      postgres: (postgres as string)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .flatMap(expandPackage),
    };
  }

  return targets;
}

/**
 * One declared entry → every package it can resolve to.
 *
 * Windows and Linux name their package with a host-arch template
 * (`linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`), because only the
 * host's own package is installed on that machine. Both arms are real
 * packages a real build will vendor, so both are checked.
 */
function expandPackage(entry: string): string[] {
  const literal = /^['"`]([a-z0-9-]+)['"`]$/.exec(entry);
  if (literal) return [literal[1] as string];

  const templated = /^`([a-z0-9]+)-\$\{[^}]*\}`$/.exec(entry);
  if (templated) return [`${templated[1] as string}-x64`, `${templated[1] as string}-arm64`];

  throw new Error(`Cannot read the package name out of: ${entry}`);
}

describe('release targets', () => {
  const targets = declaredTargets();

  it('declares all three operating systems', () => {
    expect(Object.keys(targets).sort()).toEqual(['linux', 'mac', 'win']);
  });

  it('vendors PostgreSQL from the target, never from a hardcoded platform', () => {
    const lines = code(RELEASE);
    const vendor = lines.slice(lines.findIndex((l) => l.includes('async function vendorPostgres')));
    const body = vendor.slice(0, vendor.findIndex((l) => l === '}') + 1).join('\n');

    // The whole defect, stated: the declared field has a consumer.
    expect(body).toMatch(/RELEASE_TARGET\.postgres/);

    // And the thing it replaced has not crept back in beside it.
    for (const pkg of ['windows-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']) {
      expect(body, `vendorPostgres names ${pkg} directly`).not.toContain(`'${pkg}'`);
    }
  });

  it('approves every declared package for its postinstall', () => {
    // `@embedded-postgres/*` ships `native/**` in the tarball but recreates the
    // SONAME symlinks in `native/lib/` from a postinstall. npm blocks it unless
    // the package is listed here, and without the symlinks `postgres` cannot
    // load its own libraries — invisible on Windows, which has no symlinks to
    // lose, which is why only the Windows package was ever approved.
    const allow = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).allowScripts;
    const approved = Object.keys(allow).map((entry) => entry.slice(0, entry.lastIndexOf('@')));

    for (const [name, target] of Object.entries(targets)) {
      for (const pkg of target.postgres) {
        expect(approved, `${name} vendors ${pkg}, which is not in allowScripts`).toContain(
          `@embedded-postgres/${pkg}`,
        );
      }
    }
  });

  it('vendors both architectures for the universal macOS build', () => {
    // One .dmg runs on Intel and Apple silicon; `extraResources` is copied
    // identically into both halves of the merge, so one architecture's
    // binaries would ship to an audience of two architectures.
    expect(targets.mac?.postgres.sort()).toEqual(['darwin-arm64', 'darwin-x64']);
  });
});

describe('electron-builder configuration', () => {
  const targets = declaredTargets();

  /** `win:` → the yml key electron-builder uses for that `--os` name. */
  const KEY: Record<string, string> = { win: 'win', mac: 'mac', linux: 'linux' };

  /*
   * Which blocks may name the artifact for a target.
   *
   * electron-builder reads `artifactName` from the platform block *and* from
   * each packager block under it, with the more specific one winning. Windows
   * has always set it on `nsis:` rather than on `win:`, so a check that looked
   * only at the platform block would have failed against configuration that
   * has shipped every release.
   */
  const NAMED_BY: Record<string, string[]> = {
    win: ['win', 'nsis'],
    mac: ['mac', 'dmg'],
    linux: ['linux', 'deb', 'appImage'],
  };

  for (const panel of PANELS) {
    const yml = readFileSync(path.join(ROOT, panel, 'electron-builder.yml'), 'utf8');

    for (const [name, target] of Object.entries(targets)) {
      it(`${panel} configures the ${name} target`, () => {
        expect(yml, `no ${KEY[name]}: block in ${panel}/electron-builder.yml`).toMatch(
          new RegExp(`^${KEY[name]}:$`, 'm'),
        );
      });

      it(`${panel}'s ${name} artifactName can produce a .${target.ext}`, () => {
        /*
         * `build()` checks for an exact filename ending in `TARGETS[os].ext`.
         * The only thing that can produce it is an `artifactName` whose
         * extension is `${ext}` — a literal `.exe` in a linux block, or a
         * missing artifactName, both yield a name `build()` will never find
         * and an error blaming electron-builder.
         */
        const named = (NAMED_BY[name] as string[])
          .map((key) => {
            const header = `\n${key}:\n`;
            const at = yml.indexOf(header);
            if (at < 0) return null;
            const after = yml.slice(at + header.length);
            // Up to the next top-level key, so `mac:`'s artifactName cannot
            // answer for `linux:` just because it comes later in the file.
            const next = /^\w+:$/m.exec(after);
            const body = next ? after.slice(0, next.index) : after;
            return /artifactName: (\S+)/.exec(body)?.[1] ?? null;
          })
          .filter((value): value is string => value !== null);

        expect(named, `no block naming the ${name} artifact`).not.toHaveLength(0);
        for (const artifact of named) expect(artifact).toMatch(/\.\$\{ext\}$/);
      });
    }

    it(`${panel} names its Linux executable`, () => {
      // Without `executableName` the binary is named from the npm package and
      // ships as `@orderbookmaster`. `tools/uninstall/uninstall-orderbook.sh`
      // matches on this name to find the .deb's desktop entry and icons.
      expect(yml).toMatch(new RegExp(`executableName: orderbook-${panel}$`, 'm'));
    });
  }
});

describe('the uninstall script knows what the .deb installs', () => {
  const script = readFileSync(
    path.join(ROOT, 'tools', 'uninstall', 'uninstall-orderbook.sh'),
    'utf8',
  );

  it('sweeps the executableName-derived paths, not only the product name', () => {
    // The .deb names its /usr/share/applications entry, its hicolor icons and
    // its /usr/bin symlink after `executableName`. A sweep that only knew
    // "OrderBook Master Panel" walked past all three.
    expect(script).toMatch(/exec_of\(\)/);
    expect(script).toContain('/usr/share/applications/$exec_name.desktop');
    expect(script).toContain('/usr/bin/$exec_name');
  });
});
