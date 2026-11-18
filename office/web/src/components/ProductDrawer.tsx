/**
 * Create or edit a product without leaving the Catalog screen.
 *
 * A product is a **model in a category** carrying its own code, weight, the
 * colours it is offered in and its print side. The form says so in its
 * shape: one code-and-weight pair, a list of colours (none, one, or several
 * the counter picks from in a dropdown), and a Default / Left / Right print
 * side. Nothing else on the form knows about codes.
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
 * That is the whole form: name, product, alias, size, code and weight, the
 * colours and the print side. The product master carries nothing else
 * (2026-09-21).
 *
 * The name is kept for its call sites; it is a modal.
 */

import { useEffect, useRef, useState } from 'react';
import type {
  OptionListItem,
  PrintSideSetting,
  Product,
  ProductCategory,
  ProductInput,
} from '@orderbook/shared';
import { ProductValidationError, validateProductInput } from '@orderbook/shared';

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
  printSideOptions,
  Segmented,
  Select,
  SuggestInput,
  rem,
  t,
  useColourHex,
  useCommand,
  useEnterToAdvance,
  useFormBaseline,
  useUnsavedWork,
} from '@orderbook/ui';

export interface CreatedProduct {
  id: string;
  name: string;
  /** The sub product's code — what the catalogue shows. */
  code: string;
}

interface ProductDrawerProps {
  open: boolean;
  product?: Product | null;
  /** The categories (the owner's products) this panel holds, for the product picker. */
  categories: ProductCategory[];
  /** For the colour swatch beside a colour (`stock.colour`). */
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
  code: '',
  weightKg: '',
};

type Draft = typeof EMPTY;

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
  const [colours, setColours] = useState<string[]>([]);
  const [printSide, setPrintSide] = useState<PrintSideSetting>('default');
  const [busy, setBusy] = useState(false);
  const baseline = useFormBaseline<unknown>();

  const set = (field: keyof Draft, value: string): void =>
    setDraft((current) => ({ ...current, [field]: value }));

  const setColour = (index: number, value: string): void =>
    setColours((current) => current.map((colour, at) => (at === index ? value : colour)));

  // Live products only, in catalogue order — the order the printed catalogue
  // and the lead screen's product bar use.
  const products = categories.filter((category) => !category.deletedAt).sort(byCatalogueOrder);
  const chosen = categories.find((category) => category.id === draft.categoryId) ?? null;

  useEffect(() => {
    if (!open) return;

    const loaded = editing
      ? {
          draft: {
            name: editing.name,
            categoryId: editing.categoryId,
            alias: editing.alias ?? '',
            size: editing.size ?? '',
            code: editing.code,
            weightKg: editing.weightKg != null ? String(editing.weightKg) : '',
          },
          colours: [...editing.colours],
          printSide: editing.printSide,
        }
      : { draft: EMPTY, colours: [] as string[], printSide: 'default' as PrintSideSetting };
    baseline.mark(loaded);
    setDraft(loaded.draft);
    setColours(loaded.colours);
    setPrintSide(loaded.printSide);

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

  /** True when the product was saved; false when it was refused or failed (the reason went to `onError`). */
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
      code: draft.code.trim() || null,
      weightKg: toNumber(draft.weightKg),
      colours: colours.map((colour) => colour.trim()).filter(Boolean),
      printSide,
    };

    // The same rules the Master applies, so the refusal is immediate and
    // names the problem rather than arriving as a 400 after the round trip.
    try {
      validateProductInput(input);
    } catch (caught) {
      onError(caught instanceof ProductValidationError ? t(caught.messageKey) : String(caught));
      return false;
    }

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
        onCreated?.({ id: result.id, name, code: draft.code.trim() });
        setDraft(EMPTY);
        baseline.mark({ draft: EMPTY, colours, printSide });
      }
      return true;
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('product.createFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // "Save all and update": a product form with something typed in it is saved if it
  // is complete, and named if it is not.
  useUnsavedWork(
    'product-form',
    open && baseline.dirty({ draft, colours, printSide })
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

  function focusColourRow(index: number): void {
    fields.current?.querySelector<HTMLInputElement>(`[data-colour-row="${index}"] input`)?.focus();
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
          <Field
            label={t('product.field.category')}
            required
            hint={t('product.field.categoryHint')}
          >
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
          {text('size', t('product.field.size'), {
            placeholder: t('product.field.sizePlaceholder'),
          })}
        </FieldGroup>

        <FieldGroup title={t('product.group.codes')}>
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
          <Field label={t('product.printSide.label')} span={3}>
            {() => (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 'var(--s-12)',
                }}
              >
                <Segmented<PrintSideSetting>
                  value={printSide}
                  options={printSideOptions()}
                  onChange={(next) => setPrintSide(next)}
                />
                <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                  {t('product.printSide.hint')}
                </span>
              </div>
            )}
          </Field>
        </FieldGroup>

        <FieldGroup title={t('product.group.colours')}>
          <div
            style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: rem(6) }}
          >
            {colours.length > 0 && (
              <div
                className="ob-eyebrow"
                style={{
                  display: 'grid',
                  gridTemplateColumns: COLOUR_GRID,
                  gap: '0 var(--s-12)',
                  color: 'var(--fg-tertiary)',
                }}
              >
                <span>{t('product.colours.col.label')}</span>
                <span />
              </div>
            )}
            {colours.map((colour, index) => (
              <div
                key={index}
                data-colour-row={index}
                style={{
                  display: 'grid',
                  gridTemplateColumns: COLOUR_GRID,
                  gap: '0 var(--s-12)',
                  alignItems: 'center',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: rem(8), minWidth: 0 }}>
                  <ColourChip hex={colourHex(colour)} name={colour || '—'} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <SuggestInput
                      value={colour}
                      placeholder={t('product.colours.labelPlaceholder')}
                      optionsLabel={t('lead.add.draft.showOptions', {
                        field: t('product.colours.col.label'),
                      })}
                      options={colourOptions}
                      onChange={(next) => setColour(index, next)}
                    />
                  </span>
                </span>
                <button
                  type="button"
                  className="ob-btn ob-btn--ghost"
                  aria-label={t('product.colours.remove', {
                    label: colour || String(index + 1),
                  })}
                  title={t('product.colours.remove', { label: colour || String(index + 1) })}
                  style={{ padding: 0, minWidth: rem(32), justifyContent: 'center' }}
                  onClick={() => setColours((current) => current.filter((_, at) => at !== index))}
                >
                  ✕
                </button>
              </div>
            ))}
            <span style={{ display: 'flex', gap: 'var(--s-8)' }}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setColours((current) => [...current, '']);
                  window.setTimeout(() => focusColourRow(colours.length), 0);
                }}
              >
                {t('product.colours.add')}
              </Button>
              {colourOptions.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setColours(colourOptions.map((option) => option.value))}
                >
                  {t('product.colours.all')}
                </Button>
              )}
            </span>
            <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
              {t('product.colours.hint')}
            </span>
          </div>
        </FieldGroup>
      </div>
    </Modal>
  );
}

const COLOUR_GRID = `minmax(0, 1fr) ${rem(32)}`;
