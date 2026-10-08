/**
 * The Office's New lead form, driven the way the counter drives it
 * (`docs/catalogue/CATALOGUE_MODEL.md` §6), in the whole panel booted in jsdom
 * (`panel-harness.ts` says how).
 *
 * Each case is a rule somebody at a counter would trip over, and none of them
 * is visible to a type check:
 *
 *  · the party list covered the form before anything was typed;
 *  · the follow-up starts at today + the company's default (3 unless set), and
 *    moves when the company changes it;
 *  · the product bar, then the same box as the product's sub-product bar, then
 *    the sub product's card (owner, 2026-10-08): Enter walks colour, quantity,
 *    packaging and grade, each list open as it is reached, then Add sub product,
 *    whose Enter adds the card and opens the sub-product bar of the same product
 *    again; Escape closes a list the walk opened, then walks back, and on the
 *    empty sub-product bar Escape or Backspace goes to the product bar;
 *  · the packaging box offers the company's list — Box, Grass, Paper — and one
 *    Enter takes the highlighted one and moves on; while the company requires
 *    packaging, a counted row without one does not add;
 *  · a multicolour sub product takes several colours, each its own line;
 *  · the product bar takes the code typed, however fast the Enter follows it;
 *  · so does the party box, and an Enter with nothing to take stays in the bar;
 *  · a source the company stops listing is not sent;
 *  · Shift+Q goes to the next product, adding a ready card — and is a capital Q
 *    anywhere it would do nothing, a colour box on a ready card included;
 *  · an Escape a list spent is claimed, and the page says when the shell's
 *    Escape may go Home (`data-esc-home`);
 *  · Ctrl+Enter reviews, Ctrl+Enter again saves, and only once.
 */

import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../src/i18n.js';
import {
  FakeEventSource,
  installBrowserStubs,
  json,
  loadApp,
  routeFetch,
  wait,
  type Call,
} from './panel-harness.js';

const CONNECTION = {
  hasNetworkLink: true,
  interfaces: [],
  isPaired: true,
  panelName: 'Counter',
  state: 'connected',
  masterHost: '10.0.0.1',
  masterPort: 4100,
  companyName: 'Acme Ceramics',
  lastError: null,
  lastSyncedAt: null,
  masterVersion: null,
};

const PARTY = {
  id: 'party-1',
  partyCode: 'P-001',
  name: 'Sharma Traders',
  city: 'Morbi',
  phone: '98250 00000',
};

/** Found by `Sha` after PARTY, and alone by `Shah`. */
const SHAH = { ...PARTY, id: 'party-2', partyCode: 'P-002', name: 'Shah Ceramics' };

const CATEGORY = {
  id: 'cat-1',
  name: 'ONE PIECE TOILET',
  code: 'OPT',
  brand: 'Swisware+',
  sortOrder: 1,
};

/** Ahead of OPT in catalogue order, so it heads the product bar before anything is typed. */
const WASH_BASIN = {
  id: 'cat-0',
  name: 'WASH BASIN',
  code: 'WB',
  brand: 'Swisware+',
  sortOrder: 0,
};

/** `fixed`: one variant whose label is the colour. */
const FIXED = {
  id: 'prod-1',
  name: 'Aqua Closet',
  categoryId: CATEGORY.id,
  categoryName: CATEGORY.name,
  categoryCode: CATEGORY.code,
  brand: CATEGORY.brand,
  sortOrder: 1,
  alias: null,
  size: 'L-27',
  multiColour: false,
  hasVariants: true,
  variants: [{ id: 'var-1', label: 'White', code: 'OPT-0001', weightKg: 30, isActive: true }],
};

/** `selectable`: multicolour, one variant with no label. */
const MULTI = {
  ...FIXED,
  id: 'prod-2',
  name: 'Orissa Pan',
  sortOrder: 2,
  multiColour: true,
  hasVariants: false,
  variants: [{ id: 'var-2', label: null, code: 'OPT-0002', weightKg: 12, isActive: true }],
};

/** `dedicated`: a numbered designer piece — no label, not multicolour; its design is its colour. */
const DEDICATED = {
  ...FIXED,
  id: 'prod-3',
  name: '1111',
  sortOrder: 3,
  hasVariants: false,
  variants: [{ id: 'var-3', label: null, code: 'OPT-0003', weightKg: 20, isActive: true }],
};

const COLOURS = ['White', 'Ivory'].map((name, index) => ({
  id: `colour-${index}`,
  listKey: 'stock.colour',
  value: name,
  label: name,
  hex: index === 0 ? '#ffffff' : '#fffff0',
  isActive: true,
  sortOrder: index,
}));

/** The packaging list as `20260328000000_line_packaging_defaults` seeds it. */
const PACKAGING = ['Box', 'Grass', 'Paper'].map((value, index) => ({
  id: `packaging-${index}`,
  listKey: 'line.packaging',
  value,
  label: value,
  hex: null,
  isActive: true,
  sortOrder: index,
}));

const GRADES = ['A', 'B'].map((value, index) => ({
  id: `grade-${index}`,
  listKey: 'line.grade',
  value,
  label: value,
  hex: null,
  isActive: true,
  sortOrder: index,
}));

const SOURCES = ['walk-in', 'phone'].map((value, index) => ({
  id: `source-${index}`,
  listKey: 'lead.sourcePlatform',
  value,
  label: value,
  hex: null,
  isActive: true,
  sortOrder: index,
}));

/** What the Master's pickers answer right now; a test changes it, then sends the change frame. */
const live = {
  categories: [WASH_BASIN, CATEGORY] as Array<typeof CATEGORY>,
  products: [MULTI, DEDICATED, FIXED] as Array<Record<string, unknown>>,
  /** An older Master (or none): the live-ids read answers `null`, "cannot tell". */
  older: false,
  /** The live-ids read never answers (a missing route, a stalled link). */
  hang: false,
  /** The link to the Master is down. */
  offline: false,
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    parties: [PARTY],
    products: [FIXED, MULTI],
    categories: [CATEGORY],
    partyVariants: [],
    leads: [],
    orders: [],
    pipelines: [],
    optionLists: COLOURS,
    customFields: [],
    conflicts: [],
    dashboard: { asOf: '2026-09-29T00:00:00.000Z' },
    permissions: [],
    serverHlc: '0',
    serverTime: '2026-09-29T00:00:00.000Z',
    pendingCount: 0,
    ...overrides,
  };
}

async function sendSnapshot(view: ReturnType<typeof snapshot>): Promise<void> {
  // The panel opens its stream in an effect; a frame sent before that reached nobody.
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  await act(async () => {
    FakeEventSource.instances.at(-1)!.emit('snapshot', view);
  });
}

/** Boots the Office panel on the New lead form and returns every request it made. */
async function openForm(view: Record<string, unknown> = {}): Promise<Call[]> {
  const calls = routeFetch(({ method, url, body }) => {
    const path = url.split('?')[0] ?? url;
    if (path === '/api/connection') {
      return json(live.offline ? { ...CONNECTION, state: 'disconnected' } : CONNECTION);
    }
    if (path === '/api/session') {
      return json({
        session: {
          userId: 'user-1',
          username: 'asha',
          displayName: 'Asha',
          roleId: null,
          roleName: 'Sales',
          roleTier: 'office',
          permissions: ['leads.view', 'leads.create'],
          offline: false,
          signedInAt: '2026-09-29T00:00:00.000Z',
        },
      });
    }
    if (path === '/api/sync') return json({ ...CONNECTION, pendingCount: 0, rejections: [] });
    if (path === '/api/pick/party') {
      const term = (new URL(url, 'http://panel').searchParams.get('q') ?? '').toLowerCase();
      const items = [PARTY, SHAH].filter((row) => row.name.toLowerCase().includes(term));
      return json({ items, truncated: false });
    }
    if (path === '/api/pick/category') {
      // Matched the way the Master matches: the code from its start, the name anywhere.
      const term = (new URL(url, 'http://panel').searchParams.get('q') ?? '').toLowerCase();
      const items = live.categories.filter(
        (row) => row.code.toLowerCase().startsWith(term) || row.name.toLowerCase().includes(term),
      );
      return json({ items, truncated: false });
    }
    if (path === '/api/pick/product') {
      const term = (new URL(url, 'http://panel').searchParams.get('q') ?? '').toLowerCase();
      const items = term
        ? live.products.filter((row) => String(row.name).toLowerCase().includes(term))
        : live.products;
      return json({ items, truncated: false });
    }
    if (path === '/api/pick/live-products' && method === 'POST') {
      if (live.hang) return new Promise<Response>(() => undefined);
      const ids = ((body as { ids?: string[] } | undefined)?.ids ?? []) as string[];
      return json({
        live: live.older ? null : ids.filter((id) => live.products.some((row) => row.id === id)),
      });
    }
    if (path === '/api/leads' && method === 'POST') {
      return json({ queued: true, id: 'L-TMP-1', mutationId: 'mut-1', pendingCount: 1 });
    }
    return undefined;
  });

  const App = await loadApp('office');
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await waitFor(() => expect(document.querySelector('.ob-footer')).not.toBeNull());
  await sendSnapshot(snapshot(view));
  fireEvent.click(
    within(document.querySelector<HTMLElement>('.ob-topbar')!).getByRole('button', {
      name: t('action.newLead'),
    }),
  );
  // The first open also compiles the screen, which takes a while under a full run.
  await screen.findByLabelText(t('lead.add.party.search'), {}, { timeout: 10_000 });
  return calls;
}

/** Local calendar date as `YYYY-MM-DD`, the way the form computes it. */
function isoDate(daysFromToday: number): string {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday);
  return [
    day.getFullYear(),
    String(day.getMonth() + 1).padStart(2, '0'),
    String(day.getDate()).padStart(2, '0'),
  ].join('-');
}

function searchBox(): HTMLInputElement {
  return screen.getByLabelText(t('lead.add.products.searchLabel'));
}

/** What a row is called to a screen reader: its code, and the colour it is in. */
const qtyLabel = (named: string): string => `${t('lead.add.draft.col.quantity')} — ${named}`;
const colourLabel = (code: string): string => `${t('lead.add.draft.colour')} — ${code}`;
const qtyBox = (named: string): HTMLInputElement => screen.getByLabelText(qtyLabel(named));

/** The party, so the form has one. */
async function chooseParty(): Promise<void> {
  fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), {
    target: { value: 'Sha' },
  });
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(PARTY.name) }));
}

/** The product off the product bar: the same box is then its sub-product bar, the list down. */
async function chooseProduct(): Promise<void> {
  fireEvent.focus(searchBox());
  fireEvent.mouseDown(await screen.findByRole('button', { name: new RegExp(CATEGORY.name) }));
  await screen.findByRole('button', { name: new RegExp(MULTI.name) });
}

/** Party, then the product, then `subProduct` picked off the sub-product bar: its card opens. */
async function pickSubProduct(subProduct: string = FIXED.name): Promise<void> {
  await chooseParty();
  await chooseProduct();
  fireEvent.mouseDown(
    within(screen.getByRole('listbox')).getByRole('button', { name: new RegExp(subProduct) }),
  );
  await waitFor(() => expect(document.querySelector('[data-product-card]')).not.toBeNull());
}

/** A multicolour row's colour: type to narrow, Enter takes it and goes on. */
async function pickColour(code: string, typed: string): Promise<void> {
  const box = colourBox(code);
  box.focus();
  fireEvent.change(box, { target: { value: typed } });
  await pressEnter(box);
}

/** A multicolour row's colour box: the input, not the list it opens under the same name. */
function colourBox(code: string): HTMLInputElement {
  return screen.getByLabelText(colourLabel(code), { selector: 'input' });
}

/** A row's packaging box, found the way its quantity is: by the variant or colour it is for. */
function packagingBox(named: string): HTMLInputElement {
  return screen.getByLabelText(`${t('lead.add.draft.packaging')} — ${named}`);
}

/** The grade box beside a row's packaging. */
function gradeBox(named: string): HTMLInputElement {
  return screen.getByLabelText(`${t('lead.add.draft.grade')} — ${named}`);
}

/** The card's Add sub product button. */
function addButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('[data-add-card]')!;
}

/** Add sub product drawn disabled: the card is short of something (it still takes the caret). */
const addOff = (): boolean => addButton().getAttribute('aria-disabled') === 'true';

/** Enter on a field, with the renders it causes let through. */
async function pressEnter(field: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(field, { key: 'Enter' });
    await wait(0);
  });
}

/** A key on whatever has the caret; true when nothing claimed it (`preventDefault`). */
async function press(key: string): Promise<boolean> {
  let unclaimed = true;
  await act(async () => {
    unclaimed = fireEvent.keyDown(document.activeElement!, { key });
    await wait(0);
  });
  return unclaimed;
}

/** The card is gone and the caret is back in the bar (put there in the commit that closes the card). */
async function backInTheBar(): Promise<void> {
  await waitFor(() => expect(document.activeElement).toBe(searchBox()));
  expect(document.querySelector('[data-product-card]')).toBeNull();
}

/**
 * The fixed sub product at 5, added by Enter: with no packaging or grade list (the default here)
 * the quantity's Enter goes to Add sub product, and the Enter there adds the card.
 */
async function enterOneLine(): Promise<void> {
  await pickSubProduct(FIXED.name);
  const qty = qtyBox('OPT-0001');
  fireEvent.change(qty, { target: { value: '5' } });
  await pressEnter(qty);
  expect(document.activeElement).toBe(addButton());
  await pressEnter(addButton());
  await backInTheBar();
}

function leadPosts(calls: Call[]): Call[] {
  return calls.filter((call) => call.url === '/api/leads' && call.method === 'POST');
}

const aside = (): HTMLElement => document.querySelector<HTMLElement>('.ob-order-aside')!;
const page = (): HTMLElement => document.querySelector<HTMLElement>('.ob-order-page')!;

beforeEach(() => {
  installBrowserStubs();
  live.categories = [WASH_BASIN, CATEGORY];
  live.products = [MULTI, DEDICATED, FIXED];
  live.older = false;
  live.hang = false;
  live.offline = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the party', () => {
  it('lists nothing until something is typed', async () => {
    const calls = await openForm();
    const partyBox = screen.getByLabelText(t('lead.add.party.search'));

    fireEvent.focus(partyBox);
    await act(async () => wait(300)); // past the picker's debounce

    expect(screen.queryByRole('button', { name: new RegExp(PARTY.name) })).toBeNull();
    expect(screen.queryByRole('button', { name: t('lead.add.party.create') })).toBeNull();
    expect(calls.some((call) => call.url.startsWith('/api/pick/party'))).toBe(false);

    fireEvent.change(partyBox, { target: { value: 'Sha' } });

    expect(await screen.findByRole('button', { name: new RegExp(PARTY.name) })).toBeTruthy();

    // Cleared again, the list goes at once — not a debounce later, with the
    // last term's rows still under an empty box for Tab to take.
    fireEvent.change(partyBox, { target: { value: '' } });

    expect(screen.queryByRole('button', { name: new RegExp(PARTY.name) })).toBeNull();
  });

  it('takes the party typed, on an Enter faster than the search', async () => {
    await openForm();
    const partyBox = screen.getByLabelText(t('lead.add.party.search'));
    fireEvent.change(partyBox, { target: { value: 'Sha' } });
    await screen.findByRole('button', { name: new RegExp(SHAH.name) });

    // One more letter and Enter at once: the list on screen is still `Sha`'s.
    fireEvent.change(partyBox, { target: { value: 'Shah' } });
    fireEvent.keyDown(partyBox, { key: 'Enter' });

    await screen.findByRole('button', { name: t('lead.add.party.change') });
    expect(screen.getByText(SHAH.name)).toBeTruthy();
    expect(screen.queryByText(PARTY.name)).toBeNull();
  });

  it('after Change party, takes the same text typed again on an Enter faster than the search', async () => {
    await openForm();
    await chooseParty();
    fireEvent.click(await screen.findByRole('button', { name: t('lead.add.party.change') }));
    await act(async () => wait(300)); // the empty box's rows are cleared

    // `Sha` was answered before the change; this Enter must wait for its own.
    const partyBox = screen.getByLabelText(t('lead.add.party.search'));
    fireEvent.change(partyBox, { target: { value: 'Sha' } });
    fireEvent.keyDown(partyBox, { key: 'Enter' });

    await screen.findByRole('button', { name: t('lead.add.party.change') });
    expect(screen.getByText(PARTY.name)).toBeTruthy();
  });

  it('opens New party on Enter over "+ Create a new party", with the typed name in it', async () => {
    await openForm();
    const partyBox = screen.getByLabelText(t('lead.add.party.search'));
    fireEvent.change(partyBox, { target: { value: 'Zzz Traders' } });
    await screen.findByRole('button', { name: t('lead.add.party.create') });
    await act(async () => wait(300)); // the empty answer has arrived

    await pressEnter(partyBox);

    const name = await screen.findByLabelText(new RegExp(t('party.field.name')));
    expect((name as HTMLInputElement).value).toBe('Zzz Traders');
    // And it did not walk on to the source box behind the dialog.
    expect(document.activeElement).not.toBe(screen.getByLabelText(t('lead.add.step.source')));
  });

  it('reaches "+ Create a new party" with the arrow keys past the matches, and Enter opens it', async () => {
    await openForm();
    const partyBox = screen.getByLabelText(t('lead.add.party.search'));
    fireEvent.change(partyBox, { target: { value: 'Sha' } });
    await screen.findByRole('button', { name: new RegExp(SHAH.name) });
    await act(async () => wait(300));

    fireEvent.keyDown(partyBox, { key: 'ArrowDown' });
    fireEvent.keyDown(partyBox, { key: 'ArrowDown' });
    await pressEnter(partyBox);

    const name = await screen.findByLabelText(new RegExp(t('party.field.name')));
    expect((name as HTMLInputElement).value).toBe('Sha');
    // No party was chosen on the way.
    expect(screen.queryByRole('button', { name: t('lead.add.party.change') })).toBeNull();
  });

  it('shows the chosen party by name, code and city (owner, 2026-10-07)', async () => {
    await openForm();
    await chooseParty();
    await screen.findByRole('button', { name: t('lead.add.party.change') });

    const chip = screen.getByText(PARTY.name).parentElement!;
    expect(within(chip).getByText(PARTY.partyCode)).toBeTruthy();
    expect(chip.textContent).toContain(PARTY.city);
  });
});

describe('the follow-up date', () => {
  it('starts at today + 3 when the company has not said otherwise', async () => {
    await openForm();

    expect((screen.getByLabelText(t('lead.add.details.followUp')) as HTMLInputElement).value).toBe(
      isoDate(3),
    );
  });

  it('moves with the company default while nobody has changed it', async () => {
    await openForm();

    await sendSnapshot(snapshot({ features: { followUpDefaultDays: 5 } }));

    expect((screen.getByLabelText(t('lead.add.details.followUp')) as HTMLInputElement).value).toBe(
      isoDate(5),
    );
  });
});

describe('the source', () => {
  it('moves off a source the company stops listing, so the Master does not refuse the lead', async () => {
    const calls = await openForm({ optionLists: [...COLOURS, ...SOURCES] });

    // The form started on the first source; the company then drops it.
    await sendSnapshot(snapshot({ optionLists: [...COLOURS, SOURCES[1]] }));
    await enterOneLine();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    const [post] = leadPosts(calls);
    expect((post?.body as { sourcePlatform: string | null }).sourcePlatform).toBe('phone');
  });
});

describe('the product bar', () => {
  it('takes the product whose code was typed, on an Enter faster than the search', async () => {
    await openForm();
    fireEvent.focus(searchBox());
    await screen.findByRole('button', { name: new RegExp(WASH_BASIN.name) });

    // No wait between the code and the Enter — the counter types `opt⏎` blind.
    fireEvent.change(searchBox(), { target: { value: 'opt' } });
    fireEvent.keyDown(searchBox(), { key: 'Enter' });

    // The same box is the product's sub-product bar now, its list down.
    expect(searchBox().placeholder).toBe(
      t('lead.add.products.productPlaceholder', { category: CATEGORY.name }),
    );
    expect(await screen.findByRole('button', { name: new RegExp(FIXED.name) })).toBeTruthy();
    expect(document.querySelector('[data-product-card]')).toBeNull();
  });

  it('keeps its rows, and the sub products after them, out of the Tab order', async () => {
    await openForm();
    // A Tab onto a row blurred the box, whose blur closed the list — the row
    // with the caret on it included.
    const tabbable = (): HTMLElement[] =>
      within(screen.getByRole('listbox'))
        .getAllByRole('button')
        .filter((row) => row.tabIndex >= 0);

    fireEvent.focus(searchBox());
    await screen.findByRole('button', { name: new RegExp(WASH_BASIN.name) });
    expect(tabbable()).toEqual([]);

    fireEvent.mouseDown(screen.getByRole('button', { name: new RegExp(CATEGORY.name) }));
    await screen.findByRole('button', { name: new RegExp(MULTI.name) });
    expect(tabbable()).toEqual([]);
  });

  it('keeps the caret in the bar on an Enter with nothing to take, not in the notes', async () => {
    await openForm();
    fireEvent.focus(searchBox());
    await screen.findByRole('button', { name: new RegExp(CATEGORY.name) });

    searchBox().focus();
    fireEvent.change(searchBox(), { target: { value: 'zzz' } });
    fireEvent.keyDown(searchBox(), { key: 'Enter' });

    expect(document.activeElement).toBe(searchBox());
  });
});

describe('the sub-product bar', () => {
  it('lists every sub product of the product, in catalogue order, asking for all of them', async () => {
    const calls = await openForm();
    await chooseParty();
    await chooseProduct();

    // The Master answered MULTI first; `sortOrder` puts FIXED first.
    const rows = within(screen.getByRole('listbox')).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining(FIXED.name),
      expect.stringContaining(MULTI.name),
      expect.stringContaining(DEDICATED.name),
    ]);
    const request = calls.find((call) => call.url.startsWith('/api/pick/product'))!;
    expect(new URL(request.url, 'http://panel').searchParams.get('limit')).toBe('1000');
    // No card yet: the card is one sub product, picked from this list.
    expect(document.querySelector('[data-product-card]')).toBeNull();
  });

  it('collapses to one short line a row and expands again, the choice kept on this PC', async () => {
    await openForm();
    await chooseParty();
    await chooseProduct();
    const pick = (): HTMLElement => document.querySelector<HTMLElement>('.ob-subpick')!;
    expect(pick().querySelector('.ob-subpick__count')!.textContent).toBe(
      t('lead.add.products.count', { count: 3 }),
    );
    expect(pick().dataset.compact).toBeUndefined();
    expect(pick().querySelector('.ob-thumb')).not.toBeNull();

    const collapse = screen.getByRole('button', { name: t('lead.add.products.collapse') });
    expect(fireEvent.mouseDown(collapse)).toBe(false);
    fireEvent.click(collapse);
    expect(pick().dataset.compact).toBe('true');
    expect(pick().querySelector('.ob-thumb')).toBeNull();
    expect(collapse.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('ob.order.subList.compact')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: t('lead.add.products.expand') }));
    expect(pick().dataset.compact).toBeUndefined();
    expect(window.localStorage.getItem('ob.order.subList.compact')).toBe('false');
  });

  it('narrows to what is typed, an exact name, code or colour first, then a prefix', async () => {
    // Ahead of FIXED in catalogue order, and only a prefix match for `white`.
    const whitewash = {
      ...FIXED,
      id: 'prod-4',
      name: 'Whitewash Pan',
      sortOrder: 0,
      variants: [{ id: 'var-4', label: 'Ivory', code: 'OPT-0004', weightKg: 9, isActive: true }],
    };
    live.products = [MULTI, DEDICATED, FIXED, whitewash];
    await openForm();
    await chooseProduct();

    fireEvent.change(searchBox(), { target: { value: 'white' } });
    const rows = within(screen.getByRole('listbox')).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining(FIXED.name),
      expect.stringContaining(whitewash.name),
    ]);
  });

  it('keeps the caret in the bar on an Enter with nothing to take, not in the notes', async () => {
    await openForm();
    await chooseProduct();

    searchBox().focus();
    fireEvent.change(searchBox(), { target: { value: 'zzz' } });
    fireEvent.keyDown(searchBox(), { key: 'Enter' });

    expect(document.activeElement).toBe(searchBox());
  });

  it('opens the sub product typed and taken with Enter, a fixed colour on its quantity (D10 R1)', async () => {
    await openForm();
    await chooseParty();
    await chooseProduct();

    fireEvent.change(searchBox(), { target: { value: FIXED.name } });
    await pressEnter(searchBox());

    const qty = await screen.findByLabelText(qtyLabel('OPT-0001'));
    expect(document.activeElement).toBe(qty);
    // One sub product on the card, not every one of the product.
    expect(document.querySelectorAll('[data-walk="qty"]')).toHaveLength(1);
  });

  it('opens on the one variant whose code was typed in full', async () => {
    const pair = {
      ...FIXED,
      id: 'prod-5',
      name: 'Twin Basin',
      sortOrder: 5,
      variants: [
        { id: 'var-5w', label: 'White', code: 'OPT-0005', weightKg: 9, isActive: true },
        { id: 'var-5i', label: 'Ivory', code: 'OPT-0006', weightKg: 9, isActive: true },
      ],
    };
    live.products = [MULTI, DEDICATED, FIXED, pair];
    await openForm();
    await chooseProduct();

    fireEvent.change(searchBox(), { target: { value: 'opt-0006' } });
    await pressEnter(searchBox());

    expect(await screen.findByLabelText(qtyLabel('OPT-0006'))).toBeTruthy();
    expect(screen.queryByLabelText(qtyLabel('OPT-0005'))).toBeNull();
  });

  it('goes back to the product bar on Backspace in the empty box', async () => {
    await openForm();
    await chooseProduct();

    expect(await press('Backspace')).toBe(false);
    expect(searchBox().placeholder).toBe(t('lead.add.products.categoryPlaceholder'));
    // The product list is down again.
    expect(await screen.findByRole('button', { name: new RegExp(WASH_BASIN.name) })).toBeTruthy();
  });

  it('closes its list on the first Escape and goes back to the product bar on the next, claiming both', async () => {
    await openForm();
    await chooseProduct();
    searchBox().focus();

    expect(await press('Escape')).toBe(false);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(searchBox().placeholder).toBe(
      t('lead.add.products.productPlaceholder', { category: CATEGORY.name }),
    );

    expect(await press('Escape')).toBe(false);
    expect(searchBox().placeholder).toBe(t('lead.add.products.categoryPlaceholder'));
    expect(document.activeElement).toBe(searchBox());
    expect(await screen.findByRole('button', { name: new RegExp(WASH_BASIN.name) })).toBeTruthy();
  });

  it('keeps a typed box: Escape there does not throw the product away', async () => {
    await openForm();
    await chooseProduct();
    searchBox().focus();
    fireEvent.change(searchBox(), { target: { value: 'aqua' } });

    await press('Escape'); // the list
    await press('Escape'); // the walk back, not the product
    expect(screen.getByLabelText(t('lead.add.products.searchLabel'))).toBeTruthy();
    expect(searchBox().placeholder).toBe(
      t('lead.add.products.productPlaceholder', { category: CATEGORY.name }),
    );
  });
});

describe('the sub product card', () => {
  const OPTIONS = { optionLists: [...COLOURS, ...PACKAGING, ...GRADES] };

  it('walks colour, quantity, packaging and grade, each list open as it is reached, then Add sub product, whose Enter adds and opens the sub-product bar of the same product again', async () => {
    const calls = await openForm(OPTIONS);
    await pickSubProduct(MULTI.name);

    // Colour first, its list already open with the first colour highlighted: Enter takes it.
    const box = colourBox('OPT-0002');
    expect(document.activeElement).toBe(box);
    const options = within(screen.getByRole('listbox', { name: colourLabel('OPT-0002') }));
    expect(options.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'White',
      'Ivory',
    ]);
    expect(options.getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true');
    await pressEnter(box);

    // The quantity.
    const qty = qtyBox('OPT-0002 · White');
    expect(document.activeElement).toBe(qty);
    fireEvent.change(qty, { target: { value: '10' } });
    await pressEnter(qty);

    // The packaging, its list open on arrival ("—" first: never chosen for anybody). Typed and
    // taken with Enter, which moves on.
    expect(document.activeElement).toBe(packagingBox('OPT-0002 · White'));
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['—', 'Box', 'Grass', 'Paper']);
    fireEvent.change(packagingBox('OPT-0002 · White'), { target: { value: 'gr' } });
    await pressEnter(packagingBox('OPT-0002 · White'));

    // The grade, its list open on arrival too: Enter takes it and goes on to Add sub product.
    expect(document.activeElement).toBe(gradeBox('OPT-0002 · White'));
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['—', 'A', 'B']);
    fireEvent.change(gradeBox('OPT-0002 · White'), { target: { value: 'b' } });
    await pressEnter(gradeBox('OPT-0002 · White'));

    // Not added yet: the caret is on Add sub product, and Enter there adds.
    expect(document.activeElement).toBe(addButton());
    expect(addButton().textContent).toContain(t('lead.add.draft.saveProduct'));
    expect(aside().querySelectorAll('[data-added-line]')).toHaveLength(0);
    await pressEnter(addButton());
    await backInTheBar();

    expect(within(aside()).getByText(MULTI.name)).toBeTruthy();
    // Back in the sub-product bar of the same product, its list open and nothing typed.
    expect(searchBox().value).toBe('');
    expect(searchBox().placeholder).toBe(
      t('lead.add.products.productPlaceholder', { category: CATEGORY.name }),
    );
    expect(
      within(screen.getByRole('listbox')).getByRole('button', { name: new RegExp(FIXED.name) }),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
    const [post] = leadPosts(calls);
    const items = (post?.body as { items: Array<Record<string, unknown>> }).items;
    expect(
      items.map(({ variantId, colour, packaging, grade, quantity }) => ({
        variantId,
        colour,
        packaging,
        grade,
        quantity,
      })),
    ).toEqual([
      { variantId: 'var-2', colour: 'White', packaging: 'Grass', grade: 'B', quantity: 10 },
    ]);
  });

  it('then takes the next sub product straight from the bar, and adds it as a line of its own', async () => {
    await openForm(OPTIONS);
    await pickSubProduct(FIXED.name);
    fireEvent.change(qtyBox('OPT-0001'), { target: { value: '5' } });
    await pressEnter(qtyBox('OPT-0001'));
    await pressEnter(packagingBox('OPT-0001'));
    await pressEnter(gradeBox('OPT-0001'));
    await pressEnter(addButton());
    await backInTheBar();

    fireEvent.change(searchBox(), { target: { value: DEDICATED.name } });
    await pressEnter(searchBox());
    const qty = await screen.findByLabelText(qtyLabel('OPT-0003'));
    expect(document.activeElement).toBe(qty);
    fireEvent.change(qty, { target: { value: '3' } });
    await pressEnter(qty);
    await pressEnter(packagingBox('OPT-0003'));
    await pressEnter(gradeBox('OPT-0003'));
    await pressEnter(addButton());
    await backInTheBar();

    expect(aside().querySelectorAll('[data-added-line]')).toHaveLength(2);
  });

  it('puts the caret in the bar in the commit that mounts it again, not a tick after it', async () => {
    await openForm(OPTIONS);
    await pickSubProduct(FIXED.name);
    fireEvent.change(qtyBox('OPT-0001'), { target: { value: '5' } });
    await pressEnter(qtyBox('OPT-0001'));
    await pressEnter(packagingBox('OPT-0001'));
    await pressEnter(gradeBox('OPT-0001'));

    // A focus left to a timer could find the bar not mounted yet, and the caret was lost.
    let focusedAtClose: boolean | null = null;
    const observer = new MutationObserver(() => {
      if (focusedAtClose !== null || document.querySelector('[data-product-card]')) return;
      const bar = screen.queryByLabelText(t('lead.add.products.searchLabel'));
      focusedAtClose = bar !== null && document.activeElement === bar;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    await pressEnter(addButton());
    observer.disconnect();

    expect(focusedAtClose).toBe(true);
    expect(aside().querySelectorAll('[data-added-line]')).toHaveLength(1);
  });

  it('skips an empty grade list: packaging goes straight to Add sub product, a mouse pick too', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING] });
    await pickSubProduct(FIXED.name);
    fireEvent.change(qtyBox('OPT-0001'), { target: { value: '5' } });
    await pressEnter(qtyBox('OPT-0001'));
    expect(document.activeElement).toBe(packagingBox('OPT-0001'));

    await act(async () => {
      fireEvent.mouseDown(within(screen.getByRole('listbox')).getByRole('option', { name: 'Box' }));
      await wait(0);
    });
    expect(document.activeElement).toBe(addButton());
    expect(aside().querySelectorAll('[data-added-line]')).toHaveLength(0);
  });

  it('opens on the quantity of a fixed colour, the colour shown and not asked', async () => {
    await openForm(OPTIONS);
    await pickSubProduct(FIXED.name);

    expect(document.activeElement).toBe(qtyBox('OPT-0001'));
    expect(screen.queryByLabelText(colourLabel('OPT-0001'))).toBeNull();
    expect(qtyBox('OPT-0001').closest('.ob-order-subrow')!.textContent).toContain('White');
  });

  it('focuses the first field in the commit that mounts the card, not a tick after it', async () => {
    await openForm(OPTIONS);
    await chooseParty();
    await chooseProduct();
    const row = within(screen.getByRole('listbox')).getByRole('button', {
      name: new RegExp(FIXED.name),
    });

    // A focus left to a later passive effect lands after whatever a fast keystroke (or a test) did
    // meanwhile, and takes the caret back to the first field; so it must already be there when
    // the DOM appears.
    let focusedAtMount: boolean | null = null;
    const observer = new MutationObserver(() => {
      const box = document.querySelector<HTMLElement>('[data-walk="qty"]');
      if (box && focusedAtMount === null) focusedAtMount = document.activeElement === box;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    fireEvent.mouseDown(row);
    await screen.findByLabelText(qtyLabel('OPT-0001'));
    observer.disconnect();

    expect(focusedAtMount).toBe(true);
  });

  it('walks back with Escape: grade, packaging, quantity, the list the walk opened closing first', async () => {
    await openForm(OPTIONS);
    await pickSubProduct(FIXED.name);
    const qty = qtyBox('OPT-0001');
    fireEvent.change(qty, { target: { value: '5' } });
    await pressEnter(qty);
    await pressEnter(packagingBox('OPT-0001'));
    expect(document.activeElement).toBe(gradeBox('OPT-0001'));

    // The grade's list opened as the walk arrived: the first Escape closes it, the caret stays.
    expect(await press('Escape')).toBe(false);
    expect(document.activeElement).toBe(gradeBox('OPT-0001'));
    expect(screen.queryByRole('listbox')).toBeNull();

    // Walked back to, a list stays shut: it opens as the walk arrives or on a click, not on a focus.
    for (const back of [packagingBox('OPT-0001'), qty]) {
      expect(await press('Escape')).toBe(false);
      expect(document.activeElement).toBe(back);
      expect(screen.queryByRole('listbox')).toBeNull();
    }
    act(() => gradeBox('OPT-0001').focus());
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(gradeBox('OPT-0001'));
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['—', 'A', 'B']);
  });

  it('goes back to the sub-product bar on Escape from the first field of a card nothing was typed into', async () => {
    await openForm(OPTIONS);
    await pickSubProduct(FIXED.name);

    expect(await press('Escape')).toBe(false);
    await backInTheBar();
    expect(searchBox().placeholder).toBe(
      t('lead.add.products.productPlaceholder', { category: CATEGORY.name }),
    );
  });

  it('keeps the caret on an empty quantity: Enter there adds nothing', async () => {
    await openForm(OPTIONS);
    await pickSubProduct(FIXED.name);
    const qty = qtyBox('OPT-0001');

    await pressEnter(qty);
    await act(async () => wait(0));

    expect(document.activeElement).toBe(qty);
    expect(addOff()).toBe(true);
    expect(aside().querySelectorAll('[data-added-line]')).toHaveLength(0);
  });

  it('with no packaging or grade list, goes from the quantity to Add sub product, whose Enter adds', async () => {
    await openForm();
    await enterOneLine();

    expect(within(aside()).getByText(FIXED.name)).toBeTruthy();
    expect(searchBox().placeholder).toBe(
      t('lead.add.products.productPlaceholder', { category: CATEGORY.name }),
    );
  });

  it('holds a counted row without packaging back while the company requires it, and Enter on the grade goes back to the packaging', async () => {
    await openForm({
      optionLists: [...COLOURS, ...PACKAGING, ...GRADES],
      features: { packagingRequiredOnConvert: true },
    });
    await pickSubProduct(FIXED.name);
    const qty = qtyBox('OPT-0001');
    fireEvent.change(qty, { target: { value: '5' } });
    await pressEnter(qty);

    expect(packagingBox('OPT-0001').getAttribute('aria-required')).toBe('true');
    expect(packagingBox('OPT-0001').getAttribute('aria-invalid')).toBe('true');
    expect(addOff()).toBe(true);
    // Required, the list offers no "—": it opens on the first real packaging, not on a none.
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Box', 'Grass', 'Paper']);

    // The list shut and nothing picked: the walk goes on to the grade, and the grade's Enter back
    // to the packaging, its list open.
    expect(await press('Escape')).toBe(false);
    await pressEnter(packagingBox('OPT-0001'));
    expect(document.activeElement).toBe(gradeBox('OPT-0001'));
    await pressEnter(gradeBox('OPT-0001'));
    await act(async () => wait(0));
    expect(document.activeElement).toBe(packagingBox('OPT-0001'));
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(3);
    expect(aside().querySelectorAll('[data-added-line]')).toHaveLength(0);

    // Add sub product, reached by Tab and pressed, does the same: the caret back on the packaging.
    act(() => addButton().focus());
    await pressEnter(addButton());
    expect(document.activeElement).toBe(packagingBox('OPT-0001'));
    expect(aside().querySelectorAll('[data-added-line]')).toHaveLength(0);

    // Box picked: the grade's Enter goes to Add sub product, and its Enter adds.
    fireEvent.change(packagingBox('OPT-0001'), { target: { value: 'bo' } });
    await pressEnter(packagingBox('OPT-0001'));
    expect(addOff()).toBe(false);
    await pressEnter(gradeBox('OPT-0001'));
    expect(document.activeElement).toBe(addButton());
    await pressEnter(addButton());
    await backInTheBar();
    expect(within(aside()).getByText(FIXED.name)).toBeTruthy();
  });

  it('with packaging required and no grades, reopens a shut packaging list on Enter, and takes the first packaging on to Add sub product', async () => {
    await openForm({
      optionLists: [...COLOURS, ...PACKAGING],
      features: { packagingRequiredOnConvert: true },
    });
    await pickSubProduct(FIXED.name);
    fireEvent.change(qtyBox('OPT-0001'), { target: { value: '5' } });
    await pressEnter(qtyBox('OPT-0001'));
    const packaging = packagingBox('OPT-0001');
    expect(document.activeElement).toBe(packaging);

    // Shut with Escape and nothing picked: Enter has nowhere to go but back here, and the list is
    // open again — the caret is never left on a shut box that no Enter opens.
    expect(await press('Escape')).toBe(false);
    expect(screen.queryByRole('listbox')).toBeNull();
    await pressEnter(packaging);
    await act(async () => wait(0));
    expect(document.activeElement).toBe(packaging);
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Box', 'Grass', 'Paper']);

    // Enter takes the first packaging and goes on to Add sub product, whose Enter adds.
    await pressEnter(packaging);
    await act(async () => wait(0));
    expect(packaging.value).toBe('Box');
    expect(document.activeElement).toBe(addButton());
    await pressEnter(addButton());
    await backInTheBar();
    expect(within(aside()).getByText(FIXED.name)).toBeTruthy();
  });

  it('adds from a click on Add sub product too, back to the sub-product bar of the same product', async () => {
    await openForm(OPTIONS);
    await pickSubProduct(FIXED.name);
    fireEvent.change(qtyBox('OPT-0001'), { target: { value: '5' } });

    await act(async () => {
      fireEvent.click(addButton());
      await wait(0);
    });
    await backInTheBar();

    expect(within(aside()).getByText(FIXED.name)).toBeTruthy();
    expect(searchBox().placeholder).toBe(
      t('lead.add.products.productPlaceholder', { category: CATEGORY.name }),
    );
  });

  it('closes from its ✕ without adding anything, back to the sub-product bar', async () => {
    await openForm(OPTIONS);
    await pickSubProduct(FIXED.name);
    fireEvent.change(qtyBox('OPT-0001'), { target: { value: '4' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.products.clear') }));
      await wait(0);
    });
    await backInTheBar();

    expect(aside().querySelectorAll('[data-added-line]')).toHaveLength(0);
    expect(searchBox().placeholder).toBe(
      t('lead.add.products.productPlaceholder', { category: CATEGORY.name }),
    );
  });

  it('groups the added lines by product and takes them back to the card to edit them together', async () => {
    await openForm();
    await enterOneLine();
    expect(aside().querySelectorAll('[data-added-group]')).toHaveLength(1);

    await act(async () => {
      fireEvent.click(
        within(aside()).getByRole('button', {
          name: t('lead.add.line.modifyProduct', { product: CATEGORY.name }),
        }),
      );
      await wait(0);
    });

    // The product's lines are rows again, quantity as it was, and off the lead meanwhile.
    expect(qtyBox('OPT-0001').value).toBe('5');
    expect(aside().querySelectorAll('[data-added-group]')).toHaveLength(0);
  });

  it('never throws away a card lifted from the list on Escape, even with its quantity cleared', async () => {
    await openForm();
    await enterOneLine();
    await act(async () => {
      fireEvent.click(
        within(aside()).getByRole('button', {
          name: t('lead.add.line.modifyProduct', { product: CATEGORY.name }),
        }),
      );
      await wait(0);
    });
    fireEvent.change(qtyBox('OPT-0001'), { target: { value: '' } });
    qtyBox('OPT-0001').focus();
    await press('Escape');

    // The lines left the order with the card: it stays open, and adds them back.
    expect(document.querySelector('[data-product-card]')).not.toBeNull();
    fireEvent.change(qtyBox('OPT-0001'), { target: { value: '5' } });
    await pressEnter(qtyBox('OPT-0001'));
    await pressEnter(addButton());
    await backInTheBar();
    expect(aside().querySelectorAll('[data-added-line]')).toHaveLength(1);
  });

  it('removes a product from the lead with its remove button', async () => {
    await openForm();
    await enterOneLine();

    await act(async () => {
      fireEvent.click(
        within(aside()).getByRole('button', {
          name: t('lead.add.line.removeProduct', { product: CATEGORY.name }),
        }),
      );
      await wait(0);
    });

    expect(aside().querySelectorAll('[data-added-group]')).toHaveLength(0);
  });
});

describe('the colour labels', () => {
  it("shows a colour by the list's CURRENT label, so a renamed colour reads the new way", async () => {
    const renamed = COLOURS.map((colour) =>
      colour.value === 'White' ? { ...colour, label: 'Pearl White' } : colour,
    );
    await openForm({ optionLists: [...renamed, ...PACKAGING, ...GRADES] });
    await pickSubProduct(MULTI.name);
    await pickColour('OPT-0002', 'Pea');

    // The card row, then the added line, both say the label.
    const qty = qtyBox('OPT-0002 · Pearl White');
    fireEvent.change(qty, { target: { value: '10' } });
    await act(async () => {
      fireEvent.click(addButton());
      await wait(0);
    });

    expect(aside().textContent).toContain('Pearl White');
    expect(aside().textContent).not.toContain('White ·');
  });
});

describe('a multicolour sub product', () => {
  const OPTIONS = { optionLists: [...COLOURS, ...PACKAGING, ...GRADES] };

  it('takes two colours, each with its own quantity, as two lines on one variant', async () => {
    const calls = await openForm(OPTIONS);
    await pickSubProduct(MULTI.name);

    await pickColour('OPT-0002', 'Whi');
    expect(document.activeElement).toBe(qtyBox('OPT-0002 · White'));
    fireEvent.change(qtyBox('OPT-0002 · White'), { target: { value: '10' } });

    // "+ Same sub product, another colour": a blank copy of the row right under it.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.card.anotherColour') }));
      await wait(0);
    });
    const copy = [...document.querySelectorAll<HTMLInputElement>('[data-walk="colour"]')][1]!;
    expect(copy.value).toBe('');
    copy.focus();
    fireEvent.change(copy, { target: { value: 'Ivo' } });
    await pressEnter(copy);
    fireEvent.change(qtyBox('OPT-0002 · Ivory'), { target: { value: '5' } });

    await act(async () => {
      fireEvent.click(addButton());
      await wait(0);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    const [post] = leadPosts(calls);
    const items = (post?.body as { items: Array<Record<string, unknown>> }).items;
    expect(
      items.map(({ variantId, colour, quantity }) => ({ variantId, colour, quantity })),
    ).toEqual([
      { variantId: 'var-2', colour: 'White', quantity: 10 },
      { variantId: 'var-2', colour: 'Ivory', quantity: 5 },
    ]);
  });

  it('puts the caret in the colour box of the new row when "another colour" is taken', async () => {
    await openForm(OPTIONS);
    await pickSubProduct(MULTI.name);
    await pickColour('OPT-0002', 'Whi');

    // One button, once, below the table (as on the artboard), working on the row the caret is in.
    expect(screen.getAllByRole('button', { name: t('lead.add.card.anotherColour') })).toHaveLength(
      1,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.card.anotherColour') }));
      await wait(10);
    });

    const boxes = [...document.querySelectorAll<HTMLInputElement>('[data-walk="colour"]')];
    expect(boxes).toHaveLength(2);
    expect(document.activeElement).toBe(boxes[1]);
  });

  it('holds a counted row without a colour back, and says so', async () => {
    await openForm(OPTIONS);
    await pickSubProduct(MULTI.name);
    fireEvent.change(qtyBox('OPT-0002'), { target: { value: '4' } });

    expect(addOff()).toBe(true);
    expect(document.body.textContent).toContain(t('lead.add.draft.hintColourRow'));

    await pickColour('OPT-0002', 'Whi');
    expect(addOff()).toBe(false);
  });

  it('puts the caret back on the colour box when Escape walks back from its quantity', async () => {
    await openForm(OPTIONS);
    await pickSubProduct(MULTI.name);
    await pickColour('OPT-0002', 'Whi');
    expect(document.activeElement).toBe(qtyBox('OPT-0002 · White'));

    await press('Escape');
    expect(document.activeElement).toBe(screen.getByLabelText(colourLabel('OPT-0002')));
  });
});

describe('Office: the catalogue changing while the entry is open', () => {
  const NEW_CATEGORY = {
    id: 'cat-new',
    name: 'NEW PAN RANGE',
    code: 'NPR',
    brand: 'Swisware+',
    sortOrder: 5,
  };

  /** The Master added a product category: the Office hears it as a small change frame. */
  async function masterAddsCategory(): Promise<void> {
    live.categories = [...live.categories, NEW_CATEGORY];
    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('change', {
        entity: 'product_category',
        action: 'created',
        id: NEW_CATEGORY.id,
        payload: {
          ...NEW_CATEGORY,
          tenantId: 't',
          createdAt: '2026-10-07T00:00:00.000Z',
          updatedAt: '2026-10-07T00:00:00.000Z',
          deletedAt: null,
        },
      });
      await wait(120); // past the shell's 60 ms batch of change frames
    });
  }

  it('offers a product added on the Master at once, with nothing reopened', async () => {
    await openForm();
    await chooseParty();
    fireEvent.focus(searchBox());
    await screen.findByRole('button', { name: new RegExp(CATEGORY.name) });
    expect(screen.queryByRole('button', { name: new RegExp(NEW_CATEGORY.name) })).toBeNull();

    await masterAddsCategory();

    expect(await screen.findByRole('button', { name: new RegExp(NEW_CATEGORY.name) })).toBeTruthy();
  });

  it('re-runs what was typed when the catalogue changes', async () => {
    await openForm();
    await chooseParty();
    fireEvent.focus(searchBox());
    fireEvent.change(searchBox(), { target: { value: 'NPR' } });
    expect(screen.queryByRole('button', { name: new RegExp(NEW_CATEGORY.name) })).toBeNull();

    await masterAddsCategory();

    expect(searchBox().value).toBe('NPR');
    expect(await screen.findByRole('button', { name: new RegExp(NEW_CATEGORY.name) })).toBeTruthy();
  });

  it('blocks the save when a product on the order was deleted, sending nothing and keeping the draft', async () => {
    const calls = await openForm();
    await enterOneLine();
    expect(document.querySelector('[data-catalogue-gone]')).toBeNull();

    live.products = live.products.filter((product) => product.id !== FIXED.id);
    await masterAddsCategory();

    await waitFor(() => expect(document.querySelector('[data-catalogue-gone]')).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
    expect(leadPosts(calls)).toHaveLength(0);
    expect(
      await screen.findByText(t('lead.add.errors.goneLines', { names: FIXED.name })),
    ).toBeTruthy();
    expect(screen.getAllByText(new RegExp(FIXED.name)).length).toBeGreaterThan(0);
  });

  it('clears the refusal once the product it named is removed from the lead', async () => {
    const calls = await openForm();
    await enterOneLine();

    live.products = live.products.filter((product) => product.id !== FIXED.id);
    await masterAddsCategory();
    await waitFor(() => expect(document.querySelector('[data-catalogue-gone]')).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
    const message = t('lead.add.errors.goneLines', { names: FIXED.name });
    expect(await screen.findByText(message)).toBeTruthy();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: t('lead.add.line.removeProduct', { product: CATEGORY.name }),
        }),
      );
      await wait(0);
    });

    expect(screen.queryByText(message)).toBeNull();
    expect(leadPosts(calls)).toHaveLength(0);
  });

  it('does not flag or block a product renamed on the Master while it was on the order', async () => {
    const calls = await openForm();
    await enterOneLine();

    live.products = live.products.map((product) =>
      product.id === FIXED.id ? { ...product, name: 'ZZ Renamed Closet' } : product,
    );
    await masterAddsCategory();
    await waitFor(() =>
      expect(calls.filter((call) => call.url === '/api/pick/live-products').length).toBeGreaterThan(
        1,
      ),
    );
    await act(async () => wait(50));
    expect(document.querySelector('[data-catalogue-gone]')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
    expect(leadPosts(calls)).toHaveLength(1);
  });

  it('asks the Master again at save time, so a delete not yet heard of still blocks the save', async () => {
    const calls = await openForm();
    await enterOneLine();
    await act(async () => wait(50));

    // Deleted on the Master with no change frame sent yet.
    live.products = live.products.filter((product) => product.id !== FIXED.id);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    expect(leadPosts(calls)).toHaveLength(0);
    expect(
      await screen.findByText(t('lead.add.errors.goneLines', { names: FIXED.name })),
    ).toBeTruthy();
  });

  it('saves anyway when the live-ids read never answers, after a short wait', async () => {
    live.hang = true;
    const calls = await openForm();
    await enterOneLine();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
    await waitFor(() => expect(leadPosts(calls)).toHaveLength(1), { timeout: 8000 });
  }, 20_000);

  it('does not ask at all while the link to the Master is down, and the save goes at once', async () => {
    live.offline = true;
    const calls = await openForm();
    await enterOneLine();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
    await waitFor(() => expect(leadPosts(calls)).toHaveLength(1));
    expect(calls.filter((call) => call.url === '/api/pick/live-products')).toHaveLength(0);
  });

  it('does not block when the Master cannot say (an older Master), and the save goes', async () => {
    const calls = await openForm();
    live.older = true;
    await enterOneLine();
    live.products = live.products.filter((product) => product.id !== FIXED.id);
    await masterAddsCategory();
    await waitFor(() =>
      expect(calls.filter((call) => call.url === '/api/pick/live-products').length).toBeGreaterThan(
        1,
      ),
    );
    await act(async () => wait(50));
    expect(document.querySelector('[data-catalogue-gone]')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
    expect(leadPosts(calls)).toHaveLength(1);
  });

  it('keeps the card, the typed quantity and the caret through a catalogue change', async () => {
    await openForm();
    await pickSubProduct(FIXED.name);
    const qty = qtyBox('OPT-0001');
    fireEvent.change(qty, { target: { value: '7' } });
    qty.focus();

    await masterAddsCategory();

    const again = qtyBox('OPT-0001');
    expect(again).toBe(qty);
    expect(again.value).toBe('7');
    expect(document.activeElement).toBe(again);
  });
});

describe('Office: the follow-up chips', () => {
  it('are one radio group beside the date, not three loose chips', async () => {
    await openForm();
    const group = document.querySelector<HTMLElement>('[data-follow-up-chips]')!;
    expect(group).not.toBeNull();
    // The three quick chips, and not the date box, share the one wrapping group.
    expect(group.querySelectorAll('button')).toHaveLength(3);
    expect(group.querySelector('input')).toBeNull();
    // One segmented radio group, the design's control, not three loose chips.
    expect(group.getAttribute('role')).toBe('radiogroup');
  });
});

describe('a dedicated sub product', () => {
  it('asks for a quantity only, and its line carries no colour', async () => {
    const calls = await openForm();
    await pickSubProduct(DEDICATED.name);

    // The owner's numbered designer pieces: no colour is chosen or shown (§2).
    const qty = qtyBox('OPT-0003');
    expect(screen.queryByLabelText(colourLabel('OPT-0003'))).toBeNull();
    expect(document.activeElement).toBe(qty);

    fireEvent.change(qty, { target: { value: '3' } });
    await pressEnter(qty);
    await pressEnter(addButton());
    await backInTheBar();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    const [post] = leadPosts(calls);
    const items = (post?.body as { items: Array<Record<string, unknown>> }).items;
    expect(
      items.map(({ variantId, colour, quantity }) => ({ variantId, colour, quantity })),
    ).toEqual([{ variantId: 'var-3', colour: null, quantity: 3 }]);
  });
});

describe('Shift+Q', () => {
  /** Shift+Q on whatever has the caret; true when nothing claimed it (a Q is typed). */
  async function shiftQ(target: HTMLElement = document.activeElement as HTMLElement) {
    let typed = true;
    await act(async () => {
      typed = fireEvent.keyDown(target, { key: 'Q', shiftKey: true });
      await wait(0);
    });
    return typed;
  }

  it('from the empty sub-product bar after an add, goes to the product bar, its list down', async () => {
    await openForm();
    await enterOneLine();

    expect(await shiftQ(searchBox())).toBe(false);
    expect(searchBox().placeholder).toBe(t('lead.add.products.categoryPlaceholder'));
    expect(await screen.findByRole('button', { name: new RegExp(WASH_BASIN.name) })).toBeTruthy();
  });

  it('is only a capital Q in the product bar, with no product chosen', async () => {
    await openForm();
    fireEvent.focus(searchBox());

    expect(await shiftQ(searchBox())).toBe(true);
    expect(searchBox().placeholder).toBe(t('lead.add.products.categoryPlaceholder'));
  });

  it('is a capital Q in the notes, and in a sub-product box with text in it', async () => {
    await openForm();
    await enterOneLine();

    const notes = screen.getByLabelText(t('lead.add.details.notes'));
    expect(fireEvent.keyDown(notes, { key: 'Q', shiftKey: true })).toBe(true);

    fireEvent.change(searchBox(), { target: { value: 'A' } });
    expect(fireEvent.keyDown(searchBox(), { key: 'Q', shiftKey: true })).toBe(true);

    // Still on the product: neither press finished it.
    expect(searchBox().placeholder).toBe(
      t('lead.add.products.productPlaceholder', { category: CATEGORY.name }),
    );
  });

  it("from a ready card's quantity, adds the card and goes to the product bar", async () => {
    await openForm();
    await pickSubProduct(FIXED.name);
    const qty = qtyBox('OPT-0001');
    fireEvent.change(qty, { target: { value: '5' } });

    expect(await shiftQ(qty)).toBe(false);
    await backInTheBar();

    expect(within(aside()).getByText(FIXED.name)).toBeTruthy();
    expect(searchBox().placeholder).toBe(t('lead.add.products.categoryPlaceholder'));
  });

  it('leaves a card with no quantity open, rather than finishing the product under it', async () => {
    await openForm();
    await pickSubProduct(FIXED.name);
    const qty = qtyBox('OPT-0001');

    expect(await shiftQ(qty)).toBe(true);
    expect(qtyBox('OPT-0001')).toBe(qty);

    // And the product is still chosen: the card, once filled, adds back to its bar.
    fireEvent.change(qty, { target: { value: '5' } });
    await pressEnter(qty);
    await pressEnter(addButton());
    await backInTheBar();
    expect(searchBox().placeholder).toBe(
      t('lead.add.products.productPlaceholder', { category: CATEGORY.name }),
    );
  });

  it('is a capital Q in the colour box, even on a card ready to add', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct(MULTI.name);
    await pickColour('OPT-0002', 'Whi');
    fireEvent.change(qtyBox('OPT-0002 · White'), { target: { value: '10' } });

    const colourBox = screen.getByLabelText(colourLabel('OPT-0002'));
    expect(fireEvent.keyDown(colourBox, { key: 'Q', shiftKey: true })).toBe(true);
    // The card is still open: the Q did not add it.
    expect(screen.getByLabelText(colourLabel('OPT-0002'))).toBe(colourBox);
  });
});

describe('Escape and the shell', () => {
  it('is claimed by the party box when it closes its list, and left alone when there is none', async () => {
    await openForm();
    const partyBox = screen.getByLabelText(t('lead.add.party.search'));
    partyBox.focus();
    fireEvent.change(partyBox, { target: { value: 'Sha' } });
    await screen.findByRole('button', { name: new RegExp(PARTY.name) });

    expect(await press('Escape')).toBe(false);
    expect(screen.queryByRole('button', { name: new RegExp(PARTY.name) })).toBeNull();
    // Nothing left to close, and the party is the first field: the shell may have this one.
    expect(await press('Escape')).toBe(true);
  });

  it('marks the page Home-able only while a new order holds nothing at all', async () => {
    await openForm();
    expect(page().getAttribute('data-esc-home')).toBe('true');

    // A product chosen is work.
    await chooseProduct();
    expect(page().getAttribute('data-esc-home')).toBe('false');
    await press('Backspace');
    await waitFor(() => expect(page().getAttribute('data-esc-home')).toBe('true'));

    // Typed text in the bar, a note, a party: each is work.
    fireEvent.change(searchBox(), { target: { value: 'op' } });
    expect(page().getAttribute('data-esc-home')).toBe('false');
    fireEvent.change(searchBox(), { target: { value: '' } });
    expect(page().getAttribute('data-esc-home')).toBe('true');
    fireEvent.change(screen.getByLabelText(t('lead.add.details.notes')), {
      target: { value: 'ring back' },
    });
    expect(page().getAttribute('data-esc-home')).toBe('false');
    fireEvent.change(screen.getByLabelText(t('lead.add.details.notes')), {
      target: { value: '' },
    });
    await chooseParty();
    expect(page().getAttribute('data-esc-home')).toBe('false');
  });
});

describe('Ctrl+Enter', () => {
  it('opens the review, and a second Ctrl+Enter saves the lead once however fast it repeats', async () => {
    const calls = await openForm();
    await enterOneLine();

    await act(async () => {
      fireEvent.keyDown(searchBox(), { key: 'Enter', ctrlKey: true });
    });
    const review = await screen.findByRole('dialog', { name: t('lead.add.review.title') });
    expect(leadPosts(calls)).toHaveLength(0);

    // The chord held down: its auto-repeat must not save a review nobody read.
    await act(async () => {
      fireEvent.keyDown(review, { key: 'Enter', ctrlKey: true, repeat: true });
      await wait(0);
    });
    expect(leadPosts(calls)).toHaveLength(0);

    // Two presses before any render: the second must not queue the lead again.
    await act(async () => {
      fireEvent.keyDown(review, { key: 'Enter', ctrlKey: true });
      fireEvent.keyDown(review, { key: 'Enter', ctrlKey: true });
      await wait(0);
    });

    expect(leadPosts(calls)).toHaveLength(1);
  });
});
