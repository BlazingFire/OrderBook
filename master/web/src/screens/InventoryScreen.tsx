/**
 * Stock levels, stock-in, physical-count corrections and reorder levels.
 *
 * Negative stock is shown plainly rather than hidden: selling against a
 * factory order that has not arrived is normal here, and the negative figure
 * is exactly the signal that a reorder is due.
 */

import { useCallback, useEffect, useState } from 'react';
import type { InventoryStockLevel, StockMovement } from '@orderbook/shared';

import { api } from '../api';
import { Field } from '../components/Field';
import { formatDateTime } from '../format';

interface Props {
  /** Bumped by the live socket whenever stock changes, to trigger a refetch. */
  revision: number;
}

type Mode = { kind: 'none' } | { kind: 'in' | 'count'; level: InventoryStockLevel };

export function InventoryScreen({ revision }: Props) {
  const [stock, setStock] = useState<InventoryStockLevel[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [levels, history] = await Promise.all([
        api.stock({ search: search || undefined, lowOnly }),
        api.stockMovements(),
      ]);
      setStock(levels.stock);
      setMovements(history.movements);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load stock');
    } finally {
      setLoading(false);
    }
  }, [search, lowOnly]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const lowCount = stock.filter((level) => level.isLow).length;

  return (
    <div>
      <h2>Inventory</h2>
      {error && <div className="error">{error}</div>}

      {lowCount > 0 && !lowOnly && (
        <div className="notice">
          {lowCount} product{lowCount === 1 ? ' is' : 's are'} at or below the reorder level.{' '}
          <button className="secondary" onClick={() => setLowOnly(true)}>
            Show only these
          </button>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <Field label="Search products">
              {(id) => (
                <input
                  id={id}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Code, name or type"
                />
              )}
            </Field>
          </div>
          <button className={lowOnly ? '' : 'secondary'} onClick={() => setLowOnly((value) => !value)}>
            {lowOnly ? 'Showing low stock' : 'Show low stock only'}
          </button>
        </div>

        {loading ? (
          <p className="muted">Loading…</p>
        ) : stock.length === 0 ? (
          <p className="muted">No products match.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Product</th>
                <th>In stock (boxes)</th>
                <th>Sq ft</th>
                <th>Reorder at</th>
                <th>Last movement</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {stock.map((level) => (
                <tr key={level.productId}>
                  <td>{level.productCode}</td>
                  <td>
                    {level.productName}
                    <div className="muted">
                      {[level.categoryName, level.size].filter(Boolean).join(' • ') || '—'}
                    </div>
                  </td>
                  <td>
                    <strong style={{ color: level.quantityBoxes < 0 ? 'var(--danger)' : undefined }}>
                      {level.quantityBoxes}
                    </strong>
                    {level.isLow && <span className="badge cancelled" style={{ marginLeft: 6 }}>Low</span>}
                    {level.quantityBoxes < 0 && (
                      <div className="muted">Short by {Math.abs(level.quantityBoxes)} — reorder</div>
                    )}
                  </td>
                  <td>{level.quantitySqft || '—'}</td>
                  <td>
                    <ReorderLevelCell level={level} onSaved={load} onError={setError} />
                  </td>
                  <td>{formatDateTime(level.updatedAt)}</td>
                  <td>
                    <div className="row">
                      <button onClick={() => setMode({ kind: 'in', level })}>Stock in</button>
                      <button className="secondary" onClick={() => setMode({ kind: 'count', level })}>
                        Count
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {mode.kind !== 'none' && (
        <StockEntryForm
          mode={mode}
          onDone={() => {
            setMode({ kind: 'none' });
            void load();
          }}
          onCancel={() => setMode({ kind: 'none' })}
          onError={setError}
        />
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Recent stock movements</h3>
        {movements.length === 0 ? (
          <p className="muted">No stock movements recorded yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Product</th>
                <th>Type</th>
                <th>Change</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((movement) => (
                <tr key={movement.id}>
                  <td>{formatDateTime(movement.createdAt)}</td>
                  <td>
                    {movement.productName}
                    <div className="muted">{movement.productCode}</div>
                  </td>
                  <td>
                    <span className={`badge ${movement.movementType === 'outbound' ? 'cancelled' : 'order'}`}>
                      {movement.movementType}
                    </span>
                  </td>
                  <td style={{ color: movement.quantityBoxes < 0 ? 'var(--danger)' : 'var(--success)' }}>
                    {movement.quantityBoxes > 0 ? '+' : ''}
                    {movement.quantityBoxes}
                  </td>
                  <td className="muted">{movement.note ?? movement.referenceType ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function StockEntryForm({
  mode,
  onDone,
  onCancel,
  onError,
}: {
  mode: Exclude<Mode, { kind: 'none' }>;
  onDone: () => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const isStockIn = mode.kind === 'in';
  const [quantity, setQuantity] = useState(isStockIn ? '' : String(mode.level.quantityBoxes));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const value = Number(quantity);
    if (!Number.isFinite(value)) {
      onError('Enter a number of boxes');
      return;
    }

    setBusy(true);
    try {
      if (isStockIn) await api.stockInbound(mode.level.productId, value, note || undefined);
      else await api.stockAdjust(mode.level.productId, value, note || undefined);
      onDone();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>
        {isStockIn ? 'Stock in' : 'Physical count'} — {mode.level.productName}
      </h3>
      <p className="muted">
        {isStockIn
          ? 'How many boxes arrived. This is added to the current stock.'
          : `How many boxes are actually on the floor. Current record says ${mode.level.quantityBoxes}.`}
      </p>

      <div className="grid cols-2">
        <Field label={isStockIn ? 'Boxes received' : 'Boxes counted'}>
          {(id) => (
            <input
              id={id}
              type="number"
              min="0"
              step="0.01"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              autoFocus
            />
          )}
        </Field>
        <Field label="Reason / note (optional)">
          {(id) => (
            <input
              id={id}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={isStockIn ? 'Factory lot number' : 'Breakage, stock take…'}
            />
          )}
        </Field>
      </div>

      <div className="row">
        <button onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ReorderLevelCell({
  level,
  onSaved,
  onError,
}: {
  level: InventoryStockLevel;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(level.reorderLevel === null ? '' : String(level.reorderLevel));

  async function save() {
    try {
      await api.setReorderLevel(level.productId, value === '' ? null : Number(value));
      setEditing(false);
      onSaved();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not save reorder level');
    }
  }

  if (!editing) {
    return (
      <button className="secondary" onClick={() => setEditing(true)}>
        {level.reorderLevel === null ? 'Set' : level.reorderLevel}
      </button>
    );
  }

  return (
    <div className="row" style={{ flexWrap: 'nowrap' }}>
      <input
        type="number"
        min="0"
        step="0.01"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label={`Reorder level for ${level.productName}`}
        style={{ width: 80 }}
        autoFocus
      />
      <button onClick={save}>Save</button>
    </div>
  );
}
