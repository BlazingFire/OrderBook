/**
 * `/api/data-reset` — the Master's Delete data screen
 * (`master/src/services/data-reset.service.ts`).
 *
 * Copies `settings.routes.ts`'s shape: `requireAuth`, then a `needs(...)`
 * guard; the service adds the admin tier and, for Start fresh, the person's own
 * password. Mounted **before** `app.use('/api', dataRoutes)`, which is a
 * catch-all.
 */

import { Router } from 'express';

import * as dataResetService from '../../services/data-reset.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';

export const dataResetRoutes: Router = Router();

dataResetRoutes.use(requireAuth);

const needs = requirePermissionMiddleware;

dataResetRoutes.get(
  '/summary',
  needs('settings.manage'),
  asyncHandler(async (req, res) => {
    res.json(await dataResetService.freshStartSummary(actorFromRequest(req)));
  }),
);

function confirmation(body: unknown) {
  const fields = (body ?? {}) as { confirmPassword?: unknown; confirmText?: unknown };
  return {
    confirmPassword: String(fields.confirmPassword ?? ''),
    confirmText: String(fields.confirmText ?? ''),
  };
}

/** Each is POST so the password never enters a URL or a log; `no-store` so no cache holds the answer. */
dataResetRoutes.post(
  '/fresh-start',
  needs('settings.manage'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await dataResetService.freshStart(confirmation(req.body), actorFromRequest(req)));
  }),
);

dataResetRoutes.post(
  '/chat',
  needs('settings.manage'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await dataResetService.clearChat(confirmation(req.body), actorFromRequest(req)));
  }),
);

dataResetRoutes.post(
  '/print-history',
  needs('settings.manage'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await dataResetService.clearPrintHistory(confirmation(req.body), actorFromRequest(req)));
  }),
);
