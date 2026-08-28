/**
 * The shared UI package stays shared.
 *
 * Every component in `@orderbook/ui` used to exist twice, once under each
 * panel's `web/src/ui/`. Twenty-six of the files were byte-identical and four
 * had quietly drifted apart — including `icons.tsx`, which carried a comment
 * telling you to remember to add your new icon to the other panel by hand.
 * Adding a component was a two-file change and `base.css` was a two-file
 * change of 2,300 lines.
 *
 * Nothing about a re-created `web/src/ui/` would fail a build, and the drift
 * takes months to show up as a bug, so this is the guard.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('the panels do not keep their own copy of ui/', () => {
  it.each(['master/web/src/ui', 'office/web/src/ui'])('%s does not exist', (relative) => {
    expect(existsSync(path.join(ROOT, relative))).toBe(false);
  });

  it('no panel source imports a local ui/ module', () => {
    const offenders: string[] = [];

    for (const app of ['master/web/src', 'office/web/src']) {
      for (const file of sources(path.join(ROOT, app))) {
        const text = readFileSync(file, 'utf8');
        // `from './ui/X'`, `'../ui/X'`, `'../../ui/X'` — any depth.
        if (/from\s+'(?:\.\.?\/)+ui\//.test(text)) offenders.push(path.relative(ROOT, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every module in the package is reachable from its barrel', () => {
    const dir = path.join(ROOT, 'ui', 'src');
    const modules = readdirSync(dir)
      .filter((f) => /\.(ts|tsx)$/.test(f) && f !== 'index.ts')
      .map((f) => f.replace(/\.tsx?$/, ''));

    const barrel = readFileSync(path.join(dir, 'index.ts'), 'utf8');
    const missing = modules.filter((name) => !barrel.includes(`'./${name}.js'`));

    expect(missing).toEqual([]);
  });
});
