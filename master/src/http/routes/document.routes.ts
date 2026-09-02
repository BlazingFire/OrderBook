/**
 * `/api/documents` (`docs/backend-modules/04-API-CONTRACT.md` §6). Same shape
 * as `access.routes.ts`: `requireAuth` mounted once, then a per-handler
 * permission guard with **zero** exemptions.
 *
 * The route guard is the second gate, not the only one — the socket path runs
 * no Express middleware at all, so every service function re-checks the same
 * key. Handlers parse and delegate; no business rule lives here.
 *
 * `/render` and `/preview` guard only `documents.render` at this layer. The
 * subject's own view key depends on the request *body*, which middleware
 * cannot see, so the service checks it — and must, or `documents.render`
 * becomes a way to read a lead you may not open.
 */

import { Router, type Response } from 'express';

import type { DocumentType } from '@orderbook/shared';
import { isDocumentType } from '@orderbook/shared';

import * as documentService from '../../services/document.service.js';
import * as renderService from '../../services/document-render.service.js';
import { asyncHandler } from '../async-handler.js';
import {
  actorFromRequest,
  requireAuth,
  requirePermissionMiddleware,
} from '../middleware/require-auth.js';

export const documentRoutes: Router = Router();

documentRoutes.use(requireAuth);

const needs = requirePermissionMiddleware;

function parseDocumentType(value: unknown): DocumentType | undefined {
  return typeof value === 'string' && isDocumentType(value) ? value : undefined;
}

function parseLimit(value: unknown): number | undefined {
  return typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined;
}

function sendFile(
  res: Response,
  file: { fileName: string; contentType: string; bytes: Uint8Array },
  disposition: 'inline' | 'attachment',
): void {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `${disposition}; filename="${file.fileName}"`);
  res.send(Buffer.from(file.bytes));
}

// --- Templates -------------------------------------------------------------

documentRoutes.get(
  '/templates',
  needs('documents.view'),
  asyncHandler(async (req, res) => {
    res.json(
      await documentService.listTemplates(
        {
          documentType: parseDocumentType(req.query.documentType),
          cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
          limit: parseLimit(req.query.limit),
        },
        actorFromRequest(req),
      ),
    );
  }),
);

documentRoutes.get(
  '/templates/:id',
  needs('documents.view'),
  asyncHandler(async (req, res) => {
    res.json(await documentService.getTemplate(req.params.id!, actorFromRequest(req)));
  }),
);

documentRoutes.post(
  '/templates',
  needs('documents.create'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await documentService.createTemplate(req.body, actorFromRequest(req)));
  }),
);

documentRoutes.put(
  '/templates/:id',
  needs('documents.edit'),
  asyncHandler(async (req, res) => {
    res.json(
      await documentService.updateTemplate(req.params.id!, req.body, actorFromRequest(req)),
    );
  }),
);

documentRoutes.delete(
  '/templates/:id',
  needs('documents.delete'),
  asyncHandler(async (req, res) => {
    res.json(
      await documentService.deleteTemplate(
        req.params.id!,
        req.body?.expectedVersion,
        actorFromRequest(req),
      ),
    );
  }),
);

// Restore reuses the delete key — no restore key is minted anywhere.
documentRoutes.post(
  '/templates/:id/restore',
  needs('documents.delete'),
  asyncHandler(async (req, res) => {
    res.json(await documentService.restoreTemplate(req.params.id!, actorFromRequest(req)));
  }),
);

// --- Assets ----------------------------------------------------------------

documentRoutes.get(
  '/assets',
  needs('documents.view'),
  asyncHandler(async (req, res) => {
    res.json(await documentService.listAssets(actorFromRequest(req)));
  }),
);

documentRoutes.post(
  '/assets',
  needs('documents.edit'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await documentService.uploadAsset(req.body, actorFromRequest(req)));
  }),
);

documentRoutes.get(
  '/assets/:id/file',
  needs('documents.view'),
  asyncHandler(async (req, res) => {
    const file = await renderService.fetchAssetFile(req.params.id!, actorFromRequest(req));
    sendFile(res, file, 'inline');
  }),
);

documentRoutes.delete(
  '/assets/:id',
  needs('documents.edit'),
  asyncHandler(async (req, res) => {
    res.json(await documentService.deleteAsset(req.params.id!, actorFromRequest(req)));
  }),
);

// --- Rendering -------------------------------------------------------------

documentRoutes.post(
  '/render',
  needs('documents.render'),
  asyncHandler(async (req, res) => {
    res.json(await renderService.renderDocument(req.body, actorFromRequest(req)));
  }),
);

documentRoutes.post(
  '/preview',
  needs('documents.render'),
  asyncHandler(async (req, res) => {
    const file = await renderService.previewDocument(req.body, actorFromRequest(req));
    sendFile(res, file, 'inline');
  }),
);

// --- Export history --------------------------------------------------------

documentRoutes.get(
  '/exports',
  needs('documents.view'),
  asyncHandler(async (req, res) => {
    res.json(
      await renderService.listExports(
        {
          subjectKind:
            req.query.subjectKind === 'lead' || req.query.subjectKind === 'order'
              ? req.query.subjectKind
              : undefined,
          subjectId: typeof req.query.subjectId === 'string' ? req.query.subjectId : undefined,
          cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
          limit: parseLimit(req.query.limit),
        },
        actorFromRequest(req),
      ),
    );
  }),
);

documentRoutes.get(
  '/exports/:id',
  needs('documents.view'),
  asyncHandler(async (req, res) => {
    res.json(await renderService.getExport(req.params.id!, actorFromRequest(req)));
  }),
);

// Served here rather than from `/uploads`, which is unauthenticated static.
// The path is resolved from config plus the stored key, never from the URL.
documentRoutes.get(
  '/exports/:id/file',
  needs('documents.view'),
  asyncHandler(async (req, res) => {
    const file = await renderService.fetchExportFile(req.params.id!, actorFromRequest(req));
    sendFile(res, file, 'attachment');
  }),
);
