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

import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import {
  MAX_PARTY_IMPORT_BYTES,
  MAX_PRODUCT_IMPORT_BYTES,
  MAX_PRODUCT_ZIP_BYTES,
  type MessageKey,
} from '@orderbook/shared';

import { config } from '../../config/index.js';
import { ValidationError } from '../../lib/errors.js';
import * as partyImportService from '../../services/party-import.service.js';
import * as productImportService from '../../services/product-import.service.js';
import * as productZipService from '../../services/product-zip.service.js';
import { asyncHandler } from '../async-handler.js';
import { panelActorFromRequest } from '../middleware/require-panel.js';
import { requirePermission, type ActorContext } from '../../domain/actor.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PRODUCT_IMPORT_BYTES },
});

const partyUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PARTY_IMPORT_BYTES },
});

/**
 * The product backup zip carries every photo, so it is written to the data
 * folder's `tmp` as it arrives, never held in memory. Whoever handles it
 * deletes it: the preview when it answers, the restore job when it ends.
 */
const zipUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, done) => {
      const dir = path.join(config.dataDir, 'tmp');
      mkdir(dir, { recursive: true }).then(
        () => done(null, dir),
        (error: Error) => done(error, dir),
      );
    },
  }),
  limits: { fileSize: MAX_PRODUCT_ZIP_BYTES },
});

/** The file, or — for one past the size ceiling — the import's own named refusal, not a generic 400. */
function uploader(single: ReturnType<typeof multer>, tooLarge: MessageKey = 'validation.import.tooLarge') {
  return (req: Request, res: Response, next: NextFunction): void => {
    single.single('file')(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        next(new ValidationError(tooLarge));
        return;
      }
      next(error);
    });
  };
}

const uploadFile = uploader(upload);
const uploadPartyFile = uploader(partyUpload);
const uploadZip = uploader(zipUpload, 'validation.productZip.tooLarge');

/**
 * The import handlers, parameterised on who is acting: a paired Office panel
 * (`panelActorFromRequest`, behind `requirePanel`) or a signed-in Master user
 * (`actorFromRequest`, behind the session guard on `dataRoutes`). The service
 * checks `products.bulk` / `.create` / `.edit` against that actor either way.
 *
 * `zip` adds the product backup zip — `export.zip`, and the restore with its
 * job — for the Master's own users only. The Office's proxy buffers a download
 * whole, and a restore is minutes of photo encoding behind a progress bar the
 * Office has no screen for, so a paired panel is not offered either.
 */
export function productImportRoutes(
  actorOf: (req: Request) => ActorContext,
  options: { zip?: boolean } = {},
): Router {
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
      if (format === 'zip' && options.zip) {
        // Streamed from the file the service wrote, then deleted, however the response ends.
        const file = await productZipService.exportProductZip(actorOf(req));
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
        const stream = createReadStream(file.filePath);
        res.on('close', () => {
          stream.destroy();
          void rm(file.filePath, { force: true });
        });
        stream.on('error', (error) => res.destroy(error));
        stream.pipe(res);
        return;
      }
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

  if (!options.zip) return routes;

  /**
   * The zip, as a dry run (the preview) or the real run (202 and the job's
   * first status; `GET /products/restore/job` follows it). The opt-ins ride as
   * form fields, `true` or absent.
   */
  routes.post(
    '/products/restore',
    uploadZip,
    asyncHandler(async (req, res) => {
      if (!req.file) throw new ValidationError('validation.productZip.fileRequired');
      const { path: filePath, originalname } = req.file;
      const fileName = originalname || 'products.zip';
      const body = (req.body ?? {}) as Record<string, unknown>;

      if (String(body.dryRun ?? '') === 'true') {
        try {
          res.json(await productZipService.previewProductZip(filePath, fileName, actorOf(req)));
        } finally {
          await rm(filePath, { force: true });
        }
        return;
      }

      try {
        const status = productZipService.startProductRestore(
          filePath,
          fileName,
          {
            binMissingProducts: String(body.binMissingProducts ?? '') === 'true',
            removeMissingPhotos: String(body.removeMissingPhotos ?? '') === 'true',
            exactCatalogue: String(body.exactCatalogue ?? '') === 'true',
          },
          actorOf(req),
        );
        res.status(202).json(status);
      } catch (error) {
        await rm(filePath, { force: true });
        throw error;
      }
    }),
  );

  routes.get('/products/restore/job', (req, res) => {
    requirePermission(actorOf(req), 'products.bulk');
    res.json(productZipService.productRestoreJob());
  });

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
