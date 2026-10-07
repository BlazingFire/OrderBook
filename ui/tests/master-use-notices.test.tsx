/**
 * V6: the Master's notice hook forgets the last person's list when they sign out, so the sign-in
 * pop-up of whoever signs in next never decides on somebody else's notices.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const notices = vi.fn();
vi.mock('../../master/web/src/api', () => ({ api: { notices: () => notices(), markNoticesRead: vi.fn() } }));

const { useNotices } = await import('../../master/web/src/useNotices');

const ONE = { id: 'NT1', priority: 'important', readByMe: false };

describe('useNotices (Master)', () => {
  it('is unloaded and empty again once signed out, until the next read answers', async () => {
    notices.mockResolvedValue({ notices: [ONE], unreadCount: 1 });
    const hook = renderHook(({ enabled }) => useNotices(0, enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    expect(hook.result.current.notices).toEqual([ONE]);

    hook.rerender({ enabled: false });
    expect(hook.result.current.loaded).toBe(false);
    expect(hook.result.current.notices).toEqual([]);

    notices.mockResolvedValue({ notices: [], unreadCount: 0 });
    hook.rerender({ enabled: true });
    expect(hook.result.current.loaded).toBe(false);
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    expect(hook.result.current.notices).toEqual([]);
  });
});
