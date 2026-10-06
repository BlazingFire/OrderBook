/**
 * Import and export parties as a spreadsheet, on both panels
 * (`docs/PARTY_IMPORT_FORMAT.md`).
 *
 * The dialog is `ImportDialog`, shared with the product import; this file is
 * what is specific to parties — the words, the two modes (add new / update by
 * Party Code), a sample row read as a party — and `PartyImportControls`, the
 * Export and Import buttons with their dialog, so the Master's Parties screen
 * and the Office's Catalog screen mount one thing and cannot drift apart.
 *
 * Takes a `transport`, never a panel's api client (`no-transport-dep.test.ts`).
 * Each button is absent, not disabled, without its permission: Export needs
 * `parties.view` and Import `parties.bulk` — the Master checks both again.
 */

import { useRef, useState } from 'react';
import type { PartyImportFormat, PartyImportMode, PartyImportResult, PartyImportSampleRow } from '@orderbook/shared';
import { MAX_PARTY_IMPORT_BYTES, MAX_PARTY_IMPORT_ISSUES } from '@orderbook/shared';

import { Button } from './Button.js';
import { Popover } from './Popover.js';
import type { DataTableColumn } from './DataTable.js';
import { apiErrorText } from './errorText.js';
import { ImportDialog, saveBlob } from './ImportDialog.js';
import { t } from './i18n.js';
import { rem } from './rem.js';
import { useToast } from './Toast.js';

/** What the dialog and the buttons need from a panel — HTTP on both, the Master's own or the Office's proxy of it. */
export interface PartyImportTransport {
  partyImportTemplate: (format: PartyImportFormat) => Promise<{ blob: Blob; fileName: string }>;
  exportParties: (format: PartyImportFormat) => Promise<{ blob: Blob; fileName: string }>;
  importParties: (
    file: File,
    options: { dryRun: boolean; mode: PartyImportMode },
  ) => Promise<PartyImportResult>;
}

interface PartyImportModalProps {
  open: boolean;
  transport: PartyImportTransport;
  onClose: () => void;
  /** Something was written; the screen should refetch. */
  onImported: (result: PartyImportResult) => void;
  onError: (message: string) => void;
}

// Built per render, not at import: `t` answers in the language on screen.
const modes = (): ReadonlyArray<{ value: PartyImportMode; label: string }> => [
  { value: 'create', label: t('partyImport.mode.create') },
  { value: 'updateByCode', label: t('partyImport.mode.updateByCode') },
];

const sampleColumns = (): DataTableColumn<PartyImportSampleRow>[] => [
  {
    key: 'code',
    header: t('catalog.parties.column.code'),
    width: rem(100),
    render: (row) => <span className="ob-mono">{row.partyCode ?? '—'}</span>,
  },
  { key: 'name', header: t('party.field.name'), render: (row) => row.name ?? '—' },
  { key: 'city', header: t('party.field.city'), width: rem(140), render: (row) => row.city ?? '—' },
  {
    key: 'phone',
    header: t('party.field.phone'),
    width: rem(140),
    render: (row) => <span className="ob-mono">{row.phone ?? '—'}</span>,
  },
  {
    key: 'pincode',
    header: t('party.field.pincode'),
    width: rem(100),
    render: (row) => <span className="ob-mono">{row.pincode ?? '—'}</span>,
  },
];

// The sheet row is the key: two rows of a file can say the same name, and an
// update's sample row is an existing party with changes laid over it.
const sampleKey = (row: PartyImportSampleRow): string => String(row.row);

export function PartyImportModal({ open, transport, onClose, onImported, onError }: PartyImportModalProps) {
  return (
    <ImportDialog<PartyImportMode, PartyImportSampleRow, PartyImportResult>
      open={open}
      onClose={onClose}
      onImported={onImported}
      onError={onError}
      maxBytes={MAX_PARTY_IMPORT_BYTES}
      maxIssues={MAX_PARTY_IMPORT_ISSUES}
      modes={modes()}
      labels={{
        title: t('partyImport.title'),
        templateHint: t('partyImport.template.hint'),
        exportHint: t('partyImport.export.hint'),
        modeLabel: t('partyImport.mode.label'),
        confirm: (count) => t('partyImport.confirm', { count }),
        done: (result) => t('partyImport.done', { created: result.created, updated: result.updated }),
        donePartial: (result) =>
          t('import.done.partial', {
            created: result.created,
            updated: result.updated,
            skipped: result.skipped,
            failed: result.failed,
          }),
        unchanged: (count) => t('partyImport.unchanged', { count }),
        exportFailed: 'partyImport.exportFailed',
      }}
      actions={{
        template: (format) => transport.partyImportTemplate(format),
        export: (format) => transport.exportParties(format),
        run: (file, options) => transport.importParties(file, options),
      }}
      sampleColumns={sampleColumns()}
      sampleKey={sampleKey}
    />
  );
}

/**
 * The Export menu (CSV or Excel) and the Import button for a party list, with
 * the dialog behind Import. Renders nothing for a person with neither
 * permission, and each control only with its own flag.
 *
 * Export is a menu because the Excel file is the one to edit and upload back;
 * it was reachable only from inside the Import dialog, which a person who may
 * export but not import never sees. A second click while a file is being
 * fetched does nothing, so a double-click cannot start two exports.
 */
export function PartyImportControls({
  transport,
  canImport,
  canExport,
  onImported,
}: {
  transport: PartyImportTransport;
  canImport: boolean;
  canExport: boolean;
  /** Parties were added or changed; the list should refetch. */
  onImported: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exporting, setExporting] = useState<PartyImportFormat | null>(null);
  const transportRef = useRef(transport);
  transportRef.current = transport;
  // A ref as well as state: two clicks in one frame both see the same render.
  const busyRef = useRef(false);

  if (!canImport && !canExport) return null;

  async function download(format: PartyImportFormat): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setMenuOpen(false);
    setExporting(format);
    try {
      const { blob, fileName } = await transportRef.current.exportParties(format);
      saveBlob(blob, fileName);
    } catch (caught) {
      toast.push(apiErrorText(caught, 'partyImport.exportFailed'), { tone: 'error' });
    } finally {
      busyRef.current = false;
      setExporting(null);
    }
  }

  return (
    <>
      {canExport && (
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <Button
            variant="secondary"
            size="sm"
            icon="upload"
            busy={exporting !== null}
            disabled={exporting !== null}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((current) => !current)}
          >
            {t('partyImport.export')}
          </Button>
          <Popover
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            anchorStyle={{ right: 0, top: 'calc(100% + var(--s-4))' }}
          >
            <div className="ob-menu" role="menu">
              <button type="button" role="menuitem" className="ob-menu-item ob-body" onClick={() => void download('csv')}>
                {t('import.export.csv')}
              </button>
              <button type="button" role="menuitem" className="ob-menu-item ob-body" onClick={() => void download('xlsx')}>
                {t('import.export.xlsx')}
              </button>
            </div>
          </Popover>
        </span>
      )}
      {canImport && (
        <>
          <Button variant="secondary" size="sm" icon="download" onClick={() => setOpen(true)}>
            {t('partyImport.open')}
          </Button>
          <PartyImportModal
            open={open}
            transport={transport}
            onClose={() => setOpen(false)}
            onImported={(result) => {
              onImported();
              toast.push(t('partyImport.done', { created: result.created, updated: result.updated }));
            }}
            onError={(message) => toast.push(message, { tone: 'error' })}
          />
        </>
      )}
    </>
  );
}
