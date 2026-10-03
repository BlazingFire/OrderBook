/**
 * `GET /api/reports/:report/pdf` — the inline PDF Preview PDF opens in a window
 * or a tab. It is `exportReport` with the format forced to `pdf`, so the
 * permission pair and the subject rule are the file route's; only the response
 * differs (`application/pdf`, `inline`).
 */

import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/http/app.js';
import * as roles from '../src/services/role.service.js';
import * as users from '../src/services/user.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let app: Express;

async function agentWith(permissions: string[], username: string) {
  const admin = await testActor();
  const role = await roles.createRole({ name: `Role ${username}`, tier: 'office', permissions }, admin);
  await users.createUser({ username, displayName: username, roleId: role.id, password: 'correct-horse' }, admin);
  const agent = request.agent(app);
  await agent.post('/api/auth/sign-in').send({ username, password: 'correct-horse' }).expect(200);
  return agent;
}

/** supertest hands a PDF back as a Buffer only when asked. */
function binary(res: request.Response, done: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}

describe.skipIf(!canRunIntegrationTests)('report PDF route (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
  });
  afterAll(teardownDatabase);
  beforeEach(resetData);

  it('answers a PDF inline to someone holding reports.view and reports.export', async () => {
    const agent = await agentWith(['reports.view', 'reports.export'], 'vera');
    const response = await agent.get('/api/reports/by-city/pdf?period=thisMonth').buffer(true).parse(binary).expect(200);

    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toMatch(/^inline; filename="/);
    expect((response.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('answers a PDF whatever format the query asks for', async () => {
    const agent = await agentWith(['reports.view', 'reports.export'], 'vera');
    for (const format of ['csv', 'xlsx', 'docx']) {
      const response = await agent
        .get(`/api/reports/dispatches/pdf?format=${format}`)
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(response.headers['content-type'], format).toBe('application/pdf');
      expect((response.body as Buffer).subarray(0, 5).toString('latin1'), format).toBe('%PDF-');
    }
  });

  it('is refused to someone who is not signed in', async () => {
    await request(app).get('/api/reports/by-city/pdf').expect(401);
  });

  it('is refused without reports.export, and without reports.view, naming the key', async () => {
    const noExport = await agentWith(['reports.view'], 'nora');
    const refusedExport = await noExport.get('/api/reports/by-city/pdf').expect(403);
    expect(JSON.stringify(refusedExport.body)).toContain('reports.export');

    const noView = await agentWith(['reports.export'], 'vik');
    const refusedView = await noView.get('/api/reports/by-city/pdf').expect(403);
    expect(JSON.stringify(refusedView.body)).toContain('reports.view');
  });

  it('refuses a report kind it does not know', async () => {
    const agent = await agentWith(['reports.view', 'reports.export'], 'vera');
    const response = await agent.get('/api/reports/not-a-report/pdf');
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('keeps the export route a file download', async () => {
    const agent = await agentWith(['reports.view', 'reports.export'], 'vera');
    const response = await agent.get('/api/reports/by-city/export?format=pdf').buffer(true).parse(binary).expect(200);
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="/);
  });
});
