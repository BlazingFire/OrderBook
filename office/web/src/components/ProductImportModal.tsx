/**
 * Import products from a spreadsheet, without leaving the Catalog screen.
 *
 * Three steps in one dialog: pick a file (and, first, a blank template to
 * fill in), look at what the file would do, then do it. The look-first step is
 * not decoration — it is the same import run as a dry run on the Master, so
 * the counts and the row-numbered problems a person approves are the ones the
 * real run then produces. A row that the Master refuses is named by its row
 * number here, where the file is, rather than in a sync log nobody reads.
 *
 * **Online-only, and honest about it.** The file goes to the Master over the
 * panel's HTTP surface (the route product photos use) and never through the
 * offline outbox; with the Master off the dialog says so instead of queueing
 * five thousand writes it cannot report on.
 *
 * Templates are fetched and saved as blobs rather than linked: the panel
 * answers a JSON 503 when the Master is off, and a plain `<a href>` would
 * navigate the whole window onto it.
 */

import { useRef, useState } from 'react';
import type {
  ProductImportFormat,
  ProductImportIssue,
  ProductImportMode,
  ProductImportResult,
} from '@orderbook/shared';
import { MAX_PRODUCT_IMPORT_BYTES, MAX_PRODUCT_IMPORT_ISSUES } from '@orderbook/shared';

import { ApiError, api } from '../api';
import {
  BusyMark,
  Button,
  DataTable,
  Modal,
  Segmented,
  StatusPill,
  formatMoney,
  rem,
  t,
  type DataTableColumn,
} from '@orderbook/ui';

type Step = 'pick' | 'preview' | 'done';

const MAX_MB = Math.round(MAX_PRODUCT_IMPORT_BYTES / (1024 * 1024));

interface ProductImportModalProps {
  open: boolean;
  onClose: () => void;
  /** Something was written; the catalogue should refetch. */
  onImported: (result: ProductImportResult) => void;
  onError: (message: string) => void;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** What went wrong, in the reader's language, from what the Master sent. */
function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'unavailable') return t('import.offline');
    if (error.messageKey) return t(error.messageKey, error.params as never);
    return error.message;
  }
  return t('import.failed');
}

export function ProductImportModal({ open, onClose, onImported, onError }: ProductImportModalProps) {
  const [step, setStep] = useState<Step>('pick');
  const [mode, setMode] = useState<ProductImportMode>('create');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ProductImportResult | null>(null);
  const [busy, setBusy] = useState<'template' | 'checking' | 'importing' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset(): void {
    setStep('pick');
    setFile(null);
    setResult(null);
    setFailure(null);
    setBusy(null);
  }

  function close(): void {
    reset();
    onClose();
  }

  async function downloadTemplate(format: ProductImportFormat): Promise<void> {
    setBusy('template');
    setFailure(null);
    try {
      const { blob, fileName } = await api.productImportTemplate(format);
      saveBlob(blob, fileName);
    } catch (caught) {
      onError(caught instanceof ApiError && caught.code === 'unavailable' ? t('import.offline') : t('import.templateFailed'));
    } finally {
      setBusy(null);
    }
  }

  /** Validate locally, then ask the Master what the file would do. */
  async function accept(chosen: File): Promise<void> {
    if (chosen.size > MAX_PRODUCT_IMPORT_BYTES) {
      setFailure(t('import.fileTooLarge', { maxMb: MAX_MB }));
      return;
    }

    setFile(chosen);
    setFailure(null);
    setBusy('checking');
    try {
      setResult(await api.importProducts(chosen, { dryRun: true, mode }));
      setStep('preview');
    } catch (caught) {
      setFailure(describe(caught));
    } finally {
      setBusy(null);
    }
  }

  async function runImport(): Promise<void> {
    if (!file) return;
    setBusy('importing');
    setFailure(null);
    try {
      const outcome = await api.importProducts(file, { dryRun: false, mode });
      setResult(outcome);
      setStep('done');
      if (outcome.created + outcome.updated > 0) onImported(outcome);
    } catch (caught) {
      setFailure(describe(caught));
    } finally {
      setBusy(null);
    }
  }

  function onFilePicked(event: React.ChangeEvent<HTMLInputElement>): void {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (chosen) void accept(chosen);
  }

  function onDrop(event: React.DragEvent): void {
    event.preventDefault();
    setDropping(false);
    const chosen = event.dataTransfer.files[0];
    if (chosen) void accept(chosen);
  }

  const issueColumns: DataTableColumn<ProductImportIssue & { key: string }>[] = [
    {
      key: 'row',
      header: t('import.column.row'),
      width: rem(64),
      align: 'right',
      render: (issue) => <span className="ob-mono">{issue.row}</span>,
    },
    {
      key: 'column',
      header: t('import.column.column'),
      width: rem(140),
      render: (issue) => issue.column ?? '—',
    },
    {
      key: 'problem',
      header: t('import.column.problem'),
      render: (issue) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-8)', minWidth: 0 }}>
          <StatusPill tone={issue.kind === 'skipped' ? 'default' : 'conflict'}>
            {issue.kind === 'skipped' ? t('import.kind.skipped') : t('import.kind.error')}
          </StatusPill>
          <span>{t(issue.messageKey, issue.params as never)}</span>
        </span>
      ),
    },
  ];

  const issueRows = (result?.issues ?? []).map((issue, index) => ({
    ...issue,
    key: `${issue.row}:${issue.column ?? ''}:${issue.messageKey}:${index}`,
  }));

  const summary = result
    ? t('import.preview.summary', {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        failed: result.failed,
      })
    : '';

  const issuesTable = result && result.issues.length > 0 && (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
      <h3 className="ob-body-strong" style={{ margin: 0 }}>
        {t('import.preview.issues')}
      </h3>
      {result.issuesTruncated && (
        <p className="ob-small" style={{ margin: 0, color: 'var(--fg-secondary)' }}>
          {t('import.preview.issuesTruncated', { count: MAX_PRODUCT_IMPORT_ISSUES })}
        </p>
      )}
      <div style={{ maxHeight: rem(320), overflow: 'auto' }}>
        <DataTable columns={issueColumns} rows={issueRows} rowKey={(issue) => issue.key} />
      </div>
    </section>
  );

  const footer =
    step === 'pick' ? (
      <Button variant="secondary" onClick={close} disabled={busy !== null}>
        {t('common.cancel')}
      </Button>
    ) : step === 'preview' ? (
      <>
        <Button variant="secondary" onClick={reset} disabled={busy !== null}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          icon="upload"
          busy={busy === 'importing'}
          disabled={!result || result.created + result.updated === 0}
          onClick={() => void runImport()}
        >
          {t('import.confirm', { count: (result?.created ?? 0) + (result?.updated ?? 0) })}
        </Button>
      </>
    ) : (
      <>
        <Button variant="secondary" onClick={reset}>
          {t('import.another')}
        </Button>
        <Button variant="primary" onClick={close}>
          {t('common.close')}
        </Button>
      </>
    );

  return (
    <Modal open={open} onClose={close} size="lg" title={t('import.title')} footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
        {step === 'pick' && (
          <>
            <p className="ob-small" style={{ margin: 0, color: 'var(--fg-secondary)' }}>
              {t('import.template.hint')}
            </p>
            <div style={{ display: 'flex', gap: 'var(--s-8)', flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                icon="download"
                busy={busy === 'template'}
                onClick={() => void downloadTemplate('xlsx')}
              >
                {t('import.template.xlsx')}
              </Button>
              <Button
                variant="secondary"
                icon="download"
                busy={busy === 'template'}
                onClick={() => void downloadTemplate('csv')}
              >
                {t('import.template.csv')}
              </Button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)', flexWrap: 'wrap' }}>
              <span className="ob-small">{t('import.mode.label')}</span>
              <Segmented<ProductImportMode>
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'create', label: t('import.mode.create') },
                  { value: 'upsert', label: t('import.mode.upsert') },
                ]}
              />
            </div>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy !== null}
              onDragOver={(event) => {
                event.preventDefault();
                setDropping(true);
              }}
              onDragLeave={() => setDropping(false)}
              onDrop={onDrop}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 'var(--s-8)',
                minHeight: rem(140),
                padding: 'var(--s-20)',
                border: `2px dashed ${dropping ? 'var(--accent)' : 'var(--line)'}`,
                borderRadius: 'var(--r-md)',
                background: dropping ? 'var(--bg-sunken, transparent)' : 'none',
                color: 'var(--fg-secondary)',
                cursor: busy ? 'progress' : 'pointer',
              }}
            >
              {busy === 'checking' ? (
                <>
                  <BusyMark size={24} label="" />
                  <span>{t('import.checking')}</span>
                </>
              ) : (
                <>
                  <span className="ob-body-strong" style={{ color: 'var(--fg-primary)' }}>
                    {t('import.chooseFile')}
                  </span>
                  <span className="ob-small">{t('import.dropHint')}</span>
                </>
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              hidden
              onChange={onFilePicked}
            />
          </>
        )}

        {step === 'preview' && result && (
          <>
            <p className="ob-body-strong" style={{ margin: 0 }}>
              {summary}
            </p>
            {result.ignoredColumns.length > 0 && (
              <p className="ob-small" style={{ margin: 0, color: 'var(--fg-secondary)' }}>
                {t('import.preview.ignored', { columns: result.ignoredColumns.join(', ') })}
              </p>
            )}
            {result.created + result.updated === 0 && (
              <p className="ob-small" style={{ margin: 0, color: 'var(--fg-secondary)' }}>
                {t('import.preview.nothing')}
              </p>
            )}
            {result.sample.length > 0 && (
              <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
                <h3 className="ob-body-strong" style={{ margin: 0 }}>
                  {t('import.preview.sample')}
                </h3>
                <DataTable
                  columns={[
                    {
                      key: 'category',
                      header: t('catalog.products.column.category'),
                      width: rem(130),
                      render: (row) => row.categoryName ?? '—',
                    },
                    {
                      key: 'name',
                      header: t('catalog.products.column.name'),
                      render: (row) => row.name,
                    },
                    {
                      key: 'codes',
                      header: t('catalog.products.column.codes'),
                      width: rem(140),
                      render: (row) => (
                        <span className="ob-mono">
                          {(row.variants ?? []).map((variant) => variant.code).join(', ')}
                        </span>
                      ),
                    },
                    {
                      key: 'rate',
                      header: t('catalog.products.column.rate'),
                      width: rem(100),
                      align: 'right',
                      render: (row) => formatMoney(row.rate ?? null),
                    },
                  ]}
                  rows={result.sample}
                  rowKey={(row) => `${row.categoryName ?? ''}:${row.name}`}
                />
              </section>
            )}
            {issuesTable}
            {busy === 'importing' && (
              <p className="ob-small" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
                <BusyMark size={16} label="" />
                {t('import.running')}
              </p>
            )}
          </>
        )}

        {step === 'done' && result && (
          <>
            <p className="ob-body-strong" style={{ margin: 0 }}>
              {result.skipped + result.failed === 0
                ? t('import.done', { created: result.created, updated: result.updated })
                : t('import.done.partial', {
                    created: result.created,
                    updated: result.updated,
                    skipped: result.skipped,
                    failed: result.failed,
                  })}
            </p>
            {issuesTable}
          </>
        )}

        {failure && (
          <p className="ob-small" role="alert" style={{ margin: 0, color: 'var(--danger, #b42318)' }}>
            {failure}
          </p>
        )}
      </div>
    </Modal>
  );
}
