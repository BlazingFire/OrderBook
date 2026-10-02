/**
 * `/api/logs` (`docs/backend-modules/04-API-CONTRACT.md` §2).
 *
 * A new file rather than routes added to `access.routes.ts`, because
 * `master/tests/credential-invariants.test.ts` asserts a guard-count-to-
 * handler-count identity in that file with exactly two exemptions — adding
 * unrelated routes there would either break that count or need a third.
 * Copies `access.routes.ts`'s shape: `requireAuth` then a per-handler
 * permission guard.
 */

import { isLocale } from '@orderbook/shared';
import { Router } from 'express';

import * as logService from '../../services/log.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';

export const logRoutes: Router = Router();

logRoutes.use(requireAuth);

const needs = requirePermissionMiddleware;

function parseListQuery(query: Record<string, unknown>): Parameters<typeof logService.listLogs>[0] {
  return {
    cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
    direction: query.direction === 'newer' ? 'newer' : query.direction === 'older' ? 'older' : undefined,
    limit: query.limit ? Number(query.limit) : undefined,
    actorType: typeof query.actorType === 'string' ? (query.actorType as never) : undefined,
    actorId: typeof query.actorId === 'string' ? query.actorId : undefined,
    entityType: typeof query.entityType === 'string' ? query.entityType : undefined,
    action: typeof query.action === 'string' ? query.action : undefined,
    from: typeof query.from === 'string' ? query.from : undefined,
    to: typeof query.to === 'string' ? query.to : undefined,
    q: typeof query.q === 'string' ? query.q : undefined,
  };
}

logRoutes.get(
  '/',
  needs('logs.view'),
  asyncHandler(async (req, res) => {
    res.json(await logService.listLogs(parseListQuery(req.query), actorFromRequest(req)));
  }),
);

logRoutes.get(
  '/facets',
  needs('logs.view'),
  asyncHandler(async (req, res) => {
    res.json(
      await logService.listLogFacets(
        {
          from: typeof req.query.from === 'string' ? req.query.from : undefined,
          to: typeof req.query.to === 'string' ? req.query.to : undefined,
        },
        actorFromRequest(req),
      ),
    );
  }),
);

logRoutes.post(
  '/verify',
  needs('logs.verifyChain'),
  asyncHandler(async (req, res) => {
    res.json(await logService.verifyLogChain(req.body ?? {}, actorFromRequest(req)));
  }),
);

logRoutes.get(
  '/export',
  needs('logs.export'),
  asyncHandler(async (req, res) => {
    const { csv } = await logService.exportLogs(
      { ...parseListQuery(req.query), locale: isLocale(req.query.locale) ? req.query.locale : undefined },
      actorFromRequest(req),
    );
    const from = typeof req.query.from === 'string' ? req.query.from : 'all';
    const to = typeof req.query.to === 'string' ? req.query.to : 'all';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="logs-${from}-${to}.csv"`);
    res.send(csv);
  }),
);
