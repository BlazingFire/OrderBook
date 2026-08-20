/**
 * Add Lead — the screen office staff spend their day in.
 *
 * Both the party and the product can be picked from existing records or
 * created inline, because a customer standing at the counter is often new and
 * making staff leave this screen to add them first would lose the lead.
 */

import { useMemo, useState } from 'react';
import type { LeadItemInput, Party, Product, SyncSnapshot } from '@orderbook/shared';

import { api } from '../api';
import { Field } from '../components/Field';
import { formatMoney } from '../format';

interface Props {
  snapshot: SyncSnapshot;
  onSaved: () => void;
  onCancel: () => void;
}

interface DraftItem extends LeadItemInput {
  productName: string;
  productCode: string;
}

export function AddLeadScreen({ snapshot, onSaved, onCancel }: Props) {
  const [partyId, setPartyId] = useState('');
  const [partySearch, setPartySearch] = useState('');
  const [showNewParty, setShowNewParty] = useState(false);

  const [productSearch, setProductSearch] = useState('');
  const [showNewProduct, setShowNewProduct] = useState(false);

  const [items, setItems] = useState<DraftItem[]>([]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedParty = snapshot.parties.find((party) => party.id === partyId) ?? null;

  const matchingParties = useMemo(() => {
    const term = partySearch.trim().toLowerCase();
    if (!term) return snapshot.parties.slice(0, 8);
    return snapshot.parties
      .filter(
        (party) =>
          party.name.toLowerCase().includes(term) ||
          party.partyCode.toLowerCase().includes(term) ||
          (party.phone ?? '').includes(term),
      )
      .slice(0, 8);
  }, [partySearch, snapshot.parties]);

  const matchingProducts = useMemo(() => {
    const term = productSearch.trim().toLowerCase();
    if (!term) return snapshot.products.slice(0, 8);
    return snapshot.products
      .filter(
        (product) =>
          product.name.toLowerCase().includes(term) ||
          product.productCode.toLowerCase().includes(term) ||
          (product.series ?? '').toLowerCase().includes(term) ||
          (product.categoryName ?? '').toLowerCase().includes(term),
      )
      .slice(0, 8);
  }, [productSearch, snapshot.products]);

  const total = items.reduce(
    (sum, item) => sum + Math.round((item.unitPrice ?? 0) * (item.quantityBoxes ?? 0)),
    0,
  );

  function addProduct(product: Product) {
    setItems((current) => [
      ...current,
      {
        productId: product.id,
        productName: product.name,
        productCode: product.productCode,
        quantityBoxes: 1,
        unitPrice: product.pricePerBox,
      },
    ]);
    setProductSearch('');
  }

  function updateItem(index: number, patch: Partial<DraftItem>) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function removeItem(index: number) {
    setItems((current) => current.filter((_, i) => i !== index));
  }

  async function save() {
    if (!partyId) {
      setError('Choose a party for this lead');
      return;
    }
    if (items.length === 0) {
      setError('Add at least one product');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.createLead({
        partyId,
        notes: notes.trim() || null,
        items: items.map((item) => ({
          productId: item.productId,
          quantityBoxes: item.quantityBoxes ?? null,
          unitPrice: item.unitPrice ?? null,
        })),
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the lead');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Add Lead</h2>
        <button className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>1. Party</h3>

        {selectedParty ? (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong>{selectedParty.name}</strong>{' '}
              <span className="muted">
                {selectedParty.partyCode}
                {selectedParty.phone ? ` • ${selectedParty.phone}` : ''}
              </span>
            </div>
            <button className="secondary" onClick={() => setPartyId('')}>
              Change
            </button>
          </div>
        ) : (
          <>
            <Field label="Search party by name, code or phone">
              {(id) => (
                <input
                  id={id}
                  value={partySearch}
                  onChange={(event) => setPartySearch(event.target.value)}
                  placeholder="Start typing…"
                />
              )}
            </Field>

            {matchingParties.length > 0 && (
              <table>
                <tbody>
                  {matchingParties.map((party) => (
                    <tr key={party.id}>
                      <td>{party.partyCode}</td>
                      <td>{party.name}</td>
                      <td>{party.phone ?? '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="secondary" onClick={() => setPartyId(party.id)}>
                          Select
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div style={{ marginTop: 10 }}>
              <button className="secondary" onClick={() => setShowNewParty((value) => !value)}>
                {showNewParty ? 'Cancel new party' : '+ New party'}
              </button>
            </div>

            {showNewParty && (
              <NewPartyForm
                onCreated={(party) => {
                  setPartyId(party.id);
                  setShowNewParty(false);
                }}
                onError={setError}
              />
            )}
          </>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>2. Products</h3>

        {items.length > 0 && (
          <table style={{ marginBottom: 12 }}>
            <thead>
              <tr>
                <th>Product</th>
                <th style={{ width: 110 }}>Boxes</th>
                <th style={{ width: 140 }}>Price / box</th>
                <th style={{ width: 120 }}>Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={`${item.productId}-${index}`}>
                  <td>
                    {item.productName}
                    <div className="muted">{item.productCode}</div>
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.quantityBoxes ?? ''}
                      onChange={(event) =>
                        updateItem(index, { quantityBoxes: Number(event.target.value) || 0 })
                      }
                      aria-label={`Boxes of ${item.productName}`}
                    />
                  </td>
                  <td>
                    {/* Entered in rupees, stored in paise. */}
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.unitPrice === null ? '' : (item.unitPrice ?? 0) / 100}
                      onChange={(event) =>
                        updateItem(index, {
                          unitPrice: Math.round((Number(event.target.value) || 0) * 100),
                        })
                      }
                      aria-label={`Price per box of ${item.productName}`}
                    />
                  </td>
                  <td>{formatMoney(Math.round((item.unitPrice ?? 0) * (item.quantityBoxes ?? 0)))}</td>
                  <td>
                    <button className="danger" onClick={() => removeItem(index)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <Field label="Search product by code, name, type or series">
          {(id) => (
            <input
              id={id}
              value={productSearch}
              onChange={(event) => setProductSearch(event.target.value)}
              placeholder="Start typing…"
            />
          )}
        </Field>

        {matchingProducts.length > 0 && (
          <table>
            <tbody>
              {matchingProducts.map((product) => (
                <tr key={product.id}>
                  <td>{product.productCode}</td>
                  <td>
                    {product.name}
                    <div className="muted">
                      {[product.categoryName, product.size, product.finish]
                        .filter(Boolean)
                        .join(' • ') || '—'}
                    </div>
                  </td>
                  <td>{formatMoney(product.pricePerBox)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="secondary" onClick={() => addProduct(product)}>
                      Add
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ marginTop: 10 }}>
          <button className="secondary" onClick={() => setShowNewProduct((value) => !value)}>
            {showNewProduct ? 'Cancel new product' : '+ New product'}
          </button>
        </div>

        {showNewProduct && (
          <NewProductForm
            categories={snapshot.categories.map((category) => category.name)}
            onCreated={(product) => {
              addProduct(product);
              setShowNewProduct(false);
            }}
            onError={setError}
          />
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>3. Finish</h3>
        <Field label="Notes (optional)">
          {(id) => (
            <textarea
              id={id}
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Delivery date, site details, special requests…"
            />
          )}
        </Field>

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div style={{ fontSize: 18 }}>
            Total: <strong>{formatMoney(total)}</strong>
          </div>
          <button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save lead'}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewPartyForm({
  onCreated,
  onError,
}: {
  onCreated: (party: Party) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [gstNumber, setGstNumber] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) {
      onError('Party name is required');
      return;
    }
    setBusy(true);
    try {
      onCreated(await api.createParty({ name: name.trim(), phone, city, gstNumber }));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not create party');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div className="grid cols-2">
        <Field label="Party name">
          {(id) => <input id={id} value={name} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <Field label="Phone">
          {(id) => <input id={id} value={phone} onChange={(event) => setPhone(event.target.value)} />}
        </Field>
        <Field label="City">
          {(id) => <input id={id} value={city} onChange={(event) => setCity(event.target.value)} />}
        </Field>
        <Field label="GST number">
          {(id) => (
            <input id={id} value={gstNumber} onChange={(event) => setGstNumber(event.target.value)} />
          )}
        </Field>
      </div>
      <button onClick={create} disabled={busy}>
        {busy ? 'Saving…' : 'Save party'}
      </button>
    </div>
  );
}

function NewProductForm({
  categories,
  onCreated,
  onError,
}: {
  categories: string[];
  onCreated: (product: Product) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [productCode, setProductCode] = useState('');
  const [categoryName, setCategoryName] = useState('');
  const [size, setSize] = useState('');
  const [finish, setFinish] = useState('');
  const [priceRupees, setPriceRupees] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) {
      onError('Product name is required');
      return;
    }
    setBusy(true);
    try {
      const product = await api.createProduct({
        // Left blank, the Master generates a code rather than blocking staff
        // who do not have one to hand.
        productCode: productCode.trim(),
        name: name.trim(),
        categoryName: categoryName.trim() || null,
        size: size.trim() || null,
        finish: finish.trim() || null,
        pricePerBox: priceRupees ? Math.round(Number(priceRupees) * 100) : null,
      });
      onCreated(product);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not create product');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div className="grid cols-2">
        <Field label="Product name">
          {(id) => <input id={id} value={name} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <Field label="Product code (leave blank to generate)">
          {(id) => (
            <input
              id={id}
              value={productCode}
              onChange={(event) => setProductCode(event.target.value)}
            />
          )}
        </Field>
        <Field label="Type">
          {(id) => (
            <>
              <input
                id={id}
                list="office-category-options"
                value={categoryName}
                onChange={(event) => setCategoryName(event.target.value)}
                placeholder="e.g. Floor Tile"
              />
              <datalist id="office-category-options">
                {categories.map((category) => (
                  <option key={category} value={category} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Size">
          {(id) => (
            <input
              id={id}
              value={size}
              onChange={(event) => setSize(event.target.value)}
              placeholder="600x600mm"
            />
          )}
        </Field>
        <Field label="Finish">
          {(id) => (
            <input
              id={id}
              value={finish}
              onChange={(event) => setFinish(event.target.value)}
              placeholder="Glossy / Matte"
            />
          )}
        </Field>
        <Field label="Price per box (₹)">
          {(id) => (
            <input
              id={id}
              type="number"
              min="0"
              step="0.01"
              value={priceRupees}
              onChange={(event) => setPriceRupees(event.target.value)}
            />
          )}
        </Field>
      </div>
      <button onClick={create} disabled={busy}>
        {busy ? 'Saving…' : 'Save product'}
      </button>
    </div>
  );
}
