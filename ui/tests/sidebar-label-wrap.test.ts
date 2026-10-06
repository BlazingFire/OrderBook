/**
 * Sidebar labels wrap to two lines instead of being cut to a stub: "Converted pending orders"
 * and "Pending Order outcomes" lost their end at 157 % with one line and an ellipsis. The
 * row's `title` already carries the whole text; this pins the CSS half.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'ui', 'src', 'base.css'), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replaceAll('.', String.raw`\.`);
  const match = new RegExp(String.raw`(?:^|[}/])\s*${escaped}\s*\{([^}]*)\}`, 'm').exec(css);
  expect(match, `${selector} not found`).not.toBeNull();
  return match![1] ?? '';
}

describe('sidebar labels', () => {
  it('may wrap, to two lines, and may not stay on one line', () => {
    const row = ruleBody('.ob-navitem');
    expect(row).toMatch(/white-space:\s*normal/);
    expect(row).not.toMatch(/white-space:\s*nowrap/);

    const label = ruleBody('.ob-navitem-label');
    expect(label).toMatch(/-webkit-line-clamp:\s*2/);
    expect(label).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
