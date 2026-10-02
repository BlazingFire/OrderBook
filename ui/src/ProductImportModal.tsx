/**
 * Import products from a spreadsheet, without leaving the Catalog screen.
 *
 * Port of `office/web/src/components/ProductImportModal.tsx`; keep in step
 * (until the Office switches to this copy the code exists twice). Deliberate
 * differences: it talks through the `CatalogueTransport`, held in a ref, and a
 * failure is `apiErrorText(caught, 'import.failed')` - the Master has no
 * "Master is off" state to describe.
 *
 * The steps, the issue table and the downloads are `ImportDialog`, shared with
 * the party import; this file is what is specific to products: the words, the
 * modes, and a sample row read the way the catalogue does
 * (`docs/catalogue/CATALOGUE_MODEL.md` §1) — brand, product
 * (`OPT · One Piece Toilet`), sub product — so a file whose rows landed under
 * the wrong product is caught before anything is written.
 */

import type { ProductImportMode, ProductImportResult, ProductInput } from '@orderbook/shared';
import { MAX_PRODUCT_IMPORT_BYTES, MAX_PRODUCT_IMPORT_ISSUES } from '@orderbook/shared';

import { productLabel, type CatalogueTransport } from './catalogueSummary.js';
import type { DataTableColumn } from './DataTable.js';
import { ImportDialog, saveBlob } from './ImportDialog.js';
import { t } from './i18n.js';
import { rem } from './rem.js';

interface ProductImportModalProps {
  open: boolean;
  transport: CatalogueTransport;
  onClose: () => void;
  /** Something was written; the catalogue should refetch. */
  onImported: (result: ProductImportResult) => void;
  onError: (message: string) => void;
}

/** Download the catalogue as a CSV: `sub` = every sub product, `main` = the main products. */
export async function exportCatalogueCsv(
  transport: CatalogueTransport,
  level: 'sub' | 'main',
): Promise<void> {
  const { blob, fileName } = await transport.exportProducts('csv', level);
  saveBlob(blob, fileName);
}

// Built per render, not at import: `t` answers in the language on screen.
const modes = (): ReadonlyArray<{ value: ProductImportMode; label: string }> => [
  { value: 'create', label: t('import.mode.create') },
  { value: 'upsert', label: t('import.mode.upsert') },
];

const sampleColumns = (): DataTableColumn<ProductInput>[] => [
  {
    key: 'brand',
    header: t('catalog.products.column.brand'),
    width: rem(100),
    render: (row) => row.categoryBrand ?? '—',
  },
  {
    key: 'category',
    header: t('catalog.products.column.category'),
    width: rem(170),
    render: (row) => productLabel(row.categoryCode, row.categoryName) || '—',
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
      <span className="ob-mono">{(row.variants ?? []).map((variant) => variant.code).join(', ')}</span>
    ),
  },
  {
    key: 'size',
    header: t('catalog.products.column.size'),
    width: rem(110),
    render: (row) => row.size ?? '—',
  },
];

// Two brands may share a product name, and a row may name its product by code
// alone, so all three are the key.
const sampleKey = (row: ProductInput): string =>
  `${row.categoryBrand ?? ''}:${row.categoryCode ?? ''}:${row.categoryName ?? ''}:${row.name}`;

export function ProductImportModal({
  open,
  transport,
  onClose,
  onImported,
  onError,
}: ProductImportModalProps) {
  return (
    <ImportDialog<ProductImportMode, ProductInput, ProductImportResult>
      open={open}
      onClose={onClose}
      onImported={onImported}
      onError={onError}
      maxBytes={MAX_PRODUCT_IMPORT_BYTES}
      maxIssues={MAX_PRODUCT_IMPORT_ISSUES}
      modes={modes()}
      labels={{
        title: t('import.title'),
        templateHint: t('import.template.hint'),
        exportHint: t('import.export.hint'),
        modeLabel: t('import.mode.label'),
        confirm: (count) => t('import.confirm', { count }),
        done: (result) => t('import.done', { created: result.created, updated: result.updated }),
        donePartial: (result) =>
          t('import.done.partial', {
            created: result.created,
            updated: result.updated,
            skipped: result.skipped,
            failed: result.failed,
          }),
        unchanged: (count) => t('import.unchanged', { count }),
      }}
      actions={{
        template: (format) => transport.productImportTemplate(format),
        export: (format) => transport.exportProducts(format),
        run: (file, options) => transport.importProducts(file, options),
      }}
      sampleColumns={sampleColumns()}
      sampleKey={sampleKey}
    />
  );
}
