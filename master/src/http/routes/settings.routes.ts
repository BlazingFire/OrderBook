/**
 * `/api/settings` — the company's own switches.
 *
 * Copies `access.routes.ts`'s shape: `requireAuth`, then a `needs(...)` guard
 * per handler, with the service checking again on the way through. Zero
 * exemptions here — every route on this router is gated.
 *
 * Mounted **before** `app.use('/api', dataRoutes)`, which is a catch-all.
 */

import { Router } from 'express';

import { isSettingKey } from '@orderbook/shared';

import { ValidationError } from '../../lib/errors.js';
import * as passwordVaultService from '../../services/password-vault.service.js';
import * as settingsService from '../../services/settings.service.js';
import { asyncHandler } from '../async-handler.js';
import {
  actorFromRequest,
  requireAuth,
  requirePermissionMiddleware,
} from '../middleware/require-auth.js';

export const settingsRoutes: Router = Router();

settingsRoutes.use(requireAuth);

const needs = requirePermissionMiddleware;

settingsRoutes.get(
  '/',
  needs('settings.manage'),
  asyncHandler(async (req, res) => {
    res.json(await settingsService.readSettings(actorFromRequest(req)));
  }),
);

/**
 * How much of the company the password vault covers.
 *
 * Gated on `users.viewPassword` rather than `settings.manage`: the count is
 * only meaningful to somebody who can actually reveal a password, and it says
 * out loud how many plaintexts this installation is holding.
 *
 * Declared before `PUT /:key` for readability only — Express matches by method
 * first, so a GET could never reach that handler anyway.
 */
settingsRoutes.get(
  '/vault-status',
  needs('users.viewPassword'),
  asyncHandler(async (req, res) => {
    res.json(await passwordVaultService.vaultStatus(actorFromRequest(req)));
  }),
);

settingsRoutes.put(
  '/:key',
  needs('settings.manage'),
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    // Checked here as well as in the service, so an unknown key is a 400 named
    // after the key rather than a 500 from indexing the declaration table with
    // whatever arrived in the URL.
    if (!isSettingKey(key)) throw new ValidationError('validation.setting.invalid', { key });

    await settingsService.writeSetting(actorFromRequest(req), key, req.body?.value);
    res.json(await settingsService.readSettings(actorFromRequest(req)));
  }),
);
