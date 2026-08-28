/**
 * The assistant's HTTP surface.
 *
 * **`GET /status` always answers.** Every other route here 404s while the
 * assistant is unconfigured, and the difference is deliberate: without a status
 * that answers, a panel cannot tell "switched off" from "this Master predates
 * the feature", and both should render the same way — which they can only do if
 * there is something to render.
 *
 * There is no streaming route. `POST /runs` returns a run id over the ordinary
 * cookie-authenticated request, and the tokens arrive on the Socket.IO
 * connection the browser already holds. A second stream would mean a second
 * keep-alive, a second reconnect and a second teardown, all for a channel that
 * is already open.
 */

import { Router } from 'express';

import { asyncHandler } from '../async-handler.js';
import {
  actorFromRequest,
  requireAuth,
  requirePermissionMiddleware,
} from '../middleware/require-auth.js';
import * as aiService from '../../services/ai.service.js';
import * as insightService from '../../services/ai-insight.service.js';

export const aiRoutes: Router = Router();

aiRoutes.use(requireAuth);

const needs = requirePermissionMiddleware;

/**
 * Answered whether or not the assistant is configured.
 *
 * Deliberately not behind `ai.use` either: a panel asks this to decide whether
 * to render a tab, and somebody without the permission should see the same
 * "not available" as somebody whose Master has no model.
 */
aiRoutes.get(
  '/status',
  asyncHandler(async (req, res) => {
    res.json(await aiService.status(actorFromRequest(req)));
  }),
);

/** The off switch, for everything below. */
aiRoutes.use(
  asyncHandler(async (req, res, next) => {
    const status = await aiService.status(actorFromRequest(req));
    if (!status.enabled) {
      res.status(404).json({ error: 'not_found', message: 'The assistant is not configured' });
      return;
    }
    next();
  }),
);

aiRoutes.get(
  '/runs',
  needs('ai.use'),
  asyncHandler(async (req, res) => {
    res.json(await aiService.listOwnRuns(actorFromRequest(req)));
  }),
);

aiRoutes.post(
  '/runs',
  needs('ai.use'),
  asyncHandler(async (req, res) => {
    // Acked as soon as the row exists and the request is away. Waiting for the
    // answer here is what makes an Office panel report the Master unreachable
    // fifteen seconds into a perfectly healthy reply.
    res.status(202).json(await aiService.startRun(actorFromRequest(req), req.body));
  }),
);

aiRoutes.get(
  '/runs/:id',
  needs('ai.use'),
  asyncHandler(async (req, res) => {
    res.json(await aiService.getRun(actorFromRequest(req), String(req.params.id)));
  }),
);

aiRoutes.delete(
  '/runs/:id',
  needs('ai.use'),
  asyncHandler(async (req, res) => {
    await aiService.cancelRun(actorFromRequest(req), String(req.params.id));
    res.status(204).end();
  }),
);

aiRoutes.post(
  '/proposals/:runId/apply',
  needs('ai.write'),
  asyncHandler(async (req, res) => {
    const body: unknown = req.body;
    const fields =
      typeof body === 'object' &&
      body !== null &&
      Array.isArray((body as { fields?: unknown }).fields)
        ? (body as { fields: unknown[] }).fields.filter(
            (field): field is string => typeof field === 'string',
          )
        : [];

    await aiService.applyProposal(actorFromRequest(req), String(req.params.runId), fields);
    res.status(204).end();
  }),
);

aiRoutes.get(
  '/insights',
  needs('ai.use'),
  asyncHandler(async (req, res) => {
    res.json(await insightService.listInsights(actorFromRequest(req)));
  }),
);

aiRoutes.post(
  '/test',
  needs('ai.manage'),
  asyncHandler(async (req, res) => {
    res.json(await aiService.testProvider(actorFromRequest(req)));
  }),
);
