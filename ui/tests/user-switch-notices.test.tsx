/**
 * D6 chain audit: after A signs out and B signs in, nothing of A's may render for B.
 *
 *  · The Master's `useNotices` lives in the shell, which stays mounted across a sign-out: D11's reset
 *    (d90cc45) leaves it empty for the next person's first render, and A's late answer is dropped.
 *  · A read started under A and still on its way is not joined by B's first identical read
 *    (`invalidateReads()` drops the in-flight map too, both panels).
 *  · Both panels' shared read cache (`requestCache`) is dropped by signing in and by signing out,
 *    so a per-person list read for A (parties under Party Access, say) is never served to B.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notice } from '@orderbook/shared';

import type { useNotices as UseNotices } from '../../master/web/src/useNotices';

import { installBrowserStubs, json, routeFetch, type Call } from './panel-harness.js';

const notice = (id: string): Notice =>
  ({
    id,
    title: id,
    body: '',
    priority: 'important',
    pinned: false,
    showUntil: null,
    audience: { kind: 'roles', roleIds: ['r-admin'] },
    authorId: null,
    authorName: null,
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
    version: 1,
    readByMe: false,
  }) as Notice;

beforeEach(async () => {
  installBrowserStubs();
  // The panels' api modules live for the whole file: nothing one test left on its way may answer the next.
  for (const panel of ['master', 'office']) {
    const api = (await import(/* @vite-ignore */ `../../${panel}/web/src/api.ts`)) as {
      invalidateReads: () => void;
    };
    api.invalidateReads();
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The shell renders the hook with `enabled` false while nobody is signed in (`canViewNotices`
// needs a user), so a switch from A to B always passes through it, as here.
describe('Master useNotices across a user switch (D11 d90cc45 resets it)', () => {
  it('is empty on the first render for the next person', async () => {
    const pending: Array<(value: Response) => void> = [];
    routeFetch((call) =>
      call.url === '/api/notices'
        ? new Promise<Response>((resolve) => pending.push(resolve))
        : undefined,
    );
    const { useNotices } = (await import(
      /* @vite-ignore */ '../../master/web/src/useNotices.ts'
    )) as { useNotices: typeof UseNotices };

    const { result, rerender } = renderHook(({ on }) => useNotices(0, on), {
      initialProps: { on: true },
    });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]!(json({ notices: [notice('for-admins')], unreadCount: 1 }));
    });
    expect(result.current.notices.map((n) => n.id)).toEqual(['for-admins']);

    rerender({ on: false }); // A signs out
    rerender({ on: true }); // B signs in: B's first render
    expect(result.current.notices).toEqual([]);
    expect(result.current.unread).toBeUndefined();
  });

  it('keeps a late answer for A from landing after B is signed in, and B reads on its own', async () => {
    const pending: Array<(value: Response) => void> = [];
    routeFetch((call) =>
      call.url === '/api/notices'
        ? new Promise<Response>((resolve) => pending.push(resolve))
        : undefined,
    );
    const { useNotices } = (await import(
      /* @vite-ignore */ '../../master/web/src/useNotices.ts'
    )) as { useNotices: typeof UseNotices };
    const { invalidateReads } = (await import(
      /* @vite-ignore */ '../../master/web/src/api.ts'
    )) as { invalidateReads: () => void };

    const { result, rerender } = renderHook(({ on }) => useNotices(0, on), {
      initialProps: { on: true },
    });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    rerender({ on: false }); // A signs out while A's read is on its way
    invalidateReads(); // the sign-out / sign-in POSTs invalidate as they settle
    rerender({ on: true }); // B
    // B's read is its own request, not a share of A's still on its way.
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[0]!(json({ notices: [notice('for-admins')], unreadCount: 1 }));
    });
    expect(result.current.notices).toEqual([]);
    await act(async () => {
      pending[1]!(json({ notices: [notice('for-everyone')], unreadCount: 1 }));
    });
    expect(result.current.notices.map((n) => n.id)).toEqual(['for-everyone']);
  });
});

describe.each(['master', 'office'] as const)(
  '%s: the read cache across sign-in and sign-out',
  (panel) => {
    it('reads a cached list again after signing out and after signing in', async () => {
      const calls: Call[] = routeFetch((call) => {
        if (call.url.startsWith('/api/categories')) return json([]);
        if (call.url.startsWith('/api/auth/')) return json({ ok: true });
        return undefined;
      });
      const { api, requestCache } = (await import(
        /* @vite-ignore */ `../../${panel}/web/src/api.ts`
      )) as {
        api: {
          categories: () => Promise<unknown>;
          signOut: () => Promise<unknown>;
          signIn: (username: string, password: string) => Promise<unknown>;
        };
        requestCache: { setLive: (live: boolean) => void; reset: () => void };
      };
      requestCache.reset();
      requestCache.setLive(true);
      const reads = () => calls.filter((call) => call.url.startsWith('/api/categories')).length;

      await api.categories();
      await api.categories();
      expect(reads()).toBe(1); // the second answered from the cache

      await api.signOut();
      await api.categories();
      expect(reads()).toBe(2);

      await api.signIn('b', 'secret');
      await api.categories();
      expect(reads()).toBe(3);
      requestCache.setLive(false);
    });
  },
);
