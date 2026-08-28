/**
 * App updates (`docs/PROJECT_PLAN.md` §12, finally answered).
 *
 * Two audiences, and the split matters. The Master's own browser asks
 * `/status` and, if an administrator says so, `/master/install`. A **paired
 * Office Panel** asks `/office/latest` and `/office/download` — that pair is
 * the whole reason an office PC can update over the LAN instead of by USB
 * stick.
 *
 * The office routes are reachable by a paired panel's *server*, which holds no
 * user session: it forwards on behalf of whoever is signed in at that panel,
 * and the panel checks `settings.manage` on its own side before asking. They
 * are readable without a session for the same reason `GET /api/health` is —
 * "which build is on offer" is not privileged, the file is one an operator
 * deliberately published to the LAN, and refusing it would mean a panel could
 * never discover an update before somebody signs in to it.
 */

import { createReadStream } from 'node:fs';

import { Router } from 'express';

import * as updateService from '../../services/update.service.js';
import { appVersion } from '../../lib/app-version.js';
import { asyncHandler } from '../async-handler.js';
import { NotFoundError } from '../../lib/errors.js';
import {
  actorFromRequest,
  requireAuth,
  requirePermissionMiddleware,
} from '../middleware/require-auth.js';

/** Reachable by a paired panel, which carries no user session. See the header. */
export const publicUpdateRoutes: Router = Router();

publicUpdateRoutes.get(
  '/office/latest',
  asyncHandler(async (_req, res) => {
    res.json(await updateService.availability('office', '0.0.0'));
  }),
);

publicUpdateRoutes.get(
  '/office/download',
  asyncHandler(async (_req, res) => {
    const manifest = await updateService.readManifest('office');
    if (!manifest) throw new NotFoundError('Office release');

    const file = updateService.releaseFileFor('office', manifest);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(manifest.sizeBytes));
    res.setHeader('Content-Disposition', `attachment; filename="${manifest.file}"`);

    // Streamed, never buffered: these files are 100–200 MB and the Master is
    // also serving every panel's live socket while this download runs.
    createReadStream(file).pipe(res);
  }),
);

/** The Master's own browser. */
export const updateRoutes: Router = Router();

updateRoutes.use(requireAuth);

updateRoutes.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const [master, office] = await Promise.all([
      updateService.masterAvailability(),
      updateService.availability('office', '0.0.0'),
    ]);

    res.json({ running: appVersion(), master, office });
  }),
);

/**
 * Verify the Master's setup file and hand back its path.
 *
 * Deliberately does **not** run it. This process is the server the whole shop
 * is talking to, and an installer replacing its own program files mid-request
 * is not a shutdown anybody controls. The desktop shell owns the launch and
 * the quit; this route owns the checksum.
 */
updateRoutes.post(
  '/master/install',
  requirePermissionMiddleware('settings.manage'),
  asyncHandler(async (req, res) => {
    // Read for its side effect of refusing an unauthenticated caller earlier —
    // the middleware above has already established the session.
    actorFromRequest(req);

    const { path, manifest } = await updateService.prepareMasterUpdate();
    res.json({ path, manifest });
  }),
);
