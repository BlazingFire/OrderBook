import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBurstBatcher } from '../src/burstBatch';

afterEach(() => vi.useRealTimers());

describe('the burst batcher', () => {
  it('delivers a burst once, with every item in arrival order', () => {
    vi.useFakeTimers();
    const delivered: number[][] = [];
    const batch = createBurstBatcher<number>((items) => delivered.push(items), 80);
    for (let i = 1; i <= 50; i += 1) {
      batch.push(i);
      vi.advanceTimersByTime(1);
    }
    expect(delivered).toEqual([]); // nothing yet: the window is still open
    vi.advanceTimersByTime(80);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('does not slide: a steady stream is flushed every window, not held for ever', () => {
    vi.useFakeTimers();
    const delivered: number[][] = [];
    const batch = createBurstBatcher<number>((items) => delivered.push(items), 80);
    for (let i = 0; i < 400; i += 1) {
      batch.push(i);
      vi.advanceTimersByTime(1);
    }
    vi.advanceTimersByTime(80);
    expect(delivered.length).toBeGreaterThanOrEqual(4);
    expect(delivered.flat()).toHaveLength(400);
  });

  it('discard drops what is waiting, and dispose cancels the timer', () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const batch = createBurstBatcher<number>(deliver, 80);
    batch.push(1);
    batch.discard();
    vi.advanceTimersByTime(200);
    expect(deliver).not.toHaveBeenCalled();
    batch.push(2);
    batch.dispose();
    vi.advanceTimersByTime(200);
    expect(deliver).not.toHaveBeenCalled();
  });
});
