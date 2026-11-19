/**
 * One sub product, on one screen, in two states.
 *
 * Opening a sub product shows this screen read-only: photos in the rail, the
 * facts on the right. "Edit sub product" turns the same screen into its form —
 * same place, same rail, same order of fields — and Save or Cancel turns it
 * back. There is no second layout to learn and no dialog: the record and the
 * form are one screen, so what is being edited is always the thing on screen.
 *
 * The rail holds what is about the record rather than in it — its photos, how
 * it prints, what a line starts with, and the one destructive action, with its
 * own explanation. The right column is the record itself.
 *
 * Writes go through `CatalogueTransport.updateProduct`, the same call the
 * drawer and the route make; validation is `validateProductInput`, the same
 * rules the Master applies. A refused save names the field through `onError`.
 *
 * `ProductDetail` (view) and `ProductEditScreen` (the edit route) both render
 * this, which is why there is exactly one field set for a sub product.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  OptionListItem,
  PrintSideSetting,
  Product,
  ProductCategory,
  ProductInput,
} from '@orderbook/shared';
import { ProductValidationError, validateProductInput } from '@orderbook/shared';

import { Button } from './Button.js';
import { byCatalogueOrder, codesOf, productLabel, shownColours, weightLabel } from './catalogueSummary.js';
import type { CatalogueTransport } from './catalogueSummary.js';
import { Card } from './Card.js';
import { ColourName, ColourChip, StatusPill } from './DataDisplay.js';
import { apiErrorText } from './errorText.js';
import { FormField, Input, NumberInput } from './Form.js';
import { t } from './i18n.js';
import { useCommand } from './KeyboardProvider.js';
import { ProductImages } from './ProductImages.js';
import { rem } from './rem.js';
import { Segmented } from './Tabs.js';
import { printSideLabel, printSideOptions } from './printSide.js';
import { Select, SuggestInput } from './SuggestInput.js';
import { useFormBaseline, useUnsavedWork } from './unsavedWork.js';
import { useEnterToAdvance } from './useEnterToAdvance.js';

export type ProductRecordMode = 'view' | 'edit';

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

export interface ProductRecordScreenProps {
  product: Product;
  transport: CatalogueTransport;
  colourHex: (colour: string) => string | undefined;
  /** `products.edit`: the Edit action, and the photo controls on the rail. */
  canEdit: boolean;
  mode: ProductRecordMode;
  /** View only: switch this screen into its form. */
  onEdit?: () => void;
  /** Edit only: the record was saved; the caller refetches and returns to view. */
  onSaved?: (name: string) => void;
  /** Edit only: abandon the draft and return to view. */
  onCancel?: () => void;
  /** `products.delete`: the Danger zone card; absent without it. */
  onDelete?: () => void;
  /** The categories the product picker offers — the record's own product on top. */
  categories?: ProductCategory[];
  /** The option lists for colours and packaging; both pickers read them. */
  optionLists?: OptionListItem[];
  /** The snapshot clocks an offline-capable panel merges with; the Master omits it. */
  baseFieldHlc?: Record<string, string>;
  onPhotosChanged: (product: Product) => void;
  onError: (message: string) => void;
  /** Edit only: whether the draft differs from the record, for Back's guard. */
  onDirtyChange?: (dirty: boolean) => void;
}

export function ProductRecordScreen({
  product,
  transport,
  colourHex,
  canEdit,
  mode,
  onEdit,
  onSaved,
  onCancel,
  onDelete,
  categories = [],
  optionLists = [],
  baseFieldHlc,
  onPhotosChanged,
  onError,
  onDirtyChange,
}: ProductRecordScreenProps) {
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [colours, setColours] = useState<string[]>([]);
  const [printSide, setPrintSide] = useState<PrintSideSetting>('default');
  const [defaultPackaging, setDefaultPackaging] = useState('');
  const [busy, setBusy] = useState(false);
  const baseline = useFormBaseline<unknown>();
  const fields = useRef<HTMLDivElement>(null);

  const set = (field: keyof Draft, value: string): void =>
    setDraft((current) => ({ ...current, [field]: value }));

  const setColour = (index: number, value: string): void =>
    setColours((current) => current.map((colour, at) => (at === index ? value : colour)));

  // Keyed on the record, not the object: a field arriving through the event
  // stream must not wipe a half-typed draft.
  useEffect(() => {
    if (mode !== 'edit') return;
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
      defaultPackaging: product.defaultPackaging ?? '',
    };
    baseline.mark(loaded);
    setDraft(loaded.draft);
    setColours(loaded.colours);
    setPrintSide(loaded.printSide);
    setDefaultPackaging(loaded.defaultPackaging);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, product.id]);

  const dirty =
    mode === 'edit' && baseline.dirty({ draft, colours, printSide, defaultPackaging });

  useEffect(() => {
    onDirtyChange?.(Boolean(dirty));
  }, [dirty, onDirtyChange]);

  useEnterToAdvance(fields, () => void save(), mode === 'edit');
  useCommand('record.save', mode === 'edit' && !busy ? () => void save() : null);

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
      defaultPackaging: defaultPackaging || null,
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
      onSaved?.(name);
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
    dirty ? { label: t('updates.saveAll.product', { name: draft.name.trim() || '…' }), save } : null,
  );

  const products =
    categories.length > 0
      ? categories
          .filter((category) => !category.deletedAt || category.id === product.categoryId)
          .sort(byCatalogueOrder)
      : [];
  const chosen = categories.find((category) => category.id === draft.categoryId) ?? null;

  const colourOptions = optionLists
    .filter((option) => option.listKey === 'stock.colour' && option.isActive)
    .map((option) => ({ value: option.value, label: option.label }));

  const packagingOptions = optionLists
    .filter((option) => option.listKey === 'line.packaging' && option.isActive)
    .map((option) => ({ value: option.value, label: option.label }));

  function focusColourRow(index: number): void {
    fields.current?.querySelector<HTMLInputElement>(`[data-colour-row="${index}"] input`)?.focus();
  }

  const editing = mode === 'edit';
  const weight = weightLabel(product);

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: 'var(--s-20)',
      }}
    >
      {/* The rail: what is about the record rather than in it. */}
      <div
        style={{
          flex: `0 1 ${rem(340)}`,
          minWidth: rem(260),
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-16)',
        }}
      >
        <ProductImages
          product={product}
          transport={transport}
          canEdit={canEdit && !editing}
          onChanged={onPhotosChanged}
          onError={onError}
        />

        <RecordCard title={t('product.printSide.label')}>
          {editing ? (
            <>
              <Segmented<PrintSideSetting>
                value={printSide}
                label={t('product.printSide.label')}
                options={printSideOptions()}
                onChange={setPrintSide}
              />
              <p className="ob-small" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
                {t('product.printSide.hint')}
              </p>
            </>
          ) : (
            <ReadValue>{printSideLabel(product.printSide)}</ReadValue>
          )}
        </RecordCard>

        <RecordCard title={t('product.defaultPackaging.label')}>
          {editing ? (
            <>
              <select
                className="ob-input"
                aria-label={t('product.defaultPackaging.label')}
                value={defaultPackaging}
                onChange={(event) => setDefaultPackaging(event.target.value)}
              >
                <option value="">{t('product.defaultPackaging.none')}</option>
                {packagingOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="ob-small" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
                {t('product.defaultPackaging.hint')}
              </p>
            </>
          ) : (
            <ReadValue>{product.defaultPackaging ?? '—'}</ReadValue>
          )}
        </RecordCard>

        {onDelete && (
          <RecordCard title={t('product.danger.title')} tone="danger">
            <p className="ob-small" style={{ margin: 0, color: 'var(--fg-secondary)' }}>
              {t('catalog.subProducts.delete.body')}
            </p>
            <div>
              <Button variant="danger" size="sm" icon="trash" onClick={onDelete}>
                {t('catalog.subProducts.delete')}
              </Button>
            </div>
          </RecordCard>
        )}
      </div>

      {/* The record. */}
      <div
        ref={fields}
        style={{
          flex: `1 1 ${rem(480)}`,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-16)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--s-8)' }}>
          {editing ? (
            <>
              <Button variant="secondary" onClick={onCancel}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" busy={busy} onClick={() => void save()}>
                {busy ? t('product.saving') : t('product.saveChanges')}
              </Button>
            </>
          ) : (
            canEdit &&
            onEdit && (
              <Button variant="primary" icon="edit" onClick={onEdit}>
                {t('product.detail.editAction')}
              </Button>
            )
          )}
        </div>

        <RecordCard title={t('product.group.identity')}>
          <div style={GRID}>
            <div style={{ gridColumn: '1 / -1' }}>
              {editing ? (
                <FormField label={t('product.field.name')} required>
                  {(id) => (
                    <Input
                      id={id}
                      value={draft.name}
                      autoFocus
                      onChange={(event) => set('name', event.target.value)}
                    />
                  )}
                </FormField>
              ) : (
                <ReadField label={t('product.field.name')} value={product.name} strong />
              )}
            </div>

            {editing ? (
              <FormField
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
              </FormField>
            ) : (
              <ReadField label={t('product.field.category')} value={productLabel(product.categoryName)} />
            )}

            {editing ? (
              <FormField label={t('product.field.brand')} hint={t('product.field.brandHint')}>
                {(id) => <Input id={id} value={chosen?.brand ?? ''} disabled />}
              </FormField>
            ) : (
              <ReadField label={t('product.field.brand')} value={product.brand} />
            )}

            {editing ? (
              <FormField label={t('product.field.alias')}>
                {(id) => (
                  <Input
                    id={id}
                    value={draft.alias}
                    onChange={(event) => set('alias', event.target.value)}
                  />
                )}
              </FormField>
            ) : (
              <ReadField label={t('product.field.alias')} value={product.alias} />
            )}

            {editing ? (
              <FormField label={t('product.field.size')}>
                {(id) => (
                  <Input
                    id={id}
                    value={draft.size}
                    placeholder={t('product.field.sizePlaceholder')}
                    onChange={(event) => set('size', event.target.value)}
                  />
                )}
              </FormField>
            ) : (
              <ReadField label={t('product.field.size')} value={product.size} />
            )}
          </div>
        </RecordCard>

        <RecordCard title={t('product.group.codes')}>
          <div style={GRID}>
            {editing ? (
              <FormField label={t('product.field.code')} required>
                {(id) => (
                  <Input
                    id={id}
                    className="ob-mono"
                    value={draft.code}
                    onChange={(event) => set('code', event.target.value)}
                  />
                )}
              </FormField>
            ) : (
              <ReadField
                label={t('product.field.code')}
                value={<span className="ob-mono ob-body-strong">{codesOf(product)}</span>}
              />
            )}

            {editing ? (
              <FormField label={t('product.field.weight')} hint={t('product.field.weightHint')}>
                {(id) => (
                  <NumberInput
                    id={id}
                    value={draft.weightKg}
                    onChange={(event) =>
                      set('weightKg', event.target.value.replace(/[^0-9.]/g, ''))
                    }
                  />
                )}
              </FormField>
            ) : (
              <ReadField
                label={t('product.field.weight')}
                value={
                  weight === null ? (
                    <StatusPill tone="offline">{t('product.weight.missing')}</StatusPill>
                  ) : (
                    weight
                  )
                }
              />
            )}
          </div>
        </RecordCard>

        <RecordCard title={t('product.group.colours')}>
          {editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: rem(6) }}>
              {colours.map((colour, index) => (
                <div
                  key={index}
                  data-colour-row={index}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `minmax(0, 1fr) ${rem(32)}`,
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
          ) : (
            <ReadValue>
              <ProductColours product={product} colourHex={colourHex} />
            </ReadValue>
          )}
        </RecordCard>
      </div>
    </div>
  );
}

const GRID = {
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fit, minmax(${rem(200)}, 1fr))`,
  gap: 'var(--s-16) var(--s-20)',
  alignItems: 'start',
} as const;

function RecordCard({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: 'danger';
  children: ReactNode;
}) {
  return (
    <Card padded={false}>
      <div
        style={{
          padding: 'var(--s-12) var(--s-16)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <h3
          className="ob-body-strong"
          style={{
            margin: 0,
            fontSize: rem(15),
            color: tone === 'danger' ? 'var(--state-conflict)' : undefined,
          }}
        >
          {title}
        </h3>
      </div>
      <div
        style={{
          padding: 'var(--s-16)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-12)',
          alignItems: 'stretch',
        }}
      >
        {children}
      </div>
    </Card>
  );
}

function ReadField({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: ReactNode;
  strong?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: rem(4), minWidth: 0 }}>
      <span className="ob-label">{label}</span>
      <ReadValue strong={strong}>{value}</ReadValue>
    </div>
  );
}

function ReadValue({ children, strong = false }: { children: ReactNode; strong?: boolean }) {
  const isEmpty = children === null || children === undefined || children === '';
  if (isEmpty) {
    return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
  }
  return (
    <span
      className={strong ? 'ob-body-strong' : undefined}
      style={{ minWidth: 0, overflowWrap: 'anywhere' }}
    >
      {children}
    </span>
  );
}

/**
 * A sub product's colour, shown by the catalogue's rule: "Multicolour" when it
 * offers several, its one colour (swatch and all when the range has a hex),
 * and nothing for a numbered design that offers none.
 */
export function ProductColours({
  product,
  colourHex,
}: {
  product: Product;
  colourHex: (colour: string) => string | undefined;
}) {
  if (product.colours.length > 1) {
    return <StatusPill tone="accent">{t('catalog.colourRule.multicolour')}</StatusPill>;
  }
  const colours = shownColours(product);
  if (colours.length === 0) return null;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 'var(--s-8)', minWidth: 0 }}>
      {colours.map((colour) => {
        const hex = colourHex(colour);
        return hex ? (
          <ColourName key={colour} name={colour} hex={hex} />
        ) : (
          <span key={colour}>{colour}</span>
        );
      })}
    </span>
  );
}
