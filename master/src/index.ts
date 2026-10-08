/**
 * Master Panel entrypoint.
 *
 * Startup order matters, and it has two halves that pull in opposite
 * directions.
 *
 * The database must be up and migrated before anything can serve *requests*,
 * and discovery must not advertise this Master until it can actually accept a
 * pairing request. But the HTTP port must open **before** any of that, because
 * everything that can go wrong goes wrong first: a cluster that will not
 * start, a port already taken, a major-version mismatch, a missing font. This
 * used to exit the process with the explanation in a console window nobody
 * looks at, while the browser sat on its starting screen for ever waiting for
 * a port that was never going to open.
 *
 * So the port opens immediately serving `createBootApp()`, which answers every
 * API call with the boot status, and the real app replaces it once the boot
 * sequence finishes. A failure now has a screen to appear on.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';

import { installCrashGuard } from '@orderbook/shared';
import { bootFailed, bootReady, bootStep } from './boot-status.js';
import { config } from './config/index.js';
import { recordBootedVersion, snapshotClusterBeforeUpgrade } from './db/cluster-snapshot.js';
import { startPostgres, type PostgresServerHandle } from './db/postgres-server.js';
import { closeDatabase, db, initDatabase, runMigrations } from './db/knex.js';
import { startDiscoveryResponder, type DiscoveryResponder } from './discovery/responder.js';
import { createApp } from './http/app.js';
import { createBootApp } from './http/boot-app.js';
import { appVersion } from './lib/app-version.js';
import { createLogger } from './lib/logger.js';
import { toErrorMessage } from './lib/errors.js';
import { loadOrCreateKey } from './lib/secret-box.js';
import { sweepOrphanImageVariants } from './services/image.service.js';
import { attachCataloguePhotos } from './services/catalogue-photos.service.js';
import { assertFontsPresent } from './pdf/fonts.js';
import { listLanAddresses } from './lib/network.js';
import { createRealtimeHub, type RealtimeHub } from './realtime/hub.js';
import { purgeExpiredSessions } from './services/auth.service.js';
import { startBackupScheduler } from './services/backup-scheduler.js';
import { startConnectorScheduler } from './services/connector-scheduler.js';
import { startNotificationPruner } from './services/notification.service.js';
import { announceNewVersion, startAutoUpdateScheduler } from './services/auto-update.js';
import { seedBundledOfficeRelease, startReleasePolling } from './services/update.service.js';
import { isSetupComplete, refreshStoredLanIp } from './services/setup.service.js';
import { startMemoryMonitor } from './lib/memory-monitor.js';

const log = createLogger('master');

const SESSION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/*
 * Everything shutdown has to tear down, at module scope so the handlers can be
 * registered before `main()` runs.
 *
 * They used to be locals inside `main()`, and the handlers were installed at
 * the *end* of the boot sequence — after `startPostgres()` and
 * `runMigrations()`, which is 60-90 seconds on a first run. That is precisely
 * the window in which an operator watching a splash screen gives up and closes
 * it, and precisely the half-built cluster the handlers exist to protect: for
 * the whole of it there was no SIGTERM handler at all, so the process died
 * where it stood and left `initdb` output behind for the next launch to trip
 * over. Registering at module scope costs nothing and closes that window.
 */
let postgres: PostgresServerHandle | null = null;
let hub: RealtimeHub | null = null;
let discovery: DiscoveryResponder | null = null;
let httpServer: ReturnType<typeof createServer> | null = null;
let sessionSweep: NodeJS.Timeout | null = null;
let bootSucceeded = false;
let shuttingDown = false;

/**
 * Extra teardown a subsystem registers for itself.
 *
 * A seam, so that a feature needing cleanup adds a line here instead of
 * reshaping `shutdown()` — which is how this function grew two near-identical
 * copies the first time.
 */
export const disposables: Array<() => void | Promise<void>> = [];

/**
 * Stop everything that is currently running, in dependency order.
 *
 * Safe at any point in the boot sequence, including before it starts: every
 * resource is null until it exists. Postgres goes last so nothing is mid-query
 * when it goes down.
 */
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${reason}, shutting down`);

  if (sessionSweep) clearInterval(sessionSweep);

  for (const dispose of disposables) {
    await Promise.resolve()
      .then(dispose)
      .catch(() => {});
  }

  /*
   * End the sockets the HTTP server is still holding, before anything awaits it.
   *
   * This has to come first — ahead of `hub.stop()` — because Socket.IO's
   * `io.close()` closes the *underlying HTTP server* and waits for it too. A
   * browser keep-alive connection never ends on its own, so that await hung,
   * and everything after it never ran: the pool stayed open and, on an
   * installation using the bundled database, **`postgres.stop()` was never
   * reached**. The shell then hit its ten-second grace period and hard-killed
   * the process, leaving a cluster listening for the next launch to adopt.
   */
  httpServer?.closeAllConnections();

  await discovery?.stop().catch(() => {});
  await hub?.stop().catch(() => {});
  if (httpServer) {
    const server = httpServer;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Again, for anything that connected while the teardown above ran.
      server.closeAllConnections();
    });
  }
  await closeDatabase().catch(() => {});
  await postgres?.stop().catch(() => {});

  log.info('Shutdown complete');
  process.exit(bootSucceeded ? 0 : 1);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

/*
 * The desktop shell asks over IPC rather than by signal, because Windows has
 * no signals: `child.kill('SIGTERM')` there is `TerminateProcess`, which the
 * process cannot observe — so on the operator's actual machine none of the
 * teardown above had ever run.
 */
process.on('message', (message: unknown) => {
  if ((message as { type?: string } | null)?.type === 'orderbook:shutdown') {
    void shutdown('shutdown request');
  }
});

/*
 * The shell died. Do not outlive it holding the port and the cluster — the
 * next launch would meet its own orphan. Only fires when an IPC channel
 * exists, so `npm run dev:master` is unaffected.
 */
process.on('disconnect', () => void shutdown('parent gone'));

/*
 * A promise nobody awaited that then failed. Node's default since v15 is to
 * kill the process, which on a shop PC means a restart in the middle of the
 * day over what is usually one failed broadcast. Log it and keep running; so is a
 * stray `uncaughtException`, because a window that blanks every time an odd error
 * escapes is worse than a log line. If they keep coming (more than five in a
 * minute) the process is in a state nobody can reason about: it shuts down cleanly
 * and the shell starts a fresh one (`shared/src/domain/crash-guard.ts`).
 */
installCrashGuard(process, log, { onRepeated: (reason) => void shutdown(reason) });

/**
 * Proves `config.locale.timeZone` at boot rather than letting a typo surface
 * later as a quietly-wrong report bucket. Nothing pins a timezone otherwise —
 * `buildKnexConfig` passes only client/connection/pool/migrations, and there
 * is no `SET TIME ZONE` anywhere — so a mistyped zone would otherwise reach
 * Postgres invisibly on the first date computation instead of failing loudly
 * here, on every boot, naming the variable to fix.
 *
 * Run AFTER `runMigrations()`: it needs a live, migrated connection, and a
 * fresh install must fail on a missing schema with a migration error, not a
 * timezone one.
 */
async function assertTimeZoneValid(): Promise<void> {
  try {
    await db().raw('SELECT now() AT TIME ZONE ?', [config.locale.timeZone]);
  } catch {
    throw new Error(
      `ORDERBOOK_TIMEZONE is set to "${config.locale.timeZone}", which PostgreSQL does not ` +
        'recognise. Set it to a valid IANA zone name (for example "Asia/Kolkata") and restart.',
    );
  }
}

async function main(): Promise<void> {
  /*
   * The live request handler. Starts as the boot app and is swapped for the
   * real one when the boot sequence completes, rather than creating a second
   * server: the port is already open and listening by then, and re-binding it
   * would reintroduce the very window this exists to close.
   */
  let handler: (req: IncomingMessage, res: ServerResponse) => void = createBootApp();
  const server = createServer((req, res) => handler(req, res));
  httpServer = server;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.http.port, config.http.host, resolve);
  });

  log.info(
    `Master Panel starting — open http://localhost:${config.http.port} to watch its progress`,
  );

  try {
    bootStep('Preparing folders');
    await fs.mkdir(config.uploadsDir, { recursive: true });

    // A pre-flight, not the only initialiser: `secret-box.ts` creates the key
    // lazily on first use, because no integration suite runs `main()`. Calling
    // it here means an unwritable `dataDir/secrets` is loud on the boot screen
    // rather than silent until the first person signs in.
    bootStep('Preparing secure storage');
    loadOrCreateKey();

    // A missing PDF font must stop startup here, naming the file. PDFKit's
    // fallback for an unregistered face is Helvetica, so the alternative to
    // failing now is silently printing a report in a face it was not measured in.
    bootStep('Checking PDF fonts');
    assertFontsPresent();

    /*
     * Before the cluster starts, and only when this build has not booted on
     * it before: a whole-cluster copy that survives a migration going wrong.
     * `cluster-snapshot.ts` says why it is a file copy of a *stopped* cluster
     * and why it fails soft. An external database (`DATABASE_URL`) is not ours
     * to copy; whoever runs it keeps its backups.
     */
    if (!config.database.url) {
      await snapshotClusterBeforeUpgrade({
        dataDir: config.dataDir,
        clusterDir: config.database.clusterDir,
        version: appVersion(),
        onCopyStart: () =>
          bootStep('Keeping a copy of the database before the update (once per version)'),
        log,
      });
    }

    bootStep('Starting the database');
    postgres = await startPostgres();
    initDatabase(postgres.connectionUrl);

    bootStep('Updating the database');
    await runMigrations();
    await assertTimeZoneValid();
    // Only now: the marker means "this version's schema is in place", so a
    // boot that dies in a migration leaves the next attempt taking a fresh copy.
    await recordBootedVersion(config.dataDir, appVersion());

    if (await isSetupComplete()) {
      await refreshStoredLanIp();
    } else {
      log.info('No configuration found — the browser will show the first-run setup screen');
    }

    /*
     * Startup only, before the panel starts taking requests:
     * `normalizeAndStore` writes four variant files before the row that names
     * them is inserted, so a sweep running while somebody uploads would delete
     * a completed upload and leave a row pointing at nothing. Here, nothing
     * else is writing.
     */
    await sweepOrphanImageVariants().catch((error: unknown) => {
      log.warn(`Could not sweep orphaned image folders: ${toErrorMessage(error)}`);
    });

    bootStep('Starting the panel');
    handler = createApp();

    // After the sweep, never before it: the sweep would take a photo being
    // attached for an orphan. Not awaited — encoding a few hundred photos
    // takes minutes, and the panel serves meanwhile.
    void attachCataloguePhotos().catch((error: unknown) => {
      log.warn(`Could not attach the catalogue photos: ${toErrorMessage(error)}`);
    });
    // The Office setup this Master's setup file carried, into the releases
    // folder the Offices update from. Not awaited either: 85 MB or more to copy.
    void seedBundledOfficeRelease().catch((error: unknown) => {
      log.warn(`Could not offer the bundled Office setup: ${toErrorMessage(error)}`);
    });
    hub = createRealtimeHub(server);

    discovery = await startDiscoveryResponder();
    sessionSweep = setInterval(purgeExpiredSessions, SESSION_SWEEP_INTERVAL_MS);
    sessionSweep.unref?.();

    // One disposable, per this file's rule: the scheduler owns its own timer
    // and hands back the way to stop it.
    disposables.push(startConnectorScheduler());

    // Same shape: the daily automatic backup, off until a Server Master turns it on.
    disposables.push(startBackupScheduler());

    // Same shape: the poller owns its timers and hands back the way to stop
    // them. A no-op unless a releases repository is configured.
    // After each poll it tells everybody about a build that has just landed.
    disposables.push(startReleasePolling(async () => void (await announceNewVersion())));

    // The nightly update (23:00 by default): prepares the build and asks the shell to install it.
    disposables.push(startAutoUpdateScheduler());

    // Same shape again: old read notices and anything past 500 a person go.
    disposables.push(startNotificationPruner());

    // Start memory pressure monitoring — warns at 75%, critical at 90% of
    // the heap ceiling. It logs; it does not intervene. There is no GC hint:
    // `global.gc` is undefined without `--expose-gc`, which nothing passes, so
    // the call that used to be here was a no-op in dev and in the packaged app
    // alike. Deleting it was the fix.
    const stopMemoryMonitor = startMemoryMonitor({
      onWarn: () => log.warn('Memory pressure warning — heap usage above 75%'),
      onCritical: () => log.error('Memory pressure critical — heap usage above 90%'),
    });
    disposables.push(stopMemoryMonitor);

    bootReady();
    bootSucceeded = true;

    for (const address of listLanAddresses()) {
      log.info(`Master Panel ready at http://${address}:${config.http.port}`);
    }
    log.info(`Master Panel ready at http://localhost:${config.http.port}`);
  } catch (error) {
    /*
     * Deliberately no `process.exit`. The HTTP server stays up serving the boot
     * app, which now reports this failure — so the operator sees it on the
     * screen they are already looking at instead of in a console window behind
     * it. Exiting here is what made this class of failure invisible.
     */
    bootFailed(error);
    log.error('Failed to start', error);
    log.error(
      `The Master Panel is not usable. Open http://localhost:${config.http.port} to see why.`,
    );

    /*
     * Deliberately still running. `shutdown()` is already registered and will
     * stop a half-started cluster when the signal comes — there used to be a
     * second, near-identical handler installer here for exactly that case, and
     * having two of them is how the successful path ended up protected and the
     * failing one not.
     */
  }
}

/**
 * Only reached if `main` itself could not open the port — there is no server
 * to report through, so the console is genuinely all there is.
 */
main().catch((error) => {
  bootFailed(error);
  log.error('Failed to start, and could not open a port to say so', error);
  process.exit(1);
});
