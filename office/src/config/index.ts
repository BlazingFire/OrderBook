/**
 * Office Panel configuration. Like the Master, every value works out of the
 * box; environment variables exist for development and for running two panels
 * on one machine during testing.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';

import { isLocale, DEFAULT_LOCALE } from '@orderbook/shared';

import { loadEnvFiles } from '../lib/env-file.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(packageRoot, '..');

/**
 * A writable overrides file, for settings this panel changes about itself at
 * runtime — today only where its data lives, after a storage move made while
 * running from source. Under the desktop shell that record is the shell's own
 * pointer instead (`locationFile` below), for the reason `relocateDataDir`
 * gives in `config/paths.ts`.
 *
 * It cannot live in `packageRoot` once installed: under Program Files that
 * directory is read-only. It cannot live inside `dataDir` either, for a subtler
 * reason — it is a file that can *say where dataDir is*, so putting it there
 * would move the pointer along with the data and leave the next start looking
 * in the old place.
 *
 * So: a fixed per-machine location, beside the default data directory rather
 * than inside it. `ORDERBOOK_OFFICE_SETTINGS_FILE` is what the desktop shell
 * sets when packaged; from source it stays in the package folder, exactly
 * where it has always been.
 */
const settingsFile = process.env.ORDERBOOK_OFFICE_SETTINGS_FILE
  ? path.resolve(process.env.ORDERBOOK_OFFICE_SETTINGS_FILE)
  : path.join(packageRoot, '.env');

// See master/src/config/index.ts — same precedence, most specific file wins.
loadEnvFiles(settingsFile, path.join(packageRoot, '.env'), path.join(repoRoot, '.env'));

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const dataDir = process.env.ORDERBOOK_OFFICE_DATA_DIR
  ? path.resolve(process.env.ORDERBOOK_OFFICE_DATA_DIR)
  : path.join(packageRoot, 'data');

export const config = {
  packageRoot,
  dataDir,
  settingsFile,
  /**
   * The desktop shell's record of where `dataDir` is (`office-location.json`,
   * `{"dataDir": …}`), or null when nothing but a terminal started this
   * process. The shell reads it before every start of this server and passes
   * the answer in as `ORDERBOOK_OFFICE_DATA_DIR`, so under the shell it — not
   * `settingsFile` — is what a storage move has to rewrite.
   */
  locationFile: process.env.ORDERBOOK_OFFICE_LOCATION_FILE
    ? path.resolve(process.env.ORDERBOOK_OFFICE_LOCATION_FILE)
    : null,
  /** Pairing credentials issued by the Master. */
  credentialsFile: path.join(dataDir, 'pairing.json'),

  // Offline state (docs/LEAD_GENERATION_FLOW.md §2, §4, §7). A panel is no
  // longer a pure thin client: it must be able to accept a lead with no link
  // to the Master and still be holding it after a power cut.
  /** Device code + the counter behind temporary ids. */
  deviceFile: path.join(dataDir, 'device.json'),
  /** Persisted hybrid logical clock, so a restart cannot rewind ordering. */
  clockFile: path.join(dataDir, 'clock.json'),
  /** Mutations saved locally and not yet acknowledged by the Master. */
  outboxFile: path.join(dataDir, 'outbox.json'),
  /** Last snapshot received, so an offline start still has something to show. */
  snapshotFile: path.join(dataDir, 'snapshot.json'),
  /**
   * People who have signed in on this panel: a locally-minted password verifier
   * and their cached role, so sign-in works with the Master switched off
   * (docs/ROLES_AND_USERS.md §15).
   */
  usersFile: path.join(dataDir, 'users.json'),
  /**
   * Failed sign-in counts, persisted so relaunching the panel does not reset a
   * lockout — which would make it no obstacle to somebody sitting at the machine.
   */
  signInAttemptsFile: path.join(dataDir, 'sign-in-attempts.json'),
  /**
   * This panel's own on-disk copy of image variants it has actually viewed —
   * fetched lazily from the Master on first request, then instant on every
   * repeat (`http/app.ts`'s `/uploads/images/:imageId/:variant`). Unlike
   * `7-IMAGE-PIPELINE.md` §4.2's full proactive replica of every image the
   * company owns, this is a cache, not a guarantee — see `HANDOFF.md` for
   * why that gap is deliberate for this pass.
   */
  imagesDir: path.join(dataDir, 'images'),

  http: {
    // Loopback only: staff use the browser on this same PC, and nothing else
    // on the network has any reason to reach an Office Panel.
    host: process.env.OFFICE_HOST ?? '127.0.0.1',
    port: intFromEnv('OFFICE_PORT', 4200),
  },

  panelName: process.env.OFFICE_PANEL_NAME ?? `${hostname()} Office Panel`,
  hostname: hostname(),

  discovery: {
    /** How long to keep broadcasting before reporting that no Master answered. */
    timeoutMs: intFromEnv('OFFICE_DISCOVERY_TIMEOUT_MS', 8000),
  },

  sync: {
    /** Retry cadence for a flush that failed while the link was up. */
    retryMs: intFromEnv('OFFICE_SYNC_RETRY_MS', 5000),
    /** Mutations pushed per batch, so one long outage does not send a huge frame. */
    batchSize: intFromEnv('OFFICE_SYNC_BATCH_SIZE', 100),
    /**
     * How long a new pending order's save waits for the Master's number while
     * the link is up. Past it the save answers Provisional and the number
     * follows over the event stream.
     */
    saveNumberWaitMs: intFromEnv('OFFICE_SAVE_NUMBER_WAIT_MS', 5000),
  },

  locale: {
    /**
     * No timezone here — the Office holds no database and computes no
     * calendar boundary. Just the default so a fresh browser profile on this
     * panel starts in the deployment's language, read by `GET /api/session`
     * (answered locally, never forwarded, so it works with the Master off).
     */
    defaultLocale: isLocale(process.env.ORDERBOOK_DEFAULT_LOCALE)
      ? process.env.ORDERBOOK_DEFAULT_LOCALE
      : DEFAULT_LOCALE,
  },
} as const;
