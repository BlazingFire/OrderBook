/**
 * The hub sweeps expired presence tabs on a timer (1.4 R22), so a crashed browser's
 * face leaves a board without waiting for somebody else's beat. The timer runs every
 * `PRESENCE_BEAT_MS` while the hub is up and stops with it.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PRESENCE_BEAT_MS } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import { setupDatabase, teardownDatabase } from './helpers/fixtures.js';
import { createRealtimeHub } from '../src/realtime/hub.js';
import * as presenceService from '../src/services/presence.service.js';

describe.skipIf(!canRunIntegrationTests)('the presence sweep timer (integration)', () => {
  let server: HttpServer | undefined;

  beforeAll(setupDatabase, 120_000);
  afterAll(teardownDatabase);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    server?.close();
    server = undefined;
  });

  it('sweeps once every PRESENCE_BEAT_MS while the hub is up, and stops when it stops', async () => {
    // Only the interval is faked: the database and the sockets keep their real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sweep = vi.spyOn(presenceService, 'sweepPresence');

    server = createServer();
    const hub = createRealtimeHub(server);

    vi.advanceTimersByTime(PRESENCE_BEAT_MS - 1);
    expect(sweep).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PRESENCE_BEAT_MS * 2);
    expect(sweep).toHaveBeenCalledTimes(3);

    await hub.stop();
    sweep.mockClear();
    vi.advanceTimersByTime(PRESENCE_BEAT_MS * 5);
    expect(sweep).not.toHaveBeenCalled();

    // Let the hub's boot-time queries finish before the database goes away.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
});
