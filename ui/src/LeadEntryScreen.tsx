/**
 * New / edit pending order — shared form, mounted by the Master over HTTP.
 *
 * Port of `office/web/src/screens/AddLeadScreen.tsx`; keep in step (until the
 * Office switches to this copy, the form exists twice). Deliberate differences
 * from the Office copy:
 *  - it reads its data from a `LeadEntryView` and writes through a
 *    `LeadEntryTransport`, held in a ref (`ui/tests/no-transport-dep.test.ts`);
 *  - the Master saves online, so the save hint, the toast wording and the
 *    "list is empty" hints say "Fields → Option lists", not "Settings → Fields";
 *  - `canCreateParty` hides Create party without `parties.create`;
 *  - `onSaved(id, saved?)` also hands back the saved lead;
 *  - a failed save shows the server's translated message (`apiErrorText`);
 *  - there is no `view.parties`: editing seeds the picker with the lead's party;
 *  - `view.owners` (sent only with `record.reassignOwner`) adds an Owner picker,
 *    so a Server Master can raise a pending order for anybody.
 *
 * Original header follows.
 *
 * New lead — the screen office staff spend their day in
 * (docs/LEAD_GENERATION_FLOW.md §3, `New Lead Flow` design).
 *
 * One page, three required answers, and a chip in the header that says how many
 * are done: somebody at a counter with a customer on the phone needs to know
 * what is still missing without reading the whole form. Party, source and
 * follow-up share one compact card at the top because they are all *about* the
 * enquiry; the products below are the work.
 *
 * Products are found the way the catalogue is organised — **Brand → Product →
 * Sub product** (`docs/catalogue/CATALOGUE_MODEL.md` §6; in code a product is
 * a *category* and a sub product a *model*). The search box is the **product
 * bar**: a product by name or code, rows `CODE · Name · Brand`. Choosing one
 * opens the **product card** under it with EVERY sub product of that product,
 * one row for each variant on sale, in catalogue order. A row says what its
 * sub product's colour rule (`colourRuleOf`) leaves to ask:
 *  · `fixed` — the colour is the variant's label, shown and not chosen;
 *  · `dedicated` — nothing about colour at all (a dash);
 *  · `selectable` (multicolour) — a colour from the company's colour list in
 *    the row's colour select, and "+ Same sub product, another colour" adds a
 *    blank row under it, so White ×10 and Ivory ×5 are two rows.
 * A row is a line once it has a quantity. Each row's packaging sits beside its
 * quantity, a pick from the company's `line.packaging` list (required only
 * while the company requires it), and grade beside that, always optional.
 *
 * Keys, the way the counter works (the model is `ui/src/order/gridModel.ts`):
 *  · **Enter** walks a row's colour select (a multicolour row), quantity,
 *    packaging and grade (a pick moves on by itself), then the next row; after
 *    the last row it lands on Add product, whose Enter adds every counted row
 *    and returns to the product bar. A row nobody has started is skipped: from
 *    an empty quantity the walk goes past that row's packaging and grade, and
 *    from the closed colour select of a row with no quantity it goes on to the
 *    next row without opening the list. **Escape** walks back over the same
 *    stops;
 *  · **Shift+Q** adds a ready card and goes to the product bar. Anywhere it
 *    would do nothing it is a capital Q;
 *  · **Ctrl+Enter** opens a review of the finished lead, and Ctrl+Enter there
 *    saves it — once, however the key repeats. Ctrl+S still saves directly.
 *
 * The Added products list groups the lines by product (`groupLines`): code,
 * name and total pieces, then a line per sub product and colour; the pencil
 * lifts that product's lines back into the card, where Add puts them back in
 * place.
 *
 * The unit of a lead is **one variant in one colour** (`LineItem.variantId`,
 * `LineItem.colour`). A multicolour sub product ordered in White and Ivory adds
 * two lines on the same variant; the review groups them back into one row
 * (`White ×10, Ivory ×5`).
 *
 * Rules enforced visibly rather than only on the server:
 *  · **Packaging is never auto-filled.** While the company requires it the
 *    draft cannot be added until somebody chooses one; a party's saved
 *    packaging is only ever a suggestion.
 *  · **A colour is chosen only on a multicolour sub product**, and only from
 *    the company's colour list. The Master drops one sent for anything else
 *    rather than refuse the lead (§2), so this screen never sends one.
 *  · **The source is one of the company's listed sources.** There is no
 *    free-text "Other": the Master refuses an unlisted source, and a queued
 *    lead would bounce on it.
 *  · **A party's own record renames the product for that party.**
 *
 * Weights are the variant's and may not have been entered yet. A line without
 * one shows "weight missing" rather than a zero, and the footer counts such
 * lines beside the total weight it could compute.
 *
 * Saving works with no link to the Master: the lead is queued locally with a
 * temporary id and appears on the board immediately.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type {
  AssignablePerson,
  ColourRule,
  Lead,
  LeadInput,
  LeadUpdateInput,
  LineItemInput,
  OptionListItem,
  Party,
  PartyProductVariant,
  PickKind,
  PresenceLastWrite,
  Product,
  ProductCategory,
  SyncSnapshot,
} from '@orderbook/shared';
import {
  PICK_MAX_LIMIT,
  colourLabeller,
  colourRuleOf,
  lineColourText,
  resolveCompanyFeatures,
} from '@orderbook/shared';

import { Button } from './Button.js';
import { AddedGroup, AddedLine } from './order/AddedGroup.js';
import { AddedProductsPanel } from './order/AddedProductsPanel.js';
import { ColourSelect } from './order/ColourSelect.js';
import {
  addColourRow,
  buildRows,
  cardPieces,
  cardReady,
  groupLines,
  inCatalogueOrder,
  lineGroupKey,
  linesToRows,
  nextWalkStop,
  prevWalkStop,
  rowsToLines,
  type GridLine,
  type GridRow,
  type LineGroup,
  type WalkRow,
  type WalkStop,
} from './order/gridModel.js';
import { ProductCard, SubGrid, SubRow } from './order/ProductCard.js';
import { PartyChip } from './order/PartyChip.js';
import { ProductThumb } from './ProgressiveImage.js';
import { FollowUpField, OrderDetailsBar, OrderField } from './order/OrderDetailsBar.js';
import { ColourChip, StatusPill, useColourHex } from './DataDisplay.js';
import { useConfirm } from './ConfirmDialog.js';
import { apiErrorText } from './errorText.js';
import {
  changedLeadFields,
  StaleEditNotice,
  useLeadEditBase,
  type LeadFormValues,
} from './LeadStaleEdit.js';
import { DateField, Input, Textarea } from './Form.js';
import { formatKg } from './format.js';
import { t } from './i18n.js';
import { Icon } from './icons.js';
import { useCommand } from './KeyboardProvider.js';
import { Modal } from './Modal.js';
import { PartyFormModal, type CreatedParty, type PartyFormTransport } from './PartyFormModal.js';
import { rem } from './rem.js';
import { useResetGuard } from './ResetSlot.js';
import { Select } from './SuggestInput.js';
import { ConflictBanner } from './States.js';
import { useSubNav } from './SubNavSlot.js';
import { useUnsavedWork } from './unsavedWork.js';
import { useDebounced } from './useDebounced.js';
import { useEnterToAdvance, useEscapeToPrevious } from './useEnterToAdvance.js';

/** What the form reads: the slice of the sync snapshot an Office has locally, or the Master's `/api/lead-entry`. */
export type LeadEntryView = Pick<
  SyncSnapshot,
  'optionLists' | 'partyVariants' | 'partyGrants' | 'features'
> & {
  /** Edit only: the colour rule per line. Absent, it is worked out from the line. */
  products?: Product[];
  /**
   * Who a pending order may be raised for, sent only to somebody holding
   * `record.reassignOwner` (a Server Master, usually). Absent, the form has no
   * Owner picker and the lead is the caller's own.
   */
  owners?: AssignablePerson[];
};

/** What the form may reach. Held in a ref: callers may build the object inline. */
export interface LeadEntryTransport extends PartyFormTransport {
  pick<T>(
    kind: PickKind,
    q: { term: string; categoryId?: string; limit?: number },
  ): Promise<{ items: T[] }>;
  /** The Master answers with the lead, PO number and all. */
  createLead(input: LeadInput): Promise<{ id: string; poNumber?: string | null }>;
  updateLead(id: string, input: LeadUpdateInput): Promise<unknown>;
  /**
   * Which of these product ids are still in the catalogue; `live: null` when that cannot be told
   * (Master off or too old). Absent on a transport that cannot ask.
   */
  liveProducts?(ids: string[]): Promise<{ live: string[] | null }>;
}

interface Props {
  view: LeadEntryView;
  transport: LeadEntryTransport;
  /** `parties.create`: without it the party list offers no Create party. */
  canCreateParty?: boolean;
  /** Bumped by the shell each time the form is asked for; see the focus effect. */
  focusNonce?: number;
  /**
   * Moves whenever the catalogue changes (a product, sub product or variant added, edited,
   * deleted). The product and sub-product bars read again and the open form is kept:
   * nothing is unmounted, so the draft and the caret stay where they were.
   */
  catalogueRevision?: number;
  /** The saved lead's id; `saved` is the lead as the Master returned it (edit). */
  onSaved: (id: string, saved?: Lead) => void;
  onCancel: () => void;
  /**
   * A saved lead to edit instead of starting a new one. The form opens on its
   * party, source, follow-up, notes and lines, and Save sends only what changed
   * since it opened, with the clocks it opened at (`LeadStaleEdit.tsx`); the
   * lines go, whole, only when they changed.
   */
  lead?: Lead;
  /** The last save somebody else made to `lead` while it is open (a presence push). */
  remoteChange?: PresenceLastWrite | null;
}

/** One line on the lead: one variant, one colour, one quantity. */
type DraftLine = GridLine;

/**
 * The product card, open: the chosen product and a row for each variant of each of its sub
 * products. A card lifted from the Added products list (an edit) holds that product's lines only.
 */
interface DraftCard {
  categoryName: string;
  categoryCode: string | null;
  brand: string | null;
  rows: GridRow[];
  /** Where the lines go back to when the card is an edit of a group; null appends them. */
  at: number | null;
}

const QUICK_FOLLOW_UPS = [
  { days: 1, token: 'lead.add.followUp.tomorrow' },
  { days: 3, token: 'lead.add.followUp.inThreeDays' },
  { days: 7, token: 'lead.add.followUp.nextWeek' },
] as const;

/**
 * How many added products the panel will draw at once.
 *
 * The panel is a scroller, not a page, and a lead with more products than this
 * is one somebody is searching rather than reading. The cap is announced rather
 * than silent — see `lead.add.panel.truncated`.
 */
const PANEL_LIMIT = 60;

/** Local calendar date as `YYYY-MM-DD`, matching `Lead.followUpDate`'s format. */
function isoDate(daysFromToday: number): string {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday);
  const month = String(day.getMonth() + 1).padStart(2, '0');
  return `${day.getFullYear()}-${month}-${String(day.getDate()).padStart(2, '0')}`;
}

/** Weight × quantity to three decimals, or null while the weight is unknown. */
function lineWeight(line: { weightKg: number | null; quantity: number }): number | null {
  if (line.weightKg === null) return null;
  return Math.round(line.weightKg * line.quantity * 1000) / 1000;
}

/**
 * The products matching what is typed in the product bar, the Master's rule
 * (`pickCategories`): the code from its start, the name or brand anywhere, a
 * code typed in full first, catalogue order otherwise (the sort is stable).
 *
 * Local for the sub-product bar's reason: `OPT⏎` typed blind took the first
 * row of the list from before the code, which the debounced search had not
 * replaced yet.
 */
function productMatches(rows: readonly ProductCategory[], term: string): ProductCategory[] {
  if (!term) return rows.slice();
  const code = (row: ProductCategory): string => (row.code ?? '').toLowerCase();
  return rows
    .filter(
      (row) =>
        code(row).startsWith(term) ||
        row.name.toLowerCase().includes(term) ||
        (row.brand ?? '').toLowerCase().includes(term),
    )
    .sort((a, b) => Number(code(b) === term) - Number(code(a) === term));
}

/** A bare key, or one with a chord held — a chord is somebody's shortcut. */
function chorded(event: {
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
}

/** A saved lead's lines as the form's own, so they can be modified and removed like new ones. */
function linesOf(lead: Lead, view: LeadEntryView): DraftLine[] {
  return lead.items.map((item, index) => {
    const product = view.products?.find((candidate) => candidate.id === item.productId);
    // The product's own rule while the catalogue still has it; otherwise read
    // off the line — a chosen colour only exists on a multicolour one.
    const rule: ColourRule = product
      ? colourRuleOf(product)
      : item.colour
        ? 'selectable'
        : item.variantLabel
          ? 'fixed'
          : 'dedicated';
    return {
      key: `saved-${index + 1}`,
      productId: item.productId,
      productName: item.productName,
      categoryName: item.categoryName ?? '',
      categoryCode: item.categoryCode,
      brand: item.brandName,
      alias: item.alias,
      size: item.size,
      image: product?.images?.[0],
      packaging: item.packaging ?? '',
      rule,
      grade: item.grade ?? '',
      fromPartyVariant: item.fromPartyVariant,
      notes: item.notes ?? '',
      variantId: item.variantId,
      variantLabel: item.variantLabel,
      code: item.code ?? '',
      weightKg: item.weightKg,
      colour: item.colour ?? '',
      quantity: item.quantity,
    };
  });
}

/**
 * The form, opened again from scratch by Reload theirs: a new mount reads the
 * lead as it is now, which no amount of resetting state in place does reliably.
 */
/** How many products on the order are checked against the catalogue after a change. */
const LIVE_CHECK_BATCH = 200;

/** How long Save waits for the Master's live-ids answer before saving as if it could not tell. */
const LIVE_SAVE_WAIT_MS = 3000;

export function LeadEntryScreen(props: Props) {
  const [opening, setOpening] = useState(0);
  return <LeadEntryForm key={opening} {...props} onReload={() => setOpening((n) => n + 1)} />;
}

function LeadEntryForm({
  view,
  transport,
  canCreateParty = true,
  focusNonce = 0,
  catalogueRevision = 0,
  onSaved,
  onCancel,
  lead,
  remoteChange,
  onReload,
}: Props & { onReload: () => void }) {
  // Read inside effects and callbacks, never listed as a dependency.
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const colourHex = useColourHex(view.optionLists);
  // The company's switches, each absence resolved to the setting's own
  // declared fallback at this panel's edge.
  const features = resolveCompanyFeatures(view.features);
  const packagingRequired = features.packagingRequiredOnConvert;

  const [partyId, setPartyId] = useState(lead?.partyId ?? '');
  const [partyQuery, setPartyQuery] = useState('');
  const [partyOpen, setPartyOpen] = useState(false);
  const [partySel, setPartySel] = useState(0);
  const [partyRows, setPartyRows] = useState<Party[]>([]);
  const [partyDrawerOpen, setPartyDrawerOpen] = useState(false);

  const [sourcePlatform, setSourcePlatform] = useState(lead?.sourcePlatform ?? '');
  /*
   * Today plus the company's default (`leads.followUpDefaultDays`, 3 unless
   * the company says otherwise; 0 = today), not blank.
   *
   * Every lead gets followed up. A blank required-looking field on a form nobody
   * has touched reads as a fault — the same reasoning that fills the source
   * below. The quick chips and the picker both overwrite it, and clearing it is
   * one press of the chip that matches.
   *
   * A save starts a fresh form (the shell remounts this screen), which seeds it
   * again; the effect below re-seeds it when the company changes the default
   * while the form is open — over the old default only, so a date somebody
   * picked stays theirs.
   */
  const followUpDays = features.followUpDefaultDays;
  const [followUpDate, setFollowUpDate] = useState(() =>
    lead ? (lead.followUpDate ?? '') : isoDate(followUpDays),
  );
  const seededDays = useRef(followUpDays);
  useEffect(() => {
    const seeded = isoDate(seededDays.current);
    seededDays.current = followUpDays;
    setFollowUpDate((current) => (current === seeded ? isoDate(followUpDays) : current));
  }, [followUpDays]);
  const [notes, setNotes] = useState(lead?.notes ?? '');
  /** Only with `view.owners`; empty means the caller, which the Master assumes. */
  const [ownerId, setOwnerId] = useState(lead?.ownerId ?? '');
  const editBase = useLeadEditBase(lead);

  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sel, setSel] = useState(0);
  /** The product bar's answer. Cleared with the chip's ✕, Backspace on an empty box, or Shift+Q. */
  const [category, setCategory] = useState<ProductCategory | null>(null);
  /** Every product the bar can offer, in catalogue order; narrowed locally as somebody types. */
  const [allCategories, setAllCategories] = useState<ProductCategory[]>([]);
  /** Every live sub product of the chosen product, in catalogue order. */
  const [subRows, setSubRows] = useState<Product[]>([]);
  const [lines, setLines] = useState<DraftLine[]>(() => (lead ? linesOf(lead, view) : []));
  const [draft, setDraft] = useState<DraftCard | null>(null);
  /** The product's sub products have arrived, so the card can open on them. */
  const [subsLoaded, setSubsLoaded] = useState(false);
  /** The row the caret was last in: the "another colour" button works on it. */
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** Bumped when a card opens; the effect after it puts the caret on the first field. */
  const [cardOpened, setCardOpened] = useState(0);
  const addRef = useRef<HTMLDivElement>(null);
  /** Which Added products groups are ticked, and what is filtering them. */
  const [selected, setSelected] = useState<Record<string, true>>({});
  const [lineQuery, setLineQuery] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  /*
   * Set before the first await, which `busy` is not: a second Ctrl+Enter (or
   * Ctrl+S) reached `save` before the render that disables anything, and each
   * call queued the lead. Left set after a save, because the shell then
   * replaces this form with a fresh one.
   */
  const saving = useRef(false);

  /** The whole screen: the scope of Ctrl+Enter, since a hidden screen stays mounted. */
  const rootRef = useRef<HTMLDivElement>(null);
  /** The last "no longer in the catalogue" message shown, so it can be cleared with its lines. */
  const goneMessage = useRef<string | null>(null);
  /** The products section: the scope of Shift+Q. */
  const productsRef = useRef<HTMLElement>(null);
  const partyRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  /**
   * The form column, for the Enter/Escape walk.
   *
   * The column and not the whole screen: the panel on the right is a review of
   * what is already added, not a step on the way in, and Enter falling off the
   * end of the notes into its search box would be a detour out of the flow.
   *
   * No `onSubmit` either. Enter on the last field saves in a drawer, where the
   * last field is unambiguous and the dialog is the whole task; here it would
   * queue a lead from whichever field happened to be last on a screen whose
   * fields appear and disappear as products are drafted. Ctrl+S saves.
   */
  const formRef = useRef<HTMLDivElement>(null);
  /** Parties the picker has fetched, so a chosen one survives the term changing. */
  const seenParties = useRef(
    new Map<string, Party>(
      lead ? [[lead.partyId, { id: lead.partyId, name: lead.partyName } as unknown as Party]] : [],
    ),
  );
  /** Line keys, unique for the life of the screen. */
  const nextKey = useRef(1);

  /*
   * The sidebar has no New-lead item of its own — it is not a module, it is a
   * thing you are doing to the Leads module. Registering it as Leads' nested
   * entry is what puts Leads back under the cursor while the form is open;
   * without it nothing at all was highlighted and the header read "Office
   * Panel".
   */
  // Not when editing: the form is then the body of the lead's own sub-screen,
  // which carries the entry, and a New-lead draft may still hold `addLead`.
  useSubNav(
    lead ? 'leadEdit' : 'addLead',
    lead
      ? null
      : {
          parentId: 'leads',
          items: [{ id: 'addLead.new', label: t('lead.add.title'), icon: 'leads' }],
          activeId: 'addLead.new',
        },
  );

  const sourceOptions = useMemo(
    () =>
      view.optionLists.filter(
        (option: OptionListItem) => option.listKey === 'lead.sourcePlatform' && option.isActive,
      ),
    [view.optionLists],
  );

  const packagingOptions = useMemo(
    () =>
      view.optionLists.filter(
        (option: OptionListItem) => option.listKey === 'line.packaging' && option.isActive,
      ),
    [view.optionLists],
  );

  /**
   * The company's grade list. Ships empty, like packaging — a shop's grade
   * ladder is its own, and Settings → Fields is where it is kept.
   */
  const gradeOptions = useMemo(
    () =>
      view.optionLists.filter(
        (option: OptionListItem) => option.listKey === 'line.grade' && option.isActive,
      ),
    [view.optionLists],
  );

  /** The company's colour list — what a multi-colour line may name. */
  const colourOptions = useMemo(
    () =>
      view.optionLists.filter(
        (option: OptionListItem) => option.listKey === 'stock.colour' && option.isActive,
      ),
    [view.optionLists],
  );

  /**
   * A line keeps the colour list's VALUE; the screen shows that value's LABEL as the list has it
   * now, so a colour renamed in Fields reads the new way on every line without touching the lines.
   */
  const labelOf = useMemo(() => colourLabeller(colourOptions), [colourOptions]);

  /*
   * The enquiry came from somewhere, and on this screen it always came from the
   * first thing in the list until somebody says otherwise. A blank required
   * answer on a form nobody has touched reads as a fault rather than a question.
   *
   * A source the company stops listing while the form is open is let go too:
   * the select would show the first option over a value it no longer holds,
   * and the Master refuses an unlisted source on a new lead (§6.2).
   */
  const savedSource = lead?.sourcePlatform ?? null;
  useEffect(() => {
    setSourcePlatform((current) =>
      sourceOptions.some((option) => option.value === current) ||
      // The source a saved lead already has stays, listed or not; the Master
      // accepts an unchanged one (`assertSourcePlatform`).
      (current !== '' && current === savedSource)
        ? current
        : (sourceOptions[0]?.value ?? ''),
    );
  }, [sourceOptions, savedSource]);

  /**
   * Parties this person may actually put a lead against.
   *
   * A view-only grant is dropped. The Master refuses the save either way — a
   * lead against a view-only party is a 403 naming why — so this is not the
   * enforcement; it exists so the picker does not walk somebody into a refusal
   * for a party they are looking straight at.
   */
  const readOnlyParties = useMemo(
    () =>
      new Set(
        (view.partyGrants ?? [])
          .filter((grant) => grant.level === 'view')
          .map((grant) => grant.partyId),
      ),
    [view.partyGrants],
  );

  const selectedParty = seenParties.current.get(partyId) ?? null;

  /** The party's own product records, which are also what makes the "party-wise" badge true. */
  const partyRecordFor = useMemo(
    () =>
      new Map(
        view.partyVariants
          .filter((variant) => variant.partyId === partyId)
          .map((variant): [string, PartyProductVariant] => [variant.productId, variant]),
      ),
    [partyId, view.partyVariants],
  );
  const partyWiseMode = partyRecordFor.size > 0;

  // --- Party search -------------------------------------------------------

  const partyTerm = useDebounced(partyQuery, 200);
  /*
   * The text `partyRows` answers, and the text an Enter was pressed on before
   * its answer came. Parties are searched on the Master, so the list lags the
   * box by the debounce and the round trip: `Shah⏎` typed after a pause at
   * `Sha` took the first of `Sha`'s parties. That Enter now waits for its own.
   */
  const partyAnswered = useRef('');
  const partyEnterFor = useRef<string | null>(null);

  useEffect(() => {
    if (partyId) return;
    /*
     * Nothing is listed for an empty box (§6.1). A list that opened on focus
     * covered the source and follow-up with somebody else's parties before
     * anything had been typed, and Tab out of it took the first of them.
     */
    if (!partyTerm.trim()) {
      // Answered too — by nothing — so a `Sha⏎` typed next waits for its own.
      partyAnswered.current = partyTerm;
      setPartyRows([]);
      return;
    }
    let cancelled = false;

    void (async () => {
      let rows: Party[] = [];
      try {
        const page = await transportRef.current.pick<Party>('party', { term: partyTerm });
        for (const row of page.items) seenParties.current.set(row.id, row);
        rows = page.items.filter((party) => !readOnlyParties.has(party.id)).slice(0, 6);
      } catch {
        // The picker answers from the cached snapshot when the link is down, so
        // a failure here is a real one — and an empty list says so without a
        // banner over a field somebody is still typing in.
      }
      if (cancelled) return;
      partyAnswered.current = partyTerm;
      setPartyRows(rows);
      if (partyEnterFor.current === partyTerm) {
        partyEnterFor.current = null;
        if (rows[0]) chooseParty(rows[0]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [partyTerm, partyId, readOnlyParties]);

  /*
   * "+ Create a new party" is the row after the last party when the person may create one: with
   * no match it is the only row, highlighted at once, and Enter on it opens the dialog.
   */
  const lastPartyRow = canCreateParty ? partyRows.length : Math.max(0, partyRows.length - 1);
  const partyPick = Math.min(partySel, lastPartyRow);
  const partyListOpen = partyOpen && partyQuery.trim() !== '';

  function chooseParty(party: Party): void {
    seenParties.current.set(party.id, party);
    setPartyId(party.id);
    setPartyQuery('');
    setPartyOpen(false);
    setPartySel(0);
    // On to the source, not straight to the products: the enquiry card is the
    // first three answers in order, and jumping the two of them that are left
    // meant they were filled in last or not at all. The rest of the way down is
    // Enter, one field at a time, so nothing needs to jump ahead any more.
    window.setTimeout(() => sourceRef.current?.focus(), 0);
  }

  // --- The product bar, then the sub-product bar -------------------------

  /*
   * Every product, fetched each time the bar is back on products (41 in the
   * catalogue), and matched as somebody types by `productMatches`.
   */
  useEffect(() => {
    if (category || draft) return;
    let cancelled = false;

    void (async () => {
      try {
        const page = await transportRef.current.pick<ProductCategory>('category', {
          term: '',
          limit: PICK_MAX_LIMIT,
        });
        if (!cancelled) setAllCategories(page.items);
      } catch {
        if (!cancelled) setAllCategories([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [category, draft, catalogueRevision]);

  const categoryRows = useMemo(
    // Every product, not the first seven: the list scrolls (`.ob-suggest`).
    () => productMatches(allCategories, query.trim().toLowerCase()),
    [allCategories, query],
  );

  const categoryId = category?.id ?? '';

  /*
   * Every sub product of the chosen product, fetched once (§6.5). The bar used
   * to show the first seven of a search, and One Piece Toilet alone has 56 —
   * the tail could only be reached by guessing its name.
   */
  useEffect(() => {
    setSubRows([]);
    setSubsLoaded(false);
  }, [categoryId]);

  useEffect(() => {
    if (!categoryId) return;
    let cancelled = false;

    void (async () => {
      try {
        const page = await transportRef.current.pick<Product>('product', {
          term: '',
          categoryId,
          limit: PICK_MAX_LIMIT,
        });
        if (!cancelled) {
          setSubRows(inCatalogueOrder(page.items));
          setSubsLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setSubRows([]);
          setSubsLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [categoryId, catalogueRevision]);

  /*
   * Products on this order (lines and the open card) that the catalogue no longer
   * has, found again each time the catalogue changes. They are flagged, not
   * dropped: a lead already in progress keeps working and saves as it was.
   */
  const [gone, setGone] = useState<Array<{ id: string; name: string }>>([]);
  const goneNames = gone.map((product) => product.name);

  const checkedProducts = useMemo(() => {
    const byId = new Map<string, string>();
    // On an existing lead its saved lines may legitimately name a product deleted since; only
    // what this edit adds is checked, because only that can make the Master refuse the save.
    for (const line of lines)
      if (!line.key.startsWith('saved-')) byId.set(line.productId, line.productName);
    for (const row of draft?.rows ?? []) {
      if (Number(row.qty) > 0) byId.set(row.productId, row.productName);
    }
    return [...byId];
  }, [lines, draft]);
  const checkedKey = checkedProducts.map(([id]) => id).join(',');

  useEffect(() => {
    if (checkedProducts.length === 0) {
      setGone([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // Ask the Master which of the ids are still live, in batches so no order is too long
        // for it. `null` is "cannot tell" (Master off or too old): say nothing, block nothing.
        const ids = checkedProducts.map(([id]) => id);
        const answers = await Promise.all(
          Array.from({ length: Math.ceil(ids.length / LIVE_CHECK_BATCH) }, (_, index) =>
            transportRef.current.liveProducts?.(
              ids.slice(index * LIVE_CHECK_BATCH, (index + 1) * LIVE_CHECK_BATCH),
            ),
          ),
        );
        if (cancelled) return;
        if (answers.some((answer) => !answer || !answer.live)) {
          setGone([]);
          return;
        }
        const live = new Set(answers.flatMap((answer) => answer!.live!));
        setGone(
          checkedProducts.filter(([id]) => !live.has(id)).map(([id, name]) => ({ id, name })),
        );
      } catch {
        // Unreachable or refused: say nothing rather than flag everything.
      }
    })();
    return () => {
      cancelled = true;
    };
    // The same ids, asked again whenever the catalogue changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkedKey, catalogueRevision]);

  const rows: ProductCategory[] = categoryRows;
  const pick = rows.length ? Math.min(sel, rows.length - 1) : 0;
  const listOpen = !draft && !category && searchOpen;
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row on screen as the arrows walk past the list's
  // visible rows. `?.()`: jsdom has no `scrollIntoView`.
  useEffect(() => {
    if (!listOpen) return;
    const rowEls = listRef.current?.querySelectorAll<HTMLElement>('button.ob-suggest-row');
    rowEls?.[pick]?.scrollIntoView?.({ block: 'nearest' });
  }, [listOpen, pick, category]);

  /** A key for a card row: unique for the life of the screen. */
  function newRowKey(): string {
    return `row-${nextKey.current++}`;
  }

  function chooseCategory(next: ProductCategory): void {
    setCategory(next);
    setQuery('');
    setSel(0);
    // The card opens by itself once the product's sub products have arrived (the effect below).
    setSearchOpen(false);
  }

  /** The card, closed — added, cleared, or Shift+Q — and the caret back in the product bar. */
  function closeCard(): void {
    setDraft(null);
    setCategory(null);
    setQuery('');
    setSel(0);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }

  // --- Draft --------------------------------------------------------------

  /** A counted row still without its packaging, while the company requires one. */
  const lacks = (r: GridRow) => packagingRequired && Number(r.qty) > 0 && !r.packaging.trim();

  /** The caret on the card's first field, the first thing it asks. */
  function focusFirstField(): void {
    gridRef.current
      ?.querySelector<HTMLElement>('.ob-order-colour__input, input[data-kind]')
      ?.focus();
  }

  /*
   * The chosen product's sub products have arrived: open the card on all of them. Only once per
   * choice (`draft` guards it), so a catalogue change mid-entry never rebuilds a card somebody has
   * typed into; `subRows` is read again only when the card is next opened.
   */
  useEffect(() => {
    if (!category || !subsLoaded || draft) return;
    setDraft({
      categoryName: category.name,
      categoryCode: category.code ?? null,
      brand: category.brand ?? null,
      rows: buildRows(subRows, {
        nextKey: newRowKey,
        partyRecordFor: (id) => partyRecordFor.get(id),
      }),
      at: null,
    });
    setCardOpened((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, subsLoaded, draft]);

  useEffect(() => {
    if (cardOpened > 0) focusFirstField();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardOpened]);

  function patchRow(key: string, patch: Partial<GridRow>): void {
    setDraft((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
          }
        : current,
    );
  }

  /** "+ Same sub product, another colour": a blank copy under the row, the caret on its colour. */
  function addAnotherColour(rowKey: string): void {
    const key = newRowKey();
    setDraft((current) =>
      current ? { ...current, rows: addColourRow(current.rows, rowKey, () => key) } : current,
    );
    window.setTimeout(
      () =>
        gridRef.current
          ?.querySelector<HTMLElement>(`[data-row-key="${key}"] .ob-order-colour__input`)
          ?.focus(),
      0,
    );
  }

  function draftIsReady(candidate: DraftCard): boolean {
    // `leads.packagingRequiredOnConvert` off: a shop that packs to order cannot state the
    // packaging at the counter, so a line may go in without. On, every counted row needs its own.
    return cardReady(candidate.rows, {
      packagingRequired,
      colourListNonEmpty: colourOptions.length > 0,
    });
  }

  /**
   * One line per row with a quantity — per variant, and per colour: White ×10 and Ivory ×5 are
   * two lines on the same variant. A card lifted from the list puts its lines back where they were.
   */
  function saveDraft(): void {
    if (!draft || !draftIsReady(draft)) return;

    const added = rowsToLines(draft.rows, () => `line-${nextKey.current++}`);
    const at = draft.at;

    setLines((current) => {
      const next = current.slice();
      if (at === null) next.push(...added);
      else next.splice(Math.min(at, next.length), 0, ...added);
      return next;
    });
    closeCard();
  }

  /** Lift one product's lines back into the card, on their own; Add puts them back in place. */
  function modifyGroup(group: LineGroup<DraftLine>): void {
    const at = lines.indexOf(group.lines[0]!);
    const doomed = new Set(group.lines.map((line) => line.key));
    setLines((current) => current.filter((candidate) => !doomed.has(candidate.key)));
    forget(group.key);
    setCategory(null);
    setDraft({
      categoryName: group.name,
      categoryCode: group.code,
      brand: group.brand,
      rows: linesToRows(group.lines, newRowKey),
      at: Math.max(0, at),
    });
    setSearchOpen(false);
    setCardOpened((n) => n + 1);
  }

  function removeGroup(group: LineGroup<DraftLine>): void {
    const doomed = new Set(group.lines.map((line) => line.key));
    setLines((current) => current.filter((candidate) => !doomed.has(candidate.key)));
    forget(group.key);
  }

  // --- The card's keys ----------------------------------------------------

  const cardTitle = draft ? draft.categoryName : '';
  /** While the company requires packaging, a counted row without it is what holds Add product back. */
  const lacksPackaging = Boolean(draft?.rows.some(lacks));
  /** The product's photo: the first sub product that has one, since a product itself has none. */
  const cardImage = draft?.rows.find((row) => row.image)?.image;

  /** A selectable row can take "another colour": the one the caret is on, else the last counted. */
  const selectableRows = draft?.rows.filter((row) => row.rule === 'selectable') ?? [];
  const someSelectable = colourOptions.length > 0 && selectableRows.length > 0;
  const moreTarget = someSelectable
    ? (
        selectableRows.find((row) => row.key === activeRow) ??
        [...selectableRows].reverse().find((row) => Number(row.qty) > 0) ??
        selectableRows[selectableRows.length - 1]
      )?.key
    : undefined;

  /** The party's saved packaging is offered for the rows still without one — never applied alone. */
  const suggestedAny = Boolean(
    draft?.rows.some((row) => row.packaging === '' && partyRecordFor.get(row.productId)?.packaging),
  );

  function useSuggestedPackaging(): void {
    setDraft((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((row) => {
              const suggested = partyRecordFor.get(row.productId)?.packaging;
              return row.packaging === '' && suggested ? { ...row, packaging: suggested } : row;
            }),
          }
        : current,
    );
  }

  function stepQty(row: GridRow, delta: number): void {
    const current = Number(row.qty) || 0;
    patchRow(row.key, { qty: String(Math.max(0, current + delta)) });
  }

  /** The card's fields in DOM order (a multicolour row's colour select first), and its Add button. */
  function cardStops() {
    const body = gridRef.current;
    if (!body) return null;
    const fields = Array.from(
      body.querySelectorAll<HTMLInputElement>('.ob-order-colour__input, input[data-kind]'),
    );
    const add = addRef.current?.querySelector<HTMLElement>('[data-add-card]') ?? null;
    const stops: WalkStop[] = fields.map((field) => ({
      rowKey: field.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey ?? null,
      field: field.classList.contains('ob-order-colour__input')
        ? 'colour'
        : (field.dataset.kind as WalkStop['field']),
    }));
    stops.push({ rowKey: null, field: 'add' });
    return { fields, add, stops };
  }

  /** What the walk needs to know of a row; `started` is a row whose colour was just taken. */
  function rowOf(key: string, started?: string): WalkRow {
    const row = draft?.rows.find((candidate) => candidate.key === key);
    return { qty: Number(row?.qty) || 0, hasColour: Boolean(row?.colour) || key === started };
  }

  /**
   * One stop on, row by row: each row's colour (a multicolour one), quantity, packaging and grade,
   * then Add product. A row nobody has started — no quantity and no colour — is skipped whole, and
   * from a row with no quantity the walk skips its packaging and grade (`nextWalkStop`). A disabled
   * Add takes no focus, so a card still short of something keeps the caret where it is and the
   * footer says what is missing.
   */
  function stepOn(from: Element | null, started?: string): void {
    const found = cardStops();
    if (!found || !from) return;
    const index = found.fields.indexOf(from as HTMLInputElement);
    if (index < 0) return;
    const next = nextWalkStop(found.stops, index, (key) => rowOf(key, started));
    if (next === null) return;
    (next < found.fields.length ? found.fields[next] : found.add)?.focus();
  }

  /**
   * Escape walks back over the same stops the forward walk uses: a row with no quantity has no
   * packaging or grade stop, so Escape from the row below lands on its quantity. Heard after a list
   * has closed itself (which spends the key) and before the screen's general step back.
   */
  function escapeBack(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape' || event.defaultPrevented || chorded(event)) return;
    const found = cardStops();
    if (!found) return;
    const target = event.target as Element;
    const index =
      target === found.add ? found.fields.length : found.fields.indexOf(target as HTMLInputElement);
    if (index <= 0) return;
    const previous = prevWalkStop(found.stops, index, (key) => rowOf(key));
    if (previous === null) return;
    event.preventDefault();
    (previous < found.fields.length ? found.fields[previous] : found.add)?.focus();
  }

  function quantityKey(event: ReactKeyboardEvent<HTMLInputElement>, row: GridRow): void {
    const by = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      stepQty(row, by);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      stepQty(row, -by);
      return;
    }
    if (event.key !== 'Enter' || chorded(event)) return;
    // Claimed, not left to the screen's walk, which would run on past the Add button into the notes.
    event.preventDefault();
    stepOn(event.currentTarget);
  }

  /**
   * A packaging or grade box's Enter, heard after the list inside it has taken the highlighted value
   * (a wrapper's handler runs after the box's own). Escape needs nothing here: the list closes on its
   * first press when somebody opened it, and otherwise the screen's walk steps back.
   */
  function pickKey(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Enter' || chorded(event)) return;
    event.preventDefault();
    stepOn(event.target as Element);
  }

  /** A pick — by Enter or by mouse — moves on by itself (owner's instruction, 2026-09-30). */
  function picked(key: string, patch: Partial<GridRow>): void {
    patchRow(key, patch);
    stepOn(document.activeElement);
  }

  /** A retired value, or one typed on an older lead, stays shown — not silently blanked. */
  function valuesFor(
    options: OptionListItem[],
    current: string,
  ): Array<{ value: string; label: string }> {
    const listed = options.map((option) => ({ value: option.value, label: option.label }));
    return current && !listed.some((option) => option.value === current)
      ? [...listed, { value: current, label: current }]
      : listed;
  }

  /** Drop a key from the tick set — a line that is gone cannot stay selected. */
  function forget(key: string): void {
    setSelected((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  // --- The Added-products panel -------------------------------------------

  const panelTerm = lineQuery.trim().toLowerCase();

  /*
   * Matched on the same words the row shows — code, product, colour, grade and
   * category — so what somebody reads is what they can search.
   */
  const matchedLines = panelTerm
    ? lines.filter((line) =>
        [
          line.code,
          line.productName,
          line.variantLabel ?? '',
          line.colour,
          line.grade,
          line.categoryName,
        ]
          .join(' ')
          .toLowerCase()
          .includes(panelTerm),
      )
    : lines;

  const panelLines = matchedLines.slice(0, PANEL_LIMIT);

  /*
   * Ticks are keyed by line, and a line can be removed while ticked (by its own
   * Remove, or by a Modify that lifts it back into the draft). Reading the set
   * back through the live lines keeps a stale key from inflating the count.
   */
  const groups = groupLines(panelLines);
  const selectedGroups = groups.filter((group) => selected[group.key]);
  const selectedLines = lines.filter((line) => selected[lineGroupKey(line)]);
  const shownKeys = groups.map((group) => group.key);
  const allShownTicked = shownKeys.length > 0 && shownKeys.every((key) => selected[key]);

  function toggleSelect(key: string): void {
    setSelected((current) => {
      const next = { ...current };
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });
  }

  function toggleSelectAllShown(): void {
    setSelected((current) => {
      const next = { ...current };
      for (const key of shownKeys) {
        if (allShownTicked) delete next[key];
        else next[key] = true;
      }
      return next;
    });
  }

  function removeSelected(): void {
    const doomed = new Set(selectedLines.map((line) => line.key));
    setLines((current) => current.filter((line) => !doomed.has(line.key)));
    setSelected({});
  }

  // --- Complete sub product (Shift+Q) --------------------------------------

  /**
   * Adds a pending valid sub product and goes to the product bar; with nothing
   * pending and an empty sub-product box, just finishes the product (§6.7).
   * False when it did nothing — a half-filled card, text in the box, no
   * product chosen — so the key it came from is left to type its Q.
   */
  function completeSubProduct(): boolean {
    if (!draft || !draftIsReady(draft)) return false;
    saveDraft();
    return true;
  }

  /*
   * A plain document listener, not a registered command: the keyboard provider
   * leaves a bare Shift+letter to the field the caret is in, and on this screen
   * the caret is always in one. Scoped to the products section, so a capital Q
   * in the notes, the party box or anywhere else is only ever a Q.
   *
   * Inside the section too, a box that takes words — packaging, a colour —
   * keeps its Q, even on a card ready to add. The bar's Q counts only while it
   * is empty (`completeSubProduct` checks), and a quantity takes no letters.
   */
  const completeRef = useRef(completeSubProduct);
  completeRef.current = completeSubProduct;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.key.toLowerCase() !== 'q') return;
      if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target;
      if (!(target instanceof Node) || !productsRef.current?.contains(target)) return;
      if (
        target instanceof HTMLInputElement &&
        target !== searchRef.current &&
        target.getAttribute('inputmode') !== 'numeric'
      ) {
        return;
      }
      if (completeRef.current()) event.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // --- Save ---------------------------------------------------------------

  /** Why the lead cannot be saved yet, or null when it can. */
  function refusal(): string | null {
    if (!partyId) return t('lead.add.errors.partyRequired');
    if (lines.length === 0) return t('lead.add.errors.noProducts');
    if (draft) return t('lead.add.errors.draftOpen');
    // The Master refuses a whole new order that names a deleted product: stop here, keep the form.
    const goneLines = lines.filter((line) => gone.some((product) => product.id === line.productId));
    if (goneLines.length > 0) {
      const message = t('lead.add.errors.goneLines', {
        names: [...new Set(goneLines.map((line) => line.productName))].join(', '),
      });
      goneMessage.current = message;
      return message;
    }
    return null;
  }

  /*
   * The "no longer in the catalogue" message belongs to the lines it names: once none of them is on
   * the order any more (removed, or the product is back), it goes too instead of lingering.
   */
  useEffect(() => {
    if (error === null || error !== goneMessage.current) return;
    if (lines.some((line) => gone.some((product) => product.id === line.productId))) return;
    goneMessage.current = null;
    setError(null);
  }, [error, lines, gone]);

  /** The form as the Master would receive it; also what "Save all" compares with the lead as opened. */
  function buildInput(): LeadFormValues {
    const items: LineItemInput[] = lines.map((line, index) => ({
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity,
      productName: line.productName,
      categoryName: line.categoryName,
      categoryCode: line.categoryCode,
      brandName: line.brand,
      alias: line.alias,
      code: line.code,
      variantLabel: line.variantLabel,
      // Only a multicolour sub product carries one; the Master drops any other.
      colour: line.colour.trim() || null,
      grade: line.grade.trim() || null,
      size: line.size,
      weightKg: line.weightKg,
      packaging: line.packaging.trim(),
      sequence: index + 1,
      fromPartyVariant: line.fromPartyVariant,
      notes: line.notes.trim() || null,
    }));

    return {
      partyId,
      sourcePlatform: sourcePlatform || null,
      followUpDate: followUpDate || null,
      partyWiseMode,
      notes: notes.trim() || null,
      items,
      ownerId: view.owners ? ownerId : undefined,
    };
  }

  async function save(): Promise<void> {
    if (saving.current) return;
    const problem = refusal();
    if (problem) {
      setError(problem);
      return;
    }

    saving.current = true;
    setBusy(true);
    setError(null);

    try {
      // Asked again now, not read from the background check: a product deleted a moment ago
      // would otherwise get the whole order refused. Unanswerable (Master off or old) goes on.
      const added = lines.filter((line) => line.key.startsWith('saved-') === false);
      const ids = [...new Set(added.map((line) => line.productId))];
      const ask = transportRef.current.liveProducts;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer =
        ids.length > 0 && ask
          ? await Promise.race([
              ask.call(transportRef.current, ids).catch(() => null),
              new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), LIVE_SAVE_WAIT_MS);
              }),
            ])
          : null;
      clearTimeout(timer);
      if (answer?.live) {
        const live = new Set(answer.live);
        const missing = added.filter((line) => !live.has(line.productId));
        if (missing.length > 0) {
          setGone(
            [...new Map(missing.map((line) => [line.productId, line.productName])).entries()].map(
              ([id, name]) => ({ id, name }),
            ),
          );
          const message = t('lead.add.errors.goneLines', {
            names: [...new Set(missing.map((line) => line.productName))].join(', '),
          });
          goneMessage.current = message;
          setError(message);
          saving.current = false;
          setBusy(false);
          return;
        }
      }
    } catch {
      // Cannot tell: the Master still decides on save.
    }

    try {
      const input = buildInput();

      if (lead && editBase.opened) {
        // Only what changed, checked against the clocks it was opened at.
        const changes = changedLeadFields(editBase.opened, input, editBase.base);
        const saved = changes
          ? ((await transportRef.current.updateLead(lead.id, changes)) as Lead | undefined)
          : undefined;
        onSaved(lead.id, saved);
      } else {
        const { ownerId: chosen, ...rest } = input;
        const created = await transportRef.current.createLead(
          chosen ? { ...rest, ownerId: chosen } : rest,
        );
        // The whole lead, from the Master; its number names it in the toast.
        if (created.poNumber) onSaved(created.id, created as Lead);
        else onSaved(created.id);
      }
    } catch (caught) {
      saving.current = false;
      if (!editBase.refused(caught)) setError(apiErrorText(caught, 'lead.add.errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  /*
   * Ctrl+Enter: the review when the lead is ready (§6.8), the save when the
   * review is up. Auto-repeat is swallowed — a held chord would otherwise open
   * the review and save it before anybody had read it — and `saving` stops two
   * real presses that land before the next render.
   *
   * Scoped to this screen, which stays mounted while hidden. Another dialog on
   * it (the new-party form) keeps its own Ctrl+Enter: false leaves the key alone.
   */
  const ctrlEnterRef = useRef<(target: Element, repeat: boolean) => boolean>(() => false);
  ctrlEnterRef.current = (target, repeat) => {
    if (!reviewOpen && target.closest('[role="dialog"]')) return false;
    if (repeat) return true;
    if (reviewOpen) {
      void save();
      return true;
    }
    const problem = refusal();
    setError(problem);
    if (!problem) setReviewOpen(true);
    return true;
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.key !== 'Enter' || !event.ctrlKey) return;
      if (event.altKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (!(target instanceof Element) || !rootRef.current?.contains(target)) return;
      if (ctrlEnterRef.current(target, event.repeat)) event.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const totalQty = lines.reduce((sum, line) => sum + line.quantity, 0);
  /*
   * The weight is summed over the lines that have one and the rest are counted,
   * the same way the Master reports it: a missing weight is a fact to show, not
   * a zero to add.
   */
  const totalWeight = lines.reduce((sum, line) => sum + (lineWeight(line) ?? 0), 0);
  const unweighed = lines.filter((line) => line.weightKg === null).length;

  const ready = Boolean(partyId) && lines.length > 0 && !draft;
  /** Distinct products on the order: the panel counts products, and lines under them. */
  const productCount = groupLines(lines).length;
  const doneSteps = (partyId ? 1 : 0) + (sourcePlatform ? 1 : 0) + (lines.length > 0 ? 1 : 0);

  const statusLine = !partyId
    ? t('lead.add.status.party')
    : lines.length === 0
      ? t('lead.add.status.products')
      : draft
        ? t('lead.add.status.draft')
        : t('lead.add.savingHintOnline');

  useCommand('record.save', busy ? null : () => void save());

  /*
   * Enter forward, Escape back — one field at a time, down the whole column:
   * party, source, follow-up, the product search, the draft card's colours,
   * then each row's quantity, packaging and grade (the card claims those
   * Enters, and after the last grade lands on Add product), then the notes and
   * any custom fields.
   *
   * A select opens its list on Enter instead of skipping past it, and the
   * native popup then owns the arrows and its own Enter; the Enter after it
   * closes moves on. Both halves are in `useEnterToAdvance`.
   */
  useEnterToAdvance(formRef);
  useEscapeToPrevious(formRef);

  /*
   * Where the cursor goes when this form is asked for. A blank form starts at
   * the party picker, because that is the first thing a lead needs; a form
   * with anything already on it is left exactly as it was — somebody switched
   * tabs mid-lead and came back, and moving their cursor would be a second
   * interruption. The screen stays mounted while hidden, so the draft itself
   * never needs restoring.
   */
  const blank = !partyId && !partyQuery && lines.length === 0 && !draft && !notes.trim();
  useEffect(() => {
    if (focusNonce === 0 || !blank) return;
    const timer = window.setTimeout(() => partyRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  /*
   * Resetting throws away a lead somebody is part-way through typing, so it asks
   * first — but only when there is something to lose. In the product's own
   * dialog: `window.confirm` in Electron is unthemed, its buttons are never
   * translated, it shows the page origin in its title bar, and it blocks the
   * renderer while it is up (`ResetSlot.tsx` made the guard a promise for
   * exactly this).
   */
  const confirm = useConfirm();
  useResetGuard(
    partyId || lines.length > 0 || draft || notes.trim()
      ? () =>
          confirm({
            title: t('lead.add.discardConfirm'),
            confirmLabel: t('lead.add.discard'),
            tone: 'danger',
          })
      : null,
  );

  // "Save all and update" (1.4 R7b): a new lead that is ready is saved before an
  // update closes the window; one that is not is named, so nobody loses it unawares.
  const editChanged = Boolean(
    lead && editBase.opened && changedLeadFields(editBase.opened, buildInput(), editBase.base),
  );
  useUnsavedWork(
    lead ? `lead-edit:${lead.id}` : 'new-lead',
    (lead ? editChanged : partyId || lines.length > 0 || draft || notes.trim())
      ? {
          label: lead
            ? t('updates.saveAll.leadEdit', { party: lead.partyName })
            : selectedParty?.name
              ? t('updates.saveAll.leadFor', { party: selectedParty.name })
              : t('updates.saveAll.newLead'),
          save: async () => {
            if (refusal()) return false;
            await save();
            return saving.current;
          },
        }
      : null,
  );

  const summary =
    lines.length === 0
      ? t('lead.add.summary.empty')
      : t(lines.length === 1 ? 'lead.add.summary.countOne' : 'lead.add.summary.count', {
          count: lines.length,
          qty: totalQty,
        });

  return (
    <div ref={rootRef} className="ob-order-page">
      {/* --- Header ------------------------------------------------------ */}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
        {lead && (
          <h1 className="ob-title" style={{ margin: 0 }}>
            {t('lead.edit.title')}
          </h1>
        )}
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
      </div>

      {error && <ConflictBanner>{error}</ConflictBanner>}
      {editBase.conflicted && !busy && (
        <StaleEditNotice
          lastWrite={remoteChange}
          busy={busy}
          onReload={onReload}
          onKeepMine={editBase.keepMine}
        />
      )}

      <div className="ob-order-cols">
        <div ref={formRef} className="ob-order-formwrap">
          {/* --- The enquiry: party, source, follow-up, owner ----------------- */}

          <OrderDetailsBar hasOwner={Boolean(view.owners)}>
            <OrderField label={t('lead.add.party.title')} wide>
              {selectedParty ? (
                /*
                 * Name, code and city (owner's rule, 2026-10-07): the code and the town tell two
                 * Sharma Traders apart and stay on the chip once one is chosen. The close button is
                 * a step of the Enter/Escape walk (`data-field`, in the kit chip) so Escape from the
                 * source select still lands on the party after one has been chosen.
                 */
                <PartyChip
                  name={selectedParty.name}
                  code={selectedParty.partyCode}
                  city={selectedParty.city}
                  // The key keeps its name from when party records carried rates; the text says
                  // what it is now — the party's own product names are in use. No money is shown.
                  extra={
                    partyWiseMode ? (
                      <StatusPill tone="ok">{t('lead.add.party.ownRates')}</StatusPill>
                    ) : undefined
                  }
                  changeLabel={t('lead.add.party.change')}
                  onChange={() => {
                    setPartyId('');
                    setPartyQuery('');
                    setPartyOpen(true);
                    setPartySel(0);
                    window.setTimeout(() => partyRef.current?.focus(), 0);
                  }}
                />
              ) : (
                <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                  <Input
                    ref={partyRef}
                    value={partyQuery}
                    placeholder={t('lead.add.party.placeholder')}
                    aria-label={t('lead.add.party.search')}
                    autoComplete="off"
                    onChange={(event) => {
                      setPartyQuery(event.target.value);
                      setPartyOpen(true);
                      setPartySel(0);
                      // An Enter waiting on the old text is not one for the new.
                      partyEnterFor.current = null;
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setPartyOpen(false);
                        return;
                      }
                      if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        setPartyOpen(true);
                        setPartySel(Math.min(partyPick + 1, lastPartyRow));
                      }
                      if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        setPartySel(Math.max(0, partyPick - 1));
                      }
                      // Only over a list that is showing: the rows of the last
                      // term linger for the debounce after the box is cleared.
                      if (
                        (event.key === 'Enter' || event.key === 'Tab') &&
                        !chorded(event) &&
                        partyListOpen
                      ) {
                        // The rows on screen answer an older text: this key
                        // takes the first of its own answer when it comes.
                        if (partyAnswered.current !== partyQuery) {
                          event.preventDefault();
                          partyEnterFor.current = partyQuery;
                        } else if (partyRows[partyPick]) {
                          event.preventDefault();
                          chooseParty(partyRows[partyPick]);
                        } else if (event.key === 'Enter' && canCreateParty) {
                          // The create row: open the dialog, the typed name already in it.
                          event.preventDefault();
                          setPartyOpen(false);
                          setPartyDrawerOpen(true);
                        }
                      }
                    }}
                  />
                  {partyListOpen && (
                    <div role="listbox" className="ob-suggest">
                      {partyRows.map((party, index) => (
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
                      {canCreateParty && (
                        <button
                          type="button"
                          className="ob-btn ob-btn--ghost"
                          style={{
                            width: '100%',
                            justifyContent: 'flex-start',
                            color: 'var(--accent)',
                            background:
                              partyPick === partyRows.length ? 'var(--bg-selected)' : undefined,
                          }}
                          onMouseEnter={() => setPartySel(partyRows.length)}
                          onClick={() => {
                            setPartyOpen(false);
                            setPartyDrawerOpen(true);
                          }}
                        >
                          {t('lead.add.party.create')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </OrderField>

            <OrderField label={t('lead.add.source.label')}>
              {/*
               * A select rather than a row of chips: the list is company-defined and a shop with
               * eight sources wrapped the chips onto three lines above a field nobody had filled in
               * yet. The listed sources and nothing else (§6.2): the free-text box behind "Other"
               * sent whatever was typed as the source, which the Master refuses as unlisted. A
               * source the shop needs is added to the list, in Settings → Fields.
               */}
              <Select
                ref={sourceRef}
                value={sourcePlatform}
                aria-label={t('lead.add.step.source')}
                style={{ width: '100%' }}
                onChange={(event) => setSourcePlatform(event.target.value)}
              >
                {sourceOptions.map((option) => (
                  <option key={option.id} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </OrderField>

            <OrderField label={t('lead.add.followUp.label')}>
              <FollowUpField
                groupLabel={t('lead.add.followUp.group')}
                date={
                  <DateField
                    value={followUpDate}
                    aria-label={t('lead.add.details.followUp')}
                    onChange={(event) => setFollowUpDate(event.target.value)}
                  />
                }
                quick={QUICK_FOLLOW_UPS.map(({ days, token }) => {
                  const iso = isoDate(days);
                  return {
                    key: token,
                    label: t(`${token}Short`),
                    title: t(token),
                    active: followUpDate === iso,
                    onClick: () => setFollowUpDate((current) => (current === iso ? '' : iso)),
                  };
                })}
              />
            </OrderField>

            {/* Raising a pending order for somebody else: only for whoever the Master sent the list
              to (`record.reassignOwner`). */}
            {view.owners && (
              <OrderField label={t('lead.add.owner')}>
                <Select
                  value={ownerId}
                  aria-label={t('lead.add.owner')}
                  style={{ width: '100%' }}
                  onChange={(event) => setOwnerId(event.target.value)}
                >
                  {!lead && <option value="">{t('lead.add.owner.me')}</option>}
                  {view.owners.map((owner) => (
                    <option key={owner.id} value={owner.id}>
                      {owner.roleTier === 'server_master'
                        ? `${owner.displayName} · ${t('presence.serverMaster')}`
                        : owner.displayName}
                    </option>
                  ))}
                </Select>
              </OrderField>
            )}
          </OrderDetailsBar>

          <div className="ob-order-main">
            <div className="ob-order-card">
              <section ref={productsRef} style={{ display: 'flex', flexDirection: 'column' }}>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'baseline',
                    gap: `${rem(4)} ${rem(10)}`,
                    marginBottom: 'var(--s-10)',
                  }}
                >
                  <h2 className="ob-order-eyebrow">{t('lead.add.products.title')}</h2>
                  <span className="ob-order-hint">
                    {lines.length
                      ? t('lead.add.products.searchAdds')
                      : t('lead.add.products.searchFirst')}
                  </span>
                </div>

                {/* The product bar: the product first; its sub products open below as a grid. */}
                <div style={{ position: 'relative' }}>
                  <div className="ob-lead-search">
                    <Input
                      ref={searchRef}
                      value={draft ? cardTitle : query}
                      disabled={Boolean(draft)}
                      placeholder={t('lead.add.products.categoryPlaceholder')}
                      aria-label={t('lead.add.products.searchLabel')}
                      autoComplete="off"
                      style={{ flex: 1, minWidth: rem(160) }}
                      onFocus={() => setSearchOpen(true)}
                      onBlur={() => setSearchOpen(false)}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setSearchOpen(true);
                        setSel(0);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape' && searchOpen) {
                          event.preventDefault();
                          setSearchOpen(false);
                          return;
                        }
                        if (event.key === 'ArrowDown') {
                          event.preventDefault();
                          setSearchOpen(true);
                          setSel(Math.min(pick + 1, Math.max(0, rows.length - 1)));
                        }
                        if (event.key === 'ArrowUp') {
                          event.preventDefault();
                          setSel(Math.max(0, pick - 1));
                        }
                        /*
                         * A bare Enter takes the highlighted row; Tab only once something was
                         * typed. A chord is never a pick: Ctrl+Enter here is the review.
                         */
                        const takes =
                          !chorded(event) &&
                          (event.key === 'Enter' || (event.key === 'Tab' && query.trim() !== ''));
                        if (takes && listOpen && rows[pick]) {
                          // Claimed, so the Enter walk does not step past a choice that has only
                          // just been made.
                          event.preventDefault();
                          chooseCategory(rows[pick]!);
                        } else if (takes && listOpen && event.key === 'Enter') {
                          // Nothing to take (a typo): the caret stays in the bar. Escape closes
                          // the list for somebody who does mean to walk on.
                          event.preventDefault();
                        }
                      }}
                    />
                  </div>

                  {listOpen && (
                    <div role="listbox" className="ob-suggest" ref={listRef}>
                      <div
                        className="ob-suggest-row ob-eyebrow"
                        style={{
                          gridTemplateColumns: 'minmax(0, 1fr)',
                          color: 'var(--fg-tertiary)',
                        }}
                      >
                        <span>{t('lead.add.products.col.category')}</span>
                      </div>
                      {categoryRows.map((row, index) => (
                        <button
                          key={row.id}
                          type="button"
                          // Out of the Tab order, as in the sub-product list below.
                          tabIndex={-1}
                          className="ob-suggest-row"
                          style={{
                            gridTemplateColumns: 'minmax(0, 1fr)',
                            background: index === pick ? 'var(--bg-selected)' : undefined,
                          }}
                          onMouseEnter={() => setSel(index)}
                          // `mousedown`, not `click`: the input's blur would close
                          // the list out from under the pointer first.
                          onMouseDown={(event) => {
                            event.preventDefault();
                            chooseCategory(row);
                          }}
                        >
                          {/* `CODE · Name · Brand` (§6.4): the code is what the
                          counter types, the brand what tells two ranges'
                          same-named products apart. */}
                          <span className="ob-ellipsis">
                            {row.code && (
                              <span className="ob-mono ob-body-strong">
                                {row.code}
                                {' · '}
                              </span>
                            )}
                            <span
                              className="ob-body-strong"
                              style={{ color: index === pick ? 'var(--accent)' : undefined }}
                            >
                              {row.name}
                            </span>
                            {row.brand && (
                              <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
                                {' · '}
                                {row.brand}
                              </span>
                            )}
                          </span>
                        </button>
                      ))}
                      {categoryRows.length === 0 && (
                        <p className="ob-small" style={{ margin: 0, padding: 'var(--s-8)' }}>
                          {t('lead.add.products.noCategory')}
                        </p>
                      )}
                    </div>
                  )}

                  <p
                    className="ob-micro"
                    style={{ margin: `${rem(7)} 0 0`, color: 'var(--fg-tertiary)' }}
                  >
                    {draft
                      ? t('lead.add.products.pickedHint')
                      : t('lead.add.products.categoryHint')}
                  </p>
                </div>

                {!draft && !category && (
                  <div className="ob-order-empty">
                    <span className="ob-order-empty__title">
                      {t('lead.add.products.noneTitle')}
                    </span>
                    <span className="ob-order-empty__body">{t('lead.add.products.noneBody')}</span>
                  </div>
                )}

                {goneNames.length > 0 && (
                  <p
                    role="note"
                    data-catalogue-gone
                    className="ob-small"
                    style={{ margin: `${rem(8)} 0 0`, color: 'var(--state-conflict)' }}
                  >
                    {goneNames.length === 1
                      ? t('lead.add.catalogue.goneOne', { names: goneNames[0]! })
                      : t('lead.add.catalogue.goneMany', { names: goneNames.join(', ') })}
                  </p>
                )}

                {/* The product card: every sub product of the chosen product, a row each. */}
                {draft && (
                  <div style={{ marginTop: 'var(--s-12)' }} onKeyDown={escapeBack}>
                    <ProductCard
                      head={
                        <>
                          <ProductThumb
                            images={cardImage ? [cardImage] : undefined}
                            name={draft.categoryName}
                            size={48}
                            fallback="none"
                            alt=""
                          />
                          {draft.categoryCode && (
                            <span className="ob-order-product__chip">{draft.categoryCode}</span>
                          )}
                          <span className="ob-order-product__name">{draft.categoryName}</span>
                          {draft.brand && <span className="ob-order-eyebrow">{draft.brand}</span>}
                          <span style={{ flex: 1, minWidth: 0 }} />
                          <Button
                            variant="secondary"
                            size="sm"
                            aria-label={t('lead.add.products.clear')}
                            title={t('lead.add.products.clear')}
                            onClick={closeCard}
                          >
                            ✕
                          </Button>
                        </>
                      }
                      footer={
                        <div ref={addRef} className="ob-order-product__footrow">
                          <span className="ob-order-hint">{t('lead.add.card.shiftQ')}</span>
                          <span style={{ flex: 1, minWidth: 0 }} />
                          <span className="ob-order-product__pieces">
                            {`${t('lead.add.card.thisProduct')} ${cardPieces(draft.rows).toLocaleString('en-IN')} ${t('unit.pieces')}`}
                          </span>
                          {/*
                           * The last stop of the card's Enter walk, after the last row: Enter over a
                           * button is a click. `data-field` makes it a stop of the screen's Escape
                           * walk too, back to that row's grade. While the card is short of something
                           * the button is disabled, which takes it out of both.
                           */}
                          <Button
                            variant="secondary"
                            data-field
                            data-add-card
                            disabled={!draftIsReady(draft)}
                            aria-label={
                              draft.at !== null
                                ? t('lead.add.draft.saveChanges')
                                : t('lead.add.draft.saveProduct')
                            }
                            onClick={saveDraft}
                          >
                            {draft.at !== null
                              ? t('lead.add.draft.saveChanges')
                              : t('lead.add.draft.saveProduct')}
                            <span className="ob-order-kbd" aria-hidden="true">
                              Enter
                            </span>
                          </Button>
                        </div>
                      }
                    >
                      {draft.rows.length === 0 ? (
                        <p
                          className="ob-small"
                          style={{ margin: rem(14), color: 'var(--fg-tertiary)' }}
                        >
                          {t('lead.add.card.noSubs')}
                        </p>
                      ) : (
                        <div
                          onFocus={(event) => {
                            const row = (event.target as HTMLElement).closest<HTMLElement>(
                              '[data-row-key]',
                            );
                            if (row?.dataset.rowKey) setActiveRow(row.dataset.rowKey);
                          }}
                        >
                          <SubGrid
                            bodyRef={gridRef}
                            labels={{
                              code: t('lead.add.products.col.code'),
                              sub: t('lead.add.products.col.product'),
                              colour: t('lead.add.draft.colour'),
                              weight: t('lead.add.products.col.weight'),
                              qty: t('lead.add.draft.col.qty'),
                              packaging: (
                                <>
                                  {t('lead.add.draft.packaging')}
                                  {packagingRequired && (
                                    <span
                                      aria-hidden="true"
                                      title={t('lead.add.step.required')}
                                      style={{ color: 'var(--state-offline)' }}
                                    >
                                      {' *'}
                                    </span>
                                  )}
                                </>
                              ),
                              grade: t('lead.add.draft.grade'),
                            }}
                          >
                            {draft.rows.map((row) => {
                              // The chosen colour on a multicolour row, else the fixed one.
                              const named = row.colour
                                ? `${row.code} · ${labelOf(row.colour)}`
                                : row.code;
                              const unpacked = lacks(row);
                              const chooses = row.rule === 'selectable' && colourOptions.length > 0;
                              return (
                                <SubRow key={row.key} rowKey={row.key}>
                                  <span className="ob-order-cell--code" title={row.code}>
                                    {row.code}
                                  </span>
                                  <span className="ob-order-cell--name" title={row.productName}>
                                    {row.productName}
                                  </span>
                                  {chooses ? (
                                    <ColourSelect
                                      value={row.colour}
                                      options={colourOptions}
                                      labelOf={labelOf}
                                      hexOf={colourHex}
                                      ariaLabel={`${t('lead.add.draft.colour')} — ${row.code}`}
                                      placeholder={t('lead.add.card.pickColour')}
                                      hint={t('lead.add.card.colourHint')}
                                      filterHint={t('lead.add.card.filterHint')}
                                      noMatches={t('common.noMatches')}
                                      attention
                                      onPick={(colour) => patchRow(row.key, { colour })}
                                      openOnEnter={Number(row.qty) > 0}
                                      onAdvance={(picked) =>
                                        stepOn(document.activeElement, picked ? row.key : undefined)
                                      }
                                    />
                                  ) : row.rule === 'fixed' && row.variantLabel ? (
                                    <span className="ob-order-cell--fixed">
                                      <ColourChip
                                        name={labelOf(row.variantLabel)}
                                        hex={colourHex(row.variantLabel)}
                                      />
                                      <span className="ob-order-cell--name">
                                        {labelOf(row.variantLabel)}
                                      </span>
                                    </span>
                                  ) : (
                                    <span className="ob-order-cell--none">—</span>
                                  )}
                                  <span className="ob-order-cell--num">
                                    <WeightCell kg={row.weightKg} />
                                  </span>
                                  <Input
                                    data-kind="qty"
                                    value={row.qty}
                                    inputMode="numeric"
                                    placeholder="0"
                                    aria-label={`${t('lead.add.draft.col.quantity')} — ${named}`}
                                    style={{ textAlign: 'right', minWidth: 0, width: '100%' }}
                                    onChange={(event) =>
                                      patchRow(row.key, {
                                        qty: event.target.value.replace(/[^0-9]/g, ''),
                                      })
                                    }
                                    onKeyDown={(event) => quantityKey(event, row)}
                                  />
                                  {/*
                                   * Packaging and grade beside the quantity and the same box: the
                                   * kit's pick-only `Select` is an `Input` with a list under it. Type
                                   * a letter or arrow down, Enter takes it and steps on; "—" is none.
                                   */}
                                  <span style={{ minWidth: 0 }} onKeyDown={pickKey}>
                                    <Select
                                      data-kind="packaging"
                                      value={row.packaging}
                                      aria-label={`${t('lead.add.draft.packaging')} — ${named}`}
                                      aria-required={packagingRequired || undefined}
                                      aria-invalid={unpacked || undefined}
                                      onChange={(event) =>
                                        picked(row.key, { packaging: event.target.value })
                                      }
                                    >
                                      <option value="">—</option>
                                      {valuesFor(packagingOptions, row.packaging).map((option) => (
                                        <option key={option.value} value={option.value}>
                                          {option.label}
                                        </option>
                                      ))}
                                    </Select>
                                  </span>
                                  <span style={{ minWidth: 0 }} onKeyDown={pickKey}>
                                    <Select
                                      data-kind="grade"
                                      value={row.grade}
                                      aria-label={`${t('lead.add.draft.grade')} — ${named}`}
                                      onChange={(event) =>
                                        picked(row.key, { grade: event.target.value })
                                      }
                                    >
                                      <option value="">—</option>
                                      {valuesFor(gradeOptions, row.grade).map((option) => (
                                        <option key={option.value} value={option.value}>
                                          {option.label}
                                        </option>
                                      ))}
                                    </Select>
                                  </span>
                                </SubRow>
                              );
                            })}
                          </SubGrid>
                        </div>
                      )}

                      {/* What is still missing, under the table, as on the Office: the footer keeps
                          the artboard's one short hint. */}
                      {lacksPackaging && (
                        <p
                          className="ob-order-hint"
                          data-card-hint
                          style={{
                            margin: 0,
                            padding: `${rem(6)} ${rem(14)} 0`,
                            color: 'var(--state-offline)',
                          }}
                        >
                          {t('lead.add.draft.hintPackaging')}
                        </p>
                      )}

                      {draft.rows.length > 0 && (
                        <div className="ob-order-more">
                          {someSelectable && (
                            <button
                              type="button"
                              disabled={!moreTarget}
                              onClick={() => moreTarget && addAnotherColour(moreTarget)}
                            >
                              <Icon name="plus" size={14} />
                              {t('lead.add.card.anotherColour')}
                            </button>
                          )}
                          {suggestedAny && (
                            <button type="button" onClick={useSuggestedPackaging}>
                              {t('lead.add.card.useSuggested')}
                            </button>
                          )}
                        </div>
                      )}
                      {draft.rows.length > 0 && packagingOptions.length === 0 && (
                        <p
                          className="ob-micro"
                          style={{ margin: `${rem(4)} ${rem(14)} 0`, color: 'var(--fg-tertiary)' }}
                        >
                          {t('lead.add.draft.packagingEmptyFields')}
                        </p>
                      )}
                      {draft.rows.length > 0 && gradeOptions.length === 0 && (
                        <p
                          className="ob-micro"
                          style={{
                            margin: `${rem(4)} ${rem(14)} ${rem(8)}`,
                            color: 'var(--fg-tertiary)',
                          }}
                        >
                          {t('lead.add.draft.gradeEmptyFields')}
                        </p>
                      )}
                    </ProductCard>
                  </div>
                )}
              </section>

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
            </div>
          </div>
        </div>

        <AddedProductsPanel
          ariaLabel={t('lead.add.panel.title')}
          title={t('lead.add.panel.title')}
          count={
            panelTerm
              ? t('lead.add.panel.countFiltered', {
                  shown: groupLines(matchedLines).length,
                  total: productCount,
                })
              : String(productCount)
          }
          search={
            <Input
              value={lineQuery}
              placeholder={t('lead.add.panel.search')}
              aria-label={t('lead.add.panel.search')}
              autoComplete="off"
              onChange={(event) => setLineQuery(event.target.value)}
            />
          }
          toolbar={
            <>
              {selectedGroups.length > 0 && (
                <div className="ob-lead-selbar">
                  <span
                    className="ob-small ob-body-strong"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {t('lead.add.panel.selected', { count: selectedGroups.length })}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }} />
                  <Button variant="secondary" size="sm" onClick={() => setSelected({})}>
                    {t('lead.add.panel.clear')}
                  </Button>
                  <Button variant="danger" size="sm" onClick={removeSelected}>
                    {t(
                      selectedGroups.length === 1
                        ? 'lead.add.panel.removeSelectedOne'
                        : 'lead.add.panel.removeSelected',
                      { count: selectedGroups.length },
                    )}
                  </Button>
                </div>
              )}
              {lines.length > 0 && (
                <label
                  className="ob-small"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--s-8)',
                    color: 'var(--fg-tertiary)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    className="ob-lead-check"
                    checked={allShownTicked}
                    onChange={toggleSelectAllShown}
                  />
                  {t('lead.add.panel.selectAll')}
                </label>
              )}
            </>
          }
          empty={
            panelLines.length === 0
              ? t(lines.length === 0 ? 'lead.add.panel.emptyNone' : 'lead.add.panel.emptyFiltered')
              : undefined
          }
          footerNote={
            <div style={{ display: 'flex', flexDirection: 'column', gap: rem(2) }}>
              {lines.length > 0 && (
                <span className="ob-small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {t('lead.add.summary.weight', { kg: formatKg(totalWeight) })}
                </span>
              )}
              <span
                className="ob-micro"
                style={{ color: ready ? 'var(--fg-tertiary)' : 'var(--state-offline)' }}
              >
                {unweighed > 0
                  ? t(
                      unweighed === 1
                        ? 'lead.add.summary.noWeightOne'
                        : 'lead.add.summary.noWeight',
                      {
                        count: unweighed,
                      },
                    )
                  : statusLine}
              </span>
            </div>
          }
          checks={[
            selectedParty
              ? {
                  key: 'party',
                  state: 'ok',
                  label: t('lead.add.check.party.ok', { name: selectedParty.name }),
                }
              : { key: 'party', state: 'todo', label: t('lead.add.check.party.todo') },
            lines.length > 0
              ? {
                  key: 'products',
                  state: 'ok',
                  label: t('lead.add.check.products.ok', { count: productCount }),
                }
              : { key: 'products', state: 'idle', label: t('lead.add.check.products.todo') },
            followUpDate
              ? {
                  key: 'followUp',
                  state: 'ok',
                  label: t('lead.add.check.followUp', { date: followUpDate }),
                }
              : { key: 'followUp', state: 'idle', label: t('lead.add.check.followUp.none') },
          ]}
          totalLabel={
            lines.length === 0
              ? t('lead.add.summary.empty')
              : t(
                  productCount === 1 && lines.length === 1
                    ? 'lead.add.panel.totalOneLine'
                    : productCount === 1
                      ? 'lead.add.panel.totalLineOne'
                      : 'lead.add.panel.totalLine',
                  {
                    products: productCount,
                    lines: lines.length,
                  },
                )
          }
          totalPcs={totalQty.toLocaleString('en-IN')}
          pcsUnit={t('unit.pieces')}
          cancelLabel={t('action.cancel')}
          onCancel={onCancel}
          saveLabel={busy ? t('lead.add.saving') : t('lead.add.save')}
          saveKbd={t('lead.add.saveKbd')}
          saveTitle="Ctrl+S · Ctrl+Enter"
          saveDisabled={!ready}
          saving={busy}
          onSave={() => void save()}
        >
          {groups.map((group) => {
            const image = group.lines.find((line) => line.image)?.image;
            return (
              <AddedGroup
                key={group.key}
                leading={
                  <input
                    type="checkbox"
                    className="ob-lead-check"
                    style={{ marginLeft: 'var(--s-8)' }}
                    checked={Boolean(selected[group.key])}
                    aria-label={t('lead.add.panel.select', { product: group.name })}
                    onChange={() => toggleSelect(group.key)}
                  />
                }
                thumb={
                  <ProductThumb
                    images={image ? [image] : undefined}
                    name={group.name}
                    size={32}
                    fallback="none"
                    alt=""
                  />
                }
                code={group.code}
                name={group.name}
                pieces={group.pieces}
                pcsUnit={t('unit.pieces')}
                editLabel={t('lead.add.line.modifyProduct', { product: group.name })}
                removeLabel={t('lead.add.line.removeProduct', { product: group.name })}
                onEdit={() => modifyGroup(group)}
                onRemove={() => removeGroup(group)}
              >
                {group.lines.map((line) => {
                  const colour =
                    line.colour || (line.rule === 'fixed' ? (line.variantLabel ?? '') : '');
                  return (
                    <AddedLine
                      key={line.key}
                      sub={line.productName}
                      colour={colour ? labelOf(colour) : ''}
                      colourHex={colour ? colourHex(colour) : undefined}
                      packaging={line.packaging}
                      grade={line.grade}
                      qty={line.quantity}
                    />
                  );
                })}
              </AddedGroup>
            );
          })}
          {matchedLines.length > panelLines.length && (
            <p className="ob-micro" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
              {t('lead.add.panel.truncated', { shown: panelLines.length })}
            </p>
          )}
        </AddedProductsPanel>
      </div>

      <ReviewModal
        open={reviewOpen}
        partyName={selectedParty?.name ?? ''}
        source={
          sourceOptions.find((option) => option.value === sourcePlatform)?.label ?? sourcePlatform
        }
        followUpDate={followUpDate}
        notes={notes}
        lines={lines}
        labelOf={labelOf}
        summary={summary}
        busy={busy}
        error={error}
        onClose={() => setReviewOpen(false)}
        onConfirm={() => void save()}
      />

      <PartyFormModal
        transport={transport}
        initialName={partyQuery.trim()}
        open={partyDrawerOpen}
        onClose={() => setPartyDrawerOpen(false)}
        onCreated={(party: CreatedParty) => {
          seenParties.current.set(party.id, party as unknown as Party);
          setPartyId(party.id);
          setPartyDrawerOpen(false);
          // On to the source, as `chooseParty` does — not past it to the products.
          window.setTimeout(() => sourceRef.current?.focus(), 0);
        }}
        onError={setError}
      />
    </div>
  );
}

// --- Pieces ---------------------------------------------------------------

/** The small upper-case label that names a row without becoming a heading. */
function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="ob-eyebrow" style={{ flex: 'none', color: 'var(--fg-tertiary)' }}>
      {children}
    </span>
  );
}

/** The weight cell: a figure, or the pill that says there is none to show. */
function WeightCell({ kg }: { kg: number | null }) {
  if (kg === null)
    return <StatusPill tone="offline">{t('product.weight.missingShort')}</StatusPill>;
  return (
    <span className="ob-small" style={{ fontVariantNumeric: 'tabular-nums' }}>
      {formatKg(kg)}
    </span>
  );
}

/**
 * The review Ctrl+Enter opens (§6.8): the enquiry and every line, the lines of
 * one sub product grouped back into one row — `White ×10, Ivory ×5` — the way
 * the lead PDF prints them. Ctrl+Enter again saves (the screen's own handler,
 * so the key is guarded in one place); Esc goes back to the form. A save that
 * fails says so here, where the person pressing it is looking.
 */
function ReviewModal({
  open,
  partyName,
  source,
  followUpDate,
  notes,
  lines,
  labelOf,
  summary,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  partyName: string;
  source: string;
  followUpDate: string;
  notes: string;
  lines: DraftLine[];
  labelOf: (colour: string) => string;
  summary: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  // One row per variant, grade and packaging, in the order they were added.
  const groups = new Map<string, DraftLine[]>();
  for (const line of lines) {
    const key = [line.variantId, line.grade, line.packaging].join('|');
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('lead.add.review.title')}
      subtitle={t('lead.add.review.hint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" busy={busy} title="Ctrl+Enter" onClick={onConfirm}>
            {busy ? t('lead.add.saving') : t('lead.add.save')}
          </Button>
        </>
      }
    >
      {error && <ConflictBanner>{error}</ConflictBanner>}
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
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-6)',
          marginTop: 'var(--s-12)',
        }}
      >
        {[...groups.entries()].map(([key, group]) => {
          const first = group[0]!;
          const quantity = group.reduce((sum, line) => sum + line.quantity, 0);
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-8)' }}>
              <span
                className="ob-mono ob-small"
                style={{ flex: 'none', color: 'var(--fg-tertiary)' }}
              >
                {first.code}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                <span className="ob-body-strong">{first.productName}</span>
                <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                  {[
                    first.categoryName,
                    first.size,
                    lineColourText(group, first.productName, labelOf),
                    first.grade,
                    first.packaging,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span
                className="ob-small"
                style={{ flex: 'none', fontVariantNumeric: 'tabular-nums' }}
              >
                {t('lead.add.line.qtyShort', { count: quantity })}
              </span>
            </div>
          );
        })}
      </div>
      <p
        className="ob-small"
        style={{ margin: 'var(--s-12) 0 0', fontVariantNumeric: 'tabular-nums' }}
      >
        {summary}
      </p>
    </Modal>
  );
}
