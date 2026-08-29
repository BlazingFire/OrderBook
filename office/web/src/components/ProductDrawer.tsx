/**
 * Create or edit a product without leaving the Catalog screen.
 *
 * **Twenty-two fields, in five labelled groups.** The form used to offer eight
 * of a product's columns; the other fourteen — every ceramic and trade
 * attribute the owner asked for — had no way in at all, so a shade or a PEI
 * rating could only be recorded by writing it somewhere it did not belong. The
 * field coverage is the change that matters here; the container being a centred
 * modal rather than a right-hand drawer follows the standing rule and is
 * secondary.
 *
 * The name is kept for its call sites; it is a modal now.
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
import type { Product } from '@orderbook/shared';
import { PRODUCT_APPLICATIONS, PRODUCT_EDGE_TYPES, PRODUCT_UOMS } from '@orderbook/shared';

import { api } from '../api';
import {
  Button,
  Field,
  FieldGroup,
  Input,
  Modal,
  NumberInput,
  Select,
  t,
  useCommand,
  useEnterToAdvance,
} from '@orderbook/ui';
import { ProductImages } from './ProductImages';

export interface CreatedProduct {
  id: string;
  productCode: string;
  name: string;
}

interface ProductDrawerProps {
  open: boolean;
  product?: Product | null;
  onClose: () => void;
  onCreated?: (product: CreatedProduct) => void;
  onUpdated?: (name: string) => void;
  onError: (message: string) => void;
}

/** Every editable column, so the form and the record cannot drift apart. */
const EMPTY = {
  productCode: '',
  name: '',
  alias: '',
  productType: '',
  series: '',
  size: '',
  grade: '',
  finish: '',
  color: '',
  hsnCode: '',
  rate: '',
  mrp: '',
  purchaseRate: '',
  gstRatePct: '',
  uom: 'box',
  barcode: '',
  brand: '',
  weightKg: '',
  piecesPerBox: '',
  boxCoverageSqft: '',
  thicknessMm: '',
  shade: '',
  calibre: '',
  waterAbsorptionPct: '',
  peiRating: '',
  edgeType: '',
  surfaceTexture: '',
  application: '',
  originPlant: '',
};

type Draft = typeof EMPTY;

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
  onClose,
  onCreated,
  onUpdated,
  onError,
}: ProductDrawerProps) {
  const editing = product ?? null;

  const [draft, setDraft] = useState<Draft>(EMPTY);
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

    setDraft(
      editing
        ? {
            productCode: editing.productCode,
            name: editing.name,
            alias: editing.alias ?? '',
            productType: editing.productType ?? '',
            series: editing.series ?? '',
            size: editing.size ?? '',
            grade: editing.grade ?? '',
            finish: editing.finish ?? '',
            color: editing.color ?? '',
            hsnCode: editing.hsnCode ?? '',
            rate: fromPaise(editing.rate),
            mrp: fromPaise(editing.mrp),
            purchaseRate: fromPaise(editing.purchaseRate),
            gstRatePct: editing.gstRatePct != null ? String(editing.gstRatePct) : '',
            uom: editing.uom || 'box',
            barcode: editing.barcode ?? '',
            brand: editing.brand ?? '',
            weightKg: editing.weightKg != null ? String(editing.weightKg) : '',
            piecesPerBox: editing.piecesPerBox != null ? String(editing.piecesPerBox) : '',
            boxCoverageSqft: editing.boxCoverageSqft != null ? String(editing.boxCoverageSqft) : '',
            thicknessMm: editing.thicknessMm != null ? String(editing.thicknessMm) : '',
            shade: editing.shade ?? '',
            calibre: editing.calibre ?? '',
            waterAbsorptionPct:
              editing.waterAbsorptionPct != null ? String(editing.waterAbsorptionPct) : '',
            peiRating: editing.peiRating != null ? String(editing.peiRating) : '',
            edgeType: editing.edgeType ?? '',
            surfaceTexture: editing.surfaceTexture ?? '',
            application: editing.application ?? '',
            originPlant: editing.originPlant ?? '',
          }
        : EMPTY,
    );

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

  async function save(): Promise<void> {
    const productCode = draft.productCode.trim();
    const name = draft.name.trim();

    if (!productCode) {
      onError(t('product.codeRequired'));
      return;
    }
    if (!name) {
      onError(t('product.nameRequired'));
      return;
    }

    const text = (field: keyof Draft): string | null => draft[field].trim() || null;

    const input = {
      productCode,
      name,
      alias: text('alias'),
      productType: text('productType'),
      series: text('series'),
      size: text('size'),
      grade: text('grade'),
      finish: text('finish'),
      color: text('color'),
      hsnCode: text('hsnCode'),
      rate: toPaise(draft.rate),
      mrp: toPaise(draft.mrp),
      gstRatePct: toNumber(draft.gstRatePct),
      uom: draft.uom,
      barcode: text('barcode'),
      brand: text('brand'),
      weightKg: toNumber(draft.weightKg),
      piecesPerBox: toNumber(draft.piecesPerBox),
      boxCoverageSqft: toNumber(draft.boxCoverageSqft),
      thicknessMm: toNumber(draft.thicknessMm),
      shade: text('shade'),
      calibre: text('calibre'),
      waterAbsorptionPct: toNumber(draft.waterAbsorptionPct),
      peiRating: toNumber(draft.peiRating),
      edgeType: text('edgeType'),
      surfaceTexture: text('surfaceTexture'),
      application: text('application'),
      originPlant: text('originPlant'),
      // Sent only when the field was rendered. Sending `null` for a hidden
      // field would clear a cost this person was never shown.
      ...(canSeeCost ? { purchaseRate: toPaise(draft.purchaseRate) } : {}),
    };

    setBusy(true);
    try {
      if (editing) {
        await api.updateProduct(editing.id, input);
        onUpdated?.(name);
      } else {
        const result = await api.createProduct(input);
        onCreated?.({ id: result.id, productCode, name });
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
          <Field label={t('product.field.code')} required>
            {(id) => (
              <Input
                id={id}
                value={draft.productCode}
                autoFocus
                className="ob-mono"
                onChange={(event) => set('productCode', event.target.value)}
              />
            )}
          </Field>
          <Field label={t('product.field.name')} required span={2}>
            {(id) => (
              <Input
                id={id}
                value={draft.name}
                onChange={(event) => set('name', event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void save();
                }}
              />
            )}
          </Field>
          {text('alias', t('product.field.alias'))}
          {text('brand', t('product.field.brand'))}
          {text('productType', t('product.field.type'))}
          {text('series', t('product.field.series'))}
          {text('barcode', t('product.field.barcode'), { className: 'ob-mono' })}
        </FieldGroup>

        <FieldGroup title={t('product.group.pricing')}>
          {numeric('rate', t('product.field.rate'), t('product.field.rateHint'))}
          {numeric('mrp', t('product.field.mrp'))}
          {canSeeCost &&
            numeric(
              'purchaseRate',
              t('product.field.purchaseRate'),
              t('product.field.purchaseRateHint'),
            )}
          {numeric('gstRatePct', t('product.field.gstRate'))}
          {text('hsnCode', t('product.field.hsnCode'), { className: 'ob-mono' })}
        </FieldGroup>

        <FieldGroup title={t('product.group.packing')}>
          {choice(
            'uom',
            t('product.field.uom'),
            PRODUCT_UOMS,
            (value) => t(`product.uom.${value}` as never),
            false,
          )}
          {numeric('piecesPerBox', t('product.field.piecesPerBox'))}
          {numeric('boxCoverageSqft', t('product.field.boxCoverage'))}
          {numeric('weightKg', t('product.field.weight'))}
        </FieldGroup>

        <FieldGroup title={t('product.group.spec')}>
          {text('size', t('product.field.size'))}
          {numeric('thicknessMm', t('product.field.thickness'))}
          {text('grade', t('product.field.grade'))}
          {text('finish', t('product.field.finish'))}
          {text('color', t('product.field.color'))}
          {text('shade', t('product.field.shade'))}
          {text('surfaceTexture', t('product.field.surfaceTexture'))}
          {text('calibre', t('product.field.calibre'))}
          {numeric('waterAbsorptionPct', t('product.field.waterAbsorption'))}
          {numeric('peiRating', t('product.field.peiRating'))}
          {choice('edgeType', t('product.field.edgeType'), PRODUCT_EDGE_TYPES, (value) =>
            t(`product.edge.${value}` as never),
          )}
          {choice('application', t('product.field.application'), PRODUCT_APPLICATIONS, (value) =>
            t(`product.application.${value}` as never),
          )}
          {text('originPlant', t('product.field.originPlant'))}
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
