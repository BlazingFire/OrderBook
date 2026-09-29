/**
 * The option-list editor without a server behind it: a fake transport stands
 * in for either panel's api client, which is the whole point of the editor
 * taking one. What matters is that the list renders from the transport, that
 * an add goes out through it, that a stale save is read through the panel's
 * own `conflictOf` and overwritten only against the version it reported, and
 * that a reader without `fields.manage` gets the list and nothing that writes.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FieldUsageBreakdown, OptionListItem } from '@orderbook/shared';

import { OptionListEditor, type OptionListTransport } from '../src/OptionListEditor.js';
import { t } from '../src/i18n.js';

beforeAll(() => {
  // jsdom implements neither. `useOverlay` calls the first when a Modal
  // closes, and DataTable measures itself with the second; an observer that
  // never fires is an honest stand-in where there is no layout.
  Element.prototype.checkVisibility ??= () => true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(cleanup);

function item(value: string, overrides: Partial<OptionListItem> = {}): OptionListItem {
  return {
    id: `id-${value}`,
    tenantId: 'tenant',
    listKey: 'lead.sourcePlatform',
    value,
    label: value.toUpperCase(),
    sequence: 0,
    isActive: true,
    hex: null,
    deletedAt: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function fakeTransport(items: OptionListItem[]) {
  const usage: FieldUsageBreakdown = {
    listKey: 'lead.sourcePlatform',
    sources: ['leads'],
    values: [],
    unlisted: [],
  };
  return {
    fieldValues: vi.fn(async () => ({ items })),
    fieldUsage: vi.fn(async () => usage),
    createFieldValue: vi.fn(async () => undefined),
    updateFieldValue: vi.fn(async () => undefined),
    deleteFieldValue: vi.fn(async () => undefined),
    reorderFieldValues: vi.fn(async () => undefined),
    conflictOf: vi.fn<OptionListTransport['conflictOf']>(() => null),
  } satisfies OptionListTransport;
}

describe('OptionListEditor', () => {
  it('renders the list the transport returns', async () => {
    const transport = fakeTransport([item('call'), item('whatsapp')]);
    render(<OptionListEditor listKey="lead.sourcePlatform" canManage transport={transport} />);

    expect(await screen.findByText('CALL')).toBeTruthy();
    expect(screen.getByText('WHATSAPP')).toBeTruthy();
    expect(transport.fieldValues).toHaveBeenCalledWith('lead.sourcePlatform');
    expect(transport.fieldUsage).toHaveBeenCalledWith('lead.sourcePlatform');
  });

  it('sends a new value through create, then reloads', async () => {
    const transport = fakeTransport([item('call')]);
    render(<OptionListEditor listKey="lead.sourcePlatform" canManage transport={transport} />);
    await screen.findByText('CALL');

    fireEvent.click(screen.getByRole('button', { name: t('fields.values.add') }));
    fireEvent.change(screen.getByLabelText(new RegExp(`^${t('fields.values.field.value')}`)), {
      target: { value: '  walk_in ' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('fields.action.create') }));

    await waitFor(() => expect(transport.fieldValues).toHaveBeenCalledTimes(2));
    // A blank label falls back to the value, and a set with no colour sends none.
    expect(transport.createFieldValue).toHaveBeenCalledWith({
      listKey: 'lead.sourcePlatform',
      value: 'walk_in',
      label: 'walk_in',
      hex: null,
    });
  });

  it('reports a stale save through conflictOf and overwrites only against the stored version', async () => {
    const transport = fakeTransport([item('call', { version: 3 })]);
    const stale = new Error('Somebody else saved this first');
    transport.updateFieldValue.mockRejectedValueOnce(stale);
    transport.conflictOf.mockImplementation((error) =>
      error === stale
        ? {
            message: stale.message,
            storedVersion: 7,
            diff: { label: { stored: 'Phone', incoming: 'CALL' } },
          }
        : null,
    );
    render(<OptionListEditor listKey="lead.sourcePlatform" canManage transport={transport} />);
    await screen.findByText('CALL');

    fireEvent.click(screen.getByRole('button', { name: t('fields.action.edit') }));
    fireEvent.click(screen.getByRole('button', { name: t('fields.action.save') }));

    expect(await screen.findByText(stale.message)).toBeTruthy();
    expect(transport.updateFieldValue).toHaveBeenLastCalledWith(
      'id-call',
      expect.objectContaining({ expectedVersion: 3 }),
    );

    fireEvent.click(screen.getByRole('button', { name: t('fields.conflict.overwrite') }));
    await waitFor(() => expect(transport.updateFieldValue).toHaveBeenCalledTimes(2));
    expect(transport.updateFieldValue).toHaveBeenLastCalledWith(
      'id-call',
      expect.objectContaining({ expectedVersion: 7 }),
    );
  });

  it('shows the list read-only when the reader cannot manage it', async () => {
    const transport = fakeTransport([item('call')]);
    render(
      <OptionListEditor listKey="lead.sourcePlatform" canManage={false} transport={transport} />,
    );
    await screen.findByText('CALL');

    expect(screen.queryByRole('button', { name: t('fields.values.add') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('fields.action.edit') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('fields.action.remove') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('fields.action.moveUp') })).toBeNull();
  });
});
