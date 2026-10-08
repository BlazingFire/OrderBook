/**
 * The sub-product dropdown of the New Order form, the second link of the product bar's chain,
 * shared by the Master and the Office copy (owner, 2026-10-08).
 *
 * A header that stays put while the rows scroll (how many sub products are shown, and the column
 * names), the rows on one grid — photo, code, sub product with its size under it, colour or
 * variants, weight — and a line of keys at the foot. **Compact** draws one short line per row, with
 * no photo and the size beside the name; the choice is this PC's (`useSubListCompact`), and the
 * button that flips it (`SubListCompactToggle`) sits at the right of the search box.
 *
 * Presentational: the screen owns the rows, the highlighted one and what a pick does. A row is
 * taken on `mousedown`, not `click` — the search box's blur would close the list out from under
 * the pointer first — and is out of the Tab order: the box's arrows and Enter are the keyboard's.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { colourRuleOf, shownColour, type Product } from '@orderbook/shared';

import { ColourChip } from '../DataDisplay.js';
import { formatKg } from '../format.js';
import { t } from '../i18n.js';
import { Icon } from '../icons.js';
import { ProductThumb } from '../ProgressiveImage.js';
import './order.css';

const COMPACT_KEY = 'ob.order.subList.compact';

function readCompact(): boolean {
  try {
    return window.localStorage.getItem(COMPACT_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Compact or full sub-product rows, kept on this PC. */
export function useSubListCompact(): [boolean, () => void] {
  const [compact, setCompact] = useState(readCompact);
  const toggle = useCallback(() => {
    setCompact((now) => {
      try {
        window.localStorage.setItem(COMPACT_KEY, String(!now));
      } catch {
        // Storage unavailable: the choice lasts for this visit.
      }
      return !now;
    });
  }, []);
  return [compact, toggle];
}

/**
 * Collapse / Expand. A plain button, so Tab reaches it; the Enter walk passes it by (it is not a
 * field). Its `mousedown` keeps the caret in the search box, so the open list changes in place.
 */
export function SubListCompactToggle({
  compact,
  onToggle,
}: {
  compact: boolean;
  onToggle: () => void;
}) {
  const label = compact ? t('lead.add.products.expand') : t('lead.add.products.collapse');
  return (
    <button
      type="button"
      className="ob-subpick-toggle"
      aria-pressed={compact}
      title={compact ? t('lead.add.products.expandTitle') : t('lead.add.products.collapseTitle')}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
    >
      <Icon name={compact ? 'chevron-down' : 'chevron-up'} size={14} />
      {label}
    </button>
  );
}

/** One weight, or the spread of a legacy sub product's variants; "missing" when one has none. */
function weightText(weights: Array<number | null>): string {
  if (weights.length === 0) return '—';
  if (weights.some((weight) => weight === null)) return t('product.weight.missingShort');
  const low = Math.min(...(weights as number[]));
  const high = Math.max(...(weights as number[]));
  return low === high ? formatKg(low) : `${formatKg(low)} – ${formatKg(high)}`;
}

export function SubProductList({
  rows,
  total,
  pick,
  compact,
  colourHex,
  listRef,
  onHover,
  onPick,
}: {
  /** The sub products matching what is typed, in the order shown. */
  rows: readonly Product[];
  /** Every sub product of the product, for "3 of 56". */
  total: number;
  /** The highlighted row. */
  pick: number;
  compact: boolean;
  colourHex: (name: string) => string | undefined;
  /** The scrolling list, where the screen keeps the highlighted row in view. */
  listRef?: React.Ref<HTMLDivElement>;
  onHover: (index: number) => void;
  onPick: (row: Product) => void;
}) {
  const count =
    rows.length === total
      ? total === 1
        ? t('lead.add.products.countOne')
        : t('lead.add.products.count', { count: total })
      : t('lead.add.products.countFiltered', { shown: rows.length, total });

  // Opened low on a short screen (1024 x 768), the list would run off the bottom with its key
  // line: once it has rows (they arrive after it opens), the page scrolls just enough to show it
  // whole. `?.()`: jsdom has no `scrollIntoView`.
  const frame = useRef<HTMLDivElement>(null);
  const filled = rows.length > 0;
  useEffect(() => {
    if (filled) frame.current?.scrollIntoView?.({ block: 'nearest' });
  }, [filled]);

  return (
    <div
      ref={frame}
      className="ob-suggest ob-subpick"
      data-compact={compact ? 'true' : undefined}
    >
      <div className="ob-subpick__head">
        <span className="ob-subpick__count" aria-live="polite">
          {count}
        </span>
        <div className="ob-subpick__grid ob-subpick__cols" aria-hidden="true">
          {!compact && <span />}
          <span>{t('lead.add.products.col.code')}</span>
          <span>{t('lead.add.products.col.product')}</span>
          <span>{t('lead.add.products.col.variant')}</span>
          <span className="ob-subpick__num">{t('lead.add.products.col.weight')}</span>
        </div>
      </div>

      <div
        role="listbox"
        aria-label={t('lead.add.products.col.product')}
        className="ob-subpick__rows"
        ref={listRef}
      >
        {rows.map((row, index) => {
          const active = row.variants.filter((variant) => variant.isActive);
          const first = active[0] ?? row.variants[0];
          const rule = colourRuleOf(row);
          const colour =
            active.length > 1
              ? active.map((variant) => variant.label ?? variant.code).join(', ')
              : rule === 'selectable'
                ? null
                : shownColour(first?.label, row.name);
          // A colour-named sub product (a fixed colour, or MAGENTA sold in Magenta) shows its dot.
          const swatch = rule === 'fixed' && first?.label ? colourHex(first.label) : undefined;
          return (
            <button
              key={row.id}
              type="button"
              tabIndex={-1}
              className="ob-suggest-row ob-subpick__grid ob-subpick__row"
              data-active={index === pick ? 'true' : undefined}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(row);
              }}
            >
              {!compact && (
                <ProductThumb
                  images={row.images}
                  size={32}
                  fallback="initial"
                  alt=""
                  name={row.name}
                />
              )}
              <span className="ob-subpick__code">
                {active.length > 1
                  ? t('lead.add.products.variantCount', { count: active.length })
                  : (first?.code ?? '—')}
              </span>
              <span className="ob-subpick__name">
                <span className="ob-ellipsis">{row.name}</span>
                {row.size && <span className="ob-subpick__size">{row.size}</span>}
              </span>
              <span className="ob-subpick__colour">
                {swatch && first?.label && <ColourChip name={first.label} hex={swatch} />}
                {rule === 'selectable' && active.length <= 1 ? (
                  <span className="ob-subpick__any">{t('product.multiColour.pill')}</span>
                ) : (
                  colour && <span className="ob-ellipsis">{colour}</span>
                )}
              </span>
              <span className="ob-subpick__num">
                {weightText(active.map((variant) => variant.weightKg))}
              </span>
            </button>
          );
        })}
        {rows.length === 0 && (
          <p className="ob-subpick__none">{t('lead.add.products.noProduct')}</p>
        )}
      </div>

      <p className="ob-subpick__hint">{t('lead.add.products.listHint')}</p>
    </div>
  );
}
