/** `GET /api/device`: the PC the Master runs on, for the sign-in warning. No sign-in, no database. */

import os from 'node:os';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/http/app.js';

describe('GET /api/device', () => {
  it('answers memory and processor count without a sign-in', async () => {
    const response = await request(createApp()).get('/api/device');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      totalMemoryBytes: os.totalmem(),
      cpuCount: os.cpus().length,
    });
  });
});

describe('a body the parser refuses', () => {
  it('is a 400 for malformed JSON, not a 500', async () => {
    const response = await request(createApp())
      .post('/api/auth/sign-in')
      .set('Content-Type', 'application/json')
      .send('{"username": ');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'invalid_request', messageKey: 'error.generic.malformedBody' });
  });

  it('is a 413 above the 2 MB limit', async () => {
    const response = await request(createApp())
      .post('/api/auth/sign-in')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ username: 'x'.repeat(3 * 1024 * 1024) }));

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ error: 'payload_too_large', messageKey: 'error.generic.tooLarge' });
  });
});
