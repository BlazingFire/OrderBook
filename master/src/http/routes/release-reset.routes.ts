/**
 * 1.5.9's one-time reset (`services/release-reset.service.ts`): what it would remove and keep,
 * and the confirmation that backs up and deletes. Administrators only (checked in the service).
 */

import { Router } from 'express';

import * as releaseResetService from '../../services/release-reset.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';

export const releaseResetRoutes: Router = Router();

releaseResetRoutes.use(requireAuth);

releaseResetRoutes.get(
  '/',
  requirePermissionMiddleware('settings.manage'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await releaseResetService.releaseResetStatus(actorFromRequest(req)));
  }),
);

releaseResetRoutes.post(
  '/confirm',
  requirePermissionMiddleware('settings.manage'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { understood?: unknown; confirmPassword?: unknown };
    res.set('Cache-Control', 'no-store');
    res.json(
      await releaseResetService.confirmReleaseReset(
        { understood: body.understood === true, confirmPassword: String(body.confirmPassword ?? '') },
        actorFromRequest(req),
      ),
    );
  }),
);
