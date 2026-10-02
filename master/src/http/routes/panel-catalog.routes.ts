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

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { MAX_PARTY_IMPORT_BYTES, MAX_PRODUCT_IMPORT_BYTES } from '@orderbook/shared';

import { ValidationError } from '../../lib/errors.js';
import * as partyImportService from '../../services/party-import.service.js';
import * as productImportService from '../../services/product-import.service.js';
import { asyncHandler } from '../async-handler.js';
import { panelActorFromRequest } from '../middleware/require-panel.js';
import type { ActorContext } from '../../domain/actor.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PRODUCT_IMPORT_BYTES },
});

const partyUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PARTY_IMPORT_BYTES },
});

/** The file, or — for one past the size ceiling — the import's own named refusal, not a generic 400. */
function uploader(single: ReturnType<typeof multer>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    single.single('file')(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        next(new ValidationError('validation.import.tooLarge'));
        return;
      }
      next(error);
    });
  };
}

const uploadFile = uploader(upload);
const uploadPartyFile = uploader(partyUpload);

/**
 * The import handlers, parameterised on who is acting: a paired Office panel
 * (`panelActorFromRequest`, behind `requirePanel`) or a signed-in Master user
 * (`actorFromRequest`, behind the session guard on `dataRoutes`). The service
 * checks `products.bulk` / `.create` / `.edit` against that actor either way.
 */
export function productImportRoutes(actorOf: (req: Request) => ActorContext): Router {
  const routes: Router = Router();

  routes.get(
    '/products/import/template.:format',
    asyncHandler(async (req, res) => {
      const format = String(req.params.format);
      if (format !== 'csv' && format !== 'xlsx') {
        throw new ValidationError('validation.import.unsupportedFormat');
      }

      const file = await productImportService.productImportTemplate(format, actorOf(req));

      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
      res.send(file.bytes);
    }),
  );

  routes.get(
    '/products/export.:format',
    asyncHandler(async (req, res) => {
      const format = String(req.params.format);
      if (format !== 'csv' && format !== 'xlsx') {
        throw new ValidationError('validation.import.unsupportedFormat');
      }

      const file = await productImportService.exportProducts(
        format,
        actorOf(req),
        req.query.level === 'main' ? 'main' : 'sub',
      );

      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
      res.send(file.bytes);
    }),
  );

  routes.post(
    '/products/import',
    uploadFile,
    asyncHandler(async (req, res) => {
      if (!req.file) throw new ValidationError('validation.import.fileRequired');

      const body = (req.body ?? {}) as Record<string, unknown>;
      const dryRun = String(body.dryRun ?? '') === 'true';
      const mode = body.mode === 'upsert' ? 'upsert' : 'create';

      res.json(
        await productImportService.importProducts(
          { buffer: req.file.buffer, fileName: req.file.originalname || 'products.csv' },
          { dryRun, mode },
          actorOf(req),
        ),
      );
    }),
  );

  return routes;
}

/**
 * The party import handlers, parameterised on who is acting like
 * `productImportRoutes`. The service checks `parties.bulk` (import, template)
 * and `parties.view` (export) against that actor, and Party Access per row.
 *
 * Mounted **before** `/parties/:id`: `export.csv` would otherwise be read as an id.
 */
export function partyImportRoutes(actorOf: (req: Request) => ActorContext): Router {
  const routes: Router = Router();

  const formatOf = (value: unknown): 'csv' | 'xlsx' => {
    if (value !== 'csv' && value !== 'xlsx') throw new ValidationError('validation.import.unsupportedFormat');
    return value;
  };
  const send = (res: Response, file: { bytes: Buffer; contentType: string; fileName: string }): void => {
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.bytes);
  };

  routes.get(
    '/parties/import/template.:format',
    asyncHandler(async (req, res) => {
      send(res, await partyImportService.partyImportTemplate(formatOf(req.params.format), actorOf(req)));
    }),
  );

  routes.get(
    '/parties/export.:format',
    asyncHandler(async (req, res) => {
      send(res, await partyImportService.exportParties(formatOf(req.params.format), actorOf(req)));
    }),
  );

  routes.post(
    '/parties/import',
    uploadPartyFile,
    asyncHandler(async (req, res) => {
      if (!req.file) throw new ValidationError('validation.import.fileRequired');

      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(
        await partyImportService.importParties(
          { buffer: req.file.buffer, fileName: req.file.originalname || 'parties.csv' },
          {
            dryRun: String(body.dryRun ?? '') === 'true',
            mode: body.mode === 'updateByCode' ? 'updateByCode' : 'create',
          },
          actorOf(req),
        ),
      );
    }),
  );

  return routes;
}

export const panelCatalogRoutes: Router = Router();
panelCatalogRoutes.use(productImportRoutes(panelActorFromRequest));
panelCatalogRoutes.use(partyImportRoutes(panelActorFromRequest));
