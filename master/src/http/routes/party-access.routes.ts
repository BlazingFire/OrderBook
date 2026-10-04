/**
 * Party Access endpoints — who may see and manage each party.
 *
 * The same two-layer shape as `access.routes.ts`: the route refuses early so a
 * doomed request never opens a transaction, and the service checks again
 * because the Office Panel reaches it over Socket.IO and never passes through
 * here at all.
 *
 * Reading needs `party.assign` **or** `party.accessAll`, which no single
 * `needs()` can express — the service's `requireCanRead` owns that rule, and
 * these read routes deliberately carry no route-level guard rather than
 * duplicating it in a form that could drift.
 */

import { PARTY_ACCESS_SORTS } from '@orderbook/shared';
import type { PartyAccessSort } from '@orderbook/shared';
import { Router } from 'express';

import * as partyAccessService from '../../services/party-access.service.js';
import { asyncHandler } from '../async-handler.js';
import {
  actorFromRequest,
  requireAuth,
  requirePermissionMiddleware,
} from '../middleware/require-auth.js';

export const partyAccessRoutes: Router = Router();

partyAccessRoutes.use(requireAuth);

const needs = requirePermissionMiddleware;

function sortColumn(value: unknown): PartyAccessSort | undefined {
  return PARTY_ACCESS_SORTS.find((column) => column === value);
}

function restrictionFilter(value: unknown): 'open' | 'restricted' | undefined {
  return value === 'open' || value === 'restricted' ? value : undefined;
}

partyAccessRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(
      await partyAccessService.listAssignments(
        {
          search: typeof req.query.search === 'string' ? req.query.search : undefined,
          userId: typeof req.query.userId === 'string' ? req.query.userId : undefined,
          restriction: restrictionFilter(req.query.restriction),
          sort: sortColumn(req.query.sort),
          dir: req.query.dir === 'desc' ? 'desc' : 'asc',
          limit: req.query.limit ? Number(req.query.limit) : undefined,
          offset: req.query.offset ? Number(req.query.offset) : undefined,
        },
        actorFromRequest(req),
      ),
    );
  }),
);

// These sit before `/:partyId`, or their paths are read as party ids.
partyAccessRoutes.get(
  '/summary',
  asyncHandler(async (req, res) => {
    res.json(await partyAccessService.summary(actorFromRequest(req)));
  }),
);

partyAccessRoutes.get(
  '/people',
  asyncHandler(async (req, res) => {
    res.json(await partyAccessService.assignablePeople(actorFromRequest(req)));
  }),
);


partyAccessRoutes.get(
  '/export.csv',
  needs('parties.export'),
  asyncHandler(async (req, res) => {
    const { csv } = await partyAccessService.exportRows(actorFromRequest(req));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="party-access.csv"');
    res.send(csv);
  }),
);

partyAccessRoutes.get(
  '/:partyId',
  asyncHandler(async (req, res) => {
    res.json(
      await partyAccessService.assignmentsForParty(String(req.params.partyId), actorFromRequest(req)),
    );
  }),
);

partyAccessRoutes.put(
  '/:partyId',
  needs('party.assign'),
  asyncHandler(async (req, res) => {
    res.json(
      await partyAccessService.replaceAssignments(
        String(req.params.partyId),
        req.body,
        actorFromRequest(req),
      ),
    );
  }),
);
