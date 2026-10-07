/**
 * The shell as the design artboards (Navigation, Sidebar, Main) draw it: the in-app lockup,
 * the sidebar rows and sub-pages, the collapsed sidebar, the segmented control, the tabs.
 * The numbers are the artboards' (px at the 14 px root: 28 = 2rem, 26 = 1.8571rem, 36 = ctl-h-lg).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { Tabs } from '../src/Tabs.js';

afterEach(cleanup);

const css = readFileSync(join(process.cwd(), 'ui', 'src', 'base.css'), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.[\]()>':=*]/g, (c) => String.fromCharCode(92) + c);
  // A selector list may sit on several lines (and the file is CRLF): any whitespace stands for the break.
  const pattern = escaped.split(String.fromCharCode(10)).join(String.raw`\s*`);
  const match = new RegExp(String.raw`(?:^|[}/])\s*${pattern}\s*\{([^}]*)\}`, 'm').exec(css);
  expect(match, `${selector} not found`).not.toBeNull();
  return match![1] ?? '';
}

describe('sidebar (Sidebar artboard)', () => {
  it('sets the in-app lockup: wordmark 18px beside the 24px mark with an 8px gap', () => {
    expect(rule('.ob-sidebar-wordmark')).toMatch(/font-size:\s*1\.2857rem/);
    expect(rule('.ob-sidebar-brand')).toMatch(/gap:\s*var\(--s-8\)/);
  });

  it('draws 28px rows with a 10px gap, a 28px group band and 26px sub-pages', () => {
    expect(rule('.ob-navitem-main')).toMatch(/min-height:\s*2rem/);
    expect(rule('.ob-navitem-main')).toMatch(/gap:\s*0\.7143rem/);
    expect(rule('.ob-navgroup-label')).toMatch(/height:\s*2rem/);
    expect(rule('.ob-navgroup-label')).toMatch(/align-items:\s*flex-end/);
    expect(rule('.ob-navitem--child .ob-navitem-main')).toMatch(/min-height:\s*1\.8571rem/);
    expect(rule('.ob-navitem--child .ob-navitem-main')).toMatch(/border-radius:\s*0 var\(--r-md\) var\(--r-md\) 0/);
  });

  it('shows a count in the accent colour at 11px/500', () => {
    const count = rule('.ob-navitem-main .count');
    expect(count).toMatch(/color:\s*var\(--accent\)/);
    expect(count).toMatch(/font-weight:\s*500/);
  });

  it('collapses to 32px square icon buttons, centred, with the mark alone', () => {
    const collapsed = rule('.ob-sidebar--collapsed .ob-navitem-main');
    expect(collapsed).toMatch(/width:\s*2\.2857rem/);
    expect(collapsed).toMatch(/height:\s*2\.2857rem/);
    expect(rule('.ob-sidebar--collapsed .ob-sidebar-brand')).toMatch(/justify-content:\s*center/);
  });

  it('hides the scroll bar of the collapsed column so the centred icons stay centred', () => {
    expect(rule('.ob-sidebar--collapsed .ob-sidebar-nav')).toMatch(/padding:\s*var\(--s-12\) 0/);
    expect(css).toMatch(/\.ob-sidebar--collapsed \.ob-sidebar-nav\s*\{\s*scrollbar-width:\s*none/);
  });

  it('keeps a 36px collapse button', () => {
    expect(rule('.ob-sidebar-collapse')).toMatch(/height:\s*var\(--ctl-h-lg\)/);
  });
});

describe('segmented control (Navigation artboard)', () => {
  it('is a sunken track whose chosen segment is a raised chip with a hairline', () => {
    expect(rule('.ob-seg')).toMatch(/background:\s*var\(--bg-sunken\)/);
    const chosen = rule(".ob-seg > button[aria-pressed='true']");
    expect(chosen).toMatch(/background:\s*var\(--bg-surface\)/);
    expect(chosen).toMatch(/box-shadow:\s*0 0 0 1px var\(--line\)/);
    expect(chosen).toMatch(/font-weight:\s*550/);
  });
});

describe('tabs (Navigation artboard)', () => {
  it('are 36px tall with a 12px inset underline, a hover wash and a count badge', () => {
    expect(rule('.ob-tab')).toMatch(/height:\s*var\(--ctl-h-lg\)/);
    expect(rule(".ob-tab[aria-selected='true']::after")).toMatch(/left:\s*var\(--s-12\)/);
    expect(rule('.ob-tab:hover')).toMatch(/background:\s*var\(--bg-hover\)/);
    expect(rule('.ob-tab-count')).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  function Harness({ withDisabled }: { withDisabled: boolean }) {
    const [active, setActive] = useState('a');
    return (
      <Tabs
        activeId={active}
        onChange={setActive}
        tabs={[
          { id: 'a', label: 'Details' },
          { id: 'b', label: 'Line items', count: 4 },
          { id: 'c', label: 'Timeline', disabled: withDisabled },
          { id: 'd', label: 'Exports' },
        ]}
      />
    );
  }

  it('shows a count after the label, and skips a disabled tab on the arrow keys', () => {
    render(<Harness withDisabled />);
    expect(screen.getByRole('tab', { name: /Line items/ }).textContent).toContain('4');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Details' }), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('tab', { name: /Line items/ }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Exports' }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByRole('tab', { name: 'Timeline' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('visits every tab when none is disabled', () => {
    render(<Harness withDisabled={false} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Details' }), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('tab', { name: /Line items/ }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('status footer (Navigation and Shell artboards)', () => {
  it('is a 26px strip of 12px-padded cells, the sync state in its own colour when it is not fine', () => {
    expect(rule('.ob-footer')).toMatch(/height:\s*var\(--shell-footer-h\)/);
    expect(rule('.ob-footer')).toMatch(/gap:\s*0/);
    expect(rule('.ob-footer')).toMatch(/font-size:\s*var\(--t-small-size\)/);
    expect(rule(".ob-footer-sync[data-state='offline']," + String.fromCharCode(10) + ".ob-footer-sync[data-state='offlinePending']")).toMatch(
      /color:\s*var\(--state-offline\)/,
    );
    expect(rule(".ob-footer-sync[data-state='conflict']")).toMatch(/color:\s*var\(--state-conflict\)/);
  });

  it.each(['master/web', 'office/web'])('puts the sync state first and the version last in %s', (panel) => {
    const source = readFileSync(join(process.cwd(), panel, 'src', 'App.tsx'), 'utf8').split(String.fromCharCode(13)).join('');
    const footer = source.slice(source.indexOf('const footer = ('), source.indexOf('const ', source.indexOf('const footer = (') + 20));
    expect(footer.indexOf('ob-footer-sync')).toBeGreaterThan(-1);
    expect(footer.indexOf('ob-footer-sync')).toBeLessThan(footer.indexOf('ob-footer-user'));
    expect(footer.indexOf('ob-footer-user')).toBeLessThan(footer.indexOf('ob-footer-version'));
    expect(footer).toContain('data-state={railState}');
  });
});
