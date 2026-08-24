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
import { permissionSetForRole } from '../repositories/role.repository.js';
import { resolveSessionDetailed } from './auth.service.js';
import * as panelService from './panel.service.js';

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

export async function resolvePanelActor(
  request: PanelActorRequest,
): Promise<PanelActorResolution> {
  const { tenantId, panelId, deviceCode, actingUserToken } = request;
  let rejection: SessionRejection | undefined;

  if (actingUserToken) {
    const resolution = await resolveSessionDetailed(actingUserToken);

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
          permissions: await permissionSetForRole(tenantId, resolution.user.roleId),
          // Still the panel's device code: a temporary id and an HLC timestamp
          // identify the machine that minted them, not the person at it.
          deviceCode,
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
    },
  };
}
