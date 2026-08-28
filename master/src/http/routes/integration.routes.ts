/**
 * The administrator's side: issuing keys and managing connections.
 *
 * Every route here is behind `api.manage`, with no exemptions. There is no
 * read-only half worth opening up — a list of keys tells you which programs can
 * reach this shop's data, and a list of connections tells you where its
 * catalogue is being copied from.
 *
 * The token comes back on exactly one response, from `POST /keys`. Nothing
 * else in this file can return it, because nothing else has it.
 */

import { Router } from 'express';

import { asyncHandler } from '../async-handler.js';
import {
  actorFromRequest,
  requireAuth,
  requirePermissionMiddleware,
} from '../middleware/require-auth.js';
import { resetRateLimits } from '../middleware/api-key-rate-limit.js';
import * as apiKeyService from '../../services/api-key.service.js';
import * as connectorService from '../../services/connector.service.js';
import * as connectorRunService from '../../services/connector-run.service.js';
import * as connectorRepo from '../../repositories/connector.repository.js';

export const integrationRoutes: Router = Router();

integrationRoutes.use(requireAuth);

const needs = requirePermissionMiddleware;

// --- Keys ------------------------------------------------------------------

integrationRoutes.get(
  '/keys',
  needs('api.manage'),
  asyncHandler(async (req, res) => {
    res.json(await apiKeyService.listKeys(actorFromRequest(req)));
  }),
);

integrationRoutes.post(
  '/keys',
  needs('api.manage'),
  asyncHandler(async (req, res) => {
    const issued = await apiKeyService.issueKey(actorFromRequest(req), req.body);
    // The one response that carries a token. `no-store` for the same reason the
    // password reveal has it: this must not sit in a proxy or a browser cache.
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(issued);
  }),
);

integrationRoutes.post(
  '/keys/:id/revoke',
  needs('api.manage'),
  asyncHandler(async (req, res) => {
    const key = await apiKeyService.revokeKey(actorFromRequest(req), String(req.params.id));
    // Forget its rate window too, so the id cannot carry a spent quota if it is
    // ever reused. Cheap, and it keeps the map to live keys.
    resetRateLimits(key.id);
    res.json(key);
  }),
);

// --- Connections -----------------------------------------------------------

integrationRoutes.get(
  '/connectors',
  needs('api.manage'),
  asyncHandler(async (req, res) => {
    res.json(await connectorService.listConnectors(actorFromRequest(req)));
  }),
);

integrationRoutes.get(
  '/connectors/profiles',
  needs('api.manage'),
  asyncHandler(async (req, res) => {
    res.json(connectorService.listProfiles(actorFromRequest(req)));
  }),
);

integrationRoutes.post(
  '/connectors',
  needs('api.manage'),
  asyncHandler(async (req, res) => {
    const actor = actorFromRequest(req);
    const body: unknown = req.body;
    const profileSlug =
      typeof body === 'object' && body !== null
        ? (body as { fromProfile?: string }).fromProfile
        : undefined;

    const connector = profileSlug
      ? await connectorService.createFromProfile(actor, profileSlug, req.body)
      : await connectorService.createConnector(actor, req.body);

    res.status(201).json(connector);
  }),
);

integrationRoutes.get(
  '/connectors/:id',
  needs('api.manage'),
  asyncHandler(async (req, res) => {
    res.json(await connectorService.getConnector(actorFromRequest(req), String(req.params.id)));
  }),
);

integrationRoutes.patch(
  '/connectors/:id',
  needs('api.manage'),
  asyncHandler(async (req, res) => {
    res.json(
      await connectorService.updateConnector(
        actorFromRequest(req),
        String(req.params.id),
        req.body,
      ),
    );
  }),
);

integrationRoutes.delete(
  '/connectors/:id',
  needs('api.manage'),
  asyncHandler(async (req, res) => {
    await connectorService.deleteConnector(actorFromRequest(req), String(req.params.id));
    res.status(204).end();
  }),
);

integrationRoutes.put(
  '/connectors/:id/mapping',
  needs('api.manage'),
  asyncHandler(async (req, res) => {
    const body: unknown = req.body;
    const resources = Array.isArray(body) ? body : (body as { resources?: unknown })?.resources;

    res.json(
      await connectorService.setMapping(
        actorFromRequest(req),
        String(req.params.id),
        Array.isArray(resources) ? resources : [],
      ),
    );
  }),
);

integrationRoutes.post(
  '/connectors/:id/test',
  needs('api.manage'),
  asyncHandler(async (req, res) => {
    const body: unknown = req.body;
    const entity = (
      typeof body === 'object' && body !== null ? (body as { entity?: unknown }).entity : undefined
    ) as 'party' | 'product';

    res.json(
      await connectorRunService.testConnection(
        actorFromRequest(req),
        String(req.params.id),
        entity === 'product' ? 'product' : 'party',
      ),
    );
  }),
);

integrationRoutes.post(
  '/connectors/:id/run',
  needs('api.manage'),
  asyncHandler(async (req, res) => {
    const body: unknown = req.body;
    const mode =
      typeof body === 'object' && body !== null && (body as { mode?: unknown }).mode === 'import'
        ? 'import'
        : 'dry_run';

    res.json(
      await connectorRunService.runConnector(
        actorFromRequest(req),
        String(req.params.id),
        mode,
        'manual',
      ),
    );
  }),
);

integrationRoutes.get(
  '/connectors/:id/runs',
  needs('api.manage'),
  asyncHandler(async (req, res) => {
    const actor = actorFromRequest(req);
    // The service's own gate has already run through `needs`; this read is a
    // plain list of what the runs did.
    res.json(await connectorRepo.listRuns(actor.tenantId, String(req.params.id)));
  }),
);
