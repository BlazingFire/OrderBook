/**
 * R18: the sidebar and Basic Home share one icon per module, and no two
 * modules share one. Both panels build their nav from `NAV_ICONS`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Icon } from '../src/icons.js';
import { NAV_ICONS } from '../src/navIcons.js';

afterEach(cleanup);

describe('NAV_ICONS', () => {
  it('gives every module its own icon', () => {
    const names = Object.values(NAV_ICONS);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names an icon that draws something', () => {
    for (const name of Object.values(NAV_ICONS)) {
      const { container } = render(<Icon name={name} />);
      expect(container.querySelector('path')?.getAttribute('d'), name).toBeTruthy();
      cleanup();
    }
  });

  it.each(['master/web', 'office/web'])('is the only icon source in %s App.tsx nav rows', (panel) => {
    const source = readFileSync(join(process.cwd(), panel, 'src', 'App.tsx'), 'utf8');
    const literal = source.match(/id: '(?:basicHome|dashboard|leads|orders|conflicts|chatroom|printroom|reports|products|parties|partyAccess|panels|access|fields|logs|recycleBin|integrations|settings|updates)',[^}]{0,140}?icon: '/g);
    expect(literal).toBeNull();
  });
});

describe('sign-out control (R12)', () => {
  it.each(['master/web', 'office/web'])('has the icon and the muted-red class in %s', (panel) => {
    const source = readFileSync(join(process.cwd(), panel, 'src', 'App.tsx'), 'utf8');
    expect(source).toMatch(/ob-btn--signout[\s\S]{0,120}<Icon name="sign-out"/);
  });

  it('colours it from a token defined for light and dark', () => {
    const tokens = readFileSync(join(process.cwd(), 'ui', 'src', 'tokens.css'), 'utf8');
    expect(tokens.match(/--signout-fg:/g)).toHaveLength(2);
    const css = readFileSync(join(process.cwd(), 'ui', 'src', 'base.css'), 'utf8');
    expect(css).toMatch(/\.ob-btn--signout[^{]*\{\s*color: var\(--signout-fg\)/);
  });
});
