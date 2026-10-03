/**
 * "Check now" (`checkNow` in `services/update.service.ts`, 1.4 R6): it asks
 * GitHub straight away and answers within the short wait rather than when a
 * 150 MB download ends; presses closer together than the cool-down share the
 * first one's answer; and the poll and the button both finish by telling
 * everybody (`afterSync`).
 *
 * GitHub itself is mocked; the releases folder is empty, which reads "nothing
 * to install" without touching the network or the database.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  syncFromGitHub: vi.fn(async () => null as unknown),
  forgetLatestRelease: vi.fn(),
}));

vi.mock('../src/services/github-releases.js', () => ({
  syncFromGitHub: mocks.syncFromGitHub,
  forgetLatestRelease: mocks.forgetLatestRelease,
  downloadProgress: vi.fn(() => ({ phase: 'idle' })),
}));
vi.mock('../src/db/knex.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: vi.fn(() => ({})),
}));

describe('checkNow', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.syncFromGitHub.mockReset();
    mocks.syncFromGitHub.mockResolvedValue(null);
    mocks.forgetLatestRelease.mockReset();
  });

  it('forgets the cached release, syncs both builds and stamps the time', async () => {
    const service = await import('../src/services/update.service.js');
    expect(service.lastChecked()).toBeNull();

    await service.checkNow();

    expect(mocks.forgetLatestRelease).toHaveBeenCalledTimes(1);
    // The Master's build and the office build for the Master's own OS, at least.
    const panels = mocks.syncFromGitHub.mock.calls.map((call) => (call as unknown as string[])[0]);
    expect(panels).toContain('master');
    expect(panels).toContain('office');
    expect(service.lastChecked()).not.toBeNull();
  });

  it('shares one answer between presses inside the cool-down, so the API allowance is safe', async () => {
    const service = await import('../src/services/update.service.js');
    await service.checkNow();
    const syncs = mocks.syncFromGitHub.mock.calls.length;

    await service.checkNow();
    await service.checkNow();

    expect(mocks.forgetLatestRelease).toHaveBeenCalledTimes(1);
    // `availability` still asks once per press (it is cached underneath), but no extra full sweep.
    expect(mocks.syncFromGitHub.mock.calls.length - syncs).toBeLessThanOrEqual(4);
  });

  it('answers within the wait while a slow download carries on in the background', async () => {
    // Only the wait is faked: the folder is read for real, and file reads are not timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending: Array<(value: null) => void> = [];
      mocks.syncFromGitHub.mockImplementation(
        () => new Promise((resolve) => void pending.push(resolve as (value: null) => void)),
      );
      const service = await import('../src/services/update.service.js');

      const answer = service.checkNow();
      // Two waits of at most five seconds each: the check's own, then the one
      // `availability` makes before it reads the folder.
      let settled = false;
      void answer.then(() => (settled = true));
      for (let step = 0; step < 6 && !settled; step += 1) {
        await vi.advanceTimersByTimeAsync(6_000);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(settled).toBe(true);
      await expect(answer).resolves.toMatchObject({ master: { current: expect.any(String) } });
      // The sync has not finished, so nothing has been stamped yet.
      expect(service.lastChecked()).toBeNull();

      // The sweep asks for the next build once each one lets go, so keep letting go.
      await vi.waitFor(() => {
        for (const resolve of pending) resolve(null);
        expect(service.lastChecked()).not.toBeNull();
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
