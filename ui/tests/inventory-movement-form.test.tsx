/**
 * The Master's stock-in / physical-count form walks product bar → sub-product
 * bar → the variant (CATALOGUE_MODEL.md §7). What matters is what reaches the
 * endpoint and what the operator is shown on the way:
 *
 *  · the sub-product bar asks for **every** sub product of the chosen product,
 *    not a first page — One Piece Toilet alone holds 56;
 *  · a catalogue sub product has one variant, so it is chosen without asking
 *    and is what the write names;
 *  · a `fixed` colour shows locked, and nothing shows for a colour that only
 *    repeats the name, a `dedicated` piece, or a multicolour one (colour is not
 *    a stock key, so naming one would be false).
 *
 * Here rather than beside the screen because `ui/tests` is the only jsdom suite.
 * The screen is imported through a variable path, as `panel-harness.ts`
 * explains, so the Master's web sources stay out of this folder's type check.
 */

import type { ComponentType } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PICK_MAX_LIMIT } from '@orderbook/shared';

import { t } from '../src/i18n.js';

interface Variant {
  id: string;
  code: string;
  label: string | null;
  isActive: boolean;
}

function subProduct(id: string, name: string, label: string | null, multiColour = false) {
  const variant: Variant = { id: `v-${id}`, code: `OPT-${id}`, label, isActive: true };
  return { id, name, size: 'L-27', multiColour, variants: [variant] };
}

const SUB_PRODUCTS = [
  subProduct('102', '102 (9")', 'White'),
  subProduct('mag', 'MAGENTA', 'Magenta'),
  subProduct('1111', '1111', null),
  // A label on a multicolour piece still names no colour: `multiColour` wins.
  subProduct('orissa', 'Orissa Pan', 'Ivory', true),
];

const mocks = vi.hoisted(() => ({ pick: vi.fn() }));

vi.mock('../../master/web/src/api', () => ({ api: { pick: mocks.pick } }));

afterEach(cleanup);

interface FormProps {
  description: string;
  submitLabel: string;
  busy: boolean;
  lock: null;
  categories: unknown[];
  colourHex: (colour: string) => string | undefined;
  onSubmit: (input: unknown) => Promise<void>;
}

let MovementForm: ComponentType<FormProps>;

beforeAll(async () => {
  const path = '../../master/web/src/screens/InventoryScreen.tsx';
  ({ MovementForm } = (await import(/* @vite-ignore */ path)) as {
    MovementForm: ComponentType<FormProps>;
  });
});

/** Opens a `Select` the way a person does and takes the row whose text starts with `label`. */
async function choose(field: string, label: string): Promise<void> {
  fireEvent.focus(screen.getByLabelText(field));
  fireEvent.mouseDown(await screen.findByRole('option', { name: new RegExp(`^${label}`) }));
}

async function walkTo(name: string) {
  mocks.pick.mockReset();
  mocks.pick.mockResolvedValue({ truncated: false, items: SUB_PRODUCTS });
  const onSubmit = vi.fn(async () => undefined);
  render(
    <MovementForm
      description=""
      submitLabel="Save"
      busy={false}
      lock={null}
      categories={[{ id: 'c-opt', code: 'OPT', name: 'One Piece Toilet', brand: 'Swisware+' }]}
      colourHex={() => undefined}
      onSubmit={onSubmit}
    />,
  );
  await choose(t('inventory.field.product'), 'OPT · One Piece Toilet · Swisware\\+');
  await choose(t('inventory.field.subProduct'), name);
  fireEvent.change(screen.getByLabelText(t('inventory.field.pieces')), { target: { value: '5' } });
  return onSubmit;
}

describe('MovementForm', () => {
  it('lists every sub product of the chosen product and writes the fixed one’s variant', async () => {
    const onSubmit = await walkTo('102');

    expect(mocks.pick).toHaveBeenCalledWith('product', {
      term: '',
      categoryId: 'c-opt',
      limit: PICK_MAX_LIMIT,
    });
    // The fixed colour, shown locked: text beside its label, not a field to change.
    const colour = screen.getByText(t('inventory.field.colour')).nextElementSibling;
    expect(colour?.tagName).toBe('P');
    expect(colour?.textContent).toBe('White');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        variantId: 'v-102',
        quantityBoxes: 5,
        note: undefined,
      }),
    );
  });

  it.each([
    ['a colour that repeats the name', 'MAGENTA', 'v-mag'],
    ['a dedicated piece', '1111', 'v-1111'],
    ['a multicolour piece', 'Orissa Pan', 'v-orissa'],
  ])('shows no colour for %s and still writes its one variant', async (_case, name, variantId) => {
    const onSubmit = await walkTo(name);

    expect(screen.queryByText(t('inventory.field.colour'))).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ variantId })),
    );
  });
});
