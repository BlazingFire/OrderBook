/**
 * Smart review table for a product import file.
 *
 * Each row shows file values, then existing values, then the auto decision and
 * the reason. The auto choice is file wins if valid: a valid new row creates,
 * a valid change updates, a code taken by another product or a blank code
 * skips, and nothing ever auto deletes or merges. Every row carries its own
 * Create, Update and Skip choice, and the bulk bar sets one decision per
 * conflict kind: all code clashes to Skip, all new to Create, all valid
 * updates to Update. There is no whole file accept: the apply always runs on
 * the reviewed per row selection.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ProductImportRowDecision, ProductImportRowPreview } from '@orderbook/shared';

import { Button } from './Button.js';
import { DataTable, type DataTableColumn } from './DataTable.js';
import { StatusPill } from './DataDisplay.js';
import { t } from './i18n.js';
import { rem } from './rem.js';
import { Segmented } from './Tabs.js';

export type { ProductImportRowDecision };

interface ProductSmartReviewProps {
  rows: ProductImportRowPreview[];
  truncated: boolean;
  canUpdate: boolean;
  onApply: (selectedRows: number[], mode: 'create' | 'upsert') => void;
  applying: boolean;
}

const KIND_TONE: Record<string, 'ok' | 'accent' | 'conflict' | 'default' | 'offline'> = {
  new: 'ok',
  update: 'accent',
  unchanged: 'default',
  clash: 'conflict',
  invalid: 'offline',
};

export function ProductSmartReview({
  rows,
  truncated,
  canUpdate,
  onApply,
  applying,
}: ProductSmartReviewProps) {
  const [decisions, setDecisions] = useState<Record<number, ProductImportRowDecision>>({});

  // A new file reuses the same row numbers, so choices made on the last file
  // are dropped when its rows arrive; without this, row 7's Skip outlived the
  // file it was made on.
  useEffect(() => {
    setDecisions({});
  }, [rows]);

  // Without the update permission the server would refuse an upsert anyway:
  // an auto-update falls back to skipping rather than blocking the whole
  // apply or offering a choice the segmented control does not have.
  const autoOf = (row: ProductImportRowPreview): ProductImportRowDecision =>
    row.decision === 'update' && !canUpdate ? 'skip' : row.decision;

  const decisionOf = (row: ProductImportRowPreview): ProductImportRowDecision =>
    decisions[row.row] ?? autoOf(row);

  const setDecision = (rowNumber: number, decision: ProductImportRowDecision): void =>
    setDecisions((current) => ({ ...current, [rowNumber]: decision }));

  // The review approves rows, it does not write per-row fates: a kept row
  // follows its auto decision and one global mode carries the apply. The
  // control says Include/Skip so a per-row Create on an existing code cannot
  // read as a choice the server would honour (it upserts under mode upsert).
  const setIncluded = (row: ProductImportRowPreview, included: boolean): void =>
    setDecision(row.row, included ? autoOf(row) : 'skip');

  const setKind = (kind: string, decision: ProductImportRowDecision): void =>
    setDecisions((current) => {
      const next = { ...current };
      for (const row of rows) {
        if (row.kind === kind) next[row.row] = decision;
      }
      return next;
    });

  const summary = useMemo(() => {
    const counts: Record<ProductImportRowDecision, number> = { create: 0, update: 0, skip: 0 };
    for (const row of rows) counts[decisionOf(row)] += 1;
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, decisions]);

  const selected = useMemo(
    () => rows.filter((row) => decisionOf(row) !== 'skip').map((row) => row.row),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, decisions],
  );

  const hasUpdate = rows.some((row) => decisionOf(row) === 'update');
  const mode = hasUpdate ? 'upsert' : 'create';

  const columns: DataTableColumn<ProductImportRowPreview>[] = [
    {
      key: 'row',
      header: t('import.column.row'),
      width: rem(64),
      align: 'right',
      render: (row) => <span className="ob-mono">{row.row}</span>,
    },
    {
      key: 'file',
      header: t('product.smart.fileValue'),
      render: (row) => (
        <span>
          <span className="ob-body-strong">{row.fileName || '…'}</span>
          {row.fileCode && <span className="ob-mono"> {row.fileCode}</span>}
        </span>
      ),
    },
    {
      key: 'existing',
      header: t('product.smart.existingValue'),
      render: (row) =>
        row.existingName ? (
          <span>
            <span>{row.existingName}</span>
            {row.existingCode && <span className="ob-mono"> {row.existingCode}</span>}
          </span>
        ) : (
          <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>
        ),
    },
    {
      key: 'cells',
      header: t('product.smart.reason'),
      render: (row) => (
        <span className="ob-small" style={{ color: 'var(--fg-secondary)' }}>
          {row.cells.length > 0
            ? row.cells
                .map((cell) => `${cell.column}: ${cell.from || '…'} → ${cell.to || '…'}`)
                .join('; ')
            : t(row.reasonKey, (row.reasonParams ?? {}) as never)}
        </span>
      ),
    },
    {
      key: 'decision',
      header: t('product.smart.decision'),
      width: rem(220),
      render: (row) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-8)' }}>
          <StatusPill tone={KIND_TONE[row.kind] ?? 'default'}>
            {row.kind === 'new'
              ? t('product.smart.create')
              : row.kind === 'update' || row.kind === 'unchanged'
                ? t('product.smart.update')
                : t('product.smart.skip')}
          </StatusPill>
          <Segmented<'include' | 'skip'>
            value={decisionOf(row) === 'skip' ? 'skip' : 'include'}
            options={[
              { value: 'include', label: t('product.smart.include') },
              { value: 'skip', label: t('product.smart.skip') },
            ]}
            onChange={(next) => setIncluded(row, next === 'include')}
          />
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
      <div className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
        {t('product.smart.noWholeFile')}
        {truncated ? ' ' + t('import.preview.truncated', { max: rows.length }) : ''}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-8)' }}>
        <Button variant="secondary" size="sm" onClick={() => setKind('clash', 'skip')}>
          {t('product.smart.bulk.skipClashes')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setKind('new', 'create')}>
          {t('product.smart.bulk.createNew')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!canUpdate}
          onClick={() => setKind('update', 'update')}
        >
          {t('product.smart.bulk.updateValid')}
        </Button>
        <span style={{ flex: 1 }} />
        <Button
          variant="primary"
          size="sm"
          busy={applying}
          disabled={applying || selected.length === 0 || (hasUpdate && !canUpdate)}
          onClick={() => onApply(selected, mode)}
        >
          {t('import.confirm', { count: selected.length })}
        </Button>
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => String(row.row)}
        empty={<span className="ob-small">{t('import.preview.noRows')}</span>}
      />
      <div className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
        {t('import.preview.summary', {
          created: summary.create,
          updated: summary.update,
          skipped: summary.skip,
          failed: 0,
        })}
      </div>
    </div>
  );
}
