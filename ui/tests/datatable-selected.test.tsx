/**
 * A DataTable row says whether it is selected (`aria-selected`) when the table has
 * any idea of selection, and is a plain `row`, not a `button`: `aria-selected` is not
 * allowed on `button`, and a row holding a checkbox or a button of its own should
 * not be a button itself (Party Access D1, nit 5, fixed once for every table).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DataTable, type DataTableColumn } from '../src/DataTable.js';
import { installBrowserStubs } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
});

afterEach(cleanup);

interface Row {
  id: string;
  name: string;
}

const ROWS: Row[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
];

const COLUMNS: DataTableColumn<Row>[] = [{ key: 'name', header: 'Name', render: (row) => row.name }];

function dataRows(): HTMLElement[] {
  return screen.getAllByRole('row').filter((row) => row.hasAttribute('data-row'));
}

describe('DataTable row selection semantics', () => {
  it('marks the open record selected and the others not', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} selectedId="b" onRowOpen={() => undefined} />);
    expect(dataRows().map((row) => row.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    // The CSS hook is unchanged.
    expect(dataRows().map((row) => row.getAttribute('data-selected'))).toEqual([null, 'true']);
  });

  it('marks ticked rows selected', () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        selectedIds={new Set(['a'])}
        onSelectionChange={() => undefined}
      />,
    );
    expect(dataRows().map((row) => row.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  });

  it('says nothing about selection on a table that has no idea of it', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} onRowOpen={() => undefined} />);
    expect(dataRows().every((row) => !row.hasAttribute('aria-selected'))).toBe(true);
  });

  it('keeps an openable row a row that is still reached by Tab and opened by a click or Enter', () => {
    const open = vi.fn();
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} selectedId="a" onRowOpen={open} />);
    const [first] = dataRows();
    expect(first!.getAttribute('role')).toBe('row');
    expect(first!.getAttribute('tabindex')).toBe('0');
    expect(screen.queryByRole('button', { name: /Alpha/ })).toBeNull();
    fireEvent.keyDown(first!, { key: 'Enter' });
    fireEvent.click(dataRows()[1]!);
    expect(open.mock.calls.map((call) => (call[0] as Row).id)).toEqual(['a', 'b']);
  });
});
