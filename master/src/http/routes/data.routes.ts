/**
 * The Master Panel's own UI reads and writes through these endpoints. Office
 * Panels use the Socket.IO commands instead — both funnel into the same
 * services, so behaviour cannot diverge between the two panels.
 *
 * One deliberate asymmetry: **the Master cannot create a lead.** Leads are
 * raised in the Office Panel (docs/LEAD_GENERATION_FLOW.md §2), and the absence
 * of a POST /leads here is what makes that true rather than merely documented.
 */

import { Router } from 'express';
import multer from 'multer';

import { ValidationError } from '../../lib/errors.js';
import * as backupExportService from '../../services/backup-export.service.js';
import * as backupRestoreService from '../../services/backup-restore.service.js';
import * as catalogService from '../../services/catalog.service.js';
import * as conflictService from '../../services/conflict.service.js';
import * as dashboardService from '../../services/dashboard.service.js';
import * as fieldsService from '../../services/fields.service.js';
import * as inventoryService from '../../services/inventory.service.js';
import * as leadService from '../../services/lead.service.js';
import * as orderService from '../../services/order.service.js';
import * as searchService from '../../services/search.service.js';
import * as storageService from '../../services/storage.service.js';
import { asyncHandler } from '../async-handler.js';
import {
  actorFromRequest,
  requireAuth,
  requirePermissionMiddleware,
} from '../middleware/require-auth.js';

export const dataRoutes: Router = Router();

dataRoutes.use(requireAuth);

/**
 * The Recycle Bin's four DELETE routes are the first handlers on this router
 * to carry a permission guard — every other route here relies on the
 * service-layer check alone. `leads.delete` / `orders.delete` /
 * `parties.delete` / `products.delete` have been in the frozen catalogue and
 * in stored role rows since `20260303`, and were enforced nowhere because no
 * delete path existed for any of the four until now.
 */
const needs = requirePermissionMiddleware;

/**
 * Buffers the whole uploaded backup file in memory before decrypting it — the
 * same tradeoff `images.routes.ts`'s upload makes, accepted here for the same
 * reason: this product's scale is one shop's database, not a multi-gigabyte
 * one. A future increase in scale would want to stream this instead.
 */
const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });

function paging(query: Record<string, unknown>): {
  search?: string;
  limit?: number;
  offset?: number;
} {
  return {
    search: typeof query.search === 'string' && query.search ? query.search : undefined,
    limit: query.limit ? Number(query.limit) : undefined,
    offset: query.offset ? Number(query.offset) : undefined,
  };
}

function idList(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const parsed = raw.split(',').filter(Boolean);
  return parsed.length ? parsed : undefined;
}

// --- Overview --------------------------------------------------------------

dataRoutes.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    res.json(await dashboardService.getDashboardSummary(actorFromRequest(req)));
  }),
);

dataRoutes.get(
  '/storage',
  asyncHandler(async (_req, res) => {
    res.json(await storageService.getStorageUsage());
  }),
);

// --- Storage: export, restore & migration (docs/7-STORAGE-BACKUP-RESTORE.md) ---

dataRoutes.post(
  '/storage/export',
  needs('storage.manage'),
  asyncHandler(async (req, res) => {
    const { scope, tenantIds, passphrase } = req.body ?? {};
    if (scope !== 'whole' && scope !== 'selected') {
      throw new ValidationError('validation.backup.scopeRequired');
    }
    if (typeof passphrase !== 'string' || !passphrase) {
      throw new ValidationError('validation.backup.passphraseRequired');
    }

    const result = await backupExportService.exportBackup({
      scope,
      tenantIds: Array.isArray(tenantIds) ? tenantIds.map(String) : undefined,
      passphrase,
    });

    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(result.data);
  }),
);

dataRoutes.post(
  '/storage/restore/preview',
  needs('storage.manage'),
  backupUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError('validation.backup.fileRequired');
    res.json(backupRestoreService.previewRestore(req.file.buffer));
  }),
);

dataRoutes.post(
  '/storage/restore',
  needs('storage.manage'),
  backupUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError('validation.backup.fileRequired');

    const passphrase = req.body?.passphrase;
    if (typeof passphrase !== 'string' || !passphrase) {
      throw new ValidationError('validation.backup.passphraseRequired');
    }
    const confirmWipe = req.body?.confirmWipe === 'true' || req.body?.confirmWipe === true;

    res.json(await backupRestoreService.restoreBackup(req.file.buffer, passphrase, confirmWipe));
  }),
);

/**
 * Deliberately ungated — `fieldsService.listPipelinesUnguarded` and its two
 * siblings below check nothing. They feed the Add Lead form and
 * `buildSnapshot`'s `Promise.all`; routing them through a `fields.view`
 * check would make that `Promise.all` reject for anyone lacking the key, and
 * a rejected `buildSnapshot` produces no snapshot at all
 * (`04-API-CONTRACT.md` §5.6). The management surface is `/api/fields/*`.
 */
dataRoutes.get(
  '/pipelines',
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.listPipelinesUnguarded(actorFromRequest(req).tenantId));
  }),
);

dataRoutes.get(
  '/option-lists',
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.listOptionListsUnguarded(actorFromRequest(req).tenantId));
  }),
);

dataRoutes.get(
  '/custom-fields',
  asyncHandler(async (req, res) => {
    res.json(await fieldsService.listCustomFieldsUnguarded(actorFromRequest(req).tenantId));
  }),
);

dataRoutes.get(
  '/search',
  asyncHandler(async (req, res) => {
    res.json(
      await searchService.search(
        {
          term: String(req.query.q ?? ''),
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        },
        actorFromRequest(req),
      ),
    );
  }),
);

// --- Parties & products ----------------------------------------------------

dataRoutes.get(
  '/parties',
  asyncHandler(async (req, res) => {
    res.json(await catalogService.listParties(paging(req.query), actorFromRequest(req)));
  }),
);

dataRoutes.post(
  '/parties',
  asyncHandler(async (req, res) => {
    res.status(201).json(await catalogService.createParty(req.body, actorFromRequest(req)));
  }),
);

dataRoutes.put(
  '/parties/:id',
  asyncHandler(async (req, res) => {
    res.json(
      await catalogService.updateParty(String(req.params.id), req.body, actorFromRequest(req)),
    );
  }),
);

dataRoutes.delete(
  '/parties/:id',
  needs('parties.delete'),
  asyncHandler(async (req, res) => {
    res.json(await catalogService.deleteParty(String(req.params.id), actorFromRequest(req)));
  }),
);

dataRoutes.get(
  '/parties/:id/variants',
  asyncHandler(async (req, res) => {
    res.json(
      await catalogService.listVariantsForParty(String(req.params.id), actorFromRequest(req)),
    );
  }),
);

dataRoutes.post(
  '/party-variants',
  asyncHandler(async (req, res) => {
    res.json(await catalogService.upsertVariant(req.body, actorFromRequest(req)));
  }),
);

dataRoutes.get(
  '/products',
  asyncHandler(async (req, res) => {
    res.json(await catalogService.listProducts(paging(req.query), actorFromRequest(req)));
  }),
);

dataRoutes.get(
  '/products/by-code/:code',
  asyncHandler(async (req, res) => {
    const product = await catalogService.findProductByCode(
      String(req.params.code),
      actorFromRequest(req),
    );
    if (!product) {
      res.status(404).json({ error: 'No product with that code' });
      return;
    }
    res.json(product);
  }),
);

dataRoutes.post(
  '/products',
  asyncHandler(async (req, res) => {
    res.status(201).json(await catalogService.createProduct(req.body, actorFromRequest(req)));
  }),
);

dataRoutes.put(
  '/products/:id',
  asyncHandler(async (req, res) => {
    res.json(
      await catalogService.updateProduct(String(req.params.id), req.body, actorFromRequest(req)),
    );
  }),
);

dataRoutes.delete(
  '/products/:id',
  needs('products.delete'),
  asyncHandler(async (req, res) => {
    res.json(await catalogService.deleteProduct(String(req.params.id), actorFromRequest(req)));
  }),
);

dataRoutes.get(
  '/categories',
  asyncHandler(async (req, res) => {
    res.json(await catalogService.listCategories(actorFromRequest(req)));
  }),
);

// --- Inventory -------------------------------------------------------------

dataRoutes.get(
  '/stock',
  asyncHandler(async (req, res) => {
    res.json(
      await inventoryService.listStock(
        { ...paging(req.query), lowOnly: req.query.lowOnly === 'true' },
        actorFromRequest(req),
      ),
    );
  }),
);

dataRoutes.get(
  '/stock/movements',
  asyncHandler(async (req, res) => {
    res.json(
      await inventoryService.listMovements(
        {
          productId: typeof req.query.productId === 'string' ? req.query.productId : undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        },
        actorFromRequest(req),
      ),
    );
  }),
);

dataRoutes.get(
  '/stock/colours/:productId',
  asyncHandler(async (req, res) => {
    const actor = actorFromRequest(req);
    res.json(await inventoryService.coloursFor(actor.tenantId, String(req.params.productId)));
  }),
);

dataRoutes.post(
  '/stock/inbound',
  asyncHandler(async (req, res) => {
    res.json(await inventoryService.recordInbound(req.body, actorFromRequest(req)));
  }),
);

dataRoutes.post(
  '/stock/adjust',
  asyncHandler(async (req, res) => {
    res.json(await inventoryService.recordAdjustment(req.body, actorFromRequest(req)));
  }),
);

dataRoutes.post(
  '/stock/reorder-level',
  asyncHandler(async (req, res) => {
    const { productId, colour, reorderLevel } = req.body ?? {};
    if (typeof productId !== 'string') throw new ValidationError('validation.stock.productRequired');
    if (typeof colour !== 'string') throw new ValidationError('validation.stock.colourSelectRequired');

    const level = reorderLevel === null || reorderLevel === '' ? null : Number(reorderLevel);
    res.json(
      await inventoryService.setReorderLevel(
        { productId, colour, reorderLevel: level },
        actorFromRequest(req),
      ),
    );
  }),
);

// --- Leads (read and progress only — creation is the Office Panel's job) ---

dataRoutes.get(
  '/leads',
  asyncHandler(async (req, res) => {
    res.json(
      await leadService.listLeads(
        {
          ...paging(req.query),
          stageIds: idList(req.query.stageIds),
          includeConverted: req.query.includeConverted === 'true',
          followUpDueOnly: req.query.followUpDueOnly === 'true',
        },
        actorFromRequest(req),
      ),
    );
  }),
);

dataRoutes.get(
  '/leads/:id',
  asyncHandler(async (req, res) => {
    res.json(await leadService.getLead(String(req.params.id), actorFromRequest(req)));
  }),
);

dataRoutes.post(
  '/leads/:id/stage',
  asyncHandler(async (req, res) => {
    const stageId = req.body?.stageId;
    if (typeof stageId !== 'string') throw new ValidationError('validation.stage.required');

    res.json(
      await leadService.setStage(
        { id: String(req.params.id), stageId, remark: req.body?.remark ?? null },
        actorFromRequest(req),
      ),
    );
  }),
);

dataRoutes.post(
  '/leads/:id/remarks',
  asyncHandler(async (req, res) => {
    res.json(
      await leadService.addRemark(
        { id: String(req.params.id), message: String(req.body?.message ?? '') },
        actorFromRequest(req),
      ),
    );
  }),
);

dataRoutes.delete(
  '/leads/:id',
  needs('leads.delete'),
  asyncHandler(async (req, res) => {
    res.json(await leadService.deleteLead(String(req.params.id), actorFromRequest(req)));
  }),
);

dataRoutes.post(
  '/leads/:id/convert',
  asyncHandler(async (req, res) => {
    res.status(201).json(
      await orderService.convertLead(
        {
          leadId: String(req.params.id),
          dispatchAddressLabel: req.body?.dispatchAddressLabel ?? null,
          expectedDispatchDate: req.body?.expectedDispatchDate ?? null,
        },
        actorFromRequest(req),
      ),
    );
  }),
);

// --- Orders ----------------------------------------------------------------

dataRoutes.get(
  '/orders',
  asyncHandler(async (req, res) => {
    res.json(
      await orderService.listOrders(
        { ...paging(req.query), stageIds: idList(req.query.stageIds) },
        actorFromRequest(req),
      ),
    );
  }),
);

dataRoutes.get(
  '/orders/:id',
  asyncHandler(async (req, res) => {
    res.json(await orderService.getOrder(String(req.params.id), actorFromRequest(req)));
  }),
);

dataRoutes.put(
  '/orders/:id',
  asyncHandler(async (req, res) => {
    res.json(
      await orderService.updateOrder(String(req.params.id), req.body, actorFromRequest(req)),
    );
  }),
);

dataRoutes.post(
  '/orders/:id/stage',
  asyncHandler(async (req, res) => {
    const stageId = req.body?.stageId;
    if (typeof stageId !== 'string') throw new ValidationError('validation.stage.required');

    res.json(
      await orderService.setStage(
        { id: String(req.params.id), stageId, remark: req.body?.remark ?? null },
        actorFromRequest(req),
      ),
    );
  }),
);

dataRoutes.post(
  '/orders/:id/dispatch',
  asyncHandler(async (req, res) => {
    res.json(
      await orderService.dispatchOrder(
        { orderId: String(req.params.id), note: req.body?.note ?? null },
        actorFromRequest(req),
      ),
    );
  }),
);

dataRoutes.delete(
  '/orders/:id',
  needs('orders.delete'),
  asyncHandler(async (req, res) => {
    res.json(await orderService.deleteOrder(String(req.params.id), actorFromRequest(req)));
  }),
);

// --- Sync conflicts --------------------------------------------------------

dataRoutes.get(
  '/conflicts',
  asyncHandler(async (req, res) => {
    res.json(
      await conflictService.listConflicts(actorFromRequest(req), {
        includeResolved: req.query.includeResolved === 'true',
      }),
    );
  }),
);

dataRoutes.post(
  '/conflicts/:id/resolve',
  asyncHandler(async (req, res) => {
    const action = req.body?.action;
    if (action !== 'keepWinner' && action !== 'restoreLoser') {
      throw new ValidationError('validation.conflict.actionRequired');
    }

    res.json(
      await conflictService.resolveConflict(
        { conflictId: Number(req.params.id), action },
        actorFromRequest(req),
      ),
    );
  }),
);
