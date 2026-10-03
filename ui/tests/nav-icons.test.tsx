/**
 * R18: the sidebar and Basic Home share one icon per module, and no two
 * modules share one. Both panels build their nav from `NAV_ICONS`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AppShell, type NavGroup } from '../src/AppShell.js';
import { BasicHome } from '../src/BasicHome.js';
import { Icon } from '../src/icons.js';
import { KeyboardProvider } from '../src/KeyboardProvider.js';
import { GLYPHS } from '../src/navGlyphs.js';
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

  it('colours it from a palette token', () => {
    const tokens = readFileSync(join(process.cwd(), 'ui', 'src', 'tokens.css'), 'utf8');
    // One definition, from the palette's red: dark mode follows `--kiln-red`'s dark value.
    expect(tokens.match(/--signout-fg:/g)).toHaveLength(1);
    expect(tokens).toMatch(/--signout-fg: var\(--kiln-red\)/);
    const css = readFileSync(join(process.cwd(), 'ui', 'src', 'base.css'), 'utf8');
    expect(css).toMatch(/\.ob-btn--signout[^{]*\{\s*color: var\(--signout-fg\)/);
  });
});

describe('one icon per module on the sidebar and on Basic Home (1.4 R18)', () => {
  const ids = Object.keys(NAV_ICONS).filter((id) => id !== 'basicHome') as Array<keyof typeof NAV_ICONS>;
  const groups: NavGroup[] = [
    { label: 'All', items: ids.map((id) => ({ id, label: `M-${id}`, icon: NAV_ICONS[id] })) },
  ];

  it('draws the Basic Home drawing in the sidebar for a module that has one, and the same line icon on both for one that has none', () => {
    const { container: side } = render(
      <AppShell
        groups={groups}
        activeId="dashboard"
        onNavigate={() => undefined}
        collapsed={false}
        onToggleCollapsed={() => undefined}
        topbar={null}
        footer={null}
        rail="synced"
        railLabel=""
        onRailClick={() => undefined}
      >
        <div />
      </AppShell>,
    );
    const sidebar = (id: string) => side.querySelector<HTMLElement>(`button[title="M-${id}"]`)!;
    const { container: home } = render(
      <KeyboardProvider panel="office">
        <BasicHome groups={groups} onOpen={() => undefined} />
      </KeyboardProvider>,
    );
    const tile = (id: string) =>
      [...home.querySelectorAll<HTMLElement>('.ob-tile')].find((el) => el.textContent?.startsWith(`M-${id}`))!;

    for (const id of ids) {
      if (GLYPHS[id]) {
        const navArt = sidebar(id).querySelector(`svg[data-glyph="${id}"]`);
        const tileArt = [...tile(id).querySelectorAll(`svg[data-glyph="${id}"]`)].find((svg) =>
          svg.classList.contains('ob-tile-art'),
        );
        expect(navArt, `${id} sidebar`).not.toBeNull();
        expect(tileArt, `${id} tile`).not.toBeUndefined();
        // The same drawing: identical markup, only the box and colours differ.
        expect(navArt!.innerHTML, id).toBe(tileArt!.innerHTML);
      } else {
        const path = (el: Element) => el.querySelector('svg path')?.getAttribute('d');
        expect(path(sidebar(id)), `${id} line icon`).toBeTruthy();
        expect(path(sidebar(id)), id).toBe(path(tile(id).querySelector('.ob-tile-icon')!));
      }
    }
  });
});
