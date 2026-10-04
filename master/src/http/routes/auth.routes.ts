import { Router } from 'express';

import { config } from '../../config/index.js';
import { ValidationError } from '../../lib/errors.js';
import { isLoopback, masterPcAddress } from '../../lib/network.js';
import * as authService from '../../services/auth.service.js';
import * as notificationService from '../../services/notification.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth } from '../middleware/require-auth.js';

export const authRoutes: Router = Router();

authRoutes.post(
  '/sign-in',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new ValidationError('validation.signIn.credentialsRequired');
    }

    // A Server Master signs in only from the Master PC itself (`isLoopback`).
    const { token, user, sessionTtlMs } = await authService.signIn(username, password, undefined, {
      onMasterPc: isLoopback(req),
    });

    res.cookie(config.session.cookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      // The ttl the session was actually stamped with, handed back by `signIn`
      // — never a second read. Two independent reads would let the shorter one
      // win silently once the value became a company setting.
      maxAge: sessionTtlMs,
    });
    // The token is also returned in the body: the Master's own browser UI
    // presents it when opening its Socket.IO connection, which does not carry
    // the cookie in every transport.
    res.json({ user, sessionToken: token });
  }),
);

authRoutes.post(
  '/sign-out',
  asyncHandler(async (req, res) => {
    await authService.signOut(
      req.cookies?.[config.session.cookieName],
      masterPcAddress(req.socket.remoteAddress, req.headers),
    );
    res.clearCookie(config.session.cookieName);
    res.status(204).end();
  }),
);

authRoutes.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    // Decorated with the session's own permission set: the UI hides controls
    // from this list, and the server refuses them again regardless.
    res.json({
      user: await authService.decorate(req.user!, req.sessionToken),
      sessionToken: req.sessionToken,
    });
  }),
);

/**
 * The bell, mounted at `/api/notifications`. Beside `/me` because, like it, it
 * needs only a signed-in person and reaches only that person's own rows.
 */
export const notificationRoutes: Router = Router();

notificationRoutes.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json(
      await notificationService.listNotifications(
        { limit, before: req.query.before },
        actorFromRequest(req),
      ),
    );
  }),
);

notificationRoutes.post(
  '/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await notificationService.markRead(req.body, actorFromRequest(req)));
  }),
);
