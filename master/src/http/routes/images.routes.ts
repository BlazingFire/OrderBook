/**
 * Product images (`7-IMAGE-PIPELINE.md`).
 *
 * Two routers: `imagesRoutes` (mounted at `/api/products/:productId/images`)
 * for the write surface, and `imageFilesRoutes` (mounted at `/api/images`)
 * for the permission-gated variant stream an `<img>` tag points at. The
 * latter carries **no** `requirePermissionMiddleware` — §4.3 asks for a 404,
 * not a 403, when the caller cannot see the product, and that translation
 * happens inside `image.service.ts#resolveImageFile`, not at the route gate.
 */

import { Router } from 'express';
import multer from 'multer';

import { MAX_SOURCE_BYTES } from '../../domain/images.js';
import { ValidationError } from '../../lib/errors.js';
import * as imageService from '../../services/image.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';

const needs = requirePermissionMiddleware;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SOURCE_BYTES } });

export const imagesRoutes: Router = Router({ mergeParams: true });

imagesRoutes.use(requireAuth);

imagesRoutes.post(
  '/',
  needs('products.edit'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const productId = String(req.params.productId);
    if (!req.file) throw new ValidationError('validation.image.fileRequired');
    // No crop at all is the whole picture (the bulk photo import); a partial
    // crop is still refused by the rect check, as before.
    const wholeFrame = ['cropX', 'cropY', 'cropWidth', 'cropHeight'].every((key) => req.body[key] === undefined);

    const product = await imageService.uploadImage(
      {
        productId,
        fileBuffer: req.file.buffer,
        crop: {
          cropX: Number(req.body.cropX),
          cropY: Number(req.body.cropY),
          cropWidth: Number(req.body.cropWidth),
          cropHeight: Number(req.body.cropHeight),
          rotationDeg: Number(req.body.rotationDeg ?? 0),
          caption: typeof req.body.caption === 'string' ? req.body.caption : null,
        },
        wholeFrame,
      },
      actorFromRequest(req),
    );
    res.status(201).json(product);
  }),
);

imagesRoutes.patch(
  '/:imageId',
  needs('products.edit'),
  asyncHandler(async (req, res) => {
    res.json(await imageService.updateImageCaption(String(req.params.imageId), req.body, actorFromRequest(req)));
  }),
);

imagesRoutes.post(
  '/reorder',
  needs('products.edit'),
  asyncHandler(async (req, res) => {
    const productId = String(req.params.productId);
    res.json(
      await imageService.reorderImages({ productId, ids: req.body.ids ?? [] }, actorFromRequest(req)),
    );
  }),
);

imagesRoutes.delete(
  '/:imageId',
  needs('products.edit'),
  asyncHandler(async (req, res) => {
    res.json(await imageService.deleteImage(String(req.params.imageId), actorFromRequest(req)));
  }),
);

export const imageFilesRoutes: Router = Router();

imageFilesRoutes.use(requireAuth);

imageFilesRoutes.get(
  '/:imageId/:variant',
  asyncHandler(async (req, res, next) => {
    const file = await imageService.resolveImageFile(
      String(req.params.imageId),
      String(req.params.variant),
      actorFromRequest(req),
    );

    // The checksum never changes for an existing file, so a long-lived cache
    // is safe — this is what makes a repeat view of the same image free.
    res.set('ETag', `"${file.checksum}"`);
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('image/webp');
    res.sendFile(file.path, (error) => {
      if (error) next(error);
    });
  }),
);
