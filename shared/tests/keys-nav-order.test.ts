/**
 * Each panel's nav commands follow that panel's own sidebar, read from the
 * sidebar itself.
 *
 * `MASTER_NAV` and `OFFICE_NAV` in `shared/src/keys/commands.ts` are declared
 * lists on purpose — a rendered index would move Alt+3 with a person's
 * permissions — and a declared list drifts from what it copies. Parties joined
 * the Master's sidebar without joining `MASTER_NAV`: the palette could not
 * open it by name, and from Alt+3 on every chord opened the screen one below
 * the one the sidebar showed at that position.
 *
 * Reads the source, in the `keys-implemented.test.ts` style. The sidebars are
 * built inside React components from permissions, so there is nothing to
 * import; the declaration order in the file is the order the sidebar shows
 * for somebody who can see everything.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { COMMANDS } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** The text from `start` up to (not including) the first `end` after it. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `${start} not found`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to, `${JSON.stringify(end)} not found after ${start}`).toBeGreaterThan(-1);
  return source.slice(from, to);
}

/**
 * Every sidebar entry's `id`, in declaration order, each once. An entry can be
 * declared more than once when its shape depends on who is signed in — the
 * Office's Conflicts item is one thing for somebody who may resolve and another
 * for somebody who may only look — and it is still one place in the sidebar.
 */
function sidebarIds(block: string): string[] {
  return [
    ...new Set([...block.matchAll(/\bid: '([A-Za-z]+)'/g)].map((match) => match[1] as string)),
  ];
}

/** The screens a panel's Alt+N commands open, in `navOrder`. */
function navTabs(panel: 'master' | 'office'): string[] {
  return COMMANDS.filter((command) => command.panel === panel && command.navOrder !== undefined)
    .sort((a, b) => (a.navOrder as number) - (b.navOrder as number))
    .map((command) => command.tab as string);
}

describe('each panel numbers its nav commands in its own sidebar order', () => {
  it('the Master: its sidebar groups, in order', () => {
    const source = read('master/web/src/App.tsx');
    const ids = sidebarIds(between(source, 'const groups: NavGroup[] = [', '].map((group)'));

    // Guards the slicing above: a reformatted App.tsx that matched nothing
    // would otherwise compare two short lists and prove little.
    expect(ids).toContain('dashboard');
    expect(ids).toContain('settings');

    expect(navTabs('master')).toEqual(ids);
  });

  it('the Office: its sidebar groups, in order', () => {
    const source = read('office/web/src/App.tsx');
    const ids = sidebarIds(between(source, 'const groups: NavGroup[] = [', '].map((group)'));

    expect(ids).toContain('dashboard');
    // The activity log reached the Office in 1.3 Phase 2, between Settings
    // and App update in the System group.
    expect(ids.slice(ids.indexOf('settings'))).toEqual(['settings', 'logs', 'updates']);

    expect(navTabs('office')).toEqual(ids);
  });

  it('both panels give a screen they share the same chord', () => {
    const chords = (panel: 'master' | 'office') =>
      new Map(
        COMMANDS.filter((command) => command.panel === panel && command.navOrder !== undefined).map(
          (command) => [command.tab as string, command.defaultChord],
        ),
      );
    const master = chords('master');
    const office = chords('office');
    const shared = [...office.keys()].filter((tab) => master.has(tab));

    expect(shared).toContain('basicHome');
    for (const tab of shared) expect(master.get(tab), tab).toBe(office.get(tab));
  });
});
