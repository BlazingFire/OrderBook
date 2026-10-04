/**
 * The installer's firewall rules must name the ports the Master actually listens on,
 * and an update must replace them, not pile up a second copy. Nothing else notices
 * a mismatch: Windows just silently drops the packets and panels "cannot find" the Master.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DISCOVERY_PORT } from '@orderbook/shared';

const root = process.cwd();
const nsh = readFileSync(path.join(root, 'master', 'installer', 'installer.nsh'), 'utf8');
const lines = nsh.split(/\r?\n/);

const rule = (verb: 'add' | 'delete', name: string): number =>
  lines.findIndex((line) => line.includes(`firewall ${verb} rule name="${name}"`));

function ruleLine(verb: 'add' | 'delete', name: string): string {
  const at = rule(verb, name);
  expect(at, `no "${verb} rule" for ${name}`).toBeGreaterThanOrEqual(0);
  return lines[at]!;
}

const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), 'utf8');

describe('installer firewall rules', () => {
  const electronPort = Number(/process\.env\.PORT \?\? (\d+)/.exec(read('electron', 'master.main.ts'))![1]);
  const configPort = Number(/intFromEnv\('PORT', (\d+)\)/.exec(read('master', 'src', 'config', 'index.ts'))![1]);

  it('open the port the packaged Master listens on, and the discovery port', () => {
    expect(electronPort).toBe(configPort);
    const tcp = ruleLine('add', `OrderBook Master (TCP ${electronPort})`);
    expect(tcp).toContain('protocol=TCP');
    expect(tcp).toContain(`localport=${electronPort}`);
    const udp = ruleLine('add', `OrderBook Discovery (UDP ${DISCOVERY_PORT})`);
    expect(udp).toContain('protocol=UDP');
    expect(udp).toContain(`localport=${DISCOVERY_PORT}`);
  });

  it('are deleted before they are added, so an update leaves one pair, on every network profile', () => {
    for (const name of [`OrderBook Master (TCP ${electronPort})`, `OrderBook Discovery (UDP ${DISCOVERY_PORT})`]) {
      const first = rule('delete', name);
      const add = rule('add', name);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(add).toBeGreaterThan(first);
      expect(lines[add]).toContain('profile=any');
    }
  });
});
