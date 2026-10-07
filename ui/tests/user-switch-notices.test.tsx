/**
 * D6 chain audit: after A signs out and B signs in, nothing of A's may render for B.
 *
 *  · The Master's `useNotices` lives in the shell, which stays mounted across a sign-out: it starts
 *    empty for a different person on the first render, and drops an answer A's read brings late.
 *  · Both panels' shared read cache (`requestCache`) is dropped by signing in and by signing out,
 *    so a per-person list read for A (parties under Party Access, say) is never served to B.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notice } from '@orderbook/shared';

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

beforeEach(() => {
  installBrowserStubs();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Master useNotices across a user switch', () => {
  it('starts empty for the next person on the first render, and drops the previous person’s late answer', async () => {
    const pending: Array<(value: Response) => void> = [];
    routeFetch((call) => {
      if (call.url !== '/api/notices') return undefined;
      return new Promise<Response>((resolve) => pending.push(resolve));
    });
    const { useNotices } = (await import(
      /* @vite-ignore */ '../../master/web/src/useNotices.ts'
    )) as typeof import('../../master/web/src/useNotices');

    const { result, rerender } = renderHook(({ user }) => useNotices(0, true, user), {
      initialProps: { user: 'A' as string | null },
    });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]!(json({ notices: [notice('for-admins')], unreadCount: 1 }));
    });
    expect(result.current.notices.map((n) => n.id)).toEqual(['for-admins']);
    expect(result.current.unread).toBe(1);

    // A re-read starts for A, then A signs out and B signs in before it answers.
    rerender({ user: 'A' });
    rerender({ user: 'B' });
    expect(result.current.notices).toEqual([]);
    expect(result.current.unread).toBeUndefined();

    await vi.waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      pending.at(-1)!(json({ notices: [], unreadCount: 0 }));
    });
    expect(result.current.notices).toEqual([]);
  });

  it('keeps a late answer for A from landing after B is signed in', async () => {
    const pending: Array<(value: Response) => void> = [];
    routeFetch((call) =>
      call.url === '/api/notices'
        ? new Promise<Response>((resolve) => pending.push(resolve))
        : undefined,
    );
    const { useNotices } = (await import(
      /* @vite-ignore */ '../../master/web/src/useNotices.ts'
    )) as typeof import('../../master/web/src/useNotices');

    const { result, rerender } = renderHook(({ user }) => useNotices(0, true, user), {
      initialProps: { user: 'A' as string | null },
    });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    // B's sign-in invalidates the panel's reads, as every non-GET does when it settles.
    const { invalidateReads } = (await import(
      /* @vite-ignore */ '../../master/web/src/api.ts'
    )) as { invalidateReads: () => void };
    invalidateReads();
    rerender({ user: 'B' });
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
