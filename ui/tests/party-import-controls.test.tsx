/**
 * `PartyImportControls` and the dialog behind it, over a fake
 * `PartyImportTransport` the way both panels mount them: nothing without a
 * permission, each control only with its own flag, Export as a menu of CSV and
 * Excel that cannot start two downloads, and a preview that shows the party an
 * update changes.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartyImportResult } from '@orderbook/shared';

import { t } from '../src/i18n.js';
import { PartyImportControls, type PartyImportTransport } from '../src/PartyImportModal.js';
import { ToastProvider } from '../src/Toast.js';
import { installBrowserStubs } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
  // The download is an anchor click on an object URL; jsdom has neither.
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RESULT: PartyImportResult = {
  dryRun: true,
  mode: 'updateByCode',
  fileName: 'parties.csv',
  totalRows: 2,
  created: 0,
  updated: 2,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  issues: [],
  issuesTruncated: false,
  ignoredColumns: [],
  sample: [
    { row: 2, partyCode: 'P-0001', name: 'Shah Ceramics', city: 'Morbi', phone: '98250 22222' },
    // The same name twice: only the sheet row tells the two apart.
    { row: 3, partyCode: 'P-0002', name: 'Shah Ceramics', city: 'Rajkot', phone: '98250 33333' },
  ],
};

function makeTransport(overrides: Partial<PartyImportTransport> = {}): PartyImportTransport {
  return {
    partyImportTemplate: vi.fn(async () => ({ blob: new Blob(['x']), fileName: 'parties-template.csv' })),
    exportParties: vi.fn(async (format) => ({ blob: new Blob(['x']), fileName: `parties.${format}` })),
    importParties: vi.fn(async () => RESULT),
    ...overrides,
  };
}

function mount(props: { canImport: boolean; canExport: boolean }, transport = makeTransport()) {
  return render(
    <ToastProvider>
      <PartyImportControls transport={transport} onImported={() => undefined} {...props} />
    </ToastProvider>,
  );
}

const exportButton = () => screen.queryByRole('button', { name: t('partyImport.export') });
const importButton = () => screen.queryByRole('button', { name: t('partyImport.open') });

describe('which controls are on screen', () => {
  it('renders nothing at all for a person with neither permission', () => {
    const { container } = mount({ canImport: false, canExport: false });
    expect(container.textContent).toBe('');
    expect(exportButton()).toBeNull();
    expect(importButton()).toBeNull();
  });

  it('offers Export alone to a person who may export but not import, and Import alone to the reverse', () => {
    mount({ canImport: false, canExport: true });
    expect(exportButton()).not.toBeNull();
    expect(importButton()).toBeNull();
    cleanup();

    mount({ canImport: true, canExport: false });
    expect(exportButton()).toBeNull();
    expect(importButton()).not.toBeNull();
    cleanup();

    mount({ canImport: true, canExport: true });
    expect(exportButton()).not.toBeNull();
    expect(importButton()).not.toBeNull();
  });
});

describe('Export is a menu of CSV and Excel', () => {
  it('opens on a click, offers both formats, and downloads the one chosen', async () => {
    const transport = makeTransport();
    mount({ canImport: false, canExport: true }, transport);

    expect(screen.queryByRole('menuitem')).toBeNull();
    fireEvent.click(exportButton()!);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      t('import.export.csv'),
      t('import.export.xlsx'),
    ]);

    fireEvent.click(screen.getByRole('menuitem', { name: t('import.export.xlsx') }));
    await waitFor(() => expect(transport.exportParties).toHaveBeenCalledTimes(1));
    expect(transport.exportParties).toHaveBeenCalledWith('xlsx');
    // The menu closes once a format is chosen.
    await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull());
  });

  it('does not start a second export while the first is on its way', async () => {
    let finish: (value: { blob: Blob; fileName: string }) => void = () => undefined;
    const transport = makeTransport({
      exportParties: vi.fn(() => new Promise((resolve) => { finish = resolve; })),
    });
    mount({ canImport: false, canExport: true }, transport);

    fireEvent.click(exportButton()!);
    fireEvent.click(screen.getByRole('menuitem', { name: t('import.export.csv') }));
    expect(transport.exportParties).toHaveBeenCalledTimes(1);

    // Busy: the menu is shut and the button is disabled, so a second click on
    // it opens nothing and a second download cannot be asked for.
    expect(exportButton()!.hasAttribute('disabled')).toBe(true);
    fireEvent.click(exportButton()!);
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(transport.exportParties).toHaveBeenCalledTimes(1);

    finish({ blob: new Blob(['x']), fileName: 'parties.csv' });
    await waitFor(() => expect(exportButton()!.hasAttribute('disabled')).toBe(false));
    expect(transport.exportParties).toHaveBeenCalledTimes(1);
  });

  it('says so when the export is refused, and can be tried again', async () => {
    const transport = makeTransport({
      exportParties: vi.fn(async () => {
        throw Object.assign(new Error('Forbidden'), { messageKey: 'error.forbidden.missingPermission' });
      }),
    });
    mount({ canImport: false, canExport: true }, transport);

    fireEvent.click(exportButton()!);
    fireEvent.click(screen.getByRole('menuitem', { name: t('import.export.csv') }));
    await waitFor(() => expect(transport.exportParties).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(exportButton()!.hasAttribute('disabled')).toBe(false));

    fireEvent.click(exportButton()!);
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  });
});

describe('the preview of an update', () => {
  it('shows each party with its code, one row per sheet row even when two share a name', async () => {
    const transport = makeTransport();
    mount({ canImport: true, canExport: false }, transport);

    fireEvent.click(importButton()!);
    const file = new File(['Party Code,Phone\r\nP-0001,98250 22222\r\n'], 'parties.csv', { type: 'text/csv' });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });

    await waitFor(() => expect(transport.importParties).toHaveBeenCalledTimes(1));
    expect(transport.importParties).toHaveBeenCalledWith(file, { dryRun: true, mode: 'create' });

    expect(await screen.findByText('P-0001')).toBeTruthy();
    expect(screen.getByText('P-0002')).toBeTruthy();
    expect(screen.getByText(t('catalog.parties.column.code'))).toBeTruthy();
    // Both rows are there although they share a name — a key by name would have merged or warned.
    expect(screen.getAllByText('Shah Ceramics')).toHaveLength(2);
  });

  it('quotes a mode that exists in the export hint', () => {
    mount({ canImport: true, canExport: false });
    fireEvent.click(importButton()!);
    expect(t('partyImport.export.hint')).toContain(`"${t('partyImport.mode.updateByCode')}"`);
    expect(screen.getByText(t('partyImport.mode.updateByCode'))).toBeTruthy();
  });
});

describe('the problem list download', () => {
  it('guards a cell that would read as a formula, like every other CSV the product writes', async () => {
    const blobs: Blob[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob);
          return 'blob:problems';
        },
        revokeObjectURL: () => undefined,
      }),
    );
    const transport = makeTransport({
      importParties: vi.fn(async () => ({
        ...RESULT,
        updated: 0,
        failed: 1,
        issues: [
          { row: 2, kind: 'error' as const, column: '=HYPERLINK("http://x")', messageKey: 'validation.party.pincodeInvalid' as const },
        ],
      })),
    });
    mount({ canImport: true, canExport: false }, transport);

    fireEvent.click(importButton()!);
    const file = new File(['Party Code\r\nP-0001\r\n'], 'parties.csv', { type: 'text/csv' });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    fireEvent.click(await screen.findByRole('button', { name: t('import.report.download') }));

    expect(blobs).toHaveLength(1);
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blobs[0]!);
    });
    expect(text).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(text).not.toContain(`,"=HYPERLINK`);
  });
});
