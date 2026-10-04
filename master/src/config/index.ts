/**
 * Master Panel configuration. Every value has a working default so the app can
 * be launched by double-clicking on a shop PC with no environment set up;
 * environment variables exist for development and unusual deployments.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { releasesRepo } from '@orderbook/shared';

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

  releases: {
    /**
     * `owner/repo` to fetch published builds from, or null to stay on the
     * folder alone.
     *
     * Point this at a **public** repository that holds nothing but release
     * assets. The source repository is private, and release assets on a private
     * repository need an `Authorization` header — so a token would have to ship
     * to every shop PC, where it would generally also be able to read the whole
     * source. A separate public releases repository costs nothing and means no
     * secret ever leaves this machine.
     */
    githubRepo: releasesRepo(process.env),

    /**
     * A token, if the releases repository really must be private.
     *
     * Named for what it is rather than `GITHUB_TOKEN`, because anybody setting
     * it should have to think about the sentence above. It is read on the
     * Master only and never travels to a panel.
     */
    githubToken: process.env.ORDERBOOK_RELEASES_GITHUB_TOKEN?.trim() || null,

    /**
     * How often the Master asks GitHub, in minutes. Two by default (1.4 R6),
     * so a new release shows within minutes; the release listing is cached and
     * asked conditionally, which keeps this inside GitHub's 60 calls an hour
     * for an unauthenticated caller. Zero switches polling off and leaves the
     * Updates screen's own check as the only trigger.
     */
    pollMinutes: Number(process.env.ORDERBOOK_RELEASES_POLL_MINUTES ?? '2'),
  },

  pdf: {
    /** The four vendored SIL OFL faces the report export draws with. Committed, not fetched — this product never has a network. */
    fontsDir: path.join(packageRoot, 'assets', 'fonts'),
  },

  /**
   * The catalogue the loader reads (`docs/catalogue/CATALOGUE_MODEL.md` §4) —
   * Markdown, parsed by `domain/catalogue-markdown.ts`. Shipped under
   * `assets/` with the Master, like the fonts, so the /api/developer/load-catalogue
   * route (no screen since 5a32106) works on an installed copy that has no
   * repository beside it.
   */
  catalogueFile: path.join(packageRoot, 'assets', 'catalogue', 'swisware-plus-2026.md'),

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
  },
} as const;
