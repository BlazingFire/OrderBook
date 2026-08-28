#!/usr/bin/env node
/**
 * Build both panels' Windows setup files and publish them to the releases
 * folder.
 *
 *   npm run release              -- current version, both panels
 *   npm run release -- 1.1.0     -- bump every package.json first
 *   npm run release -- --panel office
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

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
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
};

const args = process.argv.slice(2);
const only = args.includes('--panel') ? args[args.indexOf('--panel') + 1] : null;
const requestedVersion = args.find((arg) => /^\d+\.\d+\.\d+$/.test(arg)) ?? null;

function run(command, commandArgs, cwd = ROOT) {
  console.log(`  $ ${command} ${commandArgs.join(' ')}`);
  execFileSync(command, commandArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
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

async function sha256(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve);
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

  return output
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
    .filter((line) => !line.includes(`${path.sep}@embedded-postgres${path.sep}`));
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

  console.log(`\n== ${config.label} Panel ${version} ==`);

  run('npm', ['run', 'build', '--workspace', `@orderbook/${panel}`]);

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
  await stage(panel);

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
      '--win',
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
  const expected = `OrderBook-${config.label}-${version}-Setup.exe`;
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
  const manifest = {
    panel,
    version,
    file,
    sizeBytes: size,
    sha256: await sha256(setupPath),
    releasedAt: new Date().toISOString(),
    ...(notes ? { notes } : {}),
  };

  // Written last, on purpose. It is the file both panels look for, so a build
  // interrupted halfway leaves the previous release intact rather than a
  // manifest pointing at a setup file that is still being copied.
  await writeFile(path.join(target, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`  published ${file} (${(size / 1024 / 1024).toFixed(0)} MB) to ${target}`);
}

async function main() {
  if (requestedVersion) await setVersion(requestedVersion);
  const version = await currentVersion();

  const notes = process.env.ORDERBOOK_RELEASE_NOTES ?? '';
  const panels = only ? [only] : Object.keys(PANELS);

  for (const panel of panels) {
    if (!PANELS[panel]) throw new Error(`Unknown panel "${panel}" — expected master or office`);
  }

  console.log(`Releasing ${version} to ${RELEASES_DIR}`);
  run('npm', ['run', 'build:shared']);

  for (const panel of panels) {
    const setupPath = await build(panel, version);
    await publish(panel, version, setupPath, notes);
  }

  console.log(`\nDone. Copy ${RELEASES_DIR} to the Master PC to publish these builds.`);
}

main().catch((error) => {
  console.error(`\nRelease failed: ${error.message}`);
  process.exit(1);
});
