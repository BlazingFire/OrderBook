/**
 * Create or edit a product without leaving the Catalog screen.
 *
 * A product is a **model in a category** with one or more **variants**, and
 * every variant owns a code and a weight. The form says so in its shape: the
 * *Codes & weight* group is a switch — "Does this product come in variants?" —
 * and either one code-and-weight pair (No) or a table of colour · code · weight
 * rows (Yes). Nothing else on the form knows about codes.
 *
 * The category is a suggest field over the categories the panel already holds;
 * a name that matches none creates one on the Master. Required, because the
 * lead screen finds products by category first.
 *
 * The tile-era attributes (finish, shade, PEI rating, calibre…) are no longer
 * offered. Their columns stay in the database and a record that holds them
 * keeps them — a save from here simply does not name them, and the Master
 * leaves what it is not told about alone.
 *
 * The name is kept for its call sites; it is a modal.
 *
 * **The purchase rate is hidden entirely without the key, not disabled.** A
 * disabled field with a value in it is a disclosure; a disabled field with no
 * value in it is a permanent tease. The Master masks the field by *absence*, so
 * "the key is not there" and "the person may not see cost" are the same test.
 *
 * The sale rate has no client-side gate, deliberately: the Master ignores a
 * rate from anybody without `field.saleRate.edit` whatever the panel sends, so
 * a gate here would be a courtesy — and this screen is not handed a `can()`.
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
import { PRODUCT_UOMS, ProductValidationError, validateProductVariants } from '@orderbook/shared';

import { api } from '../api';
import {
  Button,
  ColourChip,
  Field,
  FieldGroup,
  Input,
  Modal,
  NumberInput,
  Segmented,
  Select,
  SuggestInput,
  rem,
  t,
  useColourHex,
  useCommand,
  useEnterToAdvance,
} from '@orderbook/ui';
import { ProductImages } from './ProductImages';

export interface CreatedProduct {
  id: string;
  name: string;
  /** The first variant's code — what the catalogue shows for a one-form product. */
  code: string;
}

interface ProductDrawerProps {
  open: boolean;
  product?: Product | null;
  /** The categories this panel holds, for the suggest field. */
  categories: ProductCategory[];
  /** For the colour swatch beside a variant label (`stock.colour`). */
  optionLists: OptionListItem[];
  /** Holds `field.saleRate.view`; off with the company's pricing switch (v1.1.0). */
  showMoney: boolean;
  onClose: () => void;
  onCreated?: (product: CreatedProduct) => void;
  onUpdated?: (name: string) => void;
  onError: (message: string) => void;
}

/** Every editable model-level column, so the form and the record cannot drift apart. */
const EMPTY = {
  name: '',
  categoryName: '',
  alias: '',
  productType: '',
  brand: '',
  barcode: '',
  hsnCode: '',
  rate: '',
  mrp: '',
  purchaseRate: '',
  gstRatePct: '',
  uom: 'piece',
  size: '',
  grade: '',
  /** The one code and weight of a product with no variants. */
  code: '',
  weightKg: '',
};

type Draft = typeof EMPTY;

/** One row of the variants table, as typed. */
interface VariantRow {
  /** The saved variant's id, kept so stock and lines stay pointed at it. */
  id: string | null;
  label: string;
  code: string;
  weightKg: string;
}

const EMPTY_ROW: VariantRow = { id: null, label: '', code: '', weightKg: '' };

/** Money is entered in rupees and stored in paise. */
function toPaise(value: string): number | null {
  return value.trim() ? Math.round(Number(value) * 100) : null;
}

function toNumber(value: string): number | null {
  return value.trim() ? Number(value) : null;
}

function fromPaise(value: number | null | undefined): string {
  return value != null ? String(value / 100) : '';
}

export function ProductDrawer({
  open,
  product,
  categories,
  optionLists,
  showMoney,
  onClose,
  onCreated,
  onUpdated,
  onError,
}: ProductDrawerProps) {
  const editing = product ?? null;
  const colourHex = useColourHex(optionLists);

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [hasVariants, setHasVariants] = useState(false);
  const [rows, setRows] = useState<VariantRow[]>([EMPTY_ROW]);
  const [busy, setBusy] = useState(false);

  /*
   * Local mirror of the editing product's `images[]`, patched in place as
   * uploads, reorders and deletes resolve. The merged view updates a moment
   * later through the event stream, but waiting for that would make the
   * thumbnail strip flicker blank between actions.
   */
  const [liveProduct, setLiveProduct] = useState<Product | null>(editing);

  const set = (field: keyof Draft, value: string): void =>
    setDraft((current) => ({ ...current, [field]: value }));

  const setRow = (index: number, patch: Partial<VariantRow>): void =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  /**
   * Whether this panel's signed-in person may see what the company pays.
   *
   * Read from the record rather than from a permission list: the Master masks
   * the purchase rate by **key absence**, so an editing product that carries no
   * `purchaseRate` property is exactly the case where the field must not
   * render. On a new product there is nothing to disclose, so it is offered —
   * and the Master drops it if they may not set one.
   */
  const canSeeCost = !editing || 'purchaseRate' in editing;

  useEffect(() => {
    if (!open) return;

    if (editing) {
      const single = editing.variants[0];
      setDraft({
        name: editing.name,
        categoryName: editing.categoryName,
        alias: editing.alias ?? '',
        productType: editing.productType ?? '',
        brand: editing.brand ?? '',
        barcode: editing.barcode ?? '',
        hsnCode: editing.hsnCode ?? '',
        rate: fromPaise(editing.rate),
        mrp: fromPaise(editing.mrp),
        purchaseRate: fromPaise(editing.purchaseRate),
        gstRatePct: editing.gstRatePct != null ? String(editing.gstRatePct) : '',
        uom: editing.uom || 'piece',
        size: editing.size ?? '',
        grade: editing.grade ?? '',
        code: !editing.hasVariants && single ? single.code : '',
        weightKg: !editing.hasVariants && single?.weightKg != null ? String(single.weightKg) : '',
      });
      setHasVariants(editing.hasVariants);
      // Deactivated variants stay off the table: they are history's, not the
      // form's, and re-adding the same label brings the old row back.
      setRows(
        editing.hasVariants
          ? editing.variants
              .filter((variant) => variant.isActive)
              .map((variant) => ({
                id: variant.id,
                label: variant.label ?? '',
                code: variant.code,
                weightKg: variant.weightKg != null ? String(variant.weightKg) : '',
              }))
          : [EMPTY_ROW],
      );
    } else {
      setDraft(EMPTY);
      setHasVariants(false);
      setRows([EMPTY_ROW]);
    }

    setLiveProduct(editing);
    // Keyed on the record's identity, not the record: an unrelated field
    // arriving through the event stream must not wipe a half-typed draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id]);

  const fields = useRef<HTMLDivElement>(null);

  // Enter walks the fields and saves on the last one; Ctrl+S saves from
  // anywhere in the dialog. Registered here rather than on the screen behind
  // the scrim, which is what puts this above it on the command stack.
  useEnterToAdvance(fields, () => void save(), open);
  useCommand('record.save', open && !busy ? () => void save() : null);

  function close(): void {
    setDraft(EMPTY);
    onClose();
  }

  /** The variant set as the Master will receive it, from whichever half of the switch is showing. */
  function variantInputs(): ProductVariantInput[] {
    if (!hasVariants) {
      const single = editing && !editing.hasVariants ? editing.variants[0] : undefined;
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

  async function save(): Promise<void> {
    const name = draft.name.trim();
    const categoryName = draft.categoryName.trim();

    if (!name) {
      onError(t('product.nameRequired'));
      return;
    }
    if (!categoryName) {
      onError(t('validation.product.categoryRequired'));
      return;
    }

    const variants = variantInputs();
    // The same rules the Master applies, so the refusal is immediate and names
    // the row's problem rather than arriving as a 400 after the round trip.
    try {
      validateProductVariants(variants, hasVariants);
    } catch (caught) {
      onError(caught instanceof ProductValidationError ? t(caught.messageKey) : String(caught));
      return;
    }

    const text = (field: keyof Draft): string | null => draft[field].trim() || null;

    const input: ProductInput = {
      name,
      categoryName,
      alias: text('alias'),
      productType: text('productType'),
      brand: text('brand'),
      barcode: text('barcode'),
      hsnCode: text('hsnCode'),
      gstRatePct: toNumber(draft.gstRatePct),
      uom: draft.uom as ProductInput['uom'],
      size: text('size'),
      grade: text('grade'),
      hasVariants,
      variants,
      // Sent only when the field was rendered. Sending `null` for a hidden
      // field would clear a price this person was never shown — and with the
      // company's pricing switch off, nobody is shown one.
      ...(showMoney ? { rate: toPaise(draft.rate), mrp: toPaise(draft.mrp) } : {}),
      ...(showMoney && canSeeCost ? { purchaseRate: toPaise(draft.purchaseRate) } : {}),
    };

    setBusy(true);
    try {
      if (editing) {
        // What this screen last saw for each field — lets the Master's merge
        // tell an ordinary sequential edit apart from a real clash against
        // whatever changed elsewhere since.
        await api.updateProduct(editing.id, { ...input, baseFieldHlc: editing.sync.fieldHlc });
        onUpdated?.(name);
      } else {
        const result = await api.createProduct(input);
        onCreated?.({ id: result.id, name, code: variants[0]?.code ?? '' });
        setDraft(EMPTY);
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('product.createFailed'));
    } finally {
      setBusy(false);
    }
  }

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

  /** A numeric cell. Digits and one dot — a stepper is wrong for a free figure. */
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

  /** A closed set. A native select, because that is exactly what one is. */
  const choice = (
    field: keyof Draft,
    label: string,
    values: readonly string[],
    labelFor: (value: string) => string,
    blank = true,
  ) => (
    <Field label={label}>
      {(id) => (
        <Select id={id} value={draft[field]} onChange={(event) => set(field, event.target.value)}>
          {blank && <option value="">{t('product.field.none')}</option>}
          {values.map((value) => (
            <option key={value} value={value}>
              {labelFor(value)}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );

  const colourOptions = optionLists
    .filter((option) => option.listKey === 'stock.colour' && option.isActive)
    .map((option) => ({ value: option.value, label: option.label }));

  /**
   * Enter inside the variants table stays inside it: on to the next row, a new
   * row after the last, or the save when the last row is still blank. Left to
   * the walk, Enter on the last weight would save a half-typed table.
   */
  function onRowKeyDown(event: KeyboardEvent<HTMLElement>, index: number): void {
    if (event.key !== 'Enter') return;
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
    fields.current
      ?.querySelector<HTMLInputElement>(`[data-variant-row="${index}"] input`)
      ?.focus();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      size="xl"
      title={editing ? t('product.edit.title') : t('product.new.title')}
      footer={
        <>
          <span className="ob-small">{!editing && t('product.saveHint')}</span>
          <span style={{ flex: 1 }} />
          <Button variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {busy ? t('product.saving') : editing ? t('product.saveChanges') : t('product.save')}
          </Button>
        </>
      }
    >
      <div ref={fields}>
        <FieldGroup title={t('product.group.identity')}>
          <Field label={t('product.field.name')} required span={2}>
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
              <SuggestInput
                id={id}
                value={draft.categoryName}
                invalid={!draft.categoryName.trim()}
                optionsLabel={t('lead.add.draft.showOptions', {
                  field: t('product.field.category'),
                })}
                options={categories.map((category) => ({
                  value: category.name,
                  label: category.name,
                }))}
                onChange={(next) => set('categoryName', next)}
              />
            )}
          </Field>
          {text('alias', t('product.field.alias'))}
          {text('brand', t('product.field.brand'))}
          {text('productType', t('product.field.type'))}
          {text('barcode', t('product.field.barcode'), { className: 'ob-mono' })}
        </FieldGroup>

        <FieldGroup title={t('product.group.pricing')}>
          {showMoney && numeric('rate', t('product.field.rate'), t('product.field.rateHint'))}
          {showMoney && numeric('mrp', t('product.field.mrp'))}
          {showMoney &&
            canSeeCost &&
            numeric(
              'purchaseRate',
              t('product.field.purchaseRate'),
              t('product.field.purchaseRateHint'),
            )}
          {numeric('gstRatePct', t('product.field.gstRate'))}
          {text('hsnCode', t('product.field.hsnCode'), { className: 'ob-mono' })}
          {choice(
            'uom',
            t('product.field.uom'),
            PRODUCT_UOMS,
            (value) => t(`product.uom.${value}` as never),
            false,
          )}
        </FieldGroup>

        <FieldGroup title={t('product.group.codes')}>
          <Field label={t('product.variants.hasVariants')} span={3}>
            {() => (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--s-12)' }}>
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
            <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: rem(6) }}>
              <div
                className="ob-eyebrow"
                style={{
                  display: 'grid',
                  gridTemplateColumns: VARIANT_GRID,
                  gap: `0 ${rem(10)}`,
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
                    gap: `0 ${rem(10)}`,
                    alignItems: 'center',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: rem(8), minWidth: 0 }}>
                    <ColourChip hex={colourHex(row.label)} name={row.label || '—'} />
                    <span style={{ flex: 1, minWidth: 0 }} onKeyDown={(event) => onRowKeyDown(event, index)}>
                      <SuggestInput
                        value={row.label}
                        invalid={!row.label.trim()}
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
                    style={{ marginTop: rem(4) }}
                    onChange={(event) => setRow(index, { code: event.target.value })}
                    onKeyDown={(event) => onRowKeyDown(event, index)}
                  />
                  <NumberInput
                    value={row.weightKg}
                    aria-label={`${t('product.variants.col.weight')} ${index + 1}`}
                    style={{ marginTop: rem(4) }}
                    onChange={(event) =>
                      setRow(index, { weightKg: event.target.value.replace(/[^0-9.]/g, '') })
                    }
                    onKeyDown={(event) => onRowKeyDown(event, index)}
                  />
                  <button
                    type="button"
                    className="ob-btn ob-btn--ghost"
                    aria-label={t('product.variants.remove', { label: row.label || String(index + 1) })}
                    title={t('product.variants.remove', { label: row.label || String(index + 1) })}
                    style={{ padding: 0, minWidth: rem(28), marginTop: rem(4) }}
                    disabled={rows.length === 1}
                    onClick={() => setRows((current) => current.filter((_, at) => at !== index))}
                  >
                    ✕
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

        <FieldGroup title={t('product.group.sizeGrade')}>
          {text('size', t('product.field.size'))}
          {text('grade', t('product.field.grade'))}
        </FieldGroup>

        {liveProduct && (
          <FieldGroup title={t('product.group.photos')}>
            <Field label={t('product.field.images')} span={3}>
              {() => (
                <ProductImages product={liveProduct} onChanged={setLiveProduct} onError={onError} />
              )}
            </Field>
          </FieldGroup>
        )}
      </div>
    </Modal>
  );
}

const VARIANT_GRID = `minmax(0, 1.4fr) minmax(0, 1fr) ${rem(120)} ${rem(28)}`;
