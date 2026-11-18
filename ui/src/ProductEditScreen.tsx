/**
 * Edit a product on its own screen, without a modal.
 *
 * Route based editing for the catalogue: the Products screen mounts this inside
 * an EditorScreen when the sub product edit route is open, and the list behind
 * it no longer opens the ProductDrawer modal for editing. The field set, the
 * order of the groups and the validation are the same as the drawer, so a form
 * learned once works in both places: name, product, alias, size, its own code
 * and weight, the colours it is offered in, and its print side. Saving goes
 * through the same transport updateProduct call, which reaches
 * catalog.service updateProduct, and failures show the same translated message.
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
import { printSideOptions } from './printSide.js';
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
  const [colours, setColours] = useState<string[]>([]);
  const [printSide, setPrintSide] = useState<PrintSideSetting>('default');
  const [busy, setBusy] = useState(false);
  const baseline = useFormBaseline<unknown>();

  const set = (field: keyof Draft, value: string): void =>
    setDraft((current) => ({ ...current, [field]: value }));

  const setColour = (index: number, value: string): void =>
    setColours((current) => current.map((colour, at) => (at === index ? value : colour)));

  const products = categories.filter((category) => !category.deletedAt).sort(byCatalogueOrder);
  const chosen = categories.find((category) => category.id === draft.categoryId) ?? null;

  useEffect(() => {
    const loaded = {
      draft: {
        name: product.name,
        categoryId: product.categoryId,
        alias: product.alias ?? '',
        size: product.size ?? '',
        code: product.code,
        weightKg: product.weightKg != null ? String(product.weightKg) : '',
      },
      colours: [...product.colours],
      printSide: product.printSide,
    };
    baseline.mark(loaded);
    setDraft(loaded.draft);
    setColours(loaded.colours);
    setPrintSide(loaded.printSide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  const fields = useRef<HTMLDivElement>(null);
  useEnterToAdvance(fields, () => void save(), true);
  useCommand('record.save', !busy ? () => void save() : null);

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
      categoryId: draft.categoryId,
      alias: text('alias'),
      size: text('size'),
      code: draft.code.trim() || null,
      weightKg: toNumber(draft.weightKg),
      colours: colours.map((colour) => colour.trim()).filter(Boolean),
      printSide,
    };
    try {
      validateProductInput(input);
    } catch (caught) {
      onError(caught instanceof ProductValidationError ? t(caught.messageKey) : String(caught));
      return false;
    }
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
    baseline.dirty({ draft, colours, printSide })
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

  function focusColourRow(index: number): void {
    fields.current?.querySelector<HTMLInputElement>(`[data-colour-row="${index}"] input`)?.focus();
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
                <ColourChip hex={colourHex(colour)} name={colour || '…'} />
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
                {'\u00D7'}
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

const COLOUR_GRID = `minmax(0, 1fr) ${rem(32)}`;
