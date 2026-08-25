/**
 * Both halves of the Socket.IO contract have to be *used*, not merely declared.
 *
 * `panel:revoked` sat in `ServerToClientEvents` for months, fully handled by the
 * Office Panel, and never emitted by the Master — so a revoked panel kept
 * running on a dead pairing until it happened to reconnect. Nothing was red:
 * the type existed, the handler existed, and no test asked whether anything
 * ever sent it. This pins the general rule rather than that one event, because
 * the next event added to the contract can go the same way.
 *
 * Reads the source, in the `credential-invariants.test.ts` style. Importing the
 * hub would prove the module loads, not that a `socket.emit('x')` call site
 * exists for every declared event.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MASTER_SRC = path.resolve(HERE, '..', 'src');
const OFFICE_SRC = path.resolve(HERE, '..', '..', 'office', 'src');
const CONTRACT = path.resolve(HERE, '..', '..', 'shared', 'src', 'protocol', 'socket.ts');

function sourceUnder(dir: string): string {
  return readdirSync(dir)
    .map((entry) => path.join(dir, entry))
    .map((full) => (statSync(full).isDirectory() ? sourceUnder(full) : full.endsWith('.ts') ? readFileSync(full, 'utf8') : ''))
    .join('\n');
}

/** The keys of one interface in the contract file, as written. */
function eventNames(interfaceName: string): string[] {
  const source = readFileSync(CONTRACT, 'utf8');
  const start = source.indexOf(`export interface ${interfaceName} {`);
  expect(start, `${interfaceName} not found in the contract`).toBeGreaterThan(-1);

  const body = source.slice(start, source.indexOf('\n}', start));
  return [...body.matchAll(/^\s*'([a-z]+:[a-zA-Z]+)':/gm)].map((match) => match[1] as string);
}

describe('the socket contract is wired at both ends', () => {
  const serverEvents = eventNames('ServerToClientEvents');

  it('declares the events this test is meant to be covering', () => {
    // Guards the regexes above: if the contract is reformatted so nothing
    // matches, every other assertion here would vacuously pass.
    expect(serverEvents.length).toBeGreaterThanOrEqual(6);
    expect(serverEvents).toContain('panel:revoked');
  });

  it('emits every Master → client event somewhere in the Master', () => {
    const master = sourceUnder(MASTER_SRC);

    for (const event of serverEvents) {
      expect(master.includes(`'${event}'`), `${event} is declared but the Master never emits it`).toBe(true);
    }
  });

  it('handles every Master → client event somewhere in the Office Panel', () => {
    const office = sourceUnder(OFFICE_SRC);

    // Addressed to the Master's own browser, not to a panel. `dashboard:changed`
    // is here because the Office Dashboard derives its figures from the panel's
    // synced `LocalView` rather than from a pushed aggregate — see the note in
    // `broadcastDashboard`.
    const masterBrowserOnly = new Set(['panels:changed', 'dashboard:changed']);

    for (const event of serverEvents.filter((name) => !masterBrowserOnly.has(name))) {
      expect(office.includes(`'${event}'`), `${event} is declared but the Office Panel never handles it`).toBe(true);
    }
  });
});
