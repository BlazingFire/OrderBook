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
  const pick = vi.fn(
    async (kind: string, q: { term: string; categoryId?: string; limit?: number }) => {
      const term = q.term.toLowerCase();
      if (kind === 'party') {
        const items = [PARTY, SHAH].filter((row) => row.name.toLowerCase().includes(term));
        return { items };
      }
      if (kind === 'category') {
        // The code from its start, the name anywhere.
        const items = [WASH_BASIN, CATEGORY].filter(
          (row) => row.code.toLowerCase().startsWith(term) || row.name.toLowerCase().includes(term),
        );
        return { items };
      }
      return { items: [MULTI, DEDICATED, FIXED] };
    },
  );
  const createLead = vi.fn(async (_input: unknown) => ({ id: 'L-1' }));
  const updateLead = vi.fn(async (_id: string, _input: unknown): Promise<unknown> => undefined);
  const transport = {
    pick,
    createLead,
    updateLead,
    createParty: vi.fn(async () => ({ id: 'party-new' })),
    updateParty: vi.fn(async () => undefined),
  } as unknown as LeadEntryTransport;
  return { transport, pick, createLead, updateLead };
}

type Fake = ReturnType<typeof makeTransport>;

function viewOf(overrides: Record<string, unknown> = {}): LeadEntryView {
  return {
    optionLists: COLOURS,
    partyVariants: [],
    stock: [],
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
  onSaved: (id: string, saved?: Lead) => void;
}

function Harness({ view, transport, canCreateParty, lead, remoteChange, onSaved }: Mounted) {
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
  Fake & { setView: (next: Record<string, unknown>) => void; onSaved: ReturnType<typeof vi.fn> }
> {
  const fake = makeTransport();
  const onSaved = vi.fn();
  const props = { transport: fake.transport, onSaved, ...extra };
  const { rerender } = render(<Harness view={viewOf(view)} {...props} />);
  // An edit opens on the lead's own party, so there is no party box to wait for.
  if (extra.lead) await screen.findByText(t('lead.edit.title'));
  else await screen.findByLabelText(t('lead.add.party.search'), {}, { timeout: 10_000 });
  return {
    ...fake,
    onSaved,
    setView: (next) => rerender(<Harness view={viewOf(next)} {...props} />),
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

/** The grade box beside a row's packaging. */
function gradeBox(named: string): HTMLInputElement {
  return screen.getByLabelText(`${t('lead.add.draft.grade')} — ${named}`);
}

/** The draft card's Add product button — the last stop of its Enter walk. */
function addButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('[data-add-card]')!;
}

/**
 * Enter through a row's packaging and grade, both left as they are, onto Add
 * product, and Enter there — which, on a button, is a click.
 */
async function finishCard(named: string): Promise<void> {
  await pressEnter(packagingBox(named));
  await pressEnter(gradeBox(named));
  expect(document.activeElement).toBe(addButton());
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
    const fake = await openForm();
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
    const request = fake.pick.mock.calls.find(([kind]) => kind === 'product')!;
    expect(request[1].limit).toBe(PICK_MAX_LIMIT);
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

  it('walks an empty quantity through its packaging and grade, and stops there while Add is off', async () => {
    await openForm();
    await pickSubProduct(FIXED.name);
    const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`);

    qty.focus();
    await pressEnter(qty);
    expect(document.activeElement).toBe(packagingBox('White'));

    await pressEnter(packagingBox('White'));
    expect(document.activeElement).toBe(gradeBox('White'));

    await pressEnter(gradeBox('White'));
    expect(document.activeElement).toBe(gradeBox('White'));
    expect(addButton().disabled).toBe(true);
    expect(screen.getByLabelText(`${t('lead.add.draft.col.quantity')} — White`)).toBe(qty);
  });

  it('adds the sub product from Add product, reached by Enter, and stays on the product', async () => {
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

describe('the packaging and grade beside each quantity', () => {
  it('walks quantity, packaging, grade and Add product with Enter, and back with Escape', async () => {
    await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
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

    await pressEnter(packagingBox('White'));
    expect(document.activeElement).toBe(gradeBox('White'));
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['—', 'A', 'B']);

    await pressEnter(gradeBox('White'));
    expect(document.activeElement).toBe(addButton());

    for (const back of [gradeBox('White'), packagingBox('White'), qty]) {
      await act(async () => {
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        await wait(0);
      });
      expect(document.activeElement).toBe(back);
    }
  });

  it('moves on to the grade once packaging is picked, and to Add product once a grade is', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct(FIXED.name);
    const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`);
    fireEvent.change(qty, { target: { value: '5' } });
    await pressEnter(qty);

    // Typed and taken with Enter.
    fireEvent.change(packagingBox('White'), { target: { value: 'gr' } });
    await pressEnter(packagingBox('White'));
    expect(document.activeElement).toBe(gradeBox('White'));

    // Picked with the mouse.
    await act(async () => {
      fireEvent.mouseDown(await screen.findByRole('option', { name: 'B' }));
      await wait(0);
    });
    expect(document.activeElement).toBe(addButton());

    await act(async () => {
      fireEvent.click(addButton());
      await wait(0);
    });
    expect(screen.queryByLabelText(`${t('lead.add.draft.col.quantity')} — White`)).toBeNull();
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

  it('gives each colour its own packaging and grade', async () => {
    const fake = await openForm({ optionLists: [...COLOURS, ...PACKAGING, ...GRADES] });
    await pickSubProduct(MULTI.name);
    const colourBox = await screen.findByLabelText(t('lead.add.flow.addColour'));
    for (const colour of ['Whi', 'Ivo']) {
      fireEvent.change(colourBox, { target: { value: colour } });
      fireEvent.keyDown(colourBox, { key: 'Enter' });
    }

    const white = screen.getByLabelText(`${t('lead.add.draft.col.quantity')} — White`);
    fireEvent.change(white, { target: { value: '10' } });
    await pressEnter(white);
    fireEvent.change(packagingBox('White'), { target: { value: 'bo' } });
    await pressEnter(packagingBox('White'));
    fireEvent.change(gradeBox('White'), { target: { value: 'a' } });
    await pressEnter(gradeBox('White'));
    // On to the next row's quantity, not the Add button.
    const ivory = screen.getByLabelText(`${t('lead.add.draft.col.quantity')} — Ivory`);
    expect(document.activeElement).toBe(ivory);

    fireEvent.change(ivory, { target: { value: '5' } });
    await pressEnter(ivory);
    await finishCard('Ivory');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    const { items } = created(fake);
    expect(items.map(({ colour, packaging, grade }) => ({ colour, packaging, grade }))).toEqual([
      { colour: 'White', packaging: 'Box', grade: 'A' },
      { colour: 'Ivory', packaging: '', grade: null },
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
    expect(packagingBox('White').getAttribute('aria-invalid')).toBe('true');
    await pressEnter(packagingBox('White'));
    await pressEnter(gradeBox('White'));
    // Add product is off, so the caret stays on the grade.
    expect(document.activeElement).toBe(gradeBox('White'));
    expect(addButton().disabled).toBe(true);

    // Back to the packaging; the first arrow opens the list, the second moves to Box.
    await act(async () => {
      fireEvent.keyDown(gradeBox('White'), { key: 'Escape' });
      await wait(0);
    });
    expect(document.activeElement).toBe(packagingBox('White'));
    await act(async () => {
      fireEvent.keyDown(packagingBox('White'), { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(packagingBox('White'), { key: 'ArrowDown' });
    });
    await finishCard('White');
    expect(screen.queryByLabelText(`${t('lead.add.draft.col.quantity')} — White`)).toBeNull();
    expect(
      within(document.querySelector<HTMLElement>('.ob-lead-panel')!).getByText('OPT-0001'),
    ).toBeTruthy();
  });
});

describe('a multicolour sub product', () => {
  it('takes two colours, each with its own quantity, as two lines on one variant', async () => {
    const fake = await openForm();
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
    await finishCard('Ivory');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    const { items } = created(fake);
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
    await finishCard('White');
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
      within(document.querySelector<HTMLElement>('.ob-lead-panel')!).getByText('OPT-0001'),
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
    const notesBox = () => screen.getByLabelText(t('lead.add.details.notes')) as HTMLTextAreaElement;
    const save = async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
        await wait(0);
      });
    };

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

      expect(await screen.findByText(t('lead.conflict.savedBy', { name: 'Ravi', time }))).toBeTruthy();
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
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(MULTI.name) }));
      fireEvent.click(
        await screen.findByRole('button', {
          name: t('lead.add.line.modifyProduct', { product: MULTI.name }),
        }),
      );
    }

    it('keeps its colour rule when the view carries the catalogue (the Master sends it with products.view)', async () => {
      await openForm(
        { optionLists: [...COLOURS, ...SOURCES], products: [MULTI] },
        { lead: multiLead },
      );
      await modifyTheLine();
      expect(await screen.findByLabelText(t('lead.add.flow.addColour'))).toBeTruthy();
    });

    it('falls back to what the line itself shows without it: no colour, so no colour to choose', async () => {
      await openForm({ optionLists: [...COLOURS, ...SOURCES] }, { lead: multiLead });
      await modifyTheLine();
      await screen.findByText(t('lead.add.draft.editing'));
      expect(screen.queryByLabelText(t('lead.add.flow.addColour'))).toBeNull();
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
    fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), { target: { value: 'Sha' } });
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
