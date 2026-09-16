/**
 * What the shared `PartyFormModal` is allowed to reach on this panel.
 *
 * The component lives in `ui/` and is used by both panels, whose clients differ
 * in the way the offline story makes unavoidable: this panel writes straight to
 * the database it owns and gets the saved `Party` back, while the Office's
 * write is queued through its outbox and answers with the temporary id it
 * minted. The component only needs an id, so the adapter is this small — but it
 * has to exist, or the component would have to know which panel it is on.
 */

import type { PartyInput } from '@orderbook/shared';
import type { PartyFormTransport } from '@orderbook/ui';

import { api } from './api';

export const partyFormTransport: PartyFormTransport = {
  createParty: (input: PartyInput) => api.createParty(input),
  updateParty: (id, input) => api.updateParty(id, input),
};
