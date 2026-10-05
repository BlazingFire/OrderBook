import { describe, expect, it } from 'vitest';

import { createRequestCache, isCacheableRead } from '../src/requestCache';

function setup() {
  let clock = 1_000;
  const cache = createRequestCache({ freshMs: 1_000, maxAgeMs: 10_000, now: () => clock });
  cache.setLive(true);
  return {
    cache,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** A loader that answers from `answers`, counting how often the network was asked. */
function loader<T>(answers: T[]) {
  let calls = 0;
  const load = () => Promise.resolve(answers[Math.min(calls++, answers.length - 1)]!);
  return { load, calls: () => calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the shared request cache', () => {
  it('answers a repeat read from memory while the entry is fresh', async () => {
    const { cache } = setup();
    const net = loader([{ rows: [1] }]);
    expect(await cache.get('/api/leads', net.load)).toEqual({ rows: [1] });
    expect(await cache.get('/api/leads', net.load)).toEqual({ rows: [1] });
    expect(net.calls()).toBe(1);
    expect(cache.stats()).toMatchObject({ misses: 1, hits: 1 });
  });

  it('serves an older entry at once and reads again behind it (stale-while-revalidate)', async () => {
    const { cache, advance } = setup();
    const net = loader([{ v: 1 }, { v: 2 }]);
    const heard: string[] = [];
    cache.subscribe((key) => heard.push(key));

    await cache.get('/api/orders', net.load);
    advance(5_000);
    expect(await cache.get('/api/orders', net.load)).toEqual({ v: 1 }); // stale answer, immediately
    await settle();
    expect(net.calls()).toBe(2); // refreshed in the background
    expect(heard).toEqual(['/api/orders']); // the answer differed, so subscribers heard
    expect(await cache.get('/api/orders', net.load)).toEqual({ v: 2 });
  });

  it('does not tell subscribers when the refresh brought the same answer', async () => {
    const { cache, advance } = setup();
    const net = loader([{ v: 1 }, { v: 1 }]);
    const heard: string[] = [];
    cache.subscribe((key) => heard.push(key));
    await cache.get('/api/orders', net.load);
    advance(5_000);
    await cache.get('/api/orders', net.load);
    await settle();
    expect(heard).toEqual([]);
  });

  it('never serves an entry older than the maximum age', async () => {
    const { cache, advance } = setup();
    const net = loader([{ v: 1 }, { v: 2 }]);
    await cache.get('/api/parties', net.load);
    advance(11_000);
    expect(await cache.get('/api/parties', net.load)).toEqual({ v: 2 });
    expect(net.calls()).toBe(2);
  });

  it('forgets everything on invalidate, so the next read asks again', async () => {
    const { cache } = setup();
    const net = loader([{ v: 1 }, { v: 2 }]);
    await cache.get('/api/leads', net.load);
    cache.invalidate();
    expect(await cache.get('/api/leads', net.load)).toEqual({ v: 2 });
    expect(net.calls()).toBe(2);
  });

  it('does not store a read that was in flight when an invalidation happened', async () => {
    const { cache } = setup();
    let release: (value: { v: number }) => void = () => undefined;
    const slow = () => new Promise<{ v: number }>((resolve) => (release = resolve));
    const pending = cache.get('/api/leads', slow);
    cache.invalidate(); // a change event lands while the read is on its way
    release({ v: 1 });
    expect(await pending).toEqual({ v: 1 }); // the caller still gets its answer
    const net = loader([{ v: 2 }]);
    expect(await cache.get('/api/leads', net.load)).toEqual({ v: 2 }); // but it was not kept
    expect(net.calls()).toBe(1);
  });

  it('bypasses the cache entirely while the change feed is down, and starts empty when it returns', async () => {
    const { cache } = setup();
    const net = loader([{ v: 1 }, { v: 2 }, { v: 3 }]);
    await cache.get('/api/leads', net.load);
    cache.setLive(false);
    await cache.get('/api/leads', net.load);
    await cache.get('/api/leads', net.load);
    expect(net.calls()).toBe(3);
    cache.setLive(true);
    expect(cache.stats().bypasses).toBe(2);
    await cache.get('/api/leads', net.load);
    expect(net.calls()).toBe(4); // nothing from before the outage survives
  });

  it('hands out copies, so a screen that edits its answer cannot corrupt the next one', async () => {
    const { cache } = setup();
    const net = loader([{ rows: [{ id: 'a' }] }]);
    const first = await cache.get<{ rows: { id: string }[] }>('/api/leads', net.load);
    first.rows.push({ id: 'edited' });
    const second = await cache.get<{ rows: { id: string }[] }>('/api/leads', net.load);
    expect(second.rows).toEqual([{ id: 'a' }]);
  });

  it('keeps the old answer when a background refresh fails', async () => {
    const { cache, advance } = setup();
    let calls = 0;
    const load = () => (calls++ === 0 ? Promise.resolve({ v: 1 }) : Promise.reject(new Error('down')));
    await cache.get('/api/leads', load);
    advance(5_000);
    expect(await cache.get('/api/leads', load)).toEqual({ v: 1 });
    await settle();
    expect(await cache.get('/api/leads', load)).toEqual({ v: 1 });
  });
});

describe('which reads are cacheable', () => {
  it('takes lists and records of company data, with or without a query', () => {
    for (const path of [
      '/api/leads',
      '/api/leads?limit=200',
      '/api/leads/LD0000000001',
      '/api/option-lists',
      '/api/fields/definitions?x=1',
      '/api/access/roles',
      '/api/reports/table/sales?a=1',
    ]) {
      expect(isCacheableRead(path), path).toBe(true);
    }
  });

  it('leaves status polls, progress, the signed-in user, notifications and setup to the network', () => {
    for (const path of [
      '/api/updates/progress',
      '/api/updates/status',
      '/api/auth/me',
      '/api/notifications',
      '/api/setup/status',
      '/api/health',
      '/api/panels/pairing-window',
      '/api/leads-export',
      '/api/chat/rooms',
    ]) {
      expect(isCacheableRead(path), path).toBe(false);
    }
  });
});
