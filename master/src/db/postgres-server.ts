/**
 * Manages a PostgreSQL cluster that belongs to this application.
 *
 * The shop-floor operator never installs or administers a database: the Master
 * process runs `initdb` on first launch, starts the server as a child process
 * bound to loopback only, and shuts it down again when the app exits. From the
 * user's perspective this is as invisible as a single-file database, but with
 * a full Postgres engine underneath (see docs/schema/00-overview.md §1).
 *
 * Setting DATABASE_URL bypasses all of this and connects to an existing
 * server instead — used in development and for deployments that already run
 * Postgres.
 */

import { execFile, spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('postgres');

const PASSWORD_FILE = 'pg-superuser-password';

/** 4.5 GB: at or below this a PC counts as small, as in `electron/lib/memory.ts`. */
const SMALL_PC_MB = 4608;
/** `postgres.log` is set aside at start once it passes this. */
const PG_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Memory settings for the cluster, as `pg_ctl --options` flags.
 *
 * On a PC with 4.5 GB or less, PostgreSQL's defaults assume memory the window,
 * the server and Windows need: shared buffers, per-sort memory and the
 * planner's idea of the OS cache all come down. `max_connections` drops from
 * the default 100 to 30, which still covers the knex pool (10), a migration
 * or backup connection and the superuser reserve. Bigger PCs keep the
 * defaults apart from a `max_connections` of 40, as there is no use for 100.
 */
export function pgMemoryOptions(totalMb: number): string[] {
  if (totalMb > SMALL_PC_MB) return ['-c max_connections=40'];
  return [
    '-c shared_buffers=64MB',
    '-c work_mem=2MB',
    '-c maintenance_work_mem=32MB',
    '-c effective_cache_size=512MB',
    '-c max_connections=30',
  ];
}

/**
 * Keep one old `postgres.log` and start a fresh one when it has grown past
 * 5 MB. Only at start, before PostgreSQL holds the file open. A log that
 * cannot be moved is left alone rather than stopping the start.
 */
async function rotatePostgresLog(logFile: string): Promise<void> {
  try {
    if ((await fs.stat(logFile)).size < PG_LOG_MAX_BYTES) return;
    await fs.rm(`${logFile}.1`, { force: true });
    await fs.rename(logFile, `${logFile}.1`);
  } catch {
    // Missing (first start) or locked: nothing to do.
  }
}

/**
 * The `@embedded-postgres/*` package directory for this machine.
 *
 * Node reports Windows as `win32`, but the package is published as
 * `windows-x64`. Interpolating `process.platform` directly produced
 * `win32-x64`, which exists nowhere — so on Windows the bundled binaries were
 * never found, the app silently fell through to a system PostgreSQL, and the
 * "nothing to install" promise quietly did not hold. The test helper imports
 * this rather than keeping its own copy, because the copy it used to keep is
 * what drifted.
 */
export function embeddedPostgresPackageDir(): string {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  return `${platform}-${process.arch}`;
}

/** Where to look for initdb/pg_ctl when ORDERBOOK_PG_BIN is not set. */
function candidateBinDirs(): string[] {
  const candidates: string[] = [];

  /*
   * Binaries bundled into the packaged app (production on the shop PC).
   *
   * Two layouts, tried in that order, both written by `vendorPostgres()` in
   * `tools/release.mjs`. A universal macOS build carries both `darwin-*`
   * packages under `vendor/postgres/<arch>/`, because one app file runs on
   * Intel and Apple silicon and nothing guarantees a package's binaries run on
   * both (in 17.10.0-beta.17 each package happens to ship the same universal
   * binaries); every other target vendors one architecture and keeps the flat
   * layout. No platform conditional here: Windows and Linux simply miss the
   * first candidate.
   */
  candidates.push(path.join(config.packageRoot, 'vendor', 'postgres', process.arch, 'bin'));
  candidates.push(path.join(config.packageRoot, 'vendor', 'postgres', 'bin'));

  // `embedded-postgres` ships platform binaries under its package directory.
  // Walking up covers both a local install and hoisting to the workspace root,
  // without hard-coding how deep this package sits in the tree.
  const platformDir = embeddedPostgresPackageDir();
  for (const root of ancestorDirs(config.packageRoot)) {
    candidates.push(
      path.join(root, 'node_modules', '@embedded-postgres', platformDir, 'native', 'bin'),
    );
  }

  // A system installation, if the machine already has one.
  for (const version of ['17', '16', '15', '14']) {
    candidates.push(`/usr/lib/postgresql/${version}/bin`);
    candidates.push(`/usr/pgsql-${version}/bin`);
    candidates.push(`C:\\Program Files\\PostgreSQL\\${version}\\bin`);
  }
  candidates.push('/usr/local/pgsql/bin', '/opt/homebrew/opt/postgresql/bin');

  return candidates;
}

/**
 * Present is not the same as runnable.
 *
 * A vendored tree that passed through a zip, a Windows checkout or a `cp` that
 * dropped the mode bits leaves `pg_ctl` sitting exactly where it belongs with
 * no executable bit. `existsSync` alone calls that directory found, and the
 * failure surfaces later as EACCES from inside `initdb`, on a shop PC, in a
 * message naming none of this. Windows has no such bit and `accessSync`
 * reports X_OK satisfied there, so this costs nothing on win32.
 */
function isExecutable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveBinDir(): string {
  if (config.database.binDir) {
    const pgCtl = path.join(config.database.binDir, binName('pg_ctl'));
    if (!existsSync(pgCtl)) {
      throw new Error(`ORDERBOOK_PG_BIN is set but pg_ctl was not found in ${config.database.binDir}`);
    }
    if (!isExecutable(pgCtl)) {
      throw new Error(`ORDERBOOK_PG_BIN is set but ${pgCtl} is not executable`);
    }
    return config.database.binDir;
  }

  const foundButNotExecutable: string[] = [];

  for (const dir of candidateBinDirs()) {
    const pgCtl = path.join(dir, binName('pg_ctl'));
    if (!existsSync(pgCtl)) continue;
    if (isExecutable(pgCtl)) return dir;
    foundButNotExecutable.push(pgCtl);
  }

  if (foundButNotExecutable.length > 0) {
    throw new Error(
      'Found PostgreSQL binaries that cannot be executed:\n  ' +
        foundButNotExecutable.join('\n  ') +
        '\nRestore the executable bit (chmod +x) on the bin directory, or set ' +
        'ORDERBOOK_PG_BIN to a usable installation.',
    );
  }

  throw new Error(
    'Could not locate PostgreSQL binaries. They normally ship with the app via the ' +
      '@embedded-postgres package for this platform — reinstalling dependencies (npm install) ' +
      'usually fixes this. Otherwise set ORDERBOOK_PG_BIN to a directory containing initdb and ' +
      'pg_ctl, or set DATABASE_URL to use an existing PostgreSQL server.',
  );
}

/** This directory and each parent up to the filesystem root. */
function ancestorDirs(from: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(from);

  for (;;) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

function binName(tool: string): string {
  return process.platform === 'win32' ? `${tool}.exe` : tool;
}

/**
 * PostgreSQL refuses to start as root. Failing here with an explanation beats
 * surfacing initdb's terse error to whoever launched the app with sudo.
 */
function assertNotRoot(): void {
  if (process.platform === 'win32') return;
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error(
      'Refusing to start the database as root — PostgreSQL does not allow it. ' +
        'Run the Master Panel as a normal user account, or set DATABASE_URL to use an existing server.',
    );
  }
}

/**
 * PostgreSQL refuses to open a data directory written by a different major
 * version, and says so only through a terse pg_ctl failure. That situation is
 * reachable in production — upgrading the app can change which bundled major
 * ships with it — so it is detected up front and explained, rather than
 * surfacing as "Command failed: pg_ctl" with the shop's order data apparently
 * unreachable.
 *
 * Nothing is deleted automatically: the existing data directory is the
 * business's records, and recovering it needs `pg_upgrade` or a dump/restore,
 * not a silent wipe.
 */
async function assertClusterVersionMatches(binDir: string, clusterDir: string): Promise<void> {
  const versionFile = path.join(clusterDir, 'PG_VERSION');
  if (!existsSync(versionFile)) return; // First run — nothing to compare against.

  const clusterVersion = (await fs.readFile(versionFile, 'utf8')).trim();
  const serverVersion = await readServerMajorVersion(binDir);
  if (!serverVersion || clusterVersion === serverVersion) return;

  throw new Error(
    `The existing database was created by PostgreSQL ${clusterVersion}, but this ` +
      `installation ships PostgreSQL ${serverVersion}. PostgreSQL cannot open a data ` +
      `directory from a different major version.\n\n` +
      `Your data is intact at ${clusterDir} — nothing has been changed. To continue, either:\n` +
      `  • install PostgreSQL ${clusterVersion} and set ORDERBOOK_PG_BIN to its bin directory, or\n` +
      `  • migrate the data with pg_upgrade, or restore a dump into the new version.`,
  );
}

/** Major version of the server binaries, e.g. "17". Null if it cannot be read. */
async function readServerMajorVersion(binDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(path.join(binDir, binName('postgres')), ['--version']);
    // "postgres (PostgreSQL) 17.10" → "17"
    const match = /PostgreSQL\)?\s+(\d+)/i.exec(stdout);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface PostgresServerHandle {
  connectionUrl: string;
  stop(): Promise<void>;
}

/**
 * When DATABASE_URL is set, this is a no-op wrapper around that connection.
 * Otherwise it ensures a cluster exists, starts it, and ensures the
 * application database is present.
 */
export async function startPostgres(): Promise<PostgresServerHandle> {
  if (config.database.url) {
    log.info('Using external database from DATABASE_URL');
    return { connectionUrl: config.database.url, stop: async () => {} };
  }

  assertNotRoot();

  const binDir = resolveBinDir();
  log.info(`Using PostgreSQL binaries from ${binDir}`);

  const clusterDir = config.database.clusterDir;
  const socketDir = path.join(config.dataDir, 'pg-socket');
  await fs.mkdir(socketDir, { recursive: true });

  await assertClusterVersionMatches(binDir, clusterDir);

  const password = await ensureCluster(binDir, clusterDir);
  await startCluster(binDir, clusterDir, socketDir);
  await ensureApplicationDatabase(password);

  const connectionUrl = buildConnectionUrl(password, config.database.database);

  return {
    connectionUrl,
    stop: async () => {
      await stopCluster(binDir, clusterDir);
    },
  };
}

function buildConnectionUrl(password: string, database: string): string {
  const { user, port } = config.database;
  return `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}

/** Creates the cluster on first run. Returns the superuser password either way. */
async function ensureCluster(binDir: string, clusterDir: string): Promise<string> {
  const passwordPath = path.join(config.dataDir, PASSWORD_FILE);

  if (existsSync(path.join(clusterDir, 'PG_VERSION'))) {
    return (await fs.readFile(passwordPath, 'utf8')).trim();
  }

  log.info('First run — creating the database cluster (this happens once)');

  const password = randomBytes(24).toString('base64url');
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(passwordPath, password, { mode: 0o600 });

  const pwfilePath = path.join(config.dataDir, 'pg-initdb-password.tmp');
  await fs.writeFile(pwfilePath, password, { mode: 0o600 });

  try {
    await execFileAsync(path.join(binDir, binName('initdb')), [
      '--pgdata',
      clusterDir,
      '--username',
      config.database.user,
      '--pwfile',
      pwfilePath,
      '--encoding',
      'UTF8',
      '--auth-local',
      'trust',
      '--auth-host',
      'scram-sha-256',
    ]);
  } finally {
    await fs.rm(pwfilePath, { force: true });
  }

  log.info('Database cluster created');
  return password;
}

async function startCluster(binDir: string, clusterDir: string, socketDir: string): Promise<void> {
  if (await isClusterRunning(binDir, clusterDir)) {
    log.info('Database cluster already running');
    return;
  }

  const serverOptions = [`-p ${config.database.port}`, `-h 127.0.0.1`];
  if (process.platform !== 'win32') serverOptions.push(`-k ${socketDir}`);
  serverOptions.push(...pgMemoryOptions(Math.round(os.totalmem() / (1024 * 1024))));

  const logFile = path.join(config.dataDir, 'postgres.log');
  await rotatePostgresLog(logFile);

  /*
   * `spawn` with `stdio: 'ignore'`, never `execFile`.
   *
   * `pg_ctl` exits as soon as the server is up, but the `postgres` process it
   * launched inherits the parent's stdout/stderr and holds them for its whole
   * life — and `execFile` only resolves once the child's pipes close. Whenever
   * this server's own stdout is a pipe rather than a console, that promise
   * never settles: PostgreSQL starts perfectly, `postgres.log` says
   * "ready to accept connections", and the boot screen sits on
   * "Starting the database" forever.
   *
   * Latent for as long as the Master only ever ran from a terminal, and
   * uncovered the first time the desktop shell spawned it with pipes.
   * `master/tests/helpers/db.ts` hit the identical hang in the test suite and
   * fixed it there; this is the same fix in the launcher it was always also
   * true of.
   */
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      path.join(binDir, binName('pg_ctl')),
      [
        '--pgdata',
        clusterDir,
        '--log',
        logFile,
        '--options',
        serverOptions.join(' '),
        '--wait',
        'start',
      ],
      { stdio: 'ignore', windowsHide: true },
    );

    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`pg_ctl start exited with ${code ?? 'no code'}`)),
    );
  });

  log.info(`Database listening on 127.0.0.1:${config.database.port}`);
}

async function stopCluster(binDir: string, clusterDir: string): Promise<void> {
  try {
    // 'fast' rolls back open transactions and shuts down promptly rather than
    // waiting for clients to disconnect on their own.
    await execFileAsync(path.join(binDir, binName('pg_ctl')), [
      '--pgdata',
      clusterDir,
      '--mode',
      'fast',
      '--wait',
      'stop',
    ]);
    log.info('Database stopped');
  } catch (error) {
    log.warn('Database did not stop cleanly', error);
  }
}

async function isClusterRunning(binDir: string, clusterDir: string): Promise<boolean> {
  try {
    await execFileAsync(path.join(binDir, binName('pg_ctl')), ['--pgdata', clusterDir, 'status']);
    return true;
  } catch {
    return false;
  }
}

/**
 * `initdb` creates only the `postgres` maintenance database (and the
 * templates), not one named after the superuser. So this connects to
 * `postgres` and creates the application database — `config.database.database`,
 * `orderbook` — itself, which also lets it be dropped or restored
 * independently of the cluster.
 *
 * Uses the `pg` driver rather than shelling out to `psql`: the bundled
 * PostgreSQL distribution ships server binaries only (initdb, pg_ctl,
 * postgres), so assuming a client binary on disk would break the very
 * deployment this is meant to support.
 */
async function ensureApplicationDatabase(password: string): Promise<void> {
  const client = new pg.Client({
    host: '127.0.0.1',
    port: config.database.port,
    user: config.database.user,
    password,
    database: 'postgres',
  });

  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      config.database.database,
    ]);
    if (existing.rowCount) return;

    // CREATE DATABASE cannot take a bind parameter, so the identifier is
    // quoted instead. The name is ours from config, never user input.
    await client.query(`CREATE DATABASE "${config.database.database}"`);
    log.info(`Created database "${config.database.database}"`);
  } finally {
    await client.end();
  }
}
