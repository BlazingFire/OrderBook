/**
 * Edit a product on its own screen, without a modal.
 *
 * Route based editing for the catalogue: the Products screen mounts this inside
 * an EditorScreen when the sub product edit route is open, and the list behind
 * it no longer opens the ProductDrawer modal for editing. The field set, the
 * order of the groups and the validation are the same as the drawer, so a form
 * learned once works in both places: name, product, alias, size, the Codes
 * and weight switch with either one code and weight or a table of colour,
 * code and weight rows, and the colour switch. Saving goes through the same
 * transport updateProduct call, which reaches catalog.service updateProduct,
 * and failures show the same translated message.
 */

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type {
  OptionListItem,
  Product,
  ProductCategory,
  ProductInput,
  ProductVariantInput,
} from '@orderbook/shared';
import { ProductValidationError, validateProductVariants } from '@orderbook/shared';

import { Button } from './Button.js';
import { byCatalogueOrder, productLabel, type CatalogueTransport } from './catalogueSummary.js';
import { ColourChip, useColourHex } from './DataDisplay.js';
import { apiErrorText } from './errorText.js';
import { Field, FieldGroup } from './FieldGrid.js';
import { Input, NumberInput } from './Form.js';
import { t } from './i18n.js';
import { useCommand } from './KeyboardProvider.js';
import { useFormBaseline, useUnsavedWork } from './unsavedWork.js';
import { rem } from './rem.js';
import { Segmented } from './Tabs.js';
import { Select, SuggestInput } from './SuggestInput.js';
import { useEnterToAdvance } from './useEnterToAdvance.js';

const EMPTY = {
  name: '',
  categoryId: '',
  alias: '',
  size: '',
  code: '',
  weightKg: '',
};

type Draft = typeof EMPTY;

interface VariantRow {
  id: string | null;
  label: string;
  code: string;
  weightKg: string;
}

const EMPTY_ROW: VariantRow = { id: null, label: '', code: '', weightKg: '' };

function toNumber(value: string): number | null {
  return value.trim() ? Number(value) : null;
}

interface ProductEditScreenProps {
  product: Product;
  categories: ProductCategory[];
  optionLists: OptionListItem[];
  transport: CatalogueTransport;
  /** The snapshot clocks for an offline-capable panel, so the merge can tell a sequential edit from a clash. */
  baseFieldHlc?: Record<string, string>;
  onSaved: (name: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}

export function ProductEditScreen({
  product,
  categories,
  optionLists,
  transport,
  baseFieldHlc,
  onSaved,
  onCancel,
  onError,
}: ProductEditScreenProps) {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const colourHex = useColourHex(optionLists);

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [hasVariants, setHasVariants] = useState(false);
  const [multiColour, setMultiColour] = useState(false);
  const [rows, setRows] = useState<VariantRow[]>([EMPTY_ROW]);
  const [busy, setBusy] = useState(false);
  const baseline = useFormBaseline<unknown>();

  const set = (field: keyof Draft, value: string): void =>
    setDraft((current) => ({ ...current, [field]: value }));

  const setRow = (index: number, patch: Partial<VariantRow>): void =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const products = categories.filter((category) => !category.deletedAt).sort(byCatalogueOrder);
  const chosen = categories.find((category) => category.id === draft.categoryId) ?? null;

  useEffect(() => {
    const single = product.variants[0];
    const loaded = {
      draft: {
        name: product.name,
        categoryId: product.categoryId,
        alias: product.alias ?? '',
        size: product.size ?? '',
        code: !product.hasVariants && single ? single.code : '',
        weightKg: !product.hasVariants && single?.weightKg != null ? String(single.weightKg) : '',
      },
      hasVariants: product.hasVariants,
      multiColour: product.multiColour,
      rows: product.hasVariants
        ? product.variants
            .filter((variant) => variant.isActive)
            .map((variant) => ({
              id: variant.id,
              label: variant.label ?? '',
              code: variant.code,
              weightKg: variant.weightKg != null ? String(variant.weightKg) : '',
            }))
        : [EMPTY_ROW],
    };
    baseline.mark(loaded);
    setDraft(loaded.draft);
    setHasVariants(loaded.hasVariants);
    setMultiColour(loaded.multiColour);
    setRows(loaded.rows.length > 0 ? loaded.rows : [EMPTY_ROW]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  const fields = useRef<HTMLDivElement>(null);
  useEnterToAdvance(fields, () => void save(), true);
  useCommand('record.save', !busy ? () => void save() : null);

  function variantInputs(): ProductVariantInput[] {
    if (!hasVariants) {
      const single = !product.hasVariants ? product.variants[0] : undefined;
      return [
        {
          ...(single ? { id: single.id } : {}),
          code: draft.code.trim(),
          label: null,
          weightKg: toNumber(draft.weightKg),
        },
      ];
    }
    return rows
      .filter((row) => row.label.trim() || row.code.trim() || row.weightKg.trim())
      .map((row, index) => ({
        ...(row.id ? { id: row.id } : {}),
        code: row.code.trim(),
        label: row.label.trim(),
        weightKg: toNumber(row.weightKg),
        sequence: index + 1,
      }));
  }

  async function save(): Promise<boolean> {
    const name = draft.name.trim();
    if (!name) {
      onError(t('product.nameRequired'));
      return false;
    }
    if (!draft.categoryId) {
      onError(t('validation.product.categoryRequired'));
      return false;
    }
    const variants = variantInputs();
    try {
      validateProductVariants(variants, hasVariants);
    } catch (caught) {
      onError(caught instanceof ProductValidationError ? t(caught.messageKey) : String(caught));
      return false;
    }
    const text = (field: keyof Draft): string | null => draft[field].trim() || null;
    const input: ProductInput = {
      name,
      categoryId: draft.categoryId,
      alias: text('alias'),
      size: text('size'),
      multiColour,
      hasVariants,
      variants,
    };
    setBusy(true);
    try {
      await transportRef.current.updateProduct(
        product.id,
        baseFieldHlc ? { ...input, baseFieldHlc } : input,
      );
      onSaved(name);
      return true;
    } catch (caught) {
      onError(apiErrorText(caught, 'product.createFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  useUnsavedWork(
    'product-form',
    baseline.dirty({ draft, hasVariants, multiColour, rows })
      ? { label: t('updates.saveAll.product', { name: draft.name.trim() || '…' }), save }
      : null,
  );

  const text = (field: keyof Draft, label: string, extra: Record<string, unknown> = {}) => (
    <Field label={label}>
      {(id) => (
        <Input
          id={id}
          value={draft[field]}
          onChange={(event) => set(field, event.target.value)}
          {...extra}
        />
      )}
    </Field>
  );

  const numeric = (field: keyof Draft, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      {(id) => (
        <NumberInput
          id={id}
          value={draft[field]}
          onChange={(event) => set(field, event.target.value.replace(/[^0-9.]/g, ''))}
        />
      )}
    </Field>
  );

  const colourOptions = optionLists
    .filter((option) => option.listKey === 'stock.colour' && option.isActive)
    .map((option) => ({ value: option.value, label: option.label }));

  function onRowKeyDown(event: KeyboardEvent<HTMLElement>, index: number): void {
    if (event.key !== 'Enter' || event.defaultPrevented) return;
    event.preventDefault();
    const row = rows[index];
    const blank = row && !row.label.trim() && !row.code.trim() && !row.weightKg.trim();
    if (index < rows.length - 1) {
      focusRow(index + 1);
    } else if (blank) {
      void save();
    } else {
      setRows((current) => [...current, EMPTY_ROW]);
      window.setTimeout(() => focusRow(index + 1), 0);
    }
  }

  function focusRow(index: number): void {
    fields.current?.querySelector<HTMLInputElement>(`[data-variant-row="${index}"] input`)?.focus();
  }

  return (
    <div ref={fields}>
      <FieldGroup title={t('product.group.identity')}>
        <Field label={t('product.field.name')} required>
          {(id) => (
            <Input
              id={id}
              value={draft.name}
              autoFocus
              onChange={(event) => set('name', event.target.value)}
            />
          )}
        </Field>
        <Field label={t('product.field.category')} required hint={t('product.field.categoryHint')}>
          {(id) => (
            <Select
              id={id}
              value={draft.categoryId}
              aria-invalid={!draft.categoryId || undefined}
              onChange={(event) => set('categoryId', event.target.value)}
            >
              {products.map((category) => (
                <option key={category.id} value={category.id}>
                  {productLabel(category.name, category.brand)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('product.field.brand')} hint={t('product.field.brandHint')}>
          {(id) => <Input id={id} value={chosen?.brand ?? ''} disabled />}
        </Field>
        {text('alias', t('product.field.alias'))}
        {text('size', t('product.field.size'), { placeholder: t('product.field.sizePlaceholder') })}
      </FieldGroup>

      <FieldGroup title={t('product.group.codes')}>
        <Field label={t('product.variants.hasVariants')} span={3}>
          {() => (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 'var(--s-12)',
              }}
            >
              <Segmented<'no' | 'yes'>
                value={hasVariants ? 'yes' : 'no'}
                options={[
                  { value: 'no', label: t('product.variants.no') },
                  { value: 'yes', label: t('product.variants.yes') },
                ]}
                onChange={(next) => setHasVariants(next === 'yes')}
              />
              <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                {hasVariants ? t('product.variants.yesHint') : t('product.variants.noHint')}
              </span>
            </div>
          )}
        </Field>

        {!hasVariants && (
          <>
            <Field label={t('product.field.code')} required>
              {(id) => (
                <Input
                  id={id}
                  value={draft.code}
                  className="ob-mono"
                  onChange={(event) => set('code', event.target.value)}
                />
              )}
            </Field>
            {numeric('weightKg', t('product.field.weight'), t('product.field.weightHint'))}
          </>
        )}

        {hasVariants && (
          <div
            style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: rem(6) }}
          >
            <div
              className="ob-eyebrow"
              style={{
                display: 'grid',
                gridTemplateColumns: VARIANT_GRID,
                gap: '0 var(--s-12)',
                color: 'var(--fg-tertiary)',
              }}
            >
              <span>{t('product.variants.col.label')}</span>
              <span>{t('product.variants.col.code')}</span>
              <span>{t('product.variants.col.weight')}</span>
              <span />
            </div>
            {rows.map((row, index) => (
              <div
                key={row.id ?? `new-${index}`}
                data-variant-row={index}
                style={{
                  display: 'grid',
                  gridTemplateColumns: VARIANT_GRID,
                  gap: '0 var(--s-12)',
                  alignItems: 'center',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: rem(8), minWidth: 0 }}>
                  <ColourChip hex={colourHex(row.label)} name={row.label || '…'} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <SuggestInput
                      value={row.label}
                      placeholder={t('product.variants.labelPlaceholder')}
                      optionsLabel={t('lead.add.draft.showOptions', {
                        field: t('product.variants.col.label'),
                      })}
                      options={colourOptions}
                      onChange={(next) => setRow(index, { label: next })}
                    />
                  </span>
                </span>
                <Input
                  value={row.code}
                  className="ob-mono"
                  invalid={!row.code.trim()}
                  aria-label={`${t('product.variants.col.code')} ${index + 1}`}
                  onChange={(event) => setRow(index, { code: event.target.value })}
                />
                <NumberInput
                  value={row.weightKg}
                  aria-label={`${t('product.variants.col.weight')} ${index + 1}`}
                  onChange={(event) =>
                    setRow(index, { weightKg: event.target.value.replace(/[^0-9.]/g, '') })
                  }
                  onKeyDown={(event) => onRowKeyDown(event, index)}
                />
                <button
                  type="button"
                  className="ob-btn ob-btn--ghost"
                  aria-label={t('product.variants.remove', {
                    label: row.label || String(index + 1),
                  })}
                  title={t('product.variants.remove', { label: row.label || String(index + 1) })}
                  style={{ padding: 0, minWidth: rem(32), justifyContent: 'center' }}
                  disabled={rows.length === 1}
                  onClick={() => setRows((current) => current.filter((_, at) => at !== index))}
                >
                  {'\u00D7'}
                </button>
              </div>
            ))}
            <span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRows((current) => [...current, EMPTY_ROW])}
              >
                {t('product.variants.add')}
              </Button>
            </span>
            <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
              {t('product.variants.weightHint')}
            </span>
          </div>
        )}
      </FieldGroup>

      <FieldGroup title={t('product.group.colours')}>
        <Field label={t('product.multiColour.label')} span={3}>
          {() => (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 'var(--s-12)',
              }}
            >
              <Segmented<'no' | 'yes'>
                value={multiColour ? 'yes' : 'no'}
                options={[
                  { value: 'no', label: t('product.multiColour.no') },
                  { value: 'yes', label: t('product.multiColour.yes') },
                ]}
                onChange={(next) => setMultiColour(next === 'yes')}
              />
              <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                {multiColour ? t('product.multiColour.yesHint') : t('product.multiColour.noHint')}
              </span>
            </div>
          )}
        </Field>
      </FieldGroup>

      <div style={{ display: 'flex', gap: 'var(--s-12)', marginTop: 'var(--s-16)' }}>
        <Button variant="primary" busy={busy} onClick={() => void save()}>
          {busy ? t('product.saving') : t('product.saveChanges')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

const VARIANT_GRID = `minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) ${rem(32)}`;
