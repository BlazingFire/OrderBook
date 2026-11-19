/**
 * 1.5.9's reset on an Office (owner, 2026-11-19: queued offline orders are discarded too):
 * the first snapshot carrying a new reset epoch drops the unsent orders and catalogue edits,
 * keeps party edits, and does it once per epoch, across restarts.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;

async function loadModules() {
  const device = await import('../src/sync/device.js');
  const outbox = await import('../src/sync/outbox.store.js');
  const reset = await import('../src/sync/release-reset.js');
  device.resetDeviceCache();
  outbox.resetOutboxCache();
  return { outbox, reset };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-office-reset-'));
  process.env.ORDERBOOK_OFFICE_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.ORDERBOOK_OFFICE_DATA_DIR;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('the Office side of the 1.5.9 reset', () => {
  it('drops unsent orders and catalogue edits once, and keeps party edits', async () => {
    const { outbox, reset } = await loadModules();
    await outbox.enqueue({ kind: 'lead.create', entity: 'lead', entityId: 'A3F9K2000000001', payload: {} });
    await outbox.enqueue({ kind: 'order.setStage', entity: 'order', entityId: 'OR0000000001', payload: {} });
    await outbox.enqueue({ kind: 'product.update', entity: 'product', entityId: 'PR0000000001', payload: {} });
    await outbox.enqueue({ kind: 'party.create', entity: 'party', entityId: 'A3F9K2000000002', payload: {} });

    // No reset yet: nothing is touched.
    expect(await reset.applyResetEpoch(null)).toBe(0);
    expect(await outbox.pendingCount()).toBe(4);

    expect(await reset.applyResetEpoch('epoch-1')).toBe(3);
    expect((await outbox.pending()).map((mutation) => mutation.kind)).toEqual(['party.create']);
    expect(await reset.readSeenReset()).toMatchObject({ epoch: 'epoch-1', dropped: 3 });

    // The same reset again (the next snapshot, or after a restart) drops nothing new.
    await outbox.enqueue({ kind: 'lead.create', entity: 'lead', entityId: 'A3F9K2000000003', payload: {} });
    expect(await reset.applyResetEpoch('epoch-1')).toBe(0);
    expect(await outbox.pendingCount()).toBe(2);
  });

  it('records a reset with nothing to drop, so a new panel is not told anything', async () => {
    const { outbox, reset } = await loadModules();
    expect(await reset.applyResetEpoch('epoch-1')).toBe(0);
    expect(await reset.readSeenReset()).toMatchObject({ epoch: 'epoch-1', dropped: 0 });
    expect(await outbox.pendingCount()).toBe(0);
  });
});
