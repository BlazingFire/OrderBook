/**
 * Test database lifecycle.
 *
 * Integration tests run against a real PostgreSQL — the schema uses JSONB, GIN
 * indexes, sequences and expression indexes, none of which a mock or a
 * different engine would exercise honestly.
 *
 * The cluster lives in its own directory under the OS temp dir, so tests never
 * touch a developer's real `data/` folder. If PostgreSQL binaries are not
 * available on the machine, the integration suites skip rather than fail — unit
 * tests still run anywhere.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';

import { embeddedPostgresPackageDir } from '../../src/db/postgres-server.js';

const execFileAsync = promisify(execFile);

const CLUSTER_ROOT = path.join(os.tmpdir(), 'orderbook-test-pg');
const CLUSTER_DIR = path.join(CLUSTER_ROOT, 'cluster');
const SOCKET_DIR = path.join(CLUSTER_ROOT, 'socket');
const PORT = Number(process.env.ORDERBOOK_TEST_PG_PORT ?? 55433);
const USER = 'orderbook_test';
const PASSWORD = 'orderbook_test_password';
const DATABASE = 'orderbook_test';

function binName(tool: string): string {
  return process.platform === 'win32' ? `${tool}.exe` : tool;
}

/**
 * Mirrors the lookup the application does, so tests exercise the same setup.
 *
 * The platform directory is *imported* rather than recomputed: this function
 * used to build its own `${process.platform}-${process.arch}`, which on Windows
 * is `win32-x64` while the package installs to `windows-x64`. Nothing was found,
 * `canRunIntegrationTests` went false, and every integration suite — including
 * the one that is the §15 gate list — reported *skipped*. A skipped gate reads
 * exactly like a passing one in the summary line, so the guard failures this
 * audit found had been invisible on the owner's machine the whole time.
 */
export function findPostgresBinDir(): string | null {
  if (process.env.ORDERBOOK_PG_BIN) return process.env.ORDERBOOK_PG_BIN;

  const candidates: string[] = [];
  const platformDir = embeddedPostgresPackageDir();
  for (const root of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    candidates.push(
      path.resolve(root, 'node_modules', '@embedded-postgres', platformDir, 'native', 'bin'),
    );
  }
  for (const version of ['17', '16', '15', '14']) {
    candidates.push(`/usr/lib/postgresql/${version}/bin`, `/usr/pgsql-${version}/bin`);
    // Absent before, which is why running the suite on Windows needed
    // ORDERBOOK_PG_BIN spelled out by hand or it quietly tested nothing.
    candidates.push(`C:\\Program Files\\PostgreSQL\\${version}\\bin`);
  }
  candidates.push('/usr/local/pgsql/bin', '/opt/homebrew/opt/postgresql/bin');

  return candidates.find((dir) => existsSync(path.join(dir, binName('pg_ctl')))) ?? null;
}

/**
 * True when integration tests can run here. Suites call this in `describe.skipIf`
 * so a machine without PostgreSQL reports skipped tests instead of red ones.
 */
export const canRunIntegrationTests = findPostgresBinDir() !== null && !isRoot();

function isRoot(): boolean {
  // PostgreSQL refuses to start as root, same as in production.
  return process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;
}

let started = false;

export function testConnectionUrl(): string {
  return `postgres://${USER}:${encodeURIComponent(PASSWORD)}@127.0.0.1:${PORT}/${DATABASE}`;
}

export async function startTestPostgres(): Promise<void> {
  if (started) return;

  const binDir = findPostgresBinDir();
  if (!binDir) throw new Error('PostgreSQL binaries not found');

  await fs.mkdir(SOCKET_DIR, { recursive: true });

  // The test cluster is disposable, so a major-version mismatch (after the
  // bundled PostgreSQL is upgraded, say) is resolved by rebuilding it rather
  // than failing. Production takes the opposite path and refuses to touch the
  // data directory — see assertClusterVersionMatches in postgres-server.ts.
  await discardClusterIfVersionDiffers(binDir);

  if (!existsSync(path.join(CLUSTER_DIR, 'PG_VERSION'))) {
    const pwfile = path.join(CLUSTER_ROOT, 'pw.tmp');
    await fs.writeFile(pwfile, PASSWORD, { mode: 0o600 });
    try {
      await execFileAsync(path.join(binDir, binName('initdb')), [
        '--pgdata', CLUSTER_DIR,
        '--username', USER,
        '--pwfile', pwfile,
        '--encoding', 'UTF8',
        '--auth-local', 'trust',
        '--auth-host', 'scram-sha-256',
      ]);
    } finally {
      await fs.rm(pwfile, { force: true });
    }
  }

  if (!(await isRunning(binDir))) {
    await startServer(binDir);
  }

  await ensureDatabase();
  started = true;
}

/**
 * Start the cluster without letting the server hold our stdio.
 *
 * Deliberately `spawn` with `stdio: 'ignore'` rather than `execFile`. `pg_ctl`
 * exits as soon as the server is up, but the server it launched inherits the
 * parent's stdout/stderr pipes and keeps them open for its whole life — and
 * `execFile` only resolves once the child's pipes close. On Windows that means
 * the promise never settles and the suite hangs until the hook times out, even
 * though PostgreSQL started perfectly. Giving the child no pipes to inherit is
 * what makes the exit observable.
 */
async function startServer(binDir: string): Promise<void> {
  const options = [`-p ${PORT}`, '-h 127.0.0.1'];
  if (process.platform !== 'win32') options.push(`-k ${SOCKET_DIR}`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      path.join(binDir, binName('pg_ctl')),
      [
        '--pgdata', CLUSTER_DIR,
        '--log', path.join(CLUSTER_ROOT, 'postgres.log'),
        '--options', options.join(' '),
        '--wait', 'start',
      ],
      { stdio: 'ignore', windowsHide: true },
    );

    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`pg_ctl start exited with ${code}`)),
    );
  });

  await waitUntilAcceptingConnections();
}

/**
 * `pg_ctl --wait` reports the postmaster is up, which is not the same as it
 * being ready to answer. Polling a real connection is the only honest check.
 */
async function waitUntilAcceptingConnections(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    const client = new pg.Client({
      host: '127.0.0.1',
      port: PORT,
      user: USER,
      password: PASSWORD,
      database: 'postgres',
      connectionTimeoutMillis: 2000,
    });

    try {
      await client.connect();
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise((wait) => setTimeout(wait, 250));
    }
  }

  throw new Error(`Test PostgreSQL never became ready: ${String(lastError)}`);
}

export async function stopTestPostgres(): Promise<void> {
  const binDir = findPostgresBinDir();
  if (!binDir || !started) return;

  await execFileAsync(path.join(binDir, binName('pg_ctl')), [
    '--pgdata', CLUSTER_DIR,
    '--mode', 'fast',
    '--wait', 'stop',
  ]).catch(() => {});
  started = false;
}

async function isRunning(binDir: string): Promise<boolean> {
  try {
    await execFileAsync(path.join(binDir, binName('pg_ctl')), ['--pgdata', CLUSTER_DIR, 'status']);
    return true;
  } catch {
    return false;
  }
}

async function ensureDatabase(): Promise<void> {
  // Uses the pg driver rather than psql: the bundled PostgreSQL distribution
  // ships server binaries only, so no client executable exists on disk.
  const client = new pg.Client({
    host: '127.0.0.1',
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: 'postgres',
  });

  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
    if (!existing.rowCount) await client.query(`CREATE DATABASE "${DATABASE}"`);
  } finally {
    await client.end();
  }
}

/** Wipes the throwaway cluster when it was built by a different major version. */
async function discardClusterIfVersionDiffers(binDir: string): Promise<void> {
  const versionFile = path.join(CLUSTER_DIR, 'PG_VERSION');
  if (!existsSync(versionFile)) return;

  const clusterVersion = (await fs.readFile(versionFile, 'utf8')).trim();

  let serverVersion: string | null = null;
  try {
    const { stdout } = await execFileAsync(path.join(binDir, binName('postgres')), ['--version']);
    serverVersion = /PostgreSQL\)?\s+(\d+)/i.exec(stdout)?.[1] ?? null;
  } catch {
    return;
  }

  if (!serverVersion || serverVersion === clusterVersion) return;

  // Stop whatever may still be running against the old cluster first.
  await execFileAsync(path.join(binDir, binName('pg_ctl')), [
    '--pgdata', CLUSTER_DIR, '--mode', 'immediate', '--wait', 'stop',
  ]).catch(() => {});
  await fs.rm(CLUSTER_DIR, { recursive: true, force: true });
}
