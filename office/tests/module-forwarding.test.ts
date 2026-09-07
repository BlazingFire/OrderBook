/**
 * The Office half of the Stage 0 ack prerequisite
 * (`docs/backend-modules/11-BUILD-SEQUENCE.md` Stage 0): `forward()` must
 * turn an unreachable Master into 503 `unavailable`, and must pass a
 * refusal's `code`, `details`, `messageKey` and `params` through to the
 * browser rather than collapsing every non-forbidden refusal into a bare
 * 502. Pure — `masterConnection` and the signed-in session are both mocked,
 * so this suite needs no cluster and cannot silently skip.
 */

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/http/app.js';
import { MasterCommandError, masterConnection } from '../src/realtime/master-connection.js';
import * as userSession from '../src/services/user-session.service.js';
import * as localStore from '../src/sync/local-store.js';

const FAKE_SESSION = {
  userId: 'US0000000001',
  username: 'kiran',
  displayName: 'Kiran',
  roleId: 'RL0000000001',
  roleName: 'Sales',
  roleTier: 'office',
  permissions: ['parties.delete', 'recycleBin.view'],
  offline: false,
  signedInAt: new Date(0).toISOString(),
};

describe('module forwarding', () => {
  beforeEach(() => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(FAKE_SESSION as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers 503 "unavailable" when the Master cannot be reached at all', async () => {
    vi.spyOn(masterConnection, 'command').mockRejectedValue(
      new MasterCommandError('Not connected to the Master Panel', undefined, undefined, true),
    );

    const response = await request(createApp()).delete('/api/parties/PT1');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: 'unavailable', messageKey: 'error.unavailable' });
  });

  it('passes messageKey, params and details through for a refusal that is not forbidden', async () => {
    vi.spyOn(masterConnection, 'command').mockRejectedValue(
      new MasterCommandError(
        'Other records still reference this and must be dealt with first',
        'conflict',
        undefined,
        false,
        { blockedBy: [{ entityType: 'lead', id: 'LD1', label: 'LD1', reason: 'live_reference' }] },
        'error.conflict.blockedByLiveReferences',
        {},
      ),
    );

    const response = await request(createApp()).delete('/api/parties/PT1');

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      error: 'conflict',
      messageKey: 'error.conflict.blockedByLiveReferences',
      details: { blockedBy: [{ entityType: 'lead', id: 'LD1' }] },
    });
  });

  it('still surfaces 403 with the missing permission for a forbidden refusal', async () => {
    vi.spyOn(masterConnection, 'command').mockRejectedValue(
      new MasterCommandError(
        'Missing permission: parties.delete',
        'forbidden',
        'parties.delete',
        false,
        undefined,
        'error.forbidden.missingPermission',
        { permission: 'parties.delete' },
      ),
    );

    const response = await request(createApp()).delete('/api/parties/PT1');

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: 'forbidden',
      messageKey: 'error.forbidden.missingPermission',
      details: { permission: 'parties.delete' },
    });
  });

  it('forwards a successful command straight through with no queuing', async () => {
    const commandSpy = vi.spyOn(masterConnection, 'command').mockResolvedValue({
      id: 'PT1',
      deletedAt: '2026-08-24T00:00:00.000Z',
    } as never);

    const response = await request(createApp()).delete('/api/parties/PT1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'PT1', deletedAt: '2026-08-24T00:00:00.000Z' });
    expect(commandSpy).toHaveBeenCalledWith('party:delete', 'PT1');
  });

  it('refuses every forwarded route with 401 when nobody is signed in', async () => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(null);

    const response = await request(createApp()).delete('/api/parties/PT1');

    expect(response.status).toBe(401);
  });
});

describe('the paged catalogue', () => {
  const UNREACHABLE = new MasterCommandError('Not connected', undefined, undefined, true);

  beforeEach(() => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue({
      ...FAKE_SESSION,
      permissions: ['products.view'],
    } as never);
    vi.spyOn(userSession, 'sessionPermissions').mockReturnValue(['products.view']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards product:list with the search, type and page when the Master is up', async () => {
    const commandSpy = vi
      .spyOn(masterConnection, 'command')
      .mockResolvedValue({ items: [], total: 0, limit: 50, offset: 100, productTypes: [] } as never);

    const response = await request(createApp()).get(
      '/api/products?search=ivory&productType=Vitrified&limit=50&offset=100',
    );

    expect(response.status).toBe(200);
    expect(response.body.offline).toBeUndefined();
    expect(commandSpy).toHaveBeenCalledWith('product:list', {
      search: 'ivory',
      productType: 'Vitrified',
      limit: 50,
      offset: 100,
    });
  });

  it('pages the cached snapshot, and says so, when the Master cannot be reached', async () => {
    vi.spyOn(masterConnection, 'command').mockRejectedValue(UNREACHABLE);
    vi.spyOn(localStore, 'getView').mockResolvedValue({
      products: [
        { id: 'PR1', name: 'Zed', productCode: 'Z-1', productType: 'Ceramic', sync: { hlc: 'x' }, images: [] },
        { id: 'PR2', name: 'Alpha', productCode: 'A-1', productType: 'Vitrified', sync: { hlc: 'x' }, images: [] },
      ],
      parties: [],
      leads: [],
      orders: [],
      partyVariants: [],
      stock: [],
      conflicts: [],
      dashboard: { asOf: '2026-08-24T00:00:00.000Z' },
      permissions: [],
      pendingCount: 0,
    } as never);

    const response = await request(createApp()).get('/api/products?limit=1');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      offline: true,
      total: 2,
      items: [{ id: 'PR2' }],
      productTypes: [
        { value: 'Ceramic', count: 1 },
        { value: 'Vitrified', count: 1 },
      ],
    });
  });

  it('answers an empty offline page before the first snapshot has ever arrived', async () => {
    vi.spyOn(masterConnection, 'command').mockRejectedValue(UNREACHABLE);
    vi.spyOn(localStore, 'getView').mockResolvedValue(null);

    const response = await request(createApp()).get('/api/products');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ items: [], total: 0, offline: true });
  });
});

describe('bulk product import', () => {
  beforeEach(() => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(FAKE_SESSION as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is online-only: an unpaired or unreachable Master is a 503, never a queued write', async () => {
    const response = await request(createApp())
      .post('/api/products/import')
      .field('dryRun', 'true')
      .attach('file', Buffer.from('productCode,name\r\nA,B\r\n'), 'products.csv');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: 'unavailable', messageKey: 'error.unavailable' });
  });

  it('refuses a request with no file before touching the Master', async () => {
    const response = await request(createApp()).post('/api/products/import').field('dryRun', 'true');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ messageKey: 'validation.import.fileRequired' });
  });

  it('serves the template through the Master, and 503 without one', async () => {
    const response = await request(createApp()).get('/api/products/import/template.csv');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: 'unavailable' });
  });
});
