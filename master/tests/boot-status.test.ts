/**
 * What the Master says while it is starting, and when it could not.
 *
 * The defect this covers had no symptom, which is why it needs a test rather
 * than a comment: the HTTP port used to open only after PostgreSQL was up, so
 * anything that failed before that killed the process with the reason in a
 * console window, and the browser sat on its starting screen indefinitely
 * against a port that would never open. Pinned here at the layer that fixed
 * it — the boot app answers, and it answers with something worth reading.
 *
 * Pure: no cluster, no `describe.skipIf`, so it can never silently skip.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { bootFailed, bootReady, bootStatus, bootStep, resetBootStatus } from '../src/boot-status.js';
import { createBootApp } from '../src/http/boot-app.js';

beforeEach(resetBootStatus);

describe('boot status', () => {
  it('starts out starting', () => {
    expect(bootStatus().state).toBe('starting');
  });

  it('names the step it is on, so a slow start is legible rather than silent', () => {
    bootStep('Starting the database');
    expect(bootStatus().step).toBe('Starting the database');
  });

  it('keeps the step it failed on', () => {
    bootStep('Starting the database');
    bootFailed(new Error('could not start'));

    expect(bootStatus().state).toBe('failed');
    expect(bootStatus().step).toBe('Starting the database');
  });

  it('ignores a step reported after the outcome is settled', () => {
    bootReady();
    bootStep('Starting the database');
    expect(bootStatus().step).toBe('Ready');
  });

  it('carries the raw error as well as the advice, so an unfamiliar failure is not lost', () => {
    bootFailed(new Error('ENOENT: no such file or directory'));

    expect(bootStatus().detail).toBe('ENOENT: no such file or directory');
    expect(bootStatus().message).toBe('ENOENT: no such file or directory');
  });

  it('turns the failures that actually happen on a shop PC into an instruction', () => {
    bootFailed(new Error('initdb: error: cannot be run as root'));
    expect(bootStatus().message).toMatch(/normal user account/i);

    resetBootStatus();
    bootFailed(new Error('listen EADDRINUSE: address already in use :::4100'));
    expect(bootStatus().message).toMatch(/already using the port/i);

    resetBootStatus();
    bootFailed(new Error('PG_VERSION says 17, binaries are 18'));
    expect(bootStatus().message).toMatch(/different version of PostgreSQL/i);
  });

  it('accepts a thrown non-Error without losing what it said', () => {
    bootFailed('pg_ctl exited with code 1');
    expect(bootStatus().detail).toBe('pg_ctl exited with code 1');
  });
});

describe('the app served while starting', () => {
  it('answers /api/health before any database exists — the whole point', async () => {
    bootStep('Starting the database');

    const response = await request(createBootApp()).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'starting',
      boot: { state: 'starting', step: 'Starting the database' },
    });
  });

  it('answers every other API call 503 with the reason attached', async () => {
    bootStep('Starting the database');

    const response = await request(createBootApp()).get('/api/setup/status');

    // 503 is the honest code — the server exists and is not ready — and the
    // body is what the panel renders instead of hanging.
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('starting');
    expect(response.body.message).toMatch(/still starting/i);
  });

  it('reports a failed startup as failed, with the operator’s instruction', async () => {
    bootFailed(new Error('initdb: error: cannot be run as root'));

    const health = await request(createBootApp()).get('/api/health');
    expect(health.body.boot.state).toBe('failed');
    expect(health.body.boot.message).toMatch(/normal user account/i);

    const call = await request(createBootApp()).get('/api/setup/status');
    expect(call.status).toBe(503);
    expect(call.body.error).toBe('startup_failed');
    expect(call.body.message).toMatch(/normal user account/i);
  });
});
