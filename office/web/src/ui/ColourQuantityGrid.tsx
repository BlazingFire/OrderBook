/**
 * ColourQuantityGrid (§9.2) — the most-used control in the product; a
 * salesperson enters a full line item here on a phone call. One row per
 * colour the product actually has stock for (from `stock`, not typed by
 * hand), plus a "custom colour" affordance underneath for a colour just now
 * being sold with no stock row yet. Quantities are rows, not columns
 * (docs/LEAD_GENERATION_FLOW.md §3.2) — a per-product total would hide that a
 * white basin in stock does not satisfy an order for a blue one.
 *
 * Tab moves down the quantity column because it is the only focusable control
 * per row; Enter commits and moves on to the next product; a blank quantity
 * is excluded from the line entirely rather than treated as zero.
 */

import { useState } from 'react';
import type { InventoryStockLevel } from '@orderbook/shared';
import { t } from '../i18n/strings';
import { Input, NumberInput } from './Form';
import { Button, IconButton } from './Button';
import { ColourChip, StatusPill } from './DataDisplay';

export interface ColourQuantity {
  colour: string;
  quantity: number;
}

export function ColourQuantityGrid({
  productId,
  productLabel,
  quantities,
  stock,
  onChange,
  onEnterLast,
  colourHex,
  mode = 'readonly',
}: {
  productId: string;
  productLabel: string;
  quantities: ColourQuantity[];
  stock: InventoryStockLevel[];
  onChange: (quantities: ColourQuantity[]) => void;
  onEnterLast?: () => void;
  colourHex?: (colour: string) => string | undefined;
  /**
   * 'entry' swaps the On hand/Reserved columns for a single Free to sell
   * figure plus a short/oversell badge when the typed quantity exceeds it
   * (New-Lead.dc.html) — the read-only drawer keeps On hand/Reserved.
   */
  mode?: 'entry' | 'readonly';
}) {
  const [customDraft, setCustomDraft] = useState('');
  const [text, setText] = useState<Record<string, string>>({});

  const known = stock
    .filter((level) => level.productId === productId)
    .sort((a, b) => a.colour.localeCompare(b.colour));

  const knownColours = new Set(known.map((level) => level.colour));
  const extra = quantities.filter((q) => !knownColours.has(q.colour));
  const rows = [...known.map((level) => ({ colour: level.colour, stock: level })), ...extra.map((q) => ({ colour: q.colour, stock: undefined }))];

  function entryFor(colour: string): ColourQuantity | undefined {
    return quantities.find((q) => q.colour === colour);
  }

  function displayValue(colour: string): string {
    if (colour in text) return text[colour];
    return entryFor(colour)?.quantity ? String(entryFor(colour)!.quantity) : '';
  }

  function commit(colour: string, raw: string): void {
    setText((t) => ({ ...t, [colour]: raw }));
    const trimmed = raw.trim();
    const rest = quantities.filter((q) => q.colour !== colour);
    if (trimmed === '') {
      onChange(rest);
      return;
    }
    const num = Number(trimmed);
    if (Number.isNaN(num)) return;
    onChange([...rest, { colour, quantity: num }]);
  }

  function step(colour: string, delta: number): void {
    const current = entryFor(colour)?.quantity ?? 0;
    const next = Math.max(0, current + delta);
    setText((t) => {
      const { [colour]: _drop, ...rest } = t;
      return rest;
    });
    onChange([...quantities.filter((q) => q.colour !== colour), { colour, quantity: next }]);
  }

  const total = quantities.reduce((sum, q) => sum + (q.quantity || 0), 0);
  const columns = mode === 'entry' ? '1fr 90px 90px 28px' : '1fr 90px 70px 70px 28px';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: columns,
          gap: 'var(--s-8)',
          padding: '0 var(--s-4)',
        }}
        className="ob-eyebrow"
      >
        <span>Colour</span>
        <span style={{ textAlign: 'right' }}>Qty</span>
        {mode === 'entry' ? (
          <span style={{ textAlign: 'right' }}>{t('lead.add.products.freeToSell')}</span>
        ) : (
          <>
            <span style={{ textAlign: 'right' }}>On hand</span>
            <span style={{ textAlign: 'right' }}>Reserved</span>
          </>
        )}
        <span />
      </div>

      {rows.map((row, i) => {
        const level = row.stock;
        const zeroStock = level ? level.quantityBoxes === 0 : false;
        const isLast = i === rows.length - 1;
        const enteredQty = entryFor(row.colour)?.quantity ?? 0;
        const short = mode === 'entry' && Boolean(level) && enteredQty > (level?.availableBoxes ?? 0);
        return (
          <div
            key={row.colour}
            style={{
              display: 'grid',
              gridTemplateColumns: columns,
              gap: 'var(--s-8)',
              alignItems: 'center',
              padding: 'var(--s-4)',
              opacity: zeroStock ? 0.7 : 1,
            }}
          >
            <span className="ob-colourname">
              <ColourChip hex={colourHex?.(row.colour)} name={row.colour} />
              <span style={{ color: zeroStock ? 'var(--fg-tertiary)' : undefined }}>{row.colour}</span>
            </span>
            <NumberInput
              value={displayValue(row.colour)}
              placeholder="—"
              aria-label={`Quantity of ${row.colour} for ${productLabel}`}
              onChange={(e) => commit(row.colour, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  step(row.colour, e.shiftKey ? 10 : 1);
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  step(row.colour, e.shiftKey ? -10 : -1);
                } else if (e.key === 'Enter' && isLast) {
                  e.preventDefault();
                  onEnterLast?.();
                }
              }}
            />
            {mode === 'entry' ? (
              <span className="ob-data" style={{ textAlign: 'right', color: 'var(--fg-secondary)' }}>
                {level ? level.availableBoxes : '—'}
              </span>
            ) : (
              <>
                <span className="ob-data" style={{ textAlign: 'right', color: 'var(--fg-secondary)' }}>
                  {level ? level.quantityBoxes : '—'}
                </span>
                <span className="ob-data" style={{ textAlign: 'right', color: 'var(--fg-secondary)' }}>
                  {level ? level.reservedBoxes : '—'}
                </span>
              </>
            )}
            {short ? (
              <StatusPill tone="conflict">{t('lead.add.products.short')}</StatusPill>
            ) : (
              !knownColours.has(row.colour) && (
                <IconButton
                  icon="close"
                  label={`Remove ${row.colour}`}
                  onClick={() => onChange(quantities.filter((q) => q.colour !== row.colour))}
                />
              )
            )}
          </div>
        );
      })}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: columns,
          gap: 'var(--s-8)',
          padding: 'var(--s-4)',
          borderTop: '1px solid var(--line)',
        }}
      >
        <span className="ob-body-strong">Total</span>
        <span className="ob-data" style={{ textAlign: 'right', fontWeight: 550 }}>
          {total}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 'var(--s-8)', alignItems: 'center', marginTop: 'var(--s-4)' }}>
        <Input
          value={customDraft}
          placeholder="Add another colour"
          style={{ width: 160 }}
          onChange={(e) => setCustomDraft(e.target.value)}
        />
        <Button
          variant="ghost"
          size="sm"
          icon="plus"
          disabled={!customDraft.trim() || knownColours.has(customDraft.trim())}
          onClick={() => {
            onChange([...quantities, { colour: customDraft.trim(), quantity: 0 }]);
            setCustomDraft('');
          }}
        >
          Colour
        </Button>
      </div>
    </div>
  );
}
