import { Router } from 'express';
import type { PairingRequest } from '@orderbook/shared';

import { ValidationError } from '../../lib/errors.js';
import * as panelService from '../../services/panel.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';

/**
 * Unauthenticated: an Office Panel has no credentials yet at this point. The
 * request is authorized instead by the open pairing window (auto mode) or the
 * pairing password (manual mode).
 */
export const pairingRoutes: Router = Router();

pairingRoutes.post(
  '/request',
  asyncHandler(async (req, res) => {
    const body = req.body as Partial<PairingRequest> | undefined;
    if (!body || (body.mode !== 'auto' && body.mode !== 'manual')) {
      throw new ValidationError('validation.pairing.invalidRequest');
    }

    const result = await panelService.pairPanel(
      {
        mode: body.mode,
        panelName: typeof body.panelName === 'string' ? body.panelName : '',
        hostname: typeof body.hostname === 'string' ? body.hostname : 'unknown',
        nonce: body.nonce,
        pairingPassword: body.pairingPassword,
        masterUniqueId: body.masterUniqueId,
      },
      normalizeIp(req.ip),
    );

    res.status(201).json(result);
  }),
);

/**
 * Management of already-paired panels.
 *
 * Admitting a panel, revoking one and renaming one are `panels.manage`: opening
 * the pairing window admits any panel that can find the Master over UDP, and a
 * revoke locks a working panel out until somebody re-pairs it by hand. The two
 * reads stay on `requireAuth` alone: the shell's presence rail asks for the
 * panel list on every signed-in session, whatever that session may administer,
 * and the pairing window reports this Master's own transient state rather than
 * anything belonging to the company.
 */
export const panelRoutes: Router = Router();

panelRoutes.use(requireAuth);

const needs = requirePermissionMiddleware;

panelRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    const actor = actorFromRequest(req);
    res.json({ panels: await panelService.listPanelsWithPresence(actor.tenantId) });
  }),
);

panelRoutes.post('/pairing-window/open', needs('panels.manage'), (_req, res) => {
  res.json(panelService.openPairingWindow());
});

panelRoutes.post('/pairing-window/close', needs('panels.manage'), (_req, res) => {
  panelService.closePairingWindow();
  res.status(204).end();
});

panelRoutes.get('/pairing-window', (_req, res) => {
  res.json({ accepting: panelService.isAcceptingPairing() });
});

panelRoutes.post(
  '/:id/revoke',
  needs('panels.manage'),
  asyncHandler(async (req, res) => {
    res.json(await panelService.revokePanel(String(req.params.id)));
  }),
);

panelRoutes.patch(
  '/:id',
  needs('panels.manage'),
  asyncHandler(async (req, res) => {
    const name = req.body?.name;
    if (typeof name !== 'string') throw new ValidationError('validation.panel.nameRequired');
    res.json(await panelService.renamePanel(String(req.params.id), name));
  }),
);

/** Express reports IPv4 clients as ::ffff:a.b.c.d when the socket is dual-stack. */
function normalizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
