/**
 * Collects items that arrive in a burst and hands them over together, once the burst has had
 * `windowMs` to gather.
 *
 * The change feeds deliver one frame per changed record, and a bulk import or a catch-up after
 * a pause sends hundreds inside a second. Applying each frame the moment it lands meant one
 * React state update — one render of the shell and of every screen that follows the entity —
 * per frame. Batching turns that into one update per window, with every item still delivered,
 * in arrival order.
 *
 * The window starts at the first item and does not slide, so a steady stream is flushed every
 * `windowMs` rather than never.
 */
export interface BurstBatcher<T> {
  push(item: T): void;
  /** Hand over what is waiting now (used when a newer, complete answer makes the queue moot, pass `discard`). */
  flush(): void;
  /** Throw away what is waiting without delivering it. */
  discard(): void;
  /** Stop the pending timer (the owner is going away); waiting items are dropped. */
  dispose(): void;
}

export function createBurstBatcher<T>(deliver: (items: T[]) => void, windowMs: number): BurstBatcher<T> {
  let queue: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (queue.length === 0) return;
    const items = queue;
    queue = [];
    deliver(items);
  };

  return {
    push(item) {
      queue.push(item);
      if (!timer) timer = setTimeout(flush, windowMs);
    },
    flush,
    discard() {
      queue = [];
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      queue = [];
    },
  };
}
