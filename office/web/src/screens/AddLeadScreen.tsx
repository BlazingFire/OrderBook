/**
 * Add Lead — the screen office staff spend their day in
 * (docs/LEAD_GENERATION_FLOW.md §3).
 *
 * Both the party and the product can be picked from existing records or created
 * inline, because a customer standing at the counter is often new and making
 * staff leave this screen to add them first would lose the lead.
 *
 * Two rules from the guide are enforced visibly here rather than only on the
 * server:
 *  · **Packaging is never auto-filled.** Typing a product code fills every
 *    other snapshot field and pointedly leaves packaging blank.
 *  · **Party-wise mode changes where values come from**, but a party's saved
 *    packaging is offered as a suggestion the user must accept — never applied.
 *
 * Saving works with no link to the Master: the lead is queued locally and
 * appears on the board immediately.
 */

import { useMemo, useState } from 'react';
import type {
  CustomFieldDefinition,
  LineItemInput,
  OptionListItem,
  Party,
  PartyProductVariant,
  Product,
} from '@orderbook/shared';

import { api, type LocalView } from '../api';
import { ColourQuantities, type ColourQuantity } from '../components/ColourQuantities';
import { CustomFields } from '../components/CustomFields';
import { Field } from '../components/Field';
import { formatMoney } from '../format';

interface Props {
  view: LocalView;
  /** From the signed-in person's own resolved set, not the snapshot's. */
  canEditRate: boolean;
  onSaved: () => void;
  onCancel: () => void;
}

interface DraftLine {
  productId: string;
  productName: string;
  code: string | null;
  alias: string | null;
  rate: number | null;
  sin: string | null;
  size: string | null;
  grade: string | null;
  productType: string | null;
  weightKg: number | null;
  packaging: string;
  notes: string;
  fromPartyVariant: boolean;
  quantities: ColourQuantity[];
  /** Shown as a hint only — accepting it is a deliberate click. */
  suggestedPackaging: string | null;
}

export function AddLeadScreen({ view, canEditRate, onSaved, onCancel }: Props) {
  const [partyId, setPartyId] = useState('');
  const [partySearch, setPartySearch] = useState('');
  const [showNewParty, setShowNewParty] = useState(false);

  const [partyWiseMode, setPartyWiseMode] = useState(false);
  const [sourcePlatform, setSourcePlatform] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [notes, setNotes] = useState('');
  const [customFields, setCustomFields] = useState<Record<string, unknown>>({});

  const [productSearch, setProductSearch] = useState('');
  const [codeEntry, setCodeEntry] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedParty = view.parties.find((party) => party.id === partyId) ?? null;

  const leadFieldDefinitions = view.customFields.filter(
    (definition: CustomFieldDefinition) => definition.entity === 'lead',
  );
  const sourceOptions = view.optionLists.filter(
    (option: OptionListItem) => option.listKey === 'lead.sourcePlatform' && option.isActive,
  );

  /** Only consulted when party-wise mode is on — that is the whole toggle. */
  const variantsForParty = useMemo(
    () =>
      partyWiseMode
        ? new Map(
            view.partyVariants
              .filter((variant) => variant.partyId === partyId)
              .map((variant) => [variant.productId, variant]),
          )
        : new Map<string, PartyProductVariant>(),
    [partyWiseMode, partyId, view.partyVariants],
  );

  const matchingParties = useMemo(() => {
    const term = partySearch.trim().toLowerCase();
    if (!term) return view.parties.slice(0, 8);
    return view.parties
      .filter(
        (party) =>
          party.name.toLowerCase().includes(term) ||
          party.partyCode.toLowerCase().includes(term) ||
          (party.phone ?? '').includes(term),
      )
      .slice(0, 8);
  }, [partySearch, view.parties]);

  const matchingProducts = useMemo(() => {
    const term = productSearch.trim().toLowerCase();
    if (!term) return view.products.slice(0, 8);
    return view.products
      .filter(
        (product) =>
          product.name.toLowerCase().includes(term) ||
          product.productCode.toLowerCase().includes(term) ||
          (product.alias ?? '').toLowerCase().includes(term) ||
          (product.series ?? '').toLowerCase().includes(term) ||
          (product.categoryName ?? '').toLowerCase().includes(term),
      )
      .slice(0, 8);
  }, [productSearch, view.products]);

  /**
   * The order total, or null when any line's rate is hidden from this person.
   *
   * `rate ?? 0` treated a rate this role may not see as free, so a rate-blind
   * user was shown a confident ₹0.00 total in perfect good faith — the exact
   * failure the masking rule exists to prevent (`roles-ui.md` §6). Rendering
   * from absence means the total is either right or visibly unknown.
   */
  const total = lines.some((line) => line.rate === null || line.rate === undefined)
    ? null
    : lines.reduce((sum, line) => sum + Math.round((line.rate ?? 0) * totalQuantity(line)), 0);

  /**
   * Build a line from a product, applying the party's variant when the lead is
   * in party-wise mode. `packaging` is left empty on purpose — §3.2 says it is
   * chosen manually every time, so the variant's value becomes a suggestion.
   */
  function lineFrom(product: Product): DraftLine {
    const variant = variantsForParty.get(product.id) ?? null;

    return {
      productId: product.id,
      productName: variant?.productName ?? product.name,
      code: product.productCode,
      alias: variant?.alias ?? product.alias,
      rate: variant?.rate ?? product.rate ?? null,
      sin: variant?.sin ?? product.sin,
      size: variant?.size ?? product.size,
      grade: variant?.grade ?? product.grade,
      productType: variant?.productType ?? product.productType,
      weightKg: variant?.weightKg ?? product.weightKg,
      packaging: '',
      notes: '',
      fromPartyVariant: variant !== null,
      quantities: [{ colour: product.color ?? '', quantity: 1 }],
      suggestedPackaging: variant?.packaging ?? null,
    };
  }

  function addProduct(product: Product): void {
    setLines((current) => [...current, lineFrom(product)]);
    setProductSearch('');
    setCodeEntry('');
  }

  /** The guide's convenience input: a code fills the rest of the line (§3.2). */
  function addByCode(): void {
    const code = codeEntry.trim();
    if (!code) return;

    const product = view.products.find(
      (candidate) => candidate.productCode.toLowerCase() === code.toLowerCase(),
    );

    if (!product) {
      setError(`No product with code "${code}"`);
      return;
    }

    setError(null);
    addProduct(product);
  }

  function updateLine(index: number, patch: Partial<DraftLine>): void {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  async function save(): Promise<void> {
    if (!partyId) {
      setError('Choose a party for this lead');
      return;
    }
    if (lines.length === 0) {
      setError('Add at least one product');
      return;
    }

    const missingPackaging = lines.filter((line) => !line.packaging.trim());
    if (missingPackaging.length > 0) {
      setError(
        `Choose packaging for ${missingPackaging.map((line) => line.productName).join(', ')}`,
      );
      return;
    }

    const missingQuantities = lines.filter((line) => totalQuantity(line) <= 0);
    if (missingQuantities.length > 0) {
      setError(
        `Add a quantity for ${missingQuantities.map((line) => line.productName).join(', ')}`,
      );
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const items: LineItemInput[] = lines.map((line, index) => ({
        productId: line.productId,
        productName: line.productName,
        alias: line.alias,
        rate: line.rate,
        code: line.code,
        sin: line.sin,
        size: line.size,
        weightKg: line.weightKg,
        grade: line.grade,
        productType: line.productType,
        packaging: line.packaging.trim(),
        sequence: index + 1,
        fromPartyVariant: line.fromPartyVariant,
        notes: line.notes.trim() || null,
        quantities: line.quantities
          .filter((quantity) => quantity.colour.trim() && quantity.quantity > 0)
          .map((quantity) => ({ colour: quantity.colour.trim(), quantity: quantity.quantity })),
      }));

      await api.createLead({
        partyId,
        sourcePlatform: sourcePlatform || null,
        followUpDate: followUpDate || null,
        partyWiseMode,
        notes: notes.trim() || null,
        customFields,
        items,
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
        <h2 style={{ margin: 0 }}>Add Lead</h2>
        <button className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {/* --- 1. Party --------------------------------------------------- */}

      <div className="card">
        <h3 className="section-title">1. Party</h3>

        {selectedParty ? (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong>{selectedParty.name}</strong>{' '}
              <span className="muted">
                {selectedParty.partyCode}
                {selectedParty.phone ? ` · ${selectedParty.phone}` : ''}
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
                      <td className="right">
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
                onCreated={(id) => {
                  setPartyId(id);
                  setShowNewParty(false);
                }}
                onError={setError}
              />
            )}
          </>
        )}

        {selectedParty && (
          <label
            className="row"
            style={{ marginTop: 12, gap: 8, cursor: 'pointer', fontSize: 14, color: 'inherit' }}
          >
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={partyWiseMode}
              onChange={(event) => {
                setPartyWiseMode(event.target.checked);
                // Existing lines keep whatever they were built from; switching
                // mode must not silently rewrite a rate already agreed on screen.
                setLines((current) => current);
              }}
            />
            Use this party&apos;s own rates and specs where they exist
          </label>
        )}
      </div>

      {/* --- 2. Products ------------------------------------------------ */}

      <div className="card">
        <h3 className="section-title">2. Products</h3>

        {lines.map((line, index) => (
          <div className="line-card" key={`${line.productId}-${index}`}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <div>
                <strong>{line.productName}</strong>{' '}
                <span className="muted">{line.code}</span>
                {line.fromPartyVariant && (
                  <span className="chip" style={{ marginLeft: 8 }}>
                    party rate
                  </span>
                )}
              </div>
              <button
                className="danger"
                onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </div>

            <div className="line-grid">
              <Field label="Packaging *">
                {(id) => (
                  <>
                    <input
                      id={id}
                      value={line.packaging}
                      placeholder="e.g. carton, pallet"
                      onChange={(event) => updateLine(index, { packaging: event.target.value })}
                    />
                    {line.suggestedPackaging && !line.packaging && (
                      <button
                        type="button"
                        className="secondary"
                        style={{ marginTop: 6, padding: '4px 10px', fontSize: 13 }}
                        onClick={() =>
                          updateLine(index, { packaging: line.suggestedPackaging ?? '' })
                        }
                      >
                        Use “{line.suggestedPackaging}”
                      </button>
                    )}
                  </>
                )}
              </Field>

              <Field
                label="Rate per box"
                hint={canEditRate ? undefined : 'Your role cannot set rates'}
              >
                {(id) => (
                  // Entered in rupees, stored in paise.
                  <input
                    id={id}
                    type="number"
                    min="0"
                    step="0.01"
                    className="num"
                    // A courtesy only — the Master ignores a rate from anybody
                    // without `field.saleRate.edit`, whatever the panel sends.
                    disabled={!canEditRate}
                    value={line.rate === null ? '' : line.rate / 100}
                    onChange={(event) =>
                      updateLine(index, {
                        rate: Math.round((Number(event.target.value) || 0) * 100),
                      })
                    }
                  />
                )}
              </Field>

              <Field label="Size">
                {(id) => (
                  <input
                    id={id}
                    value={line.size ?? ''}
                    onChange={(event) => updateLine(index, { size: event.target.value })}
                  />
                )}
              </Field>

              <Field label="Grade">
                {(id) => (
                  <input
                    id={id}
                    value={line.grade ?? ''}
                    onChange={(event) => updateLine(index, { grade: event.target.value })}
                  />
                )}
              </Field>
            </div>

            <div style={{ marginTop: 10 }}>
              <span className="field-label">Colours &amp; quantities *</span>
              <ColourQuantities
                productId={line.productId}
                productLabel={line.productName}
                quantities={line.quantities}
                stock={view.stock}
                onChange={(quantities) => updateLine(index, { quantities })}
              />
            </div>

            <div className="row right" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
              <span className="muted">
                {totalQuantity(line)} boxes ·{' '}
                <strong>
                  {line.rate === null || line.rate === undefined
                    ? '—'
                    : formatMoney(Math.round(line.rate * totalQuantity(line)))}
                </strong>
              </span>
            </div>
          </div>
        ))}

        <div className="line-grid" style={{ marginTop: 4 }}>
          <Field label="Add by product code">
            {(id) => (
              <div className="row" style={{ gap: 6 }}>
                <input
                  id={id}
                  value={codeEntry}
                  placeholder="e.g. PRD-0042"
                  onChange={(event) => setCodeEntry(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addByCode();
                    }
                  }}
                />
                <button className="secondary" onClick={addByCode}>
                  Add
                </button>
              </div>
            )}
          </Field>

          <Field label="Or search by name, alias, type or series">
            {(id) => (
              <input
                id={id}
                value={productSearch}
                onChange={(event) => setProductSearch(event.target.value)}
                placeholder="Start typing…"
              />
            )}
          </Field>
        </div>

        {matchingProducts.length > 0 && (
          <table>
            <tbody>
              {matchingProducts.map((product) => (
                <tr key={product.id}>
                  <td>{product.productCode}</td>
                  <td>
                    {product.name}
                    {product.alias && <div className="muted">{product.alias}</div>}
                  </td>
                  <td>{product.size ?? '—'}</td>
                  <td className="right">
                    <button className="secondary" onClick={() => addProduct(product)}>
                      Add
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* --- 3. Lead details -------------------------------------------- */}

      <div className="card">
        <h3 className="section-title">3. Lead details</h3>

        <div className="line-grid">
          <Field label="Where did this come from?">
            {(id) => (
              <select
                id={id}
                value={sourcePlatform}
                onChange={(event) => setSourcePlatform(event.target.value)}
              >
                <option value="">—</option>
                {sourceOptions.map((option) => (
                  <option key={option.id} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Follow up on">
            {(id) => (
              <input
                id={id}
                type="date"
                value={followUpDate}
                onChange={(event) => setFollowUpDate(event.target.value)}
              />
            )}
          </Field>
        </div>

        <Field label="Notes">
          {(id) => (
            <textarea
              id={id}
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>

        <CustomFields
          definitions={leadFieldDefinitions}
          values={customFields}
          onChange={setCustomFields}
        />
      </div>

      <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
        <strong>Total: {formatMoney(total)}</strong>
        <button onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save lead'}
        </button>
      </div>
    </div>
  );
}

function totalQuantity(line: { quantities: ColourQuantity[] }): number {
  return line.quantities.reduce((sum, quantity) => sum + (quantity.quantity || 0), 0);
}

function NewPartyForm({
  onCreated,
  onError,
}: {
  onCreated: (partyId: string) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(): Promise<void> {
    if (!name.trim()) {
      onError('Enter the party name');
      return;
    }

    setBusy(true);
    try {
      // Queued like everything else, so a new customer can be taken down with
      // no link to the Master. The returned id is the temporary one.
      const result = await api.createParty({
        name: name.trim(),
        phone: phone.trim() || null,
        city: city.trim() || null,
      });
      onCreated(result.id);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not create the party');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="line-card" style={{ marginTop: 10 }}>
      <div className="line-grid">
        <Field label="Name *">
          {(id) => <input id={id} value={name} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <Field label="Phone">
          {(id) => (
            <input id={id} value={phone} onChange={(event) => setPhone(event.target.value)} />
          )}
        </Field>
        <Field label="City">
          {(id) => <input id={id} value={city} onChange={(event) => setCity(event.target.value)} />}
        </Field>
      </div>
      <button onClick={create} disabled={busy}>
        {busy ? 'Saving…' : 'Create party'}
      </button>
    </div>
  );
}

export type { Party };
