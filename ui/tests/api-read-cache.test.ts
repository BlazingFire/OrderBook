/**
 * The read cache as the two panels' `api.ts` use it: how many requests a run of screen visits
 * really costs, with the change feed live (cache on) and not (cache off, the old behaviour).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api as masterApi, requestCache as masterCache } from '../../master/web/src/api';
import { api as officeApi, requestCache as officeCache } from '../../office/web/src/api';

interface Seen {
  method: string;
  path: string;
}

let seen: Seen[] = [];

beforeEach(() => {
  seen = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      seen.push({ method: (init?.method ?? 'GET').toUpperCase(), path });
      return Promise.resolve(
        new Response(JSON.stringify(path.includes('option-lists') ? [{ id: 'OL1' }] : { rows: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
  masterCache.reset();
  officeCache.reset();
});

afterEach(() => {
  masterCache.setLive(false);
  officeCache.setLive(false);
  vi.unstubAllGlobals();
});

const gets = (path: string) => seen.filter((call) => call.method === 'GET' && call.path.startsWith(path)).length;

/** A person moving around: the same three lists read again each time a screen opens. */
async function visitScreens(read: () => Promise<unknown>[], rounds: number): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await Promise.all(read());
}

describe('the Master panel read cache', () => {
  const lists = () => [masterApi.optionLists(), masterApi.pipelines(), masterApi.leads()];

  it('without a live change feed every visit is a request (the behaviour before the cache)', async () => {
    await visitScreens(lists, 6);
    expect(seen.filter((call) => call.method === 'GET')).toHaveLength(18);
  });

  it('with the feed live, six rounds of the same three reads cost three requests', async () => {
    masterCache.setLive(true);
    await visitScreens(lists, 6);
    expect(seen.filter((call) => call.method === 'GET')).toHaveLength(3);
  });

  it('a change event drops everything, so the next visit reads again', async () => {
    masterCache.setLive(true);
    await visitScreens(lists, 2);
    masterCache.invalidate(); // what the shell does on every data:changed
    await visitScreens(lists, 2);
    expect(gets('/api/option-lists')).toBe(2);
  });

  it('a write drops everything, so a screen that saves and re-reads sees its own change', async () => {
    masterCache.setLive(true);
    await masterApi.leads();
    await masterApi.createLead({} as never);
    await masterApi.leads();
    expect(gets('/api/leads')).toBe(3 - 1); // the two reads; the POST is not a GET
    expect(seen.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('never caches what must be asked every time', async () => {
    masterCache.setLive(true);
    await masterApi.me();
    await masterApi.me();
    expect(gets('/api/auth/me')).toBe(2);
  });
});

describe('the Office panel read cache', () => {
  it('serves repeat reads from memory while the stream is up, and asks again when it is not', async () => {
    officeCache.setLive(true);
    await visitScreens(() => [officeApi.fieldsCatalogue()], 4);
    const live = seen.length;
    officeCache.setLive(false);
    await visitScreens(() => [officeApi.fieldsCatalogue()], 4);
    expect(live).toBeLessThanOrEqual(1);
    expect(seen.length - live).toBe(4);
  });
});
