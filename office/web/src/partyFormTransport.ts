/**
 * What the shared `PartyFormModal` is allowed to reach on this panel.
 *
 * The component lives in `ui/` and is used by both panels, whose clients differ
 * in exactly the way the offline story makes unavoidable: this panel's
 * `createParty` resolves to a `QueuedResult` carrying the temporary id its
 * outbox minted, while the Master's resolves to the saved `Party`. The
 * component only needs an id, so the adapter is this small — but it has to
 * exist, or the component would have to know which panel it is running on.
 */

import type { PartyInput } from '@orderbook/shared';
import type { PartyFormTransport } from '@orderbook/ui';

import { api } from './api';

export const partyFormTransport: PartyFormTransport = {
  createParty: (input: PartyInput) => api.createParty(input),
  updateParty: (id, input) => api.updateParty(id, input),
};
