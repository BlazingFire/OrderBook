/**
 * The Master Panel's own UI reads and writes through these endpoints. Office
 * Panels use the Socket.IO commands instead — both funnel into the same
 * services, so behaviour cannot diverge between the two panels.
 */

import { Router } from 'express';
import { isLeadStatus, type LeadStatus } from '@orderbook/shared';

import type { ActorContext } from '../../domain/actor.js';
import { ValidationError } from '../../lib/errors.js';
import * as catalogService from '../../services/catalog.service.js';
import * as inventoryService from '../../services/inventory.service.js';
import * as leadService from '../../services/lead.service.js';
import * as storageService from '../../services/storage.service.js';
import { asyncHandler } from '../async-handler.js';
import { requireAuth } from '../middleware/require-auth.js';

export const dataRoutes: Router = Router();

dataRoutes.use(requireAuth);

function actorFrom(userId: string | undefined): ActorContext {
  return { actorType: 'user', actorId: userId ?? null };
}

function paging(query: Record<string, unknown>): { search?: string; limit?: number; offset?: number } {
  return {
    search: typeof query.search === 'string' && query.search ? query.search : undefined,
    limit: query.limit ? Number(query.limit) : undefined,
    offset: query.offset ? Number(query.offset) : undefined,
  };
}

dataRoutes.get(
  '/dashboard',
  asyncHandler(async (_req, res) => {
    res.json(await leadService.getDashboardSummary());
  }),
);

dataRoutes.get(
  '/storage',
  asyncHandler(async (_req, res) => {
    res.json(await storageService.getStorageUsage());
  }),
);

dataRoutes.get(
  '/parties',
  asyncHandler(async (req, res) => {
    res.json(await catalogService.listParties(paging(req.query)));
  }),
);

dataRoutes.post(
  '/parties',
  asyncHandler(async (req, res) => {
    res.status(201).json(await catalogService.createParty(req.body, actorFrom(req.user?.id)));
  }),
);

dataRoutes.put(
  '/parties/:id',
  asyncHandler(async (req, res) => {
    res.json(await catalogService.updateParty(String(req.params.id), req.body, actorFrom(req.user?.id)));
  }),
);

dataRoutes.get(
  '/products',
  asyncHandler(async (req, res) => {
    res.json(await catalogService.listProducts(paging(req.query)));
  }),
);

dataRoutes.post(
  '/products',
  asyncHandler(async (req, res) => {
    res.status(201).json(await catalogService.createProduct(req.body, actorFrom(req.user?.id)));
  }),
);

dataRoutes.put(
  '/products/:id',
  asyncHandler(async (req, res) => {
    res.json(await catalogService.updateProduct(String(req.params.id), req.body, actorFrom(req.user?.id)));
  }),
);

dataRoutes.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    res.json({ categories: await catalogService.listCategories() });
  }),
);

dataRoutes.get(
  '/stock',
  asyncHandler(async (req, res) => {
    const stock = await inventoryService.listStock({
      ...paging(req.query),
      lowOnly: req.query.lowOnly === 'true',
    });
    res.json({ stock });
  }),
);

dataRoutes.get(
  '/stock/movements',
  asyncHandler(async (req, res) => {
    const movements = await inventoryService.listMovements({
      productId: typeof req.query.productId === 'string' ? req.query.productId : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ movements });
  }),
);

dataRoutes.post(
  '/stock/inbound',
  asyncHandler(async (req, res) => {
    res.json(await inventoryService.recordInbound(req.body, actorFrom(req.user?.id)));
  }),
);

dataRoutes.post(
  '/stock/adjust',
  asyncHandler(async (req, res) => {
    res.json(await inventoryService.recordAdjustment(req.body, actorFrom(req.user?.id)));
  }),
);

dataRoutes.post(
  '/stock/reorder-level',
  asyncHandler(async (req, res) => {
    const { productId, reorderLevel } = req.body ?? {};
    if (typeof productId !== 'string') throw new ValidationError('Select a product');

    const level = reorderLevel === null || reorderLevel === '' ? null : Number(reorderLevel);
    res.json(await inventoryService.setReorderLevel(productId, level, actorFrom(req.user?.id)));
  }),
);

dataRoutes.get(
  '/leads',
  asyncHandler(async (req, res) => {
    const statuses = parseStatuses(req.query.statuses);
    res.json(await leadService.listLeads({ ...paging(req.query), statuses }));
  }),
);

dataRoutes.get(
  '/leads/:id',
  asyncHandler(async (req, res) => {
    res.json(await leadService.getLead(String(req.params.id)));
  }),
);

dataRoutes.post(
  '/leads',
  asyncHandler(async (req, res) => {
    const lead = await leadService.createLead(req.body, {
      sourcePanelId: null,
      actor: actorFrom(req.user?.id),
    });
    res.status(201).json(lead);
  }),
);

dataRoutes.post(
  '/leads/:id/status',
  asyncHandler(async (req, res) => {
    const status = req.body?.status;
    if (!isLeadStatus(status)) throw new ValidationError('Invalid lead status');
    res.json(await leadService.changeLeadStatus(String(req.params.id), status, actorFrom(req.user?.id)));
  }),
);

function parseStatuses(raw: unknown): LeadStatus[] | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const parsed = raw.split(',').filter(isLeadStatus);
  return parsed.length ? parsed : undefined;
}
