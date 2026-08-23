/**
 * Inventory, per (product, colour) (docs/LEAD_GENERATION_FLOW.md §5.1, §6).
 *
 * Three quantities are shown side by side because they answer different
 * questions: what is on the floor, what is already reserved for orders that
 * have not been dispatched, and what is therefore free to sell. Only the last
 * one is what a new order can actually draw on, so it is what "low stock" is
 * judged against.
 *
 * Stock is allowed to go negative — a dealer routinely sells against a factory
 * order that has not arrived. The shortfall is surfaced, never blocked.
 */

import { useCallback, useEffect, useState } from 'react';
import type { InventoryStockLevel, Product, StockMovement } from '@orderbook/shared';

import { api } from '../api';
import { Field } from '../components/Field';
import { formatDateTime } from '../format';

interface Props {
  revision: number;
}

export function InventoryScreen({ revision }: Props) {
  const [levels, setLevels] = useState<InventoryStockLevel[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [stock, recent] = await Promise.all([
        api.stock({ search: search || undefined, lowOnly }),
        api.stockMovements(),
      ]);
      setLevels(stock);
      setMovements(recent);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load inventory');
    }
  }, [search, lowOnly]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  useEffect(() => {
    void api
      .products()
      .then((page) => setProducts(page.items))
      .catch(() => setProducts([]));
  }, []);

  async function run(action: () => Promise<unknown>, failure: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>Inventory</h2>

      {error && <div className="error">{error}</div>}

      <div className="grid cols-2">
        <MovementForm
          title="Stock in"
          description="Boxes that arrived from the factory or a purchase."
          products={products}
          levels={levels}
          submitLabel="Add stock"
          busy={busy}
          onSubmit={(input) =>
            run(() => api.stockInbound(input), 'Could not record the incoming stock')
          }
        />

        <MovementForm
          title="Physical count"
          description="Enter the number of boxes actually on the shelf — not the difference."
          products={products}
          levels={levels}
          submitLabel="Save count"
          busy={busy}
          onSubmit={(input) => run(() => api.stockAdjust(input), 'Could not save the count')}
        />
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Stock levels</h3>
          <div className="row" style={{ gap: 10 }}>
            <input
              value={search}
              placeholder="Search product or colour"
              style={{ width: 260 }}
              onChange={(event) => setSearch(event.target.value)}
            />
            <label className="row" style={{ gap: 6, marginBottom: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={lowOnly}
                onChange={(event) => setLowOnly(event.target.checked)}
              />
              Low only
            </label>
          </div>
        </div>

        {levels.length === 0 ? (
          <p className="muted">Nothing to show.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Colour</th>
                <th className="right">On floor</th>
                <th className="right">Reserved</th>
                <th className="right">Free to sell</th>
                <th className="right">Reorder at</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((level) => (
                <tr key={`${level.productId}-${level.colour}`}>
                  <td>
                    {level.productName}
                    <div className="muted">{level.productCode}</div>
                  </td>
                  <td>{level.colour}</td>
                  <td className="right num">{level.quantityBoxes}</td>
                  <td className="right num">{level.reservedBoxes || '—'}</td>
                  <td
                    className="right num"
                    style={{
                      color: level.availableBoxes < 0 ? 'var(--danger)' : undefined,
                      fontWeight: 600,
                    }}
                  >
                    {level.availableBoxes}
                    {level.isLow && (
                      <span className="chip short" style={{ marginLeft: 6 }}>
                        low
                      </span>
                    )}
                  </td>
                  <td className="right">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="num right"
                      style={{ width: 90 }}
                      defaultValue={level.reorderLevel ?? ''}
                      aria-label={`Reorder level for ${level.productName} ${level.colour}`}
                      onBlur={(event) =>
                        void run(
                          () =>
                            api.setReorderLevel({
                              productId: level.productId,
                              colour: level.colour,
                              reorderLevel:
                                event.target.value === '' ? null : Number(event.target.value),
                            }),
                          'Could not save the reorder level',
                        )
                      }
                    />
                  </td>
                  <td className="muted">{formatDateTime(level.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Recent movements</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Every row is a signed change, never a total — which is what makes the running figure
          reconstructible.
        </p>

        {movements.length === 0 ? (
          <p className="muted">No movements recorded yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Product</th>
                <th>Colour</th>
                <th>Type</th>
                <th className="right">Change</th>
                <th>Reference</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((movement) => (
                <tr key={movement.id}>
                  <td>{formatDateTime(movement.createdAt)}</td>
                  <td>{movement.productName}</td>
                  <td>{movement.colour}</td>
                  <td>{movement.movementType}</td>
                  <td
                    className="right num"
                    style={{ color: movement.quantityBoxes < 0 ? 'var(--danger)' : 'var(--success)' }}
                  >
                    {movement.quantityBoxes > 0 ? '+' : ''}
                    {movement.quantityBoxes}
                  </td>
                  <td className="muted">
                    {movement.referenceType}
                    {movement.referenceId ? ` ${movement.referenceId}` : ''}
                  </td>
                  <td className="muted">{movement.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * Shared by stock-in and physical count: they differ only in what the number
 * means and which endpoint receives it, so one form with two labels beats two
 * near-identical ones.
 */
function MovementForm({
  title,
  description,
  products,
  levels,
  submitLabel,
  busy,
  onSubmit,
}: {
  title: string;
  description: string;
  products: Product[];
  levels: InventoryStockLevel[];
  submitLabel: string;
  busy: boolean;
  onSubmit: (input: {
    productId: string;
    colour: string;
    quantityBoxes: number;
    note?: string;
  }) => Promise<void>;
}) {
  const [productId, setProductId] = useState('');
  const [colour, setColour] = useState('');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');

  const knownColours = levels
    .filter((level) => level.productId === productId)
    .map((level) => level.colour);

  const listId = `${title.replace(/\s+/g, '-').toLowerCase()}-colours`;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        {description}
      </p>

      <Field label="Product">
        {(id) => (
          <select id={id} value={productId} onChange={(event) => setProductId(event.target.value)}>
            <option value="">Choose a product…</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.productCode} — {product.name}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="Colour">
        {(id) => (
          <>
            <input
              id={id}
              list={listId}
              value={colour}
              placeholder="e.g. Ivory"
              onChange={(event) => setColour(event.target.value)}
            />
            <datalist id={listId}>
              {knownColours.map((known) => (
                <option key={known} value={known} />
              ))}
            </datalist>
          </>
        )}
      </Field>

      <Field label="Boxes">
        {(id) => (
          <input
            id={id}
            type="number"
            min="0"
            step="0.01"
            className="num"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        )}
      </Field>

      <Field label="Note">
        {(id) => (
          <input
            id={id}
            value={note}
            placeholder="e.g. factory lot A-77, breakage"
            onChange={(event) => setNote(event.target.value)}
          />
        )}
      </Field>

      <button
        disabled={busy || !productId || !colour.trim() || quantity === ''}
        onClick={() =>
          void onSubmit({
            productId,
            colour: colour.trim(),
            quantityBoxes: Number(quantity),
            note: note.trim() || undefined,
          }).then(() => {
            setQuantity('');
            setNote('');
          })
        }
      >
        {submitLabel}
      </button>
    </div>
  );
}
