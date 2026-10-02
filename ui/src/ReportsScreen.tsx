/**
 * Reports, on both panels: one screen for all fifteen kinds, drawn from the one
 * `ReportTable` every kind answers (`shared/src/domain/reports.ts`).
 *
 * The kind is chosen in the sidebar's sub-pages (the shell lists
 * `offeredReportKinds`) or from the picker here; the controls are the period,
 * the exact dates when asked for, and — only for somebody who may ask about
 * others — whose figures. Everything else is the server's decision: who may see
 * Reports at all, whose figures a person gets, and how much of a big report the
 * screen is sent. This screen only reads `ReportOptions` to know which controls
 * to draw, so a control absent here is a courtesy and the Master's refusal is the
 * guarantee.
 *
 * Takes a `ReportsTransport`, never a panel's api client. A request is aborted
 * when the controls change under it (`AbortController`, never `AbortSignal.any`,
 * which Chromium 108 lacks), so a slow answer to an old question cannot land
 * over a new one. A refused range names the field it refused and leaves the last
 * good report on screen, labelled with its own range.
 *
 * The three typed legacy reports are not drawn from their own routes: they are
 * tables like the rest, with the colours and the cities as extra sections.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ReportColumn,
  ReportFormat,
  ReportKind,
  ReportLocale,
  ReportOptions,
  ReportPeriod,
  ReportQuery,
  ReportRow,
  ReportTable,
} from '@orderbook/shared';
import { REPORT_KINDS, REPORT_META, SUMMABLE_UNITS } from '@orderbook/shared';

import { Button } from './Button.js';
import { Card, Section } from './Card.js';
import { DataTable, type DataTableColumn } from './DataTable.js';
import { apiErrorText } from './errorText.js';
import { FormField, Input } from './Form.js';
import { locale, t } from './i18n.js';
import { rem } from './rem.js';
import { saveBlob } from './ImportDialog.js';
import { StatTile, StatTileSkeleton } from './StatTile.js';
import { EmptyState, ErrorState, SkeletonRows } from './States.js';
import { Select } from './SuggestInput.js';
import { useToast } from './Toast.js';
import { trackLoad } from './TopProgress.js';

/** What the screen needs from a panel — HTTP on both, the Master's own or the Office's proxy of it. */
export interface ReportsTransport {
  options: (signal?: AbortSignal) => Promise<ReportOptions>;
  table: (kind: ReportKind, query: ReportQuery, signal?: AbortSignal) => Promise<ReportTable>;
  exportFile: (
    kind: ReportKind,
    query: ReportQuery & { format: ReportFormat; lang?: ReportLocale },
  ) => Promise<{ blob: Blob; fileName: string }>;
}

interface ReportsScreenProps {
  transport: ReportsTransport;
  /** Which report is showing — chosen in the sidebar's sub-pages or from the picker here. */
  kind: ReportKind;
  onKindChange: (kind: ReportKind) => void;
  /** Changes whenever lead, order or party data does — a counter on the Master, a fingerprint of the snapshot on an Office. */
  revision: number | string;
}

/** A refusal carrying `field` belongs on that control; anything else is a fetch failure. */
interface Failure {
  message: string;
  field?: string;
  /** The company has switched Reports off for this person's tier. */
  hidden?: boolean;
}

const PERIODS: readonly ReportPeriod[] = [
  'thisMonth',
  'last3Months',
  'last6Months',
  'last12Months',
  'thisFinancialYear',
  'custom',
  'customDates',
];

const PERIOD_KEY = {
  thisMonth: 'reports.period.thisMonth',
  last3Months: 'reports.period.last3Months',
  last6Months: 'reports.period.last6Months',
  last12Months: 'reports.period.last12Months',
  thisFinancialYear: 'reports.period.thisFinancialYear',
  custom: 'reports.period.custom',
  customDates: 'reports.period.customDates',
} as const;

function figure(value: number, unit: ReportColumn['unit']): string {
  const text = new Intl.NumberFormat(locale() === 'hi' ? 'hi-IN' : 'en-IN', { maximumFractionDigits: 3 }).format(value);
  return unit === 'percent' ? `${text}%` : text;
}

/** One cell as a person reads it: a figure formatted, an empty value as a dash. */
function cellOf(row: ReportRow, column: ReportColumn): string {
  const value = row[column.key];
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'number' ? figure(value, column.unit) : value;
}

function columnsFor(table: { columns: readonly ReportColumn[] }): DataTableColumn<ReportRow & { key: string }>[] {
  return table.columns.map((column, index) => {
    const numeric = column.unit !== 'text' && column.unit !== 'date';
    return {
      key: column.key,
      header: t(column.labelToken),
      align: numeric ? 'right' : undefined,
      // Only the first text column grows; figures stay as wide as they need.
      width: numeric ? rem(130) : index === 0 ? undefined : rem(170),
      render: (row) => <span className={column.unit === 'date' ? 'ob-mono' : undefined}>{cellOf(row, column)}</span>,
    } satisfies DataTableColumn<ReportRow & { key: string }>;
  });
}

/** The error a refused field carries, if the thrown value is an ApiError-shaped one. */
function fieldOf(caught: unknown): string | undefined {
  const details = (caught as { details?: { field?: unknown } } | null)?.details;
  return typeof details?.field === 'string' ? details.field : undefined;
}

export function ReportsScreen({ transport, kind, onKindChange, revision }: ReportsScreenProps) {
  const toast = useToast();
  // Held in a ref so a panel that rebuilds its transport each render does not refetch.
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const [options, setOptions] = useState<ReportOptions | null>(null);
  const [period, setPeriod] = useState<ReportPeriod>('last6Months');
  const [fromMonth, setFromMonth] = useState('');
  const [toMonth, setToMonth] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [search, setSearch] = useState('');
  const [loaded, setLoaded] = useState<ReportTable | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [exporting, setExporting] = useState<ReportFormat | null>(null);

  /** What the controls currently ask for — only what applies to the chosen period. */
  const query = useMemo<ReportQuery>(
    () => ({
      period,
      fromMonth: period === 'custom' ? fromMonth || undefined : undefined,
      toMonth: period === 'custom' ? toMonth || undefined : undefined,
      fromDate: period === 'customDates' ? fromDate || undefined : undefined,
      toDate: period === 'customDates' ? toDate || undefined : undefined,
      subjectId: subjectId || undefined,
    }),
    [period, fromMonth, toMonth, fromDate, toDate, subjectId],
  );

  // The options once: who may be picked, which kinds, whether to offer a file.
  useEffect(() => {
    const controller = new AbortController();
    transportRef.current
      .options(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setOptions(next);
      })
      .catch(() => undefined); // the table's own request reports the failure
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    transportRef.current
      .table(kind, query, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setLoaded(next);
        setFailure(null);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        const field = fieldOf(caught);
        const hidden = (caught as { messageKey?: unknown } | null)?.messageKey === 'error.forbidden.reportsHidden';
        // A rejected range leaves the previous report standing — it names the
        // range it covers, so it is not a stale answer to the new question.
        if (!field) setLoaded(null);
        setFailure({ message: apiErrorText(caught, 'reports.error.load'), field, hidden });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [kind, query, revision, attempt]);

  const active = loaded && loaded.kind === kind ? loaded : null;

  const rows = useMemo(() => {
    if (!active) return [];
    const term = search.trim().toLowerCase();
    const all = active.rows.map((row, index) => ({ ...row, key: String(index) }));
    if (!term) return all;
    return all.filter((row) => active.columns.some((column) => cellOf(row, column).toLowerCase().includes(term)));
  }, [active, search]);

  const fieldFailure = (field: string): string | undefined => (failure?.field === field ? failure.message : undefined);

  async function download(format: ReportFormat): Promise<void> {
    if (exporting !== null) return;
    setExporting(format);
    try {
      const { blob, fileName } = await trackLoad(
        transportRef.current.exportFile(kind, { ...query, format, lang: locale() === 'hi' ? 'hi' : 'en' }),
      );
      saveBlob(blob, fileName);
    } catch (caught) {
      toast.push(apiErrorText(caught, 'reports.exportFailed'), { tone: 'error' });
    } finally {
      setExporting(null);
    }
  }

  const kinds = options?.kinds.length ? options.kinds : REPORT_KINDS;

  if (failure?.hidden) {
    return (
      <Card>
        <EmptyState title={t('reports.hidden.title')} description={t('reports.hidden.description')} />
      </Card>
    );
  }

  const tiles = active
    ? active.columns.filter((column) => column.unit && SUMMABLE_UNITS.includes(column.unit) && active.totals?.[column.key] !== undefined)
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-12)', flexWrap: 'wrap' }}>
        <h1 className="ob-title" style={{ margin: 0 }}>
          {t('reports.title')}
        </h1>
        <div style={{ minWidth: rem(260) }}>
          <Select
            aria-label={t('reports.title')}
            value={kind}
            onChange={(event) => onKindChange(event.target.value as ReportKind)}
          >
            {kinds.map((option) => (
              <option key={option} value={option}>
                {t(REPORT_META[option].titleToken)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--s-16)', flexWrap: 'wrap' }}>
          <div style={{ width: rem(200) }}>
            <FormField label={t('reports.range.period')}>
              {(id) => (
                <Select id={id} value={period} onChange={(event) => setPeriod(event.target.value as ReportPeriod)}>
                  {PERIODS.map((option) => (
                    <option key={option} value={option}>
                      {t(PERIOD_KEY[option])}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          </div>

          {/* Month boxes for a custom month range, day boxes for exact dates: the
              named periods are resolved against the Master's calendar, not the browser's. */}
          {period === 'custom' && (
            <>
              <div style={{ width: rem(190) }}>
                <FormField label={t('reports.range.fromMonth')} required error={fieldFailure('fromMonth')}>
                  {(id) => (
                    <Input id={id} type="month" value={fromMonth} invalid={Boolean(fieldFailure('fromMonth'))} onChange={(event) => setFromMonth(event.target.value)} />
                  )}
                </FormField>
              </div>
              <div style={{ width: rem(190) }}>
                <FormField label={t('reports.range.toMonth')} hint={t('reports.range.toMonthHint')} error={fieldFailure('toMonth')}>
                  {(id) => (
                    <Input id={id} type="month" value={toMonth} invalid={Boolean(fieldFailure('toMonth'))} onChange={(event) => setToMonth(event.target.value)} />
                  )}
                </FormField>
              </div>
            </>
          )}
          {period === 'customDates' && (
            <>
              <div style={{ width: rem(190) }}>
                <FormField label={t('reports.range.fromDate')} required error={fieldFailure('fromDate')}>
                  {(id) => (
                    <Input id={id} type="date" value={fromDate} invalid={Boolean(fieldFailure('fromDate'))} onChange={(event) => setFromDate(event.target.value)} />
                  )}
                </FormField>
              </div>
              <div style={{ width: rem(190) }}>
                <FormField label={t('reports.range.toDate')} hint={t('reports.range.toDateHint')} error={fieldFailure('toDate')}>
                  {(id) => (
                    <Input id={id} type="date" value={toDate} invalid={Boolean(fieldFailure('toDate'))} onChange={(event) => setToDate(event.target.value)} />
                  )}
                </FormField>
              </div>
            </>
          )}

          {/* Only for somebody who may ask about others. Everyone else is always
              themselves, and the server would refuse anything else. */}
          {options?.subjects && (
            <div style={{ width: rem(220) }}>
              <FormField label={t('reports.subject.label')} error={fieldFailure('subjectId')}>
                {(id) => (
                  <Select id={id} value={subjectId} onChange={(event) => setSubjectId(event.target.value)}>
                    <option value="">{t('reports.subject.everyone')}</option>
                    {options.subjects?.map((subject) => (
                      <option key={subject.id ?? ''} value={subject.id ?? ''}>
                        {subject.name}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
            </div>
          )}

          <div style={{ width: rem(220) }}>
            <FormField label={t('reports.search')}>
              {(id) => <Input id={id} value={search} data-screen-search onChange={(event) => setSearch(event.target.value)} />}
            </FormField>
          </div>

          <span style={{ flex: 1 }} />

          {/* Absent rather than disabled without the permission, and absent while
              any refusal stands — a file re-runs the query the controls currently
              describe, so a range the server has just rejected must not be
              offered as a file even though the last report is still on screen. */}
          {options?.canExport && active && !failure && (
            <div style={{ display: 'flex', gap: 'var(--s-8)', alignSelf: 'flex-end' }}>
              {(['csv', 'xlsx', 'pdf'] as const).map((format) => (
                <Button
                  key={format}
                  variant="secondary"
                  size="sm"
                  icon="download"
                  busy={exporting === format}
                  disabled={exporting !== null}
                  onClick={() => void download(format)}
                >
                  {t(`reports.export.${format}`)}
                </Button>
              ))}
            </div>
          )}
        </div>

        {active && (
          <p className="ob-small" style={{ margin: 'var(--s-8) 0 0' }}>
            {t('reports.range.caption', {
              from: active.range.months[0] ?? active.range.fromDate,
              to: active.range.months[active.range.months.length - 1] ?? '',
              zone: active.range.timeZone,
            })}
            {active.subject.name ? ` · ${t('reports.generatedFor', { name: active.subject.name })}` : ''}
          </p>
        )}
        {active && REPORT_META[kind].basis === 'snapshot' && (
          <p className="ob-small" style={{ margin: 'var(--s-4) 0 0', color: 'var(--fg-secondary)' }}>
            {t('reports.snapshotNote')}
          </p>
        )}
      </Card>

      {loading && !active ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: 'var(--s-12)' }}>
            <StatTileSkeleton />
            <StatTileSkeleton />
          </div>
          <SkeletonRows columns={5} />
        </>
      ) : failure && !failure.field && !active ? (
        <ErrorState
          title={t('reports.error.load')}
          description={failure.message}
          actionLabel={t('action.retryNow')}
          onAction={() => setAttempt((value) => value + 1)}
        />
      ) : active === null ? null : active.rows.length === 0 && active.sections.every((section) => section.rows.length === 0) ? (
        <Card>
          <EmptyState title={t('reports.empty.title')} />
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-24)' }}>
          {tiles.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: 'var(--s-12)' }}>
              {tiles.map((column) => (
                <StatTile key={column.key} label={t(column.labelToken)} value={figure(active.totals?.[column.key] ?? 0, column.unit)} />
              ))}
            </div>
          )}

          <Section title={t(REPORT_META[kind].titleToken)}>
            {active.quietAfterDays !== undefined && (
              // The threshold is the server's, not a constant this screen knows —
              // a pending order is only "quiet" relative to whatever it is set to.
              <p className="ob-small" style={{ margin: 0 }}>
                {t('reports.leadOutcomes.quietNote', { days: active.quietAfterDays })}
              </p>
            )}
            <DataTable
              columns={columnsFor(active)}
              rows={rows}
              rowKey={(row) => row.key}
              empty={<EmptyState title={t('reports.empty.title')} />}
            />
            {active.truncated && (
              <p className="ob-small" style={{ margin: 0, color: 'var(--fg-secondary)' }}>
                {t('reports.truncated', { shown: active.rows.length, total: active.rowCount })}
              </p>
            )}
          </Section>

          {active.sections
            .filter((section) => section.rows.length > 0)
            .map((section) => (
              <Section key={section.titleToken} title={t(section.titleToken)}>
                <DataTable
                  columns={columnsFor(section)}
                  rows={section.rows.map((row, index) => ({ ...row, key: String(index) }))}
                  rowKey={(row) => row.key}
                />
              </Section>
            ))}
        </div>
      )}
    </div>
  );
}
