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
 * - The ymls built a macOS `.zip` that `release.mjs` never picked up, while
 *   comments on both sides said it was what the update path downloaded.
 * - `TARGETS.linux` vendored the *build host's* PostgreSQL architecture into
 *   an app the ymls build for x64 only.
 *
 * All of those are statements a test can check by reading, which is what most
 * of this file does. Running the builds would be better and is not available:
 * a macOS target only builds on macOS by electron-builder's own refusal. The
 * one exception is the host-architecture refusal, which runs the script as a
 * different machine would, stopped before its first command, and asks `npm ls`
 * which panels have something native to refuse over.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createZipWriter } from '../src/lib/archive-zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A file under the repo root as text, with line endings normalised.
 *
 * Git checks these files out with CRLF on Windows (`core.autocrlf`), and every
 * reader below finds lines by `\n` — a `}` line, a `\nmac:\n` header — so on a
 * CRLF checkout each one came back empty and 29 assertions failed on text that
 * was never read. Linux CI checks out LF, where this is a no-op.
 */
function readText(...segments: string[]): string {
  return readFileSync(path.join(ROOT, ...segments), 'utf8').replace(/\r\n/g, '\n');
}

const RELEASE = readText('tools', 'release.mjs');

const PANELS = ['master', 'office'] as const;

/** The name each packaged thing carries in its artifact filenames. */
const ARTIFACT: Record<string, string> = {
  master: 'Master',
  office: 'Office',
  cleaner: 'CleanInstall',
};

/** Source lines with comment lines dropped — a mention in prose is not a use. */
function code(source: string): string[] {
  return source.split('\n').filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
  });
}

/** One top-level function of `release.mjs`, from its signature to its closing brace. */
function bodyOf(signature: string): string {
  const lines = code(RELEASE);
  const from = lines.slice(lines.findIndex((l) => l.includes(signature)));
  return from.slice(0, from.findIndex((l) => l === '}') + 1).join('\n');
}

interface DeclaredTarget {
  ext: string;
  /** Each `postgres:` entry exactly as written, quotes and all. */
  postgresEntries: string[];
  /** The package names those entries spell, where they are plain literals. */
  postgres: string[];
  /** The one architecture a single-arch target builds, or null. */
  arch: string | null;
  universal: boolean;
  /** Every architecture the yml builds, where that is more than `arch` (`win7`). */
  archs: string[] | null;
  /** The panels it builds, where that is not all of them (`win7`: the Office). */
  panels: string[] | null;
  /** The yml it builds from, where that is not `electron-builder.yml`. */
  config: string | null;
  /** The word after the panel in every file name (`Win7`), or null. */
  tag: string | null;
}

/** A `[ 'a', 'b' ]` array literal's entries, as written. */
function arrayEntries(source: string | undefined): string[] {
  return (source ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** A quoted string literal's contents, or null for anything computed. */
function literal(entry: string): string | null {
  return /^'([^'$`]+)'$/.exec(entry)?.[1] ?? null;
}

/** A declared `[ 'a', 'b' ]` list's literals, or null when the field is absent. */
function listed(source: string | undefined): string[] | null {
  return source === undefined
    ? null
    : arrayEntries(source)
        .map(literal)
        .filter((entry): entry is string => entry !== null);
}

/** The yml a target builds from, and the panels it builds. */
const configOf = (target: DeclaredTarget): string => target.config ?? 'electron-builder.yml';
const builds = (target: DeclaredTarget, thing: string): boolean =>
  target.panels === null || target.panels.includes(thing);

/** `OrderBook-<Panel>[-<tag>]-<v>-<tail>`, the shape `build()` looks for. */
const fileName = (thing: string, target: DeclaredTarget, tail: string): string =>
  ['OrderBook', ARTIFACT[thing], ...(target.tag ? [target.tag] : []), `<v>-${tail}`].join('-');

/**
 * The yml key electron-builder reads a target from: its own name, except for
 * the Windows 7 build, which is a Windows build from another yml.
 */
const YML_KEY: Record<string, string> = { win7: 'win' };
const ymlKey = (name: string): string => YML_KEY[name] ?? name;

/**
 * Each `--os` name's declaration, read out of the source.
 *
 * Importing `release.mjs` is not an option: it runs the release at import time
 * from `process.argv`. Reading it is the same technique as
 * `credential-invariants.test.ts`, for the same reason.
 */
function declaredTargets(): Record<string, DeclaredTarget> {
  const start = RELEASE.indexOf('const TARGETS = {');
  const block = RELEASE.slice(start, RELEASE.indexOf('\n};', start));
  const headers = [...block.matchAll(/^ {2}(\w+): \{$/gm)];
  const targets: Record<string, DeclaredTarget> = {};

  headers.forEach((match, index) => {
    const name = match[1] as string;
    // This target's own lines only, so a field one target leaves out cannot
    // be answered by the next target's.
    const body = code(block.slice(match.index, headers[index + 1]?.index)).join('\n');
    const ext = /ext: '([^']+)'/.exec(body)?.[1];
    const postgres = /postgres: \[([^\]]*)\]/.exec(body)?.[1];
    expect(ext, `${name} declares no ext`).toBeTruthy();
    expect(postgres, `${name} declares no postgres`).toBeDefined();

    const postgresEntries = arrayEntries(postgres);
    targets[name] = {
      ext: ext as string,
      postgresEntries,
      postgres: postgresEntries.map(literal).filter((pkg): pkg is string => pkg !== null),
      arch: /\barch: '(\w+)'/.exec(body)?.[1] ?? null,
      universal: /universal: true/.test(body),
      archs: listed(/archs: \[([^\]]*)\]/.exec(body)?.[1]),
      panels: listed(/panels: \[([^\]]*)\]/.exec(body)?.[1]),
      config: /config: '([^']+)'/.exec(body)?.[1] ?? null,
      tag: /tag: '([^']+)'/.exec(body)?.[1] ?? null,
    };
  });

  return targets;
}

/**
 * Run `tools/release.mjs` as a machine of another platform and architecture
 * would, and return what it printed to stderr.
 *
 * A preload fakes `process.platform` and `process.arch`, and replaces
 * `execFileSync` — which every command the script runs goes through — with a
 * throw. So nothing is ever built or copied, whatever the script decides: a
 * run that clears every check stops at its first command with
 * `Release failed: STOP before npm`, and a refusal stops earlier with its own
 * message. `panel` is `--panel`; without it the run is the default one, both
 * panels. `more` adds arguments and environment, for `--catalogue`.
 */
function releaseAs(
  platform: string,
  arch: string,
  target: string,
  panel?: string,
  more: {
    args?: string[];
    env?: Record<string, string>;
    /** Fills the releases folder the run reads, before it starts. */
    prepare?: (releasesDir: string) => void;
  } = {},
): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orderbook-release-host-'));
  try {
    more.prepare?.(dir);
    const preload = path.join(dir, 'host.mjs');
    writeFileSync(
      preload,
      [
        "import childProcess from 'node:child_process';",
        "import { syncBuiltinESMExports } from 'node:module';",
        `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });`,
        `Object.defineProperty(process, 'arch', { value: ${JSON.stringify(arch)} });`,
        'childProcess.execFileSync = (command) => {',
        '  throw new Error(`STOP before ${command}`);',
        '};',
        'syncBuiltinESMExports();',
      ].join('\n'),
    );

    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        path.join(ROOT, 'tools', 'release.mjs'),
        '--os',
        target,
        ...(panel ? ['--panel', panel] : []),
        ...(more.args ?? []),
      ],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ORDERBOOK_RELEASES_DIR: dir, ...more.env } },
    );

    // Every run here ends in a refusal or the stub; neither is a success.
    expect(result.status, result.stdout).toBe(1);
    return result.stderr;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What `publish()` leaves for an Office build: its setup file and the manifest naming it. */
function publishOffice(releasesDir: string, platform: string, version: string): void {
  const folder = path.join(releasesDir, 'office-panel');
  const file = `OrderBook-Office-${version}-Setup.exe`;
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, file), 'setup');
  writeFileSync(
    path.join(folder, `latest-${platform}.json`),
    JSON.stringify({ panel: 'office', platform, version, file }),
  );
}

/**
 * The packages in a panel's production tree that are built for one platform:
 * a `cpu` or `os` restriction (`sharp`'s and PostgreSQL's platform packages),
 * or a compiled addon (`binding.gyp`, `gypfile`, a `prebuilds/` folder). Read
 * from the same `npm ls` that `productionTree()` in `release.mjs` stages from,
 * so what this finds is what a setup file would carry.
 */
function nativePackages(panel: string): string[] {
  const result = spawnSync(
    'npm',
    ['ls', '--omit=dev', '--all', '--parseable', '--workspace', `@orderbook/${panel}`],
    { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' },
  );
  expect(result.status, result.stderr).toBe(0);

  const modules = path.join(ROOT, 'node_modules');
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(modules))
    .filter((dir) => !dir.includes(`${path.sep}@orderbook${path.sep}`))
    .filter((dir) => {
      const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      return (
        manifest.cpu !== undefined ||
        manifest.os !== undefined ||
        manifest.gypfile === true ||
        existsSync(path.join(dir, 'binding.gyp')) ||
        existsSync(path.join(dir, 'prebuilds'))
      );
    })
    .map((dir) => path.relative(modules, dir));
}

describe('release targets', () => {
  const targets = declaredTargets();

  it('declares every release target', () => {
    // The three operating systems, and the Windows 7 Office build.
    expect(Object.keys(targets).sort()).toEqual(['linux', 'mac', 'win', 'win7']);
  });

  it('names every PostgreSQL package outright, never from the build host', () => {
    // `linux-${process.arch …}` vendored whatever the build machine was into
    // an app the ymls build for x64 only: an arm64 build host would have
    // shipped arm64 database binaries inside an x64 AppImage.
    for (const [name, target] of Object.entries(targets)) {
      for (const entry of target.postgresEntries) {
        expect(literal(entry), `${name} computes a PostgreSQL package: ${entry}`).not.toBeNull();
      }
    }
  });

  it('vendors the architecture each target builds, and builds one or both', () => {
    for (const [name, target] of Object.entries(targets)) {
      if (target.universal) {
        expect(target.arch, `${name} is universal and also names one arch`).toBeNull();
        continue;
      }

      expect(target.arch, `${name} names neither an arch nor universal`).toBeTruthy();
      for (const pkg of target.postgres) {
        expect(pkg, `${name} builds ${target.arch} and vendors ${pkg}`).toMatch(
          new RegExp(`-${target.arch}$`),
        );
      }
    }
  });

  it('refuses the Master on a host of another architecture than its target', () => {
    // Staging copies the host's own native packages (npm installs only the
    // ones matching its `cpu`), so an arm64 machine building the x64 AppImage
    // ships arm64 `sharp` and no x64 PostgreSQL at all. Refused up front, by
    // name, rather than an hour later as "binaries are missing" — asked for
    // alone, and as part of the default run, before the Office built ahead of it.
    for (const panel of ['master', undefined]) {
      const linux = releaseAs('linux', 'arm64', 'linux', panel);
      expect(linux).toMatch(/Release failed: .*x64/);
      expect(linux).toContain('arm64');
      expect(linux).not.toContain('STOP before');

      const win = releaseAs('win32', 'arm64', 'win', panel);
      expect(win).toMatch(/Release failed: .*x64/);
      expect(win).not.toContain('STOP before');
    }
  });

  it('refuses exactly the panels that stage a native package, and no others', () => {
    // The refusal is about what staging copies, so it belongs to the panels
    // whose production tree holds something built for one architecture. The
    // Office panel's tree (Express, Multer, a socket client) and the
    // clean-install tool, which stages nothing, carry nothing of the build
    // machine's, and electron-builder fetches the x64 Electron for them on any
    // host. A panel that gains a native dependency must be refused from then
    // on (`native: true` in `PANELS`), or this fails.
    expect(
      nativePackages('master'),
      'found nothing native in the Master, which ships sharp',
    ).not.toHaveLength(0);

    for (const panel of PANELS) {
      const native = nativePackages(panel);
      for (const [platform, target] of [
        ['linux', 'linux'],
        ['win32', 'win'],
      ] as const) {
        const stderr = releaseAs(platform, 'arm64', target, panel);
        if (native.length > 0) {
          expect(stderr, `${panel} stages ${native.join(', ')}`).toMatch(/Release failed: .*x64/);
        } else {
          expect(stderr, `${panel} stages nothing native`).toContain(
            'Release failed: STOP before npm',
          );
        }
      }
    }

    expect(releaseAs('linux', 'arm64', 'linux', 'cleaner')).toContain(
      'Release failed: STOP before npm',
    );
    expect(releaseAs('win32', 'arm64', 'win', 'cleaner')).toContain(
      'Release failed: STOP before npm',
    );
  });

  it('lets each target through on the hosts that can build it', () => {
    // The other half: the refusal above is on the architecture, not on the
    // target. `STOP before npm` is the stub standing in for the first build
    // command, so reaching it means every check passed.
    expect(releaseAs('linux', 'x64', 'linux')).toContain('Release failed: STOP before npm');
    expect(releaseAs('win32', 'x64', 'win')).toContain('Release failed: STOP before npm');
    // Universal: either kind of Mac builds both halves.
    expect(releaseAs('darwin', 'arm64', 'mac')).toContain('Release failed: STOP before npm');
    expect(releaseAs('darwin', 'x64', 'mac')).toContain('Release failed: STOP before npm');
    // The Windows 7 build is the Office alone, which carries nothing native,
    // so any Windows machine builds it.
    expect(releaseAs('win32', 'x64', 'win7')).toContain('Release failed: STOP before npm');
    expect(releaseAs('win32', 'arm64', 'win7')).toContain('Release failed: STOP before npm');
  });

  it('builds the Windows 7 target for the Office only, and says why for the Master', () => {
    // PostgreSQL 17 does not run on Windows 7, so a Windows 7 Master is not a
    // build that can work. Asked for by name it is refused, never skipped.
    expect(targets.win7?.panels).toEqual(['office']);
    const master = releaseAs('win32', 'x64', 'win7', 'master');
    expect(master).toContain('Office panel only');
    expect(master).toContain('Windows 10');
    expect(master).not.toContain('STOP before');
    expect(releaseAs('win32', 'x64', 'win7', 'cleaner')).toContain('Office panel only');
    expect(releaseAs('win32', 'x64', 'win7', 'office')).toContain(
      'Release failed: STOP before npm',
    );
    // Only a Windows machine makes a Windows setup file.
    expect(releaseAs('linux', 'x64', 'win7')).toMatch(/Release failed: .*only be built on win32/);
  });

  it('builds and publishes the Office before the Master, which carries it', () => {
    // The default run walks `PANELS` in order, and the Master's staging copies
    // the Office setup of its own version out of the releases folder — so the
    // Office has to be published by then.
    const start = RELEASE.indexOf('const PANELS = {');
    const block = RELEASE.slice(start, RELEASE.indexOf('\n};', start));
    const order = [...block.matchAll(/^ {2}(\w+): \{$/gm)].map((match) => match[1]);
    expect(order.indexOf('office')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('office')).toBeLessThan(order.indexOf('master'));
    expect(bodyOf('async function main(')).toMatch(/Object\.keys\(PANELS\)\.filter/);

    // Into the Master's staging (`resources/panel/office-setup`), after `stage()`
    // has emptied and rebuilt it, and for the Master only.
    const build = bodyOf('async function build(');
    const bundling = build.indexOf("if (panel === 'master') await bundleOfficeSetups(version);");
    expect(bundling).toBeGreaterThan(build.indexOf('await stage(panel);'));
    expect(bundling).toBeLessThan(build.indexOf("'electron-builder'"));
    const bundle = bodyOf('async function bundleOfficeSetups(');
    expect(bundle).toContain("path.join(ROOT, PANELS.master.dir, 'staging', 'office-setup')");
    // The setup and its signed manifest, which is what the Master offers its Offices.
    expect(bundle).toContain('await cp(path.join(from, file), path.join(to, file));');
    expect(bundle).toContain('await cp(path.join(from, manifest), path.join(to, manifest));');
  });

  it('refuses a Master built alone until its Office is published, and says how', () => {
    const version = (JSON.parse(readText('package.json')) as { version: string }).version;
    for (const [platform, target] of [
      ['win32', 'win'],
      ['linux', 'linux'],
    ] as const) {
      const alone = releaseAs(platform, 'x64', target, 'master');
      expect(alone).toContain('Build the Office first');
      expect(alone).toContain(`latest-${platform}.json`);
      expect(alone).not.toContain('STOP before');

      // An Office of another version is not the one this Master carries.
      const stale = releaseAs(platform, 'x64', target, 'master', {
        prepare: (dir) => publishOffice(dir, platform, '0.0.1'),
      });
      expect(stale).toContain('Build the Office first');

      // The same version published first: through to the build.
      const ready = releaseAs(platform, 'x64', target, 'master', {
        prepare: (dir) => publishOffice(dir, platform, version),
      });
      expect(ready).toContain('Release failed: STOP before npm');
    }
    // The default run builds the Office in the same run, so it never asks.
    expect(releaseAs('win32', 'x64', 'win')).toContain('Release failed: STOP before npm');
  });

  it('stages the CommonJS shell, with its marker, for the Windows 7 target', () => {
    // Electron 22 loads its main script through the CommonJS loader, and the
    // panel's package.json says "type": "module". Without the marker beside the
    // compiled shell, the Windows 7 build dies on its first `require`.
    const office = JSON.parse(readText('office', 'package.json')) as { type?: string };
    expect(office.type).toBe('module');

    const build = bodyOf('async function build(');
    const legacy = build.slice(build.indexOf('if (RELEASE_TARGET.legacyShell)'));
    expect(legacy).toContain("path.join('electron', 'tsconfig.legacy.json')");
    expect(legacy).toContain("path.join(ROOT, 'build', 'shell-legacy')");
    expect(legacy).toMatch(
      /writeFile\(path\.join\(shellDist, 'package\.json'\), '\{"type":"commonjs"\}\\n'\)/,
    );
    expect(code(RELEASE).join('\n')).toMatch(/legacyShell: true/);

    // And the same for running from source: `npm run build:shell:legacy`.
    const copyShell = readText('tools', 'copy-shell.mjs');
    expect(copyShell).toContain("path.join(ROOT, 'build', 'shell-legacy')");
    expect(copyShell).toMatch(
      /if \(LEGACY\) await writeFile\(path\.join\(target, 'package\.json'\), '\{"type":"commonjs"\}\\n'\)/,
    );
    const scripts = (JSON.parse(readText('package.json')) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts['build:shell:legacy']).toBe(
      'tsc -p electron/tsconfig.legacy.json && node tools/copy-shell.mjs --legacy',
    );
    expect(scripts.typecheck).toContain('tsc -p electron/tsconfig.legacy.json --noEmit');

    // The legacy compile goes where both of them copy from.
    const legacyConfig = JSON.parse(
      readText('electron', 'tsconfig.legacy.json').replace(/^\s*\/\/.*$/gm, ''),
    ) as { compilerOptions: { outDir: string } };
    expect(legacyConfig.compilerOptions.outDir).toBe('../build/shell-legacy');
  });

  it('ships the Windows 7 target on the Electron pinned in tools/legacy-electron.mjs', () => {
    const block = RELEASE.slice(
      RELEASE.indexOf('  win7: {'),
      RELEASE.indexOf('\n};', RELEASE.indexOf('  win7: {')),
    );
    expect(block).toMatch(/electron: LEGACY_ELECTRON,/);
    expect(RELEASE).toContain("import { LEGACY_ELECTRON } from './legacy-electron.mjs';");
    expect(bodyOf('async function build(')).toMatch(/RELEASE_TARGET\.electron \?\?/);

    const pin = /export const LEGACY_ELECTRON = '([^']+)';/.exec(
      readText('tools', 'legacy-electron.mjs'),
    )?.[1];
    // 22 is the last Electron that runs on Windows 7 (LEGACY_ELECTRON_CEILING
    // in shared/src/domain/version.ts is the first that does not).
    expect(pin).toMatch(/^22\.3\.\d+$/);
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

  it('keeps the vendored libraries\' symlinks relative on every copy', () => {
    // `native/lib` is mostly SONAME links (`libpq.so.5 -> libpq.so.5.17`), and
    // `fs.cp` rewrites a relative link as an absolute path into the build
    // machine's node_modules unless told otherwise. The app then works where
    // it was built and nowhere else; the macOS universal merge surfaced it by
    // refusing files that resolved outside the app. Two copies carry the tree:
    // into `master/vendor`, and from there into the staging folder.
    const vendor = bodyOf('async function vendorPostgres');
    expect(vendor).toMatch(/cp\(source, dest, \{[^}]*verbatimSymlinks: true/);

    const stage = bodyOf('async function stage');
    const partsCopy = stage.slice(stage.indexOf('for (const part of parts)'));
    expect(partsCopy.slice(0, partsCopy.indexOf('}\n'))).toContain('verbatimSymlinks: true');
  });

  it('fetches and stages the other architecture of every native package for macOS', () => {
    // npm installs a platform package only for the machine's own cpu, so an
    // Apple silicon runner has `sharp-darwin-arm64` and no Intel twin. A
    // universal app built from that starts on an Intel Mac and fails on the
    // first photo.
    const block = RELEASE.slice(RELEASE.indexOf('  mac: {'), RELEASE.indexOf('  linux: {'));
    expect(block).toMatch(/universal: true/);

    const lines = code(RELEASE).join('\n');
    expect(lines).toMatch(/if \(RELEASE_TARGET\.universal\) ensureUniversalPackages\(\);/);
    expect(lines).toMatch(/if \(RELEASE_TARGET\.universal\) tree\.push\(\.\.\.universalSiblings\(tree\)\);/);
    // Before PostgreSQL is vendored, which needs the Intel package on disk.
    expect(lines.indexOf('ensureUniversalPackages();')).toBeLessThan(
      lines.indexOf('await vendorPostgres();'),
    );
  });

  it('publishes the setup file and nothing beside it', () => {
    // 1.4.1 (owner): setups only. No Standalone `.exe`, no `.deb`, no `.sha256`
    // files next to them, and no `--fast` mode that built only the Standalone.
    const code_ = code(RELEASE).join('\n');
    expect(code_).not.toMatch(/besides|publishBeside|Standalone|portable|--fast/);

    const publish = bodyOf('async function publish(');
    expect(publish).not.toMatch(/beside/i);

    // The manifest names the one file the update path installs.
    const signAt = publish.indexOf('sign({');
    expect(signAt).toBeGreaterThanOrEqual(0);
    const manifest = publish.slice(signAt, publish.indexOf('});', signAt));
    expect(manifest).toContain('sha256: await sha256(setupPath)');
  });

  it('asks electron-builder for no Standalone (portable) or deb target in any yml', () => {
    for (const thing of [...PANELS, 'cleaner'] as const) {
      for (const config of ['electron-builder.yml', 'electron-builder.legacy.yml']) {
        if (!existsSync(path.join(ROOT, thing, config))) continue;
        const yml = readText(thing, config)
          .split('\n')
          .filter((line) => !line.trim().startsWith('#'))
          .join('\n');
        expect(yml, `${thing}/${config}`).not.toMatch(/portable|Standalone|target: deb|^deb:/m);
      }
    }
  });
});

/** electron-builder's own block for a target, where its key is not the target's name. */
const PACKAGER_BLOCK: Record<string, string> = { AppImage: 'appImage' };

/** What `${ext}` becomes in each target's artifact name. */
const TARGET_EXT: Record<string, string> = {
  nsis: 'exe',
  dmg: 'dmg',
  zip: 'zip',
  AppImage: 'AppImage',
};

/** One top-level block of a yml with its comment lines dropped, or null when absent. */
function ymlBlock(yml: string, key: string): string | null {
  const header = `\n${key}:\n`;
  const at = yml.indexOf(header);
  if (at < 0) return null;
  const after = yml.slice(at + header.length);
  // Up to the next line that starts in column 0 — a key or a comment heading
  // the next block — so `mac:` cannot answer for `linux:`.
  const next = /^\S/m.exec(after);
  return (next ? after.slice(0, next.index) : after)
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/**
 * Every target a platform block builds, with the architectures it lists.
 *
 * electron-builder takes `target:` in each shape YAML allows: one name
 * (`target: dmg`), a flow list (`target: [dmg, zip]`), and a block list whose
 * entries are names (`- zip`) or objects (`- target: zip`, with `arch:` inline,
 * as a list of its own, or left out). A reader that knew only the object with
 * an `arch: [...]` line under it passed with the macOS `.zip` put back as
 * `- zip`, so every shape is read here, and a line inside the list that is
 * none of them throws instead of being skipped. An entry with no `arch` comes
 * back with an empty list: electron-builder then builds the host's own
 * architecture, which the arch test below refuses.
 */
function ymlTargets(yml: string, os: string): { target: string; arch: string[] }[] {
  const lines = (ymlBlock(yml, os) ?? '')
    .split('\n')
    // A trailing comment: YAML starts one at a `#` after whitespace.
    .map((line) => line.replace(/\s+#.*$/, ''))
    .filter((line) => line.trim() !== '');
  const indent = (line: string): number => line.length - line.trimStart().length;
  const unreadable = (line: string): Error =>
    new Error(`${os}: cannot read the target line "${line.trim()}"`);

  const at = lines.findIndex((line) => /^ {2}target:/.test(line));
  if (at < 0) return [];

  const header = lines[at] as string;
  const inline = header.slice('  target:'.length).trim();
  if (inline) {
    const listed = /^\[(.*)\]$/.exec(inline)?.[1];
    return (listed === undefined ? [inline] : arrayEntries(listed)).map((name) => {
      if (!/^\w+$/.test(name)) throw unreadable(header);
      return { target: name, arch: [] };
    });
  }

  // A block list, whose entries may sit at `target:`'s own indent or deeper.
  const targets: { target: string; arch: string[] }[] = [];
  const entryIndent = indent(lines[at + 1] ?? '');
  let archList = false;
  for (const line of lines.slice(at + 1)) {
    const depth = indent(line);
    const text = line.trim();
    // The list ends at the block's next key.
    if (depth < entryIndent || (depth === entryIndent && !text.startsWith('- '))) break;

    if (depth === entryIndent) {
      const entry = /^- (?:target: )?(\w+)$/.exec(text);
      if (!entry) throw unreadable(line);
      targets.push({ target: entry[1] as string, arch: [] });
      archList = false;
      continue;
    }

    // Deeper: a field of the entry above, and `arch` is the only one read.
    const current = targets[targets.length - 1];
    const arch = /^arch:(?: (.+))?$/.exec(text);
    const archEntry = archList ? /^- (\w+)$/.exec(text) : null;
    if (current && arch) {
      const value = arch[1];
      archList = value === undefined;
      if (value !== undefined) {
        const listed = /^\[(.*)\]$/.exec(value)?.[1];
        current.arch.push(...(listed === undefined ? [value] : arrayEntries(listed)));
      }
    } else if (current && archEntry) {
      current.arch.push(archEntry[1] as string);
    } else {
      throw unreadable(line);
    }
  }
  return targets;
}

/**
 * The file electron-builder writes for one target, with `${version}` left as
 * `<v>`. The packager's own block names it if it says anything, else the
 * platform block does — electron-builder's own precedence.
 */
function builtFile(yml: string, os: string, target: string): string | null {
  const named = (block: string | null): string | null =>
    (block && /artifactName: (\S+)/.exec(block)?.[1]) || null;
  const artifact =
    named(ymlBlock(yml, PACKAGER_BLOCK[target] ?? target)) ?? named(ymlBlock(yml, os));
  return artifact
    ? artifact.replace('${version}', '<v>').replace('${ext}', TARGET_EXT[target] ?? `<${target}?>`)
    : null;
}

describe('the yml target reader', () => {
  /** A `mac:` block holding `lines`, the way it sits in a panel's yml. */
  const read = (...lines: string[]) =>
    ymlTargets(['', 'mac:', '  category: x', ...lines, '  publish: null', ''].join('\n'), 'mac');

  it('reads every shape electron-builder accepts for a target list', () => {
    // A reader that knew only `- target: X` with an `arch:` line under it
    // passed with the macOS `.zip` put back as `- zip`.
    expect(read('  target: zip')).toEqual([{ target: 'zip', arch: [] }]);
    expect(read('  target: [dmg, zip]')).toEqual([
      { target: 'dmg', arch: [] },
      { target: 'zip', arch: [] },
    ]);
    expect(read('  target:', '    - dmg', '    - zip')).toEqual([
      { target: 'dmg', arch: [] },
      { target: 'zip', arch: [] },
    ]);
    expect(
      read('  target:', '    - target: dmg', '      arch: [universal]', '    - target: zip'),
    ).toEqual([
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: [] },
    ]);
    expect(
      read('  target:', '    - target: dmg', '      arch:', '        - x64', '        - arm64'),
    ).toEqual([{ target: 'dmg', arch: ['x64', 'arm64'] }]);
    expect(read('  target:', '    - target: dmg  # the one', '      arch: universal')).toEqual([
      { target: 'dmg', arch: ['universal'] },
    ]);
    // A sequence may sit at its key's own indent, and ends at the next key.
    expect(read('  target:', '  - dmg', '  - zip')).toEqual([
      { target: 'dmg', arch: [] },
      { target: 'zip', arch: [] },
    ]);
  });

  it('refuses a target line it cannot read rather than skipping it', () => {
    expect(() => read('  target:', '    - { target: zip }')).toThrow(/cannot read/);
    expect(() => read('  target:', '    - target: dmg', '      artifactName: x')).toThrow(
      /cannot read/,
    );
  });
});

describe('what electron-builder builds is what release.mjs picks up', () => {
  /*
   * Each file a yml asks for costs a CI leg minutes, and one that nothing
   * picks up is also a claim nobody checks: the macOS `.zip` was described as
   * "what the update path downloads" while nothing downloaded it, and the
   * `.deb` as uploaded while it never left the build folder. So the two lists
   * are held equal, in both directions.
   */
  const targets = declaredTargets();

  for (const thing of [...PANELS, 'cleaner'] as const) {
    for (const [name, target] of Object.entries(targets)) {
      // A target that builds some panels only (`win7`) has nothing to say
      // about the others.
      if (!builds(target, thing)) continue;
      const yml = readText(thing, configOf(target));
      const key = ymlKey(name);

      it(`${thing} builds exactly the ${name} files release.mjs looks for`, () => {
        const built = ymlTargets(yml, key).map(({ target: kind }) => builtFile(yml, key, kind));

        // `build()` looks for the setup file, and only that.
        const tails = [`Setup.${target.ext}`];
        const expected = tails.map((tail) => fileName(thing, target, tail));

        expect(built.sort()).toEqual(expected.sort());
      });

      it(`${thing} builds its ${name} files for the architecture release.mjs stages`, () => {
        const wanted = target.universal ? ['universal'] : (target.archs ?? [target.arch]);
        const built = ymlTargets(yml, key);
        expect(built).not.toHaveLength(0);
        for (const { target: kind, arch } of built) {
          expect(arch, `${thing}'s ${name} ${kind} target`).toEqual(wanted);
        }
      });
    }
  }
});

describe('electron-builder configuration', () => {
  const targets = declaredTargets();

  /** `win:` → the yml key electron-builder uses for that `--os` name. */
  const KEY: Record<string, string> = { win: 'win', mac: 'mac', linux: 'linux', win7: 'win' };

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
    win7: ['win', 'nsis'],
    mac: ['mac', 'dmg'],
    linux: ['linux', 'appImage'],
  };

  for (const panel of PANELS) {
    const yml = readText(panel, 'electron-builder.yml');

    for (const [name, target] of Object.entries(targets)) {
      if (!builds(target, panel)) continue;
      const targetYml = readText(panel, configOf(target));

      it(`${panel} configures the ${name} target`, () => {
        expect(targetYml, `no ${KEY[name]}: block in ${panel}/${configOf(target)}`).toMatch(
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
            const at = targetYml.indexOf(header);
            if (at < 0) return null;
            const after = targetYml.slice(at + header.length);
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

    it(`${panel} leaves the staged panel out of the universal lipo`, () => {
      // Everything under Resources/panel is staged once and lands identically
      // in both halves, both architectures' binaries included. @electron/universal
      // refuses a Mach-O file that is the same in both halves unless this
      // pattern covers it.
      const mac = yml.slice(yml.indexOf('\nmac:\n'));
      const body = mac.slice(0, (/^\w+:$/m.exec(mac.slice(6))?.index ?? mac.length) + 6);
      expect(body).toMatch(/^ {2}x64ArchFiles: Contents\/Resources\/panel\/\*\*$/m);
    });

    it(`${panel} names its Linux executable`, () => {
      // Without `executableName` the binary is named from the npm package and
      // ships as `@orderbookmaster`. `tools/uninstall/uninstall-orderbook.sh`
      // matches on this name to find the .deb's desktop entry and icons.
      expect(yml).toMatch(new RegExp(`executableName: orderbook-${panel}$`, 'm'));
    });
  }
});

describe('the Windows 7 Office yml', () => {
  /*
   * Its own file, not an `extends` of electron-builder.yml, so it can drift.
   * What must not: the same appId and product name, or Windows treats the two
   * builds as two programs and a PC moved from one to the other ends up with
   * both; the same data rule and NSIS hook, or an uninstall of one takes the
   * company's data or leaves the leftovers behind.
   */
  const main = readText('office', 'electron-builder.yml');
  const legacy = readText('office', 'electron-builder.legacy.yml');
  const field = (yml: string, pattern: RegExp): string | undefined => pattern.exec(yml)?.[1];

  it('is the same program as the main Office build', () => {
    for (const pattern of [
      /^appId: (.+)$/m,
      /^productName: (.+)$/m,
      /^ {2}output: (.+)$/m,
      /^ {2}buildResources: (.+)$/m,
      /^ {2}deleteAppDataOnUninstall: (.+)$/m,
      /^ {2}perMachine: (.+)$/m,
      /^ {2}unpackDirName: (.+)$/m,
    ]) {
      expect(field(legacy, pattern), String(pattern)).toBe(field(main, pattern));
    }
    expect(field(legacy, /^appId: (.+)$/m)).toBe('com.orderbook.office');
  });

  it('runs the main NSIS hook, and adds the Universal C Runtime warning', () => {
    expect(field(main, /^ {2}include: (.+)$/m)).toBe('installer/installer.nsh');
    expect(field(legacy, /^ {2}include: (.+)$/m)).toBe('installer/installer-legacy.nsh');

    const hook = readText('office', 'installer', 'installer-legacy.nsh');
    expect(hook).toContain('!include "${__FILEDIR__}\\installer.nsh"');
    expect(hook).toContain('!macro customInit');
    expect(hook).toContain('$SYSDIR\\ucrtbase.dll');
    expect(hook).toContain('KB2999226');
  });

  it('never reads ${__FILEDIR__} inside a macro (it would name electron-builder\'s template folder)', () => {
    // The 1.3.0 build failed on exactly this: a File line in customInstall used
    // ${__FILEDIR__}, which makensis expands where the macro is inserted.
    for (const file of [
      ['master', 'installer', 'installer.nsh'],
      ['office', 'installer', 'installer.nsh'],
      ['office', 'installer', 'installer-legacy.nsh'],
      ['tools', 'nsis', 'verified-powershell.nsh'],
    ]) {
      const text = readText(...file);
      for (const body of text.match(/^!macro\b[\s\S]*?^!macroend/gm) ?? []) {
        expect(body, file.join('/')).not.toContain('${__FILEDIR__}');
      }
    }
  });

  it('ships the uninstall scripts and the staged panel the same way', () => {
    for (const line of [
      '  - from: staging\n    to: panel',
      '  - from: ../tools/uninstall\n    to: uninstall',
      '  - electron/dist/**/*',
    ]) {
      expect(legacy).toContain(line);
      expect(main).toContain(line);
    }
  });
});

describe('the uninstall script knows what the .deb installs', () => {
  const script = readText('tools', 'uninstall', 'uninstall-orderbook.sh');

  it('sweeps the executableName-derived paths, not only the product name', () => {
    // The .deb names its /usr/share/applications entry, its hicolor icons and
    // its /usr/bin symlink after `executableName`. A sweep that only knew
    // "OrderBook Master Panel" walked past all three.
    expect(script).toMatch(/exec_of\(\)/);
    expect(script).toContain('/usr/share/applications/$exec_name.desktop');
    expect(script).toContain('/usr/bin/$exec_name');
  });
});

describe('the Windows executable carries the OrderBook icon (U11)', () => {
  /*
   * `signAndEditExecutable: false` also skips electron-builder's resource edit, so
   * without the afterPack stamp the installed panel's exe, and so its window,
   * taskbar button and shortcuts, keep Electron's own icon and name.
   */
  const WINDOWS_YMLS = [
    ['master', 'electron-builder.yml'],
    ['office', 'electron-builder.yml'],
    ['office', 'electron-builder.legacy.yml'],
    ['cleaner', 'electron-builder.yml'],
  ] as const;
  const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

  /** The image sizes in an .ico's directory (a width byte of 0 means 256). */
  const icoSizes = (ico: Buffer): number[] =>
    Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + 16 * i] || 256);

  it("every Windows build uses the panel's multi-size .ico and runs the afterPack hook that stamps it", () => {
    for (const [panel, file] of WINDOWS_YMLS) {
      const yml = readText(panel, file);
      // The `win:` block: from its header to the next top-level key.
      const win = yml.split(/^win:\n/m)[1]?.split(/^\S/m)[0] ?? '';
      expect(win, `${panel}/${file} win.icon`).toMatch(/^ {2}icon: installer\/icon\.ico$/m);
      expect(yml, `${panel}/${file}`).toMatch(/^afterPack: \.\.\/tools\/flip-fuses\.cjs$/m);
      expect(icoSizes(readFileSync(path.join(ROOT, panel, 'installer', 'icon.ico'))), `${panel} icon.ico`).toEqual(ICO_SIZES);
    }
    const hook = readText('tools', 'flip-fuses.cjs');
    const stamp = hook.indexOf('stampExe(exe, await context.packager.getIconPath()');
    expect(stamp).toBeGreaterThan(-1);
    expect(hook.indexOf('flipFuses(bytes)', stamp)).toBeGreaterThan(stamp);
  });

  it("stampExe replaces Electron's icon and name in a real Electron executable", () => {
    const { stampExe, readExe } = createRequire(import.meta.url)('../../tools/exe-icon.cjs') as {
      stampExe: (exe: string, ico: string, id: { productName: string; version: string }) => number;
      readExe: (exe: string) => { sizes: number[]; strings: Record<string, string> };
    };
    const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (!existsSync(electronExe)) return; // electron's Windows binary exists only on a Windows install

    const dir = mkdtempSync(path.join(os.tmpdir(), 'ob-icon-'));
    try {
      const exe = path.join(dir, 'OrderBook Office Panel.exe');
      writeFileSync(exe, readFileSync(electronExe));
      expect(readExe(exe).strings.ProductName).toBe('Electron');

      const ico = path.join(ROOT, 'office', 'installer', 'icon.ico');
      expect(stampExe(exe, ico, { productName: 'OrderBook Office Panel', version: '1.4.4' })).toBe(ICO_SIZES.length);
      const after = readExe(exe);
      expect(after.sizes).toEqual(ICO_SIZES);
      expect(after.strings).toMatchObject({
        ProductName: 'OrderBook Office Panel',
        FileDescription: 'OrderBook Office Panel',
        FileVersion: '1.4.4.0', // setFileVersion writes the four-part form
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('the catalogue a Master build ships', () => {
  const masterPanel = (): string =>
    code(RELEASE.slice(RELEASE.indexOf('  master: {'), RELEASE.indexOf('  cleaner: {'))).join('\n');

  it('stages the assets folder, catalogue included, with the Master', () => {
    expect(masterPanel()).toMatch(/extras: \[[^\]]*'assets'/);
  });

  it('checks a --catalogue zip (or ORDERBOOK_CATALOGUE_ZIP) before anything is built', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orderbook-release-catalogue-'));
    try {
      const zip = async (name: string, entry: string): Promise<string> => {
        const file = path.join(dir, name);
        const writer = createZipWriter(file);
        await writer.appendEntry(entry, ['Brand,Code\r\n']);
        await writer.finalize();
        return file;
      };
      const good = await zip('good.zip', 'Backup/products.csv');
      const bad = await zip('bad.zip', 'images/OPT-0001.webp');
      const text = path.join(dir, 'text.zip');
      writeFileSync(text, 'not a zip');

      const run = (args: string[], panel?: string, env?: Record<string, string>) =>
        releaseAs('win32', 'x64', 'win', panel, { args, env });
      expect(run(['--catalogue', path.join(dir, 'missing.zip')])).toMatch(/Release failed: --catalogue: .*does not exist/);
      expect(run(['--catalogue', text])).toMatch(/Release failed: --catalogue: .*is not a zip/);
      expect(run(['--catalogue', bad])).toMatch(/Release failed: --catalogue: .*has no products.csv/);
      expect(run(['--catalogue', good], 'office')).toContain('ships with the Master');
      expect(run(['--catalogue'])).toMatch(/Release failed: --catalogue: \(no file named\) does not exist/);
      expect(run([], undefined, { ORDERBOOK_CATALOGUE_ZIP: bad })).toMatch(/has no products.csv/);
      // The variable may be set for every run: an Office-only one ignores it rather than failing.
      expect(run([], 'office', { ORDERBOOK_CATALOGUE_ZIP: bad })).toContain('Release failed: STOP before npm');
      // A good zip passes the check and the run reaches its first command; the stub stops it before the copy.
      expect(run(['--catalogue', good])).toContain('Release failed: STOP before npm');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copies the zip to the path the Master boots from, after the check and before any build', () => {
    expect(RELEASE).toContain("path.join(ROOT, 'master', 'assets', 'catalogue', 'products.zip')");
    const main = bodyOf('async function main()');
    expect(main.indexOf('assertCatalogueZip(catalogueZip)')).toBeGreaterThan(-1);
    expect(main.indexOf('assertCatalogueZip(catalogueZip)')).toBeLessThan(main.indexOf("run('npm'"));
    expect(main.indexOf('cp(catalogueZip, SHIPPED_CATALOGUE)')).toBeGreaterThan(main.indexOf("run('npm'"));
    expect(main.indexOf('cp(catalogueZip, SHIPPED_CATALOGUE)')).toBeLessThan(main.indexOf('build(panel, version)'));
    expect(readText('master', 'src', 'config', 'index.ts')).toContain(
      "catalogueZip: path.join(packageRoot, 'assets', 'catalogue', 'products.zip')",
    );
  });
});
