/**
 * The Party Access list screen, on both panels (`PartyAccessScreen.tsx`, one file in two
 * places — `master/tests/party-access-screen-parity.test.ts` keeps them the same).
 *
 * Mounted on its own rather than through `App`: what it pins is the screen's own behaviour
 * — the summary strip, the toolbar, the table, its states — with the panel's real `api.ts`
 * answering from a route table (`panel-harness.ts`). Run once per panel, because each has
 * its own `api` client and its own copy of `ui/`'s wiring.
 */

import { useState } from 'react';
import type { ComponentType } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureUi } from '../src/config.js';
import { t } from '../src/i18n.js';
import { KeyboardProvider } from '../src/KeyboardProvider.js';
import { __resetUnsavedWorkForTests } from '../src/unsavedWork.js';
import { installBrowserStubs, json, routeFetch, wait, type Call } from './panel-harness.js';

type Restriction = 'all' | 'open' | 'restricted';
interface ScreenProps {
  permissions: string[];
  revision: number;
  restriction: Restriction;
  onRestrictionChange: (restriction: Restriction) => void;
}

function assignee(id: string, name: string, level: 'view' | 'manage' = 'view') {
  return {
    userId: id,
    level,
    displayName: name,
    username: id,
    roleName: 'Sales',
    roleTier: 'staff',
    isActive: true,
    avatar: null,
  };
}

function party(n: number, assignees: ReturnType<typeof assignee>[] = []) {
  return {
    partyId: `p-${n}`,
    partyCode: `P${String(n).padStart(3, '0')}`,
    partyName: `Party ${n}`,
    city: `City ${n}`,
    version: 1,
    isRestricted: assignees.length > 0,
    assignees,
  };
}

const ANITA = assignee('u-1', 'Anita Rao', 'manage');
const VIKRAM = assignee('u-2', 'Vikram Shah');
const MEERA = assignee('u-3', 'Meera Iyer');
const ROHAN = assignee('u-4', 'Rohan Das');
const SAMIR = assignee('u-5', 'Samir Khan', 'manage');

const ROWS = [party(1, [ANITA]), party(2), party(3, [ANITA, VIKRAM, MEERA, ROHAN, SAMIR])];

const PEOPLE = [
  { id: 'u-1', displayName: 'Anita Rao', username: 'anita', roleName: 'Manager', roleTier: 'staff' },
  { id: 'u-2', displayName: 'Vikram Shah', username: 'vikram', roleName: 'Sales', roleTier: 'staff' },
];

const SUMMARY = { total: 450, restricted: 120, open: 330 };

const WRITE = ['party.assign', 'party.accessAll', 'parties.export'];

function query(call: Call): URLSearchParams {
  return new URL(call.url, 'http://panel.test').searchParams;
}

function path(call: Call): string {
  return new URL(call.url, 'http://panel.test').pathname;
}

/** The list requests only (not `/summary`, `/people`, or a save). */
function listCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.method === 'GET' && path(call) === '/api/party-access');
}

interface Mounted {
  calls: Call[];
  onRestrictionChange: ReturnType<typeof vi.fn>;
}

interface Routes {
  list?: (call: Call) => Response | undefined;
  summary?: Response;
  save?: (call: Call) => Response | undefined;
}

beforeEach(() => {
  installBrowserStubs();
  __resetUnsavedWorkForTests();
});
afterEach(cleanup);

describe.each(['master', 'office'] as const)('the Party Access list on the %s panel', (panel) => {
  async function mount(
    permissions: string[] = WRITE,
    routes: Routes = {},
    initial: Restriction = 'all',
  ): Promise<Mounted> {
    configureUi({ panel, defaultTheme: 'light', themeStorageKey: 'ob.theme' });
    const file = `../../${panel}/web/src/screens/PartyAccessScreen.tsx`;
    const { PartyAccessScreen } = (await import(/* @vite-ignore */ file)) as {
      PartyAccessScreen: ComponentType<ScreenProps>;
    };

    const calls = routeFetch((call) => {
      const where = path(call);
      if (where === '/api/party-access/summary') return routes.summary ?? json(SUMMARY);
      if (where === '/api/party-access/people') return json(PEOPLE);
      if (call.method === 'PUT') {
        return (
          routes.save?.(call) ??
          json({ ...ROWS[0], assignees: [], isRestricted: false, version: 2 })
        );
      }
      if (where === '/api/party-access') {
        return (
          routes.list?.(call) ??
          json({ items: ROWS, total: ROWS.length, limit: 200, offset: 0 })
        );
      }
      return undefined;
    });

    const onRestrictionChange = vi.fn();
    function Host() {
      const [restriction, setRestriction] = useState<Restriction>(initial);
      return (
        <KeyboardProvider panel={panel}>
          <PartyAccessScreen
            permissions={permissions}
            revision={0}
            restriction={restriction}
            onRestrictionChange={(next) => {
              onRestrictionChange(next);
              setRestriction(next);
            }}
          />
        </KeyboardProvider>
      );
    }
    render(<Host />);
    return { calls, onRestrictionChange };
  }

  async function loaded(): Promise<void> {
    await screen.findByText('Party 1');
  }

  const searchBox = (): HTMLInputElement =>
    screen.getByRole('textbox', { name: t('partyAccess.searchPlaceholder') });

  describe('the header and the summary strip', () => {
    it('has the title, a one-line explanation and the Export button', async () => {
      await mount();
      await loaded();

      expect(screen.getByRole('heading', { name: t('partyAccess.title') })).toBeTruthy();
      expect(screen.getByText(t('partyAccess.intro'))).toBeTruthy();
      const exportLink = screen.getByRole('link', { name: t('partyAccess.action.export') });
      expect(exportLink.getAttribute('href')).toBe('/api/party-access/export.csv');
    });

    it('has no Export button without parties.export', async () => {
      await mount(['party.assign']);
      await loaded();
      expect(screen.queryByRole('link', { name: t('partyAccess.action.export') })).toBeNull();
    });

    it('shows the company-wide counts, not the page: 450 parties, three rows on screen', async () => {
      const { calls } = await mount();
      await loaded();

      const strip = screen.getByRole('group', { name: t('partyAccess.strip.label') });
      await waitFor(() => expect(within(strip).getByText('450')).toBeTruthy());
      expect(within(strip).getByText('120')).toBeTruthy();
      expect(within(strip).getByText('330')).toBeTruthy();

      // The numbers come from `/summary`, which takes no search and no filter.
      const summary = calls.find((call) => path(call) === '/api/party-access/summary');
      expect(summary).toBeTruthy();
      expect(new URL(summary!.url, 'http://panel.test').search).toBe('');
    });

    it('keeps the strip company-wide while a search narrows the list', async () => {
      const { calls } = await mount();
      await loaded();
      fireEvent.change(searchBox(), { target: { value: 'Party 2' } });
      await waitFor(() => expect(listCalls(calls).some((c) => query(c).get('search') === 'Party 2')).toBe(true));

      const strip = screen.getByRole('group', { name: t('partyAccess.strip.label') });
      expect(within(strip).getByText('450')).toBeTruthy();
      // And it was not asked again with the term.
      expect(
        calls.filter((call) => path(call) === '/api/party-access/summary').every(
          (call) => new URL(call.url, 'http://panel.test').search === '',
        ),
      ).toBe(true);
    });

    it('filters when a count is clicked', async () => {
      const { calls, onRestrictionChange } = await mount();
      await loaded();

      const strip = screen.getByRole('group', { name: t('partyAccess.strip.label') });
      fireEvent.click(within(strip).getByRole('button', { name: new RegExp(t('partyAccess.strip.restricted')) }));

      expect(onRestrictionChange).toHaveBeenCalledWith('restricted');
      await waitFor(() =>
        expect(listCalls(calls).some((call) => query(call).get('restriction') === 'restricted')).toBe(true),
      );
      expect(
        within(strip)
          .getByRole('button', { name: new RegExp(t('partyAccess.strip.restricted')) })
          .getAttribute('aria-pressed'),
      ).toBe('true');
    });
  });

  describe('the search box', () => {
    it('is focused by Ctrl+F', async () => {
      await mount();
      await loaded();
      expect(document.activeElement).not.toBe(searchBox());

      // `offsetParent` is null for everything in jsdom; the provider asks for a visible box.
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
        configurable: true,
        get() {
          return this.parentNode;
        },
      });
      fireEvent.keyDown(document, { key: 'f', code: 'KeyF', ctrlKey: true });
      expect(document.activeElement).toBe(searchBox());
      delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
    });

    it('sends one request about 250 ms after the last keystroke, not one per key', async () => {
      const { calls } = await mount();
      await loaded();
      const before = listCalls(calls).length;

      for (const value of ['b', 'ba', 'bat']) fireEvent.change(searchBox(), { target: { value } });
      await wait(100);
      expect(listCalls(calls).length).toBe(before);

      await waitFor(() => expect(listCalls(calls).length).toBe(before + 1));
      expect(query(listCalls(calls).at(-1)!).get('search')).toBe('bat');
    });

    it('keeps focus in the box while the results arrive', async () => {
      const { calls } = await mount();
      await loaded();
      searchBox().focus();
      fireEvent.change(searchBox(), { target: { value: 'Party' } });
      await waitFor(() => expect(listCalls(calls).some((c) => query(c).get('search') === 'Party')).toBe(true));
      await wait(50);

      expect(document.activeElement).toBe(searchBox());
      // Not remounted either: it is the same element that still holds the text.
      expect(searchBox().value).toBe('Party');
    });

    it('has a clear button that empties the box and puts the caret back', async () => {
      await mount();
      await loaded();
      expect(screen.queryByRole('button', { name: t('partyAccess.search.clear') })).toBeNull();

      fireEvent.change(searchBox(), { target: { value: 'abc' } });
      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.search.clear') }));

      expect(searchBox().value).toBe('');
      expect(document.activeElement).toBe(searchBox());
    });

    it('is cleared by Esc', async () => {
      await mount();
      await loaded();
      fireEvent.change(searchBox(), { target: { value: 'abc' } });
      fireEvent.keyDown(searchBox(), { key: 'Escape' });
      expect(searchBox().value).toBe('');
    });
  });

  describe('the filters', () => {
    it('has All, Restricted and Open', async () => {
      const { calls, onRestrictionChange } = await mount();
      await loaded();

      const group = screen
        .getAllByRole('group')
        .find((element) => within(element).queryByRole('button', { name: t('partyAccess.filter.open') }));
      expect(group).toBeTruthy();
      fireEvent.click(within(group!).getByRole('button', { name: t('partyAccess.filter.open') }));

      expect(onRestrictionChange).toHaveBeenCalledWith('open');
      await waitFor(() =>
        expect(listCalls(calls).some((call) => query(call).get('restriction') === 'open')).toBe(true),
      );
    });

    it('filters by the person parties are assigned to, and the chip takes it off', async () => {
      const { calls } = await mount();
      await loaded();
      await waitFor(() => expect(calls.some((call) => path(call) === '/api/party-access/people')).toBe(true));

      const box = screen.getByPlaceholderText(t('partyAccess.filter.personPlaceholder'));
      fireEvent.focus(box);
      // The first choice is always "Nobody", then the people.
      const options = await screen.findAllByRole('option');
      expect(options[0]?.textContent).toBe(t('partyAccess.filter.nobody'));
      fireEvent.mouseDown(await screen.findByRole('option', { name: /Anita Rao/ }));

      await waitFor(() =>
        expect(listCalls(calls).some((call) => query(call).get('userId') === 'u-1')).toBe(true),
      );
      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.filter.personClear', { name: 'Anita Rao' }) }));
      await waitFor(() => expect(listCalls(calls).at(-1) && query(listCalls(calls).at(-1)!).get('userId')).toBeNull());
    });

    it('"Nobody" is the Open filter', async () => {
      const { onRestrictionChange } = await mount();
      await loaded();
      await waitFor(() => expect(screen.getByPlaceholderText(t('partyAccess.filter.personPlaceholder'))).toBeTruthy());

      fireEvent.focus(screen.getByPlaceholderText(t('partyAccess.filter.personPlaceholder')));
      fireEvent.mouseDown(await screen.findByRole('option', { name: t('partyAccess.filter.nobody') }));

      expect(onRestrictionChange).toHaveBeenCalledWith('open');
    });

    it('shows how many are showing out of how many, live', async () => {
      await mount(WRITE, {
        list: (call) => {
          const offset = Number(query(call).get('offset') ?? 0);
          return json({
            items: Array.from({ length: offset === 0 ? 200 : 50 }, (_, i) => party(offset + i + 1)),
            total: 250,
            limit: 200,
            offset,
          });
        },
      });
      await loaded();
      expect(screen.getByRole('status').textContent).toBe(t('partyAccess.count', { shown: 200, total: 250 }));

      fireEvent.click(screen.getByRole('button', { name: t('common.loadMore') }));
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toBe(t('partyAccess.count', { shown: 250, total: 250 })),
      );
    });
  });

  describe('the table', () => {
    it('sorts on the server by code, party, city and access, flipping on a second click', async () => {
      const { calls } = await mount();
      await loaded();

      for (const [column, key] of [
        [t('partyAccess.column.code'), 'code'],
        [t('partyAccess.column.party'), 'name'],
        [t('partyAccess.column.city'), 'city'],
        [t('partyAccess.column.access'), 'access'],
      ] as const) {
        fireEvent.click(screen.getByRole('button', { name: column }));
        await waitFor(() => {
          const last = query(listCalls(calls).at(-1)!);
          expect(last.get('sort')).toBe(key);
          expect(last.get('dir')).toBe('asc');
        });
      }

      const city = t('partyAccess.column.city');
      fireEvent.click(screen.getByRole('button', { name: city }));
      await waitFor(() => expect(query(listCalls(calls).at(-1)!).get('dir')).toBe('asc'));
      fireEvent.click(screen.getByRole('button', { name: city }));
      await waitFor(() => expect(query(listCalls(calls).at(-1)!).get('dir')).toBe('desc'));
      expect(screen.getByRole('columnheader', { name: new RegExp(city) }).getAttribute('aria-sort')).toBe('descending');
    });

    it('lists the first three names with their level, then "+N more" with everyone in the tooltip', async () => {
      await mount();
      await loaded();

      const row = screen.getByText('Party 3').closest('tr')!;
      expect(within(row).getByText(/Anita Rao/)).toBeTruthy();
      expect(within(row).getByText(/Meera Iyer/)).toBeTruthy();
      expect(within(row).queryByText(/Rohan Das/)).toBeNull();
      expect(within(row).getByText(t('partyAccess.more', { count: 2 }))).toBeTruthy();

      const cell = within(row).getByText(t('partyAccess.more', { count: 2 })).parentElement!;
      expect(cell.getAttribute('title')).toBe(
        'Anita Rao (Manage), Vikram Shah (View), Meera Iyer (View), Rohan Das (View), Samir Khan (Manage)',
      );
      // The level is a small tag next to the name.
      expect(within(row).getAllByText(t('partyAccess.level.manage')).length).toBeGreaterThan(0);
    });

    it('says "Everyone" for a party nobody is assigned to', async () => {
      await mount();
      await loaded();
      const row = screen.getByText('Party 2').closest('tr')!;
      expect(within(row).getByText(t('partyAccess.everyone'))).toBeTruthy();
    });

    it('moves between rows with Up and Down, and Enter opens the one in focus', async () => {
      await mount();
      await loaded();

      const first = screen.getByText('Party 1').closest('tr')!;
      first.focus();
      fireEvent.keyDown(first, { key: 'ArrowDown' });
      const second = screen.getByText('Party 2').closest('tr')!;
      expect(document.activeElement).toBe(second);
      fireEvent.keyDown(second, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(first);
      // The top row has nothing above it; the focus stays.
      fireEvent.keyDown(first, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(first);

      fireEvent.keyDown(second, { key: 'Enter' });
      expect(await screen.findByRole('dialog')).toBeTruthy();
    });

    it('keeps the row selected after a save', async () => {
      await mount();
      await loaded();

      fireEvent.click(screen.getByText('Party 1'));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: t('partyAccess.remove') }));
      fireEvent.click(within(dialog).getByRole('button', { name: t('partyAccess.action.save') }));

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByText('Party 1').closest('tr')!.getAttribute('data-selected')).toBe('true');
    });
  });

  describe('the states', () => {
    it('shows a skeleton with the table\'s own columns while loading', async () => {
      await mount(WRITE, { list: () => undefined });
      const skeleton = document.querySelector('.ob-pa-table [aria-hidden="true"]');
      expect(skeleton).toBeTruthy();
      // The toolbar and the strip are already there, so nothing moves when the rows arrive.
      expect(searchBox()).toBeTruthy();
      expect(within(skeleton as HTMLElement).getByText(t('partyAccess.column.assignedTo'))).toBeTruthy();
    });

    it('says which search found nothing and clears it from there', async () => {
      const { calls } = await mount(WRITE, {
        list: (call) =>
          query(call).get('search') === 'zzz'
            ? json({ items: [], total: 0, limit: 200, offset: 0 })
            : json({ items: ROWS, total: 3, limit: 200, offset: 0 }),
      });
      await loaded();

      fireEvent.change(searchBox(), { target: { value: 'zzz' } });
      expect(await screen.findByText(t('partyAccess.empty.search', { term: 'zzz' }))).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.empty.clear') }));
      expect(searchBox().value).toBe('');
      await screen.findByText('Party 1');
      expect(query(listCalls(calls).at(-1)!).get('search')).toBeNull();
    });

    it('shows the error with a Retry that asks again', async () => {
      let attempts = 0;
      const { calls } = await mount(WRITE, {
        list: () => {
          attempts += 1;
          return attempts === 1
            ? json({ error: { message: 'The Master is busy' } }, 500)
            : json({ items: ROWS, total: 3, limit: 200, offset: 0 });
        },
      });

      expect(await screen.findByText(t('partyAccess.error.load'))).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: t('action.retryNow') }));

      await screen.findByText('Party 1');
      expect(listCalls(calls).length).toBe(2);
    });
  });

  describe('who gets which controls', () => {
    it('shows "Edit access" on every row for somebody who may assign, and it opens the editor', async () => {
      await mount();
      await loaded();

      const buttons = screen.getAllByRole('button', { name: new RegExp(`^${t('partyAccess.action.edit')}:`) });
      expect(buttons.length).toBe(ROWS.length);
      fireEvent.click(buttons[1]!);
      expect(await screen.findByRole('dialog')).toBeTruthy();
    });

    it('gives a reader the same table and nothing to edit with: no button, no person filter, no Save', async () => {
      const { calls } = await mount(['party.accessAll']);
      await loaded();

      expect(screen.queryByRole('button', { name: new RegExp(`^${t('partyAccess.action.edit')}:`) })).toBeNull();
      expect(screen.queryByPlaceholderText(t('partyAccess.filter.personPlaceholder'))).toBeNull();
      // The people list is for assigning; a reader never asks for it.
      expect(calls.some((call) => path(call) === '/api/party-access/people')).toBe(false);

      fireEvent.click(screen.getByText('Party 1'));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).queryByRole('button', { name: t('partyAccess.action.save') })).toBeNull();
      expect(within(dialog).getAllByRole('button', { name: t('action.close') }).length).toBeGreaterThan(0);
    });
  });
});
