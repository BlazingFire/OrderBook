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
 *  · Enter walks quantity, then the packaging beside it; Enter on the last
 *    packaging adds the sub product and stays on the product, and Escape
 *    walks back;
 *  · the packaging box offers the company's list — Box, Grass, Paper — and one
 *    Enter takes the highlighted one and adds the card; while the company
 *    requires packaging, a counted row without one does not add;
 *  · a multicolour sub product takes several colours, each its own line;
 *  · the product bar takes the code typed, however fast the Enter follows it;
 *  · so does the party box, and an Enter with nothing to take stays in the bar;
 *  · a source the company stops listing is not sent;
 *  · Shift+Q finishes the product — and is a capital Q anywhere it would not,
 *    a colour box on a ready card included;
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

const SOURCES = ['walk-in', 'phone'].map((value, index) => ({
  id: `source-${index}`,
  listKey: 'lead.sourcePlatform',
  value,
  label: value,
  hex: null,
  isActive: true,
  sortOrder: index,
}));

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    parties: [PARTY],
    products: [FIXED, MULTI],
    categories: [CATEGORY],
    partyVariants: [],
    leads: [],
    orders: [],
    stock: [],
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
  const calls = routeFetch(({ method, url }) => {
    const path = url.split('?')[0] ?? url;
    if (path === '/api/connection') return json(CONNECTION);
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
        defaultLocale: 'en',
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
      const items = [WASH_BASIN, CATEGORY].filter(
        (row) => row.code.toLowerCase().startsWith(term) || row.name.toLowerCase().includes(term),
      );
      return json({ items, truncated: false });
    }
    if (path === '/api/pick/product') {
      return json({ items: [MULTI, DEDICATED, FIXED], truncated: false });
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
  await screen.findByRole('link', { name: t('footer.designSystem') });
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

/** Party, then the product, then `subProduct` picked off the sub-product bar. */
async function pickSubProduct(subProduct: string): Promise<void> {
  fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), {
    target: { value: 'Sha' },
  });
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(PARTY.name) }));

  fireEvent.focus(searchBox());
  fireEvent.mouseDown(await screen.findByRole('button', { name: new RegExp(CATEGORY.name) }));
  fireEvent.mouseDown(await screen.findByRole('button', { name: new RegExp(subProduct) }));
}

/** A row's packaging box, found the way its quantity is: by the variant or colour it is for. */
function packagingBox(named: string): HTMLInputElement {
  return screen.getByLabelText(`${t('lead.add.draft.packaging')} — ${named}`);
}

/** Enter on a field, with the renders it causes let through. */
async function pressEnter(field: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(field, { key: 'Enter' });
    await wait(0);
  });
}

/**
 * The fixed sub product at 5, added with Enter on its quantity and Enter on
 * the packaging beside it — the (only, so last) packaging, left at none.
 */
async function enterOneLine(): Promise<void> {
  await pickSubProduct(FIXED.name);
  const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`);
  fireEvent.change(qty, { target: { value: '5' } });
  await pressEnter(qty);
  await pressEnter(packagingBox('White'));
}

function leadPosts(calls: Call[]): Call[] {
  return calls.filter((call) => call.url === '/api/leads' && call.method === 'POST');
}

beforeEach(() => {
  installBrowserStubs();
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
    fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), {
      target: { value: 'Sha' },
    });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(PARTY.name) }));
    fireEvent.click(await screen.findByRole('button', { name: t('lead.add.party.change') }));
    await act(async () => wait(300)); // the empty box's rows are cleared

    // `Sha` was answered before the change; this Enter must wait for its own.
    const partyBox = screen.getByLabelText(t('lead.add.party.search'));
    fireEvent.change(partyBox, { target: { value: 'Sha' } });
    fireEvent.keyDown(partyBox, { key: 'Enter' });

    await screen.findByRole('button', { name: t('lead.add.party.change') });
    expect(screen.getByText(PARTY.name)).toBeTruthy();
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

    expect(searchBox().placeholder).toBe(
      t('lead.add.products.productPlaceholder', { category: CATEGORY.name }),
    );
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
});

describe('the sub-product bar', () => {
  it('lists every sub product of the product, in catalogue order, asking for all of them', async () => {
    const calls = await openForm();
    fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), {
      target: { value: 'Sha' },
    });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(PARTY.name) }));
    fireEvent.focus(searchBox());
    fireEvent.mouseDown(await screen.findByRole('button', { name: new RegExp(CATEGORY.name) }));
    await screen.findByRole('button', { name: new RegExp(MULTI.name) });

    // The Master answered MULTI first; `sortOrder` puts FIXED first.
    const rows = within(screen.getByRole('listbox')).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining(FIXED.name),
      expect.stringContaining(MULTI.name),
      expect.stringContaining(DEDICATED.name),
    ]);
    const request = calls.find((call) => call.url.startsWith('/api/pick/product'))!;
    expect(new URL(request.url, 'http://panel').searchParams.get('limit')).toBe('1000');
  });

  it('keeps the caret in the bar on an Enter with nothing to take, not in the notes', async () => {
    await openForm();
    fireEvent.focus(searchBox());
    fireEvent.mouseDown(await screen.findByRole('button', { name: new RegExp(CATEGORY.name) }));
    await screen.findByRole('button', { name: new RegExp(MULTI.name) });

    searchBox().focus();
    fireEvent.change(searchBox(), { target: { value: 'zzz' } });
    fireEvent.keyDown(searchBox(), { key: 'Enter' });

    expect(document.activeElement).toBe(searchBox());
  });

  it('walks an empty quantity on to its packaging, and stops there — out of the optional grade', async () => {
    await openForm();
    await pickSubProduct(FIXED.name);
    const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`);

    qty.focus();
    await pressEnter(qty);
    expect(document.activeElement).toBe(packagingBox('White'));

    await pressEnter(packagingBox('White'));
    expect(document.activeElement).toBe(packagingBox('White'));
    expect(screen.getByLabelText(`${t('lead.add.draft.col.quantity')} — White`)).toBe(qty);
  });

  it('adds the sub product on Enter in the last packaging and stays on the product', async () => {
    await openForm();
    await enterOneLine();

    // The card is gone, the line is on the lead, and the caret is back in the
    // sub-product bar with the product still chosen.
    expect(screen.queryByLabelText(`${t('lead.add.draft.col.quantity')} — White`)).toBeNull();
    expect(
      within(document.querySelector<HTMLElement>('.ob-lead-panel')!).getByText('OPT-0001'),
    ).toBeTruthy();
    expect(document.activeElement).toBe(searchBox());
    expect(searchBox().placeholder).toBe(
      t('lead.add.products.productPlaceholder', { category: CATEGORY.name }),
    );
  });
});

describe('the packaging beside each quantity', () => {
  it('is where Enter goes from the quantity, and Escape goes back', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING] });
    await pickSubProduct(FIXED.name);
    const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`);
    fireEvent.change(qty, { target: { value: '5' } });

    await pressEnter(qty);
    expect(document.activeElement).toBe(packagingBox('White'));
    // The company's list, in its order, after "—" for none.
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['—', 'Box', 'Grass', 'Paper']);

    await act(async () => {
      fireEvent.keyDown(packagingBox('White'), { key: 'Escape' });
      await wait(0);
    });
    expect(document.activeElement).toBe(qty);
  });

  it('takes the packaging typed and adds the card on the same Enter', async () => {
    const calls = await openForm({ optionLists: [...COLOURS, ...PACKAGING] });
    await pickSubProduct(FIXED.name);
    const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`);
    fireEvent.change(qty, { target: { value: '5' } });
    await pressEnter(qty);

    fireEvent.change(packagingBox('White'), { target: { value: 'gr' } });
    await pressEnter(packagingBox('White'));

    // Added: the card is gone and the caret is back in the sub-product bar.
    expect(screen.queryByLabelText(`${t('lead.add.draft.col.quantity')} — White`)).toBeNull();
    expect(document.activeElement).toBe(searchBox());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    const [post] = leadPosts(calls);
    const items = (post?.body as { items: Array<Record<string, unknown>> }).items;
    expect(items.map(({ variantId, packaging }) => ({ variantId, packaging }))).toEqual([
      { variantId: 'var-1', packaging: 'Grass' },
    ]);
  });

  it('forgets a mouse pick once it has rendered, so a row refilled since keeps what it shows', async () => {
    const calls = await openForm({ optionLists: [...COLOURS, ...PACKAGING] });
    await pickSubProduct(MULTI.name);
    const colourBox = await screen.findByLabelText(t('lead.add.flow.addColour'));
    fireEvent.change(colourBox, { target: { value: 'Whi' } });
    fireEvent.keyDown(colourBox, { key: 'Enter' });

    // Box by mouse, then the colour taken off and put back: the row is new and blank.
    fireEvent.focus(packagingBox('White'));
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Box' }));
    fireEvent.click(
      screen.getByRole('button', { name: t('lead.add.draft.removeColour', { colour: 'White' }) }),
    );
    fireEvent.change(colourBox, { target: { value: 'Whi' } });
    fireEvent.keyDown(colourBox, { key: 'Enter' });
    expect(packagingBox('White').value).toBe('—');

    const qty = screen.getByLabelText(`${t('lead.add.draft.col.quantity')} — White`);
    fireEvent.change(qty, { target: { value: '10' } });
    await pressEnter(qty);
    await pressEnter(packagingBox('White'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    const [post] = leadPosts(calls);
    const items = (post?.body as { items: Array<Record<string, unknown>> }).items;
    expect(items.map(({ colour, packaging }) => ({ colour, packaging }))).toEqual([
      { colour: 'White', packaging: '' },
    ]);
  });

  it('holds a counted row without packaging back while the company requires it', async () => {
    await openForm({
      optionLists: [...COLOURS, ...PACKAGING],
      features: { packagingRequiredOnConvert: true },
    });
    await pickSubProduct(FIXED.name);
    const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`);
    fireEvent.change(qty, { target: { value: '5' } });
    await pressEnter(qty);

    expect(packagingBox('White').getAttribute('aria-required')).toBe('true');
    await pressEnter(packagingBox('White'));
    // Still on the card, on the box that is missing.
    expect(document.activeElement).toBe(packagingBox('White'));
    expect(packagingBox('White').getAttribute('aria-invalid')).toBe('true');

    // The first arrow opens the list again, the second moves on to Box.
    await act(async () => {
      fireEvent.keyDown(packagingBox('White'), { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(packagingBox('White'), { key: 'ArrowDown' });
    });
    await pressEnter(packagingBox('White'));
    expect(screen.queryByLabelText(`${t('lead.add.draft.col.quantity')} — White`)).toBeNull();
    expect(
      within(document.querySelector<HTMLElement>('.ob-lead-panel')!).getByText('OPT-0001'),
    ).toBeTruthy();
  });
});

describe('a multicolour sub product', () => {
  it('takes two colours, each with its own quantity, as two lines on one variant', async () => {
    const calls = await openForm();
    await pickSubProduct(MULTI.name);

    const colourBox = await screen.findByLabelText(t('lead.add.flow.addColour'));
    for (const colour of ['Whi', 'Ivo']) {
      fireEvent.change(colourBox, { target: { value: colour } });
      fireEvent.keyDown(colourBox, { key: 'Enter' });
    }
    fireEvent.change(screen.getByLabelText(`${t('lead.add.draft.col.quantity')} — White`), {
      target: { value: '10' },
    });
    const ivory = screen.getByLabelText(`${t('lead.add.draft.col.quantity')} — Ivory`);
    fireEvent.change(ivory, { target: { value: '5' } });
    await pressEnter(ivory);
    await pressEnter(packagingBox('Ivory'));
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
});

describe('a dedicated sub product', () => {
  it('asks for a quantity only, and its line carries no colour', async () => {
    const calls = await openForm();
    await pickSubProduct(DEDICATED.name);

    // The owner's numbered designer pieces: no colour is chosen or shown (§2).
    const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — OPT-0003`);
    expect(screen.queryByLabelText(t('lead.add.flow.addColour'))).toBeNull();

    fireEvent.change(qty, { target: { value: '3' } });
    await pressEnter(qty);
    await pressEnter(packagingBox('OPT-0003'));
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
  it('after an Enter-add, finishes the product and goes to the product bar', async () => {
    await openForm();
    await enterOneLine();

    let typed = true;
    await act(async () => {
      typed = fireEvent.keyDown(searchBox(), { key: 'Q', shiftKey: true });
      await wait(0);
    });

    expect(typed).toBe(false);
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
    const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`);
    fireEvent.change(qty, { target: { value: '5' } });

    let typed = true;
    await act(async () => {
      typed = fireEvent.keyDown(qty, { key: 'Q', shiftKey: true });
      await wait(0);
    });

    expect(typed).toBe(false);
    expect(
      within(document.querySelector<HTMLElement>('.ob-lead-panel')!).getByText('OPT-0001'),
    ).toBeTruthy();
    expect(searchBox().placeholder).toBe(t('lead.add.products.categoryPlaceholder'));
  });

  it('leaves a card with no quantity open, rather than finishing the product under it', async () => {
    await openForm();
    await pickSubProduct(FIXED.name);
    const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`);

    let typed = false;
    await act(async () => {
      typed = fireEvent.keyDown(qty, { key: 'Q', shiftKey: true });
      await wait(0);
    });

    expect(typed).toBe(true);
    expect(screen.getByLabelText(`${t('lead.add.draft.col.quantity')} — White`)).toBe(qty);

    // And the product is still chosen: the card, once filled, adds back to its bar.
    fireEvent.change(qty, { target: { value: '5' } });
    await pressEnter(qty);
    await pressEnter(packagingBox('White'));
    expect(searchBox().placeholder).toBe(
      t('lead.add.products.productPlaceholder', { category: CATEGORY.name }),
    );
  });

  it('is a capital Q in the colour box, even on a card ready to add', async () => {
    await openForm();
    await pickSubProduct(MULTI.name);

    const colourBox = await screen.findByLabelText(t('lead.add.flow.addColour'));
    fireEvent.change(colourBox, { target: { value: 'Whi' } });
    fireEvent.keyDown(colourBox, { key: 'Enter' });
    fireEvent.change(screen.getByLabelText(`${t('lead.add.draft.col.quantity')} — White`), {
      target: { value: '10' },
    });

    expect(fireEvent.keyDown(colourBox, { key: 'Q', shiftKey: true })).toBe(true);
    // The card is still open: the Q did not add it.
    expect(screen.getByLabelText(t('lead.add.flow.addColour'))).toBe(colourBox);
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
