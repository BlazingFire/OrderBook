/**
 * App updates (`docs/PROJECT_PLAN.md` §12, finally answered).
 *
 * Two audiences, and the split matters. The Master's own browser asks
 * `/status` and, if an administrator says so, `/master/install`. A **paired
 * Office Panel** asks `/office/latest` and `/office/download` — that pair is
 * the whole reason an office PC can update over the LAN instead of by USB
 * stick. A **new office PC** asks `/office/setup` for its first install, the
 * one route here open to a caller that is not paired (see that route).
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
import path from 'node:path';

import { Router } from 'express';

import type { ReleasePlatform } from '@orderbook/shared';
import { LEGACY_RELEASE_PLATFORM } from '@orderbook/shared';

import { config } from '../../config/index.js';
import * as autoUpdate from '../../services/auto-update.js';
import * as updateService from '../../services/update.service.js';
import { appVersion } from '../../lib/app-version.js';
import { asyncHandler } from '../async-handler.js';
import { AppError, NotFoundError } from '../../lib/errors.js';
import { LIMITS, limitByIp } from '../middleware/rate-limit.js';
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
 *
 * `win7` is the legacy Electron 22 Office line. It is answered from
 * `latest-win7.json` only: `readManifest` refuses the plain Windows
 * `latest.json` it falls back to, because that manifest says `win32`.
 */
function askingPlatform(value: unknown): ReleasePlatform {
  return value === 'darwin' || value === 'linux' || value === 'win32' || value === 'win7'
    ? value
    : LEGACY_RELEASE_PLATFORM;
}

/**
 * Reachable by a paired panel, on its pairing credentials. See the header.
 *
 * `requirePanel` is on each route, never `publicUpdateRoutes.use(...)`: this
 * router and `updateRoutes` below share the `/api/updates` prefix in
 * `http/app.ts`, and a router-level guard runs for every path under it. It
 * did, and refused the Master's own browser — which carries a session, not
 * panel credentials — before `updateRoutes` was ever reached, so the Master's
 * Updates screen could never load.
 */
export const publicUpdateRoutes: Router = Router();

publicUpdateRoutes.get(
  '/office/latest',
  requirePanel,
  asyncHandler(async (req, res) => {
    // `?check=1` is an Office's Check now: the Master asks GitHub first
    // (cooled down, so a roomful of panels share one question).
    if (req.query.check === '1') await updateService.checkNow();
    res.json(
      await updateService.availability('office', '0.0.0', askingPlatform(req.query.platform)),
    );
  }),
);


publicUpdateRoutes.get(
  '/office/download',
  requirePanel,
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

/**
 * The Office setup this Master's own setup file carried, for a new office PC:
 * the Panels screen's "Save Office setup…", or the address it shows typed into
 * a browser on that PC.
 *
 * No `requirePanel`, deliberately and unlike the two routes above: the PC
 * asking has not paired, and cannot until an Office is installed on it. What
 * it is handed is the setup file every copy of this version ships, nothing of
 * this shop's. `?platform=` picks one (`win7` for the Windows 7 Office); with
 * none, the first carried, which on Windows is the Windows 10/11 Office.
 * Limited per address, because each answer is 85 MB or more.
 */
publicUpdateRoutes.get(
  '/office/setup',
  limitByIp('office-setup', LIMITS.officeSetupPerIp),
  asyncHandler(async (req, res) => {
    const setups = await updateService.bundledOfficeSetups();
    const asked = req.query.platform;
    const setup = asked ? setups.find((m) => m.platform === asked) : setups[0];
    if (!setup) throw new AppError('error.officeSetupMissing', {}, 404, 'not_found');

    // `res.download` streams the file and names it in the Content-Disposition.
    const file = path.basename(setup.file);
    res.download(path.join(config.officeSetupDir, file), file);
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

    res.json({
      running: appVersion(),
      master,
      office,
      download: updateService.downloadStatus(),
      lastCheckedAt: updateService.lastChecked(),
      auto: await autoUpdate.getAutoUpdateStatus(),
    });
  }),
);

/**
 * Check now (1.4 R6): ask GitHub straight away. Any signed-in person may; the
 * cool-down in `checkNow` is what keeps repeated presses from spending the API
 * allowance, so no permission is needed to be allowed to look.
 */
updateRoutes.post(
  '/check',
  asyncHandler(async (_req, res) => {
    const { master, office } = await updateService.checkNow();
    res.json({
      running: appVersion(),
      master,
      office,
      download: updateService.downloadStatus(),
      lastCheckedAt: updateService.lastChecked(),
      auto: await autoUpdate.getAutoUpdateStatus(),
    });
  }),
);

updateRoutes.put(
  '/auto',
  requirePermissionMiddleware('settings.manage'),
  asyncHandler(async (req, res) => {
    res.json(await autoUpdate.updateAutoUpdateConfig(req.body, actorFromRequest(req)));
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
    const { path, manifest } = await updateService.prepareMasterUpdate(actorFromRequest(req));
    res.json({ path, manifest });
  }),
);
