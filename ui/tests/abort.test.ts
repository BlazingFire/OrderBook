/**
 * anySignal: `AbortSignal.any` for Chromium 108 (the Windows 7 Office build).
 */

import { describe, expect, it } from 'vitest';

import { anySignal } from '../src/abort.js';

describe('anySignal', () => {
  it('aborts when either input aborts, with that input’s reason', () => {
    for (const which of [0, 1]) {
      const inputs = [new AbortController(), new AbortController()];
      const joined = anySignal(inputs.map((c) => c.signal));
      expect(joined.aborted).toBe(false);

      const reason = new Error(`input ${which}`);
      inputs[which]!.abort(reason);
      expect(joined.aborted).toBe(true);
      expect(joined.reason).toBe(reason);
    }
  });

  it('returns an already-aborted signal for an already-aborted input', () => {
    const live = new AbortController();
    const joined = anySignal([live.signal, AbortSignal.abort('gone')]);
    expect(joined.aborted).toBe(true);
    expect(joined.reason).toBe('gone');
  });

  it('ignores a later abort of the other input once settled', () => {
    const first = new AbortController();
    const second = new AbortController();
    const joined = anySignal([first.signal, second.signal]);
    let fired = 0;
    joined.addEventListener('abort', () => fired++);

    first.abort('first');
    second.abort('second');
    expect(fired).toBe(1);
    expect(joined.reason).toBe('first');
  });

  it('carries a timeout input’s TimeoutError, which api.ts tells apart from a cancel', async () => {
    const caller = new AbortController();
    const joined = anySignal([caller.signal, AbortSignal.timeout(1)]);
    await new Promise((resolve) => joined.addEventListener('abort', resolve, { once: true }));
    expect((joined.reason as DOMException).name).toBe('TimeoutError');
    expect(caller.signal.aborted).toBe(false);
  });
});
