/**
 * The shared New / Edit pending order form (`ui/src/LeadEntryScreen.tsx`), driven
 * the way the counter drives it (`docs/catalogue/CATALOGUE_MODEL.md` §6) —
 * rendered directly over a fake transport, the way the Master mounts it.
 *
 * Ported from `add-lead-flow.test.tsx`, which boots the whole Office panel and
 * stays as it is: the same cases, a different way in. On top of those, the cases
 * the shared copy adds — a view-only grant hides the party, Create party needs
 * `parties.create`, edit opens on the saved lead and sends its whole line set,
 * and a new transport object does not re-query.
 */

import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PICK_MAX_LIMIT } from '@orderbook/shared';
import type { Lead, PresenceLastWrite } from '@orderbook/shared';

import { ConfirmProvider } from '../src/ConfirmDialog.js';
import { t } from '../src/i18n.js';
import { KeyboardProvider } from '../src/KeyboardProvider.js';
import {
  LeadEntryScreen,
  type LeadEntryTransport,
  type LeadEntryView,
} from '../src/LeadEntryScreen.js';
import { listUnsavedWork, saveAllUnsavedWork } from '../src/unsavedWork.js';
import { installBrowserStubs, wait } from './panel-harness.js';

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

/** The three picker answers the Master gives, matched the way it matches. */
function makeTransport() {
  /** What the Master's catalogue holds right now; a test changes it, then moves the revision. */
  const catalogue = {
    categories: [WASH_BASIN, CATEGORY] as Array<typeof CATEGORY>,
    products: [MULTI, DEDICATED, FIXED] as Array<typeof FIXED>,
  };
  const pick = vi.fn(
    async (kind: string, q: { term: string; categoryId?: string; limit?: number }) => {
      const term = q.term.toLowerCase();
      if (kind === 'party') {
        const items = [PARTY, SHAH].filter((row) => row.name.toLowerCase().includes(term));
        return { items };
      }
      if (kind === 'category') {
        // The code from its start, the name anywhere.
        const items = catalogue.categories.filter(
          (row) => row.code.toLowerCase().startsWith(term) || row.name.toLowerCase().includes(term),
        );
        return { items };
      }
      // By name when something is typed — how the Master matches a product — else all of them.
      return {
        items: term
          ? catalogue.products.filter((row) => row.name.toLowerCase().includes(term))
          : catalogue.products,
      };
    },
  );
  /** An older Master has no live-ids read: the form is told it cannot tell. */
  const master = { older: false };
  const liveProducts = vi.fn(async (ids: string[]) => ({
    live: master.older
      ? null
      : ids.filter((id) => catalogue.products.some((product) => product.id === id)),
  }));
  const createLead = vi.fn(async (_input: unknown) => ({ id: 'L-1' }));
  const updateLead = vi.fn(async (_id: string, _input: unknown): Promise<unknown> => undefined);
  const transport = {
    pick,
    liveProducts,
    createLead,
    updateLead,
    createParty: vi.fn(async () => ({ id: 'party-new' })),
    updateParty: vi.fn(async () => undefined),
  } as unknown as LeadEntryTransport;
  return { transport, pick, createLead, updateLead, catalogue, master, liveProducts };
}

type Fake = ReturnType<typeof makeTransport>;

function viewOf(overrides: Record<string, unknown> = {}): LeadEntryView {
  return {
    optionLists: COLOURS,
    partyVariants: [],
    partyGrants: [],
    ...overrides,
  } as unknown as LeadEntryView;
}

interface Mounted {
  view: LeadEntryView;
  transport: LeadEntryTransport;
  canCreateParty?: boolean;
  lead?: Lead;
  remoteChange?: PresenceLastWrite | null;
  catalogueRevision?: number;
  onSaved: (id: string, saved?: Lead) => void;
}

function Harness({
  view,
  transport,
  canCreateParty,
  lead,
  remoteChange,
  catalogueRevision,
  onSaved,
}: Mounted) {
  return (
    <StrictMode>
      <KeyboardProvider panel="master" userId={null}>
        <ConfirmProvider>
          <LeadEntryScreen
            view={view}
            transport={transport}
            canCreateParty={canCreateParty}
            lead={lead}
            remoteChange={remoteChange}
            catalogueRevision={catalogueRevision}
            onSaved={onSaved}
            onCancel={() => undefined}
          />
        </ConfirmProvider>
      </KeyboardProvider>
    </StrictMode>
  );
}

/** Mounts the form and returns the fake transport and a way to hand it a new view. */
async function openForm(
  view: Record<string, unknown> = {},
  extra: Partial<Mounted> = {},
): Promise<
  Fake & {
    setView: (next: Record<string, unknown>) => void;
    /** The catalogue changed: hand the form a new revision, as the shell does on a change event. */
    catalogueChanged: () => void;
    onSaved: ReturnType<typeof vi.fn>;
  }
> {
  const fake = makeTransport();
  const onSaved = vi.fn();
  const props = { transport: fake.transport, onSaved, ...extra };
  const { rerender } = render(<Harness view={viewOf(view)} {...props} />);
  // An edit opens on the lead's own party, so there is no party box to wait for.
  if (extra.lead) await screen.findByText(t('lead.edit.title'));
  else await screen.findByLabelText(t('lead.add.party.search'), {}, { timeout: 10_000 });
  let revision = 0;
  return {
    ...fake,
    onSaved,
    setView: (next) =>
      rerender(<Harness view={viewOf(next)} {...props} catalogueRevision={revision} />),
    catalogueChanged: () => {
      revision += 1;
      rerender(<Harness view={viewOf(view)} {...props} catalogueRevision={revision} />);
    },
  };
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

/**
 * Party, then the product: its card opens on every sub product at once, so `subProduct` is only
 * waited for (its row is on the card), not picked.
 */
async function pickSubProduct(subProduct: string): Promise<void> {
  fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), {
    target: { value: 'Sha' },
  });
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(PARTY.name) }));

  fireEvent.focus(searchBox());
  fireEvent.mouseDown(
    await screen.findByRole('button', { name: new RegExp(`^${CATEGORY.code} `) }),
  );
  await screen.findByTitle(subProduct);
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

/** Add product: a click on the card's button (the walk to it is tested on its own). */
async function finishCard(_named?: string): Promise<void> {
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

/**
 * The fixed sub product at 5, added with Enter on its quantity, its packaging
 * and its grade (both left at none), then Add product.
 */
async function enterOneLine(): Promise<void> {
  await pickSubProduct(FIXED.name);
  const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`);
  fireEvent.change(qty, { target: { value: '5' } });
  await pressEnter(qty);
  await finishCard('White');
}

/** The one `createLead` call, as the body the Master would receive. */
function created(fake: Fake): {
  items: Array<Record<string, unknown>>;
  sourcePlatform: string | null;
} {
  expect(fake.createLead).toHaveBeenCalledTimes(1);
  return fake.createLead.mock.calls[0]![0] as never;
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
    const fake = await openForm();
    const partyBox = screen.getByLabelText(t('lead.add.party.search'));

    fireEvent.focus(partyBox);
    await act(async () => wait(300)); // past the picker's debounce

    expect(screen.queryByRole('button', { name: new RegExp(PARTY.name) })).toBeNull();
    expect(screen.queryByRole('button', { name: t('lead.add.party.create') })).toBeNull();
    expect(fake.pick.mock.calls.some(([kind]) => kind === 'party')).toBe(false);

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
    const fake = await openForm();

    fake.setView({ features: { followUpDefaultDays: 5 } });

    expect((screen.getByLabelText(t('lead.add.details.followUp')) as HTMLInputElement).value).toBe(
      isoDate(5),
    );
  });
});

describe('the source', () => {
  it('moves off a source the company stops listing, so the Master does not refuse the lead', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...SOURCES] });

    // The form started on the first source; the company then drops it.
    fake.setView({ optionLists: [...COLOURS, SOURCES[1]] });
    await enterOneLine();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    expect(created(fake).sourcePlatform).toBe('phone');
  });
});

/** The qty box of a grid row, found by the variant or colour it is for. */
const qtyBox = (named: string): HTMLInputElement =>
  screen.getByLabelText(`${t('lead.add.draft.col.quantity')} — ${named}`);

const colourBoxLabel = (productName: string, code: string): string =>
  `${t('lead.add.draft.colour')} — ${productName} ${code}`;

/** The colour select of a multicolour row. */
const colourBoxOf = (productName: string, code: string): HTMLInputElement =>
  screen.getByLabelText(colourBoxLabel(productName, code));

/** The card's rows, in order, by the code in their first cell. */
const gridCodes = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-row-key] .ob-order-cell--code')].map(
    (cell) => cell.textContent ?? '',
  );

describe('the product bar', () => {
  it('opens the product on every sub product when its code was typed, on an Enter faster than the search', async () => {
    await openForm();
    fireEvent.focus(searchBox());
    await screen.findByRole('button', { name: new RegExp(WASH_BASIN.name) });

    // No wait between the code and the Enter — the counter types `opt⏎` blind.
    fireEvent.change(searchBox(), { target: { value: 'opt' } });
    fireEvent.keyDown(searchBox(), { key: 'Enter' });

    expect(await screen.findByTitle(FIXED.name)).toBeTruthy();
    expect(document.querySelector('[data-product-card]')).not.toBeNull();
  });

  it('keeps its rows out of the Tab order', async () => {
    await openForm();
    // A Tab onto a row blurred the box, whose blur closed the list — the row
    // with the caret on it included.
    fireEvent.focus(searchBox());
    await screen.findByRole('button', { name: new RegExp(WASH_BASIN.name) });
    const tabbable = within(screen.getByRole('listbox'))
      .getAllByRole('button')
      .filter((row) => row.tabIndex >= 0);
    expect(tabbable).toEqual([]);
  });

  it('keeps the caret in the bar on an Enter with nothing to take, not in the notes', async () => {
    await openForm();
    searchBox().focus();
    await screen.findByRole('button', { name: new RegExp(CATEGORY.name) });

    fireEvent.change(searchBox(), { target: { value: 'zzz' } });
    fireEvent.keyDown(searchBox(), { key: 'Enter' });

    expect(document.activeElement).toBe(searchBox());
    expect(document.querySelector('[data-product-card]')).toBeNull();
  });
});

describe('the product card', () => {
  it('lists every sub product of the product, a row for each variant, in catalogue order, asking for all of them', async () => {
    const fake = await openForm();
    await pickSubProduct(FIXED.name);

    // The Master answered MULTI first; `sortOrder` puts FIXED first.
    expect(gridCodes()).toEqual(['OPT-0001', 'OPT-0002', 'OPT-0003']);
    const request = fake.pick.mock.calls.find(([kind]) => kind === 'product')!;
    expect(request[1].limit).toBe(PICK_MAX_LIMIT);
    expect(request[1].categoryId).toBe(CATEGORY.id);
  });

  it('names the product by its name in the bar, never with its main-product code (R14), and heads the card with both', async () => {
    await openForm();
    await pickSubProduct(FIXED.name);

    expect(searchBox().value).toBe(CATEGORY.name);
    expect(searchBox().disabled).toBe(true);
    expect(document.body.textContent).not.toContain(`${CATEGORY.code} · ${CATEGORY.name}`);
    const head = document.querySelector<HTMLElement>('.ob-order-product__head')!;
    expect(head.querySelector('.ob-order-product__chip')!.textContent).toBe(CATEGORY.code);
    expect(head.querySelector('.ob-order-product__name')!.textContent).toBe(CATEGORY.name);
  });

  it('shows each row by its colour rule: a fixed colour as text, a multicolour one as a select, a numbered one as a dash', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct(FIXED.name);

    const rows = [...document.querySelectorAll<HTMLElement>('[data-row-key]')];
    const [fixed, multi, dedicated] = rows;
    expect(fixed!.querySelector('.ob-order-colour__input')).toBeNull();
    expect(fixed!.textContent).toContain('White');
    expect(multi!.querySelector('.ob-order-colour__input')).not.toBeNull();
    expect(multi!.querySelector('.ob-order-colour')!.getAttribute('data-state')).toBe('needed');
    expect(dedicated!.querySelector('.ob-order-colour__input')).toBeNull();
    expect(dedicated!.textContent).toContain('—');
  });

  it("opens on the first row's first field: the quantity of a fixed colour", async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct(FIXED.name);
    expect(document.activeElement).toBe(qtyBox('White'));
  });

  it('walks a row with a quantity through packaging and grade, then on to the next row', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct(FIXED.name);
    const qty = qtyBox('White');
    fireEvent.change(qty, { target: { value: '5' } });

    await pressEnter(qty);
    expect(document.activeElement).toBe(packagingBox('White'));
    // The company's list, in its order, after "—" for none.
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['—', 'Box', 'Grass', 'Paper']);

    await pressEnter(packagingBox('White'));
    expect(document.activeElement).toBe(gradeBox('White'));
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['—', 'A', 'B']);

    // The next row is the multicolour one: its colour select is the next stop.
    await pressEnter(gradeBox('White'));
    expect(document.activeElement).toBe(colourBoxOf(MULTI.name, 'OPT-0002'));

    for (const back of [gradeBox('White'), packagingBox('White'), qty]) {
      await act(async () => {
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        await wait(0);
      });
      // The first Escape only closes a list that was opened; walk until the caret lands.
      if (document.activeElement !== back) {
        await act(async () => {
          fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
          await wait(0);
        });
      }
      expect(document.activeElement).toBe(back);
    }
  });

  it('skips the packaging and grade of a row with no quantity, on to the next row', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct(FIXED.name);

    await pressEnter(qtyBox('White'));
    expect(document.activeElement).toBe(colourBoxOf(MULTI.name, 'OPT-0002'));
  });

  it('ends the walk on Add product, which takes no caret while the card is not ready', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct(DEDICATED.name);
    const dedicatedQty = qtyBox('OPT-0003');
    dedicatedQty.focus();

    // An empty last row goes straight to Add — which is off, so the caret stays.
    await pressEnter(dedicatedQty);
    expect(addButton().disabled).toBe(true);
    expect(document.activeElement).toBe(dedicatedQty);

    // With a quantity somewhere the card is ready: the walk through the last row ends on Add.
    fireEvent.change(dedicatedQty, { target: { value: '3' } });
    await pressEnter(dedicatedQty);
    await pressEnter(packagingBox('OPT-0003'));
    await pressEnter(gradeBox('OPT-0003'));
    expect(document.activeElement).toBe(addButton());
  });

  it('adds the counted rows from Add product, closes the card and puts the caret back in the product bar', async () => {
    await openForm();
    await enterOneLine();

    // The card is gone, the line is on the lead, the product is cleared, the caret is in the bar.
    expect(screen.queryByLabelText(`${t('lead.add.draft.col.quantity')} — White`)).toBeNull();
    expect(document.querySelector('[data-product-card]')).toBeNull();
    const aside = within(document.querySelector<HTMLElement>('.ob-order-aside')!);
    expect(aside.getByText(CATEGORY.name)).toBeTruthy();
    expect(aside.getByText(FIXED.name)).toBeTruthy();
    expect(searchBox().disabled).toBe(false);
    expect(document.activeElement).toBe(searchBox());
    expect(searchBox().placeholder).toBe(t('lead.add.products.categoryPlaceholder'));
  });

  it('clears the card from its close button without adding anything', async () => {
    await openForm();
    await pickSubProduct(FIXED.name);
    fireEvent.change(qtyBox('White'), { target: { value: '4' } });

    fireEvent.click(screen.getByRole('button', { name: t('lead.add.products.clear') }));
    expect(document.querySelector('[data-product-card]')).toBeNull();
    expect(screen.queryByRole('button', { name: t('lead.add.panel.title') })).toBeNull();
    await act(async () => wait(0));
    expect(document.activeElement).toBe(searchBox());
    // Nothing went onto the lead.
    expect(
      within(document.querySelector<HTMLElement>('.ob-order-aside')!).queryByText(FIXED.name),
    ).toBeNull();
  });

  it('moves on to the grade once packaging is picked, and takes the picks into the line', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct(FIXED.name);
    const qty = qtyBox('White');
    fireEvent.change(qty, { target: { value: '5' } });
    await pressEnter(qty);

    // Typed and taken with Enter.
    fireEvent.change(packagingBox('White'), { target: { value: 'gr' } });
    await pressEnter(packagingBox('White'));
    expect(document.activeElement).toBe(gradeBox('White'));

    // Picked with the mouse: on to the next row.
    await act(async () => {
      fireEvent.mouseDown(await screen.findByRole('option', { name: 'B' }));
      await wait(0);
    });
    expect(document.activeElement).toBe(colourBoxOf(MULTI.name, 'OPT-0002'));

    await finishCard();
    expect(document.activeElement).toBe(searchBox());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    const { items } = created(fake);
    expect(
      items.map(({ variantId, packaging, grade }) => ({ variantId, packaging, grade })),
    ).toEqual([{ variantId: 'var-1', packaging: 'Grass', grade: 'B' }]);
  });

  it('holds a counted row without packaging back while the company requires it', async () => {
    await openForm({
      optionLists: [...COLOURS, ...PACKAGING],
      features: { packagingRequiredOnConvert: true },
    });
    await pickSubProduct(FIXED.name);
    const qty = qtyBox('White');
    fireEvent.change(qty, { target: { value: '5' } });
    await pressEnter(qty);

    expect(packagingBox('White').getAttribute('aria-required')).toBe('true');
    expect(packagingBox('White').getAttribute('aria-invalid')).toBe('true');
    // Add product is off until the row has its packaging.
    expect(addButton().disabled).toBe(true);

    fireEvent.change(packagingBox('White'), { target: { value: 'bo' } });
    await pressEnter(packagingBox('White'));
    expect(packagingBox('White').getAttribute('aria-invalid')).toBeNull();
    expect(addButton().disabled).toBe(false);
    await finishCard();
    expect(screen.queryByLabelText(`${t('lead.add.draft.col.quantity')} — White`)).toBeNull();
    expect(
      within(document.querySelector<HTMLElement>('.ob-order-aside')!).getByText(FIXED.name),
    ).toBeTruthy();
  });
});

describe('colour in the card', () => {
  const OPTIONS = { optionLists: [...COLOURS, ...PACKAGING, ...GRADES] };

  async function pickColour(box: HTMLElement, typed: string): Promise<void> {
    fireEvent.change(box, { target: { value: typed } });
    await pressEnter(box);
  }

  it("takes a colour for a multicolour row by typing and Enter, and goes on to that row's quantity", async () => {
    await openForm(OPTIONS);
    await pickSubProduct(MULTI.name);
    const box = colourBoxOf(MULTI.name, 'OPT-0002');
    box.focus();

    await pickColour(box, 'Ivo');
    expect(box.value).toBe('Ivory');
    expect(qtyBox('Ivory')).toBeTruthy();
    expect(document.activeElement).toBe(qtyBox('Ivory'));
    expect(document.querySelector('.ob-order-colour[data-state="set"]')).not.toBeNull();
  });

  it('opens the list on Enter in an empty colour select, with the colours and the key hint, and does not walk on', async () => {
    await openForm(OPTIONS);
    await pickSubProduct(MULTI.name);
    const box = colourBoxOf(MULTI.name, 'OPT-0002');
    box.focus();

    await pressEnter(box);
    expect(document.activeElement).toBe(box);
    const options = within(screen.getByRole('listbox', { name: /Colour/ })).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['White', 'Ivory']);
    expect(screen.getByText(t('lead.add.card.colourHint'))).toBeTruthy();
    // No stock figure anywhere in the list (owner: no on hand).
    expect(screen.getByRole('listbox', { name: /Colour/ }).textContent).not.toMatch(/on hand/i);
  });

  it("shows a colour by the list's CURRENT label, so a renamed colour reads the new way", async () => {
    const renamed = COLOURS.map((colour) =>
      colour.value === 'Ivory' ? { ...colour, label: 'Pearl Ivory' } : colour,
    );
    await openForm({ optionLists: [...renamed, ...PACKAGING, ...GRADES] });
    await pickSubProduct(MULTI.name);
    const box = colourBoxOf(MULTI.name, 'OPT-0002');
    box.focus();
    await pickColour(box, 'Pea');

    const qty = qtyBox('Pearl Ivory');
    fireEvent.change(qty, { target: { value: '10' } });
    await finishCard();

    const aside = document.querySelector<HTMLElement>('.ob-order-aside')!;
    expect(aside.textContent).toContain('Pearl Ivory');
  });

  it('wants a colour before a counted multicolour row can be added', async () => {
    await openForm(OPTIONS);
    await pickSubProduct(MULTI.name);
    const qty = qtyBox('OPT-0002');
    fireEvent.change(qty, { target: { value: '10' } });
    expect(addButton().disabled).toBe(true);

    const box = colourBoxOf(MULTI.name, 'OPT-0002');
    box.focus();
    await pickColour(box, 'Ivo');
    expect(addButton().disabled).toBe(false);
  });

  it('adds another colour of the same sub product as a row of its own, under it, and takes two colours as two lines on one variant', async () => {
    const fake = await openForm(OPTIONS);
    await pickSubProduct(MULTI.name);
    const first = colourBoxOf(MULTI.name, 'OPT-0002');
    first.focus();
    await pickColour(first, 'Ivo');
    fireEvent.change(qtyBox('Ivory'), { target: { value: '5' } });

    // "+ Same sub product, another colour" works on the row the caret was last in.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.card.anotherColour') }));
      await wait(0);
    });
    expect(gridCodes()).toEqual(['OPT-0001', 'OPT-0002', 'OPT-0002', 'OPT-0003']);
    const boxes = screen.getAllByLabelText(
      `${t('lead.add.draft.colour')} — ${MULTI.name} OPT-0002`,
    ) as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(document.activeElement).toBe(boxes[1]);

    await pickColour(boxes[1]!, 'Whi');
    // The new row is White; FIXED's own row is White too, so find this one by its row.
    const rows = [...document.querySelectorAll<HTMLElement>('[data-row-key]')];
    const whiteMulti = rows[2]!.querySelector<HTMLInputElement>('input[data-kind="qty"]')!;
    fireEvent.change(whiteMulti, { target: { value: '10' } });
    await finishCard();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    const { items } = created(fake);
    expect(
      items.map(({ variantId, colour, quantity }) => ({ variantId, colour, quantity })),
    ).toEqual([
      { variantId: 'var-2', colour: 'Ivory', quantity: 5 },
      { variantId: 'var-2', colour: 'White', quantity: 10 },
    ]);
  });

  it('gives each colour its own packaging and grade', async () => {
    const fake = await openForm(OPTIONS);
    await pickSubProduct(MULTI.name);
    const first = colourBoxOf(MULTI.name, 'OPT-0002');
    first.focus();
    await pickColour(first, 'Ivo');
    fireEvent.change(qtyBox('Ivory'), { target: { value: '10' } });
    await pressEnter(qtyBox('Ivory'));
    fireEvent.change(packagingBox('Ivory'), { target: { value: 'bo' } });
    await pressEnter(packagingBox('Ivory'));
    fireEvent.change(gradeBox('Ivory'), { target: { value: 'a' } });
    await pressEnter(gradeBox('Ivory'));
    // On to the next row (the numbered one): it has no colour select, so its quantity.
    expect(document.activeElement).toBe(qtyBox('OPT-0003'));

    fireEvent.change(qtyBox('OPT-0003'), { target: { value: '2' } });
    await finishCard();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    const { items } = created(fake);
    expect(items.map(({ colour, packaging, grade }) => ({ colour, packaging, grade }))).toEqual([
      { colour: 'Ivory', packaging: 'Box', grade: 'A' },
      { colour: null, packaging: '', grade: null },
    ]);
  });

  it('has no colour select for a numbered sub product, and none at all for a fixed colour', async () => {
    await openForm(OPTIONS);
    await pickSubProduct(DEDICATED.name);

    expect(
      screen.queryByLabelText(`${t('lead.add.draft.colour')} — ${DEDICATED.name} OPT-0003`),
    ).toBeNull();
    expect(
      screen.queryByLabelText(`${t('lead.add.draft.colour')} — ${FIXED.name} OPT-0001`),
    ).toBeNull();
    expect(screen.getAllByLabelText(new RegExp(`^${t('lead.add.draft.colour')} —`))).toHaveLength(
      1,
    );
  });

  it('falls back to a plain row for a multicolour sub product when the company has no colour list', async () => {
    await openForm({ optionLists: [...PACKAGING, ...GRADES] });
    await pickSubProduct(MULTI.name);
    expect(document.querySelector('.ob-order-colour__input')).toBeNull();
    fireEvent.change(qtyBox('OPT-0002'), { target: { value: '4' } });
    expect(addButton().disabled).toBe(false);
  });
});

describe('the catalogue changing while the entry is open', () => {
  const NEW_CATEGORY = {
    id: 'cat-new',
    name: 'NEW PAN RANGE',
    code: 'NPR',
    brand: 'Swisware+',
    sortOrder: 5,
  };
  const NEW_SUB = {
    ...FIXED,
    id: 'prod-new',
    name: 'Fresh Closet',
    sortOrder: 9,
    variants: [{ id: 'var-new', label: 'Black', code: 'OPT-0099', weightKg: 25, isActive: true }],
  };

  async function chooseParty(): Promise<void> {
    fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), {
      target: { value: 'Sha' },
    });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(PARTY.name) }));
  }

  it('offers a product added on the Master at once, with nothing reopened', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await chooseParty();
    fireEvent.focus(searchBox());
    await screen.findByRole('button', { name: new RegExp(CATEGORY.name) });
    expect(screen.queryByRole('button', { name: new RegExp(NEW_CATEGORY.name) })).toBeNull();

    // An administrator adds a product on the Master; the shell moves the revision.
    fake.catalogue.categories.push(NEW_CATEGORY as never);
    await act(async () => {
      fake.catalogueChanged();
      await wait(0);
    });

    expect(await screen.findByRole('button', { name: new RegExp(NEW_CATEGORY.name) })).toBeTruthy();
  });

  it('re-runs the search somebody typed when the catalogue changes, so a product that was not found appears', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await chooseParty();
    fireEvent.focus(searchBox());
    fireEvent.change(searchBox(), { target: { value: 'NPR' } });
    expect(screen.queryByRole('button', { name: new RegExp(NEW_CATEGORY.name) })).toBeNull();

    fake.catalogue.categories.push(NEW_CATEGORY as never);
    await act(async () => {
      fake.catalogueChanged();
      await wait(0);
    });

    // The same typed text, the product it was looking for.
    expect(searchBox().value).toBe('NPR');
    expect(await screen.findByRole('button', { name: new RegExp(NEW_CATEGORY.name) })).toBeTruthy();
  });

  it('opens the next card on the sub products the catalogue has now, an added one and an edited one included', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    fake.catalogue.products.push(NEW_SUB as never);
    await act(async () => {
      fake.catalogueChanged();
      await wait(0);
    });

    await pickSubProduct(NEW_SUB.name);
    expect(gridCodes()).toContain('OPT-0099');

    fireEvent.click(screen.getByRole('button', { name: t('lead.add.products.clear') }));
    fake.catalogue.products[fake.catalogue.products.indexOf(NEW_SUB as never)] = {
      ...NEW_SUB,
      name: 'Fresh Closet Plus',
    } as never;
    await act(async () => {
      fake.catalogueChanged();
      await wait(0);
    });
    await act(async () => wait(0));
    fireEvent.focus(searchBox());
    fireEvent.mouseDown(
      await screen.findByRole('button', { name: new RegExp(`^${CATEGORY.code} `) }),
    );
    expect(await screen.findByTitle('Fresh Closet Plus')).toBeTruthy();
  });

  it('keeps the draft, the typed quantity and the caret through a catalogue change', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct(FIXED.name);
    const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`);
    fireEvent.change(qty, { target: { value: '7' } });
    qty.focus();
    expect(document.activeElement).toBe(qty);

    fake.catalogue.products.push(NEW_SUB as never);
    await act(async () => {
      fake.catalogueChanged();
      await wait(0);
    });

    // The same card, the same typed quantity, the caret where it was.
    const again = screen.getByLabelText(
      `${t('lead.add.draft.col.quantity')} — White`,
    ) as HTMLInputElement;
    expect(again).toBe(qty);
    expect(again.value).toBe('7');
    expect(document.activeElement).toBe(again);
  });

  it('does not flag a product that is still in the catalogue when something else changed', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await enterOneLine();

    fake.catalogue.products.push(NEW_SUB as never);
    await act(async () => {
      fake.catalogueChanged();
      await wait(0);
    });
    // The check asks the Master about the product's id once the change has been heard.
    await waitFor(() => {
      expect(fake.liveProducts.mock.calls.some(([ids]) => ids.includes(FIXED.id))).toBe(true);
    });
    await act(async () => wait(50));
    expect(document.querySelector('[data-catalogue-gone]')).toBeNull();
  });

  it('does not flag or block a product that was renamed on the Master while it was on the order', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await enterOneLine();

    // Same product, a name that starts differently: a lookup by the captured name would miss it.
    fake.catalogue.products = fake.catalogue.products.map((product) =>
      product.id === FIXED.id ? { ...product, name: 'ZZ Renamed Closet' } : product,
    );
    await act(async () => {
      fake.catalogueChanged();
      await wait(0);
    });
    await waitFor(() => expect(fake.liveProducts.mock.calls.length).toBeGreaterThan(1));
    await act(async () => wait(50));
    expect(document.querySelector('[data-catalogue-gone]')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
    expect(fake.createLead).toHaveBeenCalledTimes(1);
  });

  it('catches a deleted product on the 31st line: no cap on how many are checked', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    const extra = Array.from({ length: 30 }, (_, index) => ({
      ...FIXED,
      id: `prod-x${index}`,
      name: `Bulk Closet ${String(index).padStart(2, '0')}`,
      sortOrder: 20 + index,
      variants: [
        {
          id: `var-x${index}`,
          label: 'White',
          code: `OPT-X${index}`,
          weightKg: 25,
          isActive: true,
        },
      ],
    }));
    fake.catalogue.products.push(...(extra as never[]));
    await pickSubProduct(FIXED.name);
    // One card holds every sub product: count a piece on the fixed ones, thirty-one lines in all.
    for (const row of document.querySelectorAll<HTMLElement>('[data-row-key]')) {
      // The fixed-colour rows only: a multicolour row wants a colour first, the numbered one is left out.
      if (row.querySelector('.ob-order-colour__input') || row.textContent?.includes('OPT-0003'))
        continue;
      fireEvent.change(row.querySelector<HTMLInputElement>('input[data-kind="qty"]')!, {
        target: { value: '1' },
      });
    }
    await finishCard();

    const last = extra[extra.length - 1]!;

    // Every id reaches the Master, the 31st included, and a live one is not flagged.
    await act(async () => {
      fake.catalogueChanged();
      await wait(0);
    });
    await waitFor(() => expect(fake.liveProducts.mock.calls.flat(2)).toContain(last.id));
    await act(async () => wait(50));
    expect(document.querySelector('[data-catalogue-gone]')).toBeNull();

    fake.catalogue.products = fake.catalogue.products.filter((product) => product.id !== last.id);
    await act(async () => {
      fake.catalogueChanged();
      await wait(0);
    });
    const note = await waitFor(() => {
      const found = document.querySelector('[data-catalogue-gone]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(note.textContent).toContain(last.name);
  }, 120_000);

  it('does not block when the Master cannot say (an older Master), and lets the save go', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    fake.master.older = true;
    await enterOneLine();
    fake.catalogue.products = fake.catalogue.products.filter((product) => product.id !== FIXED.id);
    await act(async () => {
      fake.catalogueChanged();
      await wait(0);
    });
    await waitFor(() => expect(fake.liveProducts.mock.calls.length).toBeGreaterThan(1));
    await act(async () => wait(50));
    expect(document.querySelector('[data-catalogue-gone]')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
    expect(fake.createLead).toHaveBeenCalledTimes(1);
  });

  it('clears the no-longer-in-the-catalogue message once the gone line is removed', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await enterOneLine();
    fake.catalogue.products = fake.catalogue.products.filter((product) => product.id !== FIXED.id);
    await act(async () => {
      fake.catalogueChanged();
      await wait(0);
    });
    await waitFor(() => expect(document.querySelector('[data-catalogue-gone]')).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
    const alertText = t('lead.add.errors.goneLines', { names: FIXED.name });
    expect(await screen.findByText(alertText)).toBeTruthy();

    // Remove the product's group: nothing gone is left, so the message goes too.
    fireEvent.click(
      screen.getByRole('button', {
        name: t('lead.add.line.removeProduct', { product: CATEGORY.name }),
      }),
    );
    await waitFor(() => expect(screen.queryByText(alertText)).toBeNull());
  });

  it('clears it as well when the product comes back in the catalogue', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await enterOneLine();
    const original = fake.catalogue.products;
    fake.catalogue.products = original.filter((product) => product.id !== FIXED.id);
    await act(async () => {
      fake.catalogueChanged();
      await wait(0);
    });
    await waitFor(() => expect(document.querySelector('[data-catalogue-gone]')).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
    const alertText = t('lead.add.errors.goneLines', { names: FIXED.name });
    expect(await screen.findByText(alertText)).toBeTruthy();

    fake.catalogue.products = original;
    await act(async () => {
      fake.catalogueChanged();
      await wait(0);
    });
    await waitFor(() => expect(screen.queryByText(alertText)).toBeNull());
  });

  it('flags a product that was deleted and blocks the save, naming the line and keeping the draft', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await enterOneLine();
    expect(document.querySelector('[data-catalogue-gone]')).toBeNull();

    // The product is deleted on the Master while the order is open.
    fake.catalogue.products = fake.catalogue.products.filter((product) => product.id !== FIXED.id);
    await act(async () => {
      fake.catalogueChanged();
      await wait(0);
    });

    const note = await waitFor(() => {
      const found = document.querySelector('[data-catalogue-gone]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(note.textContent).toContain(FIXED.name);

    // The Master would refuse the whole order, so nothing is sent: the form stays open
    // with its line, and the message names the product.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
    expect(fake.createLead).not.toHaveBeenCalled();
    expect(fake.onSaved).not.toHaveBeenCalled();
    expect(
      await screen.findByText(t('lead.add.errors.goneLines', { names: FIXED.name })),
    ).toBeTruthy();
    expect(screen.getAllByText(new RegExp(FIXED.name)).length).toBeGreaterThan(0);
  });
});

describe('the Added products list, grouped by product', () => {
  /** A sub product of another product (WASH BASIN), so a card can add lines to two groups. */
  const BASIN = {
    ...FIXED,
    id: 'prod-9',
    name: 'Oval Basin',
    categoryId: WASH_BASIN.id,
    categoryName: WASH_BASIN.name,
    categoryCode: WASH_BASIN.code,
    sortOrder: 9,
    variants: [{ id: 'var-9', label: 'Ivory', code: 'WB-0001', weightKg: 8, isActive: true }],
  };

  async function twoGroups() {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    fake.catalogue.products.push(BASIN as never);
    await pickSubProduct(FIXED.name);
    fireEvent.change(qtyBox('White'), { target: { value: '5' } });
    fireEvent.change(qtyBox('OPT-0003'), { target: { value: '3' } });
    const basin = [...document.querySelectorAll<HTMLElement>('[data-row-key]')].find((row) =>
      row.textContent?.includes('WB-0001'),
    )!;
    fireEvent.change(basin.querySelector<HTMLInputElement>('input[data-kind="qty"]')!, {
      target: { value: '7' },
    });
    await finishCard();
    return fake;
  }

  const aside = (): HTMLElement => document.querySelector<HTMLElement>('.ob-order-aside')!;
  const groupNames = (): string[] =>
    [...aside().querySelectorAll('[data-added-group] .ob-order-group__name')].map(
      (name) => name.textContent ?? '',
    );

  it("groups the lines by product, in the order they were added, with each product's total pieces", async () => {
    await twoGroups();

    expect(groupNames()).toEqual([CATEGORY.name, WASH_BASIN.name]);
    const totals = [...aside().querySelectorAll('.ob-order-group__pieces')].map(
      (total) => total.textContent,
    );
    expect(totals).toEqual([expect.stringContaining('8'), expect.stringContaining('7')]);
    // One line per sub product and colour under its product.
    const lines = [...aside().querySelectorAll('[data-added-line]')].map(
      (line) => line.textContent ?? '',
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(FIXED.name);
    expect(lines[0]).toContain('White');
    expect(lines[0]).toContain('5');
    // The product's own total and the order's: 5 + 3 + 7 pcs, 2 products, 3 lines.
    expect(aside().textContent).toContain('15');
    expect(aside().textContent).toContain(t('lead.add.panel.totalLine', { products: 2, lines: 3 }));
  });

  it('lifts a product back into the card with its own rows and quantities, and puts its lines back where they were', async () => {
    const fake = await twoGroups();

    fireEvent.click(
      screen.getByRole('button', {
        name: t('lead.add.line.modifyProduct', { product: CATEGORY.name }),
      }),
    );
    // Only that product's lines are on the card, the quantities as they were.
    expect(gridCodes()).toEqual(['OPT-0001', 'OPT-0003']);
    expect(qtyBox('White').value).toBe('5');
    expect(qtyBox('OPT-0003').value).toBe('3');
    // The list no longer shows the lines being edited.
    expect(groupNames()).toEqual([WASH_BASIN.name]);
    expect(addButton().getAttribute('aria-label')).toBe(t('lead.add.draft.saveChanges'));

    fireEvent.change(qtyBox('White'), { target: { value: '6' } });
    await finishCard();
    expect(groupNames()).toEqual([CATEGORY.name, WASH_BASIN.name]);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
    const { items } = created(fake);
    expect(items.map(({ code, quantity }) => [code, quantity])).toEqual([
      ['OPT-0001', 6],
      ['OPT-0003', 3],
      ['WB-0001', 7],
    ]);
  });

  it('removes a product with its lines from its own button, and ticks groups for a bulk remove', async () => {
    await twoGroups();

    fireEvent.click(
      screen.getByRole('button', {
        name: t('lead.add.line.removeProduct', { product: CATEGORY.name }),
      }),
    );
    expect(groupNames()).toEqual([WASH_BASIN.name]);
    expect(aside().textContent).toContain(t('lead.add.panel.totalOneLine'));

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: t('lead.add.panel.select', { product: WASH_BASIN.name }),
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: t('lead.add.panel.removeSelectedOne', { count: 1 }) }),
    );
    expect(groupNames()).toEqual([]);
  });

  it('filters the groups by what is typed in its search, on the words a line shows', async () => {
    await twoGroups();
    fireEvent.change(screen.getByLabelText(t('lead.add.panel.search')), {
      target: { value: 'basin' },
    });
    expect(groupNames()).toEqual([WASH_BASIN.name]);
  });
});

describe('product photos', () => {
  const PHOTO = {
    id: 'img-9',
    productId: FIXED.id,
    caption: null,
    isPrimary: true,
    sequence: 0,
    width: 48,
    height: 32,
    checksum: 'x',
    blurhash: '',
    byteSize: 1,
    uploadedAt: '2026-10-07T00:00:00.000Z',
  };

  it('shows the photo on the picked card and on the added group', async () => {
    const fake = makeTransport();
    fake.catalogue.products = fake.catalogue.products.map((product) =>
      product.id === FIXED.id ? { ...product, images: [PHOTO] } : product,
    ) as never;
    const onSaved = vi.fn();
    render(
      <Harness
        view={viewOf({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] })}
        transport={fake.transport}
        onSaved={onSaved}
      />,
    );
    await screen.findByLabelText(t('lead.add.party.search'), {}, { timeout: 10_000 });

    await pickSubProduct(FIXED.name);
    // A product has no photo of its own: its card shows its first sub product's, at 48 px.
    expect(document.querySelector('.ob-order-product__head .ob-thumb')).not.toBeNull();

    fireEvent.change(qtyBox('White'), { target: { value: '5' } });
    await finishCard();
    expect(document.querySelector('.ob-order-aside .ob-thumb')).not.toBeNull();
  });

  it('draws nothing for a product with no photo', async () => {
    await openForm();
    await enterOneLine();
    expect(document.querySelector('.ob-thumb')).toBeNull();
  });
});

describe('the party box and the chosen party', () => {
  it('shows the chosen party by name, code and city (owner, 2026-10-07)', async () => {
    await openForm();
    fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), {
      target: { value: 'Sha' },
    });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(PARTY.name) }));
    await screen.findByRole('button', { name: t('lead.add.party.change') });

    const chip = document.querySelector<HTMLElement>('[data-party-chip]')!;
    expect(chip).not.toBeNull();
    expect(chip.querySelector('.ob-order-party__name')!.textContent).toBe(PARTY.name);
    expect(chip.querySelector('.ob-order-party__code')!.textContent).toBe(PARTY.partyCode);
    expect(chip.querySelector('.ob-order-party__meta')!.textContent).toContain(PARTY.city);
    expect(chip.querySelector('.ob-order-party__badge')!.textContent).toBe('ST');
    // The close button is still a step of the Enter / Escape walk.
    expect(chip.querySelector('button')!.hasAttribute('data-field')).toBe(true);
  });

  it('opens New party on Enter over "+ Create a new party", with the typed name in it', async () => {
    await openForm({}, { canCreateParty: true });
    const partyBox = screen.getByLabelText(t('lead.add.party.search'));
    fireEvent.change(partyBox, { target: { value: 'Zzz Traders' } });
    await screen.findByRole('button', { name: t('lead.add.party.create') });
    await act(async () => wait(300)); // the empty answer has arrived

    await pressEnter(partyBox);

    const name = await screen.findByLabelText(new RegExp(t('party.field.name')));
    expect((name as HTMLInputElement).value).toBe('Zzz Traders');
    expect(document.activeElement).not.toBe(screen.getByLabelText(t('lead.add.step.source')));
  });

  it('reaches "+ Create a new party" with the arrow keys past the matches, and Enter opens it', async () => {
    await openForm({}, { canCreateParty: true });
    const partyBox = screen.getByLabelText(t('lead.add.party.search'));
    fireEvent.change(partyBox, { target: { value: 'Sha' } });
    await screen.findByRole('button', { name: new RegExp(SHAH.name) });
    await act(async () => wait(300));

    fireEvent.keyDown(partyBox, { key: 'ArrowDown' });
    fireEvent.keyDown(partyBox, { key: 'ArrowDown' });
    await pressEnter(partyBox);

    const name = await screen.findByLabelText(new RegExp(t('party.field.name')));
    expect((name as HTMLInputElement).value).toBe('Sha');
    expect(screen.queryByRole('button', { name: t('lead.add.party.change') })).toBeNull();
  });

  it('has no create row, and Enter opens nothing, without the permission to create a party', async () => {
    await openForm({}, { canCreateParty: false });
    const partyBox = screen.getByLabelText(t('lead.add.party.search'));
    fireEvent.change(partyBox, { target: { value: 'Zzz Traders' } });
    await act(async () => wait(400));
    await pressEnter(partyBox);
    expect(screen.queryByRole('button', { name: t('lead.add.party.create') })).toBeNull();
    expect(screen.queryByLabelText(new RegExp(t('party.field.name')))).toBeNull();
  });
});

describe('the save button', () => {
  it('says Save order, with its Ctrl S chip left out of its name', async () => {
    await openForm();
    const save = screen.getByRole('button', { name: 'Save order' });
    expect(save.textContent).toContain('Save order');
    expect(save.textContent).toContain('Ctrl S');
    expect(save.getAttribute('aria-label')).toBe('Save order');
  });
});

describe('the follow-up quick choices', () => {
  it('are one segmented radio group beside the date, in the short faces of the design', async () => {
    await openForm();
    const group = document.querySelector<HTMLElement>('[data-follow-up-chips]')!;
    expect(group).not.toBeNull();
    expect(group.getAttribute('role')).toBe('radiogroup');
    const radios = group.querySelectorAll('button[role="radio"]');
    expect([...radios].map((radio) => radio.textContent)).toEqual(['+1 d', '+3 d', '+1 wk']);
    expect([...radios].map((radio) => radio.getAttribute('title'))).toEqual([
      t('lead.add.followUp.tomorrow'),
      t('lead.add.followUp.inThreeDays'),
      t('lead.add.followUp.nextWeek'),
    ]);
    // The date box is not in the group.
    expect(group.querySelector('input')).toBeNull();
  });

  it('start on three days, and a click on the checked one clears the date, another sets it again', async () => {
    await openForm();
    const date = screen.getByLabelText(t('lead.add.details.followUp')) as HTMLInputElement;
    const three = screen.getByRole('radio', { name: t('lead.add.followUp.inThreeDays') });
    expect(three.getAttribute('aria-checked')).toBe('true');
    expect(date.value).not.toBe('');
    fireEvent.click(three);
    expect(three.getAttribute('aria-checked')).toBe('false');
    expect(date.value).toBe('');
    fireEvent.click(three);
    expect(three.getAttribute('aria-checked')).toBe('true');
    expect(date.value).not.toBe('');
  });
});

describe('a dedicated sub product', () => {
  it('asks for a quantity only, and its line carries no colour', async () => {
    const fake = await openForm();
    await pickSubProduct(DEDICATED.name);

    // The owner's numbered designer pieces: no colour is chosen or shown (§2).
    const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — OPT-0003`);
    expect(screen.queryByLabelText(t('lead.add.flow.addColour'))).toBeNull();

    fireEvent.change(qty, { target: { value: '3' } });
    await pressEnter(qty);
    await finishCard('OPT-0003');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    const { items } = created(fake);
    expect(
      items.map(({ variantId, colour, quantity }) => ({ variantId, colour, quantity })),
    ).toEqual([{ variantId: 'var-3', colour: null, quantity: 3 }]);
  });
});

describe('Shift+Q', () => {
  it('after an Add product, the card is closed and the key is just a Q in the product bar', async () => {
    await openForm();
    await enterOneLine();

    // Nothing pending: the bar's capital Q is typed, not swallowed.
    expect(fireEvent.keyDown(searchBox(), { key: 'Q', shiftKey: true })).toBe(true);
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
    await pickSubProduct(FIXED.name);
    const qty = qtyBox('White');
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
    expect(document.querySelector('[data-product-card]')).toBeNull();
    expect(searchBox().placeholder).toBe(t('lead.add.products.categoryPlaceholder'));
  });

  it('leaves a card with no quantity open, rather than finishing the product under it', async () => {
    await openForm();
    await pickSubProduct(FIXED.name);
    const qty = qtyBox('White');

    let typed = false;
    await act(async () => {
      typed = fireEvent.keyDown(qty, { key: 'Q', shiftKey: true });
      await wait(0);
    });

    expect(typed).toBe(true);
    expect(qtyBox('White')).toBe(qty);

    // The card, once filled, adds as usual.
    fireEvent.change(qty, { target: { value: '5' } });
    await finishCard();
    expect(document.querySelector('[data-product-card]')).toBeNull();
  });

  it('is a capital Q in the colour box, even on a card ready to add', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct(MULTI.name);

    fireEvent.change(qtyBox('White'), { target: { value: '10' } });
    const colourBox = colourBoxOf(MULTI.name, 'OPT-0002');

    expect(fireEvent.keyDown(colourBox, { key: 'Q', shiftKey: true })).toBe(true);
    // The card is still open: the Q did not add it.
    expect(colourBoxOf(MULTI.name, 'OPT-0002')).toBe(colourBox);
  });
});

describe('Ctrl+Enter', () => {
  it('opens the review, and a second Ctrl+Enter saves the lead once however fast it repeats', async () => {
    const fake = await openForm();
    await enterOneLine();

    await act(async () => {
      fireEvent.keyDown(searchBox(), { key: 'Enter', ctrlKey: true });
    });
    const review = await screen.findByRole('dialog', { name: t('lead.add.review.title') });
    expect(fake.createLead).not.toHaveBeenCalled();

    // The chord held down: its auto-repeat must not save a review nobody read.
    await act(async () => {
      fireEvent.keyDown(review, { key: 'Enter', ctrlKey: true, repeat: true });
      await wait(0);
    });
    expect(fake.createLead).not.toHaveBeenCalled();

    // Two presses before any render: the second must not queue the lead again.
    await act(async () => {
      fireEvent.keyDown(review, { key: 'Enter', ctrlKey: true });
      fireEvent.keyDown(review, { key: 'Enter', ctrlKey: true });
      await wait(0);
    });

    expect(fake.createLead).toHaveBeenCalledTimes(1);
  });
});

describe('what the shared copy adds', () => {
  it('leaves a view-only party out of the list', async () => {
    await openForm({ partyGrants: [{ partyId: PARTY.id, level: 'view' }] });
    fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), {
      target: { value: 'Sha' },
    });

    // The other match is offered; the one this person may only view is not.
    expect(await screen.findByRole('button', { name: new RegExp(SHAH.name) })).toBeTruthy();
    expect(screen.queryByRole('button', { name: new RegExp(PARTY.name) })).toBeNull();
  });

  it('offers Create party only with parties.create', async () => {
    for (const [canCreateParty, shown] of [
      [false, false],
      [true, true],
    ] as const) {
      cleanup();
      await openForm({}, { canCreateParty });
      fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), {
        target: { value: 'Sha' },
      });
      await screen.findByRole('button', { name: new RegExp(PARTY.name) });
      expect(!!screen.queryByRole('button', { name: t('lead.add.party.create') })).toBe(shown);
    }
  });

  it('opens an edit on the saved lead and sends only what changed, with the clocks it opened at', async () => {
    const lead = {
      id: 'L-9',
      partyId: PARTY.id,
      partyName: PARTY.name,
      sourcePlatform: 'phone',
      followUpDate: isoDate(2),
      partyWiseMode: false,
      notes: 'ring back',
      convertedOrderId: null,
      sync: { version: 2, hlc: 'h2', fieldHlc: { notes: 'h1', items: 'h2' }, temporaryId: null },
      items: [
        {
          productId: FIXED.id,
          variantId: 'var-1',
          productName: FIXED.name,
          categoryName: CATEGORY.name,
          categoryCode: CATEGORY.code,
          brandName: CATEGORY.brand,
          alias: null,
          code: 'OPT-0001',
          variantLabel: 'White',
          colour: null,
          size: 'L-27',
          weightKg: 30,
          packaging: 'Box',
          grade: null,
          sequence: 1,
          fromPartyVariant: false,
          notes: null,
          quantity: 5,
        },
      ],
    } as unknown as Lead;
    const fake = await openForm({ optionLists: [...COLOURS, ...SOURCES] }, { lead });

    // The party is the lead's own — it was never in a list this screen fetched.
    expect(screen.getByText(PARTY.name)).toBeTruthy();
    expect(
      within(document.querySelector<HTMLElement>('.ob-order-aside')!).getByText(FIXED.name),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText(t('lead.add.details.notes')), {
      target: { value: 'ring back at five' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    expect(fake.createLead).not.toHaveBeenCalled();
    expect(fake.updateLead).toHaveBeenCalledTimes(1);
    const [id, input] = fake.updateLead.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('L-9');
    // The untouched party and lines stay out, so they cannot overwrite somebody
    // else's newer save of them.
    expect(input).toEqual({
      notes: 'ring back at five',
      baseFieldHlc: { notes: 'h1', items: 'h2' },
    });
    expect(fake.onSaved).toHaveBeenCalledWith('L-9', undefined);
  });

  describe('someone else saving the lead while it is open', () => {
    const opened = {
      id: 'L-11',
      partyId: PARTY.id,
      partyName: PARTY.name,
      ownerId: 'user-1',
      sourcePlatform: 'phone',
      followUpDate: isoDate(2),
      partyWiseMode: false,
      notes: 'ring back',
      convertedOrderId: null,
      sync: { version: 1, hlc: 'h1', fieldHlc: { notes: 'h1' }, temporaryId: null },
      items: [
        {
          productId: FIXED.id,
          variantId: 'var-1',
          productName: FIXED.name,
          categoryName: CATEGORY.name,
          categoryCode: CATEGORY.code,
          brandName: CATEGORY.brand,
          alias: null,
          code: 'OPT-0001',
          variantLabel: 'White',
          colour: null,
          size: 'L-27',
          weightKg: 30,
          packaging: 'Box',
          grade: null,
          sequence: 1,
          fromPartyVariant: false,
          notes: null,
          quantity: 5,
        },
      ],
    } as unknown as Lead;
    const notesBox = () =>
      screen.getByLabelText(t('lead.add.details.notes')) as HTMLTextAreaElement;
    const save = async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
        await wait(0);
      });
    };

    /** A line added in this edit: the dedicated sub product, at 3. */
    async function addDedicatedLine(): Promise<void> {
      searchBox().focus();
      fireEvent.mouseDown(
        await screen.findByRole('button', { name: new RegExp(`^${CATEGORY.code} `) }),
      );
      const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — OPT-0003`);
      fireEvent.change(qty, { target: { value: '3' } });
      await finishCard('OPT-0003');
    }

    it('blocks the save when a line ADDED in this edit names a deleted product, keeping the draft', async () => {
      const fake = await openForm({ optionLists: [...COLOURS, ...SOURCES] }, { lead: opened });
      await addDedicatedLine();

      fake.catalogue.products = fake.catalogue.products.filter(
        (product) => product.id !== DEDICATED.id,
      );
      await act(async () => {
        fake.catalogueChanged();
        await wait(0);
      });
      await waitFor(() => expect(document.querySelector('[data-catalogue-gone]')).not.toBeNull());

      await save();
      expect(fake.updateLead).not.toHaveBeenCalled();
      expect(fake.onSaved).not.toHaveBeenCalled();
      expect(
        await screen.findByText(t('lead.add.errors.goneLines', { names: DEDICATED.name })),
      ).toBeTruthy();
      expect(screen.getAllByText(new RegExp(DEDICATED.name)).length).toBeGreaterThan(0);
    });

    it('leaves a line that was already saved on the lead alone when its product was deleted since', async () => {
      const fake = await openForm({ optionLists: [...COLOURS, ...SOURCES] }, { lead: opened });
      fake.catalogue.products = fake.catalogue.products.filter(
        (product) => product.id !== FIXED.id,
      );
      await act(async () => {
        fake.catalogueChanged();
        await wait(0);
      });
      await act(async () => wait(50));
      expect(document.querySelector('[data-catalogue-gone]')).toBeNull();

      fireEvent.change(notesBox(), { target: { value: 'changed' } });
      await save();
      expect(fake.updateLead).toHaveBeenCalledTimes(1);
    });

    it('turns a 409 stale edit into the notice, and Keep mine saves over their version', async () => {
      const fake = await openForm({ optionLists: [...COLOURS, ...SOURCES] }, { lead: opened });
      const stale = Object.assign(new Error('stale'), {
        code: 'conflict',
        messageKey: 'error.conflict.staleEdit',
        details: { stale: ['notes'], fieldHlc: { notes: 'h5' } },
      });
      fake.updateLead.mockRejectedValueOnce(stale);
      fireEvent.change(notesBox(), { target: { value: 'mine' } });
      await save();

      expect(await screen.findByText(t('error.conflict.staleEdit'))).toBeTruthy();
      expect(fake.onSaved).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: t('lead.conflict.keepMine') }));
      expect(screen.queryByText(t('error.conflict.staleEdit'))).toBeNull();
      await save();

      expect(fake.updateLead).toHaveBeenCalledTimes(2);
      const [, again] = fake.updateLead.mock.calls[1] as [string, Record<string, unknown>];
      expect(again).toEqual({ notes: 'mine', baseFieldHlc: { notes: 'h5' } });
    });

    it('names who saved, and Reload theirs opens the form again on their version', async () => {
      const fake = makeTransport();
      const view = viewOf({ optionLists: [...COLOURS, ...SOURCES] });
      const props = { view, transport: fake.transport, onSaved: vi.fn() };
      const { rerender } = render(<Harness {...props} lead={opened} />);
      await screen.findByText(t('lead.edit.title'));
      fireEvent.change(notesBox(), { target: { value: 'half typed' } });

      const theirs = {
        ...opened,
        notes: 'their note',
        sync: { version: 2, hlc: 'h7', fieldHlc: { notes: 'h7' }, temporaryId: null },
      } as unknown as Lead;
      const at = '2026-10-03T10:42:00.000Z';
      const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      rerender(
        <Harness
          {...props}
          lead={theirs}
          remoteChange={{ userId: 'user-2', displayName: 'Ravi', at, action: 'updated' }}
        />,
      );

      expect(
        await screen.findByText(t('lead.conflict.savedBy', { name: 'Ravi', time })),
      ).toBeTruthy();
      // Nothing is taken over by itself: the half-typed note is still there.
      expect(notesBox().value).toBe('half typed');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: t('fields.conflict.reload') }));
        await wait(0);
      });
      expect(notesBox().value).toBe('their note');
      expect(screen.queryByText(t('lead.conflict.savedBy', { name: 'Ravi', time }))).toBeNull();
    });
  });

  describe('editing a multicolour line saved without a colour', () => {
    const multiLead = {
      id: 'L-10',
      partyId: PARTY.id,
      partyName: PARTY.name,
      sourcePlatform: 'phone',
      followUpDate: isoDate(2),
      partyWiseMode: false,
      notes: null,
      convertedOrderId: null,
      sync: { version: 1, hlc: 'h1', fieldHlc: {}, temporaryId: null },
      items: [
        {
          productId: MULTI.id,
          variantId: 'var-2',
          productName: MULTI.name,
          categoryName: CATEGORY.name,
          categoryCode: CATEGORY.code,
          brandName: CATEGORY.brand,
          alias: null,
          code: 'OPT-0002',
          variantLabel: null,
          colour: null,
          size: 'L-27',
          weightKg: 12,
          packaging: 'Box',
          grade: null,
          sequence: 1,
          fromPartyVariant: false,
          notes: null,
          quantity: 4,
        },
      ],
    } as unknown as Lead;

    async function modifyTheLine(): Promise<void> {
      fireEvent.click(
        await screen.findByRole('button', {
          name: t('lead.add.line.modifyProduct', { product: CATEGORY.name }),
        }),
      );
    }

    it('keeps its colour rule when the view carries the catalogue (the Master sends it with products.view)', async () => {
      await openForm(
        { optionLists: [...COLOURS, ...SOURCES], products: [MULTI] },
        { lead: multiLead },
      );
      await modifyTheLine();
      expect(await screen.findByLabelText(colourBoxLabel(MULTI.name, 'OPT-0002'))).toBeTruthy();
    });

    it('falls back to what the line itself shows without it: no colour, so no colour to choose', async () => {
      await openForm({ optionLists: [...COLOURS, ...SOURCES] }, { lead: multiLead });
      await modifyTheLine();
      await screen.findByRole('button', { name: t('lead.add.draft.saveChanges') });
      expect(screen.queryByLabelText(colourBoxLabel(MULTI.name, 'OPT-0002'))).toBeNull();
    });
  });

  it('shows the server’s message when a save is refused, and saves again on a retry', async () => {
    const fake = await openForm();
    fake.createLead.mockRejectedValueOnce(new Error('No such product'));
    await enterOneLine();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    expect(await screen.findByText('No such product')).toBeTruthy();
    expect(fake.onSaved).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
    expect(fake.createLead).toHaveBeenCalledTimes(2);
    expect(fake.onSaved).toHaveBeenCalledWith('L-1');
  });

  it('does not search again when the transport object is replaced, and uses the new one after', async () => {
    const first = makeTransport();
    const onSaved = vi.fn();
    // One view throughout, as a snapshot is: a new `partyGrants` array is a real change.
    const view = viewOf();
    const mount = (transport: LeadEntryTransport) => (
      <Harness view={view} transport={transport} onSaved={onSaved} />
    );
    const { rerender } = render(mount(first.transport));
    const box = await screen.findByLabelText(t('lead.add.party.search'));
    fireEvent.change(box, { target: { value: 'Sha' } });
    await screen.findByRole('button', { name: new RegExp(PARTY.name) });
    const before = first.pick.mock.calls.length;

    // The same behaviour in a new object, as an inline `render:` callback hands over every render.
    const second = makeTransport();
    rerender(mount(second.transport));
    await act(async () => wait(300));
    expect(first.pick.mock.calls.length).toBe(before);
    expect(second.pick).not.toHaveBeenCalled();

    // The next real search goes to the object it was last given.
    fireEvent.change(box, { target: { value: 'Shah' } });
    await waitFor(() => expect(second.pick).toHaveBeenCalledWith('party', { term: 'Shah' }));
    expect(first.pick.mock.calls.length).toBe(before);
  });
});

describe('Save all before an update (1.4 R7b)', () => {
  it('has nothing to save on an untouched form', async () => {
    await openForm();
    expect(listUnsavedWork()).toEqual([]);
  });

  it('saves a ready lead, naming the party, exactly as Ctrl+Enter would', async () => {
    const fake = await openForm();
    await enterOneLine();

    const items = listUnsavedWork();
    expect(items.map((item) => item.label)).toEqual([
      t('updates.saveAll.leadFor', { party: PARTY.name }),
    ]);

    let result: Awaited<ReturnType<typeof saveAllUnsavedWork>> | undefined;
    await act(async () => {
      result = await saveAllUnsavedWork();
    });
    expect(fake.createLead).toHaveBeenCalledTimes(1);
    expect(result?.saved).toHaveLength(1);
    expect(result?.unsaved).toHaveLength(0);
  });

  it('names a lead that is not ready, saves nothing, and does not post a half-lead', async () => {
    const fake = await openForm();
    fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), {
      target: { value: 'Sha' },
    });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(PARTY.name) }));

    let result: Awaited<ReturnType<typeof saveAllUnsavedWork>> | undefined;
    await act(async () => {
      result = await saveAllUnsavedWork();
    });
    expect(fake.createLead).not.toHaveBeenCalled();
    expect(result?.saved).toHaveLength(0);
    expect(result?.unsaved.map((item) => item.label)).toEqual([
      t('updates.saveAll.leadFor', { party: PARTY.name }),
    ]);
  });

  it('is not listed while editing a saved lead', async () => {
    const saved = {
      id: 'L-12',
      partyId: PARTY.id,
      partyName: PARTY.name,
      ownerId: 'user-1',
      sourcePlatform: 'phone',
      followUpDate: isoDate(2),
      partyWiseMode: false,
      notes: 'ring back',
      convertedOrderId: null,
      sync: { version: 1, hlc: 'h1', fieldHlc: { notes: 'h1' }, temporaryId: null },
      items: [],
    } as unknown as Lead;
    await openForm({}, { lead: saved });
    expect(listUnsavedWork()).toEqual([]);
  });
});
