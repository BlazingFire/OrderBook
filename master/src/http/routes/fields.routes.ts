/**
 * `/api/fields` (`docs/backend-modules/04-API-CONTRACT.md` §5).
 *
 * Copies `access.routes.ts`'s shape — `requireAuth` then a per-handler
 * permission guard — never `data.routes.ts`'s. A separate surface from the
 * three existing unguarded reads (`GET /api/pipelines`, `/api/option-lists`,
 * `/api/custom-fields`), which stay exactly as they are.
 */

import { Router } from 'express';

import * as fieldsService from '../../services/fields.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';

export const fieldsRoutes: Router = Router();

fieldsRoutes.use(requireAuth);

const needs = requirePermissionMiddleware;

fieldsRoutes.get(
  '/catalogue',
  needs('fields.view'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.fieldsCatalogue(actorFromRequest(req)));
  }),
);

fieldsRoutes.get(
  '/values',
  needs('fields.view'),
  asyncHandler(async (req, res) => {
    res.json(
      await fieldsService.listValues(
        {
          listKey: req.query.listKey,
          includeDeleted: req.query.includeDeleted === 'true',
          includeUnlisted: req.query.includeUnlisted === 'true',
        },
        actorFromRequest(req),
      ),
    );
  }),
);

fieldsRoutes.get(
  '/usage',
  needs('fields.view'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.fieldUsage({ listKey: req.query.listKey }, actorFromRequest(req)));
  }),
);

fieldsRoutes.get(
  '/definitions',
  needs('fields.view'),
  asyncHandler(async (req, res) => {
    res.json(
      await fieldsService.listDefinitions(
        { entity: req.query.entity, includeDeleted: req.query.includeDeleted === 'true' },
        actorFromRequest(req),
      ),
    );
  }),
);

fieldsRoutes.get(
  '/stages',
  needs('fields.view'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.listStages(actorFromRequest(req)));
  }),
);

fieldsRoutes.post(
  '/values',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await fieldsService.createValue(req.body, actorFromRequest(req)));
  }),
);

fieldsRoutes.put(
  '/values/:id',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.updateValue(String(req.params.id), req.body, actorFromRequest(req)));
  }),
);

fieldsRoutes.delete(
  '/values/:id',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.removeValue(String(req.params.id), actorFromRequest(req)));
  }),
);

fieldsRoutes.post(
  '/values/reorder',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.reorderValues(req.body, actorFromRequest(req)));
  }),
);

fieldsRoutes.post(
  '/definitions',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await fieldsService.createDefinition(req.body, actorFromRequest(req)));
  }),
);

fieldsRoutes.put(
  '/definitions/:id',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.updateDefinition(String(req.params.id), req.body, actorFromRequest(req)));
  }),
);

fieldsRoutes.delete(
  '/definitions/:id',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.removeDefinition(String(req.params.id), actorFromRequest(req)));
  }),
);

fieldsRoutes.post(
  '/definitions/reorder',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.reorderDefinitions(req.body, actorFromRequest(req)));
  }),
);

fieldsRoutes.put(
  '/stages/:id',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.updateStage(String(req.params.id), req.body, actorFromRequest(req)));
  }),
);

fieldsRoutes.post(
  '/stages/reorder',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.reorderStages(req.body, actorFromRequest(req)));
  }),
);

fieldsRoutes.post(
  '/stages/:id/archive',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.archiveStage(String(req.params.id), actorFromRequest(req)));
  }),
);

fieldsRoutes.post(
  '/stages/:id/restore',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.restoreStage(String(req.params.id), actorFromRequest(req)));
  }),
);
