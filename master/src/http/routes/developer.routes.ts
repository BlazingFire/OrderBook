/**
 * `/api/developer` — unlock, status, lock, and the three actions behind them.
 *
 * `requireAuth` and nothing more: the developer is any signed-in person, not
 * a permission holder (`shared/src/domain/developer.ts`). The developer token,
 * checked by the gate, is the real door. Mounted before the `/api` catch-all,
 * like `/api/settings`.
 */

import { Router } from 'express';

import { DEVELOPER_RESET_CONFIRMATION, DEVELOPER_TOKEN_HEADER } from '@orderbook/shared';

import { ValidationError } from '../../lib/errors.js';
import { developerGate, resetAllData, seedDummyUsers } from '../../services/developer.service.js';
import { seedSampleData } from '../../services/sample-data.service.js';
import { asyncHandler } from '../async-handler.js';
import { requireAuth } from '../middleware/require-auth.js';

export const developerRoutes: Router = Router();

developerRoutes.use(requireAuth);

developerRoutes.post(
  '/unlock',
  asyncHandler(async (req, res) => {
    res.status(201).json(await developerGate.unlock(req.body?.password));
  }),
);

developerRoutes.get('/status', (req, res) => {
  res.json(developerGate.status(req.header(DEVELOPER_TOKEN_HEADER)));
});

developerRoutes.post('/lock', (req, res) => {
  developerGate.lock(req.header(DEVELOPER_TOKEN_HEADER));
  res.json({ ok: true });
});

developerRoutes.post(
  '/reset-all',
  asyncHandler(async (req, res) => {
    developerGate.assertUnlocked(req.header(DEVELOPER_TOKEN_HEADER));
    if (req.body?.confirmation !== DEVELOPER_RESET_CONFIRMATION) {
      throw new ValidationError('validation.developer.confirmationRequired');
    }
    res.json(await resetAllData());
  }),
);

developerRoutes.post(
  '/seed-dummy-users',
  asyncHandler(async (req, res) => {
    developerGate.assertUnlocked(req.header(DEVELOPER_TOKEN_HEADER));
    res.status(201).json(await seedDummyUsers());
  }),
);

developerRoutes.post(
  '/seed-sample-data',
  asyncHandler(async (req, res) => {
    developerGate.assertUnlocked(req.header(DEVELOPER_TOKEN_HEADER));
    res.status(201).json(await seedSampleData());
  }),
);
