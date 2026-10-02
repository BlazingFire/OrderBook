import { Router } from 'express';
import multer from 'multer';

import { ValidationError } from '../../lib/errors.js';
import * as backupRestoreService from '../../services/backup-restore.service.js';
import { asyncHandler } from '../async-handler.js';
import { requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';
import * as setupService from '../../services/setup.service.js';

export const setupRoutes: Router = Router();

const needs = requirePermissionMiddleware;

// See data.routes.ts's `backupUpload` for why this buffers in memory.
const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });

/**
 * Drives the very first screen: has this Master been configured yet? Once it
 * has, also the company name for the panel's footer. That name is already
 * public: UDP discovery broadcasts it and the Office sign-in screen shows it.
 */
setupRoutes.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json(await setupService.getSetupStatus());
  }),
);

/**
 * Runs once. The response is the only time the generated sign-in password and
 * pairing password are ever visible.
 */
setupRoutes.post(
  '/initialize',
  asyncHandler(async (req, res) => {
    const companyName = typeof req.body?.companyName === 'string' ? req.body.companyName.trim() : null;
    const credentials = await setupService.runFirstTimeSetup(companyName || null);
    res.status(201).json(credentials);
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
 * like every other route here — there is nobody to authenticate as yet — and
 * refused by `restoreBackup` itself if setup has already run.
 */
setupRoutes.post(
  '/restore/preview',
  backupUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError('validation.backup.fileRequired');
    res.json(backupRestoreService.previewRestore(req.file.buffer));
  }),
);

setupRoutes.post(
  '/restore',
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
