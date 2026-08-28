/**
 * Authenticate an Office Panel's *server* on an HTTP route, and resolve who it
 * is acting as.
 *
 * Both halves matter and the second is the one that is easy to leave out.
 * Verifying the panel's own credentials answers "is this a paired machine";
 * it does not answer "on whose authority". Image upload and fetch have always
 * run as the signed-in person — `resolvePanelActor` turns the acting token into
 * their actor, and `image.service.ts` gates on `products.edit` / `products.view`
 * with a permission-to-404 translation. A route authenticated by the panel
 * secret alone would run uploads as the panel's own fallback role, changing who
 * may upload and putting the *machine's* name on every image in the audit trail
 * instead of the person's.
 *
 * So a presented-but-refused acting token is a 401, never a silent downgrade to
 * the panel's own authority.
 */

import type { NextFunction, Request, Response } from 'express';

import type { ActorContext } from '../../domain/actor.js';
import { UnauthorizedError } from '../../lib/errors.js';
import * as panelService from '../../services/panel.service.js';
import { resolvePanelActor } from '../../services/panel-actor.service.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `requirePanel`: whoever the panel is currently acting as. */
    panelActor?: ActorContext;
  }
}

export const PANEL_ID_HEADER = 'x-orderbook-panel-id';
export const PANEL_SECRET_HEADER = 'x-orderbook-panel-secret';
export const ACTING_TOKEN_HEADER = 'x-orderbook-acting-token';

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function requirePanel(req: Request, _res: Response, next: NextFunction): void {
  const panelId = header(req, PANEL_ID_HEADER);
  const panelSecret = header(req, PANEL_SECRET_HEADER);

  if (!panelId || !panelSecret) {
    next(new UnauthorizedError('error.unauthorized.panelCredentialsInvalid'));
    return;
  }

  void (async () => {
    try {
      const panel = await panelService.authenticatePanel(panelId, panelSecret);

      const resolution = await resolvePanelActor({
        tenantId: panel.tenantId,
        panelId: panel.id,
        deviceCode: panel.deviceCode,
        actingUserToken: header(req, ACTING_TOKEN_HEADER),
      });

      // A token the Master will not honour is a refusal, not a fallback. The
      // panel forgets it and asks the person to sign in again.
      if (!resolution.tokenAccepted) {
        next(new UnauthorizedError('error.unauthorized.signInFailed'));
        return;
      }

      req.panelActor = resolution.actor;
      next();
    } catch (error) {
      next(error);
    }
  })();
}

/** The actor `requirePanel` established. Throws rather than acting as nobody. */
export function panelActorFromRequest(req: Request): ActorContext {
  if (!req.panelActor) throw new UnauthorizedError('error.unauthorized.panelCredentialsInvalid');
  return req.panelActor;
}
