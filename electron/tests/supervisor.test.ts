/**
 * The bug the owner reported: "they close automatically sometimes".
 *
 * The old rule fired an error dialog and quit the application on *any* child
 * exit, including a clean `0`. These tests pin the replacement, and in
 * particular the two cases that made the old behaviour indefensible: a clean
 * exit nobody asked for is still a crash, and a stuck "updating" flag must
 * expire rather than suppressing every future crash report.
 */

import { describe, expect, it } from 'vitest';

import {
  canRestart,
  isExpectedExit,
  isUpdating,
  pruneRestarts,
  RESTART_LIMIT,
  RESTART_WINDOW_MS,
  UPDATE_WINDOW_MS,
} from '../lib/supervisor.js';

const NOW = 1_700_000_000_000;

describe('deciding what a server exit means', () => {
  it('expects the exit when we asked the server to stop', () => {
    expect(
      isExpectedExit({ quitting: true, relocating: false, updatingSince: null, now: NOW }),
    ).toBe(true);
  });

  it('treats a clean exit nobody asked for as a crash', () => {
    // The exit code is deliberately not consulted anywhere. The server has no
    // reason to stop on its own, and reading `0` as fine is what left a live
    // window sitting over a dead backend with no message.
    expect(
      isExpectedExit({ quitting: false, relocating: false, updatingSince: null, now: NOW }),
    ).toBe(false);
  });

  it('expects the exit while the server is being restarted into another folder', () => {
    // Choosing a data directory on the first-run screen stops the server and
    // starts it again. Read as a crash, the supervisor starts its own second
    // server, the two race for the port, and the loser's `EADDRINUSE` counts
    // as one more crash — the shell died on the third.
    expect(
      isExpectedExit({ quitting: false, relocating: true, updatingSince: null, now: NOW }),
    ).toBe(true);
  });

  it('expects the exit while an installer is replacing us', () => {
    expect(
      isExpectedExit({ quitting: false, relocating: false, updatingSince: NOW - 1_000, now: NOW }),
    ).toBe(true);
  });

  it('stops suppressing once the update window has passed', () => {
    // The old flag was a boolean cleared only in a catch, so an installer that
    // started and then died — or a UAC prompt the operator cancelled — hid
    // every crash for the life of the process.
    expect(isUpdating(NOW - UPDATE_WINDOW_MS - 1, NOW)).toBe(false);
    expect(
      isExpectedExit({
        quitting: false,
        relocating: false,
        updatingSince: NOW - UPDATE_WINDOW_MS - 1,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('never suppresses when no installer was launched', () => {
    expect(isUpdating(null, NOW)).toBe(false);
  });
});

describe('bounding restarts', () => {
  it('allows restarts up to the limit', () => {
    expect(canRestart([], NOW)).toBe(true);
    expect(canRestart([NOW - 1_000, NOW - 2_000], NOW)).toBe(true);
  });

  it('refuses the restart after the limit inside the window', () => {
    const recent = Array.from({ length: RESTART_LIMIT }, (_unused, index) => NOW - index * 1_000);
    expect(canRestart(recent, NOW)).toBe(false);
  });

  it('allows restarting again once the window has rolled', () => {
    const old = Array.from(
      { length: RESTART_LIMIT },
      (_unused, index) => NOW - RESTART_WINDOW_MS - index * 1_000,
    );
    expect(pruneRestarts(old, NOW)).toEqual([]);
    expect(canRestart(old, NOW)).toBe(true);
  });

  it('counts only the restarts still inside the window', () => {
    const mixed = [NOW - RESTART_WINDOW_MS - 1, NOW - 1_000];
    expect(pruneRestarts(mixed, NOW)).toEqual([NOW - 1_000]);
  });
});
