/**
 * Master Panel configuration. Every value has a working default so the app can
 * be launched by double-clicking on a shop PC with no environment set up;
 * environment variables exist for development and unusual deployments.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { isLocale, DEFAULT_LOCALE } from '@orderbook/shared';

import { loadEnvFiles } from '../lib/env-file.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(packageRoot, '..');

// Loaded before any process.env is read below. First value set wins, so the
// package-level file is read first and overrides the repo-root one: a single
// .env at the root can configure both panels, while either panel can still
// override it locally.
loadEnvFiles(path.join(packageRoot, '.env'), path.join(repoRoot, '.env'));

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
  /** `<imagesDir>/<tenantId>/<imageId>/{master,large,thumb,micro}.webp` — see `services/image.service.ts`. */
  imagesDir: path.join(dataDir, 'uploads', 'images'),

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

  /**
   * The PDF Designer's disk layout.
   *
   * Deliberately **not** under `uploadsDir`: that directory is served by
   * `express.static` with no authentication (`master/src/http/app.ts`), and a
   * rendered quotation carries prices, a customer's address and — depending on
   * the actor who rendered it — figures somebody else may not see. Documents
   * are reachable only through the authenticated route, which resolves the
   * path from this config plus the stored `storage_key`, never from any
   * client-supplied string.
   */
  /**
   * Where setup files for both panels are kept.
   *
   * Deliberately **outside** `dataDir` and outside the program folder: it is a
   * drop box an operator copies files into, not application state, and it has
   * to survive an uninstall that clears the program folder. The Master reads
   * its own build from `master-panel/` and serves the Office one from
   * `office-panel/` to paired panels, which is what lets an office PC update
   * over the LAN instead of by USB stick.
   *
   * A folder that does not exist is not an error — it is "no updates
   * available", which is the honest state on a machine nobody has published a
   * build to yet.
   */
  releasesDir: process.env.ORDERBOOK_RELEASES_DIR
    ? path.resolve(process.env.ORDERBOOK_RELEASES_DIR)
    : path.join(path.parse(process.cwd()).root, 'OrderBook-Releases'),

  documents: {
    dir: path.join(dataDir, 'documents'),
    /** `<exportsDir>/<storageKey>.pdf` — the rendered files themselves. */
    exportsDir: path.join(dataDir, 'documents', 'exports'),
    /** Logo and signature images a template draws. */
    assetsDir: path.join(dataDir, 'documents', 'assets'),
    /** The four vendored SIL OFL faces. Committed, not fetched — this product never has a network. */
    fontsDir: path.join(packageRoot, 'assets', 'fonts'),
    /**
     * 512 KB raw (~700 KB once base64-encoded). Bounded by the *Office*
     * Panel's `express.json` limit of 1 MB, not the Master's 2 MB, because an
     * asset upload is forwarded through it — raising this without raising that
     * produces a 413 only Office users ever see.
     */
    maxAssetBytes: 512 * 1024,
    maxPreviewBytes: 4 * 1024 * 1024,
    /** No automatic pruning. Retention is an open question nobody has answered yet. */
    retainExports: null,
  },

  session: {
    cookieName: 'orderbook_session',
    /** Sessions live in memory; restarting the Master signs admins out. */
    ttlMs: 12 * 60 * 60 * 1000,
  },

  locale: {
    /**
     * Business timezone. Every calendar boundary in Reports and every
     * `'YYYY-MM'` month bucket is computed against this, never against the
     * host machine's zone. `||`, not `??` — `ORDERBOOK_TIMEZONE=""` must fall
     * back to the default rather than reach Postgres as an empty string,
     * which fails at startup with a confusing message instead of an obvious
     * one. Validated once at boot by `assertTimeZoneValid()` in `index.ts`.
     */
    timeZone: process.env.ORDERBOOK_TIMEZONE || 'Asia/Kolkata',
    /** Read by each panel's boot endpoint so a fresh browser profile starts in the deployment's language. */
    defaultLocale: isLocale(process.env.ORDERBOOK_DEFAULT_LOCALE)
      ? process.env.ORDERBOOK_DEFAULT_LOCALE
      : DEFAULT_LOCALE,
  },
} as const;

export type Config = typeof config;
