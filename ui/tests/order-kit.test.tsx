/**
 * The new pending order's kit pieces (`ui/src/order/`): the details bar, the follow-up
 * segmented control, the checks list, the Added products panel and the cart row. They are
 * presentational, so what is pinned here is the contract both panels build on: which slots
 * exist, what is announced, and which handlers fire.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureUi } from '../src/config.js';
import {
  AddedGroup,
  AddedLine,
  AddedProductsPanel,
  ColourSelect,
  ProductCard,
  SubGrid,
  SubRow,
  CartEntry,
  CartLines,
  FollowUpField,
  OrderChecks,
  OrderDetailsBar,
  OrderField,
  PartyChip,
  partyInitials,
} from '../src/index.js';
import { ProductThumb } from '../src/ProgressiveImage.js';
import { installBrowserStubs } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
  configureUi({ panel: 'master', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
});
afterEach(cleanup);

describe('OrderDetailsBar', () => {
  it('lays the fields in a card, with three columns when there is no owner', () => {
    const { container, rerender } = render(
      <OrderDetailsBar hasOwner>
        <OrderField label="Party" wide>
          <input aria-label="p" />
        </OrderField>
        <OrderField label="Source">
          <input aria-label="s" />
        </OrderField>
      </OrderDetailsBar>,
    );
    const bar = container.querySelector('.ob-order-details')!;
    expect(bar.getAttribute('data-owner')).toBe('true');
    expect(within(bar as HTMLElement).getByText('Party')).toBeTruthy();
    expect(container.querySelector('[data-wide="true"]')).not.toBeNull();

    rerender(
      <OrderDetailsBar hasOwner={false}>
        <OrderField label="Party">
          <input aria-label="p" />
        </OrderField>
      </OrderDetailsBar>,
    );
    expect(container.querySelector('.ob-order-details')!.getAttribute('data-owner')).toBe('false');
  });
});

describe('FollowUpField', () => {
  it('is one radio group beside the date, with the active choice checked and each click handled', () => {
    const picked: string[] = [];
    render(
      <FollowUpField
        groupLabel="Quick follow-up"
        date={<input aria-label="date" />}
        quick={[
          {
            key: 'd1',
            label: '+1 d',
            title: 'Tomorrow',
            active: false,
            onClick: () => picked.push('d1'),
          },
          {
            key: 'd3',
            label: '+3 d',
            title: 'In 3 days',
            active: true,
            onClick: () => picked.push('d3'),
          },
        ]}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Quick follow-up' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(radios[0]!.getAttribute('title')).toBe('Tomorrow');
    expect(screen.getByRole('radio', { name: 'In 3 days' })).toBe(radios[1]);
    fireEvent.click(radios[0]!);
    expect(picked).toEqual(['d1']);
    expect(screen.getByLabelText('date')).toBeTruthy();
  });
});

describe('FollowUpField keyboard', () => {
  function field(activeKey: string | null) {
    const picked: string[] = [];
    const quick = ['d1', 'd3', 'wk'].map((key) => ({
      key,
      label: key,
      title: `title ${key}`,
      active: key === activeKey,
      onClick: () => picked.push(key),
    }));
    render(<FollowUpField groupLabel="Quick" date={<input aria-label="date" />} quick={quick} />);
    return { picked, radios: screen.getAllByRole('radio') };
  }

  it('has one tab stop: the checked choice, or the first when none is checked', () => {
    const checked = field('d3');
    expect(checked.radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
    cleanup();
    const none = field(null);
    expect(none.radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
  });

  it('moves to the next or previous choice with the arrows, selecting it and wrapping', () => {
    const { picked, radios } = field('d3');
    radios[1]!.focus();
    fireEvent.keyDown(radios[1]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(radios[2]);
    fireEvent.keyDown(radios[2]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(radios[0]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(radios[2]);
    expect(picked).toEqual(['wk', 'd1', 'wk']);
  });

  it('does not clear the checked choice by moving onto it', () => {
    const { picked, radios } = field('d1');
    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: 'ArrowRight' });
    fireEvent.keyDown(radios[1]!, { key: 'ArrowLeft' });
    // The second move lands on the checked one: it is focused but not clicked (a click would clear it).
    expect(document.activeElement).toBe(radios[0]);
    expect(picked).toEqual(['d3']);
  });
});

describe('OrderChecks', () => {
  it('marks each item ok, to do or idle, with its tooltip', () => {
    const { container } = render(
      <OrderChecks
        items={[
          { key: 'a', label: 'Party · Shree', state: 'ok' },
          { key: 'b', label: 'Select a party', state: 'todo', title: 'why' },
          { key: 'c', label: 'Add at least one product', state: 'idle' },
        ]}
      />,
    );
    const rows = [...container.querySelectorAll('li')];
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual(['ok', 'todo', 'idle']);
    expect(rows[1]!.getAttribute('title')).toBe('why');
  });
});

describe('AddedProductsPanel', () => {
  function panel(over: Partial<Parameters<typeof AddedProductsPanel>[0]> = {}) {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(
      <AddedProductsPanel
        ariaLabel="Added products"
        title="Added products"
        count="3"
        search={<input aria-label="Search added products" />}
        toolbar={<span>2 selected</span>}
        checks={[{ key: 'p', label: 'Party · X', state: 'ok' }]}
        footerNote={<p>queued, will send when online</p>}
        totalLabel="3 products"
        totalPcs="520"
        pcsUnit="pcs"
        cancelLabel="Cancel"
        onCancel={onCancel}
        saveLabel="Save pending order"
        saveKbd="Ctrl S"
        saveDisabled={false}
        onSave={onSave}
        {...over}
      >
        <div>row one</div>
      </AddedProductsPanel>,
    );
    return { onSave, onCancel };
  }

  it('frames the count, search, toolbar, rows, note, checks, total and the two actions', () => {
    const { onSave, onCancel } = panel();
    const aside = screen.getByRole('complementary', { name: 'Added products' });
    expect(within(aside).getByText('3')).toBeTruthy();
    expect(within(aside).getByLabelText('Search added products')).toBeTruthy();
    expect(within(aside).getByText('2 selected')).toBeTruthy();
    expect(within(aside).getByText('row one')).toBeTruthy();
    expect(within(aside).getByText('queued, will send when online')).toBeTruthy();
    expect(within(aside).getByText('520')).toBeTruthy();

    fireEvent.click(within(aside).getByRole('button', { name: /Save pending order/ }));
    fireEvent.click(within(aside).getByRole('button', { name: 'Cancel' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables Save, shows the empty text instead of rows, and shows busy while saving', async () => {
    panel({ saveDisabled: true, empty: <span>Nothing added yet</span>, count: '' });
    const aside = screen.getByRole('complementary', { name: 'Added products' });
    expect(
      (within(aside).getByRole('button', { name: /Save pending order/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(within(aside).getByText('Nothing added yet')).toBeTruthy();
    expect(within(aside).queryByText('row one')).toBeNull();
    cleanup();

    panel({ saving: true });
    const busy = screen.getByRole('button', { name: /Save pending order/ });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    await act(async () => undefined);
  });
});

describe('CartEntry', () => {
  it('opens on its toggle, not on its leading tick box, and shows facts, actions and lines when open', () => {
    const onToggle = vi.fn();
    const onTick = vi.fn();
    const { rerender } = render(
      <CartEntry
        open={false}
        onToggle={onToggle}
        leading={<input type="checkbox" aria-label="tick" onChange={onTick} />}
        head={<span>WB-2016 Wash basin</span>}
        facts={<span>fact</span>}
        actions={<button type="button">edit</button>}
      >
        <CartLines>
          <span>Standard</span>
        </CartLines>
      </CartEntry>,
    );
    expect(screen.queryByText('fact')).toBeNull();
    fireEvent.click(screen.getByLabelText('tick'));
    expect(onToggle).not.toHaveBeenCalled();
    expect(onTick).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /WB-2016/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /WB-2016/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );

    rerender(
      <CartEntry
        open
        onToggle={onToggle}
        head={<span>WB-2016 Wash basin</span>}
        facts={<span>fact</span>}
        actions={<button type="button">edit</button>}
      >
        <CartLines>
          <span>Standard</span>
        </CartLines>
      </CartEntry>,
    );
    expect(screen.getByText('fact')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'edit' })).toBeTruthy();
    expect(screen.getByText('Standard')).toBeTruthy();
    expect(screen.getByRole('button', { name: /WB-2016/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });
});

describe('ProductThumb', () => {
  const image = {
    id: 'img-1',
    productId: 'p1',
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

  it('loads the photo at the asked size, with the given alt, from the primary of the gallery', () => {
    const second = { ...image, id: 'img-2', isPrimary: false };
    const { container } = render(
      <ProductThumb images={[second, image]} name="Wash basin" size={48} alt="Basin photo" />,
    );
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toMatch(/^\/uploads\/images\/img-1\/(micro|thumb|large)$/);
    expect(img.getAttribute('alt')).toBe('Basin photo');
    expect(container.querySelector('.ob-thumb')!.getAttribute('style')).toContain('3.429rem');
  });

  it('with no size it is the list row, and the alt is the name', () => {
    const { container } = render(<ProductThumb images={[image]} name="Wash basin" />);
    expect(container.querySelector('img')!.getAttribute('alt')).toBe('Wash basin');
    expect(container.querySelector('.ob-thumb')!.getAttribute('style')).toContain('2rem');
  });

  it('draws nothing, a blank square, or an initial tile of the same size when there is no photo', () => {
    const none = render(<ProductThumb images={undefined} name="x" size={32} fallback="none" />);
    expect(none.container.innerHTML).toBe('');
    none.unmount();
    const blank = render(<ProductThumb images={[]} name="x" size={32} />);
    expect(blank.container.querySelector('.ob-thumb--empty')!.textContent).toBe('');
    blank.unmount();
    const tile = render(
      <ProductThumb images={[]} name="wash basin" size={32} fallback="initial" />,
    );
    const square = tile.container.querySelector('.ob-thumb--empty')!;
    expect(square.textContent).toBe('W');
    expect(square.getAttribute('style')).toContain('2.286rem');
    expect(tile.container.querySelector('img')).toBeNull();
  });
});

describe('CartEntry thumb slot', () => {
  it('puts the thumbnail inside the toggle, between the chevron and the head', () => {
    render(
      <CartEntry
        open={false}
        onToggle={() => undefined}
        thumb={<i data-testid="thumb" />}
        head={<span>WB-2016</span>}
      />,
    );
    const toggle = screen.getByRole('button', { name: /WB-2016/ });
    expect(within(toggle).getByTestId('thumb')).toBeTruthy();
  });
});

describe('PartyChip', () => {
  it('shows the initials, the name, the code and the city, and gives the party back on close', () => {
    const onChange = vi.fn();
    const { container } = render(
      <PartyChip
        name="Shree Ceramics"
        code="SC-0142"
        city="Rajkot"
        extra={<span>own names</span>}
        changeLabel="Change party"
        onChange={onChange}
      />,
    );
    expect(container.querySelector('.ob-order-party__badge')!.textContent).toBe('SC');
    expect(container.querySelector('.ob-order-party__name')!.textContent).toBe('Shree Ceramics');
    expect(container.querySelector('.ob-order-party__code')!.textContent).toBe('SC-0142');
    expect(container.querySelector('.ob-order-party__meta')!.textContent).toBe('· Rajkot');
    expect(screen.getByText('own names')).toBeTruthy();
    const close = screen.getByRole('button', { name: 'Change party' });
    expect(close.hasAttribute('data-field')).toBe(true);
    fireEvent.click(close);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('leaves out a code or a city it was not given, and takes initials from two words at most', () => {
    const { container } = render(
      <PartyChip
        name="om sai marble and sanitary"
        changeLabel="Change party"
        onChange={() => undefined}
      />,
    );
    expect(container.querySelector('.ob-order-party__code')).toBeNull();
    expect(container.querySelector('.ob-order-party__meta')).toBeNull();
    expect(partyInitials('om sai marble and sanitary')).toBe('OS');
    expect(partyInitials('  ')).toBe('');
  });
});

describe('ColourSelect', () => {
  const OPTIONS = [
    { id: '1', value: 'WHITE', label: 'White' },
    { id: '2', value: 'IVORY', label: 'Ivory' },
    { id: '3', value: 'ALMOND', label: 'Almond' },
  ] as never;

  function select(value: string, attention = false) {
    const onPick = vi.fn();
    const onAdvance = vi.fn();
    const view = render(
      <ColourSelect
        value={value}
        options={OPTIONS}
        labelOf={(v) => v.charAt(0) + v.slice(1).toLowerCase()}
        hexOf={() => '#fff'}
        ariaLabel="Colour"
        placeholder="Pick colour"
        hint="Arrows move, Enter picks"
        noMatches="No match"
        attention={attention}
        onPick={onPick}
        onAdvance={onAdvance}
      />,
    );
    return {
      onPick,
      onAdvance,
      box: screen.getByRole('combobox', { name: 'Colour' }) as HTMLInputElement,
      view,
    };
  }

  it('shows the placeholder, the chosen colour by its label, and the amber state while one is needed', () => {
    const empty = select('', true);
    expect(empty.box.value).toBe('');
    expect(empty.box.placeholder).toBe('Pick colour');
    expect(empty.view.container.querySelector('[data-state="needed"]')).not.toBeNull();
    cleanup();
    const chosen = select('IVORY');
    expect(chosen.box.value).toBe('Ivory');
    expect(chosen.view.container.querySelector('[data-state="set"]')).not.toBeNull();
  });

  it('opens its list on a click, narrows it as somebody types, and takes the highlighted colour on Enter', () => {
    const { box, onPick, onAdvance } = select('');
    fireEvent.click(box);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByText('Arrows move, Enter picks')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'iv' } });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Ivory']);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('IVORY');
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('moves with the arrows, closes on Escape, and a mouse press picks', () => {
    const { box, onPick } = select('');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('IVORY');
    fireEvent.click(box);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(box);
    fireEvent.mouseDown(screen.getByRole('option', { name: /Almond/ }));
    expect(onPick).toHaveBeenLastCalledWith('ALMOND');
  });

  it('on a closed select that has its colour, Enter just goes on; with none it opens the list', () => {
    const set = select('WHITE');
    fireEvent.keyDown(set.box, { key: 'Enter' });
    expect(set.onAdvance).toHaveBeenCalledTimes(1);
    expect(set.onPick).not.toHaveBeenCalled();
    cleanup();
    const none = select('');
    fireEvent.keyDown(none.box, { key: 'Enter' });
    expect(none.onAdvance).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('says so when nothing matches', () => {
    const { box } = select('');
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText('No match')).toBeTruthy();
  });
});

describe('ProductCard and its grid', () => {
  it('frames a head, a header row of seven labels, the rows and a footer', () => {
    const { container } = render(
      <ProductCard head={<span>OPT head</span>} footer={<span>footer</span>}>
        <SubGrid
          labels={{
            code: 'Code',
            sub: 'Sub product',
            colour: 'Colour',
            weight: 'Weight',
            qty: 'Qty',
            packaging: 'Packaging',
            grade: 'Grade',
          }}
        >
          <SubRow muted>
            <span>a</span>
          </SubRow>
        </SubGrid>
      </ProductCard>,
    );
    expect(screen.getByText('OPT head')).toBeTruthy();
    expect(screen.getByText('footer')).toBeTruthy();
    const head = container.querySelector('.ob-order-subrow--head')!;
    expect([...head.children].map((cell) => cell.textContent)).toEqual([
      'Code',
      'Sub product',
      'Colour',
      'Weight',
      'Qty',
      'Packaging',
      'Grade',
    ]);
    expect(container.querySelector('.ob-order-subrow[data-muted="true"]')).not.toBeNull();
  });
});

describe('AddedGroup', () => {
  function group(open: boolean) {
    const onToggle = vi.fn();
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    render(
      <AddedGroup
        open={open}
        onToggle={onToggle}
        leading={<input type="checkbox" aria-label="tick" />}
        code="WB"
        name="Wash basin"
        pieces={350}
        pcsUnit="pcs"
        onEdit={onEdit}
        onRemove={onRemove}
        editLabel="Edit Wash basin"
        removeLabel="Remove Wash basin"
      >
        <AddedLine
          sub="Standard"
          colour="White"
          colourHex="#fff"
          packaging="Box"
          grade=""
          qty={200}
        />
        <AddedLine sub="Standard" colour="" packaging="" grade="Premium" qty={150} />
      </AddedGroup>,
    );
    return { onToggle, onEdit, onRemove };
  }

  it('shows code, name and total, and its lines when open: colour, dashes for blanks, quantity', () => {
    group(true);
    expect(screen.getByText('WB')).toBeTruthy();
    expect(screen.getByText('Wash basin')).toBeTruthy();
    expect(screen.getByText('350')).toBeTruthy();
    const lines = document.querySelectorAll('[data-added-line]');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toContain('White');
    expect(lines[0]!.textContent).toContain('Box');
    expect(lines[0]!.textContent).toContain('200');
    // No colour, no packaging: dashes, and the grade where it is.
    expect(lines[1]!.textContent).toContain('—');
    expect(lines[1]!.textContent).toContain('Premium');
  });

  it('hides its lines when closed, toggles on its head only, and edit / remove are their own buttons', () => {
    const { onToggle, onEdit, onRemove } = group(false);
    expect(document.querySelectorAll('[data-added-line]')).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('tick'));
    expect(onToggle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Wash basin/, expanded: false }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Wash basin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Wash basin' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
