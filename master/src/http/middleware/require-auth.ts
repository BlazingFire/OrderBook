import type { NextFunction, Request, Response } from 'express';
import type { User } from '@orderbook/shared';

import { config } from '../../config/index.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { resolveSession } from '../../services/auth.service.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
    sessionToken?: string;
  }
}

export function attachSession(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[config.session.cookieName] as string | undefined;
  const user = resolveSession(token);
  if (user) {
    req.user = user;
    req.sessionToken = token;
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new UnauthorizedError());
    return;
  }
  next();
}
