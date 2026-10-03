/**
 * Parties and Products sorting and filters (1.4 D3, R17): the sort is kept per
 * machine, a server-sorted table shows rows in the order it was given, and the
 * filter rows report what was typed and clear in one click.
 */

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import { DataTable, type DataTableColumn, type DataTableSort } from '../src/DataTable.js';
import {
  NO_PARTY_LIST_FILTERS,
  NO_PRODUCT_LIST_FILTERS,
  PartyFilterRow,
  presenceOf,
  ProductFilterRow,
  useStoredSort,
  type PartyListFilters,
  type ProductListFilters,
} from '../src/ListFilters.js';
import { t } from '../src/i18n.js';

beforeAll(() => {
  Element.prototype.checkVisibility ??= () => true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('useStoredSort', () => {
  it('starts from the fallback, remembers a change, and reads it back in a new mount', () => {
    const first = renderHook(() => useStoredSort('parties', { key: 'name', dir: 'asc' }));
    expect(first.result.current[0]).toEqual({ key: 'name', dir: 'asc' });

    act(() => first.result.current[1]({ key: 'city', dir: 'desc' }));
    expect(first.result.current[0]).toEqual({ key: 'city', dir: 'desc' });
    first.unmount();

    const second = renderHook(() => useStoredSort('parties', { key: 'name', dir: 'asc' }));
    expect(second.result.current[0]).toEqual({ key: 'city', dir: 'desc' });
  });

  it('keeps each table under its own key', () => {
    const parties = renderHook(() => useStoredSort('parties', { key: 'name', dir: 'asc' }));
    act(() => parties.result.current[1]({ key: 'city', dir: 'desc' }));
    const products = renderHook(() => useStoredSort('products.sub', { key: 'category', dir: 'asc' }));
    expect(products.result.current[0]).toEqual({ key: 'category', dir: 'asc' });
  });

  it('falls back when what was stored is not a sort', () => {
    window.localStorage.setItem('ob.listSort.parties', '{"key":"city","dir":"sideways"}');
    const { result } = renderHook(() => useStoredSort('parties', { key: 'name', dir: 'asc' }));
    expect(result.current[0]).toEqual({ key: 'name', dir: 'asc' });
  });

  it('works, for this page only, when storage is blocked', () => {
    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useStoredSort('parties', { key: 'name', dir: 'asc' }));
    act(() => result.current[1]({ key: 'phone', dir: 'asc' }));
    expect(result.current[0]).toEqual({ key: 'phone', dir: 'asc' });
    blocked.mockRestore();
  });
});

describe('presenceOf', () => {
  it('maps the three states to the wire value', () => {
    expect(presenceOf('any')).toBeUndefined();
    expect(presenceOf('yes')).toBe(true);
    expect(presenceOf('no')).toBe(false);
  });
});

interface Row {
  id: string;
  name: string;
}

describe('a server-sorted DataTable', () => {
  const columns: DataTableColumn<Row>[] = [
    { key: 'name', header: 'Name', sortable: true, render: (row) => row.name },
  ];
  // Delivered Z, A: the server's order. A local sort would flip it.
  const rows: Row[] = [
    { id: '1', name: 'Zed' },
    { id: '2', name: 'Abe' },
  ];

  function Harness({ onSort }: { onSort: (sort: DataTableSort) => void }) {
    const [sort, setSort] = useState<DataTableSort>({ key: 'name', dir: 'asc' });
    return (
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        sort={sort}
        sortLocally={false}
        onSortChange={(next) => {
          setSort(next);
          onSort(next);
        }}
      />
    );
  }

  it('shows rows as given, and a header click reports the new sort', () => {
    const onSort = vi.fn();
    render(<Harness onSort={onSort} />);

    const order = () => screen.getAllByRole('row').slice(1).map((row) => row.textContent);
    expect(order()).toEqual(['Zed', 'Abe']);

    fireEvent.click(screen.getByRole('button', { name: new RegExp('Name') }));
    expect(onSort).toHaveBeenCalledWith({ key: 'name', dir: 'desc' });
    expect(order()).toEqual(['Zed', 'Abe']);
  });
});

describe('the filter rows', () => {
  it('Products: typing a size and choosing a photo state report up; Clear filters resets', () => {
    const seen: ProductListFilters[] = [];
    function Harness() {
      const [value, setValue] = useState<ProductListFilters>(NO_PRODUCT_LIST_FILTERS);
      return (
        <ProductFilterRow
          value={value}
          onChange={(next) => {
            seen.push(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);
    expect(screen.queryByRole('button', { name: t('listFilter.clear') })).toBeNull();

    fireEvent.change(screen.getByLabelText(t('listFilter.size')), { target: { value: '600x600' } });
    expect(seen.at(-1)).toEqual({ size: '600x600', hasPhoto: 'any' });

    fireEvent.click(screen.getByRole('button', { name: t('listFilter.clear') }));
    expect(seen.at(-1)).toEqual(NO_PRODUCT_LIST_FILTERS);
  });

  it('Parties: city, state and GST report up; Clear filters resets', () => {
    const seen: PartyListFilters[] = [];
    function Harness() {
      const [value, setValue] = useState<PartyListFilters>(NO_PARTY_LIST_FILTERS);
      return (
        <PartyFilterRow
          value={value}
          onChange={(next) => {
            seen.push(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);

    fireEvent.change(screen.getByLabelText(t('listFilter.city')), { target: { value: 'Morbi' } });
    fireEvent.change(screen.getByLabelText(t('listFilter.state')), { target: { value: 'Guj' } });
    expect(seen.at(-1)).toEqual({ city: 'Morbi', state: 'Guj', hasGst: 'any' });

    fireEvent.click(screen.getByRole('button', { name: t('listFilter.clear') }));
    expect(seen.at(-1)).toEqual(NO_PARTY_LIST_FILTERS);
  });
});
