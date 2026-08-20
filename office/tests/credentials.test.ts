/**
 * The credentials file is the only state an Office Panel keeps. If it is
 * unreadable the panel must fall back to the connection screen rather than
 * crash on startup, so the failure paths matter as much as the happy one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let dataDir: string;
let credentialsFile: string;

// The store reads its path from config at import time, so config is mocked to
// point at a throwaway directory per test run.
vi.mock('../src/config/index.js', () => ({
  get config() {
    return {
      credentialsFile,
      dataDir,
      packageRoot: dataDir,
      http: { host: '127.0.0.1', port: 4200 },
      panelName: 'Test Panel',
      hostname: 'test-host',
      discovery: { timeoutMs: 1000 },
    };
  },
}));

const store = await import('../src/services/credentials.store.js');

const sample = {
  panelId: '11111111-1111-4111-8111-111111111111',
  panelSecret: 'secret-value',
  masterUniqueId: '22222222-2222-4222-8222-222222222222',
  masterHost: '192.168.1.10',
  masterPort: 4100,
  companyName: 'Shree Ceramics',
  pairedAt: '2026-08-20T10:00:00.000Z',
};

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-office-'));
  credentialsFile = path.join(dataDir, 'pairing.json');
  // The module caches its last read; clearing it keeps tests independent.
  await store.clearCredentials();
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('credentials store', () => {
  it('reports no credentials before pairing', async () => {
    expect(await store.loadCredentials()).toBeNull();
  });

  it('round-trips saved credentials', async () => {
    await store.saveCredentials(sample);
    expect(await store.loadCredentials()).toEqual(sample);
  });

  it('persists to disk so a restart stays paired', async () => {
    await store.saveCredentials(sample);

    const onDisk = JSON.parse(await fs.readFile(credentialsFile, 'utf8'));
    expect(onDisk).toEqual(sample);
  });

  it('writes the file with owner-only permissions, since it holds a secret', async () => {
    await store.saveCredentials(sample);

    if (process.platform !== 'win32') {
      const stats = await fs.stat(credentialsFile);
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });

  it('creates the data directory if it does not exist yet', async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
    await store.saveCredentials(sample);

    expect(await store.loadCredentials()).toEqual(sample);
  });

  it('treats a corrupt file as unpaired instead of throwing', async () => {
    await store.saveCredentials(sample);
    await fs.writeFile(credentialsFile, 'this is not json');

    // Force a re-read past the in-memory cache.
    await store.clearCredentials();
    await fs.writeFile(credentialsFile, 'this is not json');

    expect(await store.loadCredentials()).toBeNull();
  });

  it('forgets credentials when the master revokes the panel', async () => {
    await store.saveCredentials(sample);
    await store.clearCredentials();

    expect(await store.loadCredentials()).toBeNull();
    await expect(fs.access(credentialsFile)).rejects.toThrow();
  });

  it('builds the master base URL from the stored address', () => {
    expect(store.masterBaseUrl(sample)).toBe('http://192.168.1.10:4100');
  });
});
