/**
 * Profile pictures.
 *
 * Two routers, mirroring `images.routes.ts`: `avatarRoutes` mounted under a
 * person for the write surface, and `avatarFilesRoutes` at `/api/avatars` for
 * the variant stream an `<img>` points at.
 *
 * Neither carries a `requirePermissionMiddleware`. Who may change a picture
 * depends on *whose* it is — your own needs nothing, somebody else's needs
 * `users.manage` — and a route-level gate cannot see that. The check lives in
 * `avatar.service.ts#assertMayEdit`, next to the record it is about.
 *
 * Reading is authenticated but ungated: a face is the least sensitive thing in
 * this database, and everyone signed in already sees the roster it belongs to.
 */

import { MAX_AVATAR_SOURCE_BYTES } from '@orderbook/shared';
import { Router } from 'express';
import multer from 'multer';

import * as avatarService from '../../services/avatar.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth } from '../middleware/require-auth.js';
import { sendStoredFile } from '../send-stored-file.js';

// Buffered in memory, like every other upload here: the file is small by
// definition and goes straight into sharp, so a temp file would be a round
// trip through the disk for nothing.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AVATAR_SOURCE_BYTES } });

export const avatarRoutes: Router = Router({ mergeParams: true });

avatarRoutes.use(requireAuth);

avatarRoutes.post(
  '/',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'validation_error', message: 'Choose a picture' });
      return;
    }

    const user = await avatarService.uploadAvatar(
      { userId: String(req.params.userId), fileBuffer: req.file.buffer },
      actorFromRequest(req),
    );
    res.status(201).json(user);
  }),
);

avatarRoutes.delete(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await avatarService.removeAvatar(String(req.params.userId), actorFromRequest(req)));
  }),
);

export const avatarFilesRoutes: Router = Router();

avatarFilesRoutes.use(requireAuth);

avatarFilesRoutes.get(
  '/:avatarId/:variant',
  asyncHandler(async (req, res, next) => {
    const actor = actorFromRequest(req);
    const file = avatarService.avatarFilePath(
      actor.tenantId,
      String(req.params.avatarId),
      String(req.params.variant),
    );

    // An unknown variant name is a 404, not a 400: the only way to ask for one
    // is to have typed the URL, and there is nothing there either way.
    if (!file) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // The id is minted per upload and never reused, so a URL's bytes can never
    // change — which is what makes an immutable cache correct here rather than
    // merely convenient.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('image/webp');
    sendStoredFile(res, file, next);
  }),
);
