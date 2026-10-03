/**
 * Live presence on this panel: beats go to this panel's server, which forwards
 * them to the Master (`POST /api/presence`), and pushes come back as the
 * `presence` SSE frame, which `App.tsx` feeds in here. Offline the beat fails
 * (503) and the record simply shows nobody.
 */

import { createPresenceChannel } from '@orderbook/ui';

import { api } from './api';

export const presenceChannel = createPresenceChannel({
  beat: (beat, keepalive) => api.presenceBeat(beat, keepalive),
  board: (kind) => api.presenceBoard(kind),
});
