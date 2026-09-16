/**
 * Whose authority an Office Panel's command carries (docs/ROLES_AND_USERS.md §13).
 *
 * A panel authenticates as a *machine*, with a pairing secret. Once somebody
 * signs in on it, the panel also presents a session token the Master issued, and
 * from then on its commands should run as that person: their role, their
 * permissions, their name in the audit trail.
 *
 * The rule that makes this safe is that the panel presents a **token**, never an
 * identity. It cannot say "I am an administrator"; it can only hand back
 * something the Master gave it, and the Master decides what that is worth by
 * re-reading the `roles` row every time. A modified panel therefore gains
 * nothing from lying, and a permission revoked on the Master takes effect on the
 * panel's very next command rather than at its next reconnect.
 *
 * This lives in a service rather than in the hub because it is policy, not
 * transport — the same reason the lead status machine is not in the route that
 * calls it (HANDOFF.md, clean-architecture conventions).
 */

import type { SessionRejection } from '@orderbook/shared';

import type { ActorContext } from '../domain/actor.js';
import { UnauthorizedError } from '../lib/errors.js';
import { resolveSessionDetailedWithPermissions } from './auth.service.js';
import * as panelService from './panel.service.js';

/**
 * A panel presented an acting token the Master will not honour.
 *
 * Carries the rejection reason so a caller that has somewhere to put it — the
 * socket hub emits `session:rejected` — can tell the panel *why* before the
 * command fails, without anyone having to re-derive it.
 */
export class RefusedActingTokenError extends UnauthorizedError {
  constructor(readonly rejection: SessionRejection) {
    super('error.unauthorized.signInFailed');
  }
}

export interface PanelActorRequest {
  tenantId: string;
  panelId: string;
  deviceCode: string | null;
  /** The Master-issued session token of whoever is signed in on the panel. */
  actingUserToken?: string | undefined;
}

export interface PanelActorResolution {
  actor: ActorContext;
  /**
   * False when a token was presented and is no longer honoured — the account was
   * deactivated, its role deleted, or the session expired. The caller drops it
   * so the panel stops presenting a token the Master has already refused.
   */
  tokenAccepted: boolean;
  /**
   * Why the token was refused, when it was. `revoked` tells the panel to destroy
   * the offline verifier it holds for that person; `expired` deliberately does
   * not, because a Master restart empties the session map and must not cost
   * everybody their ability to work offline.
   */
  rejection?: SessionRejection;
}

/**
 * The actor a panel's command runs as.
 *
 * **Throws** `RefusedActingTokenError` when a token was presented and refused.
 * That enforcement used to live in the caller, and only one of the two callers
 * did it: `require-panel.ts` returned a 401 and stated the rule in its own
 * header comment, while `hub.ts` cleared the token, emitted `session:rejected`
 * — and then let the command proceed under the panel's *machine* role. A
 * modified or stale panel could therefore trade a revoked user session for the
 * panel's own authority on the socket path, on exactly the boundary the HTTP
 * path guards. Enforcing it here means a third caller cannot inherit the bug.
 *
 * The genuinely tokenless case is not a refusal and still gets the panel's own
 * actor: a panel with nobody signed in has to be able to raise a lead.
 */
export async function resolvePanelActor(
  request: PanelActorRequest,
): Promise<PanelActorResolution> {
  const resolution = await resolvePanelActorAllowingRefusal(request);
  if (!resolution.tokenAccepted) {
    throw new RefusedActingTokenError(resolution.rejection ?? 'expired');
  }
  return resolution;
}

/**
 * The same resolution, reported rather than thrown.
 *
 * For the one caller that must *not* refuse: a broadcast fan-out decides what a
 * socket may receive, and a refused token there means "nobody is signed in on
 * this panel" — which is the tokenless case, not an error to raise at somebody
 * who is not asking for anything. Never use it on a command path.
 */
export async function resolvePanelActorAllowingRefusal(
  request: PanelActorRequest,
): Promise<PanelActorResolution> {
  const { tenantId, panelId, deviceCode, actingUserToken } = request;
  let rejection: SessionRejection | undefined;

  if (actingUserToken) {
    const resolution = await resolveSessionDetailedWithPermissions(actingUserToken);

    // The tenant check is not paranoia about our own code: it is the one place
    // a token from another company could otherwise be spent against this one.
    if (resolution.status === 'active' && resolution.user.tenantId === tenantId) {
      return {
        tokenAccepted: true,
        actor: {
          tenantId,
          actorType: 'user',
          actorId: resolution.user.id,
          userId: resolution.user.id,
          permissions: resolution.permissions,
          // Still the panel's device code: a temporary id and an HLC timestamp
          // identify the machine that minted them, not the person at it.
          deviceCode,
          actorName: resolution.user.displayName,
        },
      };
    }

    // A live session for another company is treated as a revocation, not an
    // expiry: this panel has no business holding it under any circumstances.
    rejection = resolution.status === 'rejected' ? resolution.reason : 'revoked';
  }

  return {
    rejection,
    // A token that resolved to nothing is reported as rejected so the caller
    // forgets it; no token at all is not a rejection.
    tokenAccepted: !actingUserToken,
    actor: {
      tenantId,
      actorType: 'office_panel',
      actorId: panelId,
      userId: null,
      // A panel with no role falls back to the seeded Office one: a panel with
      // no permissions at all could not raise a lead, which is the one thing it
      // exists to do.
      permissions: await panelService.permissionsForPanel(tenantId, panelId),
      deviceCode,
      // No signed-in person to name; recorded as an honest null rather than
      // borrowing the panel's own label.
      actorName: null,
    },
  };
}
