/**
 * Bulk product import, for an Office Panel's server, over HTTP.
 *
 * Beside `panel-image.routes.ts` for the same reason it exists: a spreadsheet
 * is a file, the command socket's frame ceiling is sized for mutations, and
 * the offline outbox cannot carry multipart. `requirePanel` — run once by
 * `app.ts` in front of both routers on the prefix — establishes both the paired
 * machine and the person acting on it, so `products.bulk` is checked against
 * the person and the audit trail names them.
 */

import { Router } from 'express';
import multer from 'multer';
import { MAX_PRODUCT_IMPORT_BYTES } from '@orderbook/shared';

import { ValidationError } from '../../lib/errors.js';
import * as productImportService from '../../services/product-import.service.js';
import { asyncHandler } from '../async-handler.js';
import { panelActorFromRequest } from '../middleware/require-panel.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PRODUCT_IMPORT_BYTES },
});

export const panelCatalogRoutes: Router = Router();

panelCatalogRoutes.get(
  '/products/import/template.:format',
  asyncHandler(async (req, res) => {
    const format = String(req.params.format);
    if (format !== 'csv' && format !== 'xlsx') {
      throw new ValidationError('validation.import.unsupportedFormat');
    }

    const file = await productImportService.productImportTemplate(format, panelActorFromRequest(req));

    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.bytes);
  }),
);

panelCatalogRoutes.post(
  '/products/import',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError('validation.import.fileRequired');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const dryRun = String(body.dryRun ?? '') === 'true';
    const mode = body.mode === 'upsert' ? 'upsert' : 'create';

    res.json(
      await productImportService.importProducts(
        { buffer: req.file.buffer, fileName: req.file.originalname || 'products.csv' },
        { dryRun, mode },
        panelActorFromRequest(req),
      ),
    );
  }),
);
