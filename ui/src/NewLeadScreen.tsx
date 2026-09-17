/**
 * New lead — Brand → main product → sub-product, keyboard first.
 *
 * Lives in `ui/` and takes a **transport**, like `DocumentsScreen`: the Office
 * and Master panels have different ways to reach the same data (the Office
 * queues through its offline outbox; the Master calls its own HTTP routes), so
 * the screen only ever speaks this narrow interface and never a panel's api
 * client directly.
 *
 * The flow, exactly as the counter works it:
 *
 *  1. Party typeahead → Enter → source → follow-up date.
 *  2. **Main product** picker: server search of categories, typeahead + arrows,
 *     same width as the sub-product picker.
 *  3. **Sub-product** picker (same size, typeahead, arrow-key dropdown): Enter
 *     adds the model to the box below and stays put, so the next model follows
 *     without the caret moving anywhere.
 *  4. **Shift+Q** (a plain keydown — shift+letter never reaches the command
 *     registry while typing) or the Next button finalises the selection.
 *  5. The caret walks **each sub-product row**: colour (a dropdown only for
 *     `colourPolicy === 'selectable'` models; otherwise the fixed base colour
 *     as locked text) → packaging → grade → quantity. Code and name are large,
 *     dimensions are small and muted.
 *  6. Enter on the last quantity (or Add product) commits the group and returns
 *     to the main-product picker.
 *  7. Ctrl+Enter (or Complete lead) opens a review modal; Ctrl+Enter in the
 *     modal confirms and saves. Esc closes the modal back to the form.
 *
 * No rate is asked for or shown here. A line goes up without one and the
 * Master prices it — the party's variant rate, failing that the catalogue.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  IsoDate,
  LeadInput,
  LineItemInput,
  OptionListItem,
  Party,
  PartyProductVariant,
  Product,
  ProductCategory,
  ProductVariantPick,
} from '@orderbook/shared';

import { Button } from './Button.js';
import { Card } from './Card.js';
import { useColourHex } from './DataDisplay.js';
import { Select, SuggestInput } from './SuggestInput.js';
import { Modal } from './Modal.js';
import { ConflictBanner } from './States.js';
import { rem } from './rem.js';
import { t } from './i18n.js';
import { DateField, Input, Textarea } from './Form.js';
import { useCommand } from './KeyboardProvider.js';
import { useDebounced } from './useDebounced.js';
import { useEnterToAdvance, useEscapeToPrevious } from './useEnterToAdvance.js';
import { useConfirm } from './ConfirmDialog.js';
import { useResetGuard } from './ResetSlot.js';

/**
 * Everything this screen needs from the panel it is mounted in.
 *
 * Narrow on purpose. A transport that exposed a whole api client would let this
 * screen reach for anything, and the two panels do not have the same anything.
 */
export interface NewLeadTransport {
  pickParty(term: string, signal?: AbortSignal): Promise<Party[]>;
  pickCategory(term: string, signal?: AbortSignal): Promise<ProductCategory[]>;
  pickModels(categoryId: string, term: string, signal?: AbortSignal): Promise<Product[]>;
  pickVariants(productCode: string): Promise<ProductVariantPick[]>;
  optionLists(): Promise<OptionListItem[]>;
  variantsForParty(partyId: string): Map<string, PartyProductVariant>;
  partyWise(partyId: string): boolean;
  createLead(input: LeadInput): Promise<{ id: string }>;
  onPartyCreated?(): void;
}

interface Props {
  /** Bumped by the shell each time the form is asked for; see the focus effect. */
  focusNonce: number;
  transport: NewLeadTransport;
  /** Carries the saved lead's id, so the shell can name it. */
  onSaved: (id: string) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** One picked model and what the counter has said about it so far. */
interface SelectedModel {
  key: string;
  product: Product;
  partyAlias: string | null;
  partyGrade: string | null;
  colour: string;
  /** Colours the counter may pick: every known one for selectable models. */
  colourChoices: Array<{ colour: string; variantCode: string | null; availableBoxes: number }>;
  packaging: string;
  grade: string | null;
  boxes: string;
}

const QUICK_FOLLOW_UPS = [
  { days: 1, token: 'lead.add.followUp.tomorrow' },
  { days: 3, token: 'lead.add.followUp.inThreeDays' },
  { days: 7, token: 'lead.add.followUp.nextWeek' },
] as const;

/** Local calendar date as `YYYY-MM-DD`, matching `Lead.followUpDate`'s format. */
function isoDate(daysFromToday: number): string {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday);
  const month = String(day.getMonth() + 1).padStart(2, '0');
  return `${day.getFullYear()}-${month}-${String(day.getDate()).padStart(2, '0')}`;
}

function fixedColourOf(product: Product): string | null {
  const base = product.color?.trim();
  // Unselectable but no base colour recorded: the counter must choose one,
  // otherwise the line would carry an empty colour nobody can act on.
  return product.colourPolicy === 'selectable' || !base ? null : base;
}

export function NewLeadScreen({ focusNonce, transport, onSaved, onCancel, onDirtyChange }: Props) {
  const [optionLists, setOptionLists] = useState<OptionListItem[]>([]);
  const [partyId, setPartyId] = useState('');
  const [partyQuery, setPartyQuery] = useState('');
  const [partyOpen, setPartyOpen] = useState(false);
  const [partySel, setPartySel] = useState(0);
  const [parties, setParties] = useState<Party[]>([]);
  const [chosenParty, setChosenParty] = useState<Party | null>(null);

  const [sourcePlatform, setSourcePlatform] = useState('');
  const [otherSource, setOtherSource] = useState('');
  const [followUpDate, setFollowUpDate] = useState(() => isoDate(0));
  const [notes, setNotes] = useState('');

  const [categoryId, setCategoryId] = useState('');
  const [categoryQuery, setCategoryQuery] = useState('');
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [categorySel, setCategorySel] = useState(0);
  const [categoryRows, setCategoryRows] = useState<ProductCategory[]>([]);

  const [modelQuery, setModelQuery] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSel, setModelSel] = useState(0);
  const [modelRows, setModelRows] = useState<Product[]>([]);
  const [selected, setSelected] = useState<SelectedModel[]>([]);
  const [phase, setPhase] = useState<'pick' | 'detail'>('pick');

  const [committed, setCommitted] = useState<LineItemInput[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const partyRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const categoryRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const seenParties = useRef(new Map<string, Party>());
  // `addModel` is async and reads the party through this, not through state:
  // state in an async closure is the party as it was when the key was pressed.
  const partyIdRef = useRef('');
  partyIdRef.current = partyId;

  const colourHex = useColourHex(optionLists);

  useEffect(() => {
    let cancelled = false;
    void transportRef.current.optionLists().then(
      (lists) => {
        if (!cancelled) setOptionLists(lists);
      },
      () => {
        if (!cancelled) setOptionLists([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceOptions = useMemo(
    () =>
      optionLists.filter((option) => option.listKey === 'lead.sourcePlatform' && option.isActive),
    [optionLists],
  );
  const packagingOptions = useMemo(
    () =>
      optionLists
        .filter((option) => option.listKey === 'line.packaging' && option.isActive)
        .map((option) => ({ value: option.value, label: option.label })),
    [optionLists],
  );
  const gradeOptions = useMemo(
    () =>
      optionLists
        .filter((option) => option.listKey === 'line.grade' && option.isActive)
        .map((option) => ({ value: option.value, label: option.label })),
    [optionLists],
  );
  const colourOptions = useMemo(
    () =>
      optionLists
        .filter((option) => option.listKey === 'stock.colour' && option.isActive)
        .map((option) => ({ value: option.value, label: option.label })),
    [optionLists],
  );

  /*
   * The enquiry came from somewhere, and on this screen it always came from the
   * first thing in the list until somebody says otherwise. A blank required
   * answer on a form nobody has touched reads as a fault rather than a question.
   */
  useEffect(() => {
    setSourcePlatform((current) => current || (sourceOptions[0]?.value ?? ''));
  }, [sourceOptions]);

  const dirty = Boolean(partyId || committed.length > 0 || selected.length > 0 || notes.trim());
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  /*
   * Where the cursor goes when this form is asked for. A blank form starts at
   * the party picker, because that is the first thing a lead needs; a form
   * with anything already on it is left exactly as it was — somebody switched
   * tabs mid-lead and came back, and moving their cursor would be a second
   * interruption. The screen stays mounted while hidden, so the draft itself
   * never needs restoring.
   */
  const blank = !partyId && !partyQuery && committed.length === 0 && !notes.trim();
  useEffect(() => {
    if (focusNonce === 0 || !blank) return;
    const timer = window.setTimeout(() => partyRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  // --- Party search ---------------------------------------------------------

  const partyTerm = useDebounced(partyQuery, 200);

  useEffect(() => {
    if (partyId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const rows = await transportRef.current.pickParty(partyTerm, controller.signal);
        for (const row of rows) seenParties.current.set(row.id, row);
        setParties(rows.slice(0, 6));
      } catch {
        setParties([]);
      }
    })();
    return () => controller.abort();
  }, [partyTerm, partyId]);

  const partyPick = parties.length ? Math.min(partySel, parties.length - 1) : 0;

  function chooseParty(party: Party): void {
    seenParties.current.set(party.id, party);
    setPartyId(party.id);
    setChosenParty(party);
    setPartyQuery('');
    setPartyOpen(false);
    setPartySel(0);
    window.setTimeout(() => sourceRef.current?.focus(), 0);
  }

  // --- Main product search --------------------------------------------------

  const categoryTerm = useDebounced(categoryQuery, 200);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const rows = await transportRef.current.pickCategory(categoryTerm, controller.signal);
        setCategoryRows(rows.slice(0, 7));
      } catch {
        setCategoryRows([]);
      }
    })();
    return () => controller.abort();
  }, [categoryTerm]);

  const categoryPick = categoryRows.length ? Math.min(categorySel, categoryRows.length - 1) : 0;

  function chooseCategory(row: ProductCategory): void {
    setCategoryId(row.id);
    setCategoryQuery('');
    setCategoryOpen(false);
    setCategorySel(0);
    setModelQuery('');
    setModelSel(0);
    setModelOpen(false);
    window.setTimeout(() => modelRef.current?.focus(), 0);
  }

  // --- Sub-product search ---------------------------------------------------

  const modelTerm = useDebounced(modelQuery, 200);

  useEffect(() => {
    if (!categoryId || phase !== 'pick') {
      setModelRows([]);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const rows = await transportRef.current.pickModels(
          categoryId,
          modelTerm,
          controller.signal,
        );
        setModelRows(rows.slice(0, 7));
      } catch {
        setModelRows([]);
      }
    })();
    return () => controller.abort();
  }, [modelTerm, categoryId, phase]);

  const modelPick = modelRows.length ? Math.min(modelSel, modelRows.length - 1) : 0;

  async function addModel(product: Product): Promise<void> {
    if (selected.some((entry) => entry.product.id === product.id)) {
      setModelQuery('');
      setModelSel(0);
      // Already in the box: stay on the picker for the next model.
      window.setTimeout(() => modelRef.current?.focus(), 0);
      return;
    }

    const fixed = fixedColourOf(product);
    const choices: SelectedModel['colourChoices'] = fixed ? [] : [];
    if (!fixed) {
      try {
        const variants = await transportRef.current.pickVariants(product.productCode);
        const seen = new Map<string, SelectedModel['colourChoices'][number]>();
        for (const variant of variants) {
          if (variant.productId !== product.id) continue;
          if (!seen.has(variant.colour)) {
            seen.set(variant.colour, {
              colour: variant.colour,
              variantCode: variant.variantCode,
              availableBoxes: variant.availableBoxes,
            });
          }
        }
        choices.push(...[...seen.values()].sort((a, b) => a.colour.localeCompare(b.colour)));
      } catch {
        // Colours still come from the `stock.colour` list below; the variant
        // codes and stock figures are a nicety, not the colour itself.
      }
      for (const option of colourOptions) {
        if (!choices.some((entry) => entry.colour === option.value)) {
          choices.push({ colour: option.value, variantCode: null, availableBoxes: 0 });
        }
      }
    }

    const variant = transportRef.current.variantsForParty(partyIdRef.current).get(product.id);
    const entry: SelectedModel = {
      key: `sel-${product.id}-${selected.length}`,
      product,
      partyAlias: variant?.productName ?? null,
      partyGrade: variant?.grade ?? null,
      colour: fixed ?? product.color?.trim() ?? choices[0]?.colour ?? '',
      colourChoices: choices,
      packaging: '',
      grade: null,
      boxes: '',
    };
    setSelected((current) => [...current, entry]);
    setModelQuery('');
    setModelSel(0);
    // Enter adds to the box and stays on the picker — the next model follows
    // without the caret moving anywhere.
    window.setTimeout(() => modelRef.current?.focus(), 0);
  }

  function patchSelected(key: string, patch: Partial<SelectedModel>): void {
    setSelected((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    );
  }

  function removeSelected(key: string): void {
    setSelected((current) => current.filter((entry) => entry.key !== key));
  }

  // --- Shift+Q: from picking models to filling their details ------------------

  /** Finalise the box and walk into its first row. Shift+Q, or the Next button. */
  function next(): void {
    if (selected.length === 0 || phase !== 'pick') return;
    setModelOpen(false);
    setPhase('detail');
    window.setTimeout(() => {
      const first = formRef.current?.querySelector<HTMLElement>(
        '[data-detail-row] input, [data-detail-row] select',
      );
      first?.focus();
    }, 0);
  }

  /** Back to the pickers; the box survives, so nothing picked is lost. */
  function backToPick(): void {
    setPhase('pick');
    window.setTimeout(() => modelRef.current?.focus(), 0);
  }

  /*
   * Shift+Q is a plain handler, not a registered command: the keyboard
   * provider skips bare shift+letter chords while the caret is in a field, and
   * the caret is always in a field on this screen. `defaultPrevented` keeps
   * the layers honest when a picker below already spent the press.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (
        (event.key === 'Q' || event.key === 'q') &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (!formRef.current?.contains(target)) return;
        if (target.closest('[role="dialog"]')) return;
        event.preventDefault();
        next();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // `next` reads live state through setters; binding it would rebind per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.length, phase]);

  // --- Commit the group -------------------------------------------------------

  function rowReady(entry: SelectedModel): boolean {
    return (
      Boolean(entry.packaging.trim()) && Number(entry.boxes) > 0 && Boolean(entry.colour.trim())
    );
  }

  function detailReady(): boolean {
    return selected.length > 0 && selected.every(rowReady);
  }

  /** One `LineItemInput` per sub-product, then the caret returns to the models. */
  function addProduct(): void {
    if (!detailReady()) return;
    const categoryName =
      categoryRows.find((row) => row.id === categoryId)?.name ??
      selected[0]?.product.categoryName ??
      null;
    const start = committed.length;
    const items: LineItemInput[] = selected.map((entry, index) => {
      const fixed = fixedColourOf(entry.product);
      const choice = entry.colourChoices.find((candidate) => candidate.colour === entry.colour);
      return {
        productId: entry.product.id,
        productName: entry.partyAlias ?? entry.product.name,
        categoryName,
        alias: entry.product.alias,
        code: entry.product.productCode,
        sin: entry.product.sin,
        size: entry.product.size,
        weightKg: entry.product.weightKg,
        grade: entry.grade ?? entry.partyGrade ?? entry.product.grade,
        productType: entry.product.productType,
        packaging: entry.packaging.trim(),
        sequence: start + index + 1,
        fromPartyVariant: entry.partyAlias !== null || entry.partyGrade !== null,
        quantities: [
          {
            colour: entry.colour.trim(),
            quantity: Number(entry.boxes),
            variantCode: fixed ? null : (choice?.variantCode ?? null),
          },
        ],
      };
    });
    setCommitted((current) => [...current, ...items]);
    setSelected([]);
    setPhase('pick');
    window.setTimeout(() => categoryRef.current?.focus(), 0);
  }

  function removeCommitted(index: number): void {
    setCommitted((current) => current.filter((_, at) => at !== index));
  }

  // --- Save -------------------------------------------------------------------

  const isOther = sourcePlatform === 'other';
  const resolvedSource = isOther ? otherSource.trim() || sourcePlatform : sourcePlatform;

  async function save(): Promise<void> {
    if (!partyId) {
      setError(t('lead.add.errors.partyRequired'));
      return;
    }
    if (committed.length === 0) {
      setError(t('lead.add.errors.noProducts'));
      return;
    }
    if (phase === 'detail' || selected.length > 0) {
      setError(t('lead.add.errors.draftOpen'));
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const saved = await transportRef.current.createLead({
        partyId,
        sourcePlatform: resolvedSource || null,
        followUpDate: (followUpDate || null) as IsoDate | null,
        partyWiseMode: transportRef.current.partyWise(partyId),
        notes: notes.trim() || null,
        items: committed.map((item, index) => ({ ...item, sequence: index + 1 })),
      });
      onSaved(saved.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('lead.add.errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    Boolean(partyId) && committed.length > 0 && phase === 'pick' && selected.length === 0;
  const doneSteps = (partyId ? 1 : 0) + (resolvedSource ? 1 : 0) + (committed.length > 0 ? 1 : 0);

  const statusLine = !partyId
    ? t('lead.add.status.party')
    : committed.length === 0
      ? t('lead.add.status.products')
      : phase === 'detail' || selected.length > 0
        ? t('lead.add.status.draft')
        : t('lead.add.savingHint');

  // Ctrl+S saves from anywhere; Ctrl+Enter opens the review (or confirms it,
  // when the modal owns the key — see the modal's own handler).
  useCommand('record.save', busy || reviewOpen ? null : () => void save());

  /*
   * Enter forward, Escape back — one field at a time, down the whole form.
   * Ctrl+Enter is intercepted below before the walk sees it (the walk ignores
   * modified presses), and the pickers claim their own Enter/arrows first.
   */
  useEnterToAdvance(formRef);
  useEscapeToPrevious(formRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.key !== 'Enter' || !event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!formRef.current?.contains(target)) return;
      if (target.closest('[role="dialog"]')) return;
      if (target.tagName === 'TEXTAREA') return;
      // The modal's own handler confirms; this one only ever opens.
      if (reviewOpen) return;
      event.preventDefault();
      setError(null);
      setReviewOpen(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [reviewOpen]);

  /*
   * A themed, translated confirm rather than `window.confirm`, which in
   * Electron renders the bare Chromium prompt and blocks the renderer while it
   * is up. `useResetGuard` takes a promise for exactly this reason.
   */
  const confirmDiscard = useConfirm();
  useResetGuard(
    dirty
      ? () =>
          confirmDiscard({
            title: t('lead.add.discardConfirm'),
            confirmLabel: t('lead.add.discard'),
            tone: 'danger',
          })
      : null,
  );

  const totalBoxes = committed.reduce(
    (sum, item) => sum + item.quantities.reduce((row, entry) => row + entry.quantity, 0),
    0,
  );
  const summary =
    committed.length === 0
      ? t('lead.add.summary.empty')
      : t(committed.length === 1 ? 'lead.add.summary.countOne' : 'lead.add.summary.count', {
          count: committed.length,
          boxes: totalBoxes,
        });

  const selectedParty = chosenParty ?? seenParties.current.get(partyId) ?? null;
  const partyWiseMode = transportRef.current.partyWise(partyId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-20)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
        <h1 className="ob-title" style={{ margin: 0 }}>
          {t('lead.add.title')}
        </h1>
        <span
          className="ob-small"
          style={{
            padding: `${rem(1)} ${rem(7)}`,
            borderRadius: 'var(--r-sm)',
            background: 'var(--bg-sunken)',
            color: 'var(--fg-secondary)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {t('lead.add.progress', { done: doneSteps, total: 3 })}
        </span>
        <span style={{ flex: 1 }} />
        <Button variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
      </div>

      {error && <ConflictBanner>{error}</ConflictBanner>}

      {/*
       * Two columns that become one when there is no room for two: the form on
       * the left, and everything already added on the right, where it stays in
       * view while the next product is being built rather than pushing the
       * Complete button off the bottom of a growing page.
       */}
      <div className="ob-lead-cols">
        <div className="ob-lead-form" ref={formRef}>
          <Card padded={false}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--s-8)',
                padding: `${rem(9)} ${rem(12)}`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'stretch',
                  gap: rem(5),
                  width: '100%',
                }}
              >
                <Eyebrow>{t('lead.add.party.title')}</Eyebrow>
                {selectedParty ? (
                  <div
                    style={{
                      display: 'flex',
                      flex: 1,
                      minWidth: 0,
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: `${rem(4)} ${rem(10)}`,
                      padding: `${rem(5)} ${rem(6)} ${rem(5)} ${rem(11)}`,
                      border: '1px solid var(--line)',
                      borderRadius: 'var(--r-md)',
                    }}
                  >
                    <span className="ob-body-strong">{selectedParty.name}</span>
                    <span className="ob-mono ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                      {selectedParty.partyCode}
                    </span>
                    {selectedParty.phone && (
                      <span className="ob-small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {selectedParty.phone}
                      </span>
                    )}
                    {selectedParty.city && <span className="ob-small">{selectedParty.city}</span>}
                    {partyId && partyWiseMode && (
                      <span className="ob-small" style={{ color: 'var(--accent)' }}>
                        {t('lead.add.party.ownRates')}
                      </span>
                    )}
                    <span style={{ flex: 1, minWidth: 0 }} />
                    <Button
                      variant="secondary"
                      size="sm"
                      data-field
                      onClick={() => {
                        setPartyId('');
                        setChosenParty(null);
                        setPartyQuery('');
                        setPartyOpen(true);
                        setPartySel(0);
                        window.setTimeout(() => partyRef.current?.focus(), 0);
                      }}
                    >
                      {t('lead.add.party.change')}
                    </Button>
                  </div>
                ) : (
                  <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                    <Input
                      ref={partyRef}
                      value={partyQuery}
                      placeholder={t('lead.add.party.placeholder')}
                      aria-label={t('lead.add.party.search')}
                      autoComplete="off"
                      onFocus={() => setPartyOpen(true)}
                      onChange={(event) => {
                        setPartyQuery(event.target.value);
                        setPartyOpen(true);
                        setPartySel(0);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          setPartyOpen(false);
                          return;
                        }
                        if (event.key === 'ArrowDown') {
                          event.preventDefault();
                          setPartyOpen(true);
                          setPartySel(Math.min(partyPick + 1, Math.max(0, parties.length - 1)));
                        }
                        if (event.key === 'ArrowUp') {
                          event.preventDefault();
                          setPartySel(Math.max(0, partyPick - 1));
                        }
                        if ((event.key === 'Enter' || event.key === 'Tab') && parties[partyPick]) {
                          event.preventDefault();
                          chooseParty(parties[partyPick]);
                        }
                      }}
                    />
                    {partyOpen && (
                      <div role="listbox" className="ob-suggest">
                        {parties.map((party, index) => (
                          <button
                            key={party.id}
                            type="button"
                            className="ob-suggest-row"
                            style={{
                              gridTemplateColumns: `${rem(92)} minmax(0, 1fr) ${rem(130)}`,
                              background: index === partyPick ? 'var(--bg-selected)' : undefined,
                            }}
                            onMouseEnter={() => setPartySel(index)}
                            onClick={() => chooseParty(party)}
                          >
                            <span
                              className="ob-mono ob-micro"
                              style={{ color: 'var(--fg-tertiary)' }}
                            >
                              {party.partyCode}
                            </span>
                            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                              <span className="ob-body-strong ob-ellipsis">{party.name}</span>
                              <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                                {party.city ?? ''}
                              </span>
                            </span>
                            <span
                              className="ob-small"
                              style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                            >
                              {party.phone ?? ''}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="ob-lead-enquiry">
                <div style={{ display: 'flex', flexDirection: 'column', gap: rem(5), minWidth: 0 }}>
                  <Eyebrow>{t('lead.add.source.label')}</Eyebrow>
                  <Select
                    ref={sourceRef}
                    value={sourcePlatform}
                    aria-label={t('lead.add.step.source')}
                    style={{ width: '100%', maxWidth: rem(280) }}
                    onChange={(event) => {
                      setSourcePlatform(event.target.value);
                      if (event.target.value === 'other') {
                        window.setTimeout(() => otherRef.current?.focus(), 0);
                      }
                    }}
                  >
                    {sourceOptions.map((option) => (
                      <option key={option.id} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                  {isOther && (
                    <Input
                      ref={otherRef}
                      value={otherSource}
                      placeholder={t('lead.add.source.otherPlaceholder')}
                      aria-label={t('lead.add.source.otherLabel')}
                      style={{ width: '100%', maxWidth: rem(280) }}
                      onChange={(event) => setOtherSource(event.target.value)}
                    />
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: rem(5), minWidth: 0 }}>
                  <Eyebrow>{t('lead.add.followUp.label')}</Eyebrow>
                  <span
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: 'var(--s-4)',
                    }}
                  >
                    <DateField
                      value={followUpDate}
                      aria-label={t('lead.add.details.followUp')}
                      onChange={(event) => setFollowUpDate(event.target.value)}
                    />
                    {QUICK_FOLLOW_UPS.map(({ days, token }) => {
                      const iso = isoDate(days);
                      return (
                        <Chip
                          key={token}
                          active={followUpDate === iso}
                          onClick={() => setFollowUpDate((current) => (current === iso ? '' : iso))}
                        >
                          {t(token)}
                        </Chip>
                      );
                    })}
                  </span>
                </div>
              </div>
            </div>
          </Card>

          {/* --- Products: main product, then its models -------------------- */}

          <section style={{ display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: `${rem(6)} ${rem(10)}`,
                marginBottom: 'var(--s-6)',
              }}
            >
              <span className="ob-body-strong">{t('lead.add.products.title')}</span>
              <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                {committed.length
                  ? t('lead.add.products.searchAdds')
                  : t('lead.add.products.searchFirst')}
              </span>
              <span style={{ flex: 1, minWidth: 0 }} />
              {committed.length > 0 && (
                <span className="ob-small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {summary}
                </span>
              )}
            </div>

            <div className="ob-lead-pickers">
              <div style={{ position: 'relative', minWidth: 0 }}>
                <Eyebrow>{t('lead.add.flow.mainProduct')}</Eyebrow>
                <Input
                  ref={categoryRef}
                  value={
                    categoryId
                      ? (categoryRows.find((row) => row.id === categoryId)?.name ?? '')
                      : categoryQuery
                  }
                  placeholder={t('lead.add.flow.mainProductPlaceholder')}
                  aria-label={t('lead.add.flow.mainProduct')}
                  autoComplete="off"
                  onFocus={() => {
                    if (!categoryId) setCategoryOpen(true);
                  }}
                  onChange={(event) => {
                    if (categoryId) {
                      // Typing over a chosen main product starts a new search.
                      setCategoryId('');
                      setPhase('pick');
                      setSelected([]);
                    }
                    setCategoryQuery(event.target.value);
                    setCategoryOpen(true);
                    setCategorySel(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setCategoryOpen(false);
                      return;
                    }
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setCategoryOpen(true);
                      setCategorySel(
                        Math.min(categoryPick + 1, Math.max(0, categoryRows.length - 1)),
                      );
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setCategorySel(Math.max(0, categoryPick - 1));
                    }
                    if (
                      (event.key === 'Enter' || event.key === 'Tab') &&
                      categoryRows[categoryPick]
                    ) {
                      event.preventDefault();
                      chooseCategory(categoryRows[categoryPick]);
                    }
                  }}
                />
                {!categoryId && categoryOpen && (
                  <div role="listbox" className="ob-suggest">
                    {categoryRows.map((row, index) => (
                      <button
                        key={row.id}
                        type="button"
                        className="ob-suggest-row"
                        style={{
                          gridTemplateColumns: 'minmax(0, 1fr)',
                          background: index === categoryPick ? 'var(--bg-selected)' : undefined,
                        }}
                        onMouseEnter={() => setCategorySel(index)}
                        onClick={() => chooseCategory(row)}
                      >
                        <span className="ob-body-strong ob-ellipsis">{row.name}</span>
                      </button>
                    ))}
                    {categoryRows.length === 0 && categoryQuery.trim() !== '' && (
                      <p className="ob-small" style={{ margin: 0, padding: 'var(--s-8)' }}>
                        {t('lead.add.flow.noHit')}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div style={{ position: 'relative', minWidth: 0 }}>
                <Eyebrow>{t('lead.add.flow.subProduct')}</Eyebrow>
                <Input
                  ref={modelRef}
                  value={modelQuery}
                  placeholder={t('lead.add.flow.subProductPlaceholder')}
                  aria-label={t('lead.add.flow.subProduct')}
                  data-screen-search
                  autoComplete="off"
                  disabled={!categoryId || phase !== 'pick'}
                  onFocus={() => {
                    if (categoryId && phase === 'pick') setModelOpen(true);
                  }}
                  onChange={(event) => {
                    setModelQuery(event.target.value);
                    setModelOpen(true);
                    setModelSel(0);
                  }}
                  onKeyDown={(event) => {
                    if (!categoryId) {
                      if (event.key === 'Enter' || event.key === 'Tab') {
                        event.preventDefault();
                        setError(t('lead.add.flow.noMainProduct'));
                        categoryRef.current?.focus();
                      }
                      return;
                    }
                    if (event.key === 'Escape') {
                      setModelOpen(false);
                      return;
                    }
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setModelOpen(true);
                      setModelSel(Math.min(modelPick + 1, Math.max(0, modelRows.length - 1)));
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setModelSel(Math.max(0, modelPick - 1));
                    }
                    // Enter claimed: the model joins the box and the caret
                    // stays on this picker for the next one.
                    if ((event.key === 'Enter' || event.key === 'Tab') && modelRows[modelPick]) {
                      event.preventDefault();
                      void addModel(modelRows[modelPick]);
                    }
                  }}
                />
                {phase === 'pick' && modelOpen && categoryId && (
                  <div role="listbox" className="ob-suggest">
                    {modelRows.map((row, index) => (
                      <button
                        key={row.id}
                        type="button"
                        className="ob-suggest-row"
                        style={{
                          gridTemplateColumns: 'minmax(0, 1fr) auto',
                          background: index === modelPick ? 'var(--bg-selected)' : undefined,
                        }}
                        onMouseEnter={() => setModelSel(index)}
                        onClick={() => void addModel(row)}
                      >
                        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                          <span
                            className="ob-body-strong ob-ellipsis"
                            style={{
                              fontSize: rem(15),
                              color: index === modelPick ? 'var(--accent)' : undefined,
                            }}
                          >
                            {row.name}
                          </span>
                          <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                            {row.size ?? ''}
                          </span>
                        </span>
                        <span className="ob-mono ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                          {row.productCode}
                        </span>
                      </button>
                    ))}
                    {modelRows.length === 0 && modelQuery.trim() !== '' && (
                      <p className="ob-small" style={{ margin: 0, padding: 'var(--s-8)' }}>
                        {t('lead.add.flow.noHit')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

            <p
              className="ob-micro"
              style={{ margin: `${rem(7)} 0 0`, color: 'var(--fg-tertiary)' }}
            >
              {t('lead.add.flow.mainProductHint')} {t('lead.add.flow.subProductHint')}
            </p>

            {/* The box the models collect in before details are filled. */}
            <div className="ob-lead-selected" aria-label={t('lead.add.flow.selectedTitle')}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--s-8)',
                  marginBottom: rem(4),
                }}
              >
                <Eyebrow>{t('lead.add.flow.selectedTitle')}</Eyebrow>
                <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                  {selected.length > 0
                    ? t('lead.add.flow.modelCount', { count: selected.length })
                    : ''}
                </span>
                <span style={{ flex: 1, minWidth: 0 }} />
                {phase === 'detail' ? (
                  <Button variant="secondary" size="sm" onClick={backToPick}>
                    {t('lead.add.flow.backToModels')}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    data-field
                    disabled={selected.length === 0}
                    title={t('lead.add.flow.nextHint')}
                    onClick={next}
                  >
                    {t('lead.add.flow.next')}
                  </Button>
                )}
              </div>
              {selected.length === 0 ? (
                <p className="ob-small" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
                  {t('lead.add.flow.selectedEmpty')}
                </p>
              ) : (
                <ul className="ob-lead-selected__list">
                  {selected.map((entry) => (
                    <li key={entry.key} className="ob-lead-selected__row">
                      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span className="ob-body-strong ob-ellipsis" style={{ fontSize: rem(15) }}>
                          {entry.product.name}
                        </span>
                        <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                          {entry.product.size ?? ''}
                        </span>
                      </span>
                      <span className="ob-mono ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                        {entry.product.productCode}
                      </span>
                      <button
                        type="button"
                        className="ob-btn ob-btn--ghost"
                        aria-label={t('lead.add.flow.removeModel', { model: entry.product.name })}
                        style={{ padding: 0, minWidth: rem(24) }}
                        onClick={() => removeSelected(entry.key)}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* One detail row per model: colour → packaging → grade → quantity. */}
            {phase === 'detail' && (
              <div className="ob-lead-details">
                {selected.map((entry) => (
                  <DetailRow
                    key={entry.key}
                    entry={entry}
                    packagingOptions={packagingOptions}
                    gradeOptions={gradeOptions}
                    colourOptions={colourOptions}
                    colourHex={colourHex}
                    suggestGrade={(value) => patchSelected(entry.key, { grade: value || null })}
                    onPatch={(patch) => patchSelected(entry.key, patch)}
                    onEnterLast={() => {
                      const index = selected.findIndex((row) => row.key === entry.key);
                      if (index === selected.length - 1) addProduct();
                      else {
                        const nextRow = formRef.current?.querySelectorAll('[data-detail-row]')[
                          index + 1
                        ] as HTMLElement | undefined;
                        nextRow?.querySelector<HTMLElement>('input, select')?.focus();
                      }
                    }}
                  />
                ))}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--s-8)',
                    marginTop: 'var(--s-8)',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }} />
                  <Button
                    variant="primary"
                    data-field
                    disabled={!detailReady()}
                    onClick={addProduct}
                  >
                    {t('lead.add.flow.addProduct')}
                  </Button>
                </div>
              </div>
            )}
          </section>

          {/* --- Notes -------------------------------------------------------- */}

          <section>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--s-8)',
                marginBottom: rem(5),
              }}
            >
              <Eyebrow>{t('lead.add.details.notes')}</Eyebrow>
              <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                {t('lead.add.step.notesHint')}
              </span>
            </div>
            <Textarea
              rows={3}
              value={notes}
              placeholder={t('lead.add.notes.placeholder')}
              aria-label={t('lead.add.details.notes')}
              onChange={(event) => setNotes(event.target.value)}
            />
          </section>

          {/* --- Complete ----------------------------------------------------- */}

          <div
            style={{
              borderTop: '1px solid var(--line)',
              paddingTop: 'var(--s-16)',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: `${rem(12)} ${rem(16)}`,
            }}
          >
            <Button
              variant="primary"
              size="lg"
              busy={busy}
              disabled={!ready}
              title="Ctrl+Enter"
              onClick={() => {
                setError(null);
                setReviewOpen(true);
              }}
            >
              {busy ? t('lead.add.flow.completing') : t('lead.add.flow.complete')}
            </Button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: rem(2) }}>
              <span className="ob-small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {summary}
              </span>
              <span
                className="ob-micro"
                style={{ color: ready ? 'var(--fg-tertiary)' : 'var(--state-offline)' }}
              >
                {statusLine}
              </span>
            </div>
          </div>
        </div>

        {/* --- Added products ------------------------------------------- */}

        <aside className="ob-lead-panel" aria-label={t('lead.add.panel.title')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
            <Eyebrow>{t('lead.add.panel.title')}</Eyebrow>
            <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
              {committed.length === 0 ? '' : String(committed.length)}
            </span>
            <span style={{ flex: 1, minWidth: 0 }} />
            <span className="ob-small" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {summary}
            </span>
          </div>

          {committed.length === 0 && (
            <p
              className="ob-small"
              style={{ margin: 0, padding: `${rem(12)} ${rem(2)}`, color: 'var(--fg-tertiary)' }}
            >
              {t('lead.add.panel.emptyNone')}
            </p>
          )}

          <div className="ob-lead-lines">
            {committed.map((item, index) => {
              const quantity = item.quantities[0];
              return (
                <div key={`${item.productId}-${index}`} className="ob-lead-line">
                  <div className="ob-lead-line__head">
                    <span
                      style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}
                    >
                      <span className="ob-body-strong ob-ellipsis" style={{ fontSize: rem(15) }}>
                        {item.productName}
                      </span>
                      <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                        {[item.categoryName, item.code, item.size].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span
                      className="ob-small"
                      style={{ fontVariantNumeric: 'tabular-nums', flex: 'none' }}
                    >
                      {quantity ? `${quantity.colour} ×${quantity.quantity}` : ''}
                    </span>
                    <button
                      type="button"
                      className="ob-btn ob-btn--ghost"
                      aria-label={t('lead.add.line.remove', {
                        product: item.productName ?? '',
                      })}
                      style={{ padding: 0, minWidth: rem(24) }}
                      onClick={() => removeCommitted(index)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      </div>

      <ReviewModal
        open={reviewOpen}
        partyName={selectedParty?.name ?? ''}
        source={resolvedSource}
        followUpDate={followUpDate}
        notes={notes}
        items={committed}
        busy={busy}
        onClose={() => setReviewOpen(false)}
        onConfirm={() => void save()}
      />
    </div>
  );
}

// --- Pieces -------------------------------------------------------------------

/** The small upper-case label that names a row without becoming a heading. */
function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="ob-eyebrow" style={{ flex: 'none', color: 'var(--fg-tertiary)' }}>
      {children}
    </span>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="ob-chip" aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}

/**
 * One model's detail row: colour → packaging → grade → quantity, walked by
 * Enter in that order.
 *
 * Colour is a dropdown only for selectable models (or when no base colour is
 * recorded); otherwise the fixed base colour reads as locked text with its
 * swatch. Enter on the last field commits the whole group when this is the
 * last row, or steps into the next row — `onEnterLast` decides.
 */
function DetailRow({
  entry,
  packagingOptions,
  gradeOptions,
  colourOptions,
  colourHex,
  onPatch,
  suggestGrade,
  onEnterLast,
}: {
  entry: SelectedModel;
  packagingOptions: Array<{ value: string; label: string }>;
  gradeOptions: Array<{ value: string; label: string }>;
  colourOptions: Array<{ value: string; label: string }>;
  colourHex: (name: string) => string | undefined;
  onPatch: (patch: Partial<SelectedModel>) => void;
  suggestGrade: (value: string) => void;
  onEnterLast: () => void;
}) {
  const fixed = fixedColourOf(entry.product);
  const gradeValues = [
    ...gradeOptions,
    ...(entry.grade && !gradeOptions.some((option) => option.value === entry.grade)
      ? [{ value: entry.grade, label: entry.grade }]
      : []),
  ];

  return (
    <div className="ob-lead-detail" data-detail-row>
      <div className="ob-lead-detail__head">
        <span className="ob-mono ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
          {entry.product.productCode}
        </span>
        <span className="ob-body-strong ob-ellipsis" style={{ fontSize: rem(16), flex: 1 }}>
          {entry.product.name}
        </span>
        <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
          {entry.product.size ?? ''}
        </span>
      </div>
      <div className="ob-lead-detail__fields">
        {fixed ? (
          <span className="ob-small" title={t('lead.add.flow.fixedColour')}>
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: rem(13),
                height: rem(13),
                borderRadius: '50%',
                background: colourHex(fixed) ?? 'var(--bg-sunken)',
                border: '1px solid var(--line-strong)',
                verticalAlign: 'text-bottom',
                marginRight: rem(6),
              }}
            />
            {fixed}
          </span>
        ) : (
          <Select
            value={entry.colour}
            aria-label={t('lead.add.flow.chooseColour')}
            style={{ maxWidth: rem(200) }}
            onChange={(event) => onPatch({ colour: event.target.value })}
          >
            {(entry.colourChoices.length > 0
              ? entry.colourChoices.map((choice) => ({
                  value: choice.colour,
                  label: choice.colour,
                }))
              : colourOptions
            ).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
        <SuggestInput
          value={entry.packaging}
          invalid={!entry.packaging.trim()}
          placeholder={t('lead.add.draft.packaging')}
          optionsLabel={t('lead.add.draft.showOptions', { field: t('lead.add.draft.packaging') })}
          options={packagingOptions}
          onChange={(next) => onPatch({ packaging: next })}
        />
        <SuggestInput
          value={entry.grade ?? ''}
          placeholder={t('lead.add.draft.grade')}
          optionsLabel={t('lead.add.draft.showOptions', { field: t('lead.add.draft.grade') })}
          options={gradeValues}
          onChange={(next) => suggestGrade(next)}
        />
        <Input
          value={entry.boxes}
          inputMode="numeric"
          placeholder="0"
          aria-label={t('lead.add.draft.col.quantity')}
          style={{ textAlign: 'right', maxWidth: rem(110) }}
          onChange={(event) => onPatch({ boxes: event.target.value.replace(/[^0-9]/g, '') })}
          onKeyDown={(event) => {
            const by = event.shiftKey ? 10 : 1;
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              onPatch({ boxes: String(Math.max(0, (Number(entry.boxes) || 0) + by)) });
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              onPatch({ boxes: String(Math.max(0, (Number(entry.boxes) || 0) - by)) });
            }
            // Enter claimed here — not left for the walk — because the next
            // step depends on which row this is: last row commits the group,
            // any other row steps into the next one.
            if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey) {
              event.preventDefault();
              onEnterLast();
            }
          }}
        />
      </div>
    </div>
  );
}

/**
 * The review before the lead is completed.
 *
 * A real `Modal`, so Esc closes it back to the form and focus is trapped and
 * restored. Ctrl+Enter confirms — its own handler, because the form's Ctrl+Enter
 * only ever opens (and is disabled while this is open).
 */
function ReviewModal({
  open,
  partyName,
  source,
  followUpDate,
  notes,
  items,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  partyName: string;
  source: string;
  followUpDate: string;
  notes: string;
  items: LineItemInput[];
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.key === 'Enter' && event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        onConfirm();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onConfirm]);

  const totalBoxes = items.reduce(
    (sum, item) => sum + item.quantities.reduce((row, entry) => row + entry.quantity, 0),
    0,
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('lead.add.flow.reviewTitle')}
      subtitle={t('lead.add.flow.reviewHint')}
      label={t('lead.add.flow.reviewTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" busy={busy} title="Ctrl+Enter" onClick={onConfirm}>
            {busy ? t('lead.add.flow.completing') : t('lead.add.flow.complete')}
          </Button>
        </>
      }
    >
      <dl className="ob-kv">
        <dt>{t('lead.add.party.title')}</dt>
        <dd>{partyName}</dd>
        <dt>{t('lead.add.source.label')}</dt>
        <dd>{source}</dd>
        <dt>{t('lead.add.followUp.label')}</dt>
        <dd>{followUpDate}</dd>
        {notes.trim() && (
          <>
            <dt>{t('lead.add.details.notes')}</dt>
            <dd>{notes.trim()}</dd>
          </>
        )}
      </dl>
      <div className="ob-lead-review">
        {items.map((item, index) => {
          const quantity = item.quantities[0];
          return (
            <div key={`${item.productId}-${index}`} className="ob-lead-review__row">
              <span className="ob-mono ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                {item.code ?? ''}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span className="ob-body-strong" style={{ fontSize: rem(15) }}>
                  {item.productName}
                </span>
                <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                  {[item.categoryName, item.size, quantity?.colour, item.packaging, item.grade]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className="ob-small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                ×{quantity?.quantity ?? 0}
              </span>
            </div>
          );
        })}
      </div>
      <p className="ob-small" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {t('lead.add.summary.count', { count: items.length, boxes: totalBoxes })}
      </p>
    </Modal>
  );
}

// Re-exported so panel adapters build the same wire shape without importing
// the Office screen they are replacing.
export type { LeadInput, LineItemInput };
