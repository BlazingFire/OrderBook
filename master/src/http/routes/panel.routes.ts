import { Router } from 'express';
import type { OfficePanelUpdateInput, PairingRequest } from '@orderbook/shared';

import { ValidationError } from '../../lib/errors.js';
import * as panelService from '../../services/panel.service.js';
import { asyncHandler } from '../async-handler.js';
import { consume } from '../middleware/api-key-rate-limit.js';
import { actorFromRequest, requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';

/**
 * How many manual-mode pairing attempts one source IP may make per minute.
 *
 * Every other credential check in this codebase locks out after repeated
 * failures — the Master's own sign-in (`auth.service.ts`), the Office
 * Panel's offline sign-in (`sign-in-attempts.store.ts`) — but the pairing
 * password, which hands a brand-new device full panel-level access, had
 * none: `/api/pairing/request` carries no rate-limit middleware and
 * `verifyPairingPassword` is a bare `bcrypt.compare`. Generous enough that a
 * shop provisioning several tills from one PC in a row never trips it —
 * `generateReadableSecret()`'s ~50 bits of entropy already makes brute force
 * impractical over the network, this is defense in depth for the day that
 * assumption is weakened. Auto-mode pairing is deliberately not limited here:
 * it has no password to guess, and the open-pairing-window check already
 * bounds it.
 */
const MANUAL_PAIRING_LIMIT_PER_MIN = 10;

/** Namespaced so an IP-keyed window can never collide with an API key id. */
const rateLimitKeyFor = (ip: string): string => `pairing:${ip}`;

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

    if (body.mode === 'manual') {
      // A request with no discernible source IP is rare enough to lump into
      // one shared bucket rather than skip the check entirely.
      consume(rateLimitKeyFor(normalizeIp(req.ip) ?? 'unknown'), MANUAL_PAIRING_LIMIT_PER_MIN);
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

panelRoutes.get(
  '/pairing-window',
  asyncHandler(async (req, res) => {
    // The same question the pairing route and the discovery reply ask. The
    // Master's own screen reads this, so answering on the window alone would
    // show "waiting for a panel" for a panel that will be refused on arrival.
    const actor = actorFromRequest(req);
    res.json({ accepting: await panelService.isAutoPairingOpen(actor.tenantId) });
  }),
);

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
