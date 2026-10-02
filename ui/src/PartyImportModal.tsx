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
import type { PartyImportFormat, PartyImportMode, PartyImportResult, PartyInput } from '@orderbook/shared';
import { MAX_PARTY_IMPORT_BYTES, MAX_PARTY_IMPORT_ISSUES } from '@orderbook/shared';

import { Button } from './Button.js';
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

const sampleColumns = (): DataTableColumn<PartyInput>[] => [
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

// An update row may carry any subset of the fields, so every filled one is the key.
const sampleKey = (row: PartyInput): string =>
  [row.name, row.city, row.phone, row.pincode, row.gstNumber, row.email].map((cell) => cell ?? '').join(':');

export function PartyImportModal({ open, transport, onClose, onImported, onError }: PartyImportModalProps) {
  return (
    <ImportDialog<PartyImportMode, PartyInput, PartyImportResult>
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
 * The Export CSV and Import buttons for a party list, and the dialog behind
 * Import. Renders nothing for a person with neither permission.
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
  const transportRef = useRef(transport);
  transportRef.current = transport;

  if (!canImport && !canExport) return null;

  return (
    <>
      {canExport && (
        <Button
          variant="secondary"
          size="sm"
          icon="download"
          onClick={() =>
            void transportRef.current
              .exportParties('csv')
              .then(({ blob, fileName }) => saveBlob(blob, fileName))
              .catch((caught) => toast.push(apiErrorText(caught, 'partyImport.exportFailed'), { tone: 'error' }))
          }
        >
          {t('catalog.export')}
        </Button>
      )}
      {canImport && (
        <>
          <Button variant="secondary" size="sm" icon="upload" onClick={() => setOpen(true)}>
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
