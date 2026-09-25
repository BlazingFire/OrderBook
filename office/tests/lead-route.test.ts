/**
 * `POST /api/leads` is the trust boundary the browser cannot bypass
 * (docs/LEAD_GENERATION_FLOW.md §1), and it is also the last place a mistake
 * can still be shown to the person who made it: past here the payload is
 * written to a durable outbox, answered `202 queued`, and only comes back —
 * hours later, after a reconnect — as a bare rejection string with no route
 * back to the form.
 *
 * So the route has to refuse a structurally broken lead outright, and has to
 * keep accepting a *half-built* one: packaging is deliberately not required on
 * save (§3.1 — an offline draft is never lost to validation), only on convert.
 *
 * Pure — the session and the outbox are mocked, so this needs no cluster and
 * cannot silently skip.
 */

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/master-fetch.js', () => ({
  masterFetch: vi.fn().mockRejectedValue(new Error('This panel is not paired with a Master')),
}));

import { createApp } from '../src/http/app.js';
import * as userSession from '../src/services/user-session.service.js';
import * as sync from '../src/sync/sync.service.js';
import * as outbox from '../src/sync/outbox.store.js';

const FAKE_SESSION = {
  userId: 'US0000000001',
  username: 'kiran',
  displayName: 'Kiran',
  roleId: 'RL0000000001',
  roleName: 'Sales',
  roleTier: 'office',
  permissions: ['leads.create', 'leads.edit'],
  offline: true,
  signedInAt: new Date(0).toISOString(),
};

function soundLead() {
  return {
    partyId: 'PT0000000001',
    sourcePlatform: 'whatsapp',
    items: [
      {
        productId: 'PR0000000001',
        variantId: 'VR0000000001',
        quantity: 4,
        packaging: 'Packaging 2',
      },
    ],
  };
}

describe('POST /api/leads', () => {
  let submitted: unknown;

  beforeEach(() => {
    submitted = undefined;
    vi.spyOn(userSession, 'currentSession').mockReturnValue(FAKE_SESSION as never);
    vi.spyOn(userSession, 'can').mockReturnValue(true);
    vi.spyOn(outbox, 'pendingCount').mockResolvedValue(1);
    vi.spyOn(sync, 'submit').mockImplementation(async (payload) => {
      submitted = payload;
      return { mutationId: 'MU1' } as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queues a sound lead and answers with its temporary id', async () => {
    const response = await request(createApp()).post('/api/leads').send(soundLead());

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ queued: true, mutationId: 'MU1' });
    expect(typeof response.body.id).toBe('string');
    expect(response.body.id.length).toBeGreaterThan(0);
    expect(submitted).toMatchObject({ kind: 'lead.create', entity: 'lead' });
  });

  it('carries the variant, the quantity and the chosen colour through to the outbox verbatim', async () => {
    const lead = soundLead();
    lead.items[0] = {
      ...lead.items[0],
      colour: 'Ivory',
    } as never;

    await request(createApp()).post('/api/leads').send(lead);

    const payload = (submitted as { payload: Record<string, unknown> }).payload;
    const item = (payload.items as Array<Record<string, unknown>>)[0] ?? {};

    expect(item.colour).toBe('Ivory');
    expect(item.variantId).toBe('VR0000000001');
    expect(item.quantity).toBe(4);
  });

  it('refuses a lead with no party before anything is written', async () => {
    const lead = soundLead() as Record<string, unknown>;
    delete lead.partyId;

    const response = await request(createApp()).post('/api/leads').send(lead);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('validation_error');
    expect(submitted).toBeUndefined();
  });

  it('refuses a lead with no products', async () => {
    const response = await request(createApp())
      .post('/api/leads')
      .send({ partyId: 'PT0000000001', items: [] });

    expect(response.status).toBe(400);
    expect(submitted).toBeUndefined();
  });

  it('refuses a line whose quantity comes to nothing', async () => {
    const lead = soundLead();
    lead.items = [{ ...lead.items[0]!, quantity: 0 }];

    const response = await request(createApp()).post('/api/leads').send(lead);

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/quantity/i);
    expect(submitted).toBeUndefined();
  });

  it('refuses a line that names a product but no variant', async () => {
    const lead = soundLead();
    lead.items = [{ ...lead.items[0]!, variantId: '' }];

    const response = await request(createApp()).post('/api/leads').send(lead);

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/variant/i);
    expect(submitted).toBeUndefined();
  });

  it('still accepts a line with no packaging — that is convert-time, not save-time', async () => {
    const lead = soundLead();
    lead.items[0] = { ...lead.items[0], packaging: null } as never;

    const response = await request(createApp()).post('/api/leads').send(lead);

    expect(response.status).toBe(202);
  });

  it('refuses the write to somebody without leads.create', async () => {
    vi.spyOn(userSession, 'can').mockReturnValue(false);

    const response = await request(createApp()).post('/api/leads').send(soundLead());

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ permission: 'leads.create' });
    expect(submitted).toBeUndefined();
  });

  it('checks the permission ahead of the shape, so a malformed lead is still a 403', async () => {
    vi.spyOn(userSession, 'can').mockReturnValue(false);

    // Somebody who may not create a lead learns that, and nothing about what
    // a well-formed one would have looked like.
    const response = await request(createApp()).post('/api/leads').send({ items: [] });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ permission: 'leads.create' });
    expect(submitted).toBeUndefined();
  });
});

describe('PUT /api/leads/:id', () => {
  let submitted: unknown;

  beforeEach(() => {
    submitted = undefined;
    vi.spyOn(userSession, 'currentSession').mockReturnValue(FAKE_SESSION as never);
    vi.spyOn(userSession, 'can').mockReturnValue(true);
    vi.spyOn(outbox, 'pendingCount').mockResolvedValue(1);
    vi.spyOn(sync, 'submit').mockImplementation(async (payload) => {
      submitted = payload;
      return { mutationId: 'MU2' } as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queues a partial edit — nothing but the fields that changed', async () => {
    const response = await request(createApp())
      .put('/api/leads/LD0000000001')
      .send({ notes: 'Call back after Diwali' });

    expect(response.status).toBe(202);
    expect(submitted).toMatchObject({ kind: 'lead.update', entityId: 'LD0000000001' });
  });

  it('refuses an edit whose lines are malformed', async () => {
    const response = await request(createApp())
      .put('/api/leads/LD0000000001')
      .send({ items: [{ productId: 'PR0000000001', variantId: 'VR0000000001', quantity: 0 }] });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/quantity/i);
    expect(submitted).toBeUndefined();
  });

  it('checks leads.edit ahead of the shape, so a malformed edit is still a 403', async () => {
    vi.spyOn(userSession, 'can').mockReturnValue(false);

    const response = await request(createApp())
      .put('/api/leads/LD0000000001')
      .send({ items: 'not a list' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ permission: 'leads.edit' });
    expect(submitted).toBeUndefined();
  });
});
