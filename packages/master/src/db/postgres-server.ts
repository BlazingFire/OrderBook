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

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('postgres');

const PASSWORD_FILE = 'pg-superuser-password';

/** Where to look for initdb/pg_ctl when ORDERBOOK_PG_BIN is not set. */
function candidateBinDirs(): string[] {
  const candidates: string[] = [];

  // Binaries bundled into the packaged app (production on the shop PC).
  candidates.push(path.join(config.packageRoot, 'vendor', 'postgres', 'bin'));

  // `embedded-postgres` ships platform binaries under its package directory.
  candidates.push(
    path.join(config.packageRoot, 'node_modules', '@embedded-postgres', 'linux-x64', 'native', 'bin'),
    path.join(config.packageRoot, '..', '..', 'node_modules', '@embedded-postgres', 'linux-x64', 'native', 'bin'),
  );

  // A system installation, if the machine already has one.
  for (const version of ['17', '16', '15', '14']) {
    candidates.push(`/usr/lib/postgresql/${version}/bin`);
    candidates.push(`/usr/pgsql-${version}/bin`);
    candidates.push(`C:\\Program Files\\PostgreSQL\\${version}\\bin`);
  }
  candidates.push('/usr/local/pgsql/bin', '/opt/homebrew/opt/postgresql/bin');

  return candidates;
}

function resolveBinDir(): string {
  if (config.database.binDir) {
    if (!existsSync(path.join(config.database.binDir, binName('pg_ctl')))) {
      throw new Error(`ORDERBOOK_PG_BIN is set but pg_ctl was not found in ${config.database.binDir}`);
    }
    return config.database.binDir;
  }

  for (const dir of candidateBinDirs()) {
    if (existsSync(path.join(dir, binName('pg_ctl')))) return dir;
  }

  throw new Error(
    'Could not locate PostgreSQL binaries. Install the bundled server, or set ORDERBOOK_PG_BIN ' +
      'to a directory containing initdb and pg_ctl, or set DATABASE_URL to use an existing server.',
  );
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

  const password = await ensureCluster(binDir, clusterDir);
  await startCluster(binDir, clusterDir, socketDir);
  await ensureApplicationDatabase(binDir, socketDir, password);

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

  const logFile = path.join(config.dataDir, 'postgres.log');

  await execFileAsync(path.join(binDir, binName('pg_ctl')), [
    '--pgdata',
    clusterDir,
    '--log',
    logFile,
    '--options',
    serverOptions.join(' '),
    '--wait',
    'start',
  ]);

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
 * `initdb` creates a database named after the superuser; the application
 * database is created separately so it can be dropped/restored independently.
 */
async function ensureApplicationDatabase(
  binDir: string,
  socketDir: string,
  password: string,
): Promise<void> {
  const psql = path.join(binDir, binName('psql'));
  const baseArgs = [
    '--host',
    process.platform === 'win32' ? '127.0.0.1' : socketDir,
    '--port',
    String(config.database.port),
    '--username',
    config.database.user,
    '--no-password',
    '--dbname',
    'postgres',
    '--tuples-only',
    '--no-align',
  ];
  const env = { ...process.env, PGPASSWORD: password };

  const { stdout } = await execFileAsync(psql, [
    ...baseArgs,
    '--command',
    `SELECT 1 FROM pg_database WHERE datname = '${config.database.database}'`,
  ], { env });

  if (stdout.trim() === '1') return;

  await execFileAsync(psql, [
    ...baseArgs,
    '--command',
    `CREATE DATABASE ${config.database.database}`,
  ], { env });

  log.info(`Created database "${config.database.database}"`);
}
