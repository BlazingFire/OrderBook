/**
 * Lists (1.4 D3, R3–R5): one page per list on the shared editor; adding needs
 * `catalog.lists.manage`, reading needs `fields.view`.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OptionListItem } from '@orderbook/shared';

import { CatalogListsScreen, type CatalogListsPage } from '../src/CatalogListsScreen.js';
import type { OptionListTransport } from '../src/OptionListEditor.js';
import { t } from '../src/i18n.js';

beforeAll(() => {
  Element.prototype.checkVisibility ??= () => true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(cleanup);

function item(listKey: string, value: string): OptionListItem {
  return {
    id: `id-${value}`,
    tenantId: 'tenant',
    listKey,
    value,
    label: value,
    sequence: 0,
    isActive: true,
    hex: null,
    deletedAt: null,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    version: 1,
  } as OptionListItem;
}

function transportFor() {
  return {
    fieldValues: vi.fn(async (listKey: string) => ({ items: [item(listKey, 'Premium')] })),
    fieldUsage: vi.fn(async (listKey: string) => ({ listKey, sources: [], values: [], unlisted: [] })),
    createFieldValue: vi.fn(),
    updateFieldValue: vi.fn(),
    deleteFieldValue: vi.fn(),
    reorderFieldValues: vi.fn(),
    conflictOf: vi.fn(() => null),
  } as unknown as OptionListTransport & { fieldValues: ReturnType<typeof vi.fn> };
}

const PAGES: Array<[CatalogListsPage, string]> = [
  ['grades', 'line.grade'],
  ['packaging', 'line.packaging'],
  ['brands', 'product.brand'],
];

describe('CatalogListsScreen', () => {
  it.each(PAGES)('%s page edits %s', async (page, listKey) => {
    const transport = transportFor();
    render(
      <CatalogListsScreen
        page={page}
        permissions={['fields.view', 'catalog.lists.manage']}
        transport={transport}
      />,
    );
    await waitFor(() => expect(transport.fieldValues).toHaveBeenCalledWith(listKey));
    expect(await screen.findByRole('button', { name: t('fields.values.add') })).toBeTruthy();
  });

  it('shows the values read-only without catalog.lists.manage, even to a fields.manage holder', async () => {
    const transport = transportFor();
    render(
      <CatalogListsScreen
        page="grades"
        permissions={['fields.view', 'fields.manage']}
        transport={transport}
      />,
    );
    expect((await screen.findAllByText('Premium')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: t('fields.values.add') })).toBeNull();
  });

  it('shows the values, read-only, to a person who holds no list permission at all', async () => {
    const transport = transportFor();
    render(<CatalogListsScreen page="brands" permissions={[]} transport={transport} />);
    expect((await screen.findAllByText('Premium')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: t('fields.values.add') })).toBeNull();
  });
});
