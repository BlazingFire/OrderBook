/**
 * ProductDrawer — create a new product, or edit an existing one, without
 * leaving the Catalog screen.
 *
 * Same shape as `PartyDrawer` on purpose: `api.createProduct` already existed
 * (docs/UI_REDESIGN.md's Catalog slice) with no UI anywhere in the panel, so
 * this is that real, already-wired write path wrapped in the same
 * Drawer-based create-form pattern as the party flow. Edit mode was added
 * alongside the image pipeline (`7-IMAGE-PIPELINE.md`) — a product needs
 * somewhere to attach photos to, and there was no product detail/edit surface
 * anywhere in the panel before this.
 *
 *   open      — whether the drawer is open.
 *   product   — pass an existing product to edit it (title becomes "Edit
 *               product", the Images section appears, Save calls
 *               `api.updateProduct`); omit to create a new one.
 *   onClose   — called to dismiss without saving (Cancel, Esc, backdrop, the
 *               drawer's own close button). The draft is discarded.
 *   onCreated — called once `api.createProduct` resolves (create mode only).
 *               The product write is queued like every other write in this
 *               app, so the server only hands back a `QueuedResult` — an id,
 *               nothing else. `onCreated` is given that id plus the code and
 *               name the caller just typed.
 *   onUpdated — called once `api.updateProduct` resolves (edit mode only),
 *               with the caller-typed name for the confirmation toast — the
 *               full record arrives moments later through the event stream,
 *               same asymmetry as create.
 *   onError   — surfaces a failure through the caller's own error channel,
 *               same convention as every other screen in this panel.
 *
 * The rate field has no permission gate here: the Master ignores a rate from
 * anybody without `field.saleRate.edit` regardless of what the panel sends
 * (see AddLeadScreen), so a client-side gate would only be a courtesy — and
 * this screen isn't handed a `can()` to check in the first place.
 */

import { useEffect, useState } from 'react';
import type { Product } from '@orderbook/shared';

import { api } from '../api';
import { Button, Drawer, FormField, Input, NumberInput, t } from '@orderbook/ui';
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

export function ProductDrawer({
  open,
  product,
  onClose,
  onCreated,
  onUpdated,
  onError,
}: ProductDrawerProps) {
  const editing = product ?? null;

  const [productCode, setProductCode] = useState('');
  const [name, setName] = useState('');
  const [alias, setAlias] = useState('');
  const [productType, setProductType] = useState('');
  const [size, setSize] = useState('');
  const [grade, setGrade] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);
  // Local mirror of the editing product's `images[]`, patched in place as
  // uploads/reorders/deletes resolve — the merged `view` also updates a
  // moment later through the event stream, but waiting for that would mean
  // the thumbnail strip flickered blank between each action.
  const [liveProduct, setLiveProduct] = useState<Product | null>(editing);

  function fillFrom(source: Product): void {
    setProductCode(source.productCode);
    setName(source.name);
    setAlias(source.alias ?? '');
    setProductType(source.productType ?? '');
    setSize(source.size ?? '');
    setGrade(source.grade ?? '');
    setWeightKg(source.weightKg != null ? String(source.weightKg) : '');
    setRate(source.rate != null ? String(source.rate / 100) : '');
  }

  useEffect(() => {
    if (open && editing) fillFrom(editing);
    else if (open) reset();
    setLiveProduct(editing);
  }, [open, editing?.id]);

  function reset(): void {
    setProductCode('');
    setName('');
    setAlias('');
    setProductType('');
    setSize('');
    setGrade('');
    setWeightKg('');
    setRate('');
  }

  function close(): void {
    reset();
    onClose();
  }

  async function save(): Promise<void> {
    const trimmedCode = productCode.trim();
    const trimmedName = name.trim();
    if (!trimmedCode) {
      onError(t('product.codeRequired'));
      return;
    }
    if (!trimmedName) {
      onError(t('product.nameRequired'));
      return;
    }

    const input = {
      productCode: trimmedCode,
      name: trimmedName,
      alias: alias.trim() || null,
      productType: productType.trim() || null,
      size: size.trim() || null,
      grade: grade.trim() || null,
      // Entered in kilograms/rupees, stored as-is/in paise respectively.
      weightKg: weightKg.trim() ? Number(weightKg) : null,
      rate: rate.trim() ? Math.round(Number(rate) * 100) : null,
    };

    setBusy(true);
    try {
      if (editing) {
        await api.updateProduct(editing.id, input);
        onUpdated?.(trimmedName);
      } else {
        const result = await api.createProduct(input);
        onCreated?.({ id: result.id, productCode: trimmedCode, name: trimmedName });
        reset();
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('product.createFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={close}
      title={editing ? t('product.edit.title') : t('product.new.title')}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-12)' }}>
          <FormField label={t('product.field.code')} required>
            {(id) => (
              <Input
                id={id}
                value={productCode}
                autoFocus
                className="ob-mono"
                onChange={(event) => setProductCode(event.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('product.field.name')} required>
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void save();
                }}
              />
            )}
          </FormField>
        </div>

        <FormField label={t('product.field.alias')}>
          {(id) => (
            <Input id={id} value={alias} onChange={(event) => setAlias(event.target.value)} />
          )}
        </FormField>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-12)' }}>
          <FormField label={t('product.field.type')}>
            {(id) => (
              <Input
                id={id}
                value={productType}
                onChange={(event) => setProductType(event.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('product.field.size')}>
            {(id) => (
              <Input id={id} value={size} onChange={(event) => setSize(event.target.value)} />
            )}
          </FormField>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-12)' }}>
          <FormField label={t('product.field.grade')}>
            {(id) => (
              <Input id={id} value={grade} onChange={(event) => setGrade(event.target.value)} />
            )}
          </FormField>
          <FormField label={t('product.field.weight')}>
            {(id) => (
              <NumberInput
                id={id}
                value={weightKg}
                onChange={(event) => setWeightKg(event.target.value.replace(/[^0-9.]/g, ''))}
              />
            )}
          </FormField>
        </div>

        <FormField label={t('product.field.rate')} hint={t('product.field.rateHint')}>
          {(id) => (
            <NumberInput
              id={id}
              value={rate}
              onChange={(event) => setRate(event.target.value.replace(/[^0-9.]/g, ''))}
            />
          )}
        </FormField>

        {liveProduct && (
          <FormField label={t('product.field.images')}>
            {() => (
              <ProductImages product={liveProduct} onChanged={setLiveProduct} onError={onError} />
            )}
          </FormField>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--s-8)',
            marginTop: 'var(--s-4)',
          }}
        >
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {busy ? t('product.saving') : editing ? t('product.saveChanges') : t('product.save')}
          </Button>
          {!editing && <span className="ob-small">{t('product.saveHint')}</span>}
        </div>
      </div>
    </Drawer>
  );
}
