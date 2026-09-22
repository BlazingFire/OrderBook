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
import { seedCatalogue } from '../../services/catalogue-seed.service.js';
import { developerGate, resetAllData, seedDummyUsers } from '../../services/developer.service.js';
import { seedSampleData } from '../../services/sample-data.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth } from '../middleware/require-auth.js';
import { getSetting } from '../../services/settings.service.js';
import { UnauthorizedError } from '../../lib/errors.js';

export const developerRoutes: Router = Router();

developerRoutes.use(requireAuth);

/*
 * Whether developer mode may be unlocked on this Master at all.
 *
 * Here, in route middleware, and deliberately not inside `developerGate`.
 * `createDeveloperGate` is a pure in-memory factory with no database access —
 * `master/tests/developer-service.test.ts` constructs it with no PostgreSQL in
 * the process — so a `getSetting` inside it would force a third injected option
 * and rewrite that whole file. This keeps the gate pure and every one of those
 * unit tests untouched.
 *
 * **The `.env` override is the floor.** While `ORDERBOOK_DEVELOPER_PASSWORD` is
 * set the switch is ignored, so an installation that turns developer mode off
 * and then loses everyone holding `settings.manage` still has a way back in at
 * the machine itself. Without that, those two events together would make a
 * packaged install unrecoverable. The `!== undefined && !== ''` test is copied
 * from `developer.service.ts` so the floor and the password check agree on what
 * "set" means.
 *
 * The refusal reaches the operator through the error path `useDeveloperSession`
 * already renders, rather than through a new field on `DeveloperStatus` — which
 * would make `status` async and force the Office panel to answer for a switch
 * this version does not honour there.
 */
developerRoutes.use(
  asyncHandler(async (req, _res, next) => {
    const override = process.env.ORDERBOOK_DEVELOPER_PASSWORD;
    if (override !== undefined && override !== '') return next();

    const actor = actorFromRequest(req);
    if (await getSetting(actor.tenantId, 'security.developerModeEnabled')) return next();

    throw new UnauthorizedError('error.unauthorized.developerDisabled');
  }),
);

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

developerRoutes.post(
  '/load-catalogue',
  asyncHandler(async (req, res) => {
    developerGate.assertUnlocked(req.header(DEVELOPER_TOKEN_HEADER));
    res.status(201).json(await seedCatalogue());
  }),
);
