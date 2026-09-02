/**
 * Product image bytes, for an Office Panel's server, over HTTP.
 *
 * These two routes exist so image traffic stops riding the Socket.IO command
 * channel. `maxHttpBufferSize` had to be **60 MB** for `product:image:upload`
 * to fit, which is a ceiling on every inbound frame on that socket — a limit
 * set by the largest photo anybody might drag in, applied to every sync push
 * and every command. Moving the bytes here lets that drop to 4 MB, which is
 * what the command channel actually needs: `flush` batches at a hundred
 * mutations and an asset upload is capped at 512 KB.
 *
 * They are `/api/panel/...` rather than additions to `images.routes.ts` because
 * the authentication is different in kind: a browser presents a session cookie,
 * a panel presents its pairing credentials **plus** the token of whoever is
 * signed in on it. `requirePanel` establishes both, and the services below then
 * see exactly the actor the socket path gave them, so the permission checks and
 * the audit trail are unchanged.
 */

import { Router } from 'express';
import multer from 'multer';

import { MAX_SOURCE_BYTES } from '../../domain/images.js';
import * as avatarService from '../../services/avatar.service.js';
import * as imageService from '../../services/image.service.js';
import { asyncHandler } from '../async-handler.js';
import { panelActorFromRequest, requirePanel } from '../middleware/require-panel.js';

// The same memory storage and ceiling `images.routes.ts` uses: the pipeline
// wants one buffer, and a temp file would only add a path to clean up.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SOURCE_BYTES } });

export const panelImageRoutes: Router = Router();

panelImageRoutes.use(requirePanel);

panelImageRoutes.post(
  '/products/:productId/images',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'validation_error', message: 'Choose an image file' });
      return;
    }

    const product = await imageService.uploadImage(
      {
        productId: String(req.params.productId),
        fileBuffer: req.file.buffer,
        crop: {
          cropX: Number(req.body.cropX),
          cropY: Number(req.body.cropY),
          cropWidth: Number(req.body.cropWidth),
          cropHeight: Number(req.body.cropHeight),
          rotationDeg: Number(req.body.rotationDeg ?? 0),
          caption: typeof req.body.caption === 'string' ? req.body.caption : null,
        },
      },
      panelActorFromRequest(req),
    );

    res.status(201).json(product);
  }),
);

/**
 * One already-derived variant, for the panel's own on-disk cache.
 *
 * No permission middleware, deliberately: `resolveImageFile` answers 404 rather
 * than 403 for a caller who may not see the product, which is the behaviour
 * `7-IMAGE-PIPELINE.md` §4.3 asks for and which a route-level gate cannot
 * express.
 */
/**
 * A profile picture, for the panel's own sign-in screen.
 *
 * Fetched once, at the moment somebody signs in on that panel, and cached
 * there — because the screen that needs it renders with **nobody signed in**
 * and the Master often switched off, which is exactly when neither this route
 * nor `avatarFilesRoutes` can be called.
 *
 * No permission check beyond `requirePanel`'s: the caller is a paired panel
 * acting for a signed-in person, and a face is already on every screen that
 * person can open. `avatarFilePath` returns null for a variant that does not
 * exist, which is the only untrusted half of the path.
 */
panelImageRoutes.get(
  '/avatars/:avatarId/:variant',
  asyncHandler(async (req, res, next) => {
    const actor = panelActorFromRequest(req);
    const file = avatarService.avatarFilePath(
      actor.tenantId,
      String(req.params.avatarId),
      String(req.params.variant),
    );

    if (!file) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // The id is minted per upload and never reused, so the bytes behind a URL
    // can never change — the same reasoning `avatarFilesRoutes` gives.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('image/webp');
    res.sendFile(file, (error) => {
      if (error) next(error);
    });
  }),
);

panelImageRoutes.get(
  '/images/:imageId/:variant',
  asyncHandler(async (req, res, next) => {
    const file = await imageService.resolveImageFile(
      String(req.params.imageId),
      String(req.params.variant),
      panelActorFromRequest(req),
    );

    res.set('ETag', `"${file.checksum}"`);
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('image/webp');
    res.sendFile(file.path, (error) => {
      if (error) next(error);
    });
  }),
);
