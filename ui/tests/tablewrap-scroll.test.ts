/**
 * `.ob-tablewrap` is `overflow: clip` so a DataTable header can stick to the pane
 * (Party Access D1, `840ea61`). Clip never scrolls, which broke the one wrapper that
 * relies on its own scroll box: the permission grid, whose sticky top and left
 * headers stick to `.ob-permwrap`. This pins both halves, and checks that no other
 * class sharing a wrapper with `.ob-tablewrap` sets a height cap without saying how
 * the rest is reached.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const css = readFileSync(join(root, 'ui', 'src', 'base.css'), 'utf8');

/** The declarations of every rule whose selector is exactly `.name`. */
function ruleBodies(name: string): string[] {
  const pattern = new RegExp(String.raw`(?:^|[}/])\s*\.` + name + String.raw`\s*\{([^}]*)\}`, 'g');
  return [...css.matchAll(pattern)].map((match) => match[1] ?? '');
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === 'node_modules' || entry === 'dist' ? [] : sources(path);
    return /\.tsx$/.test(entry) ? [path] : [];
  });
}

describe('.ob-tablewrap and the scroll boxes inside it', () => {
  it('keeps the table wrapper from being a scroll container, so a sticky header sticks to the pane', () => {
    const bodies = ruleBodies('ob-tablewrap');
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.at(-1)).toMatch(/overflow:\s*clip/);
  });

  it('gives the permission grid its own scroll box, in both directions', () => {
    const bodies = ruleBodies('ob-permwrap');
    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies.join('\n');
    expect(body).toMatch(/max-height:/);
    expect(body).toMatch(/overflow:\s*(auto|scroll)/);
  });

  it('lets a flat record table scroll sideways in its own box, since nothing in it sticks to the pane', () => {
    const rule = css.match(/\.ob-tablewrap:has\(> \.ob-table--flat\)\s*\{([^}]*)\}/);
    expect(rule, 'no rule for a flat table wrapper').not.toBeNull();
    expect(rule![1]).toMatch(/overflow-x:\s*auto/);
  });

  it('lets no other class on a table wrapper cap its height without a scroll box', () => {
    const extra = new Set<string>();
    for (const dir of ['ui/src', 'master/web/src', 'office/web/src']) {
      for (const file of sources(join(root, dir))) {
        for (const match of readFileSync(file, 'utf8').matchAll(/className="([^"]*\bob-tablewrap\b[^"]*)"/g)) {
          for (const name of (match[1] ?? '').split(/\s+/)) if (name && name !== 'ob-tablewrap') extra.add(name);
        }
      }
    }
    expect([...extra]).toContain('ob-permwrap');
    for (const name of extra) {
      const body = ruleBodies(name).join('\n');
      if (/max-height:/.test(body)) expect(body, `.${name} caps its height`).toMatch(/overflow:\s*(auto|scroll)/);
    }
  });
});
