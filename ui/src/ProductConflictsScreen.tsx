/**
 * Product conflicts: intake, tools and history in one menu screen.
 *
 * The sub product toolbar no longer carries these actions. It keeps New sub
 * product and the filters. Everything else moved here, fully moved, on both
 * panels: the Import CSV review with its smart table, the Export CSV
 * downloads, the Backup and Restore zip, the Duplicates inline tab and the
 * Alteration preview for pending records. Each tab reuses the same services
 * and the same result shapes as the modals and screens it replaces.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DuplicateGroup,
  DuplicateMember,
  Product,
  ProductImportMode,
  ProductImportResult,
  ProductAlterationAffected,
  ProductAlterationPreview,
} from '@orderbook/shared';
import {
  MAX_PRODUCT_IMPORT_BYTES,
  colourRuleOf,
  qualitySuspects,
  sizeDriftVariants,
  type QualitySuspect,
} from '@orderbook/shared';

import { Button } from './Button.js';
import { type CatalogueTransport, type CatalogueView } from './catalogueSummary.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { apiErrorText } from './errorText.js';
import { t } from './i18n.js';
import { saveBlob } from './ImportDialog.js';
import { ProductSmartReview } from './ProductSmartReview.js';
import { ProductZipModal } from './ProductZipModal.js';
import { rem } from './rem.js';
import { Select } from './SuggestInput.js';
import { BusyMark } from './BusyMark.js';
import { EmptyState, ErrorState } from './States.js';
import { Segmented } from './Tabs.js';
import { useToast } from './Toast.js';
import { formatDateTime } from './format.js';

type Tab = 'import' | 'export' | 'backup' | 'duplicates' | 'alteration' | 'quality';

interface ProductConflictsScreenProps {
  view: CatalogueView;
  transport: CatalogueTransport;
  revision: number;
  onImported?: () => void;
}

export function ProductConflictsScreen({
  view,
  transport,
  revision,
  onImported,
}: ProductConflictsScreenProps) {
  const toast = useToast();
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const canBulk = view.permissions.includes('products.bulk');
  const canExport = view.permissions.includes('products.export');
  const canEdit = view.permissions.includes('products.edit');
  const canDelete = view.permissions.includes('products.delete');

  const tabs: Array<{ value: Tab; label: string; show: boolean }> = [
    { value: 'import', label: t('product.conflicts.tab.import'), show: canBulk },
    { value: 'export', label: t('product.conflicts.tab.export'), show: canExport },
    {
      value: 'backup',
      label: t('product.conflicts.tab.backup'),
      show: Boolean(transport.productZip) && (canExport || canBulk),
    },
    {
      value: 'duplicates',
      label: t('product.conflicts.tab.duplicates'),
      show: Boolean(transport.duplicates) && canDelete,
    },
    { value: 'quality', label: t('product.conflicts.tab.quality'), show: canEdit },
    { value: 'alteration', label: t('product.conflicts.tab.alteration'), show: true },
  ];
  const visible = tabs.filter((tab) => tab.show);
  const [tab, setTab] = useState<Tab>('import');
  const active: Tab = visible.some((entry) => entry.value === tab)
    ? tab
    : (visible[0]?.value ?? 'alteration');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <div>
        <h2 style={{ margin: 0 }}>{t('product.conflicts.title')}</h2>
        <p className="ob-small" style={{ color: 'var(--fg-tertiary)', margin: 'var(--s-4) 0 0' }}>
          {t('product.conflicts.description')}
        </p>
      </div>
      <Segmented<Tab>
        value={active}
        options={visible.map((entry) => ({ value: entry.value, label: entry.label }))}
        onChange={setTab}
      />
      {active === 'export' && (
        <ExportSection
          transport={transport}
          onError={(message) => toast.push(message, { tone: 'error' })}
        />
      )}
      {active === 'import' && (
        <ImportReview
          transport={transport}
          canEdit={canEdit}
          onImported={onImported}
          onDone={(result) =>
            toast.push(t('import.done', { created: result.created, updated: result.updated }))
          }
        />
      )}
      {active === 'backup' && (
        <BackupSection
          view={view}
          transport={transport}
          revision={revision}
          onImported={onImported}
          onError={(message) => toast.push(message, { tone: 'error' })}
        />
      )}
      {active === 'duplicates' && (
        <DuplicatesInline
          transport={transport}
          revision={revision}
          onError={(message) => toast.push(message, { tone: 'error' })}
          onDone={(message) => toast.push(message, { tone: 'ok' })}
        />
      )}
      {active === 'quality' && <QualitySection view={view} revision={revision} />}
      {active === 'alteration' && (
        <AlterationSection
          view={view}
          transport={transport}
          onError={(message) => toast.push(message, { tone: 'error' })}
          onDone={(message) => toast.push(message, { tone: 'ok' })}
        />
      )}
    </div>
  );
}

/**
 * Data-quality suspects (docs/PRODUCT_CONFLICTS.md §D): computed client-side
 * over the loaded catalogue view — no new endpoint. Each finding names the
 * rows; fixing happens on the product, then a re-check.
 */
function QualitySection({ view, revision }: { view: CatalogueView; revision: number }) {
  const suspects = useMemo(() => {
    void revision;
    const colours = new Set(
      view.optionLists.filter((option) => option.listKey === 'stock.colour').map((option) => option.label.trim().toLowerCase()),
    );
    const products = view.products.map((product) => ({
      id: product.id,
      name: product.name,
      size: product.size,
      alias: product.alias,
      categoryId: product.categoryId,
      brand: product.brand,
      colourRule: colourRuleOf(product),
      variants: product.variants.map((variant) => ({
        id: variant.id,
        code: variant.code,
        label: variant.label,
        weightKg: variant.weightKg,
      })),
    }));
    const neighbours = products.map((product) => ({
      id: product.id,
      name: product.name,
      categoryId: product.categoryId,
      brand: product.brand,
      codes: product.variants.map((variant) => variant.code ?? '').filter(Boolean),
    }));
    const found: QualitySuspect[] = [];
    for (const product of products) {
      found.push(
        ...qualitySuspects(
          product,
          neighbours.filter((neighbour) => neighbour.id !== product.id),
          colours,
        ),
      );
    }
    // D5 size drift is catalogue-wide per Product, not per row.
    const byCategory = new Map<string, Array<{ id: string; size: string | null }>>();
    for (const product of view.products) {
      const list = byCategory.get(product.categoryId) ?? [];
      list.push({ id: product.id, size: product.size });
      byCategory.set(product.categoryId, list);
    }
    for (const [categoryId, rows] of byCategory) {
      for (const forms of sizeDriftVariants(rows)) {
        const first = rows.find((row) => row.size && forms.includes(row.size));
        const name = view.products.find((product) => product.id === first?.id)?.name ?? categoryId;
        found.push({
          kind: 'size-drift',
          productId: first?.id ?? categoryId,
          productName: name,
          detail: `Size prints ${forms.map((form) => `"${form}"`).join(' vs ')} in one product`,
        });
      }
    }
    return found.sort((a, b) => a.productName.localeCompare(b.productName) || a.kind.localeCompare(b.kind));
  }, [view, revision]);

  if (suspects.length === 0) {
    return (
      <EmptyState
        title={t('product.quality.empty.title')}
        description={t('product.quality.empty.description')}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
      <p className="ob-small" style={{ color: 'var(--fg-tertiary)', margin: 0 }}>
        {t('product.quality.description')}
      </p>
      {suspects.map((suspect: QualitySuspect, index: number) => (
        <div key={`${suspect.productId}:${suspect.kind}:${index}`} className="ob-card ob-card--pad" style={{ display: 'flex', gap: 'var(--s-8)', alignItems: 'baseline', flexWrap: 'wrap' }}>
          <strong>{suspect.productName}</strong>
          <span className="ob-dup__chip">{t(`product.quality.kind.${suspect.kind}`)}</span>
          <span className="ob-small" style={{ color: 'var(--fg-secondary)' }}>{suspect.detail}</span>
        </div>
      ))}
    </div>
  );
}

function ImportReview({
  transport,
  canEdit,
  onImported,
  onDone,
}: {
  transport: CatalogueTransport;
  canEdit: boolean;
  onImported?: () => void;
  onDone: (result: ProductImportResult) => void;
}) {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const [mode, setMode] = useState<ProductImportMode>('create');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ProductImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function accept(chosen: File): Promise<void> {
    if (busy) return;
    if (!/\.csv$/i.test(chosen.name) && !/\.xlsx$/i.test(chosen.name)) {
      setFailure(t('validation.import.unsupportedFormat'));
      return;
    }
    if (chosen.size === 0) {
      setFailure(t('validation.import.emptyFile'));
      return;
    }
    if (chosen.size > MAX_PRODUCT_IMPORT_BYTES) {
      setFailure(
        t('import.fileTooLarge', { maxMb: Math.round(MAX_PRODUCT_IMPORT_BYTES / (1024 * 1024)) }),
      );
      return;
    }
    setFile(chosen);
    setFailure(null);
    setBusy(true);
    try {
      setResult(await transportRef.current.importProducts(chosen, { dryRun: true, mode }));
    } catch (caught) {
      setFailure(apiErrorText(caught, 'import.failed'));
    } finally {
      setBusy(false);
    }
  }

  async function apply(selectedRows: number[], applyMode: 'create' | 'upsert'): Promise<void> {
    if (!file || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const outcome = await transportRef.current.importProducts(file, {
        dryRun: false,
        mode: applyMode,
        onlyRows: selectedRows,
        // The dry run hashed these bytes: a re-uploaded file is refused by the
        // server rather than taking the approved row numbers.
        ...(result?.fileHash ? { fileHash: result.fileHash } : {}),
      });
      onImported?.();
      onDone(outcome);
      setFile(null);
      setResult(null);
    } catch (caught) {
      setFailure(apiErrorText(caught, 'import.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
      <div className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
        {t('product.conflicts.importHint')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-8)', alignItems: 'center' }}>
        <Segmented<ProductImportMode>
          value={mode}
          options={[
            { value: 'create', label: t('import.mode.create') },
            { value: 'upsert', label: t('import.mode.upsert') },
          ]}
          onChange={(next) => {
            setMode(next);
            setFile(null);
            setResult(null);
            setFailure(null);
          }}
        />
        <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
          {t('import.template.hint')}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx"
          hidden
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            event.target.value = '';
            if (chosen) void accept(chosen);
          }}
        />
      </div>
      {busy && !result && <BusyMark />}
      {failure && <ErrorState title={failure} onAction={() => setFailure(null)} />}
      {result && result.rowPreviews && (
        <ProductSmartReview
          rows={result.rowPreviews}
          truncated={result.rowPreviewsTruncated ?? false}
          canUpdate={canEdit}
          applying={busy}
          onApply={(selectedRows, applyMode) => void apply(selectedRows, applyMode)}
        />
      )}
      {result && !result.rowPreviews && (
        <div className="ob-small">
          {t('import.preview.summary', {
            created: result.created,
            updated: result.updated,
            skipped: result.skipped,
            failed: result.failed,
          })}
        </div>
      )}
    </div>
  );
}

function ExportSection({
  transport,
  onError,
}: {
  transport: CatalogueTransport;
  onError: (message: string) => void;
}) {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const [busy, setBusy] = useState<'sub' | 'main' | null>(null);

  async function download(level: 'sub' | 'main'): Promise<void> {
    if (busy) return;
    setBusy(level);
    try {
      const { blob, fileName } = await transportRef.current.exportProducts('csv', level);
      saveBlob(blob, fileName);
    } catch (caught) {
      onError(apiErrorText(caught, 'import.exportFailed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-8)' }}>
      <Button
        variant="secondary"
        size="sm"
        busy={busy === 'sub'}
        onClick={() => void download('sub')}
      >
        {t('product.conflicts.exportSub')}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        busy={busy === 'main'}
        onClick={() => void download('main')}
      >
        {t('product.conflicts.exportMain')}
      </Button>
    </div>
  );
}

function BackupSection({
  view,
  transport,
  revision,
  onImported,
  onError,
}: {
  view: CatalogueView;
  transport: CatalogueTransport;
  revision: number;
  onImported?: () => void;
  onError: (message: string) => void;
}) {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const canExport = view.permissions.includes('products.export');
  const canRestore = view.permissions.includes('products.bulk');
  const zip = transport.productZip;
  const [zipOpen, setZipOpen] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  if (!zip)
    return (
      <EmptyState
        title={t('product.conflicts.tab.backup')}
        description={t('product.conflicts.backupHint')}
      />
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
      <div className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
        {t('product.conflicts.backupHint')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-8)' }}>
        {canExport && (
          <Button
            variant="secondary"
            size="sm"
            busy={backingUp}
            disabled={backingUp}
            onClick={() => {
              setBackingUp(true);
              void zip
                .exportZip()
                .then(({ blob, fileName }) => saveBlob(blob, fileName))
                .catch((caught) => onError(apiErrorText(caught, 'productZip.backupFailed')))
                .finally(() => setBackingUp(false));
            }}
          >
            {t('productZip.backup')}
          </Button>
        )}
        {canRestore && (
          <Button variant="secondary" size="sm" onClick={() => setZipOpen(true)}>
            {t('productZip.restore')}
          </Button>
        )}
      </div>
      {canRestore && (
        <ProductZipModal
          key={revision}
          open={zipOpen}
          transport={zip}
          canDelete={view.permissions.includes('products.delete')}
          onClose={() => setZipOpen(false)}
          onRestored={() => {
            onImported?.();
          }}
        />
      )}
    </div>
  );
}

function MemberDetail({
  member,
  level,
}: {
  member: DuplicateMember;
  level: DuplicateGroup['level'];
}) {
  const parts =
    level === 'product' ? [member.code] : [member.productName, member.code, member.size];
  return (
    <span className="ob-dup__detail">
      {parts.filter(Boolean).join(' | ')}
      {parts.some(Boolean) ? ' | ' : ''}
      {t('duplicates.addedOn', { date: formatDateTime(member.createdAt) })}
    </span>
  );
}

function blockedText(member: DuplicateMember): string | null {
  if (member.blockedBy === 'liveReferences') {
    return t('duplicates.blocked.liveReferences', { count: member.lineCount });
  }
  if (member.blockedBy === 'subProducts') {
    return t('duplicates.blocked.subProducts', { count: member.subProductCount });
  }
  return null;
}

function DuplicatesInline({
  transport,
  revision,
  onError,
  onDone,
}: {
  transport: CatalogueTransport;
  revision: number;
  onError: (message: string) => void;
  onDone: (message: string) => void;
}) {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<DuplicateGroup | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const duplicates = transportRef.current.duplicates;
    if (!duplicates) {
      setGroups([]);
      return;
    }
    duplicates
      .list()
      .then((report) => {
        if (live) {
          setGroups(report.groups);
          setFailed(false);
        }
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [revision]);

  if (!transport.duplicates) return null;
  if (failed && !groups)
    return <ErrorState title={t('duplicates.loadFailed')} onAction={() => setFailed(false)} />;
  if (!groups) return <BusyMark />;

  const keptIn = (group: DuplicateGroup): string => {
    const chosen = keep[group.key];
    return chosen && group.members.some((member) => member.id === chosen)
      ? chosen
      : (group.members[0]?.id ?? '');
  };
  const deletable = (group: DuplicateGroup): DuplicateMember[] =>
    group.members.filter((member) => member.id !== keptIn(group) && !member.blockedBy);

  async function resolve(group: DuplicateGroup): Promise<void> {
    const duplicates = transportRef.current.duplicates;
    if (!duplicates) return;
    setBusy(true);
    try {
      const result = await duplicates.resolve({
        level: group.level,
        keepId: keptIn(group),
        deleteIds: deletable(group).map((member) => member.id),
      });
      if (result.deleted.length > 0) onDone(t('duplicates.done', { count: result.deleted.length }));
      if (result.refused.length > 0)
        onDone(t('duplicates.refused', { count: result.refused.length }));
      const report = await duplicates.list();
      setGroups(report.groups);
    } catch (caught) {
      onError(apiErrorText(caught, 'duplicates.loadFailed'));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  if (groups.length === 0) {
    return (
      <EmptyState
        title={t('duplicates.empty.title')}
        description={t('duplicates.empty.description')}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
      {groups.map((group) => {
        const kept = keptIn(group);
        const removable = deletable(group);
        return (
          <section key={group.key} className="ob-card ob-card--pad ob-dup__group">
            <div className="ob-dup__title">
              <strong>{t(`duplicates.level.${group.level}`)}</strong>
              {group.brand && <span>{group.brand}</span>}
              {group.matchedOn.map((kind) => (
                <span key={kind} className="ob-dup__chip">
                  {t(`duplicates.match.${kind}`)}
                </span>
              ))}
            </div>
            <ul className="ob-dup__members">
              {group.members.map((member, index) => {
                const blocked = blockedText(member);
                return (
                  <li key={member.id} className={member.id === kept ? 'is-kept' : undefined}>
                    <label>
                      <input
                        type="radio"
                        className="ob-radio"
                        name={group.key}
                        checked={member.id === kept}
                        onChange={() =>
                          setKeep((current) => ({ ...current, [group.key]: member.id }))
                        }
                      />
                      <span className="ob-dup__name">{member.name}</span>
                      {index === 0 && (
                        <span className="ob-dup__chip">{t('duplicates.oldest')}</span>
                      )}
                    </label>
                    <MemberDetail member={member} level={group.level} />
                    {blocked && member.id !== kept && (
                      <em className="ob-dup__blocked">{blocked}</em>
                    )}
                  </li>
                );
              })}
            </ul>
            <Button
              variant="danger"
              disabled={removable.length === 0 || busy}
              title={removable.length === 0 ? t('duplicates.nothingToDelete') : undefined}
              onClick={() => setConfirming(group)}
            >
              {t('duplicates.delete')}
            </Button>
          </section>
        );
      })}
      <ConfirmDialog
        open={confirming !== null}
        title={t('duplicates.confirm.title')}
        body={
          confirming
            ? t('duplicates.confirm.body', {
                keep:
                  confirming.members.find((member) => member.id === keptIn(confirming))?.name ?? '',
                count: deletable(confirming).length,
              })
            : undefined
        }
        confirmLabel={t('duplicates.delete')}
        tone="danger"
        busy={busy}
        onConfirm={() => confirming && void resolve(confirming)}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}

/** How many before/after lines the review shows; the PDF carries every line. */
const REVIEW_CHANGES_LIMIT = 50;

function AlterationSection({
  view,
  transport,
  onError,
  onDone,
}: {
  view: CatalogueView;
  transport: CatalogueTransport;
  onError: (message: string) => void;
  onDone: (message: string) => void;
}) {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const canApply =
    view.permissions.includes('products.edit') && view.permissions.includes('products.bulk');
  const [productId, setProductId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<ProductAlterationPreview | null>(null);
  const [affected, setAffected] = useState<ProductAlterationAffected[]>([]);
  const [downloading, setDownloading] = useState(false);

  const products = view.products.slice().sort((a, b) => a.name.localeCompare(b.name));
  const current = view.products.find((entry) => entry.id === productId);
  const variantById = new Map((current?.variants ?? []).map((variant) => [variant.id, variant]));

  // The itemized review, from the preview before anything is applied: each
  // pending line's stored snapshot against the live product it would take.
  const review: ProductAlterationAffected[] = (preview?.pending ?? []).map((ref) => ({
    parentType: ref.parentType,
    parentId: ref.parentId,
    poNumber: ref.poNumber,
    before: {
      product: ref.productName ?? '',
      code: ref.code ?? '',
      size: ref.size ?? '',
    },
    after: {
      product: current?.name ?? preview?.productName ?? '',
      code: variantById.get(ref.variantId)?.code ?? ref.code ?? '',
      size: current?.size ?? '',
    },
  }));
  const shownReview = review.slice(0, REVIEW_CHANGES_LIMIT);

  async function loadPreview(): Promise<void> {
    const alteration = transportRef.current.alteration;
    if (!alteration || !productId || loading) return;
    setLoading(true);
    try {
      setAffected([]);
      setPreview(await alteration.preview(productId));
    } catch (caught) {
      onError(apiErrorText(caught, 'product.alteration.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  async function apply(): Promise<void> {
    const alteration = transportRef.current.alteration;
    const product: Product | undefined = view.products.find((entry) => entry.id === productId);
    if (!alteration || !product || applying) return;
    setApplying(true);
    try {
      const result = await alteration.apply(
        product.id,
        {
          name: product.name,
          categoryId: product.categoryId,
          alias: product.alias,
          size: product.size,
          multiColour: product.multiColour,
          hasVariants: product.hasVariants,
          variants: product.variants
            .filter((variant) => variant.isActive)
            .map((variant, index) => ({
              id: variant.id,
              code: variant.code,
              label: variant.label,
              weightKg: variant.weightKg,
              sequence: index + 1,
            })),
        },
        // The clocks this view opened the product at: a save that landed since
        // is refused with 409 instead of patched underneath.
        product.sync.fieldHlc,
      );
      onDone(t('product.alteration.applied'));
      setPreview(await alteration.preview(product.id));
      setAffected(result.affected);
    } catch (caught) {
      onError(apiErrorText(caught, 'product.alteration.applyFailed'));
    } finally {
      setApplying(false);
    }
  }

  async function downloadPdf(): Promise<void> {
    const alteration = transportRef.current.alteration;
    if (!alteration || !productId || !preview || downloading) return;
    // Before applying, the review above is the PDF's content; after applying,
    // the server's affected list is, with the real PO numbers.
    const rows = affected.length > 0 ? affected : review;
    if (rows.length === 0) return;
    setDownloading(true);
    try {
      const file = await alteration.pdf(productId, current?.name ?? preview.productName, rows);
      saveBlob(file.blob, file.fileName);
    } catch (caught) {
      onError(apiErrorText(caught, 'import.exportFailed'));
    } finally {
      setDownloading(false);
    }
  }

  if (!transport.alteration) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
      <div className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
        {t('product.alteration.description')}
      </div>
      <div style={{ display: 'flex', gap: 'var(--s-8)', alignItems: 'center', flexWrap: 'wrap' }}>
        <Select
          value={productId}
          onChange={(event) => setProductId(event.target.value)}
          aria-label={t('product.alteration.title')}
          style={{ width: rem(320) }}
        >
          <option value="">{t('product.alteration.selectProduct')}</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          size="sm"
          busy={loading}
          disabled={!productId || loading}
          onClick={() => void loadPreview()}
        >
          {t('product.alteration.title')}
        </Button>
      </div>
      {preview && (
        <>
          <div className="ob-small">
            {t('product.alteration.pendingLeads')}: {preview.pendingLeads} |{' '}
            {t('product.alteration.pendingOrders')}: {preview.pendingOrders} |{' '}
            {t('product.alteration.frozen')}: {preview.frozenLeads + preview.frozenOrders}
          </div>
          <div className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
            {t('product.alteration.pendingList', {
              shown: preview.pending.length,
              leads: preview.pendingLeads,
              orders: preview.pendingOrders,
            })}
          </div>
          {preview.pending.length > 0 && (
            <ul
              className="ob-small"
              style={{ maxHeight: rem(192), overflowY: 'auto', margin: 0, paddingLeft: rem(20) }}
            >
              {preview.pending.map((ref, index) => (
                <li key={'pending-' + String(index)}>
                  {[ref.poNumber ?? ref.parentId.slice(0, 8), ref.partyName, ref.code]
                    .filter(Boolean)
                    .join(' | ')}
                </li>
              ))}
            </ul>
          )}
          <div className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
            {t('product.alteration.frozenList', {
              shown: preview.frozen.length,
              leads: preview.frozenLeads,
              orders: preview.frozenOrders,
            })}
          </div>
          {preview.frozen.length > 0 && (
            <ul
              className="ob-small"
              style={{ maxHeight: rem(192), overflowY: 'auto', margin: 0, paddingLeft: rem(20) }}
            >
              {preview.frozen.map((ref, index) => (
                <li key={'frozen-' + String(index)}>
                  {[ref.poNumber ?? ref.parentId.slice(0, 8), ref.partyName, ref.code]
                    .filter(Boolean)
                    .join(' | ')}
                </li>
              ))}
            </ul>
          )}
          {shownReview.length > 0 && (
            <>
              <div className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
                {t('product.alteration.changesList', { shown: shownReview.length })}
              </div>
              <ul
                className="ob-small"
                style={{ maxHeight: rem(192), overflowY: 'auto', margin: 0, paddingLeft: rem(20) }}
              >
                {shownReview.map((entry, index) => (
                  <li key={'change-' + String(index)}>
                    {[entry.poNumber ?? entry.parentId.slice(0, 8), entry.parentType]
                      .filter(Boolean)
                      .join(' | ')}
                    {': '}
                    {(entry.before.product + ' ' + entry.before.code).trim()}
                    {' -> '}
                    {(entry.after.product + ' ' + entry.after.code).trim()}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div style={{ display: 'flex', gap: 'var(--s-8)', flexWrap: 'wrap' }}>
            <Button
              variant="primary"
              size="sm"
              busy={applying}
              disabled={!canApply || applying}
              onClick={() => void apply()}
            >
              {t('product.alteration.apply')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              busy={downloading}
              disabled={downloading || review.length === 0}
              onClick={() => void downloadPdf()}
            >
              {affected.length > 0
                ? t('product.alteration.pdf')
                : t('product.alteration.reviewPdf')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
