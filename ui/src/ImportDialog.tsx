/**
 * The spreadsheet-import dialog both bulk imports share — products
 * (`ProductImportModal`) and parties (`PartyImportModal`).
 *
 * Three steps in one dialog: pick a file (and, first, a blank template to fill
 * in), look at what the file would do, then do it. The look-first step is not
 * decoration — it is the same import run as a dry run on the Master, so the
 * counts and the row-numbered problems a person approves are the ones the real
 * run then produces. A row that the Master refuses is named by its row number
 * here, where the file is, rather than in a sync log nobody reads.
 *
 * **Online-only, and honest about it.** The file goes to the Master over the
 * panel's HTTP surface and never through the offline outbox; with the Master
 * off the dialog says so instead of queueing five thousand writes it cannot
 * report on.
 *
 * Templates are fetched and saved as blobs rather than linked: the panel
 * answers a JSON 503 when the Master is off, and a plain `<a href>` would
 * navigate the whole window onto it.
 *
 * What differs between the two imports is handed in: the words (`labels`), the
 * modes, the three calls (`actions`) and how a sample row reads
 * (`sampleColumns`). Everything else — the steps, the issue table, the problem
 * list download, the busy states — is here once.
 */

import { useRef, useState, type ReactNode } from 'react';
import type { MessageKey, MessageParams } from '@orderbook/shared';

import { BusyMark } from './BusyMark.js';
import { Button } from './Button.js';
import { StatusPill } from './DataDisplay.js';
import { DataTable, type DataTableColumn } from './DataTable.js';
import { apiErrorText } from './errorText.js';
import { t } from './i18n.js';
import { Modal } from './Modal.js';
import { rem } from './rem.js';
import { Segmented } from './Tabs.js';

type Step = 'pick' | 'preview' | 'done';

export type ImportFormat = 'csv' | 'xlsx';

/** The row-numbered report both imports answer with (`ProductImportResult`, `PartyImportResult`). */
export interface ImportReport<Sample> {
  created: number;
  updated: number;
  unchanged?: number;
  skipped: number;
  failed: number;
  issues: Array<{
    row: number;
    kind: 'error' | 'skipped';
    column?: string;
    messageKey: MessageKey;
    params?: MessageParams;
  }>;
  issuesTruncated: boolean;
  ignoredColumns: string[];
  sample: Sample[];
}

type Issue<Sample> = ImportReport<Sample>['issues'][number];

export interface ImportDialogProps<Mode extends string, Sample, Report extends ImportReport<Sample>> {
  open: boolean;
  onClose: () => void;
  /** Something was written; the screen should refetch. */
  onImported: (result: Report) => void;
  onError: (message: string) => void;

  /** Refused here, before the Master is asked. */
  maxBytes: number;
  /** Shown in "only the first N problems are listed". */
  maxIssues: number;

  /** The mode picker's choices; the first is the starting mode. */
  modes: ReadonlyArray<{ value: Mode; label: string }>;
  labels: {
    title: string;
    templateHint: string;
    exportHint: string;
    modeLabel: string;
    /** The confirm button: "Import 12 products". */
    confirm: (count: number) => string;
    /** The done line when every row went through. */
    done: (result: Report) => string;
    /** The done line when some rows were left out. */
    donePartial: (result: Report) => string;
    /** "N already match … and need no change." */
    unchanged: (count: number) => string;
    /** The toast when an export fails; the template's own failure line is generic. */
    exportFailed?: MessageKey;
  };
  actions: {
    template: (format: ImportFormat) => Promise<{ blob: Blob; fileName: string }>;
    export: (format: ImportFormat) => Promise<{ blob: Blob; fileName: string }>;
    run: (file: File, options: { dryRun: boolean; mode: Mode }) => Promise<Report>;
  };
  /** How a sample row reads in the preview; the dialog adds the table around it. */
  sampleColumns: DataTableColumn<Sample>[];
  sampleKey: (row: Sample) => string;
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The row-numbered problems as a CSV (BOM so Excel reads accented text), for fixing the file. */
function issuesCsv<Sample>(issues: Array<Issue<Sample>>): Blob {
  // A cell that begins with `=` `+` `-` `@` (or a TAB or CR in front of one) is a formula to
  // Excel. The text of a problem can echo a header the person typed, so it is guarded.
  const cell = (value: string | number): string => {
    const text = String(value);
    return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
  };
  const line = (cells: Array<string | number>): string => cells.map(cell).join(',');
  const rows = issues.map((issue) =>
    line([
      issue.row,
      issue.column ?? '',
      `${issue.kind === 'skipped' ? t('import.kind.skipped') : t('import.kind.error')}: ${t(issue.messageKey, issue.params as never)}`,
    ]),
  );
  const header = line([t('import.column.row'), t('import.column.column'), t('import.column.problem')]);
  // The BOM lets Excel read non-Latin text as UTF-8.
  return new Blob(['\uFEFF' + [header, ...rows].join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

export function ImportDialog<Mode extends string, Sample, Report extends ImportReport<Sample>>({
  open,
  onClose,
  onImported,
  onError,
  maxBytes,
  maxIssues,
  modes,
  labels,
  actions,
  sampleColumns,
  sampleKey,
}: ImportDialogProps<Mode, Sample, Report>) {
  const maxMb = Math.round(maxBytes / (1024 * 1024));
  // Held in refs so a screen that rebuilds its transport on every render does
  // not change what a half-finished import calls.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const [step, setStep] = useState<Step>('pick');
  const [mode, setMode] = useState<Mode>(modes[0]!.value);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Report | null>(null);
  const [busy, setBusy] = useState<'template' | 'export' | 'checking' | 'importing' | null>(null);
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

  async function download(
    kind: 'template' | 'export',
    format: ImportFormat,
  ): Promise<void> {
    if (busy !== null) return;
    setBusy(kind);
    setFailure(null);
    try {
      const { blob, fileName } = await actionsRef.current[kind](format);
      saveBlob(blob, fileName);
    } catch (caught) {
      onError(
        apiErrorText(caught, kind === 'template' ? 'import.templateFailed' : (labels.exportFailed ?? 'import.exportFailed')),
      );
    } finally {
      setBusy(null);
    }
  }

  /** Validate locally, then ask the Master what the file would do. */
  async function accept(chosen: File): Promise<void> {
    if (busy !== null) return;
    if (!/\.(csv|xlsx)$/i.test(chosen.name)) {
      setFailure(t('validation.import.unsupportedFormat'));
      return;
    }
    if (chosen.size === 0) {
      setFailure(t('validation.import.emptyFile'));
      return;
    }
    if (chosen.size > maxBytes) {
      setFailure(t('import.fileTooLarge', { maxMb }));
      return;
    }

    setFile(chosen);
    setFailure(null);
    setBusy('checking');
    try {
      setResult(await actionsRef.current.run(chosen, { dryRun: true, mode }));
      setStep('preview');
    } catch (caught) {
      setFailure(apiErrorText(caught, 'import.failed'));
    } finally {
      setBusy(null);
    }
  }

  async function runImport(): Promise<void> {
    if (!file || busy !== null) return;
    setBusy('importing');
    setFailure(null);
    try {
      const outcome = await actionsRef.current.run(file, { dryRun: false, mode });
      setResult(outcome);
      setStep('done');
      if (outcome.created + outcome.updated > 0) onImported(outcome);
    } catch (caught) {
      setFailure(apiErrorText(caught, 'import.failed'));
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

  const issueColumns: DataTableColumn<Issue<Sample> & { key: string }>[] = [
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
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-8)', minWidth: 0 }}
        >
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
      <div>
        <Button
          variant="secondary"
          size="sm"
          icon="download"
          onClick={() => saveBlob(issuesCsv(result.issues), t('import.report.fileName'))}
        >
          {t('import.report.download')}
        </Button>
      </div>
      {result.issuesTruncated && (
        <p className="ob-small" style={{ margin: 0, color: 'var(--fg-secondary)' }}>
          {t('import.preview.issuesTruncated', { count: maxIssues })}
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
          icon="download"
          autoFocus
          busy={busy === 'importing'}
          disabled={!result || result.created + result.updated === 0}
          onClick={() => void runImport()}
        >
          {labels.confirm((result?.created ?? 0) + (result?.updated ?? 0))}
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

  const note = (text: ReactNode): ReactNode => (
    <p className="ob-small" style={{ margin: 0, color: 'var(--fg-secondary)' }}>
      {text}
    </p>
  );

  return (
    <Modal open={open} onClose={busy === 'importing' ? () => undefined : close} size="lg" title={labels.title} footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
        {step === 'pick' && (
          <>
            {note(labels.templateHint)}
            <div style={{ display: 'flex', gap: 'var(--s-8)', flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                icon="download"
                busy={busy === 'template'}
                disabled={busy !== null}
                onClick={() => void download('template', 'xlsx')}
              >
                {t('import.template.xlsx')}
              </Button>
              <Button
                variant="secondary"
                icon="download"
                busy={busy === 'template'}
                disabled={busy !== null}
                onClick={() => void download('template', 'csv')}
              >
                {t('import.template.csv')}
              </Button>
            </div>
            {note(labels.exportHint)}
            <div style={{ display: 'flex', gap: 'var(--s-8)', flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                icon="download"
                busy={busy === 'export'}
                disabled={busy !== null}
                onClick={() => void download('export', 'xlsx')}
              >
                {t('import.export.xlsx')}
              </Button>
              <Button
                variant="secondary"
                icon="download"
                busy={busy === 'export'}
                disabled={busy !== null}
                onClick={() => void download('export', 'csv')}
              >
                {t('import.export.csv')}
              </Button>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--s-12)',
                flexWrap: 'wrap',
              }}
            >
              <span className="ob-small">{labels.modeLabel}</span>
              <Segmented<Mode> value={mode} onChange={setMode} options={[...modes]} />
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
            {result.ignoredColumns.length > 0 &&
              note(t('import.preview.ignored', { columns: result.ignoredColumns.join(', ') }))}
            {result.created + result.updated > 0 &&
              result.skipped + result.failed > 0 &&
              note(t('import.preview.partial', { count: result.skipped + result.failed }))}
            {(result.unchanged ?? 0) > 0 && note(labels.unchanged(result.unchanged ?? 0))}
            {result.created + result.updated === 0 &&
              (result.unchanged ?? 0) === 0 &&
              note(t('import.preview.nothing'))}
            {result.sample.length > 0 && (
              <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
                <h3 className="ob-body-strong" style={{ margin: 0 }}>
                  {t('import.preview.sample')}
                </h3>
                <DataTable columns={sampleColumns} rows={result.sample} rowKey={sampleKey} />
              </section>
            )}
            {issuesTable}
            {busy === 'importing' && (
              <p
                className="ob-small"
                style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}
              >
                <BusyMark size={16} label="" />
                {t('import.running')}
              </p>
            )}
          </>
        )}

        {step === 'done' && result && (
          <>
            <p className="ob-body-strong" style={{ margin: 0 }}>
              {result.skipped + result.failed === 0 ? labels.done(result) : labels.donePartial(result)}
            </p>
            {(result.unchanged ?? 0) > 0 && note(labels.unchanged(result.unchanged ?? 0))}
            {issuesTable}
          </>
        )}

        {failure && (
          <p
            className="ob-small"
            role="alert"
            style={{ margin: 0, color: 'var(--danger, #b42318)' }}
          >
            {failure}
          </p>
        )}
      </div>
    </Modal>
  );
}
