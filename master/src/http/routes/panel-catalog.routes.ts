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
import {
  MAX_PARTY_IMPORT_BYTES,
  type MessageKey,
} from '@orderbook/shared';

import { ValidationError } from '../../lib/errors.js';
import * as partyImportService from '../../services/party-import.service.js';
import { asyncHandler } from '../async-handler.js';
import { panelActorFromRequest } from '../middleware/require-panel.js';
import type { ActorContext } from '../../domain/actor.js';

const partyUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PARTY_IMPORT_BYTES },
});

/** The file, or — for one past the size ceiling — the import's own named refusal, not a generic 400. */
function uploader(
  single: ReturnType<typeof multer>,
  tooLarge: MessageKey = 'validation.import.tooLarge',
) {
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

const uploadPartyFile = uploader(partyUpload);

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
    if (value !== 'csv' && value !== 'xlsx')
      throw new ValidationError('validation.import.unsupportedFormat');
    return value;
  };
  const send = (
    res: Response,
    file: { bytes: Buffer; contentType: string; fileName: string },
  ): void => {
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.bytes);
  };

  routes.get(
    '/parties/import/template.:format',
    asyncHandler(async (req, res) => {
      send(
        res,
        await partyImportService.partyImportTemplate(formatOf(req.params.format), actorOf(req)),
      );
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
panelCatalogRoutes.use(partyImportRoutes(panelActorFromRequest));
