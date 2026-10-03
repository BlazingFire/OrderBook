/**
 * `report:table` / `report:export` over the socket. A socket payload is
 * whatever the client sent, so the hub reads the range the way the REST query
 * string is read (`parseReportQuery`) and the service normalises the export
 * options: junk falls back to the defaults instead of reaching the SQL or
 * throwing. The service-level tests cannot see the hub's own parsing.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { createRealtimeHub, type RealtimeHub } from '../src/realtime/hub.js';
import * as panelRepo from '../src/repositories/office-panel.repository.js';
import * as authService from '../src/services/auth.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

let server: HttpServer;
let hub: RealtimeHub;
let socket: Socket | undefined;

interface Ack {
  ok: boolean;
  data?: Record<string, unknown>;
  missingPermission?: string;
}

function ask(event: string, payload: unknown): Promise<Ack> {
  return new Promise((resolve) => (socket as Socket).emit(event, payload, resolve));
}

async function signInWith(permissions: string[]): Promise<void> {
  const admin = await testActor();
  const role = await roleService.createRole({ name: 'Reader', tier: 'management', permissions }, admin);
  await userService.createUser(
    { username: 'vera', displayName: 'vera', roleId: role.id, password: 'correct-horse' },
    admin,
  );
  const { token } = await authService.signIn('vera', 'correct-horse');
  const panelId = randomUUID();
  await panelRepo.insertPanel({
    id: panelId,
    tenant_id: admin.tenantId,
    name: 'Report panel',
    device_code: 'REPORT01',
    secret_hash: await bcrypt.hash('panel-secret', 4),
    lan_ip: '192.168.1.20',
    status: 'active',
    paired_at: new Date(),
  });
  const { port } = server.address() as AddressInfo;
  socket = connect(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    auth: { kind: 'office-panel', panelId, panelSecret: 'panel-secret', protocol: 3, actingUserToken: token },
  });
  // The first thing the hub sends a panel is its snapshot; commands work after it.
  await new Promise<void>((resolve, reject) => {
    socket?.on('sync:snapshot', () => resolve());
    socket?.on('connect_error', (error) => reject(error));
  });
}

describe.skipIf(!canRunIntegrationTests)('report commands over the socket (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    server = createServer();
    hub = createRealtimeHub(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await hub.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await teardownDatabase();
  });

  beforeEach(resetData);

  afterEach(() => {
    socket?.close();
    socket = undefined;
  });

  it('answers a table over the default range when the query is junk', async () => {
    await signInWith(['reports.view', 'reports.export']);

    const junk = {
      report: 'by-city',
      query: { period: 'next-week', fromMonth: 7, toMonth: {}, fromDate: [], toDate: null, subjectId: 5, limit: 'many' },
    };
    const junked = await ask('report:table', junk);
    const plain = await ask('report:table', { report: 'by-city', query: {} });

    expect(junked.ok, JSON.stringify(junked)).toBe(true);
    expect(junked.data?.range).toEqual(plain.data?.range);
    expect((junked.data?.range as { period: string }).period).toBe('last6Months');
  });

  it('refuses a missing payload with an ack, not a crash', async () => {
    await signInWith(['reports.view', 'reports.export']);

    expect((await ask('report:table', undefined)).ok).toBe(false);
    expect((await ask('report:export', null)).ok).toBe(false);
    // The socket is still alive afterwards.
    expect((await ask('report:table', { report: 'by-city', query: {} })).ok).toBe(true);
  });

  it('exports a CSV for a format it does not know, over the default range', async () => {
    await signInWith(['reports.view', 'reports.export']);

    const exported = await ask('report:export', {
      report: 'by-city',
      query: { period: 'someday', fromMonth: 3, format: 'docx', columns: 'city', paperSize: 9, lang: 'fr' },
    });

    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    expect(exported.data).toMatchObject({ format: 'csv' });
    expect(typeof exported.data?.csv).toBe('string');
  });

  it('keeps the permission pair: export needs reports.export', async () => {
    await signInWith(['reports.view']);

    const refused = await ask('report:export', { report: 'by-city', query: {} });

    expect(refused.ok).toBe(false);
    expect(refused.missingPermission).toBe('reports.export');
  });
});
