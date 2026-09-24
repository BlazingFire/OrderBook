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
 * - The ymls built a macOS `.zip` and a Linux `.deb` that `release.mjs` never
 *   picked up, while comments on both sides said the `.zip` was what the
 *   update path downloaded and that the `.deb` was published.
 * - `TARGETS.linux` vendored the *build host's* PostgreSQL architecture into
 *   an app the ymls build for x64 only.
 *
 * All of those are statements a test can check by reading, which is what most
 * of this file does. Running the builds would be better and is not available:
 * a macOS target only builds on macOS by electron-builder's own refusal. The
 * one exception is the host-architecture refusal, which runs the script as a
 * different machine would, stopped before its first command.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const RELEASE = readFileSync(path.join(ROOT, 'tools', 'release.mjs'), 'utf8');

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
  /** Filename tails published beside the setup file. */
  besides: string[];
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
      besides: arrayEntries(/besides: \[([^\]]*)\]/.exec(body)?.[1])
        .map(literal)
        .filter((tail): tail is string => tail !== null),
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
 * message.
 */
function releaseAs(platform: string, arch: string, target: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orderbook-release-host-'));
  try {
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
      ],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ORDERBOOK_RELEASES_DIR: dir } },
    );

    // Every run here ends in a refusal or the stub; neither is a success.
    expect(result.status, result.stdout).toBe(1);
    return result.stderr;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('release targets', () => {
  const targets = declaredTargets();

  it('declares all three operating systems', () => {
    expect(Object.keys(targets).sort()).toEqual(['linux', 'mac', 'win']);
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

  it('refuses a single-architecture target on a host of another architecture', () => {
    // Staging copies the host's own native packages (npm installs only the
    // ones matching its `cpu`), so an arm64 machine building the x64 AppImage
    // ships arm64 `sharp` and no x64 PostgreSQL at all. Refused up front, by
    // name, rather than an hour later as "binaries are missing".
    const linux = releaseAs('linux', 'arm64', 'linux');
    expect(linux).toMatch(/Release failed: .*x64/);
    expect(linux).toContain('arm64');
    expect(linux).not.toContain('STOP before');

    const win = releaseAs('win32', 'arm64', 'win');
    expect(win).toMatch(/Release failed: .*x64/);
    expect(win).not.toContain('STOP before');
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

  it('publishes the files built beside the setup file, and keeps them out of the manifest', () => {
    // `build()` insists each one exists, so a yml that stops building one
    // fails the release by name rather than publishing without it.
    expect(bodyOf('async function build(')).toMatch(/RELEASE_TARGET\.besides/);

    const publish = bodyOf('async function publish(');
    expect(publish).toMatch(
      /for \(const \w+ of built\.besides\) await publishBeside\(target, \w+\);/,
    );

    // The manifest names the one file the update path installs. A standalone
    // `.exe` or a `.deb` in it would be downloaded, verified and then refused
    // by the shell, or installed by nothing.
    const signAt = publish.indexOf('sign({');
    expect(signAt).toBeGreaterThanOrEqual(0);
    const manifest = publish.slice(signAt, publish.indexOf('});', signAt));
    expect(manifest).toContain('sha256: await sha256(setupPath)');
    expect(manifest).not.toContain('besides');
  });
});

/** electron-builder's own block for a target, where its key is not the target's name. */
const PACKAGER_BLOCK: Record<string, string> = { AppImage: 'appImage' };

/** What `${ext}` becomes in each target's artifact name. */
const TARGET_EXT: Record<string, string> = {
  nsis: 'exe',
  portable: 'exe',
  dmg: 'dmg',
  zip: 'zip',
  AppImage: 'AppImage',
  deb: 'deb',
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

/** Every target a platform block builds, with the architectures it lists. */
function ymlTargets(yml: string, os: string): { target: string; arch: string[] }[] {
  const body = ymlBlock(yml, os) ?? '';
  return [...body.matchAll(/- target: (\w+)\n\s+arch: \[([^\]]*)\]/g)].map((match) => ({
    target: match[1] as string,
    arch: arrayEntries(match[2]),
  }));
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
    const yml = readFileSync(path.join(ROOT, thing, 'electron-builder.yml'), 'utf8');

    for (const [name, target] of Object.entries(targets)) {
      it(`${thing} builds exactly the ${name} files release.mjs looks for`, () => {
        const built = ymlTargets(yml, name).map(({ target: kind }) => builtFile(yml, name, kind));

        // `build()` looks for the setup file, plus — on what it publishes —
        // each `besides` file. The cleaner is never published and builds one
        // setup file per OS.
        const tails = [`Setup.${target.ext}`, ...(thing === 'cleaner' ? [] : target.besides)];
        const expected = tails.map((tail) => `OrderBook-${ARTIFACT[thing]}-<v>-${tail}`);

        expect(built.sort()).toEqual(expected.sort());
      });

      it(`${thing} builds its ${name} files for the architecture release.mjs stages`, () => {
        const wanted = target.universal ? ['universal'] : [target.arch];
        const built = ymlTargets(yml, name);
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
