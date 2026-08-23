/**
 * Per-colour quantities on a line (docs/LEAD_GENERATION_FLOW.md §3.2).
 *
 * Quantities are a child list, not a column, because one line routinely covers
 * several colours and the count is not known in advance. Each row also shows
 * what is free to sell in *that* colour — a white basin in stock does not
 * satisfy an order for a blue one, so a per-product total would be misleading
 * here rather than merely imprecise.
 *
 * A shortfall is shown, never blocked: selling against an undelivered factory
 * order is routine for a ceramic dealer.
 */

import type { InventoryStockLevel } from '@orderbook/shared';

export interface ColourQuantity {
  colour: string;
  quantity: number;
}

interface Props {
  productId: string;
  quantities: ColourQuantity[];
  stock: InventoryStockLevel[];
  onChange: (quantities: ColourQuantity[]) => void;
  productLabel: string;
}

export function ColourQuantities({
  productId,
  quantities,
  stock,
  onChange,
  productLabel,
}: Props) {
  /** Colours this product actually has stock rows for, offered as a datalist. */
  const known = stock
    .filter((level) => level.productId === productId)
    .map((level) => level.colour)
    .sort();

  const listId = `colours-${productId}`;

  function update(index: number, patch: Partial<ColourQuantity>): void {
    onChange(quantities.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function availableFor(colour: string): number | null {
    const level = stock.find(
      (entry) => entry.productId === productId && entry.colour === colour.trim(),
    );
    return level ? level.availableBoxes : null;
  }

  return (
    <div>
      <datalist id={listId}>
        {known.map((colour) => (
          <option key={colour} value={colour} />
        ))}
      </datalist>

      {quantities.map((row, index) => {
        const available = availableFor(row.colour);
        const short = available !== null && row.quantity > available;

        return (
          <div className="colour-row" key={index}>
            <div>
              <input
                list={listId}
                value={row.colour}
                placeholder="Colour"
                aria-label={`Colour ${index + 1} for ${productLabel}`}
                onChange={(event) => update(index, { colour: event.target.value })}
              />
              {available !== null && (
                <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                  {available} free to sell
                  {short && <span className="chip short" style={{ marginLeft: 6 }}>short</span>}
                </div>
              )}
            </div>

            <input
              type="number"
              min="0"
              step="0.01"
              className="num"
              value={row.quantity || ''}
              placeholder="Boxes"
              aria-label={`Quantity of ${row.colour || 'colour'} for ${productLabel}`}
              onChange={(event) =>
                update(index, { quantity: Number(event.target.value) || 0 })
              }
            />

            <button
              type="button"
              className="secondary"
              aria-label={`Remove ${row.colour || 'colour'} from ${productLabel}`}
              onClick={() => onChange(quantities.filter((_, i) => i !== index))}
            >
              ✕
            </button>
          </div>
        );
      })}

      <button
        type="button"
        className="secondary"
        onClick={() => onChange([...quantities, { colour: '', quantity: 0 }])}
      >
        + Colour
      </button>
    </div>
  );
}
