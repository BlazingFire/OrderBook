#!/usr/bin/env node
/**
 * Build both panels' setup files for one OS and publish them to the releases
 * folder.
 *
 *   npm run release              -- current version, both panels, this OS
 *   npm run release -- 1.1.0     -- bump every package.json first
 *   npm run release -- --panel office
 *   npm run release -- --os mac  -- macOS .dmg (only runs on a Mac)
 *
 * The output folder is the whole distribution story: copy it to the Master PC
 * and the Master installs its own build from it and serves the office build to
 * every panel over the LAN. There is no update server, because this network has
 * no internet — see `master/src/services/update.service.ts`.
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
 *    invented here: `postgres-server.ts:52` has always looked there first, with
 *    the comment *"Binaries bundled into the packaged app"*. The folder simply
 *    never existed.
 *  - **`latest.json` carries a SHA-256.** Nothing runs a setup file that has not
 *    matched it, on either panel. A 100 MB file copied over a shop network or a
 *    USB stick is exactly the file that arrives truncated.
 */

import { createHash, createPrivateKey, sign as nodeSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * What each target OS needs, keyed by the `--os` name a person types.
 *
 * `builderFlag` is the switch electron-builder takes; `platform` is Node's own
 * `process.platform`, which is what goes in the manifest and what a running
 * panel compares against. `postgres` names the `@embedded-postgres` package
 * holding that OS's server binaries — the Master vendors them, and getting this
 * wrong ships a Mac build that cannot start its own database.
 *
 * **A build only runs on its own OS.** electron-builder refuses a macOS target
 * anywhere but macOS ("Build for macOS is supported only on macOS"), because a
 * .dmg is made with `hdiutil` and code signing needs the keychain. There is no
 * cross-compile to add here; the check below just says so before an hour of
 * staging rather than after.
 */
const TARGETS = {
  win: {
    builderFlag: '--win',
    platform: 'win32',
    ext: 'exe',
    postgres: ['windows-x64'],
    buildsOn: ['win32'],
  },
  mac: {
    builderFlag: '--mac',
    platform: 'darwin',
    // `arch: [universal]` in the yml, so one file covers Intel and Apple
    // silicon — but the PostgreSQL binaries are per-architecture and the
    // package for this machine's own arch is the one that must be vendored.
    ext: 'dmg',
    postgres: [`darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`],
    buildsOn: ['darwin'],
  },
  linux: {
    builderFlag: '--linux',
    platform: 'linux',
    ext: 'AppImage',
    postgres: [`linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`],
    buildsOn: ['linux'],
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
  const files = [
    'package.json',
    'shared/package.json',
    'ui/package.json',
    'master/package.json',
    'master/web/package.json',
    'office/package.json',
    'office/web/package.json',
  ];

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
  // `signed-fields.test.ts` pins the two against each other.
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

/**
 * Copy the PostgreSQL server binaries into the path the Master already looks in.
 *
 * `native/` holds `bin`, `lib` and `share` — all three are needed: `initdb`
 * reads its templates out of `share`, and dropping it produces a cluster that
 * cannot be created with an error that names none of this.
 */
async function vendorPostgres() {
  const source = path.join(ROOT, 'node_modules', '@embedded-postgres', 'windows-x64', 'native');
  const target = path.join(ROOT, 'master', 'vendor', 'postgres');

  try {
    await stat(path.join(source, 'bin'));
  } catch {
    throw new Error(
      `PostgreSQL binaries are missing from ${source}.\n` +
        'npm blocks the postinstall that downloads them; run:\n' +
        '  npm install-scripts approve @embedded-postgres/windows-x64',
    );
  }

  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  console.log(`  vendored PostgreSQL into ${path.relative(ROOT, target)}`);
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
       * binaries from `vendor/postgres` — which `postgres-server.ts:52` looks in
       * first, and which `vendorPostgres()` above fills. Shipping both would put
       * 100 MB in the installer twice.
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
    await cp(path.join(panelRoot, part), path.join(staging, part), { recursive: true });
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
  run('npx', ['tsc', '-p', path.join('electron', 'tsconfig.json')]);
  const shellDist = path.join(panelRoot, 'electron', 'dist');
  await rm(shellDist, { recursive: true, force: true });
  await cp(path.join(ROOT, 'electron', 'dist'), shellDist, { recursive: true });

  if (config.vendorPostgres) await vendorPostgres();
  if (!config.serverless) await stage(panel);

  /*
   * `electronVersion` is passed rather than written into the yml.
   *
   * electron-builder looks for Electron in the *panel's* package.json, and it
   * is a devDependency of the workspace root — one copy for both panels, which
   * is the right place for a 270 MB toolchain. Telling it the version outright
   * is cheaper than installing Electron twice, and reading it from the
   * installed package means the two can never drift.
   */
  const electronVersion = (
    await readJson(path.join(ROOT, 'node_modules', 'electron', 'package.json'))
  ).version;

  run(
    'npx',
    [
      'electron-builder',
      RELEASE_TARGET.builderFlag,
      '--config',
      'electron-builder.yml',
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
  const expected = `OrderBook-${config.artifact ?? config.label}-${version}-Setup.${RELEASE_TARGET.ext}`;
  const files = await readdir(outDir);

  if (!files.includes(expected)) {
    throw new Error(
      `electron-builder did not produce ${expected} in ${outDir}.
It built: ${files.join(', ')}`,
    );
  }

  return path.join(outDir, expected);
}

async function publish(panel, version, setupPath, notes) {
  const config = PANELS[panel];
  const target = path.join(RELEASES_DIR, config.folder);
  await mkdir(target, { recursive: true });

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
   * above. It is built on request: `npm run release -- --panel cleaner`.
   */
  const panels = only ? [only] : Object.keys(PANELS).filter((name) => PANELS[name].publish !== false);

  for (const panel of panels) {
    if (!PANELS[panel]) {
      throw new Error(`Unknown target "${panel}" — expected ${Object.keys(PANELS).join(', ')}`);
    }
  }

  console.log(`Releasing ${version} to ${RELEASES_DIR}`);
  run('npm', ['run', 'build:shared']);

  for (const panel of panels) {
    const setupPath = await build(panel, version);
    if (PANELS[panel].publish === false) {
      console.log(`  built ${path.relative(ROOT, setupPath)} (not published — hand it over directly)`);
      continue;
    }
    await publish(panel, version, setupPath, notes);
  }

  console.log(`\nDone. Copy ${RELEASES_DIR} to the Master PC to publish these builds.`);
}

main().catch((error) => {
  console.error(`\nRelease failed: ${error.message}`);
  process.exit(1);
});
