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
 *
 * Restyled onto the design system (6-UI-DESIGN.md, New-Lead.dc.html); the
 * data flow above is unchanged.
 */

import { useMemo, useRef, useState } from 'react';
import type {
  CustomFieldDefinition,
  LineItemInput,
  OptionListItem,
  Party,
  PartyProductVariant,
  Product,
} from '@orderbook/shared';

import { api, type LocalView } from '../api';
import { CustomFields } from '../components/CustomFields';
import { PartyDrawer, type CreatedParty } from '../components/PartyDrawer';
import { formatMoney } from '../format';
import { t } from '../i18n/strings';
import { Button, IconButton } from '../ui/Button';
import { Card } from '../ui/Card';
import { Combobox, type ComboboxOption } from '../ui/Combobox';
import { ColourQuantityGrid, type ColourQuantity } from '../ui/ColourQuantityGrid';
import { DateField, FormField, Input, NumberInput, Select, Switch, Textarea } from '../ui/Form';
import { ConflictBanner } from '../ui/States';
import { StatusPill, useColourHex } from '../ui/DataDisplay';
import { useSaveShortcut } from '../ui/SaveShortcutSlot';

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
  /** The rupee text as typed; see `ratePaise`. `null` is a rate this person may not see. */
  rateText: string | null;
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
  const colourHex = useColourHex(view.optionLists);
  const [partyId, setPartyId] = useState('');
  const [partyDrawerOpen, setPartyDrawerOpen] = useState(false);

  const [partyWiseMode, setPartyWiseMode] = useState(false);
  const [sourcePlatform, setSourcePlatform] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [notes, setNotes] = useState('');
  const [customFields, setCustomFields] = useState<Record<string, unknown>>({});

  const [codeEntry, setCodeEntry] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const productSearchRef = useRef<HTMLInputElement>(null);

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

  /**
   * Parties this person may only *read* are left out.
   *
   * The Master refuses the save either way — a lead against a view-only party
   * is a 403 naming why — so this is not the enforcement. It exists so the
   * picker does not walk somebody into a refusal for a party they are looking
   * straight at.
   */
  const partyOptions = useMemo<ComboboxOption<Party>[]>(() => {
    const readOnly = new Set(
      (view.partyGrants ?? []).filter((grant) => grant.level === 'view').map((grant) => grant.partyId),
    );

    return view.parties
      .filter((party) => !readOnly.has(party.id))
      .map((party) => ({
        key: party.id,
        label: [party.partyCode, party.name, party.phone, party.city].filter(Boolean).join(' · '),
        value: party,
      }));
  }, [view.parties, view.partyGrants]);

  const productOptions = useMemo<ComboboxOption<Product>[]>(
    () =>
      view.products.map((product) => ({
        key: product.id,
        label: [product.productCode, product.name, product.alias, product.series, product.categoryName]
          .filter(Boolean)
          .join(' · '),
        value: product,
      })),
    [view.products],
  );

  /**
   * The order total, or null when any line's rate is hidden from this person.
   *
   * `rate ?? 0` treated a rate this role may not see as free, so a rate-blind
   * user was shown a confident ₹0.00 total in perfect good faith — the exact
   * failure the masking rule exists to prevent (`roles-ui.md` §6). Rendering
   * from absence means the total is either right or visibly unknown.
   */
  const total = lines.reduce<number | null>((sum, line) => {
    const amount = lineTotal(line);
    return sum === null || amount === null ? null : sum + amount;
  }, 0);

  /**
   * Build a line from a product, applying the party's variant when the lead is
   * in party-wise mode. `packaging` is left empty on purpose — §3.2 says it is
   * chosen manually every time, so the variant's value becomes a suggestion.
   */
  function lineFrom(product: Product): DraftLine {
    const variant = variantsForParty.get(product.id) ?? null;
    const rate = variant?.rate ?? product.rate ?? null;

    return {
      productId: product.id,
      productName: variant?.productName ?? product.name,
      code: product.productCode,
      alias: variant?.alias ?? product.alias,
      rateText: rate === null ? null : String(rate / 100),
      sin: variant?.sin ?? product.sin,
      size: variant?.size ?? product.size,
      grade: variant?.grade ?? product.grade,
      productType: variant?.productType ?? product.productType,
      weightKg: variant?.weightKg ?? product.weightKg,
      packaging: '',
      notes: '',
      fromPartyVariant: variant !== null,
      // The grid lists every colour the product has stock for already,
      // ready for entry — starting empty avoids a stray row for a colour
      // that was never real (docs/LEAD_GENERATION_FLOW.md §3.7).
      quantities: [],
      suggestedPackaging: variant?.packaging ?? null,
    };
  }

  function addProduct(product: Product): void {
    setLines((current) => [...current, lineFrom(product)]);
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
      setError(t('lead.add.errors.partyRequired'));
      return;
    }
    if (lines.length === 0) {
      setError(t('lead.add.errors.noProducts'));
      return;
    }

    const missingPackaging = lines.filter((line) => !line.packaging.trim());
    if (missingPackaging.length > 0) {
      setError(
        t('lead.add.errors.missingPackaging', {
          names: missingPackaging.map((line) => line.productName).join(', '),
        }),
      );
      return;
    }

    const missingQuantities = lines.filter((line) => totalQuantity(line) <= 0);
    if (missingQuantities.length > 0) {
      setError(
        t('lead.add.errors.missingQuantities', {
          names: missingQuantities.map((line) => line.productName).join(', '),
        }),
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
        rate: ratePaise(line),
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
      setError(caught instanceof Error ? caught.message : t('lead.add.errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  function onPartyCreated(party: CreatedParty): void {
    setPartyId(party.id);
    setPartyDrawerOpen(false);
  }

  // Global Ctrl+S (§10) — same action the Save button below calls, withheld
  // only while a save is already in flight, mirroring the button's own
  // `busy` gate (it has no other disabled condition to mirror).
  useSaveShortcut(busy ? null : () => void save());

  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 className="ob-title" style={{ margin: 0 }}>
          {t('lead.add.title')}
        </h1>
        <Button variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
      </div>

      {error && <ConflictBanner>{error}</ConflictBanner>}

      {/* --- 1. Party --------------------------------------------------- */}

      <Card>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-12)' }}>
          {t('lead.add.party.title')}
        </div>

        {selectedParty ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-16)' }}>
              <span className="ob-body-strong">{selectedParty.name}</span>
              <span className="ob-mono" style={{ fontSize: 11.5, color: 'var(--fg-tertiary)' }}>
                {selectedParty.partyCode}
              </span>
              {selectedParty.phone && <span className="ob-small">{selectedParty.phone}</span>}
              {selectedParty.city && <span className="ob-small">{selectedParty.city}</span>}
              <span style={{ flex: 1 }} />
              <Button variant="secondary" size="sm" onClick={() => setPartyId('')}>
                {t('lead.add.party.change')}
              </Button>
            </div>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--s-8)',
                marginTop: 'var(--s-12)',
                cursor: 'pointer',
              }}
            >
              <Switch checked={partyWiseMode} onChange={setPartyWiseMode} />
              <span className="ob-small">{t('lead.add.party.useRates')}</span>
            </label>
          </>
        ) : (
          <>
            <FormField label={t('lead.add.party.search')}>
              {() => (
                <Combobox
                  options={partyOptions}
                  placeholder={t('lead.add.party.searchPlaceholder')}
                  onSelect={(option) => setPartyId(option.value.id)}
                />
              )}
            </FormField>

            <div style={{ marginTop: 'var(--s-8)' }}>
              <Button variant="ghost" size="sm" icon="plus" onClick={() => setPartyDrawerOpen(true)}>
                {t('lead.add.party.newParty')}
              </Button>
            </div>
          </>
        )}
      </Card>

      {/* --- 2. Products ------------------------------------------------ */}

      <Card>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-12)' }}>
          {t('lead.add.products.title')}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
          {lines.map((line, index) => (
            <Card key={`${line.productId}-${index}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
                <span className="ob-body-strong" style={{ fontSize: 13.5 }}>
                  {line.productName}
                </span>
                {line.code && (
                  <span className="ob-mono" style={{ fontSize: 11, color: 'var(--fg-tertiary)' }}>
                    {line.code}
                  </span>
                )}
                {line.fromPartyVariant && <StatusPill tone="accent">{t('lead.add.products.partyRate')}</StatusPill>}
                <span style={{ flex: 1 }} />
                <IconButton
                  icon="trash"
                  label={t('lead.add.products.remove')}
                  onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-12) var(--s-16)', marginTop: 'var(--s-12)' }}>
                <FormField label={t('lead.add.products.packagingRequired')}>
                  {(id) => (
                    <>
                      <Input
                        id={id}
                        value={line.packaging}
                        placeholder={t('lead.add.products.packagingPlaceholder')}
                        invalid={!line.packaging.trim()}
                        onChange={(event) => updateLine(index, { packaging: event.target.value })}
                      />
                      {line.suggestedPackaging && !line.packaging && (
                        <Button
                          variant="ghost"
                          size="sm"
                          style={{ marginTop: 'var(--s-4)' }}
                          onClick={() => updateLine(index, { packaging: line.suggestedPackaging ?? '' })}
                        >
                          {t('lead.add.products.useSuggested', { value: line.suggestedPackaging })}
                        </Button>
                      )}
                    </>
                  )}
                </FormField>

                <FormField
                  label={t('lead.add.products.rate')}
                  hint={canEditRate ? undefined : t('lead.add.products.rateHint')}
                >
                  {(id) => (
                    // Entered in rupees, kept as typed and converted to paise
                    // by `ratePaise`.
                    <NumberInput
                      id={id}
                      // A courtesy only — the Master ignores a rate from anybody
                      // without `field.saleRate.edit`, whatever the panel sends.
                      disabled={!canEditRate}
                      value={line.rateText ?? ''}
                      onChange={(event) =>
                        updateLine(index, { rateText: event.target.value.replace(/[^0-9.]/g, '') })
                      }
                    />
                  )}
                </FormField>

                <FormField label={t('lead.add.products.size')}>
                  {(id) => (
                    <Input
                      id={id}
                      value={line.size ?? ''}
                      onChange={(event) => updateLine(index, { size: event.target.value })}
                    />
                  )}
                </FormField>

                <FormField label={t('lead.add.products.grade')}>
                  {(id) => (
                    <Input
                      id={id}
                      value={line.grade ?? ''}
                      onChange={(event) => updateLine(index, { grade: event.target.value })}
                    />
                  )}
                </FormField>
              </div>

              <div style={{ marginTop: 'var(--s-12)' }}>
                <ColourQuantityGrid
                  mode="entry"
                  productId={line.productId}
                  productLabel={line.productName}
                  quantities={line.quantities}
                  stock={view.stock}
                  onChange={(quantities) => updateLine(index, { quantities })}
                  onEnterLast={() => productSearchRef.current?.focus()}
                  colourHex={colourHex}
                />
                <p className="ob-small" style={{ marginTop: 'var(--s-4)', color: 'var(--fg-tertiary)' }}>
                  {t('lead.add.products.keyboardHint')}
                </p>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--s-8)' }}>
                <span className="ob-small">
                  {totalQuantity(line)} {t('unit.boxes')} ·{' '}
                  <strong className="ob-body-strong">{formatMoney(lineTotal(line))}</strong>
                </span>
              </div>
            </Card>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-12) var(--s-16)', marginTop: 'var(--s-12)' }}>
          <FormField label={t('lead.add.products.byCode')}>
            {(id) => (
              <div style={{ display: 'flex', gap: 'var(--s-6)' }}>
                <Input
                  id={id}
                  value={codeEntry}
                  placeholder={t('lead.add.products.byCodePlaceholder')}
                  onChange={(event) => setCodeEntry(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addByCode();
                    }
                  }}
                />
                <Button variant="secondary" onClick={addByCode}>
                  {t('lead.add.products.add')}
                </Button>
              </div>
            )}
          </FormField>

          <FormField label={t('lead.add.products.searchLabel')}>
            {() => (
              <Combobox
                options={productOptions}
                placeholder={t('lead.add.products.searchPlaceholder')}
                inputRef={productSearchRef}
                onSelect={(option) => addProduct(option.value)}
              />
            )}
          </FormField>
        </div>
      </Card>

      {/* --- 3. Lead details -------------------------------------------- */}

      <Card>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-12)' }}>
          {t('lead.add.details.title')}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-12) var(--s-16)' }}>
          <FormField label={t('lead.add.details.source')}>
            {(id) => (
              <Select id={id} value={sourcePlatform} onChange={(event) => setSourcePlatform(event.target.value)}>
                <option value="">—</option>
                {sourceOptions.map((option) => (
                  <option key={option.id} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>

          <FormField label={t('lead.add.details.followUp')}>
            {(id) => <DateField id={id} value={followUpDate} onChange={(event) => setFollowUpDate(event.target.value)} />}
          </FormField>
        </div>

        <FormField label={t('lead.add.details.notes')}>
          {(id) => <Textarea id={id} rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />}
        </FormField>

        <CustomFields definitions={leadFieldDefinitions} values={customFields} onChange={setCustomFields} />
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <strong className="ob-body-strong">{t('lead.add.total', { amount: formatMoney(total) })}</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
          <span className="ob-small">{t('lead.add.savingHint')}</span>
          <Button variant="primary" size="lg" busy={busy} title="Ctrl+S" onClick={() => void save()}>
            {busy ? t('lead.add.saving') : t('lead.add.save')}
          </Button>
        </div>
      </div>

      <PartyDrawer
        open={partyDrawerOpen}
        onClose={() => setPartyDrawerOpen(false)}
        onCreated={onPartyCreated}
        onError={setError}
      />
    </div>
  );
}

function totalQuantity(line: { quantities: ColourQuantity[] }): number {
  return line.quantities.reduce((sum, quantity) => sum + (quantity.quantity || 0), 0);
}

/**
 * The line's rate in paise, or null when there is no rate to show.
 *
 * The draft holds the rupee text the user typed rather than the paise number,
 * because a controlled field rendered back from paise cannot be typed into: the
 * "." in "12." parses to 12, the state does not change, and React restores the
 * field to "12" as the key is pressed — so ₹12.50 is entered as ₹1250. Keeping
 * the text and converting once, here, lets a half-typed number stay half-typed.
 *
 * A blank or unparseable field is unknown rather than free, the same rule the
 * order total follows.
 */
function ratePaise(line: DraftLine): number | null {
  if (line.rateText === null || !line.rateText.trim()) return null;

  const rupees = Number(line.rateText);
  return Number.isFinite(rupees) ? Math.round(rupees * 100) : null;
}

function lineTotal(line: DraftLine): number | null {
  const rate = ratePaise(line);
  return rate === null ? null : Math.round(rate * totalQuantity(line));
}
