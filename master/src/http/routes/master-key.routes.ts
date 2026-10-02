/**
 * `/api/master-key` — the master key and what it unlocks before sign-in.
 *
 * Every route is Master-PC only (`requireLoopback`), and none needs a session:
 * recovering a forgotten Server Master password and setting up the missing
 * Server Masters both happen on the sign-in screen, before anyone can sign in.
 * The master-key token, checked by the gate, is the door. Mounted before the
 * `/api` catch-all, whose `requireAuth` would otherwise answer 401.
 */

import { Router, type Request } from 'express';

import { MASTER_KEY_TOKEN_HEADER } from '@orderbook/shared';

import { masterKeyGate, verifyMasterKey } from '../../services/master-key.service.js';
import {
  listServerMasters,
  recoverServerMasterPassword,
  setUpMissingServerMasters,
} from '../../services/server-master.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest } from '../middleware/require-auth.js';
import { requireLoopback } from '../middleware/require-loopback.js';

export const masterKeyRoutes: Router = Router();

masterKeyRoutes.use(requireLoopback);

/** The signed-in user when there is one, so the log names them rather than "Master PC". */
function optionalActor(req: Request) {
  return req.user ? actorFromRequest(req) : null;
}

masterKeyRoutes.post(
  '/verify',
  asyncHandler(async (req, res) => {
    res.status(201).json(await verifyMasterKey(req.body?.key, optionalActor(req)));
  }),
);

masterKeyRoutes.post('/lock', (req, res) => {
  masterKeyGate.lock(req.header(MASTER_KEY_TOKEN_HEADER));
  res.json({ ok: true });
});

masterKeyRoutes.get(
  '/server-masters',
  asyncHandler(async (req, res) => {
    res.json(await listServerMasters(req.header(MASTER_KEY_TOKEN_HEADER)));
  }),
);

masterKeyRoutes.post(
  '/server-masters',
  asyncHandler(async (req, res) => {
    const accounts = await setUpMissingServerMasters(
      req.body?.accounts,
      req.header(MASTER_KEY_TOKEN_HEADER),
      optionalActor(req),
    );
    res.status(201).json({ accounts });
  }),
);

masterKeyRoutes.post(
  '/recover',
  asyncHandler(async (req, res) => {
    await recoverServerMasterPassword(
      req.body?.userId,
      req.body?.newPassword,
      req.header(MASTER_KEY_TOKEN_HEADER),
      optionalActor(req),
    );
    res.status(204).end();
  }),
);
