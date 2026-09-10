/**
 * App updates (`docs/PROJECT_PLAN.md` §12, finally answered).
 *
 * Two audiences, and the split matters. The Master's own browser asks
 * `/status` and, if an administrator says so, `/master/install`. A **paired
 * Office Panel** asks `/office/latest` and `/office/download` — that pair is
 * the whole reason an office PC can update over the LAN instead of by USB
 * stick.
 *
 * The office routes are reachable by a **paired panel**, authenticated on its
 * pairing credentials rather than on a user session.
 *
 * They used to be reachable by anyone, and the reason given was that a panel
 * "holds no user session" — true, and beside the point: `requirePanel`
 * authenticates on the panel id and secret, and treats the acting-user token as
 * optional. So a panel with nobody signed in at it authenticates perfectly
 * well, and the routes were open for a reason that never applied.
 *
 * What that cost: an Office panel took its manifest from whoever answered on
 * the Master's address, then checked the downloaded file against a `sha256`
 * from that same answer. Whoever wrote the bytes wrote the digest they had to
 * match, so anything holding that IP on the shop LAN could hand every office PC
 * an installer. The signature check on the panel side is the other half of
 * closing that; this half means an unpaired stranger cannot even ask.
 */

import { createReadStream } from 'node:fs';

import { Router } from 'express';

import type { ReleasePlatform } from '@orderbook/shared';
import { LEGACY_RELEASE_PLATFORM } from '@orderbook/shared';

import * as updateService from '../../services/update.service.js';
import { appVersion } from '../../lib/app-version.js';
import { asyncHandler } from '../async-handler.js';
import { NotFoundError } from '../../lib/errors.js';
import {
  actorFromRequest,
  requireAuth,
  requirePermissionMiddleware,
} from '../middleware/require-auth.js';
import { requirePanel } from '../middleware/require-panel.js';

/**
 * Which OS the asking panel runs, from the panel itself.
 *
 * Self-declared, and that is sound: the request is already authenticated as a
 * paired panel, and a panel that lies about its own OS only breaks its own
 * update. A panel that sends nothing is one built before this existed, and
 * every one of those is Windows.
 */
function askingPlatform(value: unknown): ReleasePlatform {
  return value === 'darwin' || value === 'linux' || value === 'win32'
    ? value
    : LEGACY_RELEASE_PLATFORM;
}

/** Reachable by a paired panel, on its pairing credentials. See the header. */
export const publicUpdateRoutes: Router = Router();

publicUpdateRoutes.use(requirePanel);

publicUpdateRoutes.get(
  '/office/latest',
  asyncHandler(async (req, res) => {
    res.json(
      await updateService.availability('office', '0.0.0', askingPlatform(req.query.platform)),
    );
  }),
);

publicUpdateRoutes.get(
  '/office/download',
  asyncHandler(async (req, res) => {
    const manifest = await updateService.readManifest('office', askingPlatform(req.query.platform));
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
      // The Master's own screen, so its own OS. In a shop running both, this
      // reports the office build for the Master's platform; each panel's own
      // Updates screen is what tells that panel what it can install.
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
