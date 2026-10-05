/**
 * The shared limiter (`http/middleware/rate-limit.ts`) and the write-invalidated cache
 * (`lib/seq-cache.ts`), without a database.
 */

import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRateLimits } from '../src/http/middleware/api-key-rate-limit.js';
import { limitByBodyField, limitByIp, limitSocket, limitUploads } from '../src/http/middleware/rate-limit.js';
import { TooManyRequestsError } from '../src/lib/errors.js';
import { seqCached, resetSeqCache } from '../src/lib/seq-cache.js';
import { record, resetChangeRing } from '../src/realtime/change-ring.js';

function run(handler: ReturnType<typeof limitByIp>, req: Partial<Request>): unknown {
  const next = vi.fn();
  handler({ method: 'POST', ip: '192.168.1.5', body: {}, ...req } as Request, {} as Response, next);
  return next.mock.calls[0]?.[0];
}

beforeEach(() => {
  resetRateLimits();
  resetSeqCache();
  resetChangeRing();
});

describe('limitByIp', () => {
  it('lets the first N through and answers rate_limited with retryAfterSeconds after', () => {
    const limiter = limitByIp('t', 3);
    for (let i = 0; i < 3; i += 1) expect(run(limiter, {})).toBeUndefined();

    const refused = run(limiter, {}) as TooManyRequestsError;
    expect(refused).toBeInstanceOf(TooManyRequestsError);
    expect(refused.code).toBe('rate_limited');
    expect(refused.statusCode).toBe(429);
    expect(refused.details?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts one address once whether or not it arrives IPv6-mapped, and keeps others apart', () => {
    const limiter = limitByIp('t', 2);
    run(limiter, { ip: '::ffff:10.0.0.1' });
    run(limiter, { ip: '10.0.0.1' });
    expect(run(limiter, { ip: '10.0.0.1' })).toBeInstanceOf(TooManyRequestsError);
    expect(run(limiter, { ip: '10.0.0.2' })).toBeUndefined();
  });

  it('keeps routes apart and lets reads through when writesOnly', () => {
    const a = limitByIp('a', 1, { writesOnly: true });
    const b = limitByIp('b', 1);
    run(a, {});
    expect(run(a, { method: 'GET' })).toBeUndefined();
    expect(run(a, {})).toBeInstanceOf(TooManyRequestsError);
    expect(run(b, {})).toBeUndefined();
  });
});

describe('limitByBodyField', () => {
  it('counts per username regardless of case, and ignores a missing one', () => {
    const limiter = limitByBodyField('s', 'username', 2);
    run(limiter, { body: { username: 'Asha' } });
    run(limiter, { body: { username: ' asha ' } });
    expect(run(limiter, { body: { username: 'ASHA' } })).toBeInstanceOf(TooManyRequestsError);
    expect(run(limiter, { body: { username: 'ravi' } })).toBeUndefined();
    for (let i = 0; i < 5; i += 1) expect(run(limiter, { body: {} })).toBeUndefined();
  });
});

describe('limitUploads', () => {
  it('counts only multipart requests', () => {
    const limiter = limitUploads(1);
    const multipart = { is: () => 'multipart/form-data' } as unknown as Partial<Request>;
    const json = { is: () => false } as unknown as Partial<Request>;
    expect(run(limiter, multipart)).toBeUndefined();
    for (let i = 0; i < 5; i += 1) expect(run(limiter, json)).toBeUndefined();
    expect(run(limiter, multipart)).toBeInstanceOf(TooManyRequestsError);
  });
});

describe('limitSocket', () => {
  function fakeSocket() {
    let middleware: (packet: unknown[], next: () => void) => void = () => {};
    return {
      socket: {
        id: 's1',
        use: (fn: typeof middleware) => (middleware = fn),
        on: vi.fn(),
      },
      send: (...packet: unknown[]) => {
        const next = vi.fn();
        middleware(packet, next);
        return next.mock.calls.length === 1;
      },
    };
  }

  it('answers an over-limit command through its ack and drops one without an ack', () => {
    const { socket, send } = fakeSocket();
    limitSocket(socket as never, 2);
    const ack = vi.fn();
    expect(send('lead:list', {}, ack)).toBe(true);
    expect(send('lead:list', {}, ack)).toBe(true);
    expect(send('lead:list', {}, ack)).toBe(false);
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, code: 'rate_limited', messageKey: 'error.rateLimited' }),
    );
    expect(send('presence:beat', {})).toBe(false);
  });
});

describe('seqCached', () => {
  it('serves the same answer until a change is recorded, then recomputes', async () => {
    const compute = vi.fn(async () => Math.random());
    const first = await seqCached('k', 60_000, compute);
    expect(await seqCached('k', 60_000, compute)).toBe(first);
    expect(compute).toHaveBeenCalledTimes(1);

    record({ entity: 'product', action: 'updated', id: 'p1', payload: { id: 'p1' } });
    await seqCached('k', 60_000, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('expires on the TTL, shares one computation, and never keeps a rejection', async () => {
    const compute = vi.fn(async () => 1);
    await seqCached('t', 1_000, compute, 0);
    await seqCached('t', 1_000, compute, 500);
    expect(compute).toHaveBeenCalledTimes(1);
    await seqCached('t', 1_000, compute, 1_500);
    expect(compute).toHaveBeenCalledTimes(2);

    const [a, b] = [seqCached('c', 1_000, compute), seqCached('c', 1_000, compute)];
    expect(await a).toBe(await b);
    expect(compute).toHaveBeenCalledTimes(3);

    const failing = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('ok');
    await expect(seqCached('f', 1_000, failing)).rejects.toThrow('boom');
    await expect(seqCached('f', 1_000, failing)).resolves.toBe('ok');
  });
});

describe('chat history cache signal', () => {
  it('a chat push (publishChat) drops cached entries though no ring change was recorded', async () => {
    const { publishChat } = await import('../src/services/change-bus.js');
    const compute = vi.fn(async () => 1);
    await seqCached('chat', 60_000, compute);
    await seqCached('chat', 60_000, compute);
    expect(compute).toHaveBeenCalledTimes(1);

    publishChat({ tenantId: 't', userIds: [], push: {} } as never);
    await seqCached('chat', 60_000, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
