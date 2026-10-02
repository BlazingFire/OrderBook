/**
 * The loading strip and the determinate bar.
 *
 * The strip must not flicker for a quick read (nothing before 300 ms), must
 * show while slower work is in flight, and must go once it settles, whether
 * it succeeded or failed.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoadingMark, ProgressBar, TopProgress, trackLoad } from '../src/TopProgress.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const strip = () => screen.queryByRole('progressbar');

describe('TopProgress', () => {
  it('stays hidden for the first 300 ms, then shows until the work settles', async () => {
    render(<TopProgress />);
    const work = deferred();
    let tracked!: Promise<void>;
    act(() => {
      tracked = trackLoad(work.promise);
    });

    act(() => vi.advanceTimersByTime(299));
    expect(strip()).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(strip()).not.toBeNull();

    await act(async () => {
      work.resolve();
      await tracked;
    });
    expect(strip()).toBeNull();
  });

  it('never shows for work that finishes inside 300 ms', async () => {
    render(<TopProgress />);
    const work = deferred();
    let tracked!: Promise<void>;
    act(() => {
      tracked = trackLoad(work.promise);
    });
    act(() => vi.advanceTimersByTime(100));
    await act(async () => {
      work.resolve();
      await tracked;
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(strip()).toBeNull();
  });

  it('drops the count when the work fails, and hands the failure back', async () => {
    render(<TopProgress />);
    const work = deferred();
    let tracked!: Promise<void>;
    act(() => {
      tracked = trackLoad(work.promise);
    });
    act(() => vi.advanceTimersByTime(300));
    expect(strip()).not.toBeNull();

    await act(async () => {
      work.reject(new Error('offline'));
      await expect(tracked).rejects.toThrow('offline');
    });
    expect(strip()).toBeNull();
  });

  it('counts a mounted LoadingMark as loading', () => {
    const { rerender } = render(
      <>
        <TopProgress />
        <LoadingMark />
      </>,
    );
    act(() => vi.advanceTimersByTime(300));
    expect(strip()).not.toBeNull();

    rerender(<TopProgress />);
    expect(strip()).toBeNull();
  });
});

describe('ProgressBar', () => {
  it('reports a determinate value as a percentage', () => {
    render(<ProgressBar value={0.42} label="Exporting" />);
    const bar = screen.getByRole('progressbar', { name: 'Exporting' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByText('Exporting')).toBeTruthy();
  });

  it('has no value while the size of the job is unknown', () => {
    render(<ProgressBar value={null} />);
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
  });
});
