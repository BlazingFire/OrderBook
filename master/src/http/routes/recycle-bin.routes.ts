/**
 * `/api/recycle-bin` (`docs/backend-modules/04-API-CONTRACT.md` §4).
 *
 * Copies `access.routes.ts`'s shape — `requireAuth` then a per-handler
 * permission guard — never `data.routes.ts`'s (`requireAuth` alone). The route
 * guard on `POST /restore` is deliberately the *weaker* of the two checks
 * here: the entity type travels in the body, so only the service, which
 * looks up `RESTORE_PERMISSION[entityType]`, can know which key actually
 * applies.
 */

import { Router } from 'express';

import { isRecycleBinEntityType } from '@orderbook/shared';

import { ValidationError } from '../../lib/errors.js';
import * as recycleBinService from '../../services/recycle-bin.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';

export const recycleBinRoutes: Router = Router();

recycleBinRoutes.use(requireAuth);

const needs = requirePermissionMiddleware;

recycleBinRoutes.get(
  '/',
  needs('recycleBin.view'),
  asyncHandler(async (req, res) => {
    const rawTypes = req.query.types;
    const requestedTypes = (Array.isArray(rawTypes) ? rawTypes : rawTypes ? [rawTypes] : []).map(String);

    for (const type of requestedTypes) {
      if (!isRecycleBinEntityType(type)) {
        throw new ValidationError('validation.recycleBin.unknownEntityType', {}, {
          field: 'types',
          value: type,
        });
      }
    }

    const types = requestedTypes.filter(isRecycleBinEntityType);

    res.json(
      await recycleBinService.listBin(
        {
          types: types.length > 0 ? types : undefined,
          search: typeof req.query.search === 'string' ? req.query.search : undefined,
          deletedBy: typeof req.query.deletedBy === 'string' ? req.query.deletedBy : undefined,
          cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        },
        actorFromRequest(req),
      ),
    );
  }),
);

recycleBinRoutes.get(
  '/counts',
  needs('recycleBin.view'),
  asyncHandler(async (req, res) => {
    res.json(await recycleBinService.binCounts(actorFromRequest(req)));
  }),
);

recycleBinRoutes.post(
  '/restore',
  needs('recycleBin.view'),
  asyncHandler(async (req, res) => {
    const body = req.body as
      | {
          entityType?: unknown;
          id?: unknown;
          renameTo?: unknown;
          cascadeParents?: unknown;
          expectedVersion?: unknown;
        }
      | undefined;

    if (!body || !isRecycleBinEntityType(body.entityType)) {
      throw new ValidationError('validation.recycleBin.unknownEntityType', {}, {
        field: 'entityType',
      });
    }
    if (typeof body.id !== 'string' || !body.id) {
      throw new ValidationError('validation.recycleBin.idRequired', {}, { field: 'id' });
    }

    res.json(
      await recycleBinService.restoreEntity(
        {
          entityType: body.entityType,
          id: body.id,
          renameTo: typeof body.renameTo === 'string' ? body.renameTo : undefined,
          cascadeParents: body.cascadeParents === true,
          expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
        },
        actorFromRequest(req),
      ),
    );
  }),
);
