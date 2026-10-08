/**
 * `/api/notices`: the notice board for the Master's own browser (Oct 2026).
 *
 * An Office Panel reaches the same service through the twinned `notice:*` socket commands, which
 * its own server forwards at these same paths. Every route names its key: reading and recording
 * reads need `notices.view`, everything else `notices.manage`. What a reader sees is scoped by
 * their role in the service, not here.
 *
 * "Sell today" (2026-10-08) has its own three under `/sell-today` (twinned with `sellToday:*`);
 * an entry is deleted like a notice, at `DELETE /:id`.
 */

import { Router } from 'express';

import * as noticeService from '../../services/notice.service.js';
import { asyncHandler } from '../async-handler.js';
import {
  actorFromRequest,
  requireAuth,
  requirePermissionMiddleware,
} from '../middleware/require-auth.js';

const needs = requirePermissionMiddleware;

export const noticeRoutes: Router = Router();
noticeRoutes.use(requireAuth);

noticeRoutes.get(
  '/',
  needs('notices.view'),
  asyncHandler(async (req, res) => {
    res.json(await noticeService.listBoard(actorFromRequest(req)));
  }),
);

noticeRoutes.get(
  '/manage',
  needs('notices.manage'),
  asyncHandler(async (req, res) => {
    res.json(await noticeService.listManage(actorFromRequest(req)));
  }),
);

noticeRoutes.get(
  '/sell-today',
  needs('notices.manage'),
  asyncHandler(async (req, res) => {
    res.json(await noticeService.listSellTodayManage(actorFromRequest(req)));
  }),
);

noticeRoutes.post(
  '/sell-today',
  needs('notices.manage'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await noticeService.createSellToday(req.body ?? {}, actorFromRequest(req)));
  }),
);

noticeRoutes.patch(
  '/sell-today/:id',
  needs('notices.manage'),
  asyncHandler(async (req, res) => {
    res.json(
      await noticeService.updateSellToday(
        String(req.params.id),
        req.body ?? {},
        actorFromRequest(req),
      ),
    );
  }),
);

noticeRoutes.get(
  '/audiences',
  needs('notices.manage'),
  asyncHandler(async (req, res) => {
    res.json(await noticeService.listAudienceRoles(actorFromRequest(req)));
  }),
);

noticeRoutes.get(
  '/:id/readers',
  needs('notices.manage'),
  asyncHandler(async (req, res) => {
    res.json(await noticeService.getReaders(String(req.params.id), actorFromRequest(req)));
  }),
);

noticeRoutes.post(
  '/read',
  needs('notices.view'),
  asyncHandler(async (req, res) => {
    const ids = (req.body as { ids?: unknown } | undefined)?.ids;
    res.json(
      await noticeService.markRead(
        {
          ...(Array.isArray(ids)
            ? { ids: ids.filter((id): id is string => typeof id === 'string') }
            : {}),
        },
        actorFromRequest(req),
      ),
    );
  }),
);

noticeRoutes.post(
  '/',
  needs('notices.manage'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await noticeService.createNotice(req.body ?? {}, actorFromRequest(req)));
  }),
);

noticeRoutes.patch(
  '/:id',
  needs('notices.manage'),
  asyncHandler(async (req, res) => {
    res.json(
      await noticeService.updateNotice(
        String(req.params.id),
        req.body ?? {},
        actorFromRequest(req),
      ),
    );
  }),
);

noticeRoutes.delete(
  '/:id',
  needs('notices.manage'),
  asyncHandler(async (req, res) => {
    res.json(await noticeService.deleteNotice(String(req.params.id), actorFromRequest(req)));
  }),
);
