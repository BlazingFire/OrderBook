/**
 * Field-level visibility, bound to an actor.
 *
 * The masking rules themselves live in `@orderbook/shared` because the Office
 * Panel applies the identical rules to its cached snapshot — see the note there.
 * What stays here is the part that needs an `ActorContext`: deciding whether a
 * given caller is allowed, which is a Master-side concept.
 *
 * Applied on the way out of the service layer, over every read path including
 * search — search is just another read, so it goes through the same rule.
 */

import { hasPermission } from '@orderbook/shared';

import type { ActorContext } from './actor.js';

export {
  maskLead,
  maskLineItem,
  maskOrder,
  maskProduct,
  maskVariant,
  withPermittedRate,
} from '@orderbook/shared';

export function canSeeRates(actor: ActorContext): boolean {
  return hasPermission(actor.permissions, 'field.saleRate.view');
}

/**
 * Whether this actor may *set* a rate, as opposed to merely read one.
 *
 * `field.saleRate.edit` sat in the catalogue and rendered as a togglable cell
 * while being enforced in exactly no code path — a repo-wide grep found it only
 * in its own declaration. So a user who could not see rates could still send
 * one, and an administrator who unticked the box changed nothing at all.
 *
 * That is worse than a missing feature. The renderer hides controls purely as a
 * courtesy; the guarantee is that the server refuses the action anyway
 * (`roles-ui.md` §1). A permission that enforces nothing turns that guarantee
 * into a decoration and cannot be told apart from one that works.
 */
export function canEditRates(actor: ActorContext): boolean {
  return hasPermission(actor.permissions, 'field.saleRate.edit');
}
