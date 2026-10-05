/** A stray error is logged and survived; a flood of them stops the process cleanly. */

import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { installCrashGuard, type ProcessLike } from '../src/index.js';

function setup(max = 3) {
  const proc = new EventEmitter();
  const log = { error: vi.fn() };
  const onRepeated = vi.fn();
  let clock = 0;
  installCrashGuard(proc as unknown as ProcessLike, log, {
    max,
    windowMs: 1000,
    now: () => clock,
    onRepeated,
  });
  return { proc, log, onRepeated, at: (ms: number) => (clock = ms) };
}

describe('installCrashGuard', () => {
  it('logs an unhandled rejection and an uncaught exception and does not stop', () => {
    const { proc, log, onRepeated } = setup();

    proc.emit('unhandledRejection', new Error('a broadcast failed'));
    proc.emit('uncaughtException', new Error('a thrown error'));

    expect(log.error).toHaveBeenCalledWith('Unhandled rejection', expect.any(Error));
    expect(log.error).toHaveBeenCalledWith('Uncaught exception', expect.any(Error));
    expect(onRepeated).not.toHaveBeenCalled();
  });

  it('stops, once, when the limit is passed inside the window', () => {
    const { proc, onRepeated } = setup(3);

    for (let i = 0; i < 6; i += 1) proc.emit('uncaughtException', new Error(`boom ${i}`));

    expect(onRepeated).toHaveBeenCalledTimes(1);
    expect(onRepeated).toHaveBeenCalledWith('repeated unhandled errors');
  });

  it('forgets errors that are older than the window', () => {
    const { proc, at, onRepeated } = setup(3);

    for (let i = 0; i < 3; i += 1) proc.emit('unhandledRejection', new Error('early'));
    at(5000);
    for (let i = 0; i < 3; i += 1) proc.emit('unhandledRejection', new Error('late'));

    expect(onRepeated).not.toHaveBeenCalled();
  });
});
