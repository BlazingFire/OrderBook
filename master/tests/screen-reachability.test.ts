/**
 * A sidebar entry must have a screen behind it, and a screen must have a way in.
 *
 * Each panel declares a `Tab` union, builds a sidebar from `NavItem` literals,
 * and hands a `ScreenSpec[]` to `ScreenHost`. Three lists, maintained by hand.
 * Two shipped blocking bugs have come from them drifting apart — a nav entry
 * whose screen was never registered leaves a dead sidebar row, and a screen with
 * no nav entry is unreachable unless something else routes to it.
 *
 * Modelled on `party-access-screen-parity.test.ts`: reads the source rather than
 * importing, because the question is what is *written* in `App.tsx`.
 *
 * ## Why this classifies literals instead of grepping for `id:`
 *
 * The first version of this file collected screen ids with
 * `/\bid:\s*'([A-Za-z]+)'/g` over the whole file. Nav items are also `id:`
 * literals in the same file, so every nav entry counted as its own screen and
 * the two lists could never disagree — the check was `A ⊆ A`. It passed while
 * the Office panel's missing AI Support route was exactly the kind of thing it
 * was written to surface.
 *
 * The two shapes are distinguishable and this file distinguishes them: a
 * `NavItem` carries `icon:`, a `ScreenSpec` carries `render:`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '@orderbook/shared';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** The members of a TypeScript union type. */
function extractUnion(source: string, name: string): string[] {
  const re = new RegExp(`type\\s+${name}\\s*=\\s*([\\s\\S]*?);`, 'm');
  const match = re.exec(source);
  if (!match) return [];
  return [...match[1]!.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]!);
}

/**
 * The ids of every object literal that both names an `id` and carries `marker`.
 *
 * Brace-matched from each `id:` outwards, so a nested literal — the
 * `transport={{ ... }}` inside a `render:` callback, say — cannot be mistaken
 * for the enclosing entry.
 */
function idsOfLiteralsWith(source: string, marker: string): string[] {
  const ids: string[] = [];

  for (const match of source.matchAll(/\bid:\s*'([A-Za-z]+)'/g)) {
    const id = match[1]!;

    // Walk back to this literal's own `{`.
    let depth = 0;
    let open = -1;
    for (let i = match.index; i >= 0; i -= 1) {
      const c = source[i];
      if (c === '}') depth += 1;
      else if (c === '{') {
        if (depth === 0) {
          open = i;
          break;
        }
        depth -= 1;
      }
    }
    if (open < 0) continue;

    // ...and forward to its matching `}`.
    depth = 0;
    let close = -1;
    for (let i = open; i < source.length; i += 1) {
      const c = source[i];
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) continue;

    if (source.slice(open, close).includes(marker)) ids.push(id);
  }

  return [...new Set(ids)];
}

const navIds = (source: string) => idsOfLiteralsWith(source, 'icon:');
const screenIds = (source: string) => idsOfLiteralsWith(source, 'render:');

/**
 * Screens with no sidebar entry, each with the reason it has none.
 *
 * A bare list would be padded silently by the next agent whose change broke the
 * test. A reason is what makes an addition here a decision somebody has to
 * write down and a reviewer can argue with.
 */
const NAVLESS_SCREENS: Record<string, Record<string, string>> = {
  master: {
    firstRun: 'Shown once, before any sidebar exists — the panel routes to it from boot state.',
    dashboard: 'The default landing screen; reached by starting the app, not by a sidebar row.',
    addLead:
      'Opened by the `record.new` command, the topbar button and Pending Orders → New pending order, never as a sidebar row of its own.',
  },
  office: {
    addLead: 'Opened by the `record.new` command and the Leads screen, never from the sidebar.',
    connection: 'Shown when there is no Master to talk to yet, which is before the sidebar exists.',
    dashboard: 'The default landing screen; reached by starting the app, not by a sidebar row.',
  },
};

/**
 * Every screen one panel has and the other does not, with the reason.
 *
 * This is the list the previous version could not produce, and it is why the
 * Office panel's missing AI Support route read as an oversight rather than as a
 * decision. It is a decision, and it is written down here.
 *
 * The rule is total: a screen present in exactly one `App.tsx` and absent from
 * this map fails the test. Adding an entry is cheap; adding one you cannot
 * finish the sentence for is the signal that the screen belongs in both.
 */
const PANEL_ONLY: Record<string, string> = {
  // Master only — these read or write the database directly.
  panels: 'Master only: pairing and revoking Office panels is the Master’s own registry.',
  reports: 'Master only: reports aggregate across the whole tenant, which only the Master sees.',
  access: 'Master only: roles and users are administered where the credentials are stored.',
  fields: 'Master only: custom-field definitions are schema, and schema is single-writer.',
  logs: 'Master only: the activity log is a Master table with no panel-local copy.',
  recycleBin: 'Master only: restoring a soft-deleted row is a write against the owning database.',
  integrations: 'Master only: API keys and connectors are configured where they are held.',

  // `parties` was here — "Office only: the Master reaches parties through Party
  // Access instead." That was never a decision, it was an omission with a
  // sentence attached: `api.createParty` had zero callers on the Master and an
  // administrator had no way to add a customer. Both panels have the screen
  // now, and this test's other direction is what made the stale claim visible.
};

for (const [panel, file] of [
  ['master', 'master/web/src/App.tsx'],
  ['office', 'office/web/src/App.tsx'],
] as const) {
  describe(`${panel} panel: the sidebar, the Tab union and the screens agree`, () => {
    const source = read(file);
    const tabs = extractUnion(source, 'Tab');
    const nav = navIds(source);
    const screens = screenIds(source);

    it('found all three lists — an empty scan must not pass as agreement', () => {
      expect(tabs.length).toBeGreaterThan(0);
      expect(nav.length).toBeGreaterThan(0);
      expect(screens.length).toBeGreaterThan(0);
    });

    it('every sidebar entry has a screen behind it', () => {
      expect(nav.filter((id) => !screens.includes(id))).toEqual([]);
    });

    it('every screen is either in the sidebar or listed as deliberately nav-less', () => {
      const reasons = NAVLESS_SCREENS[panel] ?? {};
      const orphans = screens.filter((id) => !nav.includes(id) && !(id in reasons));
      expect(orphans).toEqual([]);
    });

    it('every sidebar entry and screen is a member of the Tab union', () => {
      expect([...new Set([...nav, ...screens])].filter((id) => !tabs.includes(id))).toEqual([]);
    });
  });
}

describe('the two panels differ only where a reason is recorded', () => {
  const master = screenIds(read('master/web/src/App.tsx'));
  const office = screenIds(read('office/web/src/App.tsx'));

  const onlyOnePanel = [
    ...master.filter((id) => !office.includes(id)),
    ...office.filter((id) => !master.includes(id)),
  ];

  it('records a reason for every screen only one panel has', () => {
    expect(onlyOnePanel.filter((id) => !(id in PANEL_ONLY))).toEqual([]);
  });

  it('carries no reason for a screen both panels now have', () => {
    // The other direction. Once a screen is added to the second panel its
    // entry here is a stale claim, and a stale reason is how a list like this
    // stops being read.
    expect(Object.keys(PANEL_ONLY).filter((id) => !onlyOnePanel.includes(id))).toEqual([]);
  });
});

describe('every nav command targets a screen that exists in its panel', () => {
  const master = screenIds(read('master/web/src/App.tsx'));
  const office = screenIds(read('office/web/src/App.tsx'));

  it('resolves every command.tab', () => {
    const failures: string[] = [];

    for (const command of COMMANDS) {
      if (!command.tab) continue;
      if (command.panel === 'master' && !master.includes(command.tab)) {
        failures.push(`${command.id}: tab "${command.tab}" has no master ScreenSpec`);
      }
      if (command.panel === 'office' && !office.includes(command.tab)) {
        failures.push(`${command.id}: tab "${command.tab}" has no office ScreenSpec`);
      }
    }

    expect(failures).toEqual([]);
  });
});
