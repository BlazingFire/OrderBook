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
import { NAV_ICONS } from '../src/navIcons.js';
import { TILE_ICONS } from '../src/tileIcons.js';

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
    const literal = source.match(/id: '(?:basicHome|dashboard|leads|orders|conflicts|chatroom|printroom|reports|products|parties|partyAccess|lists|panels|access|fields|logs|recycleBin|integrations|settings|updates)',[^}]{0,140}?icon: '/g);
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
    // One definition, from a palette shade (Chromium 108 has no color-mix) that has a light and a dark value.
    expect(tokens.match(/--signout-fg:/g)).toHaveLength(1);
    expect(tokens).toMatch(/--signout-fg: var\(--kiln-red-60\)/);
    expect(tokens.match(/--kiln-red-60:/g)).toHaveLength(2);
    const css = readFileSync(join(process.cwd(), 'ui', 'src', 'base.css'), 'utf8');
    expect(css).toMatch(/\.ob-btn--signout[^{]*\{\s*color: var\(--signout-fg\)/);
  });
});

describe('one icon per module in the sidebar, a colour tile or the same icon on Basic Home', () => {
  const ids = Object.keys(NAV_ICONS).filter((id) => id !== 'basicHome') as Array<keyof typeof NAV_ICONS>;
  const groups: NavGroup[] = [
    { label: 'All', items: ids.map((id) => ({ id, label: `M-${id}`, icon: NAV_ICONS[id] })) },
  ];

  it('keeps the sidebar on line icons and gives each tile its art or the sidebar icon', () => {
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

    const path = (el: Element) => el.querySelector('svg path')?.getAttribute('d');
    for (const id of ids) {
      expect(path(sidebar(id)), `${id} sidebar`).toBeTruthy();
      const face = tile(id).querySelector('.ob-tile-face')!;
      if (TILE_ICONS[id]) {
        expect(face.classList.contains('ob-tile-face--art'), id).toBe(true);
        expect(face.querySelector('svg')?.getAttribute('viewBox'), id).toBe('0 0 96 96');
      } else {
        expect(face.classList.contains('ob-tile-face--art'), id).toBe(false);
        expect(path(face), id).toBe(path(sidebar(id)));
      }
    }
    // Colour stays on Basic Home: the sidebar is line icons only.
    expect(side.querySelector('[data-glyph]')).toBeNull();
    for (const svg of side.querySelectorAll('.ob-navitem-main svg')) {
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('fill')).toBe('none');
    }
  });
});

describe('Basic Home colour tiles', () => {
  it('has art for every module but the notices manager, which keeps its line icon', () => {
    const missing = Object.keys(NAV_ICONS).filter(
      (id) => !TILE_ICONS[id as keyof typeof TILE_ICONS],
    );
    expect(missing.sort()).toEqual(['basicHome', 'noticesManage']);
    expect(TILE_ICONS.newLead).toBeDefined();
  });

  it('gives each rendered copy its own gradient and filter ids, and hides itself from readers', () => {
    const Art = TILE_ICONS.dashboard!;
    const { container } = render(
      <>
        <Art />
        <Art size={40} />
      </>,
    );
    const [first, second] = [...container.querySelectorAll('svg')];
    expect(first!.getAttribute('aria-hidden')).toBe('true');
    expect(first!.getAttribute('width')).toBe('80');
    expect(second!.getAttribute('width')).toBe('40');
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    // Every url(#...) reference points at an id inside its own copy.
    for (const svg of [first!, second!]) {
      const own = new Set([...svg.querySelectorAll('[id]')].map((el) => el.id));
      const refs = svg.outerHTML.match(/url\(#([^)]+)\)/g) ?? [];
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(own.has(ref.slice(5, -1)), ref).toBe(true);
    }
  });

  it('keep their colour in the SVG, not the tile CSS, which draws no gradient or per-module hue', () => {
    const css = readFileSync(join(process.cwd(), 'ui', 'src', 'base.css'), 'utf8');
    const tileRules = css.match(/\.ob-tile[^{]*\{[^}]*\}/g) ?? [];
    expect(tileRules.length).toBeGreaterThan(0);
    for (const rule of tileRules) expect(rule).not.toMatch(/gradient|--tile-|data-hue/);
  });
});

describe('Icon stroke (artboard)', () => {
  it('is 1.75 from 16 px up and 2 at 14 px and below', () => {
    const stroke = (size: number) => {
      const { container } = render(<Icon name="check" size={size} />);
      const width = container.querySelector('svg')?.getAttribute('stroke-width');
      cleanup();
      return width;
    };
    expect([stroke(13), stroke(14), stroke(16), stroke(36)]).toEqual(['2', '2', '1.75', '1.75']);
  });
});
