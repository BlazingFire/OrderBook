import { Router } from 'express';
import type { OfficePanelUpdateInput, PairingRequest } from '@orderbook/shared';

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
    res.json(await panelService.revokePanel(String(req.params.id), actorFromRequest(req)));
  }),
);

/**
 * One panel, with its role, its machine and what it has produced.
 *
 * `panels.manage`, unlike the list above it. The list is what the presence rail
 * counts on every signed-in session; this is a different object — it carries
 * the panel's effective permission set and the layout of its disk, and the
 * screen it feeds is only offered to a role that holds this key anyway.
 */
panelRoutes.get(
  '/:id',
  needs('panels.manage'),
  asyncHandler(async (req, res) => {
    const actor = actorFromRequest(req);
    res.json(await panelService.getPanelDetail(actor.tenantId, String(req.params.id)));
  }),
);

/**
 * Rename, retag, or move a panel onto another role.
 *
 * A missing field means "leave it alone", so the screen can save one card
 * without sending the rest of the form back. `name` stays required-if-present
 * rather than required outright — that is what makes a notes-only save legal.
 */
panelRoutes.patch(
  '/:id',
  needs('panels.manage'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: OfficePanelUpdateInput = {};

    if (body.name !== undefined) {
      if (typeof body.name !== 'string') throw new ValidationError('validation.panel.nameRequired');
      input.name = body.name;
    }

    if (body.notes !== undefined) {
      if (body.notes !== null && typeof body.notes !== 'string') {
        throw new ValidationError('validation.panel.fieldInvalid');
      }
      input.notes = body.notes as string | null;
    }

    if (body.roleId !== undefined) {
      if (body.roleId !== null && typeof body.roleId !== 'string') {
        throw new ValidationError('validation.panel.fieldInvalid');
      }
      input.roleId = body.roleId as string | null;
    }

    if (Object.keys(input).length === 0) throw new ValidationError('validation.panel.nameRequired');

    res.json(await panelService.updatePanel(String(req.params.id), input, actorFromRequest(req)));
  }),
);

/** Pull a fresh account of the panel's machine, rather than the last timed one. */
panelRoutes.post(
  '/:id/refresh',
  needs('panels.manage'),
  asyncHandler(async (req, res) => {
    const actor = actorFromRequest(req);
    res.json(await panelService.refreshPanelReport(actor.tenantId, String(req.params.id)));
  }),
);

/**
 * Issue the panel a new secret. The plaintext is in this response and nowhere
 * else — it is never stored, and there is no way to ask for it again.
 */
panelRoutes.post(
  '/:id/rotate-secret',
  needs('panels.manage'),
  asyncHandler(async (req, res) => {
    const actor = actorFromRequest(req);
    res.json(await panelService.rotatePanelSecret(actor.tenantId, String(req.params.id), actor));
  }),
);

/** Move that panel's data folder to another path on its own disk. */
panelRoutes.post(
  '/:id/storage-path',
  needs('panels.manage'),
  asyncHandler(async (req, res) => {
    const actor = actorFromRequest(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.path !== 'string') {
      throw new ValidationError('validation.panel.storagePathRequired');
    }

    res.json(
      await panelService.setPanelStoragePath(
        actor.tenantId,
        String(req.params.id),
        { path: body.path, moveExisting: body.moveExisting !== false },
        actor,
      ),
    );
  }),
);

/**
 * Drop the panel's socket. It reconnects by itself within seconds — this is a
 * way to clear a wedged session without ending the pairing, which is what
 * `revoke` above does.
 */
panelRoutes.post(
  '/:id/disconnect',
  needs('panels.manage'),
  asyncHandler(async (req, res) => {
    const actor = actorFromRequest(req);
    // Resolved first so a panel id from another company is a 404 here too,
    // rather than a silent `{ disconnected: false }` that confirms nothing.
    await panelService.getPanelDetail(actor.tenantId, String(req.params.id));
    res.json({ disconnected: panelService.disconnectPanel(String(req.params.id)) });
  }),
);

/**
 * What this panel has been doing, and what has been done to it.
 *
 * `logs.view`, not `panels.manage`: it is the audit trail, and the Logs module
 * already decides who may read that.
 */
panelRoutes.get(
  '/:id/activity',
  needs('logs.view'),
  asyncHandler(async (req, res) => {
    const actor = actorFromRequest(req);
    const limit = Number.parseInt(String(req.query.limit ?? ''), 10);

    res.json({
      entries: await panelService.listPanelActivity(
        actor.tenantId,
        String(req.params.id),
        Number.isFinite(limit) ? limit : 50,
      ),
    });
  }),
);

/** Express reports IPv4 clients as ::ffff:a.b.c.d when the socket is dual-stack. */
function normalizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
