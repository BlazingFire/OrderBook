/**
 * The decision that kept both panels broken.
 *
 * The Office server had no `/api/health` at all, so its shell polled a 401 for
 * sixty seconds and then declared a running server dead. The Master's live app
 * answered without a `boot` key, so the shell's failure branch was dead code.
 * Both are contract problems, and this is where the contract is enforced from
 * the reading end.
 */

import { describe, expect, it } from 'vitest';

import { interpretHealth } from '../lib/health.js';

describe('interpreting a panel health response', () => {
  it('reads a live Master as ready', () => {
    const outcome = interpretHealth(
      {
        panel: 'master',
        status: 'ok',
        boot: { state: 'ready', step: 'Ready', message: null, detail: null },
        version: '1.0.2',
        port: 4100,
        hasNetworkLink: true,
        interfaces: [],
      },
      'master',
    );

    expect(outcome.kind).toBe('ready');
  });

  it('reads a starting panel as starting, and carries the step to the splash', () => {
    const outcome = interpretHealth(
      {
        panel: 'master',
        status: 'starting',
        boot: { state: 'starting', step: 'Starting the database', message: null, detail: null },
      },
      'master',
    );

    expect(outcome).toEqual({ kind: 'starting', step: 'Starting the database' });
  });

  it('reads a failed boot as failed, so the window is handed to the error page', () => {
    const outcome = interpretHealth(
      {
        panel: 'master',
        status: 'starting',
        boot: {
          state: 'failed',
          step: 'Starting the database',
          message: 'PostgreSQL would not start.',
          detail: null,
        },
      },
      'master',
    );

    expect(outcome).toEqual({ kind: 'failed', message: 'PostgreSQL would not start.' });
  });

  /*
   * The Office bug, pinned. `{error:'not_signed_in'}` is what the gate returned
   * for a route that did not exist, and anything but "keep waiting" here is a
   * shell that gives up on a server which is merely still starting.
   */
  it('treats an auth error body as not listening, never as ready', () => {
    expect(interpretHealth({ error: 'not_signed_in', message: 'Sign in' }, 'office')).toEqual({
      kind: 'not-listening',
    });
  });

  it('treats an unparseable or empty body as not listening', () => {
    expect(interpretHealth(null, 'office')).toEqual({ kind: 'not-listening' });
    expect(interpretHealth('<html>404</html>', 'office')).toEqual({ kind: 'not-listening' });
    expect(interpretHealth({}, 'office')).toEqual({ kind: 'not-listening' });
  });

  it('refuses to navigate to the other panel on the same port', () => {
    const outcome = interpretHealth(
      {
        panel: 'office',
        status: 'ok',
        boot: { state: 'ready', step: 'Ready', message: null, detail: null },
      },
      'master',
    );

    expect(outcome).toEqual({ kind: 'wrong-app', panel: 'office' });
  });

  it('still reads a panel that omits boot entirely as ready rather than hanging', () => {
    // An older installed panel, before the shared contract. Forward compatible
    // in the direction that matters: a missing `boot` must not mean "wait".
    expect(interpretHealth({ status: 'ok' }, 'master').kind).toBe('ready');
  });
});
