/**
 * The Office half of the Stage 0 ack prerequisite
 * (`docs/backend-modules/11-BUILD-SEQUENCE.md` Stage 0): `forward()` must
 * turn an unreachable Master into 503 `unavailable`, and must pass a
 * refusal's `code`, `details`, `messageKey` and `params` through to the
 * browser rather than collapsing every non-forbidden refusal into a bare
 * 502. Pure — `masterConnection` and the signed-in session are both mocked,
 * so this suite needs no cluster and cannot silently skip.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The bulk-import routes reach the Master over `masterFetch`, not the
// `masterConnection.command` socket the rest of this suite mocks — and
// `masterFetch` reads pairing credentials off real disk (`config.dataDir`,
// which nothing here overrides). Mocked at the module boundary so these
// tests exercise "not paired" cleanly rather than whatever this machine's
// real Office panel data directory happens to hold.
vi.mock('../src/lib/master-fetch.js', () => ({
  masterFetch: vi.fn().mockRejectedValue(new Error('This panel is not paired with a Master')),
}));

import { clearReadCache, createApp } from '../src/http/app.js';
import { masterFetch } from '../src/lib/master-fetch.js';
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

// The Office server answers a few reads from a short cache; a test must not inherit the last one's.
beforeEach(clearReadCache);

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

  it('answers 426 with error.updateNeeded.master when the Master is too old for the command', async () => {
    vi.spyOn(masterConnection, 'command').mockRejectedValue(
      new MasterCommandError(
        'The Master Panel needs an update before it can do this',
        'updateNeeded',
        undefined,
        false,
        undefined,
        'error.updateNeeded.master',
      ),
    );

    const response = await request(createApp()).delete('/api/parties/PT1');

    expect(response.status).toBe(426);
    expect(response.body).toMatchObject({
      error: 'updateNeeded',
      messageKey: 'error.updateNeeded.master',
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

  it('forwards product:list with the search, category, weight filter and page when the Master is up', async () => {
    const commandSpy = vi
      .spyOn(masterConnection, 'command')
      .mockResolvedValue({ items: [], total: 0, limit: 50, offset: 100, categories: [] } as never);

    const response = await request(createApp()).get(
      '/api/products?search=ivory&categoryId=PC1&missingWeight=true&limit=50&offset=100',
    );

    expect(response.status).toBe(200);
    expect(response.body.offline).toBeUndefined();
    expect(commandSpy).toHaveBeenCalledWith('product:list', {
      search: 'ivory',
      categoryId: 'PC1',
      missingWeight: true,
      limit: 50,
      offset: 100,
    });
  });

  it('forwards the sort and the size and photo filters (1.4 R17)', async () => {
    const commandSpy = vi
      .spyOn(masterConnection, 'command')
      .mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0, categories: [] } as never);

    await request(createApp()).get('/api/products?sort=weight&dir=desc&size=600x600&hasPhoto=false');

    expect(commandSpy).toHaveBeenCalledWith('product:list', {
      sort: 'weight',
      dir: 'desc',
      size: '600x600',
      hasPhoto: false,
    });
  });

  it('asks the Master for the product share PDF and hands it on inline (1.4 R16)', async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ fileName: 'product-share-2026-10-03.pdf', bytes: new Uint8Array([37, 80, 68, 70]) });
    const within = vi.spyOn(masterConnection, 'commandWithin').mockReturnValue(send as never);

    const response = await request(createApp()).post('/api/products/share.pdf').send({ ids: ['PR1', 'PR2'] });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain('product-share-2026-10-03.pdf');
    expect(send).toHaveBeenCalledWith('product:sharePdf', ['PR1', 'PR2']);
    // A share of up to 400 products with photographs is not a 15 s command.
    expect(within).toHaveBeenCalledWith(120_000);
  });

  it('says the Master is unreachable for the product share rather than inventing one (1.4 R16)', async () => {
    vi.spyOn(masterConnection, 'commandWithin').mockReturnValue(
      (() => Promise.reject(UNREACHABLE)) as never,
    );
    const response = await request(createApp()).post('/api/products/share.pdf').send({ ids: ['PR1'] });
    expect(response.status).toBe(503);
  });

  it('pages the cached snapshot, and says so, when the Master cannot be reached', async () => {
    vi.spyOn(masterConnection, 'command').mockRejectedValue(UNREACHABLE);
    vi.spyOn(localStore, 'getView').mockResolvedValue({
      products: [
        {
          id: 'PR1',
          name: 'Zed',
          categoryId: 'PC1',
          categoryName: 'Ceramic',
          variants: [{ id: 'V1', code: 'Z-1', label: null, weightKg: null, isActive: true }],
          sync: { hlc: 'x' },
          images: [],
        },
        {
          id: 'PR2',
          name: 'Alpha',
          categoryId: 'PC2',
          categoryName: 'Vitrified',
          variants: [{ id: 'V2', code: 'A-1', label: null, weightKg: 12, isActive: true }],
          sync: { hlc: 'x' },
          images: [],
        },
      ],
      parties: [],
      leads: [],
      orders: [],
      partyVariants: [],
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
      categories: [
        { id: 'PC1', name: 'Ceramic', count: 1 },
        { id: 'PC2', name: 'Vitrified', count: 1 },
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

  it('proxies the export with the Master\'s own type, dated file name and level, whatever the format', async () => {
    const csvBody = '\uFEFFBrand,Code\r\n';
    vi.mocked(masterFetch).mockResolvedValueOnce(
      new Response(csvBody, {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="main-products-2026-10-01.csv"',
        },
      }),
    );

    const response = await request(createApp()).get('/api/products/export.csv?level=main');

    expect(response.status).toBe(200);
    expect(vi.mocked(masterFetch)).toHaveBeenLastCalledWith('/api/panel/products/export.csv?level=main');
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe('attachment; filename="main-products-2026-10-01.csv"');
    expect(response.text).toBe(csvBody);
  });

  it('passes the Master\'s refusal of an export through with its status and message key', async () => {
    vi.mocked(masterFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'forbidden', messageKey: 'error.forbidden.permission' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const response = await request(createApp()).get('/api/products/export.xlsx');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: 'forbidden' });
  });

  it('forwards the file, the mode and the dry-run flag to the Master as one multipart form', async () => {
    vi.mocked(masterFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ dryRun: true, created: 1, unchanged: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await request(createApp())
      .post('/api/products/import')
      .field('dryRun', 'true')
      .field('mode', 'upsert')
      .attach('file', Buffer.from('Code\r\nA\r\n'), 'products.csv');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ dryRun: true, created: 1 });
    const [path, init] = vi.mocked(masterFetch).mock.calls.at(-1) ?? [];
    expect(path).toBe('/api/panel/products/import');
    const form = init?.body as FormData;
    expect(form.get('dryRun')).toBe('true');
    expect(form.get('mode')).toBe('upsert');
    expect((form.get('file') as File).name).toBe('products.csv');
  });

  it('serves the template through the Master, and 503 without one', async () => {
    const response = await request(createApp()).get('/api/products/import/template.csv');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: 'unavailable' });
  });
});

describe('bulk party import', () => {
  beforeEach(() => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(FAKE_SESSION as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is online-only: an unreachable Master is a 503, never a queued write', async () => {
    const response = await request(createApp())
      .post('/api/parties/import')
      .field('dryRun', 'true')
      .attach('file', Buffer.from('Name\r\nShah\r\n'), 'parties.csv');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: 'unavailable', messageKey: 'error.unavailable' });
  });

  it('refuses a request with no file before touching the Master', async () => {
    const response = await request(createApp()).post('/api/parties/import').field('dryRun', 'true');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ messageKey: 'validation.import.fileRequired' });
  });

  it('forwards the file, the mode and the dry-run flag to the Master as one multipart form', async () => {
    vi.mocked(masterFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ dryRun: true, created: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await request(createApp())
      .post('/api/parties/import')
      .field('dryRun', 'true')
      .field('mode', 'updateByCode')
      .attach('file', Buffer.from('Party Code\r\nP-0001\r\n'), 'parties.csv');

    expect(response.status).toBe(200);
    const [path, init] = vi.mocked(masterFetch).mock.calls.at(-1) ?? [];
    expect(path).toBe('/api/panel/parties/import');
    const form = init?.body as FormData;
    expect(form.get('dryRun')).toBe('true');
    expect(form.get('mode')).toBe('updateByCode');
    expect((form.get('file') as File).name).toBe('parties.csv');
  });

  it('reads any other mode as create, so a stray value cannot become an update', async () => {
    vi.mocked(masterFetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await request(createApp())
      .post('/api/parties/import')
      .field('mode', 'upsert')
      .attach('file', Buffer.from('Name\r\nA\r\n'), 'parties.csv');

    const [, init] = vi.mocked(masterFetch).mock.calls.at(-1) ?? [];
    expect((init?.body as FormData).get('mode')).toBe('create');
  });

  it('proxies the export with the Master’s own type and dated file name', async () => {
    const csvBody = '\uFEFFParty Code,Name\r\n';
    vi.mocked(masterFetch).mockResolvedValueOnce(
      new Response(csvBody, {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="parties-2026-10-03.csv"',
        },
      }),
    );

    const response = await request(createApp()).get('/api/parties/export.csv');

    expect(response.status).toBe(200);
    expect(vi.mocked(masterFetch)).toHaveBeenLastCalledWith('/api/panel/parties/export.csv');
    expect(response.headers['content-disposition']).toBe('attachment; filename="parties-2026-10-03.csv"');
    expect(response.text).toBe(csvBody);
  });

  it('passes the Master’s refusal through with its status, and serves the template or a 503', async () => {
    vi.mocked(masterFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } }),
    );
    expect((await request(createApp()).get('/api/parties/export.xlsx')).status).toBe(403);

    const offline = await request(createApp()).get('/api/parties/import/template.csv');
    expect(offline.status).toBe(503);
  });
});

/*
 * Reports (1.3 H2): every one is forwarded live and fails hard offline — the
 * Master decides who may see whose figures, so this server forwards the
 * person's own words (`subjectId` included) and adds none of its own.
 */
describe('reports', () => {
  const UNREACHABLE = new MasterCommandError('Not connected', undefined, undefined, true);

  beforeEach(() => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(FAKE_SESSION as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards the options as report:options, with nothing else', async () => {
    const commandSpy = vi.spyOn(masterConnection, 'command').mockResolvedValue({ kinds: [], subjects: null, canExport: false } as never);

    const response = await request(createApp()).get('/api/reports/options');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ kinds: [], subjects: null, canExport: false });
    expect(commandSpy).toHaveBeenCalledWith('report:options');
  });

  it('answers 426 for the options from a Master on protocol 1, without asking it', async () => {
    // The real `command()`, over a connected socket to a Master that announced
    // protocol 1: `report:options` needs 2, so it is refused before sending.
    const emitWithAck = vi.fn();
    const connection = masterConnection as unknown as Record<string, unknown>;
    const saved = { socket: connection.socket, state: connection.state, masterProtocol: connection.masterProtocol };
    Object.assign(connection, {
      socket: { timeout: () => ({ emitWithAck }) },
      state: 'connected',
      masterProtocol: 1,
    });

    try {
      const response = await request(createApp()).get('/api/reports/options');

      expect(response.status).toBe(426);
      expect(response.body).toMatchObject({ error: 'updateNeeded', messageKey: 'error.updateNeeded.master' });
      expect(emitWithAck).not.toHaveBeenCalled();
    } finally {
      Object.assign(connection, saved);
    }
  });

  it('forwards a table with the kind and the whole query, read by the shared parser', async () => {
    const commandSpy = vi.spyOn(masterConnection, 'command').mockResolvedValue({ kind: 'by-user' } as never);

    await request(createApp()).get(
      '/api/reports/table/by-user?period=customDates&fromDate=2026-04-01&toDate=2026-04-30&subjectId=US0000000007&limit=5&bogus=x&period2=y',
    );

    expect(commandSpy).toHaveBeenCalledWith('report:table', {
      report: 'by-user',
      query: {
        period: 'customDates',
        fromMonth: undefined,
        toMonth: undefined,
        fromDate: '2026-04-01',
        toDate: '2026-04-30',
        subjectId: 'US0000000007',
        limit: 5,
      },
    });
  });

  it('drops a period it does not know rather than forwarding a guess', async () => {
    const commandSpy = vi.spyOn(masterConnection, 'command').mockResolvedValue({} as never);
    await request(createApp()).get('/api/reports/table/by-city?period=forever');
    expect(commandSpy.mock.calls.at(-1)?.[1]).toMatchObject({ query: { period: undefined } });
  });

  it('keeps the three legacy routes on their own events', async () => {
    const commandSpy = vi.spyOn(masterConnection, 'command').mockResolvedValue({} as never);

    await request(createApp()).get('/api/reports/dispatches?period=thisMonth');
    await request(createApp()).get('/api/reports/lead-outcomes?period=last3Months');
    await request(createApp()).get('/api/reports/top-parties?limit=7');

    expect(commandSpy.mock.calls.map((call) => call[0])).toEqual(['report:dispatches', 'report:leadOutcomes', 'report:topParties']);
    expect(commandSpy.mock.calls[0]?.[1]).toMatchObject({ period: 'thisMonth' });
    expect(commandSpy.mock.calls[2]?.[1]).toMatchObject({ limit: 7 });
  });

  it('is online-only: an unreachable Master is a 503 on every report route', async () => {
    vi.spyOn(masterConnection, 'command').mockRejectedValue(UNREACHABLE);

    for (const url of ['/api/reports/options', '/api/reports/table/by-user', '/api/reports/dispatches', '/api/reports/by-user/export', '/api/reports/by-user/pdf']) {
      const response = await request(createApp()).get(url);
      expect(response.status, url).toBe(503);
    }
  });

  it('answers an export in the format the Master sent: CSV as text, Excel and PDF as the file', async () => {
    const commandSpy = vi.spyOn(masterConnection, 'command');

    commandSpy.mockResolvedValueOnce({ format: 'csv', csv: 'city,orders\r\nMorbi,2\r\n', rowCount: 1 } as never);
    const asCsv = await request(createApp()).get('/api/reports/by-city/export');
    expect(asCsv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(asCsv.headers['content-disposition']).toBe('attachment; filename="by-city.csv"');
    expect(asCsv.text).toBe('city,orders\r\nMorbi,2\r\n');

    const workbook = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    commandSpy.mockResolvedValueOnce({
      format: 'xlsx',
      fileName: 'by-city.xlsx',
      contentType: workbook,
      bytes: new Uint8Array([0x50, 0x4b, 3, 4]),
      rowCount: 1,
    } as never);
    const asXlsx = await request(createApp())
      .get('/api/reports/by-city/export?format=xlsx&subjectId=US0000000007')
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(asXlsx.headers['content-type']).toBe(workbook);
    expect(asXlsx.headers['content-disposition']).toBe('attachment; filename="by-city.xlsx"');
    expect((asXlsx.body as Buffer).subarray(0, 2).toString('latin1')).toBe('PK');
    expect(commandSpy.mock.calls.at(-1)).toEqual([
      'report:export',
      expect.objectContaining({
        report: 'by-city',
        query: expect.objectContaining({ format: 'xlsx', subjectId: 'US0000000007' }),
      }),
    ]);

    commandSpy.mockResolvedValueOnce({
      format: 'pdf',
      fileName: 'by-city.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      rowCount: 1,
    } as never);
    const asPdf = await request(createApp()).get('/api/reports/by-city/export?format=pdf&paperSize=letter&orientation=portrait&totals=true');
    expect(asPdf.headers['content-type']).toBe('application/pdf');
    expect(commandSpy.mock.calls.at(-1)?.[1]).toMatchObject({
      query: { format: 'pdf', paperSize: 'letter', orientation: 'portrait', totals: true },
    });
  });

  it('previews a report as a PDF inline, whatever format the query names', async () => {
    const commandSpy = vi.spyOn(masterConnection, 'command').mockResolvedValue({
      format: 'pdf',
      fileName: 'by-city.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      rowCount: 1,
    } as never);

    const response = await request(createApp()).get(
      '/api/reports/by-city/pdf?period=customDates&fromDate=2026-04-01&toDate=2026-04-30&format=csv&columns=city,orders&totals=true',
    );

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toBe('inline; filename="by-city.pdf"');
    expect(commandSpy.mock.calls.at(-1)).toEqual([
      'report:export',
      expect.objectContaining({
        report: 'by-city',
        query: expect.objectContaining({
          format: 'pdf',
          period: 'customDates',
          fromDate: '2026-04-01',
          toDate: '2026-04-30',
          columns: ['city', 'orders'],
          totals: true,
        }),
      }),
    ]);
  });

  it('does not answer a preview with a file the Master did not make as a PDF', async () => {
    vi.spyOn(masterConnection, 'command').mockResolvedValue({ format: 'csv', csv: 'a,b', rowCount: 1 } as never);
    const response = await request(createApp()).get('/api/reports/by-city/pdf');
    expect(response.status).toBe(502);
    expect(response.headers['content-type']).not.toBe('application/pdf');
  });

  it('does not forward a format it does not know', async () => {
    const commandSpy = vi.spyOn(masterConnection, 'command').mockResolvedValue({ format: 'csv', csv: '', rowCount: 0 } as never);
    await request(createApp()).get('/api/reports/by-city/export?format=docx');
    expect(commandSpy.mock.calls.at(-1)?.[1]).toMatchObject({ query: { format: undefined } });
  });

  it('passes the Master’s refusal of a hidden or foreign report through with its status', async () => {
    vi.spyOn(masterConnection, 'command').mockRejectedValue(
      new MasterCommandError('Reports are switched off for your role', 'forbidden', 'reports.view', false, undefined, 'error.forbidden.reportsHidden'),
    );
    const response = await request(createApp()).get('/api/reports/table/by-user');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: 'forbidden', messageKey: 'error.forbidden.reportsHidden' });
  });
});

/*
 * Catalogue v2 (`docs/catalogue/CATALOGUE_MODEL.md` §5, §8): the Products list
 * answers offline from the snapshot, its writes are online-only, a panel's one
 * company setting goes through `settings:save`, and the lead PDF comes back as
 * the bytes themselves, inline.
 */
describe('categories, the Leads setting and the lead PDF', () => {
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

  it('forwards category:list with the search and brand when the Master is up', async () => {
    const commandSpy = vi.spyOn(masterConnection, 'command').mockResolvedValue([] as never);

    const response = await request(createApp()).get('/api/categories?search=opt&brand=Swisware%2B');

    expect(response.status).toBe(200);
    expect(commandSpy).toHaveBeenCalledWith('category:list', { search: 'opt', brand: 'Swisware+' });
  });

  it('answers the Products list from the snapshot, in catalogue order with counts, offline', async () => {
    vi.spyOn(masterConnection, 'command').mockRejectedValue(UNREACHABLE);
    const category = (id: string, code: string, sortOrder: number) => ({
      id,
      tenantId: 't1',
      name: `Product ${code}`,
      code,
      brand: 'Swisware+',
      sortOrder,
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
      deletedAt: null,
    });
    vi.spyOn(localStore, 'getView').mockResolvedValue({
      categories: [category('C2', 'OPB', 2), category('C1', 'OPT', 1)],
      products: [
        { id: 'PR1', name: '102', categoryId: 'C1', variants: [], sync: { hlc: 'x' }, images: [] },
        { id: 'PR2', name: '111', categoryId: 'C1', variants: [], sync: { hlc: 'x' }, images: [] },
      ],
      parties: [],
      leads: [],
      orders: [],
      partyVariants: [],
      conflicts: [],
      dashboard: { asOf: '2026-08-24T00:00:00.000Z' },
      permissions: [],
      pendingCount: 0,
    } as never);

    const response = await request(createApp()).get('/api/categories');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject([
      { code: 'OPT', subProductCount: 2 },
      { code: 'OPB', subProductCount: 0 },
    ]);
  });

  it('forwards category writes, and refuses them with 503 when the Master is away', async () => {
    const commandSpy = vi
      .spyOn(masterConnection, 'command')
      .mockResolvedValue({ id: 'C1' } as never);
    const app = createApp();

    await request(app).post('/api/categories').send({ name: 'Urinal', code: 'UR' }).expect(200);
    await request(app).put('/api/categories/C1').send({ sortOrder: 4 }).expect(200);
    await request(app).delete('/api/categories/C1').expect(200);
    expect(commandSpy.mock.calls).toEqual([
      ['category:create', { name: 'Urinal', code: 'UR' }],
      ['category:update', { id: 'C1', input: { sortOrder: 4 } }],
      ['category:delete', 'C1'],
    ]);

    commandSpy.mockRejectedValue(UNREACHABLE);
    const refused = await request(app).post('/api/categories').send({ name: 'Urinal', code: 'UR' });
    expect(refused.status).toBe(503);
  });

  it('forwards a setting to settings:save as { key, value }', async () => {
    const commandSpy = vi.spyOn(masterConnection, 'command').mockResolvedValue([] as never);

    const response = await request(createApp())
      .put('/api/settings/leads.followUpDefaultDays')
      .send({ value: 5 });

    expect(response.status).toBe(200);
    expect(commandSpy).toHaveBeenCalledWith('settings:save', {
      key: 'leads.followUpDefaultDays',
      value: 5,
    });
  });

  it('streams the lead PDF inline from lead:pdf', async () => {
    const bytes = new Uint8Array(Buffer.from('%PDF-1.7 test'));
    const commandSpy = vi
      .spyOn(masterConnection, 'command')
      .mockResolvedValue({ fileName: 'lead-LD1.pdf', bytes } as never);

    const response = await request(createApp()).get('/api/leads/LD1/pdf').buffer(true);

    expect(commandSpy).toHaveBeenCalledWith('lead:pdf', 'LD1');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toBe('inline; filename="lead-LD1.pdf"');
    expect(Buffer.from(response.body as Buffer).toString()).toBe('%PDF-1.7 test');
  });

  it('streams the final-order PDF inline from order:pdf (the third button, 2026-10-25)', async () => {
    const bytes = new Uint8Array(Buffer.from('%PDF-1.7 order'));
    const commandSpy = vi
      .spyOn(masterConnection, 'command')
      .mockResolvedValue({ fileName: 'final-order-OD1.pdf', bytes } as never);

    const response = await request(createApp()).get('/api/orders/OD1/pdf').buffer(true);

    expect(commandSpy).toHaveBeenCalledWith('order:pdf', 'OD1');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toBe('inline; filename="final-order-OD1.pdf"');
    expect(Buffer.from(response.body as Buffer).toString()).toBe('%PDF-1.7 order');
  });
});

describe('notifications', () => {
  const UNREACHABLE = new MasterCommandError('Not connected', undefined, undefined, true);

  beforeEach(() => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(FAKE_SESSION as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards the list with its page, and marking read with only well-formed ids', async () => {
    const commandSpy = vi
      .spyOn(masterConnection, 'command')
      .mockResolvedValue({ items: [], unreadCount: 0 } as never);
    const app = createApp();

    await request(app).get('/api/notifications?limit=20&before=2026-10-01T00:00:00.000Z').expect(200);
    await request(app).get('/api/notifications').expect(200);
    await request(app).post('/api/notifications/read').send({ ids: ['N1', 7, 'N2'] }).expect(200);
    await request(app).post('/api/notifications/read').send({ all: true }).expect(200);

    expect(commandSpy.mock.calls).toEqual([
      ['notification:list', { limit: 20, before: '2026-10-01T00:00:00.000Z' }],
      ['notification:list', {}],
      ['notification:markRead', { ids: ['N1', 'N2'] }],
      ['notification:markRead', { all: true }],
    ]);
  });

  it('answers 503 when the Master is away and 426 when it is too old for the bell', async () => {
    const commandSpy = vi.spyOn(masterConnection, 'command').mockRejectedValue(UNREACHABLE);
    const app = createApp();

    const away = await request(app).get('/api/notifications');
    expect(away.status).toBe(503);
    expect(away.body).toMatchObject({ messageKey: 'error.unavailable' });

    commandSpy.mockRejectedValue(
      new MasterCommandError(
        'The Master Panel needs an update before it can do this',
        'updateNeeded',
        undefined,
        false,
        undefined,
        'error.updateNeeded.master',
      ),
    );
    const old = await request(app).post('/api/notifications/read').send({ all: true });
    expect(old.status).toBe(426);
    expect(old.body).toMatchObject({ messageKey: 'error.updateNeeded.master' });
  });

  it('streams a notification only to the person it is for, even after someone else signs in', async () => {
    vi.spyOn(localStore, 'getView').mockResolvedValue(null);
    const session = vi
      .spyOn(userSession, 'currentSession')
      .mockReturnValue({ ...FAKE_SESSION, userId: 'US000000000A' } as never);

    const server = createApp().listen(0);
    const { port } = server.address() as AddressInfo;
    let received = '';
    const stream = http.get(`http://127.0.0.1:${port}/api/events`, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        received += chunk;
      });
    });

    try {
      await vi.waitFor(() => expect(received).toContain('event: status'));

      masterConnection.emit('notification', { id: 'for-a-1', forUserId: 'US000000000A' });
      await vi.waitFor(() => expect(received).toContain('for-a-1'));

      // Shift change: B signs in on the same PC before A's next notice lands.
      session.mockReturnValue({ ...FAKE_SESSION, userId: 'US000000000B' } as never);
      masterConnection.emit('notification', { id: 'for-a-2', forUserId: 'US000000000A' });
      masterConnection.emit('notification', { id: 'unaddressed' });
      masterConnection.emit('notification', { id: 'for-b-1', forUserId: 'US000000000B' });
      await vi.waitFor(() => expect(received).toContain('for-b-1'));

      expect(received).not.toContain('for-a-2');
      expect(received).not.toContain('unaddressed');
      expect(received.match(/event: notification/g)).toHaveLength(2);
    } finally {
      stream.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
