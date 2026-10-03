import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';

import { MASTER_KEY_TOKEN_HEADER } from '@orderbook/shared';

import { ConflictError, ValidationError } from '../../lib/errors.js';
import { isLoopback } from '../../lib/network.js';
import { previewArchive, restoreArchive } from '../../services/archive-restore.service.js';
import * as backupRestoreService from '../../services/backup-restore.service.js';
import { currentJob, startJob } from '../../services/backup-job.js';
import { requireLocalPath } from '../../services/backup-scheduler.js';
import { changePairingPassword } from '../../services/server-master.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';
import { requireLoopback } from '../middleware/require-loopback.js';
import * as setupService from '../../services/setup.service.js';

export const setupRoutes: Router = Router();

const needs = requirePermissionMiddleware;

// See data.routes.ts's `backupUpload` for why this buffers in memory.
const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });

/**
 * A restore replaces a set-up installation's data wholesale, so once setup has
 * run these routes refuse before reading the upload. `restoreBackup` refuses
 * again on its own; this stops the preview too, which would otherwise parse
 * any backup a caller sends.
 */
function refuseAfterSetup(_req: Request, _res: Response, next: NextFunction): void {
  void setupService.isSetupComplete().then(
    (complete) => next(complete ? new ConflictError('error.conflict.alreadySetUp') : undefined),
    next,
  );
}

/**
 * Drives the very first screen: has this Master been configured yet? Once it
 * has, also the company name for the panel's footer. That name is already
 * public: UDP discovery broadcasts it and the Office sign-in screen shows it.
 *
 * `onMasterPc` tells the screen whether the Master-PC-only flows (setup,
 * restore, the Server Master setup and recovery) are offered at all, and
 * `serverMasterSetupNeeded` whether the master-key setup flow comes first.
 */
setupRoutes.get(
  '/status',
  asyncHandler(async (req, res) => {
    res.json({
      ...(await setupService.getSetupStatus()),
      onMasterPc: isLoopback(req),
      serverMasterSetupNeeded: await setupService.serverMasterSetupNeeded(),
    });
  }),
);

/**
 * Runs once, on the Master PC only. The owner types both Server Master
 * accounts; the response is the only time the generated pairing password is
 * ever visible.
 */
setupRoutes.post(
  '/initialize',
  requireLoopback,
  asyncHandler(async (req, res) => {
    const companyName = typeof req.body?.companyName === 'string' ? req.body.companyName.trim() : null;
    const credentials = await setupService.runFirstTimeSetup(companyName || null, req.body?.accounts);
    res.status(201).json(credentials);
  }),
);

/**
 * A new pairing password, shown once: a Server Master, on the Master PC, with
 * the master key. Panels already paired keep working on their own secrets.
 */
setupRoutes.post(
  '/pairing-password',
  requireLoopback,
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await changePairingPassword(actorFromRequest(req), req.header(MASTER_KEY_TOKEN_HEADER)));
  }),
);

/** Same connection details, re-readable later from Settings. */
setupRoutes.get(
  '/identity',
  requireAuth,
  needs('settings.manage'),
  asyncHandler(async (_req, res) => {
    res.json(await setupService.getIdentity());
  }),
);

/**
 * The first-run screen's other fork (`docs/7-STORAGE-BACKUP-RESTORE.md` §5.1,
 * §5.2): "Restore from backup" instead of "Set up new site". Unauthenticated,
 * like every other route here — there is nobody to authenticate as yet — so
 * kept to the Master PC, and refused once setup has run.
 *
 * `requireLoopback` comes before `backupUpload.single`, always: multer buffers
 * up to a gigabyte in memory, and a LAN caller must be turned away before it
 * can make the Master read that much.
 */
setupRoutes.post(
  '/restore/preview',
  requireLoopback,
  refuseAfterSetup,
  backupUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError('validation.backup.fileRequired');
    res.json(backupRestoreService.previewRestore(req.file.buffer));
  }),
);

setupRoutes.post(
  '/restore',
  requireLoopback,
  refuseAfterSetup,
  backupUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError('validation.backup.fileRequired');

    const passphrase = req.body?.passphrase;
    if (typeof passphrase !== 'string' || !passphrase) {
      throw new ValidationError('validation.backup.passphraseRequired');
    }

    res.status(201).json(await backupRestoreService.restoreBackup(req.file.buffer, passphrase, false));
  }),
);

/**
 * Magic restore: the first-run screen's third fork, a backup-everything zip
 * from a drive (`docs/7-STORAGE-BACKUP-RESTORE.md`). The path is a file on this
 * PC, chosen through the shell's picker, never an upload: the zip can be many
 * gigabytes. Loopback first, then refused once setup has run, as above.
 */
setupRoutes.post(
  '/archive/preview',
  requireLoopback,
  refuseAfterSetup,
  asyncHandler(async (req, res) => {
    res.json(await previewArchive(requireLocalPath(req.body?.path)));
  }),
);

setupRoutes.post(
  '/archive/restore',
  requireLoopback,
  refuseAfterSetup,
  asyncHandler(async (req, res) => {
    const file = requireLocalPath(req.body?.path);
    const { status } = startJob('restore', async (update, jobId) => {
      await restoreArchive(file, { mode: 'first-run', progress: update, jobId });
    });
    res.status(202).json(status);
  }),
);

/**
 * The running backup or restore, for the screen showing its progress. Not
 * refused after setup, and let through during maintenance: it is polled
 * through a restore, and after one, before anyone has signed in again.
 */
setupRoutes.get('/archive/job', requireLoopback, (_req, res) => {
  res.json(currentJob());
});
