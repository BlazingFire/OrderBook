/**
 * The Party Access list screen, on both panels (`PartyAccessScreen.tsx`, one file in two
 * places — `master/tests/party-access-screen-parity.test.ts` keeps them the same).
 *
 * Mounted on its own rather than through `App`: what it pins is the screen's own behaviour
 * — the summary strip, the toolbar, the table, its states — with the panel's real `api.ts`
 * answering from a route table (`panel-harness.ts`). Run once per panel, because each has
 * its own `api` client and its own copy of `ui/`'s wiring.
 */

import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { useState } from 'react';
import type { ComponentType } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    // Party 1 was made by one of its assignees; party 3 by somebody no longer on it.
    ...(n === 1 ? { createdByUserId: 'u-1', createdByName: 'Anita Rao' } : {}),
    ...(n === 3 ? { createdByUserId: 'u-9', createdByName: 'Priya Nair' } : {}),
  };
}

const ANITA = assignee('u-1', 'Anita Rao', 'manage');
const VIKRAM = assignee('u-2', 'Vikram Shah');
const MEERA = assignee('u-3', 'Meera Iyer');
const ROHAN = assignee('u-4', 'Rohan Das');
const SAMIR = assignee('u-5', 'Samir Khan', 'manage');

const ROWS = [party(1, [ANITA]), party(2), party(3, [ANITA, VIKRAM, MEERA, ROHAN, SAMIR])];

const PEOPLE = [
  {
    id: 'u-1',
    displayName: 'Anita Rao',
    username: 'anita',
    roleName: 'Manager',
    roleTier: 'staff',
  },
  {
    id: 'u-2',
    displayName: 'Vikram Shah',
    username: 'vikram',
    roleName: 'Sales',
    roleTier: 'staff',
  },
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
  /** A live update from the Master: the screen's `revision` goes up by one. */
  bump: () => void;
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
          routes.list?.(call) ?? json({ items: ROWS, total: ROWS.length, limit: 200, offset: 0 })
        );
      }
      return undefined;
    });

    const onRestrictionChange = vi.fn();
    let setRevision: (update: (value: number) => number) => void = () => undefined;
    function Host() {
      const [restriction, setRestriction] = useState<Restriction>(initial);
      const [revision, setRev] = useState(0);
      setRevision = setRev;
      return (
        <KeyboardProvider panel={panel}>
          <PartyAccessScreen
            permissions={permissions}
            revision={revision}
            restriction={restriction}
            onRestrictionChange={(next) => {
              onRestrictionChange(next);
              setRestriction(next);
            }}
          />
        </KeyboardProvider>
      );
    }
    // The pane the app scrolls in: the table measures and scrolls against it.
    render(
      <div className="ob-pane">
        <Host />
      </div>,
    );
    return {
      calls,
      onRestrictionChange,
      bump: () => act(() => setRevision((value) => value + 1)),
    };
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

    it('tags the creator among the assignees, and names a creator who no longer holds the party', async () => {
      await mount();
      await loaded();

      const one = screen.getByText('Party 1').closest('tr')!;
      expect(within(one).getByText(t('partyAccess.creator'))).toBeTruthy();

      // Party 3 was made by somebody who is not among its five assignees: the tag has
      // nobody to sit on, so the creator is named in the list's tooltip instead.
      const three = screen.getByText('Party 3').closest('tr')!;
      expect(within(three).queryByText(t('partyAccess.creator'))).toBeNull();
      const names = three.querySelector('.ob-pa-assignees') as HTMLElement;
      expect(names.getAttribute('title')).toContain(t('partyAccess.createdBy', { name: 'Priya Nair' }));
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
      await waitFor(() =>
        expect(listCalls(calls).some((c) => query(c).get('search') === 'Party 2')).toBe(true),
      );

      const strip = screen.getByRole('group', { name: t('partyAccess.strip.label') });
      expect(within(strip).getByText('450')).toBeTruthy();
      // And it was not asked again with the term.
      expect(
        calls
          .filter((call) => path(call) === '/api/party-access/summary')
          .every((call) => new URL(call.url, 'http://panel.test').search === ''),
      ).toBe(true);
    });

    it('filters when a count is clicked', async () => {
      const { calls, onRestrictionChange } = await mount();
      await loaded();

      const strip = screen.getByRole('group', { name: t('partyAccess.strip.label') });
      fireEvent.click(
        within(strip).getByRole('button', { name: new RegExp(t('partyAccess.strip.restricted')) }),
      );

      expect(onRestrictionChange).toHaveBeenCalledWith('restricted');
      await waitFor(() =>
        expect(
          listCalls(calls).some((call) => query(call).get('restriction') === 'restricted'),
        ).toBe(true),
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

    it('sends one request 250 ms after the last keystroke: none at 249 ms, one at 250 ms', async () => {
      const { calls } = await mount();
      await loaded();
      const before = listCalls(calls).length;

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        // Each keystroke starts the wait again, so three keys are still one request.
        fireEvent.change(searchBox(), { target: { value: 'b' } });
        await act(async () => {
          vi.advanceTimersByTime(100);
        });
        fireEvent.change(searchBox(), { target: { value: 'ba' } });
        await act(async () => {
          vi.advanceTimersByTime(100);
        });
        fireEvent.change(searchBox(), { target: { value: 'bat' } });

        await act(async () => {
          vi.advanceTimersByTime(249);
        });
        expect(listCalls(calls).length).toBe(before);

        await act(async () => {
          vi.advanceTimersByTime(1);
        });
        expect(listCalls(calls).length).toBe(before + 1);
        expect(query(listCalls(calls).at(-1)!).get('search')).toBe('bat');
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps focus in the box while the results arrive', async () => {
      const { calls } = await mount();
      await loaded();
      searchBox().focus();
      fireEvent.change(searchBox(), { target: { value: 'Party' } });
      await waitFor(() =>
        expect(listCalls(calls).some((c) => query(c).get('search') === 'Party')).toBe(true),
      );
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
        .find((element) =>
          within(element).queryByRole('button', { name: t('partyAccess.filter.open') }),
        );
      expect(group).toBeTruthy();
      fireEvent.click(within(group!).getByRole('button', { name: t('partyAccess.filter.open') }));

      expect(onRestrictionChange).toHaveBeenCalledWith('open');
      await waitFor(() =>
        expect(listCalls(calls).some((call) => query(call).get('restriction') === 'open')).toBe(
          true,
        ),
      );
    });

    it('filters by the person parties are assigned to, and the chip takes it off', async () => {
      const { calls } = await mount();
      await loaded();
      await waitFor(() =>
        expect(calls.some((call) => path(call) === '/api/party-access/people')).toBe(true),
      );

      const box = screen.getByPlaceholderText(t('partyAccess.filter.personPlaceholder'));
      fireEvent.focus(box);
      // The first choice is always "Nobody", then the people.
      const options = await screen.findAllByRole('option');
      expect(options[0]?.textContent).toBe(t('partyAccess.filter.nobody'));
      fireEvent.mouseDown(await screen.findByRole('option', { name: /Anita Rao/ }));

      await waitFor(() =>
        expect(listCalls(calls).some((call) => query(call).get('userId') === 'u-1')).toBe(true),
      );
      fireEvent.click(
        screen.getByRole('button', {
          name: t('partyAccess.filter.personClear', { name: 'Anita Rao' }),
        }),
      );
      await waitFor(() =>
        expect(listCalls(calls).at(-1) && query(listCalls(calls).at(-1)!).get('userId')).toBeNull(),
      );
    });

    it('choosing Open takes the person filter off, so the result cannot be empty by contradiction', async () => {
      const { calls } = await mount();
      await loaded();
      await waitFor(() =>
        expect(calls.some((call) => path(call) === '/api/party-access/people')).toBe(true),
      );

      fireEvent.focus(screen.getByPlaceholderText(t('partyAccess.filter.personPlaceholder')));
      fireEvent.mouseDown(await screen.findByRole('option', { name: /Anita Rao/ }));
      await waitFor(() =>
        expect(listCalls(calls).some((c) => query(c).get('userId') === 'u-1')).toBe(true),
      );
      expect(
        screen.getByRole('button', {
          name: t('partyAccess.filter.personClear', { name: 'Anita Rao' }),
        }),
      ).toBeTruthy();

      // From the strip, as well as from the segmented control.
      const strip = screen.getByRole('group', { name: t('partyAccess.strip.label') });
      fireEvent.click(
        within(strip).getByRole('button', { name: new RegExp(t('partyAccess.strip.open')) }),
      );

      await waitFor(() => {
        const last = query(listCalls(calls).at(-1)!);
        expect(last.get('restriction')).toBe('open');
        expect(last.get('userId')).toBeNull();
      });
      expect(
        screen.queryByRole('button', {
          name: t('partyAccess.filter.personClear', { name: 'Anita Rao' }),
        }),
      ).toBeNull();
      // And no request ever asked for both at once.
      expect(
        listCalls(calls).some(
          (c) => query(c).get('restriction') === 'open' && query(c).get('userId') !== null,
        ),
      ).toBe(false);
    });

    it('"Nobody" is the Open filter', async () => {
      const { onRestrictionChange } = await mount();
      await loaded();
      await waitFor(() =>
        expect(screen.getByPlaceholderText(t('partyAccess.filter.personPlaceholder'))).toBeTruthy(),
      );

      fireEvent.focus(screen.getByPlaceholderText(t('partyAccess.filter.personPlaceholder')));
      fireEvent.mouseDown(
        await screen.findByRole('option', { name: t('partyAccess.filter.nobody') }),
      );

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
      expect(screen.getByRole('status').textContent).toBe(
        t('partyAccess.count', { shown: 200, total: 250 }),
      );

      fireEvent.click(screen.getByRole('button', { name: t('common.loadMore') }));
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toBe(
          t('partyAccess.count', { shown: 250, total: 250 }),
        ),
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
      expect(
        screen.getByRole('columnheader', { name: new RegExp(city) }).getAttribute('aria-sort'),
      ).toBe('descending');
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

    it('moves between rows with Up and Down on the party buttons, and Enter opens the one in focus', async () => {
      await mount();
      await loaded();

      const first = screen.getByRole('button', { name: 'Party 1' });
      first.focus();
      fireEvent.keyDown(first, { key: 'ArrowDown' });
      const second = screen.getByRole('button', { name: 'Party 2' });
      expect(document.activeElement).toBe(second);
      fireEvent.keyDown(second, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(first);
      // The top row has nothing above it; the focus stays.
      fireEvent.keyDown(first, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(first);

      // A button's Enter is its click: the native path, not a handler of ours.
      fireEvent.click(second);
      expect(await screen.findByRole('dialog')).toBeTruthy();
    });

    it('is not a button with a button inside it: the row is a row, the party name is the one control', async () => {
      await mount();
      await loaded();

      expect(document.querySelectorAll('tr[data-row][role="button"]').length).toBe(0);
      expect(document.querySelectorAll('[role="button"] button').length).toBe(0);
      const rowControls = screen.getByText('Party 1').closest('tr')!.querySelectorAll('button');
      // The name, and (for somebody who may assign) Edit access: siblings, not nested.
      expect(rowControls.length).toBe(2);
      expect(rowControls[0]!.querySelector('button')).toBeNull();
    });

    it('ends long names, codes and cities in an ellipsis with the whole text as the title', async () => {
      const long = party(9, [ANITA]);
      long.partyName = 'Shree Ganesh Tiles & Sanitaryware Traders Private Limited';
      long.partyCode = 'P-0099-LONG-CODE';
      long.city = 'Thiruvananthapuram Cantonment';
      await mount(WRITE, { list: () => json({ items: [long], total: 1, limit: 200, offset: 0 }) });
      await screen.findByText(long.partyName);

      const name = screen.getByRole('button', { name: long.partyName });
      expect(name.getAttribute('title')).toBe(long.partyName);
      expect(name.className).toContain('ob-pa-open');
      expect(screen.getByText(long.partyCode).getAttribute('title')).toBe(long.partyCode);
      expect(screen.getByText(long.city).getAttribute('title')).toBe(long.city);
      // The ellipsis itself is CSS, pinned beside the table rule below.
      expect(screen.getByText(long.city).className).toContain('ob-pa-ellipsis');
    });

    it('marks a grant held by somebody no longer active: muted, tagged, still counted', async () => {
      const gone = { ...VIKRAM, isActive: false };
      await mount(WRITE, {
        list: () => json({ items: [party(7, [ANITA, gone])], total: 1, limit: 200, offset: 0 }),
      });
      await screen.findByText('Party 7');

      const row = screen.getByText('Party 7').closest('tr')!;
      const tag = within(row).getByText(t('partyAccess.editor.deactivated'));
      expect(tag.closest('.ob-pa-inactive')?.textContent).toContain('Vikram Shah');
      // The active one is not tagged.
      expect(
        within(row)
          .getByText(/Anita Rao/)
          .closest('.ob-pa-inactive'),
      ).toBeNull();
      expect(within(row).getAllByText(t('partyAccess.editor.deactivated')).length).toBe(1);
      expect(
        within(row)
          .getByText(t('partyAccess.level.manage'))
          .closest('.ob-pa-assignees')
          ?.getAttribute('title'),
      ).toContain(`Vikram Shah (View) — ${t('partyAccess.editor.deactivated')}`);
    });

    it('dims the rows while a filter is being fetched, and stops when it arrives', async () => {
      let release: (response: Response) => void = () => undefined;
      let calls = 0;
      await mount(WRITE, {
        list: () => {
          calls += 1;
          if (calls === 1) return json({ items: ROWS, total: 3, limit: 200, offset: 0 });
          return new Promise<Response>((resolve) => {
            release = resolve;
          }) as unknown as Response;
        },
      });
      await loaded();
      const table = (): HTMLElement => document.querySelector('.ob-pa-table') as HTMLElement;
      expect(table().getAttribute('aria-busy')).toBe('false');

      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.filter.restricted') }));
      await waitFor(() => expect(table().getAttribute('aria-busy')).toBe('true'));
      // The old rows are still there, not a skeleton.
      expect(screen.getByText('Party 1')).toBeTruthy();

      await act(async () => {
        release(json({ items: [ROWS[0]], total: 1, limit: 200, offset: 0 }));
      });
      await waitFor(() => expect(table().getAttribute('aria-busy')).toBe('false'));
    });

    it('keeps every page already loaded when the Master pushes an update', async () => {
      const page = (offset: number) =>
        json({
          items: Array.from({ length: offset === 0 ? 200 : 50 }, (_, i) => party(offset + i + 1)),
          total: 250,
          limit: 200,
          offset,
        });
      const { calls, bump } = await mount(WRITE, {
        list: (call) => page(Number(query(call).get('offset') ?? 0)),
      });
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: t('common.loadMore') }));
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toBe(
          t('partyAccess.count', { shown: 250, total: 250 }),
        ),
      );
      const before = listCalls(calls).length;

      bump();
      await waitFor(() => expect(listCalls(calls).length).toBe(before + 2));
      // Both pages again, from the top, and nothing was thrown away meanwhile.
      expect(
        listCalls(calls)
          .slice(-2)
          .map((call) => query(call).get('offset')),
      ).toEqual([null, '200']);
      expect(screen.getByRole('status').textContent).toBe(
        t('partyAccess.count', { shown: 250, total: 250 }),
      );
      expect(document.querySelector('.ob-pa-table .ob-tablewrap[aria-hidden="true"]')).toBeNull();
    });

    it('keeps the focus on a row while an arrow key is held down past the rendered window', async () => {
      const page = () =>
        json({
          items: Array.from({ length: 200 }, (_, i) => party(i + 1)),
          total: 200,
          limit: 200,
          offset: 0,
        });
      await mount(WRITE, { list: () => page() });
      await loaded();

      const pane = document.querySelector('.ob-pane') as HTMLElement;
      let top = 0;
      Object.defineProperty(pane, 'clientHeight', { configurable: true, get: () => 320 });
      Object.defineProperty(pane, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = value;
          pane.dispatchEvent(new Event('scroll'));
        },
      });
      await act(async () => {
        pane.dispatchEvent(new Event('scroll'));
      });

      const first = await screen.findByRole('button', { name: 'Party 1' });
      first.focus();

      // The focused row unmounts when the window moves on; the browser then hands the
      // focus to <body> and every later key goes nowhere. Sampled between the keys.
      let lost = 0;
      const sampler = window.setInterval(() => {
        if (document.activeElement === document.body) lost += 1;
      }, 2);

      try {
        // A held key repeats about every 36 ms: far more presses than the window holds
        // rows, each one arriving before the table has caught up with the last.
        for (let press = 0; press < 70; press += 1) {
          const target = document.activeElement as HTMLElement;
          fireEvent.keyDown(target.isConnected ? target : document.body, { key: 'ArrowDown' });
          await act(async () => {
            await wait(3);
          });
        }
        await waitFor(() => expect(document.activeElement?.textContent).toBe('Party 71'));
      } finally {
        window.clearInterval(sampler);
      }

      expect(lost).toBe(0);
      expect(document.activeElement?.tagName).toBe('BUTTON');
    });

    it('moves on to a row beyond the rendered window with Down, scrolling to it first', async () => {
      const page = () =>
        json({
          items: Array.from({ length: 200 }, (_, i) => party(i + 1)),
          total: 200,
          limit: 200,
          offset: 0,
        });
      await mount(WRITE, { list: () => page() });
      await loaded();

      // jsdom lays nothing out: give the pane a height and a scrollTop that fires `scroll`.
      const pane = document.querySelector('.ob-pane') as HTMLElement;
      let top = 0;
      Object.defineProperty(pane, 'clientHeight', { configurable: true, get: () => 320 });
      Object.defineProperty(pane, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = value;
          pane.dispatchEvent(new Event('scroll'));
        },
      });
      await act(async () => {
        pane.dispatchEvent(new Event('scroll'));
      });

      // 320 px of 32 px rows plus the table's overscan: the window ends at Party 26.
      const last = await screen.findByRole('button', { name: 'Party 26' });
      expect(screen.queryByRole('button', { name: 'Party 27' })).toBeNull();

      last.focus();
      fireEvent.keyDown(last, { key: 'ArrowDown' });
      await waitFor(() => expect(document.activeElement?.textContent).toBe('Party 27'));
      expect(top).toBeGreaterThan(0);
    });

    it('keeps the row selected after a save, and asks for the strip counts again', async () => {
      const { calls } = await mount();
      await loaded();

      fireEvent.click(screen.getByText('Party 1'));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(
        within(dialog).getByRole('button', {
          name: t('partyAccess.editor.removeFor', { name: 'Anita Rao' }),
        }),
      );
      fireEvent.click(within(dialog).getByRole('button', { name: t('partyAccess.action.save') }));

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByText('Party 1').closest('tr')!.getAttribute('data-selected')).toBe('true');
      // The save changed who is restricted; nothing else would tell the strip.
      await waitFor(() =>
        expect(calls.filter((call) => path(call) === '/api/party-access/summary').length).toBe(2),
      );
    });
  });

  describe('the states', () => {
    it("shows a skeleton with the table's own columns while loading", async () => {
      await mount(WRITE, { list: () => undefined });
      const skeleton = document.querySelector('.ob-pa-table [aria-hidden="true"]');
      expect(skeleton).toBeTruthy();
      // The toolbar and the strip are already there, so nothing moves when the rows arrive.
      expect(searchBox()).toBeTruthy();
      expect(
        within(skeleton as HTMLElement).getByText(t('partyAccess.column.assignedTo')),
      ).toBeTruthy();
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

      const buttons = screen.getAllByRole('button', {
        name: new RegExp(`^${t('partyAccess.action.edit')}:`),
      });
      expect(buttons.length).toBe(ROWS.length);
      fireEvent.click(buttons[1]!);
      expect(await screen.findByRole('dialog')).toBeTruthy();
    });

    it('gives a reader the same table and the filters, and nothing to edit with: no button, no Save', async () => {
      const { calls } = await mount(['party.accessAll']);
      await loaded();

      expect(
        screen.queryByRole('button', { name: new RegExp(`^${t('partyAccess.action.edit')}:`) }),
      ).toBeNull();
      // The person filter is a reading control: a reader has it, fed by the same people list.
      expect(screen.getByPlaceholderText(t('partyAccess.filter.personPlaceholder'))).toBeTruthy();
      expect(calls.some((call) => path(call) === '/api/party-access/people')).toBe(true);

      fireEvent.click(screen.getByText('Party 1'));
      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).queryByRole('button', { name: t('partyAccess.action.save') }),
      ).toBeNull();
      expect(
        within(dialog).getAllByRole('button', { name: t('action.close') }).length,
      ).toBeGreaterThan(0);
    });
  });
});

describe('the table the list sits in', () => {
  it('clips its corners without becoming a scroll container, so the sticky header sticks to the pane', () => {
    const css = readFileSync(nodePath.join(__dirname, '..', 'src', 'base.css'), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    const block = css.match(/\n\.ob-tablewrap \{([^}]*)\}/)?.[1] ?? '';
    // `overflow: hidden` alone makes `.ob-tablewrap` the sticky containing block, which never
    // scrolls: the header scrolled away with the rows. `clip` must be the winning declaration.
    expect(block).toMatch(/overflow: clip;/);
    expect(block.lastIndexOf('overflow: clip')).toBeGreaterThan(
      block.lastIndexOf('overflow: hidden'),
    );
  });
});

describe('the styles of the list', () => {
  const css = readFileSync(nodePath.join(__dirname, '..', 'src', 'base.css'), 'utf8')
    .split(String.fromCharCode(13))
    .join('');
  const rule = (selector: string): string => {
    const at = css.indexOf(selector + ' {');
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('ends a long name, code or city in an ellipsis instead of cutting it mid-word', () => {
    const at = css.indexOf('.ob-pa-ellipsis,');
    const block = css.slice(at, css.indexOf('}', at));
    expect(block).toContain('.ob-pa-open');
    expect(block).toContain('text-overflow: ellipsis');
    expect(block).toContain('overflow: hidden');
    expect(block).toContain('white-space: nowrap');
    expect(block).toContain('min-width: 0');
  });

  it('shrinks the summary strip to one line at a narrow width or a large scale', () => {
    expect(css).toContain('container: pa-strip / inline-size');
    const query = css.slice(css.indexOf('@container pa-strip'));
    expect(query).toContain('max-width: 44rem');
    expect(query).toContain('.ob-pa-stat-hint');
    expect(query).toContain('display: none');
  });

  it('dims the rows while a refetch is under way', () => {
    expect(rule('.ob-pa-table[data-fetching]')).toContain('opacity');
  });
});
