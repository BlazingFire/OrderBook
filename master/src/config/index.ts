/**
 * Master Panel configuration. Every value has a working default so the app can
 * be launched by double-clicking on a shop PC with no environment set up;
 * environment variables exist for development and unusual deployments.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Root for all runtime state: Postgres cluster, uploads, generated secrets. */
const dataDir = process.env.ORDERBOOK_DATA_DIR
  ? path.resolve(process.env.ORDERBOOK_DATA_DIR)
  : path.join(packageRoot, 'data');

export const config = {
  packageRoot,
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),

  http: {
    /** Bound on all interfaces so Office Panel PCs on the LAN can reach it. */
    host: process.env.HOST ?? '0.0.0.0',
    port: intFromEnv('PORT', 4100),
  },

  database: {
    /**
     * When set, the Master connects to an existing Postgres instead of
     * managing its own cluster. Used in development and by deployments that
     * already run a database; the shop-PC default is the managed cluster.
     */
    url: process.env.DATABASE_URL ?? null,
    clusterDir: path.join(dataDir, 'postgres'),
    port: intFromEnv('ORDERBOOK_PG_PORT', 55432),
    user: 'orderbook',
    database: 'orderbook',
    /**
     * Directory holding initdb/pg_ctl. Resolved automatically when unset — see
     * db/postgres-server.ts.
     */
    binDir: process.env.ORDERBOOK_PG_BIN ?? null,
  },

  session: {
    cookieName: 'orderbook_session',
    /** Sessions live in memory; restarting the Master signs admins out. */
    ttlMs: 12 * 60 * 60 * 1000,
  },
} as const;

export type Config = typeof config;
