/**
 * Live presence on the Master panel: beats go over `POST /api/presence`, and
 * the socket's `presence:changed` pushes, which `App.tsx` feeds in here, say
 * who else is on a record. The tab id (`PRESENCE_TAB_ID`) is also sent in the
 * socket handshake, so the Master drops this tab the moment its socket closes.
 */

import { createPresenceChannel } from '@orderbook/ui';

import { api } from './api';

export const presenceChannel = createPresenceChannel({
  beat: (beat, keepalive) => api.presenceBeat(beat, keepalive),
  board: (kind) => api.presenceBoard(kind),
});
