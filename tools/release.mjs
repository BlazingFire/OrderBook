#!/usr/bin/env node
/**
 * Build both panels' setup files for one OS and publish them to the releases
 * folder.
 *
 *   npm run release              -- current version, both panels, this OS
 *   npm run release -- 1.1.0     -- bump every package.json first
 *   npm run release -- --panel office
 *   npm run release -- --os mac  -- macOS .dmg (only runs on a Mac)
 *   npm run release -- --os linux -- x64 AppImage (the Master only on x64 Linux)
 *   npm run release -- --os win7 -- the Windows 7 Office Panel (Electron 22, x64 + ia32);
 *                                   Office only, on Windows (docs/WINDOWS7.md)
 *   npm run release -- --catalogue D:\OrderBook-Products-x.zip
 *                                -- ship this product backup as the catalogue a new
 *                                   install loads (also ORDERBOOK_CATALOGUE_ZIP)
 *
 * The output folder is the whole distribution story: copy it to the Master PC
 * and the Master installs its own build from it and serves the office build to
 * every panel over the LAN — see `master/src/services/update.service.ts`. The
 * Release workflow (`.github/workflows/release.yml`) runs this once per OS and
 * uploads its output to a GitHub Release; a Master configured with
 * `ORDERBOOK_RELEASES_GITHUB_REPO` fetches each manifest there, and the setup
 * file it names, into that folder itself (`docs/UPDATES.md`). A site with no
 * internet copies the folder by hand.
 *
 * Each panel comes out as one setup file and nothing else: the `-Setup.exe`
 * on Windows, the `-Setup.AppImage` on Linux, the `-Setup.dmg` on macOS. There
 * is no Standalone `.exe` and no `.deb` (owner's decision, 2026-10-04): the
 * update path knows the setup file, and the manifest names it.
 *
 * Three things here are not obvious and are the reason this is a script rather
 * than a line in `package.json`:
 *
 *  - **The staging folder is assembled by hand.** electron-builder is very good
 *    at packaging an Electron app and has no idea what to do with a Node server
 *    that must stay unpacked, read fonts from disk, and `execFile` a PostgreSQL
 *    binary. So the panel is staged as plain files and handed over as
 *    `extraResources`.
 *  - **PostgreSQL is vendored into `master/vendor/postgres`.** That path is not
 *    invented here: `candidateBinDirs()` in `master/src/db/postgres-server.ts`
 *    looks there before anywhere else, under *"Binaries bundled into the
 *    packaged app"* — `vendor/postgres/<arch>/bin` for the universal macOS
 *    build, then `vendor/postgres/bin` for every other target.
 *  - **`latest.json` carries a SHA-256.** Nothing runs a setup file that has not
 *    matched it, on either panel. A 100 MB file copied over a shop network or a
 *    USB stick is exactly the file that arrives truncated.
 */

import { createHash, createPrivateKey, sign as nodeSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yauzl from 'yauzl';

import { LEGACY_ELECTRON } from './legacy-electron.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RELEASES_DIR =
  process.env.ORDERBOOK_RELEASES_DIR ?? path.join(path.parse(ROOT).root, 'OrderBook-Releases');

const PANELS = {
  master: {
    dir: 'master',
    folder: 'master-panel',
    label: 'Master',
    /** 100 MB of server binaries the Master `execFile`s. Never bundled. */
    vendorPostgres: true,
    /** The four SIL OFL faces; `assertFontsPresent()` refuses to start without them. */
    extras: ['assets'],
    /**
     * Stages binaries built for one architecture: `sharp`'s platform packages
     * from the production tree, and the vendored PostgreSQL. It is what makes
     * `assertHostArch()` refuse a run on a machine of another architecture.
     * The Office panel's tree is plain JavaScript and the clean-install tool
     * stages nothing, so neither is marked; `packaging-invariants.test.ts`
     * holds the mark to what `npm ls` finds in each panel's tree.
     */
    native: true,
  },
  office: {
    dir: 'office',
    folder: 'office-panel',
    label: 'Office',
    vendorPostgres: false,
    extras: [],
  },
  /*
   * The standalone clean-install tool. Not a panel, and the flags say so.
   *
   * It ships no server: no `dist`, no `web/dist`, no production dependency
   * tree, no PostgreSQL. Its `extraResources` carry the two uninstall scripts
   * and one static HTML page, both declared in its own
   * `electron-builder.yml`, so there is nothing for `stage()` to assemble.
   *
   * It is also NOT published into the releases folder. That folder is what a
   * Master serves to its panels over the LAN, and every file in it is
   * something a panel may be told to install — a tool that erases the machine
   * has no business in that stream. It is handed over deliberately, on a USB
   * stick or a download, which is the only way it is ever wanted.
   */
  cleaner: {
    dir: 'cleaner',
    folder: null,
    label: 'Clean Install',
    vendorPostgres: false,
    extras: [],
    /** No server to compile, and nothing to stage. */
    serverless: true,
    /** Kept out of the releases folder — see above. */
    publish: false,
    artifact: 'CleanInstall',
  },
};

const args = process.argv.slice(2);
const only = args.includes('--panel') ? args[args.indexOf('--panel') + 1] : null;
const requestedVersion = args.find((arg) => /^\d+\.\d+\.\d+$/.test(arg)) ?? null;

/**
 * A product backup zip (Products > Sub products > Backup products on a Master)
 * to ship as the catalogue a new install loads on its first boot
 * (`loadShippedCatalogue` in `master/src/services/product-zip.service.ts`), so
 * a build carries the company's current product database. Checked before
 * anything is built, and copied to `SHIPPED_CATALOGUE` before staging; without
 * it, whatever `master/assets/catalogue` holds ships as it is. The copy is
 * git-ignored: committing one is the owner's call. `--catalogue` with no file
 * after it is refused, not ignored.
 */
const catalogueFlag = args.includes('--catalogue') ? (args[args.indexOf('--catalogue') + 1] ?? '') : null;
const SHIPPED_CATALOGUE = path.join(ROOT, 'master', 'assets', 'catalogue', 'products.zip');

/**
 * What each target OS needs, keyed by the `--os` name a person types.
 *
 * `builderFlag` is the switch electron-builder takes; `platform` is Node's own
 * `process.platform`, which is what goes in the manifest and what a running
 * panel compares against. `postgres` names the `@embedded-postgres` package
 * holding that OS's server binaries — the Master vendors them, and getting this
 * wrong ships a Mac build that cannot start its own database. It is always
 * spelled out, never derived from the machine running this script: the ymls
 * decide which architecture is built, not the build host.
 *
 * **A build only runs on its own OS.** electron-builder refuses a macOS target
 * anywhere but macOS ("Build for macOS is supported only on macOS"), because a
 * .dmg is made with `hdiutil` and code signing needs the keychain. There is no
 * cross-compile to add here; the check below just says so before an hour of
 * staging rather than after.
 *
 * **And a single-architecture Master only builds on that architecture.**
 * `arch` is the one the ymls build (`arch: [x64]` under `win:` and `linux:`).
 * Staging copies the build machine's own native packages — npm installs a
 * platform package only when its `cpu` matches — so an arm64 machine building
 * the x64 AppImage would ship arm64 `sharp` and find no x64 PostgreSQL to
 * vendor (`assertHostArch()`). The Office panel and the clean-install tool
 * carry nothing native and build their x64 files on any machine. The macOS
 * target builds `universal` instead and fetches the other half itself.
 *
 * The Windows 7 build, `win7`, is the one target that is not an OS of its own,
 * and the optional fields are its. `panels` limits what it builds (the Office
 * only: the Master needs Windows 10, because PostgreSQL 17 does not run on
 * Windows 7). `config` names its own yml, `electron` the Electron it ships on
 * instead of the installed one, and `tag` goes into every file name after the
 * panel (`OrderBook-Office-Win7-<v>-Setup.exe`), which is also how the Master's
 * folder sweep tells the two Windows builds apart. `legacyShell` stages the
 * CommonJS build of the shell (`electron/tsconfig.legacy.json`). `archs` is
 * every architecture its yml builds, where that is more than `arch`.
 */
const TARGETS = {
  win: {
    builderFlag: '--win',
    platform: 'win32',
    ext: 'exe',
    arch: 'x64',
    postgres: ['windows-x64'],
    buildsOn: ['win32'],
  },
  mac: {
    builderFlag: '--mac',
    platform: 'darwin',
    // `arch: [universal]` in the yml, so one file covers Intel and Apple
    // silicon — which means *both* architectures' PostgreSQL binaries have to
    // ship. `extraResources` is copied identically into both halves of the
    // merge, so vendoring only the build machine's arch produces an app that
    // starts everywhere and can create a database on half of it.
    ext: 'dmg',
    postgres: ['darwin-x64', 'darwin-arm64'],
    buildsOn: ['darwin'],
    /**
     * Both architectures of every native package ship, not just the build
     * machine's — see `ensureUniversalPackages()`. electron-builder packs the
     * app twice and merges; everything staged under `Contents/Resources/panel`
     * is identical in both halves, so it has to already hold what each
     * architecture needs.
     */
    universal: true,
  },
  linux: {
    builderFlag: '--linux',
    platform: 'linux',
    ext: 'AppImage',
    arch: 'x64',
    postgres: ['linux-x64'],
    buildsOn: ['linux'],
  },
  win7: {
    builderFlag: '--win',
    // Not a `process.platform`: the update channel the Windows 7 Office asks
    // for (`releasePlatformFor()` in shared/src/domain/version.ts), so the
    // manifest is `latest-win7.json` and never the Windows 10 one.
    platform: 'win7',
    ext: 'exe',
    // The Office stages nothing native, so `assertHostArch()` never refuses it;
    // `archs` is what electron-builder.legacy.yml builds into each file.
    arch: 'x64',
    archs: ['x64', 'ia32'],
    postgres: [],
    buildsOn: ['win32'],
    panels: ['office'],
    config: 'electron-builder.legacy.yml',
    electron: LEGACY_ELECTRON,
    legacyShell: true,
    tag: 'Win7',
  },
};

/** The `--os` name for the machine this is running on. */
function hostTarget() {
  const found = Object.entries(TARGETS).find(([, target]) =>
    target.buildsOn.includes(process.platform),
  );
  if (!found) throw new Error(`No release target builds on ${process.platform}`);
  return found[0];
}

const osName = args.includes('--os') ? args[args.indexOf('--os') + 1] : hostTarget();
const RELEASE_TARGET = TARGETS[osName];

/**
 * Checked from `main`, not at import, so a bad `--os` prints the same
 * `Release failed: …` line every other refusal here does rather than a stack
 * trace from module evaluation.
 */
function assertTarget() {
  if (!RELEASE_TARGET) {
    throw new Error(`Unknown --os "${osName}" — expected ${Object.keys(TARGETS).join(', ')}`);
  }

  if (!RELEASE_TARGET.buildsOn.includes(process.platform)) {
    throw new Error(
      [
        `A ${osName} release can only be built on ${RELEASE_TARGET.buildsOn.join(' or ')}, ` +
          `and this is ${process.platform}.`,
        'electron-builder has no cross-compile for it: a .dmg is made with hdiutil and',
        "signed against the machine's keychain, neither of which exists off macOS.",
      ].join('\n'),
    );
  }
}

/**
 * Refuse a single-architecture target on a machine of another architecture,
 * when a panel in this run would carry that machine's binaries.
 *
 * Only a `native` panel (the Master) stages anything built for one
 * architecture, so only a run that includes one is refused. The Office panel
 * and the clean-install tool build their x64 files on an arm64 machine as well
 * as on any other: electron-builder fetches the Electron for the target, and
 * nothing else they carry is native. Checked before the first command, as
 * `assertTarget()` is, so the refusal comes up front rather than an hour later
 * as "binaries are missing".
 */
function assertHostArch(panels) {
  // A universal target has no `arch`: either kind of Mac builds both halves.
  if (!RELEASE_TARGET.arch || process.arch === RELEASE_TARGET.arch) return;

  const native = panels.filter((panel) => PANELS[panel].native);
  if (native.length === 0) return;

  const labels = native.map((panel) => PANELS[panel].label).join(' and ');
  throw new Error(
    [
      `A ${osName} release is built for ${RELEASE_TARGET.arch} only, and this machine is ${process.arch}.`,
      `Staging copies this machine's own native packages (sharp, PostgreSQL) into the ${labels},`,
      `so the ${RELEASE_TARGET.arch} app would carry ${process.arch} binaries. Build it on an ${RELEASE_TARGET.arch} machine;`,
      '`--panel office` builds the Office panel here, which carries nothing native.',
    ].join('\n'),
  );
}

/**
 * A zip the restore would read: one `products.csv`, at any depth (a person may
 * zip the folder). A broken one would fail on every new install's first boot.
 */
async function assertCatalogueZip(file) {
  if (!file || !existsSync(file)) throw new Error(`--catalogue: ${file || '(no file named)'} does not exist`);
  const names = await new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(new Error(`--catalogue: ${file} is not a zip (${error?.message ?? 'unreadable'})`));
        return;
      }
      const found = [];
      zip.on('entry', (entry) => {
        found.push(entry.fileName);
        zip.readEntry();
      });
      zip.once('end', () => {
        zip.close();
        resolve(found);
      });
      zip.once('error', reject);
      zip.readEntry();
    });
  });
  // yauzl reads a backslash in a name as a slash, so a Compress-Archive zip passes too.
  if (!names.some((name) => name.split('/').pop().toLowerCase() === 'products.csv')) {
    throw new Error(`--catalogue: ${file} has no products.csv, so it is not a product backup`);
  }
}

function run(command, commandArgs, cwd = ROOT) {
  console.log(`  $ ${command} ${commandArgs.join(' ')}`);
  execFileSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * One version across every package.
 *
 * The panels report their versions to each other and compare them; two packages
 * that disagree would have a panel calling itself behind a Master it is
 * identical to.
 */
async function setVersion(version) {
  // Every workspace, read from the root manifest rather than listed here: a
  // hand-written list once left out `cleaner/`, whose electron-builder names
  // its file from its own package.json, so a bumped release could not find
  // the file it had just built.
  const { workspaces } = await readJson(path.join(ROOT, 'package.json'));
  const files = ['package.json', ...workspaces.map((dir) => `${dir}/package.json`)];

  for (const relative of files) {
    const file = path.join(ROOT, relative);
    const manifest = await readJson(file);
    manifest.version = version;
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  console.log(`Version set to ${version} across ${files.length} packages`);
}

async function currentVersion() {
  return (await readJson(path.join(ROOT, 'package.json'))).version;
}

/**
 * Sign a manifest with the release key, if this machine has one.
 *
 * The signature is what tells an installed copy that *we* published this build,
 * which a SHA-256 published beside its own file cannot say. Panels refuse an
 * unsigned release by default, so in practice a machine without the key can
 * still produce a folder for an air-gapped site and cannot produce one anybody
 * will install over the network — which is the right way round.
 *
 * The private key never leaves the release machine. `ORDERBOOK_RELEASE_KEY`
 * points at the PEM written by `npm run release:keygen`.
 */
function sign(manifest) {
  const keyPath = process.env.ORDERBOOK_RELEASE_KEY;
  const keyId = process.env.ORDERBOOK_RELEASE_KEY_ID;

  if (!keyPath) {
    console.warn(
      '  ! ORDERBOOK_RELEASE_KEY is not set — publishing UNSIGNED.\n' +
        '    Panels refuse unsigned releases unless a machine sets\n' +
        '    ORDERBOOK_ALLOW_UNSIGNED_RELEASES=1. Run: npm run release:keygen',
    );
    return manifest;
  }

  if (!keyId) throw new Error('ORDERBOOK_RELEASE_KEY is set but ORDERBOOK_RELEASE_KEY_ID is not');

  const privateKey = createPrivateKey(readFileSync(path.resolve(keyPath), 'utf8'));

  // The exact bytes `shared/src/domain/release-signature.ts` defines. Kept in
  // step by hand here because this script must run before anything is built —
  // `master/tests/release-signed-fields.test.ts` pins the two against each other.
  const SIGNED_FIELDS = [
    'panel',
    'platform',
    'version',
    'file',
    'sizeBytes',
    'sha256',
    'releasedAt',
  ];
  const payload = SIGNED_FIELDS.map((field) =>
    field === 'sha256'
      ? `${field}=${String(manifest[field]).toLowerCase()}`
      : `${field}=${String(manifest[field])}`,
  ).join('\n');

  return {
    ...manifest,
    keyId,
    signature: nodeSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
  };
}

async function sha256(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}

/** A lockfile key or tree path naming a single-architecture macOS package. */
const DARWIN_ARCH = /(^|[-/])darwin-(arm64|x64)$/;

/**
 * Put both macOS architectures of every production native package on disk.
 *
 * npm installs an optional platform package only when its `cpu` matches the
 * machine, so an Apple silicon build machine has `@img/sharp-darwin-arm64` and
 * `@embedded-postgres/darwin-arm64` and neither Intel counterpart. A universal
 * app made from that tree starts on an Intel Mac and fails the first time it
 * decodes a photo (`sharp` loads `@img/sharp-<platform>-<arch>`), and
 * `vendorPostgres()` refuses to run without both `darwin-*` PostgreSQL
 * packages.
 *
 * Every non-dev `…darwin-arm64` / `…darwin-x64` package the lockfile pins is
 * fetched at its pinned version if it is missing — `npm pack`, then unpacked
 * where npm would have put it — and its postinstall runs only if the root
 * `allowScripts` approves that exact package and version, the same gate
 * `npm install` applies. Needs the network, as every release build already
 * does for electron-builder's toolchain.
 */
function ensureUniversalPackages() {
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const allow = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).allowScripts ?? {};

  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const name = key.slice('node_modules/'.length);
    // Top-level installs only; a nested copy is some other package's business.
    if (!key.startsWith('node_modules/') || name.includes('node_modules/')) continue;
    if (!DARWIN_ARCH.test(name) || entry.dev) continue;

    const dir = path.join(ROOT, 'node_modules', ...name.split('/'));
    const installed = path.join(dir, 'package.json');
    // Present at the pinned version is done; present at any other version is
    // a stale copy from an older lockfile and is replaced.
    if (existsSync(installed)) {
      if (JSON.parse(readFileSync(installed, 'utf8')).version === entry.version) continue;
      rmSync(dir, { recursive: true, force: true });
    }

    const tarball = execFileSync('npm', ['pack', `${name}@${entry.version}`, '--silent'], {
      cwd: tmpdir(),
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })
      .trim()
      .split(/\r?\n/)
      .pop();
    const tarballPath = path.join(tmpdir(), tarball);
    mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-xzf', tarballPath, '-C', dir, '--strip-components=1']);
    rmSync(tarballPath, { force: true });

    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const postinstall = manifest.scripts?.postinstall;
    if (postinstall) {
      // Refused rather than skipped: `@embedded-postgres/*` recreates its
      // library links in this script, and a package without them builds
      // cleanly and fails on the customer's first boot.
      if (allow[`${name}@${entry.version}`] !== true) {
        throw new Error(
          `${name}@${entry.version} needs its postinstall and package.json allowScripts does not approve it`,
        );
      }
      execFileSync(postinstall, { cwd: dir, shell: true, stdio: 'inherit' });
    }
    console.log(`  fetched ${name}@${entry.version} for the universal build`);
  }
}

/**
 * The other-architecture twin of every macOS platform package in `tree`.
 *
 * `npm ls` reports the packages npm resolved for this machine's `cpu`, so the
 * production tree names `sharp-darwin-arm64` and not its Intel twin even once
 * `ensureUniversalPackages()` has put that twin on disk. Staging both is what
 * lets `sharp` (and anything like it) find its binary on either kind of Mac.
 */
function universalSiblings(tree) {
  const have = new Set(tree);
  const siblings = [];
  for (const source of tree) {
    const match = DARWIN_ARCH.exec(source);
    if (!match) continue;
    const other = match[2] === 'arm64' ? 'x64' : 'arm64';
    const twin = source.slice(0, match.index + match[1].length) + `darwin-${other}`;
    if (have.has(twin)) continue;
    if (!existsSync(twin)) {
      throw new Error(`${path.relative(ROOT, twin)} is missing — the universal build needs both architectures`);
    }
    have.add(twin);
    siblings.push(twin);
  }
  return siblings;
}

/**
 * Copy the PostgreSQL server binaries into the path the Master already looks in.
 *
 * `native/` holds `bin`, `lib` and `share` — all three are needed: `initdb`
 * reads its templates out of `share`, and dropping it produces a cluster that
 * cannot be created with an error that names none of this.
 *
 * The packages come from `RELEASE_TARGET.postgres`, which is why the shape of
 * the vendored tree depends on the target rather than on the build host:
 *
 * - one package  → `master/vendor/postgres/{bin,lib,share}`
 * - two packages → `master/vendor/postgres/<arch>/{bin,lib,share}`
 *
 * macOS is the two-package case. `arch: [universal]` produces one app that
 * runs on both Intel and Apple silicon, but `extraResources` is copied
 * identically into both halves of the merge, so the staged tree has to hold
 * whatever each architecture needs. `candidateBinDirs()` in
 * `master/src/db/postgres-server.ts` looks under `process.arch` first for
 * exactly this layout. (In 17.10.0-beta.17 the two `darwin-*` packages ship
 * byte-identical universal binaries, so this carries the same ~130 MB twice;
 * vendoring one when the trees match is a size saving still to take.)
 */
async function vendorPostgres() {
  const packages = RELEASE_TARGET.postgres;
  const target = path.join(ROOT, 'master', 'vendor', 'postgres');
  await rm(target, { recursive: true, force: true });

  for (const pkg of packages) {
    const source = path.join(ROOT, 'node_modules', '@embedded-postgres', pkg, 'native');

    try {
      await stat(path.join(source, 'bin'));
    } catch {
      throw new Error(
        `PostgreSQL binaries are missing from ${source}.\n` +
          'npm blocks the postinstall that hydrates them; run:\n' +
          `  npm install-scripts approve @embedded-postgres/${pkg}`,
      );
    }

    // One package keeps today's flat layout; two get an arch level, named for
    // `process.arch` rather than the package so the runtime lookup matches.
    const arch = pkg.slice(pkg.indexOf('-') + 1);
    const dest = packages.length === 1 ? target : path.join(target, arch);
    // `verbatimSymlinks`, because `native/lib` is mostly SONAME symlinks
    // (`libpq.so.5 -> libpq.so.5.17`) and `cp` otherwise rewrites each one as
    // an absolute path into *this machine's* node_modules. The build machine
    // still resolves them, so the packaged app works where it was built and
    // cannot load its own libraries anywhere else; the macOS universal merge
    // is where that first showed, refusing to pair files that resolved
    // outside the app.
    await cp(source, dest, { recursive: true, verbatimSymlinks: true });
    await assertUsablePostgres(dest, pkg);
    console.log(`  vendored ${pkg} into ${path.relative(ROOT, dest)}`);
  }
}

/**
 * Fail the build rather than the shop's first boot.
 *
 * Every way this copy can go wrong — the wrong package, a `share/` that did
 * not come along, binaries that lost their executable bit passing through a
 * zip or a Windows checkout — surfaces at runtime as `initdb` failing with a
 * message that names none of it, on a machine with no developer on it. Here it
 * costs a `stat` per file.
 */
async function assertUsablePostgres(dir, pkg) {
  const exe = RELEASE_TARGET.platform === 'win32' ? '.exe' : '';

  for (const name of ['initdb', 'pg_ctl', 'postgres']) {
    const file = path.join(dir, 'bin', `${name}${exe}`);
    let info;
    try {
      info = await stat(file);
    } catch {
      throw new Error(`${pkg} vendored without ${name}${exe} — expected ${file}`);
    }
    // 0o111 is the three executable bits. Windows has no such bit and reports
    // them set, so this is a real check on macOS and Linux and a no-op on win32.
    if (exe === '' && (info.mode & 0o111) === 0) {
      throw new Error(`${file} is not executable (mode ${(info.mode & 0o777).toString(8)})`);
    }
  }

  /*
   * Every library link the package declares, present and resolving.
   *
   * `postgres` links against the link names (`libzstd.1.dylib`,
   * `libpq.so.5`), not the files they point at, so a tree whose links were
   * never recreated, or were rewritten to a path on this machine, still has
   * a `bin/` and a `share/` and fails only at runtime. `existsSync` follows
   * the link, so a dangling one reads as missing.
   */
  const links = JSON.parse(
    await readFile(path.join(dir, 'pg-symlinks.json'), 'utf8').catch(() => '[]'),
  );
  for (const { target } of links) {
    const link = path.join(dir, target.replace(/^native\//, ''));
    if (!existsSync(link)) {
      throw new Error(`${pkg} vendored without the library link ${path.relative(dir, link)}`);
    }
  }

  const share = await readdir(path.join(dir, 'share')).catch(() => []);
  if (share.length === 0) {
    throw new Error(
      `${pkg} vendored without share/ — initdb reads its templates from there ` +
        'and fails with an error that names none of this.',
    );
  }
}

/**
 * The production dependency tree for one panel, as absolute paths.
 *
 * `npm ls` reports what is **already installed** rather than resolving afresh,
 * so the setup file ships exactly the tree the tests ran against — the reason
 * not to run a second `npm ci --omit=dev` into a scratch folder.
 *
 * The alternative, copying `node_modules` wholesale, was measured: it produced
 * a 223 MB setup file for a panel whose entire runtime is Express, Multer and
 * a socket client. Most of that was five platforms' PostgreSQL binaries, a
 * PDF-rendering canvas used by one test, and the build toolchain.
 */
async function productionTree(panel) {
  const output = execFileSync(
    'npm',
    ['ls', '--omit=dev', '--all', '--parseable', '--workspace', `@orderbook/${panel}`],
    { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' },
  );

  const modules = path.join(ROOT, 'node_modules');

  return (
    output
      .split(/\r?\n/)
      .filter((line) => line.startsWith(modules))
      // The workspace packages themselves are links back into this repo; `dist`
      // and `package.json` are copied directly instead.
      .filter((line) => !line.includes(`${path.sep}@orderbook${path.sep}`))
      /*
       * `@embedded-postgres/*` is declared as an optional dependency and is
       * therefore in the production tree, but a packaged Master reads its server
       * binaries from `vendor/postgres` — which `candidateBinDirs()` in
       * `master/src/db/postgres-server.ts` looks in first, and which
       * `vendorPostgres()` above fills. Shipping both would put 100 MB in the
       * installer twice.
       */
      .filter((line) => !line.includes(`${path.sep}@embedded-postgres${path.sep}`))
  );
}

/**
 * Assemble what the setup file will lay down as `resources/panel`.
 */
async function stage(panel) {
  const config = PANELS[panel];
  const panelRoot = path.join(ROOT, config.dir);
  const staging = path.join(panelRoot, 'staging');

  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  const parts = ['dist', 'web/dist', 'package.json', ...config.extras];
  if (config.vendorPostgres) parts.push('vendor');

  for (const part of parts) {
    // `verbatimSymlinks` for the same reason as in `vendorPostgres()`: the
    // vendored libraries' relative links must stay relative on the way into
    // the staging folder, or they point back at `master/vendor` on this disk.
    await cp(path.join(panelRoot, part), path.join(staging, part), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }

  /*
   * One package at a time, from the production tree.
   *
   * `dereference` matters on Windows: npm links workspace packages as symlinks,
   * and recreating a symlink needs Developer Mode or an elevated prompt — a
   * plain copy fails with `EPERM` on a machine with neither. Following them
   * copies real files, which is what a setup file lays down anyway.
   */
  const tree = await productionTree(panel);
  if (RELEASE_TARGET.universal) tree.push(...universalSiblings(tree));
  for (const source of tree) {
    const relative = path.relative(path.join(ROOT, 'node_modules'), source);
    await cp(source, path.join(staging, 'node_modules', relative), {
      recursive: true,
      dereference: true,
    });
  }

  // The built `shared` package as real files, where `@orderbook/shared`
  // resolves to. Its own `node_modules` is left behind — everything it needs is
  // already hoisted above.
  await cp(path.join(ROOT, 'shared'), path.join(staging, 'node_modules', '@orderbook', 'shared'), {
    recursive: true,
    dereference: true,
    filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`),
  });

  console.log(`  staged ${path.relative(ROOT, staging)} (${tree.length} packages)`);
  return staging;
}

async function build(panel, version) {
  const config = PANELS[panel];
  const panelRoot = path.join(ROOT, config.dir);

  console.log(`\n== ${config.label} ${version} ==`);

  // A serverless target has no `dist` or `web/dist` to build.
  if (!config.serverless) run('npm', ['run', 'build', '--workspace', `@orderbook/${panel}`]);

  /*
   * One shell, compiled once, copied into whichever panel is being packaged.
   *
   * Both panels ran a near-identical 300-line `main.ts` of their own until the
   * two drifted — the Office copy spent a minute polling a health route its
   * server did not have. `electron-builder.yml` still ships
   * `electron/dist/**\/*` from the panel folder, so the built shell is copied
   * in rather than the yml learning about a path outside the panel.
   */
  const shellDist = path.join(panelRoot, 'electron', 'dist');
  if (RELEASE_TARGET.legacyShell) {
    /*
     * The Windows 7 build: the same shell compiled to CommonJS, because
     * Electron 22 loads its main script through the CommonJS loader. The
     * panel's package.json says `"type": "module"`, so the `{"type":"commonjs"}`
     * beside the compiled files is what makes Electron 22 read them as
     * CommonJS; the server in `dist` stays ESM. `tools/copy-shell.mjs --legacy`
     * does the same for running from source.
     */
    const legacyOut = path.join(ROOT, 'build', 'shell-legacy');
    await rm(legacyOut, { recursive: true, force: true });
    run('npx', ['tsc', '-p', path.join('electron', 'tsconfig.legacy.json')]);
    await rm(shellDist, { recursive: true, force: true });
    await cp(legacyOut, shellDist, { recursive: true });
    await writeFile(path.join(shellDist, 'package.json'), '{"type":"commonjs"}\n');
  } else {
    run('npx', ['tsc', '-p', path.join('electron', 'tsconfig.json')]);
    await rm(shellDist, { recursive: true, force: true });
    await cp(path.join(ROOT, 'electron', 'dist'), shellDist, { recursive: true });
  }

  if (RELEASE_TARGET.universal) ensureUniversalPackages();
  if (config.vendorPostgres) await vendorPostgres();
  if (!config.serverless) await stage(panel);

  /*
   * `electronVersion` is passed rather than written into the yml.
   *
   * electron-builder looks for Electron in the *panel's* package.json, and it
   * is a devDependency of the workspace root — one copy for both panels, which
   * is the right place for a 270 MB toolchain. Telling it the version outright
   * is cheaper than installing Electron twice, and reading it from the
   * installed package means the two can never drift. The Windows 7 target
   * names its own (`tools/legacy-electron.mjs`), which electron-builder
   * downloads into its cache.
   */
  const electronVersion =
    RELEASE_TARGET.electron ??
    (await readJson(path.join(ROOT, 'node_modules', 'electron', 'package.json'))).version;

  run(
    'npx',
    [
      'electron-builder',
      RELEASE_TARGET.builderFlag,
      '--config',
      RELEASE_TARGET.config ?? 'electron-builder.yml',
      `--config.electronVersion=${electronVersion}`,
    ],
    panelRoot,
  );

  /*
   * Matched on the version, not on "any file ending -Setup.exe".
   *
   * The output folder keeps previous builds, and picking the first match
   * published 1.0.0's bytes under a manifest that said 1.0.1 — an update that
   * installs and leaves the version unchanged, which is close to the worst
   * possible failure here because it looks like the update mechanism is broken
   * rather than the build.
   */
  const outDir = path.join(ROOT, 'build', panel);
  // `artifact` where the folder name and the filename differ: the tool is
  // "Clean Install" to a reader and `CleanInstall` in a filename, because a
  // space in an artifact name is a different kind of trouble on three OSes.
  // The Windows 7 build adds its `tag` after the panel: `Office-Win7`.
  const name = [config.artifact ?? config.label, RELEASE_TARGET.tag].filter(Boolean).join('-');
  const expected = `OrderBook-${name}-${version}-Setup.${RELEASE_TARGET.ext}`;
  const files = await readdir(outDir);

  if (!files.includes(expected)) {
    throw new Error(
      `electron-builder did not produce ${expected} in ${outDir}.
It built: ${files.join(', ')}`,
    );
  }

  return { setup: path.join(outDir, expected) };
}

async function publish(panel, version, built, notes) {
  const config = PANELS[panel];
  const target = path.join(RELEASES_DIR, config.folder);
  await mkdir(target, { recursive: true });

  const setupPath = built.setup;
  const file = path.basename(setupPath);
  await cp(setupPath, path.join(target, file));

  const { size } = await stat(setupPath);
  const manifest = sign({
    panel,
    platform: RELEASE_TARGET.platform,
    version,
    file,
    sizeBytes: size,
    sha256: await sha256(setupPath),
    releasedAt: new Date().toISOString(),
    ...(notes ? { notes } : {}),
  });

  const body = `${JSON.stringify(manifest, null, 2)}\n`;

  /*
   * Written last, on purpose. These are the files both panels look for, so a
   * build interrupted halfway leaves the previous release intact rather than a
   * manifest pointing at a setup file that is still being copied.
   *
   * Two names, and the second is a compatibility shim rather than a duplicate.
   * `latest-<platform>.json` is what a panel built from this change onwards
   * reads, and it is what lets one folder hold a Windows build and a Mac build
   * at once. Plain `latest.json` is the only name panels shipped before this
   * knew, and every one of those is Windows — so the Windows build writes it
   * too, and a Mac build deliberately does not, because overwriting it with a
   * .dmg manifest would break every Windows panel already in the shop. Delete
   * the shim once no pre-platform panel is left in the field.
   */
  await writeFile(path.join(target, `latest-${RELEASE_TARGET.platform}.json`), body);
  if (RELEASE_TARGET.platform === 'win32') {
    await writeFile(path.join(target, 'latest.json'), body);
  }

  console.log(`  published ${file} (${(size / 1024 / 1024).toFixed(0)} MB) to ${target}`);
}

async function main() {
  assertTarget();

  if (requestedVersion) await setVersion(requestedVersion);
  const version = await currentVersion();

  const notes = process.env.ORDERBOOK_RELEASE_NOTES ?? '';
  /*
   * The default is the two panels, not everything in `PANELS`.
   *
   * A plain `npm run release` publishes a folder somebody copies to the Master
   * PC, and the clean-install tool does not belong in it — see its entry
   * above. It is built on request: `npm run release -- --panel cleaner`. A
   * target that builds only some panels (`win7`) defaults to those.
   */
  const panels = only
    ? [only]
    : (RELEASE_TARGET.panels ??
      Object.keys(PANELS).filter((name) => PANELS[name].publish !== false));

  for (const panel of panels) {
    if (!PANELS[panel]) {
      throw new Error(`Unknown target "${panel}" — expected ${Object.keys(PANELS).join(', ')}`);
    }
    if (RELEASE_TARGET.panels && !RELEASE_TARGET.panels.includes(panel)) {
      throw new Error(
        `The ${osName} target builds the Office panel only, not the ${PANELS[panel].label}. ` +
          'The Master needs Windows 10 or later: PostgreSQL 17 does not run on Windows 7.',
      );
    }
  }
  assertHostArch(panels);
  let catalogueZip = catalogueFlag ?? (process.env.ORDERBOOK_CATALOGUE_ZIP || null);
  if (catalogueZip !== null && !panels.includes('master')) {
    // The flag names this run; the variable may be set for every run, Office-only ones included.
    if (catalogueFlag !== null) {
      throw new Error('--catalogue ships with the Master, and this run does not build the Master');
    }
    console.log('  ORDERBOOK_CATALOGUE_ZIP is ignored: this run does not build the Master');
    catalogueZip = null;
  }
  if (catalogueZip !== null) await assertCatalogueZip(catalogueZip);

  console.log(`Releasing ${version} to ${RELEASES_DIR}`);
  run('npm', ['run', 'build:shared']);

  if (catalogueZip) await cp(catalogueZip, SHIPPED_CATALOGUE);
  if (panels.includes('master')) {
    // Said every time: a copy left by an earlier --catalogue run ships too.
    console.log(
      existsSync(SHIPPED_CATALOGUE)
        ? `  catalogue: ${path.relative(ROOT, SHIPPED_CATALOGUE)}${catalogueZip ? ` (from ${catalogueZip})` : ''}`
        : '  catalogue: master/assets/catalogue/swisware-plus-2026.md (no products.zip)',
    );
  }

  for (const panel of panels) {
    const built = await build(panel, version);
    if (PANELS[panel].publish === false && built.setup) {
      console.log(`  built ${path.relative(ROOT, built.setup)} (not published — hand it over directly)`);
      continue;
    }
    await publish(panel, version, built, notes);
  }

  console.log(`\nDone. Copy ${RELEASES_DIR} to the Master PC to publish these builds.`);
}

main().catch((error) => {
  console.error(`\nRelease failed: ${error.message}`);
  process.exit(1);
});
