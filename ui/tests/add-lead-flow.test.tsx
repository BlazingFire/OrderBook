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

/** Party, then the product: its card opens with every sub product at once. */
async function pickSubProduct(): Promise<void> {
  fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), {
    target: { value: 'Sha' },
  });
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(PARTY.name) }));

  fireEvent.focus(searchBox());
  fireEvent.mouseDown(await screen.findByRole('button', { name: new RegExp(CATEGORY.name) }));
  await screen.findByLabelText(qtyLabel('OPT-0001'));
}

/** A multicolour row's colour: type to narrow, Enter takes it and goes on. */
async function pickColour(code: string, typed: string): Promise<void> {
  const box = screen.getByLabelText(colourLabel(code));
  box.focus();
  fireEvent.change(box, { target: { value: typed } });
  await pressEnter(box);
}

/** A row's packaging box, found the way its quantity is: by the variant or colour it is for. */
function packagingBox(named: string): HTMLInputElement {
  return screen.getByLabelText(`${t('lead.add.draft.packaging')} — ${named}`);
}

/** The grade box beside a row's packaging. */
function gradeBox(named: string): HTMLInputElement {
  return screen.getByLabelText(`${t('lead.add.draft.grade')} — ${named}`);
}

/** The draft card's Add product button — the last stop of its Enter walk. */
function addButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('[data-add-card]')!;
}

/**
 * Enter through a row's packaging and grade, both left as they are, then Add product (a click,
 * which is what Enter over a button is).
 */
async function finishCard(named: string): Promise<void> {
  await pressEnter(packagingBox(named));
  await pressEnter(gradeBox(named));
  await act(async () => {
    fireEvent.click(addButton());
    await wait(0);
  });
}

/** Enter on a field, with the renders it causes let through. */
async function pressEnter(field: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(field, { key: 'Enter' });
    await wait(0);
  });
}

/** The fixed sub product's row at 5, walked with Enter through packaging and grade, then Add. */
async function enterOneLine(): Promise<void> {
  await pickSubProduct();
  const qty = qtyBox('OPT-0001');
  fireEvent.change(qty, { target: { value: '5' } });
  await pressEnter(qty);
  await finishCard('OPT-0001');
}

function leadPosts(calls: Call[]): Call[] {
  return calls.filter((call) => call.url === '/api/leads' && call.method === 'POST');
}

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
    fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), {
      target: { value: 'Sha' },
    });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(PARTY.name) }));
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

    // The product opens its card, on the first row's quantity.
    expect(await screen.findByLabelText(qtyLabel('OPT-0001'))).toBeTruthy();
  });

  it('keeps its rows out of the Tab order', async () => {
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

describe('the product card', () => {
  it('lists every sub product of the product, in catalogue order, asking for all of them', async () => {
    const calls = await openForm();
    await pickSubProduct();

    // The Master answered MULTI first; `sortOrder` puts FIXED first.
    expect(
      [...document.querySelectorAll<HTMLInputElement>('[data-walk="qty"]')].map((box) =>
        box.getAttribute('aria-label'),
      ),
    ).toEqual([qtyLabel('OPT-0001'), qtyLabel('OPT-0002'), qtyLabel('OPT-0003')]);
    const request = calls.find((call) => call.url.startsWith('/api/pick/product'))!;
    expect(new URL(request.url, 'http://panel').searchParams.get('limit')).toBe('1000');
  });

  it('opens on the first row quantity, and shows each row its colour by the sub product rule', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct();

    expect(document.activeElement).toBe(qtyBox('OPT-0001'));
    // Fixed: the colour is shown, not chosen. Selectable: a colour box. Dedicated: none.
    expect(screen.queryByLabelText(colourLabel('OPT-0001'))).toBeNull();
    expect(screen.getByLabelText(colourLabel('OPT-0002'))).toBeTruthy();
    expect(screen.queryByLabelText(colourLabel('OPT-0003'))).toBeNull();
    const fixedRow = qtyBox('OPT-0001').closest('.ob-order-subrow')!;
    expect(fixedRow.textContent).toContain('White');
  });

  it('walks an empty quantity past its packaging and grade, onto the next row', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct();

    qtyBox('OPT-0001').focus();
    await pressEnter(qtyBox('OPT-0001'));

    // Nothing was counted on the first row: its packaging and grade are not stops.
    expect(document.activeElement).toBe(screen.getByLabelText(colourLabel('OPT-0002')));
    expect(addButton().disabled).toBe(true);
  });

  it('after the last row, Enter lands on Add product, which stays off until a row is counted', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct();

    const last = qtyBox('OPT-0003');
    last.focus();
    await pressEnter(last);

    // An off button takes no focus, so the caret stays on the empty row.
    expect(addButton().disabled).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('adds the counted rows from Add product, reached by Enter, and returns to the product bar', async () => {
    await openForm();
    await enterOneLine();

    // The card is gone, the product is on the lead, and the caret is back in the bar.
    expect(screen.queryByLabelText(qtyLabel('OPT-0001'))).toBeNull();
    expect(
      within(document.querySelector<HTMLElement>('.ob-order-aside')!).getByText(FIXED.name),
    ).toBeTruthy();
    expect(document.activeElement).toBe(searchBox());
    expect(searchBox().placeholder).toBe(t('lead.add.products.categoryPlaceholder'));
  });

  it('groups the added lines by product and takes them back to the card to edit them together', async () => {
    await openForm();
    await enterOneLine();
    const aside = (): HTMLElement => document.querySelector<HTMLElement>('.ob-order-aside')!;
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
    expect((qtyBox('OPT-0001') as HTMLInputElement).value).toBe('5');
    expect(aside().querySelectorAll('[data-added-group]')).toHaveLength(0);
  });

  it('removes a product from the lead with its remove button', async () => {
    await openForm();
    await enterOneLine();
    const aside = document.querySelector<HTMLElement>('.ob-order-aside')!;

    await act(async () => {
      fireEvent.click(
        within(aside).getByRole('button', {
          name: t('lead.add.line.removeProduct', { product: CATEGORY.name }),
        }),
      );
      await wait(0);
    });

    expect(aside.querySelectorAll('[data-added-group]')).toHaveLength(0);
  });
});

describe('the colour labels', () => {
  it("shows a colour by the list's CURRENT label, so a renamed colour reads the new way", async () => {
    const renamed = COLOURS.map((colour) =>
      colour.value === 'White' ? { ...colour, label: 'Pearl White' } : colour,
    );
    await openForm({ optionLists: [...renamed, ...PACKAGING, ...GRADES] });
    await pickSubProduct();
    await pickColour('OPT-0002', 'Pea');

    // The card row, then the added line, both say the label.
    const qty = qtyBox('OPT-0002 · Pearl White');
    fireEvent.change(qty, { target: { value: '10' } });
    await act(async () => {
      fireEvent.click(addButton());
      await wait(0);
    });

    const aside = document.querySelector<HTMLElement>('.ob-order-aside')!;
    expect(aside.textContent).toContain('Pearl White');
    expect(aside.textContent).not.toContain('White ·');
  });
});

describe('the packaging and grade beside each quantity', () => {
  it('walks quantity, packaging, grade and the next row with Enter, and back with Escape', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct();
    const qty = qtyBox('OPT-0001');
    fireEvent.change(qty, { target: { value: '5' } });

    await pressEnter(qty);
    expect(document.activeElement).toBe(packagingBox('OPT-0001'));
    // The company's list, in its order, after "—" for none.
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['—', 'Box', 'Grass', 'Paper']);

    await pressEnter(packagingBox('OPT-0001'));
    expect(document.activeElement).toBe(gradeBox('OPT-0001'));
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['—', 'A', 'B']);

    await pressEnter(gradeBox('OPT-0001'));
    // On to the next row, which asks for its colour first.
    expect(document.activeElement).toBe(screen.getByLabelText(colourLabel('OPT-0002')));

    for (const back of [gradeBox('OPT-0001'), packagingBox('OPT-0001'), qty]) {
      await act(async () => {
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        await wait(0);
      });
      // Escape on the colour box closes its list first; press again if it is still there.
      if (document.activeElement !== back) {
        await act(async () => {
          fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
          await wait(0);
        });
      }
      expect(document.activeElement).toBe(back);
    }
  });

  it('moves on to the next row once packaging and grade are picked, and sends them with the line', async () => {
    const calls = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct();
    const qty = qtyBox('OPT-0001');
    fireEvent.change(qty, { target: { value: '5' } });
    await pressEnter(qty);

    // Typed and taken with Enter.
    fireEvent.change(packagingBox('OPT-0001'), { target: { value: 'gr' } });
    await pressEnter(packagingBox('OPT-0001'));
    expect(document.activeElement).toBe(gradeBox('OPT-0001'));

    // Picked with the mouse.
    await act(async () => {
      fireEvent.mouseDown(await screen.findByRole('option', { name: 'B' }));
      await wait(0);
    });
    expect(document.activeElement).toBe(screen.getByLabelText(colourLabel('OPT-0002')));

    await act(async () => {
      fireEvent.click(addButton());
      await wait(0);
    });
    expect(screen.queryByLabelText(qtyLabel('OPT-0001'))).toBeNull();
    expect(document.activeElement).toBe(searchBox());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    const [post] = leadPosts(calls);
    const items = (post?.body as { items: Array<Record<string, unknown>> }).items;
    expect(
      items.map(({ variantId, packaging, grade }) => ({ variantId, packaging, grade })),
    ).toEqual([{ variantId: 'var-1', packaging: 'Grass', grade: 'B' }]);
  });

  it('holds a counted row without packaging back while the company requires it', async () => {
    await openForm({
      optionLists: [...COLOURS, ...PACKAGING],
      features: { packagingRequiredOnConvert: true },
    });
    await pickSubProduct();
    const qty = qtyBox('OPT-0001');
    fireEvent.change(qty, { target: { value: '5' } });
    await pressEnter(qty);

    expect(packagingBox('OPT-0001').getAttribute('aria-required')).toBe('true');
    expect(packagingBox('OPT-0001').getAttribute('aria-invalid')).toBe('true');
    // Add product is off while a counted row has no packaging.
    expect(addButton().disabled).toBe(true);

    // Pick Box: the first arrow opens the list, the second moves to Box, Enter takes it.
    packagingBox('OPT-0001').focus();
    await act(async () => {
      fireEvent.keyDown(packagingBox('OPT-0001'), { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(packagingBox('OPT-0001'), { key: 'ArrowDown' });
    });
    await pressEnter(packagingBox('OPT-0001'));
    expect(addButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(addButton());
      await wait(0);
    });
    expect(screen.queryByLabelText(qtyLabel('OPT-0001'))).toBeNull();
    expect(
      within(document.querySelector<HTMLElement>('.ob-order-aside')!).getByText(FIXED.name),
    ).toBeTruthy();
  });
});

describe('a multicolour sub product', () => {
  it('takes two colours on one sub product, each with its own quantity, as two lines on one variant', async () => {
    const calls = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct();

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
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct();
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

  it('opens the card on the colour box when its first row is multicolour', async () => {
    live.products = [{ ...MULTI, sortOrder: 0 }, DEDICATED, FIXED];
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), {
      target: { value: 'Sha' },
    });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(PARTY.name) }));
    fireEvent.focus(searchBox());
    fireEvent.mouseDown(await screen.findByRole('button', { name: new RegExp(CATEGORY.name) }));

    const box = await screen.findByLabelText(colourLabel('OPT-0002'));
    expect(document.activeElement).toBe(box);
  });

  it('holds a counted row without a colour back, and says so', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct();
    fireEvent.change(qtyBox('OPT-0002'), { target: { value: '4' } });

    expect(addButton().disabled).toBe(true);
    expect(document.body.textContent).toContain(t('lead.add.draft.hintColourRow'));

    await pickColour('OPT-0002', 'Whi');
    expect(addButton().disabled).toBe(false);
  });

  it('opens a colour list with the colours, takes the highlighted one with Enter and goes on to the quantity', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct();

    const colourBox = screen.getByLabelText(colourLabel('OPT-0002'));
    colourBox.focus();
    fireEvent.click(colourBox);
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['White', 'Ivory']);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');

    await pressEnter(colourBox);
    expect(document.activeElement).toBe(qtyBox('OPT-0002 · White'));
  });

  it('puts the caret back on the colour box when Escape walks back from its quantity', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct();
    await pickColour('OPT-0002', 'Whi');
    expect(document.activeElement).toBe(qtyBox('OPT-0002 · White'));

    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      await wait(0);
    });
    expect(document.activeElement).toBe(screen.getByLabelText(colourLabel('OPT-0002')));
  });
});

describe('a fixed colour', () => {
  it('is shown and skipped: the card opens on the quantity, with no colour box', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct();

    expect(screen.queryByLabelText(colourLabel('OPT-0001'))).toBeNull();
    expect(document.activeElement).toBe(qtyBox('OPT-0001'));
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

  async function chooseParty(): Promise<void> {
    fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), {
      target: { value: 'Sha' },
    });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(PARTY.name) }));
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
    await pickSubProduct();
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
    await pickSubProduct();

    // The owner's numbered designer pieces: no colour is chosen or shown (§2).
    const qty = qtyBox('OPT-0003');
    expect(screen.queryByLabelText(colourLabel('OPT-0003'))).toBeNull();

    fireEvent.change(qty, { target: { value: '3' } });
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
    ).toEqual([{ variantId: 'var-3', colour: null, quantity: 3 }]);
  });
});

describe('after an Enter-walk Add product', () => {
  it('is the product bar again, and a typed product opens its card on the first quantity', async () => {
    await openForm();
    await enterOneLine();

    expect(searchBox().placeholder).toBe(t('lead.add.products.categoryPlaceholder'));

    fireEvent.change(searchBox(), { target: { value: 'opt' } });
    await act(async () => wait(300));
    await pressEnter(searchBox());

    const qty = await screen.findByLabelText(qtyLabel('OPT-0001'));
    expect(document.activeElement).toBe(qty);
  });
});

describe('Shift+Q', () => {
  it('with no card open is only a capital Q', async () => {
    await openForm();
    await enterOneLine();

    let typed = false;
    await act(async () => {
      typed = fireEvent.keyDown(searchBox(), { key: 'Q', shiftKey: true });
      await wait(0);
    });

    expect(typed).toBe(true);
    expect(searchBox().placeholder).toBe(t('lead.add.products.categoryPlaceholder'));
  });

  it('is a capital Q in the notes', async () => {
    await openForm();
    await enterOneLine();

    const notes = screen.getByLabelText(t('lead.add.details.notes'));
    expect(fireEvent.keyDown(notes, { key: 'Q', shiftKey: true })).toBe(true);
  });

  it("from a ready card's quantity, adds the card and goes to the product bar", async () => {
    await openForm();
    await pickSubProduct();
    const qty = qtyBox('OPT-0001');
    fireEvent.change(qty, { target: { value: '5' } });

    let typed = true;
    await act(async () => {
      typed = fireEvent.keyDown(qty, { key: 'Q', shiftKey: true });
      await wait(0);
    });

    expect(typed).toBe(false);
    expect(
      within(document.querySelector<HTMLElement>('.ob-order-aside')!).getByText(FIXED.name),
    ).toBeTruthy();
    expect(searchBox().placeholder).toBe(t('lead.add.products.categoryPlaceholder'));
  });

  it('leaves a card with no quantity open, rather than finishing the product under it', async () => {
    await openForm();
    await pickSubProduct();
    const qty = qtyBox('OPT-0001');

    let typed = false;
    await act(async () => {
      typed = fireEvent.keyDown(qty, { key: 'Q', shiftKey: true });
      await wait(0);
    });

    expect(typed).toBe(true);
    expect(qtyBox('OPT-0001')).toBe(qty);
  });

  it('is a capital Q in the colour box, even on a card ready to add', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct();
    fireEvent.change(qtyBox('OPT-0001'), { target: { value: '5' } });

    const colourBox = screen.getByLabelText(colourLabel('OPT-0002'));
    expect(fireEvent.keyDown(colourBox, { key: 'Q', shiftKey: true })).toBe(true);
    // The card is still open: the Q did not add it.
    expect(screen.getByLabelText(colourLabel('OPT-0002'))).toBe(colourBox);
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
