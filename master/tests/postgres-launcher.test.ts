/**
 * The cluster is started without letting PostgreSQL hold this process's stdio.
 *
 * `pg_ctl` exits as soon as the server is up, but the `postgres` process it
 * launches inherits the parent's stdout/stderr and keeps them open for its
 * whole life. `execFile` only resolves once the child's pipes close — so
 * whenever the Master's own stdout is a **pipe** rather than a console, that
 * promise never settles. PostgreSQL starts perfectly, `postgres.log` says
 * "database system is ready to accept connections", and the boot screen sits on
 * "Starting the database" forever.
 *
 * This was latent for as long as the Master only ever ran from a terminal, and
 * it surfaced the first time the desktop shell spawned it with
 * `stdio: ['ignore', 'pipe', 'pipe']` — a packaged Master that never finished
 * starting, with a log full of success messages.
 *
 * `master/tests/helpers/db.ts` hit the identical hang in the test suite and
 * fixed it there. HANDOFF.md's account of that fix says "The same expression is
 * in the production launcher" — and it stayed there. This test is what stops it
 * coming back, because nothing else can: reproducing it needs a real cluster
 * started from a process whose stdout is a pipe, which is a packaged run.
 *
 * Reads the source, in the `credential-invariants.test.ts` style.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'postgres-server.ts'),
  'utf8',
);

/** The body of `startCluster`, where the hang lived. */
function startClusterBody(): string {
  const start = SOURCE.indexOf('async function startCluster');
  expect(start).toBeGreaterThan(-1);

  const next = SOURCE.indexOf('\nasync function stopCluster', start);
  return SOURCE.slice(start, next === -1 ? undefined : next);
}

describe('starting the PostgreSQL cluster', () => {
  it('spawns pg_ctl with no pipes to inherit, rather than execFile', () => {
    const body = startClusterBody();

    expect(body).toContain('spawn(');
    expect(body).toContain(`stdio: 'ignore'`);
    // The line that caused it. A start path that awaits `execFileAsync` hangs
    // the moment this process's own stdout is a pipe.
    expect(body).not.toContain('execFileAsync(path.join(binDir, binName(\'pg_ctl\'))');
  });

  it('still waits for pg_ctl to exit, so a failed start is a failure', () => {
    const body = startClusterBody();

    // `stdio: 'ignore'` alone is not the fix — fire-and-forget would report
    // success for a cluster that never came up. The exit code is what makes
    // "started" mean started.
    expect(body).toContain(`child.on('exit'`);
    expect(body).toContain(`child.on('error'`);
    expect(body).toMatch(/code === 0 \? resolve\(\)/);
  });

  it('keeps --wait, so pg_ctl itself does not return early', () => {
    expect(startClusterBody()).toContain(`'--wait'`);
  });
});
