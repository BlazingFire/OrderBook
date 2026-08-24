import type { PermissionSet, Permission, User } from '@orderbook/shared';
import type { NextFunction, Request, Response } from 'express';

import { config } from '../../config/index.js';
import type { ActorContext } from '../../domain/actor.js';
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js';
import { permissionSetForRole } from '../../repositories/role.repository.js';
import { resolveSession } from '../../services/auth.service.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
    permissions?: PermissionSet | null;
    sessionToken?: string;
  }
}

/**
 * Resolve the session and the permissions it grants.
 *
 * The permission set is looked up here rather than in each route so there is
 * exactly one place a request's authority is established — and so a route
 * cannot accidentally run with the caller's identity but nobody's permissions.
 */
export function attachSession(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[config.session.cookieName] as string | undefined;

  // Async because resolving a session re-reads the role's version every call —
  // that is what makes a permission change take effect on the next request
  // rather than after a timeout (docs/ROLES_AND_USERS.md §4).
  void (async () => {
    try {
      const user = await resolveSession(token);

      if (!user) {
        next();
        return;
      }

      req.user = user;
      req.sessionToken = token;
      req.permissions = await permissionSetForRole(user.tenantId, user.roleId);
      next();
    } catch (error) {
      next(error);
    }
  })();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new UnauthorizedError());
    return;
  }
  next();
}

/**
 * Route-level permission guard.
 *
 * Services check again on the way through — this is a second gate, not the only
 * one. Having it here means a request that is going to be refused is refused
 * before it opens a transaction.
 */
export function requirePermissionMiddleware(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.permissions?.permissions.includes(permission)) {
      next(new ForbiddenError(permission));
      return;
    }
    next();
  };
}

/**
 * The actor for a Master Panel request.
 *
 * The tenant comes from the signed-in user, never from the request — there is
 * deliberately no path by which a client can name the tenant it writes to.
 */
export function actorFromRequest(req: Request): ActorContext {
  if (!req.user) throw new UnauthorizedError();

  return {
    tenantId: req.user.tenantId,
    actorType: 'user',
    actorId: req.user.id,
    userId: req.user.id,
    permissions: req.permissions ?? null,
    deviceCode: null,
    actorName: req.user.displayName,
  };
}
