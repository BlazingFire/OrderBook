/**
 * Create or edit a product without leaving the Catalog screen.
 *
 * A product is a **model in a category** with one or more **variants**, and
 * every variant owns a code, a colour and a weight. The form says so in its
 * shape: the *Codes & weight* group is a switch — "Does this product come in
 * variants?" — and either one code-and-weight pair (No) or a table of colour ·
 * code · weight rows (Yes). Nothing else on the form knows about codes.
 *
 * In the owner's words the record is a **sub product** and its category is its
 * **product** (`docs/catalogue/CATALOGUE_MODEL.md` §1). The product is
 * **pick-only**, from the products this panel holds, each read the way the
 * catalogue writes it (`One Piece Toilet · Swisware+`). It used to be a
 * suggest field whose unmatched name created a category on the Master, so a
 * typo became a new product with no code and no brand; products are made on
 * the Products page now, where a code and a brand are asked for. Required,
 * because the lead screen finds a sub product through its product first.
 *
 * The brand shows beneath it, read-only: brand lives on the product and is
 * read through it, so there is nothing to set here, and a sub product moves
 * brand only by moving product.
 *
 * *Made in every colour* is the second switch. Some models are made in any
 * colour of the company's colour list ("all colours available in all items"
 * in the catalogue), and nobody wants sixteen variants per model to say so:
 * with it on, a lead line on this product may name a colour from the list.
 *
 * The two switches are also what the catalogue's colour rule is read from
 * (§2) — multi-colour is "Multicolour", one labelled variant is a fixed
 * colour, one unlabelled variant is a numbered design — so the form needs no
 * rule picker of its own.
 *
 * That is the whole form: name, product, alias, size, the variants and the
 * colour switch. The product master carries nothing else (2026-09-21).
 *
 * The name is kept for its call sites; it is a modal.
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

import { api } from '../api';
import { byCatalogueOrder, productLabel } from '../productSummary';
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

export interface CreatedProduct {
  id: string;
  name: string;
  /** The first variant's code — what the catalogue shows for a one-form product. */
  code: string;
}

interface ProductDrawerProps {
  open: boolean;
  product?: Product | null;
  /** The categories (the owner's products) this panel holds, for the product picker. */
  categories: ProductCategory[];
  /** For the colour swatch beside a variant colour (`stock.colour`). */
  optionLists: OptionListItem[];
  onClose: () => void;
  onCreated?: (product: CreatedProduct) => void;
  onUpdated?: (name: string) => void;
  onError: (message: string) => void;
}

/** Every editable model-level column, so the form and the record cannot drift apart. */
const EMPTY = {
  name: '',
  categoryId: '',
  alias: '',
  size: '',
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

function toNumber(value: string): number | null {
  return value.trim() ? Number(value) : null;
}

export function ProductDrawer({
  open,
  product,
  categories,
  optionLists,
  onClose,
  onCreated,
  onUpdated,
  onError,
}: ProductDrawerProps) {
  const editing = product ?? null;
  const colourHex = useColourHex(optionLists);

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [hasVariants, setHasVariants] = useState(false);
  const [multiColour, setMultiColour] = useState(false);
  const [rows, setRows] = useState<VariantRow[]>([EMPTY_ROW]);
  const [busy, setBusy] = useState(false);

  const set = (field: keyof Draft, value: string): void =>
    setDraft((current) => ({ ...current, [field]: value }));

  const setRow = (index: number, patch: Partial<VariantRow>): void =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  // Live products only, in catalogue order — the order the printed catalogue
  // and the lead screen's product bar use.
  const products = categories.filter((category) => !category.deletedAt).sort(byCatalogueOrder);
  const chosen = categories.find((category) => category.id === draft.categoryId) ?? null;

  useEffect(() => {
    if (!open) return;

    if (editing) {
      const single = editing.variants[0];
      setDraft({
        name: editing.name,
        categoryId: editing.categoryId,
        alias: editing.alias ?? '',
        size: editing.size ?? '',
        code: !editing.hasVariants && single ? single.code : '',
        weightKg: !editing.hasVariants && single?.weightKg != null ? String(single.weightKg) : '',
      });
      setHasVariants(editing.hasVariants);
      setMultiColour(editing.multiColour);
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
      setMultiColour(false);
      setRows([EMPTY_ROW]);
    }

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

    if (!name) {
      onError(t('product.nameRequired'));
      return;
    }
    if (!draft.categoryId) {
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
      // The id decides on the Master. The name, code and brand ride along
      // only so a sub product created offline shows under its product in the
      // list before the Master has answered (`provisionalProduct`).
      categoryId: draft.categoryId,
      categoryName: chosen?.name ?? null,
      categoryCode: chosen?.code ?? null,
      categoryBrand: chosen?.brand ?? null,
      alias: text('alias'),
      size: text('size'),
      multiColour,
      hasVariants,
      variants,
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

  const colourOptions = optionLists
    .filter((option) => option.listKey === 'stock.colour' && option.isActive)
    .map((option) => ({ value: option.value, label: option.label }));

  /**
   * Enter on a row's **last cell**: on to the next row, a new row after the
   * last, or the save when the last row is still blank. Left to the walk,
   * Enter on the last weight would save a half-typed table.
   *
   * The row's other two cells are deliberately not wired to this. It used to
   * sit on all three, which meant Enter anywhere in a row jumped to the *next*
   * row — so colour → code → weight could only be walked with Tab, and Enter
   * on the colour of a single blank row ran the save and answered with a
   * validation error about the code nobody had reached yet. Colour and code
   * are ordinary steps of `useEnterToAdvance`, which walks them in DOM order;
   * only the end of a row is this function's business.
   */
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
                    <ColourChip hex={colourHex(row.label)} name={row.label || '—'} />
                    <span style={{ flex: 1, minWidth: 0 }}>
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
                    aria-label={t('product.variants.remove', { label: row.label || String(index + 1) })}
                    title={t('product.variants.remove', { label: row.label || String(index + 1) })}
                    style={{ padding: 0, minWidth: rem(32), justifyContent: 'center' }}
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

        <FieldGroup title={t('product.group.colours')}>
          <Field label={t('product.multiColour.label')} span={3}>
            {() => (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--s-12)' }}>
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
      </div>
    </Modal>
  );
}

const VARIANT_GRID = `minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) ${rem(32)}`;
