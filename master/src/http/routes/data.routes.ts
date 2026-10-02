/**
 * The Master Panel's own UI reads and writes through these endpoints. Office
 * Panels use the Socket.IO commands instead — both funnel into the same
 * services, so behaviour cannot diverge between the two panels.
 */

import { Router } from 'express';
import multer from 'multer';
import { isPickKind } from '@orderbook/shared';

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
import * as snapshotService from '../../services/snapshot.service.js';
import * as storageService from '../../services/storage.service.js';
import { asyncHandler } from '../async-handler.js';
import { idList, paging } from '../query.js';
import { partyImportRoutes, productImportRoutes } from './panel-catalog.routes.js';
import {
  actorFromRequest,
  requireAuth,
  requirePermissionMiddleware,
} from '../middleware/require-auth.js';

export const dataRoutes: Router = Router();

dataRoutes.use(requireAuth);

/**
 * A route-level permission guard, for the handlers on this router that carry
 * one. The rest rely on the service-layer check, or are deliberately ungated
 * and say so where they are declared — the two reference reads below
 * (`/pipelines`, `/option-lists`), whose services check nothing. The Recycle Bin's four DELETE routes were the first guarded here:
 * `leads.delete` / `orders.delete` /
 * `parties.delete` / `products.delete` have been in the frozen catalogue and
 * in stored role rows since `20260303`, and were enforced nowhere because no
 * delete path existed for any of the four until then. The storage routes
 * below are guarded here and nowhere else — their services take no actor.
 */
const needs = requirePermissionMiddleware;

/**
 * Buffers the whole uploaded backup file in memory before decrypting it — the
 * same tradeoff `images.routes.ts`'s upload makes, accepted here for the same
 * reason: this product's scale is one shop's database, not a multi-gigabyte
 * one. A future increase in scale would want to stream this instead.
 */
const backupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 },
});

// --- Overview --------------------------------------------------------------

dataRoutes.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    res.json(await dashboardService.getDashboardSummary(actorFromRequest(req)));
  }),
);

/**
 * The figures on Settings › Storage: how big the database and the uploads are,
 * and how much disk the Master PC has left.
 *
 * `settings.manage`, because that is what the Settings nav entry is shown
 * under (`master/web/src/App.tsx`), and the screen reads them only for a
 * session holding it. This used to check nothing past the session, so anybody
 * signed in could read them; how full the one machine holding every record is
 * getting is the administrator's business. Export and restore stay on
 * `storage.manage`.
 */
dataRoutes.get(
  '/storage',
  needs('settings.manage'),
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

    const result = await backupExportService.exportBackup(
      {
        scope,
        tenantIds: Array.isArray(tenantIds) ? tenantIds.map(String) : undefined,
        passphrase,
      },
      actorFromRequest(req),
    );

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

    res.json(
      await backupRestoreService.restoreBackup(req.file.buffer, passphrase, confirmWipe, actorFromRequest(req)),
    );
  }),
);

/**
 * Deliberately ungated — `fieldsService.listPipelinesUnguarded` and its
 * sibling below check nothing. They feed the Add Lead form and
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

/**
 * The searchable picker's endpoint.
 *
 * Separate from `/search` because it answers a different question: search says
 * where a word appears across four indexes, a pick says which record you mean
 * for one kind and hands back the whole row, because the thing chosen goes
 * straight into a line or a form.
 *
 * `include` carries the ids that must come back whatever the term matches —
 * the row already selected, and anything pinned — so a picker never blanks a
 * selection the moment somebody types.
 */
dataRoutes.get(
  '/pick/:kind',
  asyncHandler(async (req, res) => {
    const kind = String(req.params.kind);
    if (!isPickKind(kind)) throw new ValidationError('validation.pick.unknownKind');

    const include = String(req.query.include ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    res.json(
      await searchService.pick(
        kind,
        {
          term: String(req.query.q ?? ''),
          limit: req.query.limit ? Number(req.query.limit) : undefined,
          include,
          // The lead screen's second stage: products inside the chosen category.
          categoryId: typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined,
        },
        actorFromRequest(req),
      ),
    );
  }),
);

// --- Parties & products ----------------------------------------------------

// Party import and export, ahead of `/parties/:id` so `export.csv` is not read
// as an id; the service checks `parties.bulk` / `parties.view`.
dataRoutes.use(partyImportRoutes(actorFromRequest));

dataRoutes.get(
  '/parties',
  asyncHandler(async (req, res) => {
    res.json(await catalogService.listPartiesWithMeta(paging(req.query), actorFromRequest(req)));
  }),
);

dataRoutes.get(
  '/parties/:id',
  asyncHandler(async (req, res) => {
    res.json(
      await catalogService.getPartyWithAccess(String(req.params.id), actorFromRequest(req)),
    );
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
      await catalogService.listPartyRecords(String(req.params.id), actorFromRequest(req)),
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
    res.json(
      await catalogService.listProducts(
        {
          ...paging(req.query),
          categoryId: typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined,
          brand:
            typeof req.query.brand === 'string' && req.query.brand ? req.query.brand : undefined,
          missingWeight: req.query.missingWeight === 'true',
        },
        actorFromRequest(req),
      ),
    );
  }),
);

// Bulk import for a signed-in user — the same handlers the paired-panel path
// uses (`panel-catalog.routes.ts`); the service checks `products.bulk`.
dataRoutes.use(productImportRoutes(actorFromRequest));

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

// Categories — the owner's Products (`docs/catalogue/CATALOGUE_MODEL.md` §5).
// Permissions are the service's, as for `/products`; delete is guarded here
// too, like every other Recycle Bin delete on this router.

dataRoutes.get(
  '/categories',
  asyncHandler(async (req, res) => {
    res.json(
      await catalogService.listCategories(actorFromRequest(req), {
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        brand: typeof req.query.brand === 'string' && req.query.brand ? req.query.brand : undefined,
      }),
    );
  }),
);

dataRoutes.post(
  '/categories',
  asyncHandler(async (req, res) => {
    res.status(201).json(await catalogService.createCategory(req.body, actorFromRequest(req)));
  }),
);

dataRoutes.put(
  '/categories/:id',
  asyncHandler(async (req, res) => {
    res.json(
      await catalogService.updateCategory(String(req.params.id), req.body, actorFromRequest(req)),
    );
  }),
);

dataRoutes.delete(
  '/categories/:id',
  needs('products.delete'),
  asyncHandler(async (req, res) => {
    res.json(await catalogService.deleteCategory(String(req.params.id), actorFromRequest(req)));
  }),
);

// --- Inventory -------------------------------------------------------------

dataRoutes.get(
  '/stock',
  asyncHandler(async (req, res) => {
    res.json(
      await inventoryService.listStock(
        {
          ...paging(req.query),
          lowOnly: req.query.lowOnly === 'true',
          brand: typeof req.query.brand === 'string' ? req.query.brand : undefined,
          categoryId: typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined,
        },
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
          variantId: typeof req.query.variantId === 'string' ? req.query.variantId : undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        },
        actorFromRequest(req),
      ),
    );
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
    const { variantId } = req.body ?? {};
    if (typeof variantId !== 'string' || !variantId)
      throw new ValidationError('validation.stock.variantRequired');

    /*
     * Three distinct meanings, and the route has to keep them apart:
     * **absent** is "leave it alone", **empty string or null** is "clear it",
     * and a number is a number. Collapsing the first two would make the
     * existing reorder-level screen wipe the min and max every time it saved.
     */
    const level = (value: unknown): number | null | undefined => {
      if (value === undefined) return undefined;
      if (value === null || value === '') return null;
      return Number(value);
    };

    const body = req.body as Record<string, unknown>;

    res.json(
      await inventoryService.setReorderLevel(
        {
          variantId,
          reorderLevel: level(body.reorderLevel),
          minStockLevel: level(body.minStockLevel),
          maxStockLevel: level(body.maxStockLevel),
        },
        actorFromRequest(req),
      ),
    );
  }),
);

// --- Leads -----------------------------------------------------------------

dataRoutes.post(
  '/leads',
  needs('leads.create'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await leadService.createLead(req.body, actorFromRequest(req)));
  }),
);

dataRoutes.put(
  '/leads/:id',
  needs('leads.edit'),
  asyncHandler(async (req, res) => {
    res.json(await leadService.updateLead(String(req.params.id), req.body ?? {}, actorFromRequest(req)));
  }),
);

/**
 * What the New / Edit pending order form needs that no list route gives it —
 * the Master's stand-in for the Office's local snapshot. Its own path, not
 * `/leads/…`, so `GET /leads/:id` cannot capture it.
 */
dataRoutes.get(
  '/lead-entry',
  asyncHandler(async (req, res) => {
    res.json(await snapshotService.buildLeadEntryView(actorFromRequest(req)));
  }),
);

dataRoutes.get(
  '/leads',
  asyncHandler(async (req, res) => {
    res.json(
      await leadService.listLeads(
        {
          ...paging(req.query),
          stageIds: idList(req.query.stageIds),
          includeConverted: req.query.includeConverted === 'true',
          convertedOnly: req.query.convertedOnly === 'true',
          partyId: typeof req.query.partyId === 'string' && req.query.partyId ? req.query.partyId : undefined,
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

/**
 * The fixed-layout lead PDF (`docs/catalogue/CATALOGUE_MODEL.md` §8), sent
 * `inline` so Preview PDF opens it in a window rather than downloading it.
 */
dataRoutes.get(
  '/leads/:id/pdf',
  needs('leads.export'),
  asyncHandler(async (req, res) => {
    const { fileName, bytes } = await leadService.leadPdf(
      String(req.params.id),
      actorFromRequest(req),
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.send(Buffer.from(bytes));
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
