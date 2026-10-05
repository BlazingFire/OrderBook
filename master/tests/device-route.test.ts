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
