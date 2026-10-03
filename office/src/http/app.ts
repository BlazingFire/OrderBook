/**
 * The Office Panel's local API, consumed only by its own browser UI.
 *
 * Every route here acts on this panel itself (its link, its sign-in, its
 * files), answers from its local copy of the Master's data, queues a write for
 * the Master, or forwards a command to it. What it keeps is a working copy, not
 * a database: the files under `paths()` (`config/paths.ts`) — the pairing, the
 * device code and clock, the outbox and its refusals, the last snapshot, the
 * offline sign-in records and lockouts, cached images and avatars — plus a
 * downloaded update (`updatesDir()` in `update.service.ts`), and, once that
 * folder has been moved, the one file it writes outside it: the record of
 * where the folder now is (`config.locationFile`, the desktop shell's pointer,
 * or `config.settingsFile` run from source). The Master stays the only durable
 * store of the company's records.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import {
  DEVELOPER_RESET_CONFIRMATION,
  DEVELOPER_TOKEN_HEADER,
  IMAGE_VARIANTS,
  isLocale,
  isPickKind,
  isReportFormat,
  MAX_IMAGE_SOURCE_BYTES,
  MAX_PARTY_IMPORT_BYTES,
  MAX_PRODUCT_IMPORT_BYTES,
  MUTATION_PERMISSIONS,
  cleanChatPost,
  parseReportQuery,
  standing,
  t,
  type ChatMessage,
  type DataChangedEvent,
  type PresenceBeat,
  type ReportKind,
  type PanelHealth,
  type SyncSnapshot,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { freeDiskBytes, paths } from '../config/paths.js';
import { appVersion } from '../lib/app-version.js';
import { createLogger } from '../lib/logger.js';
import { hasNetworkLink, listLanInterfaces } from '../lib/network.js';
import { MasterCommandError, masterConnection } from '../realtime/master-connection.js';
import { BackupValidationError } from '../domain/backup.js';
import * as backupExportService from '../services/backup-export.service.js';
import * as backupRestoreService from '../services/backup-restore.service.js';
import { RestoreError } from '../services/backup-restore.service.js';
import * as developerService from '../services/developer.service.js';
import { DeveloperError } from '../services/developer.service.js';
import { loadCredentials } from '../services/credentials.store.js';
import { masterFetch } from '../lib/master-fetch.js';
import { avatarFile, forgetAvatar, isCached } from '../services/avatar-cache.js';
import { moveStorage } from '../services/panel-report.service.js';
import * as userStore from '../services/user-store.js';
import {
  OfflinePickForbidden,
  listCategoriesFromView,
  listProductsFromView,
  pickFromView,
} from '../services/offline-pick.js';
import {
  PairingError,
  pairAutomatically,
  pairManually,
  scanForMasters,
} from '../services/pairing.service.js';
import * as updateService from '../services/update.service.js';
import { UpdateError } from '../services/update.service.js';
import * as userSession from '../services/user-session.service.js';
import { deviceCode, nextTemporaryId, refreshAfterPairing } from '../sync/device.js';
import * as localStore from '../sync/local-store.js';
import * as outbox from '../sync/outbox.store.js';
import * as sync from '../sync/sync.service.js';

const log = createLogger('http');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SOURCE_BYTES },
});
// This panel's whole replica is a handful of small JSON files — a generous
// limit still costs nothing to buffer in memory, unlike the Master's case.
const backupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
});
// A product spreadsheet, forwarded whole to the Master — the same ceiling it
// applies, so an oversized file is refused here rather than after the upload.
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PRODUCT_IMPORT_BYTES },
});
const partyImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PARTY_IMPORT_BYTES },
});


export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  /*
   * The desktop shell's readiness probe — see `electron/shell.ts`, which
   * `electron/office.main.ts` runs for this panel.
   *
   * Mounted first, and deliberately above the `requireUser` gate further down:
   * the shell polls this before anyone has signed in, so a guarded route would
   * answer 401 for ever and the shell would sit on its splash until the timeout
   * and then declare a server that is in fact running to be dead.
   *
   * The `boot` key mirrors the Master's `boot-app.ts` contract so one shell can
   * read both panels. This panel has no cluster to build and nothing to migrate,
   * so it is ready the moment it is listening — there is no `starting` state to
   * report, only the shape.
   */
  app.get('/api/health', (req, res) => {
    const address = req.socket.remoteAddress;
    const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

    res.json({
      panel: 'office',
      status: 'ok',
      boot: { state: 'ready', step: 'Ready', message: null, detail: null },
      version: appVersion(),
      port: config.http.port,
      hasNetworkLink: hasNetworkLink(),
      interfaces: listLanInterfaces(),
      // Absolute paths go to loopback callers only. This panel binds
      // 127.0.0.1 so that is everyone, but the rule is the Master's and the
      // two must not diverge — that divergence is what this contract exists
      // to prevent.
      ...(loopback
        ? {
            dataDir: paths().dataDir,
            logFile: process.env.ORDERBOOK_LOG_FILE ?? null,
            installerDir: updateService.updatesDir(),
            // What the shell may run, and what it must still hash to.
            installer: updateService.preparedInstaller(),
          }
        : {}),
    } satisfies PanelHealth);
  });

  // --- Connection screen ---

  app.get('/api/connection', async (_req, res) => {
    const credentials = await loadCredentials();
    res.json({
      // Two separate signals, because "no network" and "network but no Master"
      // need different advice on screen: `hasNetworkLink` (in the status
      // below) and the link `state`.
      interfaces: listLanInterfaces(),
      isPaired: credentials !== null,
      panelName: config.panelName,
      // Shown on the sign-in and connection screens so a person can tell the
      // Master's operator which PC this is. Before pairing it comes from the
      // hostname and changes once paired; a failed read leaves it out rather
      // than failing the whole status.
      deviceCode: await deviceCode().catch(() => undefined),
      ...masterConnection.getStatus(),
    });
  });

  app.post('/api/connection/scan', async (_req, res) => {
    try {
      res.json({ masters: await scanForMasters() });
    } catch (error) {
      log.warn('Scan failed', error);
      res.status(500).json({ error: 'scan_failed', message: 'Could not search the network' });
    }
  });

  app.post('/api/connection/pair/auto', async (req, res) => {
    try {
      const credentials = await pairAutomatically(req.body?.panelName);
      await refreshAfterPairing();
      await masterConnection.connect();
      res.status(201).json({ ok: true, companyName: credentials.companyName });
    } catch (error) {
      respondToPairingError(res, error);
    }
  });

  // --- Storage: restore from backup, before pairing exists to gate it
  // (docs/7-STORAGE-BACKUP-RESTORE.md §5.2) ---

  app.post('/api/connection/restore/preview', backupUpload.single('file'), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'validation_error', message: 'Choose a backup file' });
      return;
    }
    try {
      res.json(backupRestoreService.previewRestore(req.file.buffer));
    } catch (error) {
      respondToRestoreError(res, error);
    }
  });

  app.post('/api/connection/restore', backupUpload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'validation_error', message: 'Choose a backup file' });
      return;
    }
    const { passphrase } = req.body ?? {};
    if (typeof passphrase !== 'string' || !passphrase) {
      res.status(400).json({ error: 'validation_error', message: 'Enter the export passphrase' });
      return;
    }

    try {
      // Never wipes: this route is open precisely because pairing does not
      // exist yet to gate it, so the only restore it may run is onto a panel
      // that has never paired. Wiping a paired panel — outbox and all — stays
      // behind a signed-in user holding `storage.manage` at
      // `/api/storage/restore`, where the confirmation is a permission check
      // and not a flag the caller supplies about itself.
      const outcome = await backupRestoreService.restoreBackup(req.file.buffer, passphrase, false);
      res.status(201).json(outcome);
    } catch (error) {
      respondToRestoreError(res, error);
    }
  });

  app.post('/api/connection/pair/manual', async (req, res) => {
    const { host, port, pairingPassword, masterUniqueId, panelName } = req.body ?? {};

    if (
      typeof host !== 'string' ||
      !host ||
      typeof pairingPassword !== 'string' ||
      !pairingPassword
    ) {
      res.status(400).json({
        error: 'invalid_request',
        message: 'Enter the Master address and pairing password',
      });
      return;
    }

    try {
      const credentials = await pairManually({
        host,
        port: Number(port) || 4100,
        pairingPassword,
        masterUniqueId:
          typeof masterUniqueId === 'string' && masterUniqueId ? masterUniqueId : undefined,
        panelName: typeof panelName === 'string' && panelName ? panelName : undefined,
      });
      await refreshAfterPairing();
      await masterConnection.connect();
      res.status(201).json({ ok: true, companyName: credentials.companyName });
    } catch (error) {
      respondToPairingError(res, error);
    }
  });

  // --- Who is using this panel ---

  app.get('/api/session', (_req, res) => {
    res.json({ session: userSession.currentSession(), defaultLocale: config.locale.defaultLocale });
  });

  /*
   * Where this panel keeps its files, and a way to move them.
   *
   * On the sign-in screen deliberately: choosing a drive is something an
   * operator does when setting a machine up, before there is anybody to sign in
   * as — and until now it could only be done from the Master, by an
   * administrator, over the socket, which is no help at all while you are
   * standing at the new PC.
   *
   * Unauthenticated for the same reason the profile list below is, and with the
   * same bound: this server binds loopback, so the caller is whoever is at this
   * keyboard — and that person can already move the folder in Explorer. The
   * Master's equivalent is *not* offered this way, because its page is
   * reachable from every machine on the LAN.
   */
  app.get('/api/storage/path', (_req, res) => {
    void (async () => {
      const current = paths().dataDir;
      res.json({ dataDir: current, freeBytes: await freeDiskBytes(current) });
    })();
  });

  app.post('/api/storage/path', (req, res) => {
    void (async () => {
      const body: unknown = req.body;
      const target =
        typeof body === 'object' && body !== null ? (body as { path?: unknown }).path : undefined;

      if (typeof target !== 'string' || !target.trim()) {
        res.status(400).json({ error: 'invalid_request', message: 'Choose a folder first' });
        return;
      }

      const moveExisting =
        typeof body === 'object' && body !== null
          ? (body as { moveExisting?: unknown }).moveExisting !== false
          : true;

      try {
        res.json(await moveStorage({ path: target.trim(), moveExisting }));
      } catch (error) {
        // A refusal names its reason — the path is inside the old one, the disk
        // is full, the folder is not writable — and the screen shows it.
        res.status(400).json({
          error: 'storage_refused',
          message: error instanceof Error ? error.message : 'Could not move this panel’s files',
        });
      }
    })();
  });

  /*
   * The people who have signed in on this panel before.
   *
   * The sign-in screen shows them as a list of faces so somebody at the counter
   * picks themselves and types only a password. It is deliberately **this
   * panel's own** list, not the company roster: a machine shows the handful of
   * people who actually use it, and a panel nobody has used yet shows nothing
   * and asks for a username as it always did.
   *
   * Unauthenticated, and that is the point — it renders before anybody signs
   * in. What it discloses is a display name and a picture to whoever is already
   * sitting at this PC, which is the same thing the screen behind it shows. The
   * panel binds loopback, so "whoever can call this" is "whoever is at the
   * keyboard".
   *
   * No verifier, no token, no permissions, no fingerprint: everything the store
   * holds that could help somebody sign in stays on the server.
   */
  app.get('/api/session/profiles', (_req, res) => {
    void (async () => {
      const known = await userStore.listKnown();

      res.json(
        known
          .slice()
          .sort((a, b) => b.lastSignInAt.localeCompare(a.lastSignInAt))
          .map((user) => ({
            userId: user.userId,
            username: user.username,
            displayName: user.displayName,
            roleName: user.roleName,
            lastSignInAt: user.lastSignInAt,
            // `?? null` because a record written before this field existed has
            // neither key, and the browser's type says null rather than absent.
            blurhash: user.blurhash ?? null,
            // Whether there is a file to draw, so the browser does not request
            // a picture that is certainly not there.
            hasAvatar: Boolean(user.avatarId) && isCached(user.avatarId as string),
          })),
      );
    })();
  });

  app.get('/api/session/profiles/:userId/avatar', (req, res) => {
    void (async () => {
      const user = await userStore.findByUserId(String(req.params.userId));
      const file = user?.avatarId ? avatarFile(user.avatarId, 'thumb') : null;

      if (!file || !existsSync(file)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }

      // Minted per upload and never reused, so these bytes cannot change.
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.type('image/webp');
      res.sendFile(file);
    })();
  });

  /*
   * Take somebody off this panel's list.
   *
   * Not merely cosmetic: forgetting a person also drops the offline verifier
   * and the cached permissions this panel was holding for them, which is what
   * you want when somebody leaves.
   *
   * It **can** lock somebody out, and the screen says so before it calls this.
   * With the Master reachable they simply sign in again with a username and a
   * password; with it unreachable — the state the face list exists for — the
   * verifier this drops is the only thing that would have let them in, and
   * nothing on the panel can put it back until the Master answers again.
   */
  app.delete('/api/session/profiles/:userId', (req, res) => {
    void (async () => {
      const userId = String(req.params.userId);
      const user = await userStore.findByUserId(userId);

      if (user?.avatarId) await forgetAvatar(user.avatarId);
      await userStore.forget(userId);

      res.status(204).end();
    })();
  });

  app.post('/api/auth/sign-in', (req, res) => {
    void (async () => {
      const { username, password } = req.body ?? {};

      if (typeof username !== 'string' || typeof password !== 'string') {
        res.status(400).json({
          error: 'invalid_request',
          message: 'Enter your username and password',
          messageKey: 'signin.credentialsRequired',
        });
        return;
      }

      try {
        res.json({ session: await userSession.signIn(username, password) });
      } catch (error) {
        if (error instanceof userSession.SignInError) {
          // The same spread this file already uses for a forwarded refusal.
          // Without it the Master's `messageKey` and its `{seconds}`/`{count}`
          // placeholders died here, and the browser rendered English.
          res.status(401).json({
            error: error.code,
            message: error.message,
            ...(error.messageKey ? { messageKey: error.messageKey } : {}),
            ...(error.params ? { params: error.params } : {}),
            ...(error.details ? { details: error.details } : {}),
          });
          return;
        }
        log.error('Sign-in failed unexpectedly', error);
        res.status(500).json({ error: 'sign_in_failed', message: 'Sign-in failed unexpectedly' });
      }
    })();
  });

  app.post('/api/auth/sign-out', (_req, res) => {
    void userSession.signOut().then(() => res.json({ ok: true }));
  });

  // Everything past this point needs a person, not just a paired machine.
  // Placed as one gate rather than repeated per route so a route added later
  // cannot be forgotten — it is behind this by construction.
  app.use('/api', requireUser);

  // --- Data, forwarded to the Master ---

  /**
   * The panel's own view, not the Master's.
   *
   * Served from the local store so it includes work saved here but not yet
   * acknowledged — which is the entire point of the offline path. A panel
   * that has never synced has nothing to show and says so.
   */
  app.get('/api/snapshot', async (_req, res) => {
    const view = await localStore.getView();
    if (!view) {
      res.status(503).json({
        error: 'not_synced',
        message: 'This panel has not synced with the Master Panel yet',
      });
      return;
    }

    res.json(forCurrentUser(view));
  });

  app.get('/api/sync', async (_req, res) => {
    res.json({
      pendingCount: await outbox.pendingCount(),
      rejections: await sync.recentRejections(),
      ...masterConnection.getStatus(),
    });
  });

  // Pressing Sync also tries the Master again at once instead of waiting out
  // the reconnect backoff; a no-op while connected.
  app.post('/api/sync/flush', async (_req, res) => {
    masterConnection.retryNow();
    res.json(await sync.flush());
  });

  /**
   * Somebody has read the refusals, so stop holding them.
   *
   * Deliberately not gated on `sync.resolveConflicts`: that permission sits at
   * the admin tier, and the people whose writes get refused are shop-floor
   * sales staff. Gating the *notification* on a permission they do not hold is
   * how a refused lead came to vanish with nothing ever telling the person who
   * typed it. Dismissing a message about your own work is not an admin action.
   */
  app.post('/api/sync/rejections/acknowledge', async (req, res) => {
    const body = req.body as { mutationIds?: unknown } | undefined;
    const ids = Array.isArray(body?.mutationIds)
      ? body.mutationIds.filter((id): id is string => typeof id === 'string')
      : undefined;

    await sync.acknowledgeRejections(ids);
    res.json({ rejections: await sync.recentRejections() });
  });

  // --- Notifications (the bell), stored on the Master, so online only ---

  app.get('/api/notifications', (req, res) => {
    const limit = Number(req.query.limit);
    return forward(res, 'notification:list', {
      ...(typeof req.query.limit === 'string' && Number.isFinite(limit) ? { limit } : {}),
      ...(typeof req.query.before === 'string' ? { before: req.query.before } : {}),
    });
  });
  app.post('/api/notifications/read', (req, res) => {
    const body = (req.body ?? {}) as { ids?: unknown; all?: unknown };
    return forward(res, 'notification:markRead', {
      ...(body.all === true ? { all: true } : {}),
      ...(Array.isArray(body.ids)
        ? { ids: body.ids.filter((id): id is string => typeof id === 'string') }
        : {}),
    });
  });

  // --- The Chatroom -----------------------------------------------------------
  //
  // Reads, edits and room administration are the Master's, forwarded one to
  // one with the same paths the Master's own browser uses. Posting is the one
  // exception: it queues a `chat.post` mutation like any other write, so a post
  // survives a lost link and is sent again safely. The queue holds it until its
  // author is the person signed in (`sync.service.ts`), and only that person is
  // ever shown it as "Sending…" (`pendingChatPosts`).
  app.get('/api/chat/people', (_req, res) => forward(res, 'chat:people'));
  app.get('/api/chat/rooms', (req, res) =>
    forward(res, 'chat:rooms', {
      all: req.query.all === '1',
      includeArchived: req.query.archived === '1',
    }),
  );
  app.post('/api/chat/rooms', (req, res) => forward(res, 'chat:roomCreate', req.body ?? {}));
  app.get('/api/chat/rooms/:id', (req, res) => forward(res, 'chat:room', req.params.id));
  app.put('/api/chat/rooms/:id', (req, res) =>
    forward(res, 'chat:roomUpdate', { roomId: req.params.id, input: req.body ?? {} }),
  );
  app.post('/api/chat/rooms/:id/members', (req, res) =>
    forward(res, 'chat:memberSet', {
      roomId: req.params.id,
      userId: req.body?.userId,
      role: req.body?.role ?? null,
    }),
  );
  app.get('/api/chat/rooms/:id/messages', async (req, res) => {
    const beforeSeq = Number(req.query.before);
    const limit = Number(req.query.limit);
    // The latest page carries this person's still-queued posts after it; an older page does not.
    const pending = Number.isFinite(beforeSeq) ? [] : await pendingChatPosts(req.params.id);
    try {
      const messages = await masterConnection.command<'chat:messages', ChatMessage[]>('chat:messages', {
        roomId: req.params.id,
        ...(Number.isFinite(beforeSeq) ? { beforeSeq } : {}),
        ...(Number.isFinite(limit) ? { limit } : {}),
      });
      // A post the Master already has but the outbox has not yet settled is shown once.
      const known = new Set(messages.map((message) => message.clientId));
      res.json([...messages, ...pending.filter((message) => !known.has(message.clientId))]);
    } catch (error) {
      // Unreachable: the screen keeps what it holds and shows the pending posts beside it.
      if (error instanceof MasterCommandError && error.unreachable) {
        res.status(503).json({
          error: 'unavailable',
          message: error.message,
          messageKey: 'error.unavailable',
          // Under `details`, where the panel's api client keeps what a refusal carries.
          details: { pending },
        });
        return;
      }
      failForward(res, error);
    }
  });
  app.post('/api/chat/rooms/:id/messages', (req, res) => {
    const cleaned = cleanChatPost(req.body);
    return queue(res, {
      kind: 'chat.post',
      entity: 'chat_message',
      payload: { roomId: req.params.id, ...('value' in cleaned ? cleaned.value : {}) },
      validate: () => ('errorKey' in cleaned ? t('en', cleaned.errorKey) : null),
    });
  });
  app.post('/api/chat/rooms/:id/read', (req, res) =>
    forward(res, 'chat:read', { roomId: req.params.id, seq: Number(req.body?.seq) }),
  );
  app.post('/api/chat/rooms/:id/mute', (req, res) =>
    forward(res, 'chat:mute', { roomId: req.params.id, muted: req.body?.muted === true }),
  );
  app.post('/api/chat/direct', (req, res) => forward(res, 'chat:direct', { userId: req.body?.userId }));
  app.put('/api/chat/messages/:id', (req, res) =>
    forward(res, 'chat:edit', {
      messageId: req.params.id,
      body: req.body?.body,
      ...(Array.isArray(req.body?.mentions) ? { mentions: req.body.mentions } : {}),
    }),
  );
  app.delete('/api/chat/messages/:id', (req, res) => forward(res, 'chat:delete', req.params.id));
  app.post('/api/chat/messages/:id/pin', (req, res) =>
    forward(res, 'chat:pin', { messageId: req.params.id, pinned: req.body?.pinned === true }),
  );
  app.post('/api/chat/messages/:id/done', (req, res) =>
    forward(res, 'chat:taskDone', { messageId: req.params.id, done: req.body?.done === true }),
  );
  app.get('/api/chat/search', (req, res) =>
    forward(res, 'chat:search', {
      q: typeof req.query.q === 'string' ? req.query.q : '',
      ...(typeof req.query.roomId === 'string' ? { roomId: req.query.roomId } : {}),
    }),
  );
  app.get('/api/chat/tasks', (req, res) =>
    forward(res, 'chat:tasks', {
      scope: req.query.scope === 'created' ? 'created' : 'mine',
      includeDone: req.query.includeDone === '1',
    }),
  );
  app.post('/api/chat/access-requests', (req, res) =>
    forward(res, 'chat:requestAccess', {
      capability: req.body?.capability,
      ...(typeof req.body?.note === 'string' ? { note: req.body.note } : {}),
    }),
  );

  // --- The Printroom ----------------------------------------------------------
  //
  // Online-only, forwarded one to one with the same paths the Master's own
  // browser uses: a note printed an hour late on an unattended printer PC wastes
  // paper, so a send is never queued. With the Master out of reach every one of
  // these answers 503 and the local Print button on a note still works. A send
  // first lets the outbox hand over a just-edited order, so the Master builds
  // the sheet from what was on this screen. The claim, like the heartbeat, is
  // held by this panel's connection to the Master.
  app.get('/api/print-jobs', (req, res) =>
    forward(res, 'print:list', {
      ...(typeof req.query.status === 'string' ? { status: req.query.status } : {}),
      mine: req.query.mine === '1',
      ...(typeof req.query.cursor === 'string' ? { cursor: req.query.cursor } : {}),
      ...(Number.isFinite(Number(req.query.limit)) && req.query.limit !== undefined
        ? { limit: Number(req.query.limit) }
        : {}),
    }),
  );
  app.post('/api/print-jobs', async (req, res) => {
    await flushBriefly();
    await forward(res, 'print:send', req.body ?? {});
  });
  app.get('/api/print-jobs/:id', (req, res) => forward(res, 'print:get', req.params.id));
  app.post('/api/print-jobs/:id/printed', (req, res) =>
    forward(res, 'print:mark', {
      id: req.params.id,
      printed: req.body?.printed === true,
      ...(typeof req.body?.printerName === 'string' ? { printerName: req.body.printerName } : {}),
    }),
  );
  app.post('/api/print-jobs/:id/cancel', (req, res) => forward(res, 'print:cancel', req.params.id));
  app.post('/api/print-jobs/:id/claim', (req, res) => forward(res, 'print:claim', req.params.id));
  app.get('/api/print-stations', (_req, res) => forward(res, 'print:stations'));
  app.put('/api/print-stations/self', (req, res) => forward(res, 'print:station', req.body ?? {}));

  /*
   * One record by id, for a chat chip or a bell entry that points past the 500
   * rows this panel keeps. The local view first (it also holds work queued here
   * and not yet sent), then the Master, whose party scoping decides whether the
   * caller may see it at all.
   */
  app.get('/api/leads/:id', async (req, res) => {
    const view = await localStore.getView();
    const local = view ? forCurrentUser(view).leads.find((lead) => lead.id === req.params.id) : undefined;
    if (local) {
      res.json(local);
      return;
    }
    await forward(res, 'lead:get', req.params.id);
  });
  app.get('/api/orders/:id', async (req, res) => {
    const view = await localStore.getView();
    const local = view ? forCurrentUser(view).orders.find((order) => order.id === req.params.id) : undefined;
    if (local) {
      res.json(local);
      return;
    }
    await forward(res, 'order:get', req.params.id);
  });
  // --- Presence: who else has this record open. Held on the Master, so online
  // only; offline this answers 503 and the screen simply shows nobody. ---

  app.post('/api/presence', (req, res) => forward(res, 'presence:beat', presenceBeat(req.body)));

  /**
   * Every write below queues a mutation and answers immediately.
   *
   * The panel does not wait for the Master, because staff cannot wait for the
   * Master — a customer is at the counter. The record exists locally the
   * moment this responds, carries a temporary id, and is reconciled on the
   * next flush.
   */
  app.post('/api/parties', (req, res) =>
    queue(res, { kind: 'party.create', entity: 'party', payload: req.body }),
  );
  app.put('/api/parties/:id', (req, res) =>
    queue(res, {
      kind: 'party.update',
      entity: 'party',
      entityId: req.params.id,
      payload: req.body,
      baseFieldHlc: req.body?.baseFieldHlc,
    }),
  );

  /**
   * The catalogue, paged.
   *
   * Online this asks the Master, which sees the whole catalogue — the snapshot
   * this panel holds is one page of it, and a shop that imported five thousand
   * products would otherwise see the first five hundred and no way to the
   * rest. Offline it pages through the cached snapshot instead and says so,
   * the same bargain the picker makes (`/api/pick/:kind` below).
   */
  app.get('/api/products', (req, res) => {
    const query = {
      search:
        typeof req.query.search === 'string' && req.query.search ? req.query.search : undefined,
      categoryId:
        typeof req.query.categoryId === 'string' && req.query.categoryId
          ? req.query.categoryId
          : undefined,
      brand: typeof req.query.brand === 'string' && req.query.brand ? req.query.brand : undefined,
      missingWeight: req.query.missingWeight === 'true' ? true : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    };

    void (async () => {
      try {
        res.json(await masterConnection.command('product:list' as never, query));
      } catch (error) {
        if (!(error instanceof MasterCommandError && error.unreachable)) {
          failForward(res, error);
          return;
        }

        try {
          const view = await localStore.getView();
          if (!view) {
            res.json({ items: [], total: 0, limit: query.limit ?? 100, offset: 0, offline: true });
            return;
          }

          const page = listProductsFromView(
            query,
            forCurrentUser(view),
            userSession.sessionPermissions(),
          );
          res.json({ ...page, offline: true });
        } catch (offlineError) {
          if (offlineError instanceof OfflinePickForbidden) {
            res.status(403).json({
              error: 'forbidden',
              message: offlineError.message,
              details: { permission: offlineError.permission },
            });
            return;
          }
          failForward(res, offlineError);
        }
      }
    })();
  });

  /**
   * Categories — the owner's Products (`docs/catalogue/CATALOGUE_MODEL.md` §5).
   *
   * The list answers from the Master, or offline from the cached snapshot and
   * says so, like the catalogue above. The writes are online-only, like the
   * Recycle Bin: a category carries no clock to merge an offline edit with,
   * so there is nothing the outbox could replay safely — they fail 503 instead.
   */
  app.get('/api/categories', (req, res) => {
    const query = {
      search:
        typeof req.query.search === 'string' && req.query.search ? req.query.search : undefined,
      brand: typeof req.query.brand === 'string' && req.query.brand ? req.query.brand : undefined,
    };

    void (async () => {
      try {
        res.json(await masterConnection.command('category:list' as never, query));
      } catch (error) {
        if (!(error instanceof MasterCommandError && error.unreachable)) {
          failForward(res, error);
          return;
        }

        try {
          const view = await localStore.getView();
          res.json(
            view
              ? listCategoriesFromView(
                  query,
                  forCurrentUser(view),
                  userSession.sessionPermissions(),
                )
              : [],
          );
        } catch (offlineError) {
          if (offlineError instanceof OfflinePickForbidden) {
            res.status(403).json({
              error: 'forbidden',
              message: offlineError.message,
              details: { permission: offlineError.permission },
            });
            return;
          }
          failForward(res, offlineError);
        }
      }
    })();
  });
  app.post('/api/categories', (req, res) => forward(res, 'category:create', req.body));
  app.put('/api/categories/:id', (req, res) =>
    forward(res, 'category:update', { id: req.params.id, input: req.body }),
  );
  app.delete('/api/categories/:id', (req, res) => forward(res, 'category:delete', req.params.id));

  // Bulk import stays online-only, like images: the outbox carries JSON
  // mutations and rewrites its whole file per mutation, so five thousand
  // queued creates would be quadratic on disk and invisible on refusal. The
  // file goes to the Master over the panel HTTP surface and the row-numbered
  // report comes straight back. Products and parties share the two helpers.
  const unavailable = (res: express.Response, error: unknown): void => {
    res.status(503).json({
      error: 'unavailable',
      message: error instanceof Error ? error.message : 'The Master Panel is not reachable',
      messageKey: 'error.unavailable',
    });
  };

  /** A template or an export: the Master's bytes, type and file name, whatever the format. */
  const proxyDownload =
    (fallbackName: string): express.RequestHandler =>
    (req, res) => {
      void (async () => {
        try {
          const response = await masterFetch(`/api/panel${req.originalUrl.slice('/api'.length)}`);

          if (!response.ok) {
            res.status(response.status).json(await response.json().catch(() => null));
            return;
          }

          res.setHeader('Content-Type', response.headers.get('content-type') ?? 'application/octet-stream');
          res.setHeader(
            'Content-Disposition',
            response.headers.get('content-disposition') ?? `attachment; filename="${fallbackName}"`,
          );
          res.send(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          unavailable(res, error);
        }
      })();
    };

  /** An import: the file, the mode and the dry-run flag as one multipart form to the Master. */
  const proxyImport = (
    upload: multer.Multer,
    masterPath: string,
    fallbackName: string,
    modeOf: (value: unknown) => string,
  ): express.RequestHandler[] => [
    (req, res, next) => {
      // An oversized sheet gets the import's own sentence, not the photo one.
      upload.single('file')(req, res, (error: unknown) => {
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            error: 'validation_error',
            message: 'That file is too large to import',
            messageKey: 'validation.import.tooLarge',
          });
          return;
        }
        next(error);
      });
    },
    (req, res) => {
      if (!req.file) {
        res.status(400).json({
          error: 'validation_error',
          message: 'Choose a CSV or Excel file',
          messageKey: 'validation.import.fileRequired',
        });
        return;
      }

      void (async () => {
        try {
          const form = new FormData();
          form.append('file', new Blob([req.file!.buffer]), req.file!.originalname || fallbackName);
          const body = (req.body ?? {}) as Record<string, unknown>;
          form.append('dryRun', String(body.dryRun === 'true' || body.dryRun === true));
          form.append('mode', modeOf(body.mode));

          const response = await masterFetch(masterPath, { method: 'POST', body: form });
          res.status(response.status).json(await response.json().catch(() => null));
        } catch (error) {
          unavailable(res, error);
        }
      })();
    },
  ];

  app.get(
    ['/api/products/import/template.:format', '/api/products/export.:format'],
    proxyDownload('products-template'),
  );
  app.post(
    '/api/products/import',
    ...proxyImport(importUpload, '/api/panel/products/import', 'products.csv', (mode) =>
      mode === 'upsert' ? 'upsert' : 'create',
    ),
  );

  app.get(['/api/parties/import/template.:format', '/api/parties/export.:format'], proxyDownload('parties-template'));
  app.post(
    '/api/parties/import',
    ...proxyImport(partyImportUpload, '/api/panel/parties/import', 'parties.csv', (mode) =>
      mode === 'updateByCode' ? 'updateByCode' : 'create',
    ),
  );

  app.post('/api/products', (req, res) =>
    queue(res, { kind: 'product.create', entity: 'product', payload: req.body }),
  );
  app.put('/api/products/:id', (req, res) =>
    queue(res, {
      kind: 'product.update',
      entity: 'product',
      entityId: req.params.id,
      payload: req.body,
      baseFieldHlc: req.body?.baseFieldHlc,
    }),
  );

  // Images stay online-only, like Stock and Recycle Bin — the offline outbox
  // carries JSON mutations, and there is no mechanism to queue a multipart
  // file through it (`7-IMAGE-PIPELINE.md` port notes, `HANDOFF.md`).
  app.post('/api/products/:productId/images', imageUpload.single('file'), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'validation_error', message: 'Choose an image file' });
      return;
    }
    /*
     * Over HTTP, not the command socket.
     *
     * A photo is up to `MAX_SOURCE_BYTES`, and carrying it as a socket frame
     * forced `maxHttpBufferSize` to that size — a ceiling set by the largest
     * image anybody might drag in, applied to every sync push and every
     * command on the connection.
     */
    void (async () => {
      try {
        const form = new FormData();
        form.append('file', new Blob([req.file!.buffer]), req.file!.originalname || 'image');
        for (const field of [
          'cropX',
          'cropY',
          'cropWidth',
          'cropHeight',
          'rotationDeg',
          'caption',
        ]) {
          const value = (req.body as Record<string, unknown>)[field];
          if (value !== undefined && value !== null) form.append(field, String(value));
        }

        const response = await masterFetch(
          `/api/panel/products/${encodeURIComponent(String(req.params.productId))}/images`,
          { method: 'POST', body: form },
        );

        const body = await response.json().catch(() => null);
        res.status(response.status).json(body);
      } catch (error) {
        res.status(503).json({
          error: 'unavailable',
          message: error instanceof Error ? error.message : 'The Master Panel is not reachable',
        });
      }
    })();
  });
  app.patch('/api/products/:productId/images/:imageId', (req, res) =>
    forward(res, 'product:image:update', { id: req.params.imageId, input: req.body }),
  );
  app.post('/api/products/:productId/images/reorder', (req, res) =>
    forward(res, 'product:image:reorder', {
      productId: req.params.productId,
      ids: req.body.ids ?? [],
    }),
  );
  app.delete('/api/products/:productId/images/:imageId', (req, res) =>
    forward(res, 'product:image:delete', req.params.imageId),
  );

  // The already-derived variant an `<img>` tag points at — served from this
  // panel's own local cache when present (instant, no Master round trip);
  // fetched once from the Master and cached to disk on a miss. Not the
  // spec's full proactive background-prefetch queue (§4.3) — see
  // `HANDOFF.md` for why that gap is deliberate here.
  app.get('/uploads/images/:imageId/:variant', async (req, res) => {
    const { imageId, variant } = req.params;
    // Express decodes route params after it has matched the path, so an
    // encoded separator arrives here as a real one and would walk `path.join`
    // straight out of the cache directory. The Master mints image ids with
    // `randomUUID()`, so anything that is not one cannot name a cached file.
    if (!(IMAGE_VARIANTS as readonly string[]).includes(variant) || !UUID_PATTERN.test(imageId)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const localPath = path.join(paths().imagesDir, imageId, `${variant}.webp`);
    if (existsSync(localPath)) {
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.type('image/webp');
      res.sendFile(localPath);
      return;
    }

    try {
      const response = await masterFetch(
        `/api/panel/images/${encodeURIComponent(imageId)}/${encodeURIComponent(variant)}`,
      );

      if (!response.ok) {
        // The Master answered and refused — a 404 for a product this person
        // may not see, which is the translation `resolveImageFile` makes.
        res.status(response.status === 401 ? 401 : 404).json({ error: 'not_found' });
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await mkdir(path.dirname(localPath), { recursive: true });
      await writeFile(localPath, buffer);
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.type('image/webp');
      res.send(buffer);
    } catch (error) {
      // No answer at all: the Master is off, which is a 503 the browser can
      // retry, not a 404 that says the image does not exist.
      res.status(503).json({
        error: 'unavailable',
        message: error instanceof Error ? error.message : 'The Master Panel is not reachable',
      });
    }
  });

  /**
   * The same same-origin, cache-then-fetch pattern as `/uploads/images`
   * above, for a face rather than a product photo. `ui/src/Avatar.tsx`'s
   * default `src` points here rather than at a Master-only absolute URL —
   * this panel has its own sign-in-time cache (`avatar-cache.ts`) for the one
   * variant that screen needs, but any other avatar (a co-worker's picture on
   * the Party Access roster, say) falls through to the Master exactly like a
   * product image does.
   */
  app.get('/uploads/avatars/:avatarId/:variant', async (req, res) => {
    const { avatarId, variant } = req.params;
    const localPath = avatarFile(avatarId, variant);
    if (!localPath) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    if (existsSync(localPath)) {
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.type('image/webp');
      res.sendFile(localPath);
      return;
    }

    try {
      const response = await masterFetch(
        `/api/panel/avatars/${encodeURIComponent(avatarId)}/${encodeURIComponent(variant)}`,
      );

      if (!response.ok) {
        res.status(response.status === 401 ? 401 : 404).json({ error: 'not_found' });
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await mkdir(path.dirname(localPath), { recursive: true });
      await writeFile(localPath, buffer);
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.type('image/webp');
      res.send(buffer);
    } catch (error) {
      res.status(503).json({
        error: 'unavailable',
        message: error instanceof Error ? error.message : 'The Master Panel is not reachable',
      });
    }
  });

  app.post('/api/party-variants', (req, res) =>
    queue(res, { kind: 'partyVariant.upsert', entity: 'party_variant', payload: req.body }),
  );

  app.post('/api/leads', (req, res) =>
    queue(res, {
      kind: 'lead.create',
      entity: 'lead',
      payload: req.body,
      validate: () => leadPayloadProblem(req.body, { itemsRequired: true }),
      awaitNumber: true,
    }),
  );
  app.put('/api/leads/:id', (req, res) =>
    queue(res, {
      kind: 'lead.update',
      entity: 'lead',
      entityId: req.params.id,
      payload: req.body,
      baseFieldHlc: req.body?.baseFieldHlc,
      validate: () => leadPayloadProblem(req.body, { itemsRequired: false }),
    }),
  );
  app.post('/api/leads/:id/stage', (req, res) =>
    queue(res, {
      kind: 'lead.setStage',
      entity: 'lead',
      entityId: req.params.id,
      payload: { stageId: req.body?.stageId, remark: req.body?.remark ?? null },
    }),
  );
  app.post('/api/leads/:id/remarks', (req, res) =>
    queue(res, {
      kind: 'lead.addRemark',
      entity: 'lead',
      entityId: req.params.id,
      payload: { message: req.body?.message },
    }),
  );
  app.post('/api/leads/:id/convert', (req, res) =>
    queue(res, {
      kind: 'lead.convert',
      entity: 'lead',
      entityId: req.params.id,
      payload: req.body ?? {},
    }),
  );

  /**
   * The lead PDF (`docs/catalogue/CATALOGUE_MODEL.md` §8), rendered by the
   * Master and handed to the browser `inline`, so Preview PDF opens it rather
   * than saving it. Online-only: the Master holds the renderer and the fonts.
   */
  app.get('/api/leads/:id/pdf', (req, res) => {
    void (async () => {
      try {
        const pdf = await masterConnection.command<
          'lead:pdf',
          { fileName: string; bytes: Uint8Array }
        >('lead:pdf', req.params.id);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${pdf.fileName}"`);
        res.send(Buffer.from(pdf.bytes));
      } catch (error) {
        failForward(res, error);
      }
    })();
  });

  app.put('/api/orders/:id', (req, res) =>
    queue(res, {
      kind: 'order.update',
      entity: 'order',
      entityId: req.params.id,
      payload: req.body,
      baseFieldHlc: req.body?.baseFieldHlc,
    }),
  );
  app.post('/api/orders/:id/stage', (req, res) =>
    queue(res, {
      kind: 'order.setStage',
      entity: 'order',
      entityId: req.params.id,
      payload: { stageId: req.body?.stageId, remark: req.body?.remark ?? null },
    }),
  );
  app.post('/api/orders/:id/dispatch', (req, res) =>
    queue(res, {
      kind: 'order.dispatch',
      entity: 'order',
      entityId: req.params.id,
      payload: { note: req.body?.note ?? null },
    }),
  );

  // Stock stays online-only. An unconfirmed quantity shown as real stock
  // would be worse than the last figure the Master actually agreed to.
  app.post('/api/stock/inbound', (req, res) => forward(res, 'stock:inbound', req.body));
  app.post('/api/stock/adjust', (req, res) => forward(res, 'stock:adjust', req.body));
  app.post('/api/stock/reorder-level', (req, res) =>
    forward(res, 'stock:setReorderLevel', req.body),
  );

  app.get('/api/search', (req, res) =>
    forward(res, 'search:query', { term: String(req.query.q ?? ''), limit: 20 }),
  );

  /**
   * The searchable picker, answered locally when the Master is off.
   *
   * Online it forwards, so the picker sees the whole catalogue and the Master's
   * own ranking. Offline it falls back to this panel's cached snapshot — which
   * is the point of the product — and says so, because that snapshot holds one
   * page per collection rather than everything.
   *
   * The view it ranks is `forCurrentUser(...)`, **never** the raw one: the raw
   * snapshot was built for whoever was signed in when the link last worked, and
   * carries the restricted parties granted to them, which this person may not
   * be allowed to see.
   */
  app.get('/api/pick/:kind', (req, res) => {
    const kind: unknown = String(req.params.kind);
    if (!isPickKind(kind)) {
      res.status(400).json({ error: 'validation_error', message: 'Unknown pick kind' });
      return;
    }

    const query = {
      term: String(req.query.q ?? ''),
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      include: String(req.query.include ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
      // The lead screen's second stage: products inside the chosen category.
      categoryId: typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined,
    };

    void (async () => {
      try {
        res.json(await masterConnection.command('pick' as never, { kind, query }));
      } catch (error) {
        if (!(error instanceof MasterCommandError && error.unreachable)) {
          failForward(res, error);
          return;
        }

        try {
          const view = await localStore.getView();
          if (!view) {
            res.json({ items: [], truncated: false, offline: true });
            return;
          }

          const page = pickFromView(
            kind,
            query,
            forCurrentUser(view),
            userSession.sessionPermissions(),
          );

          // `offline` is what lets the listbox say the list is a cached page
          // rather than the catalogue. A picker that quietly narrows teaches
          // people the thing they want is not there.
          res.json({ ...page, offline: true });
        } catch (offlineError) {
          if (offlineError instanceof OfflinePickForbidden) {
            res.status(403).json({
              error: 'forbidden',
              message: offlineError.message,
              details: { permission: offlineError.permission },
            });
            return;
          }
          failForward(res, offlineError);
        }
      }
    })();
  });

  app.get('/api/conflicts', (_req, res) => forward(res, 'conflict:list'));
  app.post('/api/conflicts/:id/resolve', (req, res) =>
    forward(res, 'conflict:resolve', {
      conflictId: Number(req.params.id),
      action: req.body?.action,
    }),
  );

  // Recycle Bin (docs/backend-modules/04-API-CONTRACT.md §4). Forwarded live
  // and failing hard offline, like every other module in this batch —
  // nothing here is queued into the outbox: a soft delete queued for later
  // could apply against a lead whose lines have since changed, and a queued
  // restore has the same character.
  app.delete('/api/parties/:id', (req, res) => forward(res, 'party:delete', req.params.id));
  app.delete('/api/products/:id', (req, res) => forward(res, 'product:delete', req.params.id));
  app.delete('/api/leads/:id', (req, res) => forward(res, 'lead:delete', req.params.id));
  app.delete('/api/orders/:id', (req, res) => forward(res, 'order:delete', req.params.id));

  app.get('/api/recycle-bin', (req, res) => {
    const rawTypes = req.query.types;
    const types = Array.isArray(rawTypes)
      ? rawTypes.map(String)
      : rawTypes
        ? [String(rawTypes)]
        : undefined;

    return forward(res, 'recycleBin:list', {
      types,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      deletedBy: typeof req.query.deletedBy === 'string' ? req.query.deletedBy : undefined,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
  });
  app.get('/api/recycle-bin/counts', (_req, res) => forward(res, 'recycleBin:counts'));
  app.post('/api/recycle-bin/restore', (req, res) => forward(res, 'recycleBin:restore', req.body));

  // Party Access. Forwarded live and failing hard offline, for the same reason
  // as Fields below: a grant set is company-wide configuration approved as a
  // whole, with no field-level merge to fall back on, so two administrators
  // editing it offline would merge into a union neither of them approved.
  app.get('/api/party-access', (req, res) =>
    forward(res, 'partyAccess:list', {
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      userId: typeof req.query.userId === 'string' ? req.query.userId : undefined,
      restriction:
        req.query.restriction === 'open' || req.query.restriction === 'restricted'
          ? req.query.restriction
          : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    }),
  );
  // --- App update ----------------------------------------------------------
  // Asks the Master directly over HTTP (`masterFetch`, the Master's
  // `/api/updates/office/*` routes) rather than through `forward`: the
  // download is a 100 MB stream, and a command socket is no place for it.
  // Both routes need a signed-in person, as everything past the `/api` gate
  // does — the Updates screen only renders after sign-in. What that screen
  // must work without is the first snapshot, not a session (`alwaysAvailable`
  // in `office/web/src/App.tsx`).

  app.get('/api/updates/available', requireUser, (_req, res) => {
    void updateService
      .availableUpdate()
      .then((availability) => res.json(availability))
      .catch((error: unknown) => respondToUpdateFailure(res, error));
  });

  /** Check now (1.4 R6): the Master asks GitHub before it answers. Any signed-in person may look. */
  app.post('/api/updates/check', requireUser, (_req, res) => {
    void updateService
      .availableUpdate({ check: true })
      .then((availability) => res.json(availability))
      .catch((error: unknown) => respondToUpdateFailure(res, error));
  });

  /** Where this panel's download from the Master stands, for the progress bar (1.4 R7). */
  app.get('/api/updates/progress', requireUser, (_req, res) => {
    res.json(updateService.downloadStatus());
  });

  /**
   * Downloads and verifies, then hands back a path. Running it is the desktop
   * shell's job — this process is the one being replaced.
   */
  app.post('/api/updates/download', requireUser, (_req, res) => {
    // Behind the Master, anyone signed in may update: the "Update needed" screen
    // (1.4 R7e) blocks everything else, so it would be a dead end otherwise.
    const mandatory = standing(appVersion(), masterConnection.getStatus().masterVersion) === 'behind';
    if (!mandatory && !userSession.can('settings.manage')) {
      res.status(403).json({
        error: 'forbidden',
        message: 'Missing permission: settings.manage',
        details: { permission: 'settings.manage' },
      });
      return;
    }

    void updateService
      .downloadUpdate()
      .then((result) => res.json(result))
      .catch((error: unknown) => respondToUpdateFailure(res, error));
  });

  app.get('/api/party-access/people', (_req, res) => forward(res, 'partyAccess:people'));
  // Through `forwardCsv`, the same path Logs and Reports already take, so this
  // panel serves the file rather than needing a download route of its own.
  app.get('/api/party-access/export.csv', (_req, res) =>
    forwardCsv(res, 'partyAccess:export', undefined, 'party-access.csv'),
  );
  app.get('/api/party-access/:partyId', (req, res) =>
    forward(res, 'partyAccess:forParty', req.params.partyId),
  );
  app.put('/api/party-access/:partyId', (req, res) =>
    forward(res, 'partyAccess:replace', { partyId: req.params.partyId, input: req.body }),
  );

  // Fields (docs/backend-modules/04-API-CONTRACT.md §5). Forwarded live and
  // failing hard offline, like every other module in this batch — a curated
  // list is company-wide configuration, and two disconnected panels editing
  // it offline have no field-level merge to fall back on (option_lists and
  // custom_field_definitions carry no hlc/field_hlc).
  app.get('/api/fields/catalogue', (_req, res) => forward(res, 'fields:catalogue'));
  app.get('/api/fields/values', (req, res) =>
    forward(res, 'fields:values', {
      listKey: req.query.listKey,
      includeDeleted: req.query.includeDeleted === 'true',
      includeUnlisted: req.query.includeUnlisted === 'true',
    }),
  );
  app.get('/api/fields/usage', (req, res) =>
    forward(res, 'fields:usage', { listKey: req.query.listKey }),
  );
  app.post('/api/fields/values', (req, res) => forward(res, 'fields:createValue', req.body));
  app.put('/api/fields/values/:id', (req, res) =>
    forward(res, 'fields:updateValue', { id: req.params.id, input: req.body }),
  );
  app.delete('/api/fields/values/:id', (req, res) =>
    forward(res, 'fields:deleteValue', req.params.id),
  );
  app.post('/api/fields/values/reorder', (req, res) =>
    forward(res, 'fields:reorderValues', req.body),
  );

  // Settings → Leads (`docs/catalogue/CATALOGUE_MODEL.md` §5): one company
  // setting, written live. The Master decides which key, and that the writer
  // is a signed-in person holding `settings.manage` (`assertPanelSettingWrite`).
  app.put('/api/settings/:key', (req, res) =>
    forward(res, 'settings:save', { key: req.params.key, value: req.body?.value }),
  );

  app.get('/api/fields/definitions', (req, res) =>
    forward(res, 'fields:definitions', {
      entity: req.query.entity,
      includeDeleted: req.query.includeDeleted === 'true',
    }),
  );
  app.post('/api/fields/definitions', (req, res) =>
    forward(res, 'fields:createDefinition', req.body),
  );
  app.put('/api/fields/definitions/:id', (req, res) =>
    forward(res, 'fields:updateDefinition', { id: req.params.id, input: req.body }),
  );
  app.delete('/api/fields/definitions/:id', (req, res) =>
    forward(res, 'fields:deleteDefinition', req.params.id),
  );
  app.post('/api/fields/definitions/reorder', (req, res) =>
    forward(res, 'fields:reorderDefinitions', req.body),
  );

  app.get('/api/fields/stages', (_req, res) => forward(res, 'fields:stages'));
  app.put('/api/fields/stages/:id', (req, res) =>
    forward(res, 'fields:updateStage', { id: req.params.id, input: req.body }),
  );
  app.post('/api/fields/stages/reorder', (req, res) =>
    forward(res, 'fields:reorderStages', req.body),
  );
  app.post('/api/fields/stages/:id/archive', (req, res) =>
    forward(res, 'fields:archiveStage', req.params.id),
  );
  app.post('/api/fields/stages/:id/restore', (req, res) =>
    forward(res, 'fields:restoreStage', req.params.id),
  );

  // Logs (docs/backend-modules/04-API-CONTRACT.md §2). Forwarded live and
  // failing hard offline, like every other module in this batch.
  function parseLogQuery(query: Record<string, unknown>): Record<string, unknown> {
    return {
      cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
      direction:
        query.direction === 'newer' ? 'newer' : query.direction === 'older' ? 'older' : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      actorType: typeof query.actorType === 'string' ? query.actorType : undefined,
      actorId: typeof query.actorId === 'string' ? query.actorId : undefined,
      entityType: typeof query.entityType === 'string' ? query.entityType : undefined,
      action: typeof query.action === 'string' ? query.action : undefined,
      from: typeof query.from === 'string' ? query.from : undefined,
      to: typeof query.to === 'string' ? query.to : undefined,
      q: typeof query.q === 'string' ? query.q : undefined,
    };
  }

  app.get('/api/logs', (req, res) => forward(res, 'log:list', parseLogQuery(req.query)));
  app.get('/api/logs/facets', (req, res) =>
    forward(res, 'log:facets', {
      from: typeof req.query.from === 'string' ? req.query.from : undefined,
      to: typeof req.query.to === 'string' ? req.query.to : undefined,
    }),
  );
  app.post('/api/logs/verify', (req, res) => forward(res, 'log:verifyChain', req.body ?? {}));
  // CSV as a string in the ack, per `04-API-CONTRACT.md` §10.2 — bounded by
  // the same hard cap as the Master's own direct export.
  app.get('/api/logs/export', (req, res) => {
    const from = typeof req.query.from === 'string' ? req.query.from : 'all';
    const to = typeof req.query.to === 'string' ? req.query.to : 'all';
    // The CSV's `sentence` column is rendered on the Master, in this language.
    const locale = isLocale(req.query.locale) ? req.query.locale : undefined;
    return forwardCsv(res, 'log:export', { ...parseLogQuery(req.query), locale }, `logs-${from}-${to}.csv`);
  });

  // Reports (docs/backend-modules/04-API-CONTRACT.md §3). Forwarded live and
  // failing hard offline, like every other module in this batch. The query is
  // read once, by the shared `parseReportQuery`, so this server and the Master's
  // own routes cannot disagree about what a period or a subject is; who may ask
  // about whom is the Master's decision, never this server's.
  app.get('/api/reports/dispatches', (req, res) =>
    forward(res, 'report:dispatches', parseReportQuery(req.query)),
  );
  app.get('/api/reports/lead-outcomes', (req, res) =>
    forward(res, 'report:leadOutcomes', parseReportQuery(req.query)),
  );
  app.get('/api/reports/top-parties', (req, res) =>
    forward(res, 'report:topParties', parseReportQuery(req.query)),
  );
  // The kinds on offer, whom the person may pick, and whether to offer an export.
  app.get('/api/reports/options', (_req, res) => forward(res, 'report:options'));
  // Any of the fifteen kinds as one table — what the Reports screen draws.
  app.get('/api/reports/table/:report', (req, res) =>
    forward(res, 'report:table', { report: req.params.report, query: parseReportQuery(req.query) }),
  );
  /** The export options a query string carries, for the file route and the inline PDF route alike. */
  const reportExportQuery = (query: Record<string, unknown>) => {
    const columns = String(query.columns ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
    return {
      ...parseReportQuery(query),
      format: isReportFormat(query.format) ? query.format : undefined,
      columns: columns.length > 0 ? columns : undefined,
      totals: query.totals === 'true',
      paperSize: query.paperSize === 'letter' ? ('letter' as const) : undefined,
      orientation: query.orientation === 'portrait' ? ('portrait' as const) : undefined,
      lang: query.lang === 'hi' ? ('hi' as const) : undefined,
    };
  };

  /**
   * Preview PDF: the Master's PDF for a report, handed to the browser `inline`
   * so a window or a tab shows it. The same `report:export` command the file
   * route sends, with the format forced to `pdf`, so who may see what is the
   * Master's decision and nothing here widens it. Online only — the Master holds
   * the renderer and the fonts — so an unreachable Master is a 503.
   */
  app.get('/api/reports/:report/pdf', (req, res) => {
    void (async () => {
      try {
        const exported = await masterConnection.command<
          'report:export',
          | { format: 'csv'; csv: string; rowCount: number }
          | { format: 'pdf' | 'xlsx'; fileName: string; contentType: string; bytes: Uint8Array; rowCount: number }
        >('report:export', {
          report: req.params.report as ReportKind,
          query: { ...reportExportQuery(req.query), format: 'pdf' },
        });
        if (exported.format !== 'pdf') {
          res.status(502).json({ error: 'unavailable', message: 'The Master did not answer with a PDF' });
          return;
        }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${exported.fileName}"`);
        res.send(Buffer.from(exported.bytes));
      } catch (error) {
        failForward(res, error);
      }
    })();
  });

  /**
   * A report export, in whichever format the Master answered with.
   *
   * The ack is a discriminated union and this has to branch on it. It used to
   * cast to `{ csv: string }` and always set `text/csv` with a `.csv`
   * filename, so the moment a second format existed a PDF would have reached
   * the browser as a corrupt CSV — a file that opens, looks like nonsense, and
   * says nothing about why. The workbook is the third door through it.
   */
  app.get('/api/reports/:report/export', (req, res) => {
    const report = req.params.report;

    void (async () => {
      try {
        const exported = await masterConnection.command<
          'report:export',
          | { format: 'csv'; csv: string; rowCount: number }
          | {
              format: 'pdf' | 'xlsx';
              fileName: string;
              contentType: string;
              bytes: Uint8Array;
              rowCount: number;
            }
        >('report:export', {
          report: report as ReportKind,
          query: reportExportQuery(req.query),
        });

        if (exported.format === 'csv') {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${report}.csv"`);
          res.send(exported.csv);
          return;
        }

        res.setHeader('Content-Type', exported.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${exported.fileName}"`);
        res.send(Buffer.from(exported.bytes));
      } catch (error) {
        failForward(res, error);
      }
    })();
  });

  // Dashboard (docs/backend-modules/04-API-CONTRACT.md §7.2). The only live
  // pull — everything else rides on `SyncSnapshot.dashboard`, cached on
  // disk, and the `dashboard:changed` push. Cached figures stay on screen
  // with their `asOf` label when this fails offline.
  app.post('/api/dashboard/refresh', (_req, res) => forward(res, 'dashboard:get'));

  // --- Storage: export this device's replica, and restore onto this same
  // device (a migration to new hardware — docs/7-STORAGE-BACKUP-RESTORE.md
  // §2.2, §2.3, §2.4). Requires a signed-in person with `storage.manage`,
  // same as every other write in this file relies on `userSession.can`.

  app.post('/api/storage/export', async (req, res) => {
    if (!userSession.can('storage.manage')) {
      res
        .status(403)
        .json({ error: 'permission_denied', message: 'You do not have permission to do that' });
      return;
    }

    const { scope, officeScope, passphrase } = req.body ?? {};
    if (scope !== 'whole' && scope !== 'selected') {
      res.status(400).json({ error: 'validation_error', message: 'Choose a scope to export' });
      return;
    }
    if (typeof passphrase !== 'string' || !passphrase) {
      res.status(400).json({ error: 'validation_error', message: 'Enter the export passphrase' });
      return;
    }

    try {
      const result = await backupExportService.exportBackup({
        scope,
        officeScope: officeScope === 'settings-only' ? 'settings-only' : 'full-replica',
        passphrase,
      });
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(result.data);
    } catch (error) {
      respondToRestoreError(res, error);
    }
  });

  app.post('/api/storage/restore/preview', backupUpload.single('file'), (req, res) => {
    if (!userSession.can('storage.manage')) {
      res
        .status(403)
        .json({ error: 'permission_denied', message: 'You do not have permission to do that' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'validation_error', message: 'Choose a backup file' });
      return;
    }
    try {
      res.json(backupRestoreService.previewRestore(req.file.buffer));
    } catch (error) {
      respondToRestoreError(res, error);
    }
  });

  app.post('/api/storage/restore', backupUpload.single('file'), async (req, res) => {
    if (!userSession.can('storage.manage')) {
      res
        .status(403)
        .json({ error: 'permission_denied', message: 'You do not have permission to do that' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'validation_error', message: 'Choose a backup file' });
      return;
    }
    const { passphrase, confirmWipe } = req.body ?? {};
    if (typeof passphrase !== 'string' || !passphrase) {
      res.status(400).json({ error: 'validation_error', message: 'Enter the export passphrase' });
      return;
    }

    try {
      const outcome = await backupRestoreService.restoreBackup(
        req.file.buffer,
        passphrase,
        confirmWipe === 'true' || confirmWipe === true,
      );
      res.status(201).json(outcome);
      // The browser must reconnect through the normal pairing screen — this
      // process keeps running, but every cached credential and local file was
      // just replaced (`backup-restore.service.ts`), so the old link is stale.
      masterConnection.disconnect();
    } catch (error) {
      respondToRestoreError(res, error);
    }
  });

  // --- Developer mode (`shared/src/domain/developer.ts`): a signed-in person
  // gets to the door, the password opens it, and the token in
  // `x-developer-token` — not a permission — is what guards the one tool
  // behind it. No `userSession.can` here on purpose: there is no permission
  // that grants developer mode, and inventing one would let an administrator
  // hand it out. The session itself is already required by the `/api`
  // `requireUser` gate above, as it is for the storage routes. ---

  app.post('/api/developer/unlock', (req, res) => {
    void (async () => {
      const { password } = req.body ?? {};
      if (typeof password !== 'string' || !password) {
        res
          .status(400)
          .json({ error: 'validation_error', message: 'Enter the developer password' });
        return;
      }

      try {
        res.status(201).json(await developerService.unlock(password));
      } catch (error) {
        respondToDeveloperError(res, error);
      }
    })();
  });

  app.get('/api/developer/status', (req, res) => {
    res.json(developerService.status(req.header(DEVELOPER_TOKEN_HEADER)));
  });

  app.post('/api/developer/lock', (req, res) => {
    developerService.lock(req.header(DEVELOPER_TOKEN_HEADER));
    res.json({ ok: true });
  });

  app.post('/api/developer/reset-all', (req, res) => {
    void (async () => {
      if (!developerService.isUnlocked(req.header(DEVELOPER_TOKEN_HEADER))) {
        res.status(401).json({ error: 'developer_locked', message: 'Unlock developer mode first' });
        return;
      }
      if (req.body?.confirmation !== DEVELOPER_RESET_CONFIRMATION) {
        res.status(400).json({
          error: 'validation_error',
          message: `Type ${DEVELOPER_RESET_CONFIRMATION} to confirm`,
        });
        return;
      }

      try {
        res.json(await developerService.resetPanel());
      } catch (error) {
        respondToDeveloperError(res, error);
      }
    })();
  });

  // --- Live updates to this panel's browser ---
  app.get('/api/events', (req, res) => streamEvents(req, res));

  const webDist = path.join(config.packageRoot, 'web', 'dist');
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res, next) => {
    // See master/src/http/app.ts — web/dist is gitignored, so a fresh checkout
    // has no UI and would otherwise answer with a confusing JSON 404.
    if (!existsSync(path.join(webDist, 'index.html'))) {
      res.status(503).type('html').send(missingUiPage());
      return;
    }

    res.sendFile(path.join(webDist, 'index.html'), (error) => {
      if (error) next();
    });
  });

  /*
   * Mirrors `master/src/http/app.ts`. Without these, an unmatched `/api` path
   * fell through to Express's built-in HTML 404 — which `response.json()` in
   * both the browser client and the desktop shell parses as a thrown error
   * rather than a status, turning "no such endpoint" into "the panel is
   * broken".
   */
  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}

function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    error: 'not_found',
    message: 'Endpoint not found',
    messageKey: 'error.generic.notFound',
  });
}

function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  // A file that slipped past the client-side size check (an older browser
  // build, or a direct API caller) hit multer's own limit instead — a real,
  // actionable refusal, not an unexpected server failure. Without this branch
  // it fell into the generic 500 below with no indication of what went wrong.
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({
      error: 'validation_error',
      message: 'That file is too large',
      messageKey: 'validation.image.tooLarge',
    });
    return;
  }

  log.error('Unhandled request error', error);
  res.status(500).json({
    error: 'internal_error',
    message: 'Something went wrong',
    messageKey: 'error.generic.internal',
  });
}

/**
 * The shape check a queued lead has to pass before it is accepted.
 *
 * `queue()` writes `req.body` into the outbox verbatim, and the outbox is
 * durable — so a malformed lead is answered `202 queued`, sits on disk, and
 * then comes back hours later as a bare rejection string with no route back to
 * the form that produced it. This is the trust boundary the browser cannot
 * bypass (§1), and it is the last place a mistake can still be shown to the
 * person who made it.
 *
 * Deliberately structural only: a party that does not exist, a product that was
 * deleted, a party this person holds no access to — those are the Master's to
 * judge, and judging them here would need a catalogue this process does not
 * have. Nothing here rejects a *half-built* lead either; packaging stays
 * optional on save exactly as §3.1 requires.
 *
 * Run by `queue()` as its `validate` step, after the permission check, never
 * before it: somebody who may not make the write is told that, and nothing
 * about what a well-formed payload would have looked like.
 *
 * Returns the problem as a sentence, or null when the payload is sound.
 */
function leadPayloadProblem(body: unknown, options: { itemsRequired: boolean }): string | null {
  if (typeof body !== 'object' || body === null) return 'The lead was empty';
  const lead = body as Record<string, unknown>;

  if (options.itemsRequired && typeof lead.partyId !== 'string') {
    return 'Choose a party for this lead';
  }
  if (lead.partyId !== undefined && typeof lead.partyId !== 'string') {
    return 'Choose a party for this lead';
  }

  if (lead.items === undefined) {
    return options.itemsRequired ? 'Add at least one product' : null;
  }
  if (!Array.isArray(lead.items) || (options.itemsRequired && lead.items.length === 0)) {
    return 'Add at least one product';
  }

  for (const [index, raw] of lead.items.entries()) {
    const at = `Product ${index + 1}`;
    if (typeof raw !== 'object' || raw === null) return `${at} is empty`;
    const item = raw as Record<string, unknown>;

    if (typeof item.productId !== 'string' || !item.productId) {
      return `${at} has no product`;
    }
    if (typeof item.variantId !== 'string' || !item.variantId) {
      return `${at} has no variant`;
    }
    if (!(Number(item.quantity) > 0)) return `${at} needs a quantity`;
  }

  return null;
}

/**
 * Queue a write locally and answer at once.
 *
 * A create with no id yet gets a temporary one here, which is what the browser
 * then uses to address the record — including for follow-up edits made before
 * the Master has ever seen it.
 */
async function queue(
  res: Response,
  request: {
    kind: outbox.EnqueueRequest['kind'];
    entity: outbox.EnqueueRequest['entity'];
    entityId?: string;
    payload: unknown;
    baseFieldHlc?: Record<string, string>;
    /** A shape check on the payload — a sentence when it fails, null when sound. */
    validate?: () => string | null;
    /** Wait (connected only) for the Master's permanent id and pending-order number. */
    awaitNumber?: boolean;
  },
): Promise<void> {
  const session = userSession.currentSession();
  const permission = MUTATION_PERMISSIONS[request.kind];

  // While the Master is unreachable this is the *only* check standing between a
  // person and a write. It runs against the permission set cached at their last
  // online sign-in, and the Master re-checks the same table on push — refusing
  // here simply means the refusal arrives now rather than a shift later.
  if (permission && !userSession.can(permission)) {
    res.status(403).json({
      error: 'permission_denied',
      message: 'You do not have permission to do that',
      permission,
    });
    return;
  }

  // Only now the shape, so a caller the check above turns away learns nothing
  // about what the route would have accepted.
  const problem = request.validate?.() ?? null;
  if (problem) {
    res.status(400).json({ error: 'validation_error', message: problem });
    return;
  }

  try {
    // The edit's field clocks travel on the mutation, never inside its payload:
    // left there, `baseFieldHlc` became one of the fields the edit claimed to set.
    const { baseFieldHlc: _clocks, ...payload } = (request.payload ?? {}) as Record<string, unknown>;
    const entityId = request.entityId ?? (await nextTemporaryId());

    const mutation = await sync.submit({
      kind: request.kind,
      entity: request.entity,
      entityId,
      payload,
      fields: Object.keys(payload),
      baseFieldHlc: fieldClocks(request.baseFieldHlc),
      // Stamped so work done offline is attributed to the person who did it
      // once it reaches the Master. It grants nothing: the Master takes the
      // authority for a push from the session token this panel presented, never
      // from a name inside the envelope.
      actorUserId: session?.userId ?? null,
    });

    // Waited for before the count, which the answer usually shrinks.
    const numbering = request.awaitNumber ? await numberingOf(mutation.mutationId) : {};

    res.status(202).json({
      queued: true,
      id: entityId,
      mutationId: mutation.mutationId,
      pendingCount: await outbox.pendingCount(),
      ...numbering,
    });
  } catch (error) {
    log.error('Could not queue the change', error);
    res.status(500).json({
      error: 'queue_failed',
      message: 'Could not save locally — check disk space and permissions',
    });
  }
}

/**
 * What a new pending order's save can say about its number.
 *
 * While the link is up the save waits (up to `saveNumberWaitMs`) for the push
 * that carries it, so the toast can name the number. Offline, or when the
 * Master is slow, it answers Provisional at once: the lead is already safe in
 * the outbox, and the number follows over the `numbered` event.
 */
async function numberingOf(mutationId: string): Promise<Record<string, unknown>> {
  if (masterConnection.getStatus().state !== 'connected') return { status: 'provisional' };

  const settled = await sync.awaitSettled(mutationId, config.sync.saveNumberWaitMs);
  if (!settled) return { status: 'provisional' };
  if (settled.result.status === 'rejected') {
    return { status: 'rejected', error: settled.result.error ?? null };
  }
  return {
    status: 'numbered',
    permanentId: settled.permanentId,
    // Absent from a Master too old to mint one; the screen shows the id instead.
    ...(settled.poNumber ? { poNumber: settled.poNumber } : {}),
  };
}

/** Field clocks as the browser sent them, keeping only field-to-clock strings. */
function fieldClocks(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const clocks: Record<string, string> = {};
  for (const [field, hlc] of Object.entries(value)) {
    if (typeof hlc === 'string') clocks[field] = hlc;
  }
  return clocks;
}

/**
 * A presence beat with nothing but the fields the protocol defines. The Master
 * checks the values and takes who is beating from this panel's session.
 */
function presenceBeat(body: unknown): PresenceBeat {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  return {
    tabId: typeof raw.tabId === 'string' ? raw.tabId : '',
    ...(raw.recordKind === 'lead' || raw.recordKind === 'order' ? { recordKind: raw.recordKind } : {}),
    ...(typeof raw.recordId === 'string' ? { recordId: raw.recordId } : {}),
    ...(typeof raw.editing === 'boolean' ? { editing: raw.editing } : {}),
  };
}

/**
 * Re-shape the cached snapshot for whoever is signed in *now*.
 *
 * The snapshot on disk was built by the Master for whoever was signed in when
 * the link last worked. The permissions it carries are replaced: the browser
 * renders controls from the session rather than the snapshot, but leaving the
 * previous person's set in a payload is a trap for the next thing that reads
 * it. The dashboard figures and the party scope are re-applied for the same
 * reason.
 */
type LocalView = SyncSnapshot & { pendingCount: number };

/**
 * Which permission gates each `DashboardSummary` figure — kept in one place
 * so `filterDashboardForCurrentUser` and any future figure agree on the
 * mapping `docs/backend-modules/04-API-CONTRACT.md` §7.1 defines.
 */
const DASHBOARD_FIGURE_PERMISSIONS: Record<
  Exclude<keyof SyncSnapshot['dashboard'], 'asOf' | 'pipelineBreakdown'>,
  string
> = {
  leadCount: 'leads.view',
  followUpsDueCount: 'leads.view',
  orderCount: 'orders.view',
  openOrderCount: 'orders.view',
  dispatchedThisWeekCount: 'orders.view',
  convertedTodayCount: 'orders.view',
  dispatchedTodayCount: 'orders.view',
  partyCount: 'parties.view',
  productCount: 'products.view',
  lowStockCount: 'inventory.view',
  openConflictCount: 'sync.resolveConflicts',
  pendingSyncCount: 'sync.resolveConflicts',
};

/**
 * The cached snapshot on disk was built for whoever was signed in *then*.
 * Re-filters `dashboard` for whoever is signed in *now*, stripping a figure
 * the current session may not see rather than trusting the cached one already
 * omitted it correctly for this reader.
 */
function filterDashboardForCurrentUser(
  dashboard: SyncSnapshot['dashboard'],
  permissions: string[],
): SyncSnapshot['dashboard'] {
  const filtered: SyncSnapshot['dashboard'] = { asOf: dashboard.asOf };

  for (const [key, permission] of Object.entries(DASHBOARD_FIGURE_PERMISSIONS) as Array<
    [keyof typeof DASHBOARD_FIGURE_PERMISSIONS, string]
  >) {
    if (permissions.includes(permission) && dashboard[key] !== undefined) {
      (filtered as unknown as Record<string, unknown>)[key] = dashboard[key];
    }
  }

  if (permissions.includes('leads.view') && dashboard.pipelineBreakdown !== undefined) {
    filtered.pipelineBreakdown = dashboard.pipelineBreakdown;
  }

  return filtered;
}

/**
 * What `forCurrentUser` does with each `SyncSnapshot` key, kept as a map typed
 * over `keyof SyncSnapshot` so a newly added collection is a compile error
 * here rather than a silent leak — the failure mode `docs/backend-modules/
 * 10-TESTING.md` §6.8 (`DSH-1`) calls out for this snapshot. The map is the
 * inventory the pure test pins; `forCurrentUser` below is what actually runs.
 */
type SnapshotPolicy = 'replace' | 'gate' | 'passthrough';

export const SNAPSHOT_POLICY: Record<keyof SyncSnapshot, SnapshotPolicy> = {
  // The Master's boot id and change-ring position. Neither is company data —
  // they are how this panel asks for a delta next time — and both are already
  // on this panel's disk.
  bootId: 'passthrough',
  seq: 'passthrough',
  parties: 'passthrough',
  products: 'passthrough',
  categories: 'passthrough',
  partyVariants: 'passthrough',
  leads: 'passthrough',
  orders: 'passthrough',
  stock: 'passthrough',
  pipelines: 'passthrough',
  optionLists: 'passthrough',
  customFields: 'passthrough',
  conflicts: 'passthrough',
  dashboard: 'gate',
  permissions: 'replace',
  serverHlc: 'passthrough',
  serverTime: 'passthrough',
  serverVersion: 'passthrough',
  // The Master's protocol number. Not company data, the same for whoever reads it.
  protocol: 'passthrough',
  // Already computed per-actor by the Master, exactly like `permissions` and
  // `dashboard`. This panel re-gates a cached snapshot for whoever is signed in
  // *now*, but it cannot recompute a Party Access grant it was never told
  // about, so a stale value here is why the snapshot is re-fetched on sign-in.
  // Both are computed per-actor by the Master. `forCurrentUser` uses them
  // together to decide whether a cached snapshot still belongs to whoever is
  // signed in — see `withoutAnotherPersonsParties` below.
  partyGrants: 'gate',
  builtForUserId: 'passthrough',
  // Not company data — just says whether `products` above is the complete
  // catalogue or one clamped/permission-emptied page.
  productsComplete: 'passthrough',
  // The company's switches. Not per-person — the same company for whoever is
  // signed in — so nothing here is re-gated or re-scoped for the reader.
  //
  // This used to say a stale switch "can only be as stale as `stock`". That
  // was wrong, and only looked right for `inventory.freeToSell`: `stock` is
  // replayable and gets live upserts, while `features` had no change event of
  // any kind, so it was refreshed exactly once per snapshot. `'setting'` is a
  // `ChangedEntity` now and forces a fresh snapshot, which is what finally
  // makes the sentence above true.
  features: 'passthrough',
};

/**
 * Drop the restricted parties from a snapshot that was scoped for somebody
 * else, and everything hanging off them.
 *
 * Only reachable offline: signing in online re-fetches the snapshot for the new
 * person. Offline there is nobody to ask, and without this the second person to
 * sign in on a panel would be shown the first person's restricted parties —
 * which is the easiest way around the whole feature there is.
 *
 * What survives is the parties the previous person held **no grant** on. Those
 * are the ones open to everyone: a party restricted to somebody else never
 * entered this snapshot at all, so a party that is here and ungranted is
 * unassigned, and unassigned means open. The new person may well hold grants of
 * their own on parties dropped here — they get them back on reconnect, which is
 * the right way round to be wrong.
 */
function withoutAnotherPersonsParties(view: LocalView): LocalView {
  const signedInAs = userSession.currentSession()?.userId ?? null;

  // Same person, or a Master too old to say — nothing to withhold. `undefined`
  // stays permissive on purpose: an older Master sent no restricted parties in
  // the first place, because it had no such concept.
  if (view.builtForUserId === undefined || view.builtForUserId === signedInAs) return view;

  const restricted = new Set((view.partyGrants ?? []).map((grant) => grant.partyId));
  if (restricted.size === 0) return { ...view, partyGrants: [] };

  return {
    ...view,
    partyGrants: [],
    parties: view.parties.filter((party) => !restricted.has(party.id)),
    leads: view.leads.filter((lead) => !restricted.has(lead.partyId)),
    orders: view.orders.filter((order) => !restricted.has(order.partyId)),
    partyVariants: view.partyVariants.filter((variant) => !restricted.has(variant.partyId)),
  };
}

function forCurrentUser(view: LocalView): LocalView {
  const permissions = userSession.sessionPermissions();
  const scoped = withoutAnotherPersonsParties(view);

  return {
    ...scoped,
    permissions,
    dashboard: filterDashboardForCurrentUser(scoped.dashboard, permissions),
  };
}

/**
 * An update failure, told apart by what a person can do about it.
 *
 * `unreachable` is a 503 for the same reason `forward` uses one: "the Master is
 * not there" is a wait-and-retry, and collapsing it into the same 502 as "the
 * file was corrupt" would have somebody re-copying a perfectly good installer
 * because the network was down.
 */
function respondToUpdateFailure(res: Response, error: unknown): void {
  if (error instanceof UpdateError) {
    const status = error.code === 'unreachable' || error.code === 'unpaired' ? 503 : 400;
    res.status(status).json({ error: error.code, message: error.message });
    return;
  }

  res.status(500).json({
    error: 'update_failed',
    message: error instanceof Error ? error.message : 'The update could not be prepared',
  });
}

/**
 * Refuse anything that is not being done by a signed-in person.
 *
 * This panel's API is loopback-only, so this is not a network defence — it is
 * what stops the UI from operating under the panel's own role when nobody has
 * identified themselves. Before per-user sign-in existed, every write from this
 * machine was attributed to the machine; now an unattributed write is a bug.
 */
function requireUser(_req: Request, res: Response, next: NextFunction): void {
  if (!userSession.currentSession()) {
    res.status(401).json({ error: 'not_signed_in', message: 'Sign in to use this panel' });
    return;
  }
  next();
}

/**
 * Forward a command that genuinely needs the Master, and answer honestly.
 *
 * The two failures are not the same thing and used to be collapsed into one
 * 502 carrying the raw message: a `PERMISSION_DENIED`, a `VALIDATION_FAILED`
 * and "Not connected to the Master Panel" were indistinguishable to the
 * browser, and the missing-permission key the hub took care to send was
 * discarded on the way through.
 *
 * `UNAVAILABLE` (503) is §13's code for a path that needs the Master when it
 * cannot be reached — the one code this panel is entitled to invent, because it
 * is a fact about the panel rather than an answer from the Master.
 */
/**
 * How a forwarded command's failure reaches the browser.
 *
 * One function, because there were three copies and they had already drifted:
 * `forward` passed the Master's `missingPermission` through as
 * `details.permission` and the other two silently dropped it, so a control the
 * browser should have hidden stayed on screen for anybody who happened to use
 * an export.
 *
 * The distinction it exists to keep is between **silence** and a **refusal**.
 * `unreachable` means the Master did not answer and the caller may retry;
 * anything else means it answered and said no, and its own code, messageKey,
 * params and details are passed straight through so the browser can hide a
 * control, render the reader's own language, and act on structured facts.
 */
function failForward(res: Response, error: unknown): void {
  if (error instanceof MasterCommandError && error.unreachable) {
    res
      .status(503)
      .json({ error: 'unavailable', message: error.message, messageKey: 'error.unavailable' });
    return;
  }

  const message = error instanceof Error ? error.message : 'Command failed';
  const code = error instanceof MasterCommandError ? error.code : undefined;

  // 426 for a Master too old for the command (`MasterConnection.command()`'s
  // protocol gate): the request was fine, the Master needs an update.
  res.status(code === 'forbidden' ? 403 : code === 'updateNeeded' ? 426 : 502).json({
    error: code ?? 'master_command_failed',
    message,
    ...(error instanceof MasterCommandError && error.messageKey
      ? { messageKey: error.messageKey }
      : {}),
    ...(error instanceof MasterCommandError && error.params ? { params: error.params } : {}),
    ...(error instanceof MasterCommandError && error.details
      ? { details: error.details }
      : error instanceof MasterCommandError && error.missingPermission
        ? { details: { permission: error.missingPermission } }
        : {}),
  });
}

/**
 * Lets the outbox hand over whatever is queued, for at most a few seconds: a
 * Printroom send waits for it so the Master reads the order as this screen
 * showed it, but a slow or dead link must not hold the send for a minute.
 * Never rejects.
 */
async function flushBriefly(): Promise<void> {
  const FLUSH_WAIT_MS = 4000;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      sync.flush().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FLUSH_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function forward(res: Response, event: string, ...payload: unknown[]): Promise<void> {
  try {
    const data = await masterConnection.command(event as never, ...payload);
    res.json(data);
  } catch (error) {
    failForward(res, error);
  }
}

/**
 * For the commands whose successful result is a `text/csv` download rather than
 * a JSON body. Only the success path differs from `forward()`; the failure path
 * is `failForward` in both.
 */
async function forwardCsv(
  res: Response,
  event: string,
  payload: unknown,
  filename: string,
): Promise<void> {
  try {
    const result = (await masterConnection.command(event as never, payload)) as {
      csv: string;
      rowCount: number;
    };

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(result.csv);
  } catch (error) {
    failForward(res, error);
  }
}

/**
 * This person's chat posts still waiting in the outbox for one room, shaped as
 * messages with `pending: true`. Only the author's own: a post queued by
 * somebody who signed out earlier is held for them and never shown to whoever
 * is here now.
 */
async function pendingChatPosts(roomId: string): Promise<ChatMessage[]> {
  const session = userSession.currentSession();
  if (!session) return [];

  const queued = await outbox.pending();
  return queued
    .filter(
      (mutation) =>
        mutation.kind === 'chat.post' &&
        mutation.actorUserId === session.userId &&
        mutation.payload.roomId === roomId,
    )
    .map((mutation): ChatMessage => {
      const payload = mutation.payload as {
        body?: string;
        refs?: Array<{ kind: 'lead' | 'order'; id: string }>;
        mentions?: string[];
        task?: { assignees: string[]; dueOn: string | null } | null;
      };
      const person = (id: string) => ({ id, displayName: id, avatar: null, tier: 'office' });
      return {
        id: mutation.entityId,
        roomId,
        seq: 0,
        kind: payload.task ? 'task' : 'text',
        author: {
          id: session.userId,
          displayName: session.displayName,
          avatar: null,
          tier: session.roleTier,
        },
        body: payload.body ?? '',
        refs: (payload.refs ?? []).map((chip) => ({ ...chip, label: chip.id, partyName: null, restricted: false })),
        mentions: payload.mentions ?? [],
        system: null,
        createdAt: mutation.createdAt,
        editedAt: null,
        deletedAt: null,
        pinnedAt: null,
        pinnedBy: null,
        task: payload.task
          ? { assignees: payload.task.assignees.map(person), dueOn: payload.task.dueOn, doneAt: null, doneBy: null }
          : null,
        clientId: mutation.mutationId,
        pending: true,
      };
    });
}

function respondToPairingError(res: Response, error: unknown): void {
  if (error instanceof PairingError) {
    res.status(400).json({ error: error.code, message: error.message });
    return;
  }
  log.error('Pairing failed', error);
  res.status(500).json({ error: 'pairing_failed', message: 'Pairing failed unexpectedly' });
}

const RESTORE_ERROR_STATUS: Record<string, number> = {
  backup_wrong_passphrase: 400,
  backup_corrupt_file: 400,
  backup_wrong_panel_type: 400,
  backup_populated_data_directory: 409,
  backup_migration_too_new: 400,
  validation_error: 400,
};

function respondToRestoreError(res: Response, error: unknown): void {
  if (error instanceof RestoreError || error instanceof BackupValidationError) {
    res
      .status(RESTORE_ERROR_STATUS[error.code] ?? 500)
      .json({ error: error.code, message: error.message });
    return;
  }
  log.error('Storage export/restore failed', error);
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
}

function respondToDeveloperError(res: Response, error: unknown): void {
  if (error instanceof DeveloperError) {
    // `details.seconds` is how long the lockout has left — the screen counts
    // it down, so it must survive the trip.
    res.status(error.status).json({
      error: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  log.error('Developer mode failed', error);
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
}

/**
 * Every browser currently watching this panel.
 *
 * Module-level, with **one** set of listeners on the connection rather than one
 * per stream. The listeners are what makes this worth restructuring: `pushView`
 * used to build and stringify the whole gated, scoped snapshot once per open
 * stream per event, and a panel with the app open in two tabs paid for it
 * twice.
 */

const streams = new Set<(type: string, data: unknown) => void>();

/** How long a burst of view-changing events is allowed to coalesce. */
const VIEW_PUSH_DEBOUNCE_MS = 120;

let viewPushTimer: NodeJS.Timeout | null = null;

/**
 * Push the merged view to every open stream, at most once per 120 ms.
 *
 * Built **once** and written to every stream: `forCurrentUser` reads the one
 * signed-in session this panel has, so the payload is identical for all of
 * them. Returns immediately with nothing open, so a panel with no browser on it
 * does not serialise a snapshot every time the outbox moves.
 */
function schedulePushView(): void {
  if (streams.size === 0 || viewPushTimer) return;

  viewPushTimer = setTimeout(() => {
    viewPushTimer = null;
    if (streams.size === 0) return;

    void localStore
      .getView()
      .then((view) => {
        if (!view) return;
        const payload = forCurrentUser(view);
        for (const send of streams) send('snapshot', payload);
      })
      .catch((error: unknown) => {
        log.warn(
          `Could not push the view: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }, VIEW_PUSH_DEBOUNCE_MS);

  viewPushTimer.unref?.();
}

function broadcast(type: string, data: unknown): void {
  for (const send of streams) send(type, data);
}

/**
 * Broadcast an event addressed to one person, only while that person is the
 * one signed in here.
 *
 * The Master addresses it to whoever this panel was acting as when it sent,
 * and on a shared PC that can be the previous shift by the time it lands. One
 * filter for every per-person event (notifications now, presence, chat and
 * print later), and anything without a `forUserId` is dropped rather than
 * shown to whoever happens to be here.
 */
function broadcastForUser(type: string, data: { forUserId?: unknown }): void {
  const userId = userSession.currentSession()?.userId;
  if (!userId || data.forUserId !== userId) return;
  broadcast(type, data);
}

/**
 * Reconcile this panel's local product-image cache against what the Master's
 * snapshot still lists, whenever the link hands over a snapshot: a full one on
 * connect or after a ring miss, a pulled refresh, or the in-memory one a
 * reconnect's replayed delta has just brought up to date (`master-connection.ts`
 * emits `snapshot` for all three). A live `data:changed` event on its own does
 * not trigger it.
 *
 * Every variant a product photo ever displayed here gets written to
 * `paths().imagesDir` and kept — there was no equivalent of
 * `avatar-cache.ts`'s `forgetAvatar` for product images on this side, and the
 * Master's own delete already removes only its copy. Over a year of ordinary
 * catalogue churn (photos replaced, products removed) across several office
 * PCs, each accumulates unbounded dead image bytes with no reclaim path short
 * of deleting the data folder by hand.
 *
 * The snapshot, not the individual change events: image ids are minted once
 * per upload and never reused (a new picture is a new id, the same reasoning
 * `avatar-cache.ts` already documents), so a *complete* snapshot's `products`
 * collection is the current answer to "what should still be on disk" — see
 * `productsComplete` below for the case it is not, which a caught-up snapshot
 * inherits from the full one it was built on. Reacting only to
 * `product`/`updated` events would miss the case a long-offline panel most
 * needs this for: the Master's change ring wrapped, so this panel fell back to
 * a snapshot instead of replayed events, and an event-only sweep would never
 * run at all. A snapshot arrives rarely enough (a connect, a reconnect's
 * catch-up, a debounced refresh) that a directory scan on every one of them
 * costs nothing worth measuring.
 */
async function sweepImageCache(snapshot: SyncSnapshot): Promise<void> {
  // `products` is a clamped page, not the catalogue, whenever the snapshot
  // was built for an actor without `products.view` or the catalogue exceeds
  // the snapshot's page limit. Either way it is not a trustworthy "what
  // should still be on disk" answer, and sweeping against it would delete
  // cached images for every product past the first page (or the entire
  // cache for a products-denied actor) only to have them refetched and
  // deleted again on the next snapshot.
  if (!snapshot.productsComplete) return;

  const known = new Set<string>();
  for (const product of snapshot.products) {
    for (const image of product.images) known.add(image.id);
  }

  let entries: string[];
  try {
    entries = await readdir(paths().imagesDir);
  } catch {
    return; // No cache yet.
  }

  for (const entry of entries) {
    if (known.has(entry)) continue;
    await rm(path.join(paths().imagesDir, entry), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/*
 * Registered once, at module load, rather than per stream.
 *
 * `change` deliberately keeps sending the small per-record frame rather than
 * being folded into `schedulePushView`: routing it into a whole-view push
 * would replace a few hundred bytes with the entire snapshot, which is the
 * amplifier this file is removing.
 */
// Optional-called: the office suites mock this module with a partial object,
// and a belt-and-braces listener cap is not worth making them all fuller.
masterConnection.setMaxListeners?.(0);
masterConnection.on('status', (status: unknown) => broadcast('status', status));
masterConnection.on('snapshot', schedulePushView);
masterConnection.on('snapshot', (snapshot: SyncSnapshot) => void sweepImageCache(snapshot));
masterConnection.on('change', (event: DataChangedEvent) => broadcast('change', event));
masterConnection.on('conflict', (value: unknown) => broadcast('conflict', value));
masterConnection.on('notification', (notification: { forUserId?: unknown }) =>
  broadcastForUser('notification', notification),
);
// Chat is addressed to one person too, and only reaches them while they are the one signed in.
masterConnection.on('chat', (push: { forUserId?: unknown }) => broadcastForUser('chat', push));
// A Printroom job is addressed to its sender and to the station holders, per person likewise.
masterConnection.on('print', (job: { forUserId?: unknown }) => broadcastForUser('print', job));
masterConnection.on('presence', (presence: { forUserId?: unknown }) =>
  broadcastForUser('presence', presence),
);
sync.onSyncEvent(schedulePushView);
// Only moves an open Provisional record to its permanent id and updates the
// save toast. The bell entry comes from the Master's own `lead.numbered`
// notification, so nothing is announced twice. Every tab gets the id remap, but
// the number (and so the toast) only reaches the person who saved the lead: on a
// shared PC a queued save can land after its author has signed out.
sync.onNumbered(({ poNumber, ...event }) => {
  const isAuthor = event.forUserId !== null && event.forUserId === userSession.currentSession()?.userId;
  broadcast('numbered', isAuthor && poNumber ? { ...event, poNumber } : event);
});

/**
 * Server-sent events rather than another Socket.IO hop: the browser only ever
 * listens here, and SSE reconnects on its own with no extra client library.
 */
function streamEvents(req: Request, res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (type: string, data: unknown): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  streams.add(send);

  send('status', masterConnection.getStatus());
  // This stream's own first view, not the shared push: a browser that connects
  // between bursts must not wait for the next one.
  void localStore.getView().then((view) => {
    if (view) send('snapshot', forCurrentUser(view));
  });

  // Proxies and some browsers drop an idle event stream; a periodic comment
  // keeps it open without sending meaningful traffic.
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    streams.delete(send);
  });
}

/** Shown when the Office Panel server runs but its frontend was never built. */
function missingUiPage(): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>OrderBook — UI not built</title></head>
  <body style="font-family: 'Segoe UI', Tahoma, Arial, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; color: #1c2530; line-height: 1.55;">
    <h1 style="font-size: 22px;">The Office Panel is running, but its screens have not been built yet</h1>
    <p>The server answered this request, so it is working. What is missing is the
       compiled browser interface.</p>
    <p>Stop the server and run:</p>
    <pre style="background:#f0f4f8; border:1px solid #d8dee4; border-radius:6px; padding:12px 14px; overflow-x:auto;">npm run build
npm run dev:office</pre>
  </body>
</html>`;
}
