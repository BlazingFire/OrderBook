/**
 * The Office panel's readiness route.
 *
 * Its desktop shell will not show the panel until this answers, and for the
 * whole life of the shell the route did not exist — so the request hit the
 * blanket `requireUser` gate, came back 401, and the shell sat on its splash
 * for the full sixty-second timeout before declaring a perfectly healthy
 * server dead.
 *
 * Two things are asserted, and the second matters as much as the first:
 * the route answers without a session, and mounting it above the gate did not
 * open a hole for anything else.
 */

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/realtime/master-connection.js', () => ({
  masterConnection: {
    on: vi.fn(),
    off: vi.fn(),
    isConnected: () => false,
    send: vi.fn(),
  },
  MasterCommandError: class extends Error {},
}));

const { createApp } = await import('../src/http/app.js');

describe('GET /api/health', () => {
  it('answers with no session at all', async () => {
    const response = await request(createApp()).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.panel).toBe('office');
    expect(response.body.status).toBe('ok');
    expect(response.body.boot.state).toBe('ready');
    expect(typeof response.body.port).toBe('number');
  });

  it('still refuses everything behind the sign-in gate', async () => {
    // The health route is mounted above `requireUser`. This proves that did
    // not accidentally lift the gate for its neighbours.
    const response = await request(createApp()).get('/api/snapshot');
    expect(response.status).toBe(401);
  });

  it('answers a JSON 404 for an unknown API path rather than Express HTML', async () => {
    // An HTML body makes `response.json()` throw in both the browser client
    // and the desktop shell, turning "no such endpoint" into "the panel is
    // broken".
    const response = await request(createApp()).get('/api/definitely-not-a-route');
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.type).toBe('application/json');
  });
});
