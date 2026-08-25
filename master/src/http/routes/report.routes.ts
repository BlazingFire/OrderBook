/**
 * `/api/reports` (`docs/backend-modules/04-API-CONTRACT.md` §3). Same shape
 * as `log.routes.ts`: `requireAuth` then a per-handler permission guard.
 */

import { Router } from 'express';

import { isReportKind } from '@orderbook/shared';

import * as reportService from '../../services/report.service.js';
import { ValidationError } from '../../lib/errors.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';

export const reportRoutes: Router = Router();

reportRoutes.use(requireAuth);

const needs = requirePermissionMiddleware;

function parseRangeQuery(query: Record<string, unknown>): {
  period?: never;
  fromMonth?: string;
  toMonth?: string;
} {
  return {
    period: (typeof query.period === 'string' ? query.period : undefined) as never,
    fromMonth: typeof query.fromMonth === 'string' ? query.fromMonth : undefined,
    toMonth: typeof query.toMonth === 'string' ? query.toMonth : undefined,
  };
}

reportRoutes.get(
  '/dispatches',
  needs('reports.view'),
  asyncHandler(async (req, res) => {
    res.json(await reportService.dispatchReport(parseRangeQuery(req.query), actorFromRequest(req)));
  }),
);

reportRoutes.get(
  '/lead-outcomes',
  needs('reports.view'),
  asyncHandler(async (req, res) => {
    res.json(await reportService.leadOutcomeReport(parseRangeQuery(req.query), actorFromRequest(req)));
  }),
);

reportRoutes.get(
  '/top-parties',
  needs('reports.view'),
  asyncHandler(async (req, res) => {
    res.json(
      await reportService.topPartiesReport(
        { ...parseRangeQuery(req.query), limit: req.query.limit ? Number(req.query.limit) : undefined },
        actorFromRequest(req),
      ),
    );
  }),
);

reportRoutes.get(
  '/:report/export',
  needs('reports.export'),
  asyncHandler(async (req, res) => {
    const kind = req.params.report;
    if (!isReportKind(kind)) {
      throw new ValidationError('validation.reports.kind.unknown', {}, { field: 'report' });
    }

    const { csv } = await reportService.exportReport(
      kind,
      { ...parseRangeQuery(req.query), limit: req.query.limit ? Number(req.query.limit) : undefined },
      actorFromRequest(req),
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${kind}.csv"`);
    res.send(csv);
  }),
);
