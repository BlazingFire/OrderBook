/**
 * The shared Logs screen (`ui/src/LogsScreen.tsx`), which both panels mount
 * with their own transport. What it pins:
 *
 *  · a Server Master's entry is highlighted and badged, and nobody else's is;
 *  · the search box carries `data-screen-search`, so Ctrl+F reaches it;
 *  · the entity and action dropdowns show translated names, with the raw token
 *    kept for one this build does not know;
 *  · the export link asks for the CSV in the reader's own language.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityLogEntry } from '@orderbook/shared';

import { FilterBarOutlet, FilterBarProvider } from '../src/FilterBarSlot.js';
import { LogsScreen, type LogsTransport } from '../src/LogsScreen.js';
import { t } from '../src/i18n.js';
import { installBrowserStubs } from './panel-harness.js';

function entry(id: string, name: string, tier?: 'admin' | 'server_master'): ActivityLogEntry {
  return {
    id,
    sequence: id,
    tenantId: 'tenant-1',
    entityType: 'party',
    entityId: 'PT0000000001',
    action: 'created',
    actor: { type: 'user', id: `user-${id}`, name, ...(tier ? { tier } : {}) },
    details: { name: 'Sharma Traders' },
    createdAt: '2026-10-01T10:00:00.000Z',
    hash: null,
    chained: true,
  } as ActivityLogEntry;
}

const ENTRIES = [entry('2', 'Owner', 'server_master'), entry('1', 'Ravi', 'admin')];

function transport(): LogsTransport & { exportQueries: unknown[] } {
  const exportQueries: unknown[] = [];
  return {
    exportQueries,
    logs: async () => ({ items: ENTRIES, nextCursor: null, prevCursor: null, limit: 50 }),
    logFacets: async () => ({
      actors: [],
      entityTypes: ['party', 'brand_new_entity'],
      actions: ['created'],
    }),
    verifyLogChain: async () => {
      throw new Error('not used');
    },
    logsExportUrl: (query) => {
      exportQueries.push(query);
      return '/api/logs/export';
    },
  };
}

async function mount(permissions = ['logs.view', 'logs.export']) {
  const fake = transport();
  render(
    <FilterBarProvider>
      <FilterBarOutlet />
      <LogsScreen permissions={permissions} transport={fake} />
    </FilterBarProvider>,
  );
  await screen.findByText('Owner');
  return fake;
}

beforeEach(() => {
  installBrowserStubs();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the shared Logs screen', () => {
  it("highlights and badges a Server Master's entry, and nobody else's", async () => {
    await mount();

    const owner = screen.getByText('Owner').closest('tr')!;
    const ravi = screen.getByText('Ravi').closest('tr')!;

    expect(owner.getAttribute('data-highlight')).toBe('true');
    expect(within(owner).getByText(t('tier.server_master'))).toBeTruthy();
    expect(ravi.hasAttribute('data-highlight')).toBe(false);
    expect(within(ravi).queryByText(t('tier.server_master'))).toBeNull();
  });

  it('gives its search box data-screen-search', async () => {
    await mount();

    const search = screen.getByLabelText(t('logs.filter.searchPlaceholder'));
    expect(search.hasAttribute('data-screen-search')).toBe(true);
  });

  it('names entity types and actions in the reader’s language, keeping an unknown one raw', async () => {
    await mount();

    fireEvent.focus(screen.getByLabelText(t('logs.filter.entityLabel')));
    const entities = await screen.findByRole('listbox');
    expect(within(entities).getByRole('option', { name: t('logs.entity.party') })).toBeTruthy();
    expect(within(entities).getByRole('option', { name: 'brand_new_entity' })).toBeTruthy();
    fireEvent.blur(screen.getByLabelText(t('logs.filter.entityLabel')));

    fireEvent.focus(screen.getByLabelText(t('logs.filter.actionLabel')));
    await waitFor(() =>
      expect(screen.getByRole('option', { name: t('logs.action.created') })).toBeTruthy(),
    );
  });

  it('asks for the CSV in the reader’s language', async () => {
    const fake = await mount();

    await act(async () => undefined);
    expect(fake.exportQueries.at(-1)).toMatchObject({ locale: 'en' });
  });

  it('reads nothing without logs.view', async () => {
    let asked = false;
    const fake = transport();
    render(
      <LogsScreen
        permissions={[]}
        transport={{
          ...fake,
          logs: async () => {
            asked = true;
            return { items: [], nextCursor: null, prevCursor: null, limit: 50 };
          },
        }}
      />,
    );

    expect(screen.getByText(t('logs.noPermission.title'))).toBeTruthy();
    expect(asked).toBe(false);
  });
});
