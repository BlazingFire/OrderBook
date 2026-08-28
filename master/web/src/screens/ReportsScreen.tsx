/**
 * Reports — dispatches, lead outcomes and top parties over a month range
 * (docs/backend-modules/04-API-CONTRACT.md §3).
 *
 * The range is validated on the server and nowhere else: a custom range needs a
 * start month, the end cannot precede the start, and the span is capped. Those
 * three refusals arrive with the offending field named in `details.field`, so
 * they are rendered under that field rather than as a page banner — and the
 * last report that *did* resolve stays on screen while the operator fixes the
 * month, since it is labelled with its own range and is still true.
 *
 * Money is absent, not zero, when the caller cannot see rates (`ratesIncluded`
 * on the report says which). A column of em dashes would imply the figures
 * exist and happen to be blank, so the money columns are dropped entirely and
 * the omission is stated once.
 */

import { useEffect, useState } from 'react';
import type {
  DispatchColourBucket,
  DispatchMonthBucket,
  DispatchesReport,
  LeadOutcomeMonthBucket,
  LeadOutcomesReport,
  ReportKind,
  ReportPeriod,
  ReportRangeInput,
  TopCityRow,
  TopPartiesReport,
  TopPartyRow,
} from '@orderbook/shared';

import { api, ApiError } from '../api';
import {
  ButtonLink,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  Section,
  Select,
  SkeletonRows,
  Tabs,
  formatMoney,
  t,
  type DataTableColumn,
  type TabItem,
} from '@orderbook/ui';

interface Props {
  /** Bumped by the live socket whenever lead, order or stock data changes. */
  revision: number;
  /** The signed-in user's resolved permissions, as the shell already holds them. */
  permissions: string[];
}

/** Tagged so a report from the previous tab can never render under the new one. */
type Loaded =
  | { kind: 'dispatches'; data: DispatchesReport }
  | { kind: 'lead-outcomes'; data: LeadOutcomesReport }
  | { kind: 'top-parties'; data: TopPartiesReport };

/** A refusal carrying `field` belongs on that control; anything else is a fetch failure. */
interface Failure {
  message: string;
  field?: string;
}

const PERIODS: readonly ReportPeriod[] = [
  'thisMonth',
  'last3Months',
  'last6Months',
  'last12Months',
  'custom',
];

const PERIOD_KEY: Record<ReportPeriod, string> = {
  thisMonth: 'reports.period.thisMonth',
  last3Months: 'reports.period.last3Months',
  last6Months: 'reports.period.last6Months',
  last12Months: 'reports.period.last12Months',
  custom: 'reports.period.custom',
};

export function ReportsScreen({ revision, permissions }: Props) {
  const canView = permissions.includes('reports.view');
  const canExport = permissions.includes('reports.export');

  const [kind, setKind] = useState<ReportKind>('dispatches');
  const [period, setPeriod] = useState<ReportPeriod>('last6Months');
  const [fromMonth, setFromMonth] = useState('');
  const [toMonth, setToMonth] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attempt, setAttempt] = useState(0);

  const range: ReportRangeInput = {
    period,
    fromMonth: fromMonth || undefined,
    toMonth: toMonth || undefined,
  };

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    setLoading(true);

    const load = async (): Promise<void> => {
      const input: ReportRangeInput = {
        period,
        fromMonth: fromMonth || undefined,
        toMonth: toMonth || undefined,
      };
      try {
        const next: Loaded =
          kind === 'dispatches'
            ? { kind, data: await api.dispatchReport(input) }
            : kind === 'lead-outcomes'
              ? { kind, data: await api.leadOutcomeReport(input) }
              : { kind, data: await api.topPartiesReport(input) };
        if (cancelled) return;
        setLoaded(next);
        setFailure(null);
      } catch (caught) {
        if (cancelled) return;
        const field =
          caught instanceof ApiError && typeof caught.details.field === 'string'
            ? caught.details.field
            : undefined;
        // A rejected range leaves the previous report standing — it names the
        // range it covers, so it is not a stale answer to the new question.
        if (!field) setLoaded(null);
        setFailure({
          message: caught instanceof Error ? caught.message : t('reports.error.load'),
          field,
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [canView, kind, period, fromMonth, toMonth, revision, attempt]);

  if (!canView) {
    return (
      <Card>
        <EmptyState
          title={t('reports.noPermission.title')}
          description={t('reports.noPermission.description', { permission: 'reports.view' })}
        />
      </Card>
    );
  }

  const tabItems: TabItem[] = [
    { id: 'dispatches', label: t('reports.tab.dispatches') },
    { id: 'lead-outcomes', label: t('reports.tab.leadOutcomes') },
    { id: 'top-parties', label: t('reports.tab.topParties') },
  ];

  const fieldFailure = (field: string): string | undefined =>
    failure?.field === field ? failure.message : undefined;

  const active = loaded && loaded.kind === kind ? loaded : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 className="ob-title" style={{ margin: 0 }}>
          {t('reports.title')}
        </h1>
        <Tabs tabs={tabItems} activeId={kind} onChange={(id) => setKind(id as ReportKind)} />
      </div>

      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--s-16)' }}>
          <div style={{ width: '200px' }}>
            <FormField label={t('reports.range.period')}>
              {(id) => (
                <Select
                  id={id}
                  value={period}
                  onChange={(event) => setPeriod(event.target.value as ReportPeriod)}
                >
                  {PERIODS.map((option) => (
                    <option key={option} value={option}>
                      {t(PERIOD_KEY[option])}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          </div>

          {/* Both month boxes exist only for a custom range — the named periods
              are resolved against the Master's own calendar, not the browser's. */}
          {period === 'custom' && (
            <>
              <div style={{ width: '190px' }}>
                <FormField
                  label={t('reports.range.fromMonth')}
                  required
                  error={fieldFailure('fromMonth')}
                >
                  {(id) => (
                    <Input
                      id={id}
                      type="month"
                      value={fromMonth}
                      invalid={Boolean(fieldFailure('fromMonth'))}
                      onChange={(event) => setFromMonth(event.target.value)}
                    />
                  )}
                </FormField>
              </div>
              <div style={{ width: '190px' }}>
                <FormField
                  label={t('reports.range.toMonth')}
                  hint={t('reports.range.toMonthHint')}
                  error={fieldFailure('toMonth')}
                >
                  {(id) => (
                    <Input
                      id={id}
                      type="month"
                      value={toMonth}
                      invalid={Boolean(fieldFailure('toMonth'))}
                      onChange={(event) => setToMonth(event.target.value)}
                    />
                  )}
                </FormField>
              </div>
            </>
          )}

          <span style={{ flex: 1 }} />

          {/* Absent rather than disabled without the permission, and absent
              while any refusal stands — the download re-runs the query the
              controls currently describe, so a range the server has just
              rejected must not be offered as a file even though the previous
              report is still on screen. */}
          {canExport && active && !failure && (
            <ButtonLink href={api.reportExportUrl(kind, range)} variant="secondary" size="sm">
              {t('reports.export')}
            </ButtonLink>
          )}
        </div>

        {active && (
          <p className="ob-small" style={{ margin: 'var(--s-8) 0 0' }}>
            {t('reports.range.caption', {
              from: active.data.range.months[0] ?? active.data.range.fromDate,
              to: active.data.range.months[active.data.range.months.length - 1] ?? '',
              zone: active.data.range.timeZone,
            })}
          </p>
        )}
      </Card>

      {loading && !active ? (
        <SkeletonRows columns={5} />
      ) : failure && !failure.field && !active ? (
        <ErrorState
          title={t('reports.error.load')}
          description={failure.message}
          actionLabel={t('action.retryNow')}
          onAction={() => setAttempt((value) => value + 1)}
        />
      ) : active === null ? null : active.kind === 'dispatches' ? (
        <DispatchesView report={active.data} />
      ) : active.kind === 'lead-outcomes' ? (
        <LeadOutcomesView report={active.data} />
      ) : (
        <TopPartiesView report={active.data} />
      )}
    </div>
  );
}

/** Every report's "nothing happened in this range" — a fact, not a failure. */
function NoActivity({ description }: { description: string }) {
  return (
    <Card>
      <EmptyState title={t('reports.empty.title')} description={description} />
    </Card>
  );
}

function RatesHiddenNote() {
  return (
    <p className="ob-small" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
      {t('reports.ratesHidden', { permission: 'field.saleRate.view' })}
    </p>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <div className="ob-eyebrow">{label}</div>
      <div
        className="ob-display"
        style={{ marginTop: 'var(--s-6)', fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </div>
    </Card>
  );
}

function DispatchesView({ report }: { report: DispatchesReport }) {
  // The month list is zero-filled by the server, so its length says nothing
  // about whether anything was dispatched — the totals do.
  if (report.totals.orderCount === 0 && report.totals.boxCount === 0) {
    return <NoActivity description={t('reports.dispatches.empty.description')} />;
  }

  const monthColumns: DataTableColumn<DispatchMonthBucket>[] = [
    { key: 'month', header: t('reports.column.month'), width: '140px', render: (row) => row.month },
    // Only the month is pinned: DataTable turns a column with no width into a
    // `1fr` track, and a table whose every track is fixed leaves the rest of
    // the row as dead space when the money column is dropped.
    {
      key: 'orders',
      header: t('reports.column.orders'),
      align: 'right',
      render: (row) => row.orderCount,
    },
    {
      key: 'boxes',
      header: t('reports.column.boxes'),
      align: 'right',
      render: (row) => row.boxCount,
    },
    ...(report.ratesIncluded
      ? [
          {
            key: 'value',
            header: t('reports.column.value'),
            align: 'right' as const,
            render: (row: DispatchMonthBucket) => formatMoney(row.totalValue ?? null),
          },
        ]
      : []),
  ];

  const colourColumns: DataTableColumn<DispatchColourBucket>[] = [
    { key: 'colour', header: t('reports.column.colour'), render: (row) => row.colour },
    {
      key: 'boxes',
      header: t('reports.column.boxes'),
      width: '120px',
      align: 'right',
      render: (row) => row.boxCount,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-24)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--s-12)' }}>
        <StatCard label={t('reports.stat.orders')} value={report.totals.orderCount} />
        <StatCard label={t('reports.stat.boxes')} value={report.totals.boxCount} />
        {report.ratesIncluded && (
          <StatCard
            label={t('reports.stat.value')}
            value={formatMoney(report.totals.totalValue ?? null)}
          />
        )}
      </div>

      {!report.ratesIncluded && <RatesHiddenNote />}

      <Section title={t('reports.dispatches.byMonth')}>
        <DataTable
          columns={monthColumns}
          rows={report.months}
          rowKey={(row) => row.month}
          empty={<EmptyState title={t('reports.empty.title')} />}
        />
      </Section>

      <Section title={t('reports.dispatches.byColour')}>
        <DataTable
          columns={colourColumns}
          rows={report.colours}
          rowKey={(row) => row.colour}
          empty={
            <EmptyState
              title={t('reports.dispatches.colours.empty.title')}
              description={t('reports.dispatches.colours.empty.description')}
            />
          }
        />
      </Section>
    </div>
  );
}

function LeadOutcomesView({ report }: { report: LeadOutcomesReport }) {
  const { converted, lost, quiet, open } = report.totals;
  if (converted + lost + quiet + open === 0) {
    return <NoActivity description={t('reports.leadOutcomes.empty.description')} />;
  }

  const columns: DataTableColumn<LeadOutcomeMonthBucket>[] = [
    { key: 'month', header: t('reports.column.month'), width: '140px', render: (row) => row.month },
    {
      key: 'converted',
      header: t('reports.column.converted'),
      align: 'right',
      render: (row) => row.converted,
    },
    { key: 'lost', header: t('reports.column.lost'), align: 'right', render: (row) => row.lost },
    { key: 'quiet', header: t('reports.column.quiet'), align: 'right', render: (row) => row.quiet },
    { key: 'open', header: t('reports.column.open'), align: 'right', render: (row) => row.open },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-24)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--s-12)' }}>
        <StatCard label={t('reports.column.converted')} value={converted} />
        <StatCard label={t('reports.column.lost')} value={lost} />
        <StatCard label={t('reports.column.quiet')} value={quiet} />
        <StatCard label={t('reports.column.open')} value={open} />
      </div>

      <Section title={t('reports.leadOutcomes.byMonth')}>
        {/* The threshold is the server's, not a constant this screen knows —
            a lead is only "quiet" relative to whatever it is currently set to. */}
        <p className="ob-small" style={{ margin: 0 }}>
          {t('reports.leadOutcomes.quietNote', { days: report.quietAfterDays })}
        </p>
        <DataTable
          columns={columns}
          rows={report.months}
          rowKey={(row) => row.month}
          empty={<EmptyState title={t('reports.empty.title')} />}
        />
      </Section>
    </div>
  );
}

function TopPartiesView({ report }: { report: TopPartiesReport }) {
  if (report.parties.length === 0) {
    return <NoActivity description={t('reports.topParties.empty.description')} />;
  }

  const partyColumns: DataTableColumn<TopPartyRow>[] = [
    { key: 'party', header: t('reports.column.party'), render: (row) => row.partyName },
    {
      key: 'code',
      header: t('reports.column.code'),
      width: '120px',
      render: (row) => <span className="ob-mono">{row.partyCode ?? '—'}</span>,
    },
    {
      key: 'city',
      header: t('reports.column.city'),
      width: '180px',
      render: (row) => row.city ?? '—',
    },
    {
      key: 'orders',
      header: t('reports.column.orders'),
      width: '120px',
      align: 'right',
      render: (row) => row.orderCount,
    },
    ...(report.ratesIncluded
      ? [
          {
            key: 'value',
            header: t('reports.column.value'),
            width: '160px',
            align: 'right' as const,
            render: (row: TopPartyRow) => formatMoney(row.totalValue ?? null),
          },
        ]
      : []),
  ];

  const cityColumns: DataTableColumn<TopCityRow>[] = [
    { key: 'city', header: t('reports.column.city'), render: (row) => row.city ?? '—' },
    {
      key: 'parties',
      header: t('reports.column.parties'),
      width: '120px',
      align: 'right',
      render: (row) => row.partyCount,
    },
    {
      key: 'orders',
      header: t('reports.column.orders'),
      width: '120px',
      align: 'right',
      render: (row) => row.orderCount,
    },
    ...(report.ratesIncluded
      ? [
          {
            key: 'value',
            header: t('reports.column.value'),
            width: '160px',
            align: 'right' as const,
            render: (row: TopCityRow) => formatMoney(row.totalValue ?? null),
          },
        ]
      : []),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-24)' }}>
      {!report.ratesIncluded && <RatesHiddenNote />}

      <Section title={t('reports.topParties.parties')}>
        {/* Which ranking this is depends on the caller: a rate-blind role gets
            the same parties ordered by order count, so saying "top 10" without
            saying by what would be the wrong claim for half the roles. */}
        <p className="ob-small" style={{ margin: 0 }}>
          {report.orderedBy === 'value'
            ? t('reports.topParties.orderedByValue', { limit: report.limit })
            : t('reports.topParties.orderedByCount', { limit: report.limit })}
        </p>
        <DataTable
          columns={partyColumns}
          rows={report.parties}
          rowKey={(row) => row.partyId}
          empty={<EmptyState title={t('reports.empty.title')} />}
        />
      </Section>

      <Section title={t('reports.topParties.cities')}>
        <DataTable
          columns={cityColumns}
          rows={report.cities}
          rowKey={(row) => row.city ?? '—'}
          empty={
            <EmptyState
              title={t('reports.topParties.cities.empty.title')}
              description={t('reports.topParties.cities.empty.description')}
            />
          }
        />
      </Section>
    </div>
  );
}
