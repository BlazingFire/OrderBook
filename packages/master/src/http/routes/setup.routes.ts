import { Router } from 'express';

import { asyncHandler } from '../async-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import * as setupService from '../../services/setup.service.js';

export const setupRoutes: Router = Router();

/** Drives the very first screen: has this Master been configured yet? */
setupRoutes.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json({ setupComplete: await setupService.isSetupComplete() });
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
  asyncHandler(async (_req, res) => {
    res.json(await setupService.getIdentity());
  }),
);
