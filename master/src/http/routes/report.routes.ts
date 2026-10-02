/**
 * `/api/reports` (`docs/backend-modules/04-API-CONTRACT.md` §3). Same shape
 * as `log.routes.ts`: `requireAuth` then a per-handler permission guard.
 *
 * The three legacy routes (`/dispatches`, `/lead-outcomes`, `/top-parties`)
 * stay for Offices that predate the table API. `/options` and `/table/:report`
 * are what both panels' Reports screen reads, and `/:report/export` writes any
 * kind as CSV, Excel or PDF. The service decides who may see whose figures
 * (`report.service.ts`); the guards here only say a report permission is
 * needed at all.
 */

import { Router } from 'express';

import { isReportFormat, isReportKind, parseReportQuery, type ReportKind } from '@orderbook/shared';

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

function kindOf(value: unknown): ReportKind {
  if (!isReportKind(value)) {
    throw new ValidationError('validation.reports.kind.unknown', {}, { field: 'report' });
  }
  return value;
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
  '/options',
  needs('reports.view'),
  asyncHandler(async (req, res) => {
    res.json(await reportService.reportOptions(actorFromRequest(req)));
  }),
);

reportRoutes.get(
  '/table/:report',
  needs('reports.view'),
  asyncHandler(async (req, res) => {
    res.json(await reportService.reportTable(kindOf(req.params.report), parseReportQuery(req.query), actorFromRequest(req)));
  }),
);

reportRoutes.get(
  '/:report/export',
  needs('reports.export'),
  asyncHandler(async (req, res) => {
    const kind = kindOf(req.params.report);

    const columns = String(req.query.columns ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);

    const exported = await reportService.exportReport(
      kind,
      {
        // The query string reads the same everywhere (`parseReportQuery`); the
        // legacy three kinds never sent the new fields, so for them it is the
        // same range it always was.
        ...parseReportQuery(req.query),
        // Every option is absent by default, and the defaults reproduce
        // today's output byte for byte — somebody's spreadsheet is pointing at
        // this URL.
        format: isReportFormat(req.query.format) ? req.query.format : undefined,
        columns: columns.length > 0 ? columns : undefined,
        totals: req.query.totals === 'true',
        paperSize: req.query.paperSize === 'letter' ? 'letter' : undefined,
        orientation: req.query.orientation === 'portrait' ? 'portrait' : undefined,
        lang: req.query.lang === 'hi' ? 'hi' : undefined,
      },
      actorFromRequest(req),
    );

    if (exported.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${kind}.csv"`);
      res.send(exported.csv);
      return;
    }

    res.setHeader('Content-Type', exported.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${exported.fileName}"`);
    res.send(exported.bytes);
  }),
);
