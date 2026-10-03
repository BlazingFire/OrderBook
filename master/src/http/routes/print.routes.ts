/**
 * `/api/print-jobs` and `/api/print-stations`: the Printroom for the Master's
 * own browser (1.3 Phase 7).
 *
 * An Office Panel reaches the same service through the twinned `print:*` socket
 * commands, which its own server forwards at these same paths. There is no
 * `claim` route: a claim belongs to a connection, so the Master PC's window
 * makes it over its own socket (`print:claim`) and the hub releases it when that
 * socket closes.
 *
 * Which routes carry `needs()` and which do not is deliberate. Sending,
 * marking printed and registering a station each have exactly one key, so the
 * route names it. Listing, reading and cancelling are open to either of two
 * keys and scoped by the service (a sender sees and cancels only their own
 * jobs), so a single route guard would be wrong; they are listed as exemptions
 * in `credential-invariants.test.ts`.
 *
 * The station on the Master PC is `master`, and only a request from the Master
 * PC itself may speak for it: a LAN browser has no station key at all.
 */

import { Router, type Request } from 'express';

import { isLoopback } from '../../lib/network.js';
import * as printService from '../../services/print.service.js';
import type { PrintOrigin } from '../../services/print.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';

const needs = requirePermissionMiddleware;

/** Where a request came from, never from its body. */
function originOf(req: Request): PrintOrigin {
  const onMasterPc = isLoopback(req);
  return { from: onMasterPc ? 'master' : 'lan', stationKey: onMasterPc ? 'master' : null, holder: null };
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const count = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' && value !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const printJobRoutes: Router = Router();
printJobRoutes.use(requireAuth);

printJobRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(
      await printService.listJobs(
        {
          status: text(req.query.status),
          mine: req.query.mine === '1',
          cursor: text(req.query.cursor),
          limit: count(req.query.limit),
        },
        actorFromRequest(req),
      ),
    );
  }),
);

printJobRoutes.post(
  '/',
  needs('print.send'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await printService.sendJob(req.body, actorFromRequest(req), originOf(req)));
  }),
);

printJobRoutes.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await printService.getJob(req.params.id, actorFromRequest(req)));
  }),
);

printJobRoutes.post(
  '/:id/printed',
  needs('print.station'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { printed?: unknown; printerName?: unknown };
    res.json(
      await printService.markJob(
        { id: req.params.id, printed: body.printed, printerName: body.printerName },
        actorFromRequest(req),
        originOf(req),
      ),
    );
  }),
);

printJobRoutes.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    res.json(await printService.cancelJob(req.params.id, actorFromRequest(req)));
  }),
);

export const printStationRoutes: Router = Router();
printStationRoutes.use(requireAuth);

printStationRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await printService.listStations(actorFromRequest(req), originOf(req)));
  }),
);

printStationRoutes.put(
  '/self',
  needs('print.station'),
  asyncHandler(async (req, res) => {
    res.json(await printService.saveStation(req.body, actorFromRequest(req), originOf(req)));
  }),
);
