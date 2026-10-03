/**
 * `/api/fields` (`docs/backend-modules/04-API-CONTRACT.md` §5).
 *
 * Copies `access.routes.ts`'s shape — `requireAuth` then a `needs(...)` guard
 * per handler — never `data.routes.ts`'s (`requireAuth` alone). Reading is
 * `fields.view` (every tier); editing is `fields.manage` (management+).
 */

import { Router } from 'express';

import * as fieldsService from '../../services/fields.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';

export const fieldsRoutes: Router = Router();

fieldsRoutes.use(requireAuth);

const needs = requirePermissionMiddleware;

// --- Reads: fields.view ------------------------------------------------
//
// `/values` and `/usage` carry no middleware gate: the service decides, because the
// brands, packaging types and grades are readable by everyone (1.4 D3) and every
// other list needs `fields.view`. The same holds for the value writes below:
// `fields.manage` for the other lists, `catalog.lists.manage` for those three.

fieldsRoutes.get(
  '/catalogue',
  needs('fields.view'),
  asyncHandler(async (req, res) => {
    res.json(fieldsService.fieldsCatalogue(actorFromRequest(req)));
  }),
);

fieldsRoutes.get(
  '/values',
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

// --- Option-list values: fields.manage ----------------------------------

fieldsRoutes.post(
  '/values',
  asyncHandler(async (req, res) => {
    res.status(201).json(await fieldsService.createValue(req.body, actorFromRequest(req)));
  }),
);

fieldsRoutes.put(
  '/values/:id',
  asyncHandler(async (req, res) => {
    res.json(
      await fieldsService.updateValue(String(req.params.id), req.body, actorFromRequest(req)),
    );
  }),
);

fieldsRoutes.delete(
  '/values/:id',
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.deleteValue(String(req.params.id), actorFromRequest(req)));
  }),
);

fieldsRoutes.post(
  '/values/reorder',
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.reorderValues(req.body, actorFromRequest(req)));
  }),
);

// --- Custom-field definitions: fields.manage ----------------------------

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
    res.json(
      await fieldsService.updateDefinition(String(req.params.id), req.body, actorFromRequest(req)),
    );
  }),
);

fieldsRoutes.delete(
  '/definitions/:id',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.deleteDefinition(String(req.params.id), actorFromRequest(req)));
  }),
);

fieldsRoutes.post(
  '/definitions/reorder',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.reorderDefinitions(req.body, actorFromRequest(req)));
  }),
);

// --- Pipeline stages: fields.manage --------------------------------------

fieldsRoutes.put(
  '/stages/:id',
  needs('fields.manage'),
  asyncHandler(async (req, res) => {
    res.json(
      await fieldsService.updateStage(String(req.params.id), req.body ?? {}, actorFromRequest(req)),
    );
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

