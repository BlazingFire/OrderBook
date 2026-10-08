/**
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
 * a *category* and a sub product a *model*). One search box is a chain of two
 * dropdowns: the **product bar** (a product by name or code, rows
 * `CODE · Name · Brand`), then, with the product as a chip in front of the same
 * box, the **sub-product bar** (its sub products, by name, alias, code or
 * colour). Picking a sub product opens its **card**, a row for each variant on
 * sale (the shared grid model, `ui/src/order/gridModel.ts`), which asks what
 * the colour rule (`colourRuleOf`) leaves to ask:
 *  · `fixed` — the colour is the variant's label, shown and not chosen; a
 *    quantity;
 *  · `dedicated` — nothing about colour at all; a quantity;
 *  · `selectable` (multicolour) — a colour from the company's colour list, and
 *    "+ Same sub product, another colour" for a second colour, each with its
 *    own quantity.
 * Each row's packaging sits right beside its quantity, a pick from the
 * company's `line.packaging` list (Box, Grass and Paper to start; Settings →
 * Fields keeps it), required only while the company requires it. Grade sits
 * beside the packaging, the same box over the company's `line.grade` list, and
 * is always optional. A pick box whose list is empty is not a step.
 *
 * Keys, the way the counter works (owner, 2026-10-08):
 *  · **Enter** walks colour (multicolour only), quantity, packaging and grade,
 *    each pick list open as the caret arrives (`arriveAt`): Enter takes the
 *    highlighted value and moves on, as a mouse pick does; a row with no
 *    quantity is passed over (`nextWalkStop`). After the last field comes
 *    **Add sub product**, and Enter there adds the card and puts the caret back
 *    in the sub-product bar of the same product, its list open. **Escape**
 *    closes a list the walk opened, then walks back one field; on the empty
 *    sub-product bar, Escape or Backspace goes back to the product bar;
 *  · **Shift+Q** adds a ready card and goes to the product bar (the next
 *    product). Anywhere it would do nothing it is a capital Q;
 *  · **Ctrl+Enter** opens a review of the finished lead, and Ctrl+Enter there
 *    saves it — once, however the key repeats. Ctrl+S still saves directly.
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

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type {
  ColourRule,
  Lead,
  LineItemInput,
  OptionListItem,
  Party,
  PartyProductVariant,
  PresenceLastWrite,
  Product,
  ProductCategory,
} from '@orderbook/shared';
import {
  PICK_MAX_LIMIT,
  colourLabeller,
  colourRuleOf,
  lineColourText,
  resolveCompanyFeatures,
  shownColour,
} from '@orderbook/shared';

import { api, type LocalView, type QueuedResult } from '../api';
import { partyFormTransport } from '../partyFormTransport';
import {
  AddedGroup,
  AddedLine,
  AddedProductsPanel,
  Button,
  ColourSelect,
  ColourChip,
  ConflictBanner,
  DateField,
  FollowUpField,
  Icon,
  Input,
  Modal,
  OrderDetailsBar,
  OrderField,
  PartyChip,
  PartyFormModal,
  ProductCard,
  ProductThumb,
  Select,
  StaleEditNotice,
  SubGrid,
  SubRow,
  StatusPill,
  SubListCompactToggle,
  SubProductList,
  Textarea,
  arriveAt,
  changedLeadFields,
  type CreatedParty,
  type GridLine,
  type GridRow,
  type WalkRow,
  type WalkStop,
  addColourRow,
  groupLines,
  buildRows,
  cardPieces,
  cardReady,
  isCounted,
  linesToRows,
  nextWalkStop,
  prevWalkStop,
  rowProblem,
  rowsToLines,
  useSubListCompact,
  type LeadFormValues,
  type OrderCheck,
  formatKg,
  rem,
  t,
  useColourHex,
  useDebounced,
  useEnterToAdvance,
  useEscapeToPrevious,
  useResetGuard,
  useUnsavedWork,
  useCommand,
  useConfirm,
  useLeadEditBase,
  useSubNav,
} from '@orderbook/ui';

interface Props {
  view: LocalView;
  /** Bumped by the shell each time the form is asked for; see the focus effect. */
  focusNonce?: number;
  /**
   * Carries the queued lead's temporary id, so the shell can name it, and on a
   * new lead what the save said about its number (`queued.status`).
   */
  onSaved: (id: string, queued?: QueuedResult) => void;
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
  /**
   * The link to the Master is up. Down, nothing asks it which products are live: the save is
   * queued as it stands, with no call and no wait.
   */
  online?: boolean;
}

/** A line on the lead: the shared grid model's own, so the card and the panel cannot drift. */
type DraftLine = GridLine;

/** The open card: one row for every variant (and colour) of the chosen sub product. */
interface CardState {
  rows: GridRow[];
  /** Where the lines go back to when the card is an edit of a saved group; null: the end. */
  at: number | null;
}

/** How many products on the order are checked against the catalogue after a change. */
const LIVE_CHECK_BATCH = 200;

/** How long Save waits for the Master's live-ids answer before saving as if it could not tell. */
const LIVE_SAVE_WAIT_MS = 3000;

const QUICK_FOLLOW_UPS = [
  { days: 1, token: 'lead.add.followUp.tomorrow', short: 'lead.add.followUp.tomorrowShort' },
  { days: 3, token: 'lead.add.followUp.inThreeDays', short: 'lead.add.followUp.inThreeDaysShort' },
  { days: 7, token: 'lead.add.followUp.nextWeek', short: 'lead.add.followUp.nextWeekShort' },
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
 * Catalogue order (`sortOrder`), stable, a sub product without one after those
 * with. Sorted here as well as by the Master so the bar reads in catalogue order
 * whichever of the two — the Master or this panel's snapshot — answered.
 */
function inCatalogueOrder(rows: readonly Product[]): Product[] {
  const last = Number.MAX_SAFE_INTEGER;
  return rows.slice().sort((a, b) => (a.sortOrder ?? last) - (b.sortOrder ?? last));
}

/**
 * The sub products matching what is typed in the bar: an exact name or code
 * first, then a prefix, then anywhere in the name, alias, code or colour —
 * catalogue order inside each, the sort being stable.
 *
 * Local, over every sub product fetched once per product, so a fast Enter never
 * lands on the rows of a search that has not come back yet.
 */
function subProductMatches(rows: readonly Product[], term: string): Product[] {
  if (!term) return rows.slice();
  const ranked: Array<{ row: Product; rank: number }> = [];
  for (const row of rows) {
    const words = [
      row.name,
      row.alias ?? '',
      ...row.variants.flatMap((variant) => [variant.code, variant.label ?? '']),
    ].map((word) => word.toLowerCase());
    const rank = words.includes(term)
      ? 0
      : words.some((word) => word.startsWith(term))
        ? 1
        : words.some((word) => word.includes(term))
          ? 2
          : -1;
    if (rank >= 0) ranked.push({ row, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.row);
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
function linesOf(lead: Lead, view: LocalView): DraftLine[] {
  return lead.items.map((item, index) => {
    const product = view.products.find((candidate) => candidate.id === item.productId);
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
export function AddLeadScreen(props: Props) {
  const [opening, setOpening] = useState(0);
  return <AddLeadForm key={opening} {...props} onReload={() => setOpening((n) => n + 1)} />;
}

function AddLeadForm({
  view,
  focusNonce = 0,
  onSaved,
  onCancel,
  lead,
  remoteChange,
  online = true,
  onReload,
}: Props & { onReload: () => void }) {
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
  const editBase = useLeadEditBase(lead);

  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sel, setSel] = useState(0);
  /** The product bar's answer. Cleared by its chip's ✕, Backspace or Escape when empty, Shift+Q. */
  const [category, setCategory] = useState<ProductCategory | null>(null);
  /** Every product the bar can offer, in catalogue order; narrowed locally as somebody types. */
  const [allCategories, setAllCategories] = useState<ProductCategory[]>([]);
  /** Every live sub product of the chosen product, in catalogue order. */
  const [subRows, setSubRows] = useState<Product[]>([]);
  const [lines, setLines] = useState<DraftLine[]>(() => (lead ? linesOf(lead, view) : []));
  const [card, setCard] = useState<CardState | null>(null);
  /** Which panel rows are expanded, ticked, and what is filtering them. */
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
  /** The products section: the scope of Shift+Q. */
  const productsRef = useRef<HTMLDivElement>(null);
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
  const seenParties = useRef(new Map<string, Party>());
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

  const selectedParty =
    view.parties.find((party) => party.id === partyId) ?? seenParties.current.get(partyId) ?? null;

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
        const page = await api.pick<Party>('party', { term: partyTerm });
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
   * The highlighted row, counting "+ Create a new party" as the row after the last party: with
   * no match it is the only row, so Enter on it opens the dialog instead of walking on to Source.
   */
  const partyPick = Math.min(partySel, partyRows.length);
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

  // --- The product bar, then the product's card -------------------------

  /*
   * Every product, fetched each time the bar is back on products (41 in the
   * catalogue), and matched as somebody types by `productMatches`.
   */
  useEffect(() => {
    if (category || card) return;
    let cancelled = false;

    void (async () => {
      try {
        const page = await api.pick<ProductCategory>('category', {
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
  }, [category, card, view.products, view.categories]);

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
  }, [categoryId]);

  useEffect(() => {
    if (!categoryId) return;
    let cancelled = false;

    void (async () => {
      try {
        const page = await api.pick<Product>('product', {
          term: '',
          categoryId,
          limit: PICK_MAX_LIMIT,
        });
        if (!cancelled) setSubRows(inCatalogueOrder(page.items));
      } catch {
        if (!cancelled) setSubRows([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [categoryId, view.products, view.categories]);

  const subMatches = useMemo(
    () => subProductMatches(subRows, query.trim().toLowerCase()),
    [subRows, query],
  );

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
    // The open card's sub product is checked too.
    if (card) for (const row of card.rows) byId.set(row.productId, row.productName);
    return [...byId];
  }, [lines, card]);
  const checkedKey = checkedProducts.map(([id]) => id).join(',');

  useEffect(() => {
    if (checkedProducts.length === 0 || !online) {
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
            api.liveProducts(ids.slice(index * LIVE_CHECK_BATCH, (index + 1) * LIVE_CHECK_BATCH)),
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
  }, [checkedKey, view.products, view.categories, online]);

  const rows: Array<ProductCategory | Product> = category ? subMatches : categoryRows;
  const pick = rows.length ? Math.min(sel, rows.length - 1) : 0;
  const listOpen = !card && searchOpen;
  const listRef = useRef<HTMLDivElement>(null);
  const [compactList, toggleCompactList] = useSubListCompact();

  // Keep the highlighted row on screen as the arrows walk past the list's
  // visible rows. `?.()`: jsdom has no `scrollIntoView`.
  useEffect(() => {
    if (!listOpen) return;
    const rowEls = listRef.current?.querySelectorAll<HTMLElement>('button.ob-suggest-row');
    rowEls?.[pick]?.scrollIntoView?.({ block: 'nearest' });
  }, [listOpen, pick, category]);

  /** Choosing a product turns the same box into its sub-product bar, the list already down. */
  function chooseCategory(next: ProductCategory): void {
    setCategory(next);
    backToBar();
  }

  /** Back to the product bar, its list down: the chip's ✕, Backspace or Escape, Shift+Q. */
  function clearCategory(): void {
    setCategory(null);
    backToBar();
  }

  /** The caret in the bar — the sub-product bar while a product is chosen — with its list open. */
  function backToBar(): void {
    setQuery('');
    setSel(0);
    setSearchOpen(true);
    setBarFocus((n) => n + 1);
  }

  /*
   * The caret into the bar in the commit that mounts it again, as the card does for its first
   * field: the bar is not mounted while a card is open, and a timer could fire before the render
   * that mounts it — the walk's last Enter saves from a passive effect, whose render is not flushed
   * at once.
   */
  const [barFocus, setBarFocus] = useState(0);
  useLayoutEffect(() => {
    if (barFocus > 0) searchRef.current?.focus();
  }, [barFocus]);

  // --- The sub product's card ----------------------------------------------

  const readyOptions = { packagingRequired, colourListNonEmpty: colourOptions.length > 0 };
  const newRowKey = (): string => `row-${nextKey.current++}`;
  const newLineKey = (): string => `line-${nextKey.current++}`;

  /**
   * A sub product picked off its bar opens its card: a row for each variant on sale. A code typed
   * in full names one variant, so the card opens on that one alone.
   */
  function openCard(product: Product, typed = ''): void {
    const all = buildRows([product], {
      nextKey: newRowKey,
      partyRecordFor: (id) => partyRecordFor.get(id) ?? null,
    });
    const code = typed.trim().toLowerCase();
    const exact = all.filter((row) => row.code.toLowerCase() === code);
    setCard({ rows: exact.length > 0 ? exact : all, at: null });
    setQuery('');
    setSel(0);
    setSearchOpen(false);
  }

  function patchRow(key: string, patch: Partial<GridRow>): void {
    setCard((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
          }
        : current,
    );
  }

  /** "+ Same sub product, another colour": a blank copy of the row, right under it. */
  function anotherColour(key: string): void {
    const added = newRowKey();
    setCard((current) =>
      current ? { ...current, rows: addColourRow(current.rows, key, () => added) } : current,
    );
    // The caret goes into the new row's colour box, as on the Master: Enter on the button must not
    // leave it on the page.
    window.setTimeout(() => {
      arriveAt(
        productsRef.current?.querySelector<HTMLElement>(
          `[data-walk="colour"][data-row="${added}"]`,
        ),
      );
    }, 0);
  }

  function cardIsReady(candidate: CardState): boolean {
    // `leads.packagingRequiredOnConvert` off: a shop that packs to order cannot state the
    // packaging at the counter, so a line may go in without. On, every counted row needs its own.
    return cardReady(candidate.rows, readyOptions);
  }

  /**
   * One line per row with a quantity — per variant, and per colour: White ×10 and Ivory ×5 are two
   * lines on the same variant — then back to the sub-product bar of the same product, for the next
   * sub product (owner, 2026-10-08). A card lifted from the list has no product chosen: the
   * product bar.
   */
  function saveCard(): void {
    if (!card || !cardIsReady(card)) return;

    const added = rowsToLines(card.rows, newLineKey);
    const at = card.at;
    setLines((current) => {
      const next = current.slice();
      if (at === null) next.push(...added);
      else next.splice(Math.min(at, next.length), 0, ...added);
      return next;
    });
    setCard(null);
    backToBar();
  }

  /** Close the card without adding anything, back to the bar it came from. */
  function discardCard(): void {
    setCard(null);
    backToBar();
  }

  /**
   * Lift one product's saved lines back into the card, to edit them together: each row remembers
   * its line, which keeps its key (so a tick or an open row stays put) and its place in the order.
   */
  function modifyGroup(group: Array<DraftLine>): void {
    const first = lines.findIndex((line) => line.key === group[0]?.key);
    const doomed = new Set(group.map((line) => line.key));
    setLines((current) => current.filter((line) => !doomed.has(line.key)));
    for (const line of group) forget(line.key);
    setCategory(null);
    setCard({ rows: linesToRows(group, newRowKey), at: first < 0 ? null : first });
  }

  function removeGroup(group: Array<DraftLine>): void {
    const doomed = new Set(group.map((line) => line.key));
    setLines((current) => current.filter((line) => !doomed.has(line.key)));
    for (const line of group) forget(line.key);
    // A refusal that named a product on the lead is over once that product is gone.
    setError(null);
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

  /*
   * The panel is grouped by product, in the order lines were added; the limit counts products.
   * A group is shown whole, so what is ticked, edited and removed is a product's lines together.
   */
  const panelGroups = groupLines(matchedLines).slice(0, PANEL_LIMIT);
  const panelLines = panelGroups.flatMap((group) => group.lines);
  const shownProducts = groupLines(matchedLines).length;

  /*
   * Ticks are keyed by line, and a line can be removed while ticked (by its own
   * Remove, or by a Modify that lifts it back into the draft). Reading the set
   * back through the live lines keeps a stale key from inflating the count.
   */
  const selectedLines = lines.filter((line) => selected[line.key]);
  const selectedGroupCount = groupLines(selectedLines).length;
  const shownKeys = panelLines.map((line) => line.key);
  const allShownTicked = shownKeys.length > 0 && shownKeys.every((key) => selected[key]);

  /** A product's tick covers all of its lines, so opening it, editing it or removing it never splits it. */
  function toggleGroup(group: Array<DraftLine>): void {
    setSelected((current) => {
      const next = { ...current };
      const all = group.every((line) => next[line.key]);
      for (const line of group) {
        if (all) delete next[line.key];
        else next[line.key] = true;
      }
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
    setError(null);
  }

  // --- Complete sub product (Shift+Q) --------------------------------------

  /**
   * Adds a ready card and goes to the product bar — the next product; with no card open and an
   * empty sub-product bar, just goes there (§6.7). False when it did nothing — a half-filled card,
   * text in the box, no product chosen — so the key it came from is left to type its Q.
   */
  function completeSubProduct(): boolean {
    if (card) {
      if (!cardIsReady(card)) return false;
      saveCard();
    } else if (!category || query.trim() !== '') {
      return false;
    }
    clearCategory();
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
    if (card) return t('lead.add.errors.draftOpen');
    // The Master refuses a whole new order that names a deleted product: stop here, keep the form.
    const goneLines = lines.filter((line) => gone.some((product) => product.id === line.productId));
    if (goneLines.length > 0) {
      return t('lead.add.errors.goneLines', {
        names: [...new Set(goneLines.map((line) => line.productName))].join(', '),
      });
    }
    return null;
  }

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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer =
        ids.length > 0 && online
          ? await Promise.race([
              api.liveProducts(ids).catch(() => null),
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
          setError(
            t('lead.add.errors.goneLines', {
              names: [...new Set(missing.map((line) => line.productName))].join(', '),
            }),
          );
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
        // Only what changed, with the clocks it was opened at: the Master's
        // merge then records a conflict rather than overwrite a newer save.
        const changes = changedLeadFields(editBase.opened, input, editBase.base);
        if (changes) await api.updateLead(lead.id, changes);
        onSaved(lead.id);
      } else {
        // Waits (briefly, and only while the Master is reachable) for the number.
        const queued = await api.createLead(input);
        onSaved(queued.id, queued);
      }
    } catch (caught) {
      saving.current = false;
      setError(caught instanceof Error ? caught.message : t('lead.add.errors.generic'));
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

  const ready = Boolean(partyId) && lines.length > 0 && !card;

  const statusLine = !partyId
    ? t('lead.add.status.party')
    : lines.length === 0
      ? t('lead.add.status.products')
      : card
        ? t('lead.add.status.draft')
        : t('lead.add.savingHint');

  useCommand('record.save', busy ? null : () => void save());

  /*
   * Enter forward, Escape back — one field at a time, down the whole column:
   * party, source, follow-up, the product search, the card's colour, then each
   * row's quantity, packaging and grade (the card claims those Enters, and the
   * last one adds the card), then the notes and any custom fields.
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
  const blank = !partyId && !partyQuery && lines.length === 0 && !card && !notes.trim();
  /*
   * The shell's Escape goes Home from a New order only while it holds nothing at all, and only an
   * Escape nobody on the form claimed (`data-esc-home`, read by the shell). Never from an edit.
   */
  const escHome = !lead && blank && !category && query === '';
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
    partyId || lines.length > 0 || card || notes.trim()
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
    (lead ? editChanged : partyId || lines.length > 0 || card || notes.trim())
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

  const searchPlaceholder = category
    ? t('lead.add.products.productPlaceholder', { category: category.name })
    : t('lead.add.products.categoryPlaceholder');

  const productCount = new Set(lines.map((line) => line.productId)).size;
  const followUpShown = followUpDate.split('-').reverse().join('-');
  const checks: OrderCheck[] = [
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
          label: t('lead.add.check.followUp', { date: followUpShown }),
        }
      : { key: 'followUp', state: 'idle', label: t('lead.add.check.followUp.none') },
  ];
  const totalLabel =
    lines.length === 0
      ? t('lead.add.summary.empty')
      : productCount === 1 && lines.length === 1
        ? t('lead.add.panel.totalOneLine')
        : productCount === 1
          ? t('lead.add.panel.totalLineOne', { lines: lines.length })
          : t('lead.add.panel.totalLine', { products: productCount, lines: lines.length });

  return (
    <div ref={rootRef} className="ob-order-page" data-esc-home={escHome ? 'true' : 'false'}>
      {/* New: the shell's topbar names the page. Edit has no topbar title, so the heading
          stays, for the screen reader (and the tests that look for it). */}
      {lead && (
        <h1
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            margin: -1,
            padding: 0,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
            whiteSpace: 'nowrap',
            border: 0,
          }}
        >
          {t('lead.edit.title')}
        </h1>
      )}

      {error && <ConflictBanner>{error}</ConflictBanner>}
      {editBase.conflicted && !busy && (
        <StaleEditNotice
          lastWrite={remoteChange}
          busy={busy}
          onReload={onReload}
          onKeepMine={editBase.keepMine}
        />
      )}

      {/*
       * The Enter / Escape walk covers the details bar and the products column and not the Added
       * products panel, which has its own controls: `display: contents` gives the walk one
       * container without adding a box to the layout.
       */}
      <div ref={formRef} style={{ display: 'contents' }}>
        {/* --- The enquiry: party, source, follow-up ------------------------ */}

        <OrderDetailsBar hasOwner={false}>
          <OrderField label={t('lead.add.party.title')} wide>
            {selectedParty ? (
              <PartyChip
                name={selectedParty.name}
                code={selectedParty.partyCode}
                city={selectedParty.city}
                extra={
                  /* The key keeps its name from when party records carried rates; the text says
                     what it is now — the party's own product names are in use. No money. */
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
                      // Claimed only when it closed a list, so the shell's Escape sees the rest.
                      if (partyListOpen) event.preventDefault();
                      setPartyOpen(false);
                      return;
                    }
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setPartyOpen(true);
                      setPartySel(Math.min(partyPick + 1, partyRows.length));
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
                      } else if (event.key === 'Enter') {
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
                        <span className="ob-mono ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
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
                  </div>
                )}
              </div>
            )}
          </OrderField>

          <OrderField label={t('lead.add.source.label')}>
            {/*
             * A select rather than a row of chips: the list is
             * company-defined and a shop with eight sources wrapped the
             * chips onto three lines above a field nobody had filled in
             * yet.
             *
             * The listed sources and nothing else (§6.2). The free-text
             * box behind "Other" sent whatever was typed as the source,
             * which the Master refuses as unlisted — a queued lead
             * bounced on it. A source the shop needs is added to the
             * list, in Settings → Fields.
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
              quick={QUICK_FOLLOW_UPS.map(({ days, token, short }) => {
                const iso = isoDate(days);
                return {
                  key: token,
                  label: t(short),
                  title: t(token),
                  active: followUpDate === iso,
                  onClick: () => setFollowUpDate((current) => (current === iso ? '' : iso)),
                };
              })}
            />
          </OrderField>
        </OrderDetailsBar>

        <div className="ob-order-cols">
          <div className="ob-order-main">
            {/* --- Products ------------------------------------------------- */}

            <section className="ob-order-card" aria-label={t('lead.add.products.title')}>
              {/* Shift+Q is the product flow's key: the notes below sit outside this box. */}
              <div
                ref={productsRef}
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)', flex: 1 }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 'var(--s-8)',
                    flexWrap: 'wrap',
                  }}
                >
                  <h2 className="ob-order-eyebrow">{t('lead.add.products.title')}</h2>
                  <span className="ob-order-hint">
                    {lines.length
                      ? t('lead.add.products.searchAdds')
                      : t('lead.add.products.searchFirst')}
                  </span>
                </div>

                {/* The search field, or the model it turned into. */}
                <div style={{ position: 'relative' }}>
                  {card ? null : (
                    <div className="ob-lead-search ob-order-search">
                      <Icon name="search" size={16} />
                      {category && (
                        <span className="ob-chip" aria-pressed="true" style={{ cursor: 'default' }}>
                          <span className="ob-ellipsis">{category.name}</span>
                          <button
                            type="button"
                            className="ob-chip__clear"
                            aria-label={t('lead.add.products.changeCategory')}
                            title={t('lead.add.products.changeCategory')}
                            onClick={clearCategory}
                          >
                            ✕
                          </button>
                        </span>
                      )}
                      <Input
                        ref={searchRef}
                        value={query}
                        placeholder={searchPlaceholder}
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
                          // Backspace on an empty box steps back a stage, the way
                          // a token in a search field is deleted; so does Escape
                          // once the list is closed.
                          if (
                            (event.key === 'Backspace' || event.key === 'Escape') &&
                            query === '' &&
                            category
                          ) {
                            event.preventDefault();
                            clearCategory();
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
                           * A bare Enter takes the highlighted row; Tab only once
                           * something was typed, so a Tab out of the bar does not
                           * take a product nobody chose. A chord is never a pick:
                           * Ctrl+Enter here is the review.
                           */
                          const takes =
                            !chorded(event) &&
                            (event.key === 'Enter' || (event.key === 'Tab' && query.trim() !== ''));
                          if (takes && listOpen && rows[pick]) {
                            // Claimed, so the Enter walk does not step past a
                            // choice that has only just been made.
                            event.preventDefault();
                            if (category) openCard(rows[pick] as Product, query);
                            else chooseCategory(rows[pick] as ProductCategory);
                          } else if (takes && listOpen && event.key === 'Enter') {
                            // Nothing to take — a typo, or `opt⏎41⏎` typed before
                            // the product's sub products arrived. The walk would
                            // put the caret in the notes and the next code typed
                            // there; it stays in the bar. Escape closes the list
                            // for somebody who does mean to walk on.
                            event.preventDefault();
                          }
                        }}
                      />
                      {category && (
                        <SubListCompactToggle compact={compactList} onToggle={toggleCompactList} />
                      )}
                    </div>
                  )}

                  {listOpen && !category && (
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

                  {listOpen && category && (
                    <SubProductList
                      rows={subMatches}
                      total={subRows.length}
                      pick={pick}
                      compact={compactList}
                      colourHex={colourHex}
                      listRef={listRef}
                      onHover={setSel}
                      onPick={(row) => openCard(row, query)}
                    />
                  )}

                  {!card && (
                    <p className="ob-order-hint" style={{ margin: `${rem(7)} 0 0` }}>
                      {category
                        ? t('lead.add.products.productHint')
                        : t('lead.add.products.categoryHint')}
                    </p>
                  )}
                </div>

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

                {/* The sub product's card: a row for each of its variants. */}
                {card && (
                  <GridCard
                    rows={card.rows}
                    editing={card.at !== null}
                    ready={cardIsReady(card)}
                    readyOptions={readyOptions}
                    packagingRequired={packagingRequired}
                    packagingOptions={packagingOptions}
                    gradeOptions={gradeOptions}
                    colourOptions={colourOptions}
                    labelOf={labelOf}
                    colourHex={colourHex}
                    suggestedPackaging={(productId) =>
                      partyRecordFor.get(productId)?.packaging ?? null
                    }
                    onRow={patchRow}
                    onAnotherColour={anotherColour}
                    onSave={saveCard}
                    onClear={discardCard}
                  />
                )}

                {!card && !category && (
                  <div className="ob-order-empty">
                    <span className="ob-order-empty__title">
                      {t('lead.add.products.noneTitle')}
                    </span>
                    <span className="ob-order-empty__body">{t('lead.add.products.noneBody')}</span>
                  </div>
                )}
              </div>

              {/* --- Notes -------------------------------------------------- */}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-8)' }}>
                  <span className="ob-order-eyebrow">{t('lead.add.details.notes')}</span>
                  <span className="ob-order-hint">{t('lead.add.step.notesHint')}</span>
                </div>
                <Textarea
                  rows={2}
                  value={notes}
                  placeholder={t('lead.add.notes.placeholder')}
                  aria-label={t('lead.add.details.notes')}
                  onChange={(event) => setNotes(event.target.value)}
                />
              </div>
            </section>
          </div>

          {/* --- Added products --------------------------------------------- */}

          {/* Outside the Enter walk: the panel's own search, ticks and buttons. */}
          <div data-keys-grid style={{ display: 'contents' }}>
            <AddedProductsPanel
              ariaLabel={t('lead.add.panel.title')}
              title={t('lead.add.panel.title')}
              count={
                lines.length === 0
                  ? '0'
                  : panelTerm
                    ? t('lead.add.panel.countFiltered', {
                        shown: shownProducts,
                        total: groupLines(lines).length,
                      })
                    : String(groupLines(lines).length)
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
                  {selectedLines.length > 0 && (
                    <div className="ob-lead-selbar">
                      <span
                        className="ob-small ob-body-strong"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {t('lead.add.panel.selected', { count: selectedGroupCount })}
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }} />
                      <Button variant="secondary" size="sm" onClick={() => setSelected({})}>
                        {t('lead.add.panel.clear')}
                      </Button>
                      <Button variant="danger" size="sm" onClick={removeSelected}>
                        {t(
                          selectedGroupCount === 1
                            ? 'lead.add.panel.removeSelectedOne'
                            : 'lead.add.panel.removeSelected',
                          { count: selectedGroupCount },
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
                  ? t(
                      lines.length === 0
                        ? 'lead.add.panel.emptyNone'
                        : 'lead.add.panel.emptyFiltered',
                    )
                  : null
              }
              footerNote={
                <>
                  {shownProducts > panelGroups.length && (
                    <span className="ob-order-hint">
                      {t('lead.add.panel.truncated', { shown: panelGroups.length })}
                    </span>
                  )}
                  <span
                    className="ob-order-hint"
                    style={{ color: ready ? undefined : 'var(--state-offline)' }}
                  >
                    {unweighed > 0
                      ? t(
                          unweighed === 1
                            ? 'lead.add.summary.noWeightOne'
                            : 'lead.add.summary.noWeight',
                          { count: unweighed },
                        )
                      : lines.length > 0
                        ? `${t('lead.add.summary.weight', { kg: formatKg(totalWeight) })} · ${statusLine}`
                        : statusLine}
                  </span>
                </>
              }
              checks={checks}
              totalLabel={totalLabel}
              totalPcs={totalQty.toLocaleString('en-IN')}
              pcsUnit={t('unit.pieces')}
              cancelLabel={t('action.cancel')}
              onCancel={onCancel}
              saveLabel={busy ? t('lead.add.saving') : t('lead.add.save')}
              saveKbd="Ctrl S"
              saveTitle="Ctrl+S · Ctrl+Enter"
              saveDisabled={!ready}
              saving={busy}
              onSave={() => void save()}
            >
              {panelGroups.map((group) => {
                const productImages = view.products.find(
                  (product) => product.id === group.lines[0]?.productId,
                )?.images;
                return (
                  <AddedGroup
                    key={group.key}
                    leading={
                      <input
                        type="checkbox"
                        className="ob-lead-check"
                        style={{ marginLeft: 'var(--s-8)' }}
                        checked={group.lines.every((line) => selected[line.key])}
                        aria-label={t('lead.add.panel.select', { product: group.name })}
                        onChange={() => toggleGroup(group.lines)}
                      />
                    }
                    thumb={
                      <ProductThumb
                        images={productImages}
                        size={32}
                        fallback="initial"
                        alt=""
                        name={group.name}
                      />
                    }
                    code={group.code}
                    name={group.name}
                    pieces={group.pieces}
                    pcsUnit={t('unit.pieces')}
                    onEdit={() => modifyGroup(group.lines)}
                    onRemove={() => removeGroup(group.lines)}
                    editLabel={t('lead.add.line.modifyProduct', { product: group.name })}
                    removeLabel={t('lead.add.line.removeProduct', { product: group.name })}
                  >
                    {group.lines.map((line) => {
                      const colour =
                        line.colour.trim() ||
                        shownColour(line.variantLabel, line.productName) ||
                        '';
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
            </AddedProductsPanel>
          </div>
        </div>
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
        transport={partyFormTransport}
        open={partyDrawerOpen}
        initialName={partyQuery.trim()}
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
 * The card a sub product opens: a row for each of its variants (and, on a multicolour sub
 * product, for each colour), with its quantity, packaging and grade beside it.
 *
 * Nothing is on the voucher yet, which is the point: what a row's colour rule leaves to ask,
 * packaging while the company requires it and at least one quantity are all decided in one place,
 * and Add is refused until they are. The hint says what is missing rather than making somebody
 * guess at a disabled button.
 *
 * Enter walks a row's colour (a multicolour row), quantity, packaging and grade, then the next
 * row, each pick list open as the caret arrives (`arriveAt`); a row with no quantity is skipped
 * past its packaging and grade (`nextWalkStop`). After the last field comes Add sub product, and
 * Enter there adds the card and the screen returns to the sub-product bar; a card still short of
 * something puts the caret on what it lacks instead. Escape closes a list the walk opened, then
 * walks the same stops back, and from the first field of an untouched card goes back to the
 * sub-product bar.
 */
function GridCard({
  rows,
  editing,
  ready,
  readyOptions,
  packagingRequired,
  packagingOptions,
  gradeOptions,
  colourOptions,
  labelOf,
  colourHex,
  suggestedPackaging,
  onRow,
  onAnotherColour,
  onSave,
  onClear,
}: {
  rows: GridRow[];
  /** The card is a saved product's lines lifted back, not a new product. */
  editing: boolean;
  ready: boolean;
  readyOptions: { packagingRequired: boolean; colourListNonEmpty: boolean };
  /** `leads.packagingRequiredOnConvert`, already coalesced by the screen. */
  packagingRequired: boolean;
  packagingOptions: OptionListItem[];
  gradeOptions: OptionListItem[];
  colourOptions: OptionListItem[];
  /** The colour list's current label for a stored colour value. */
  labelOf: (colour: string) => string;
  colourHex: (name: string) => string | undefined;
  /** The party's saved packaging for a sub product, offered and never applied. */
  suggestedPackaging: (productId: string) => string | null;
  onRow: (key: string, patch: Partial<GridRow>) => void;
  onAnotherColour: (key: string) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const first = rows[0];

  // The card opens on its first field — the first row's colour box, its list open, else its
  // quantity — so the Enter walk has somewhere to start from. In the layout phase, in the commit
  // that mounts the card: a passive effect ran a tick later, after whatever a fast keystroke had
  // already done, and took the caret back to this field.
  useLayoutEffect(() => {
    arriveAt(
      bodyRef.current?.closest('[data-product-card]')?.querySelector<HTMLElement>('[data-walk]'),
    );
  }, []);
  const counted = rows.filter(isCounted);
  const pieces = cardPieces(rows);
  const previewKg = counted.reduce(
    (sum, row) => sum + (lineWeight({ weightKg: row.weightKg, quantity: Number(row.qty) }) ?? 0),
    0,
  );
  const colourList = colourOptions.length > 0;
  /** The row the caret was last in: "another colour" works on it (as on the Master). */
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const selectableRows = rows.filter((row) => row.rule === 'selectable');
  const someSelectable = colourList && selectableRows.length > 0;
  const moreTarget = someSelectable
    ? (
        selectableRows.find((row) => row.key === activeRow) ??
        [...selectableRows].reverse().find((row) => isCounted(row)) ??
        selectableRows[selectableRows.length - 1]
      )?.key
    : undefined;
  const problems = counted.map((row) => rowProblem(row, readyOptions));

  const hint =
    counted.length === 0
      ? t('lead.add.draft.hintQuantity')
      : problems.includes('colour')
        ? t('lead.add.draft.hintColourRow')
        : problems.includes('packaging')
          ? t('lead.add.draft.hintPackaging')
          : t('lead.add.draft.hintPieces', { count: pieces });

  /** A selectable row asks for a colour while there is a list to take it from. */
  const asksColour = (row: GridRow): boolean => row.rule === 'selectable' && colourList;

  const offered = rows.filter(
    (row) => row.packaging === '' && suggestedPackaging(row.productId) !== null,
  );

  function stepQty(row: GridRow, delta: number): void {
    const current = Number(row.qty) || 0;
    onRow(row.key, { qty: String(Math.max(0, current + delta)) });
  }

  /**
   * The walk's last Enter goes to Add sub product, where the next Enter adds (owner, 2026-10-08:
   * the last field no longer adds by itself) — run after the render that holds what was just
   * picked, so a grade taken by that very Enter counts. A card still short of something goes to
   * what it lacks instead: a counted row's colour or packaging, else the first quantity. Add
   * itself, by Enter or click, does the same when the card is not ready.
   */
  const [finishing, setFinishing] = useState(0);
  useEffect(() => {
    if (finishing === 0) return;
    if (ready) {
      bodyRef.current
        ?.closest('[data-product-card]')
        ?.querySelector<HTMLElement>('[data-walk="add"]')
        ?.focus();
      return;
    }
    const lacking = rows.find((row) => rowProblem(row, readyOptions) !== null);
    const field = lacking ? rowProblem(lacking, readyOptions) : 'qty';
    arriveAt(
      bodyRef.current?.querySelector<HTMLElement>(
        `[data-walk="${field}"][data-row="${(lacking ?? first)?.key}"]`,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishing]);

  /** Add sub product, by click or Enter: a ready card is added, any other goes to what it lacks. */
  function addCard(): void {
    if (ready) onSave();
    else setFinishing((n) => n + 1);
  }

  /** Enter on Add sub product adds, claimed with the browser's own Enter-click; Escape walks back. */
  function addKey(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'Enter' && !chorded(event)) {
      event.preventDefault();
      if (!event.repeat) addCard();
      return;
    }
    stepBack(event);
  }

  /** One stop on: an empty row is passed over (`nextWalkStop`); past the last field, Add. */
  function stepOn(from: Element | null, started?: string): void {
    const found = walkStops(from, started);
    if (!found) return;
    const next = nextWalkStop(found.stops, found.index, found.rowOf);
    if (next === null) return;
    if (found.stops[next]?.field === 'add') setFinishing((n) => n + 1);
    else arriveAt(found.nodes[next]);
  }

  /** The card's stops in DOM order — the whole card, the Add button in the footer being the last. */
  function walkStops(from: Element | null, started?: string) {
    const card = bodyRef.current?.closest('[data-product-card]');
    const nodes = [...(card?.querySelectorAll<HTMLElement>('[data-walk]') ?? [])];
    const index = nodes.indexOf(from as HTMLElement);
    if (index < 0) return null;
    const stops: WalkStop[] = nodes.map((node) => ({
      rowKey: node.dataset.row ?? null,
      field: node.dataset.walk as WalkStop['field'],
    }));
    const rowOf = (rowKey: string): WalkRow => {
      const row = rows.find((r) => r.key === rowKey);
      return { qty: Number(row?.qty) || 0, hasColour: Boolean(row?.colour) || rowKey === started };
    };
    return { nodes, stops, index, rowOf };
  }

  /**
   * Escape goes back the way Enter came: the stop before, without the packaging and grade of a
   * row with no quantity (`prevWalkStop`). Run before the screen's document-level Escape walk,
   * which only gets what is left: an Escape a field already used (a list closing) arrives
   * `defaultPrevented`. The first field has nothing before it: an untouched new card goes back to
   * the sub-product bar it came from, and one with anything typed is left to the screen's walk. So
   * is a card lifted from the list: its lines left the order with it, and Escape never drops them.
   */
  function stepBack(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape' || event.defaultPrevented || chorded(event)) return;
    const found = walkStops(event.target as Element);
    if (!found) return;
    const previous = prevWalkStop(found.stops, found.index, found.rowOf);
    if (previous === null) {
      if (
        !editing &&
        rows.every((row) => !row.qty && !row.colour && !row.packaging && !row.grade)
      ) {
        event.preventDefault();
        onClear();
      }
      return;
    }
    event.preventDefault();
    found.nodes[previous]?.focus();
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
   * A pick box's Enter, heard after the list inside it has taken the highlighted value (a
   * wrapper's handler runs after the box's own). Escape needs nothing here: the list closes on
   * its first press when somebody opened it, and otherwise the screen's walk steps back.
   */
  function pickKey(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Enter' || chorded(event)) return;
    event.preventDefault();
    stepOn(event.target as Element);
  }

  /** A pick — by Enter or by mouse — moves on by itself (owner's instruction, 2026-09-30). */
  function picked(key: string, patch: Partial<GridRow>): void {
    onRow(key, patch);
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

  /** The row's name for a screen reader: its code, and the colour it is in. */
  const rowName = (row: GridRow): string =>
    row.colour ? `${row.code} · ${labelOf(row.colour)}` : row.code;

  return (
    <ProductCard
      head={
        <>
          <ProductThumb
            images={first?.image ? [first.image] : undefined}
            size={48}
            fallback="initial"
            alt=""
            name={first?.categoryName ?? ''}
          />
          {first?.categoryCode && (
            <span
              className="ob-mono"
              style={{
                fontSize: rem(12),
                color: 'var(--accent)',
                whiteSpace: 'nowrap',
                flex: 'none',
              }}
            >
              {first.categoryCode}
            </span>
          )}
          <span
            className="ob-body-strong"
            style={{ flex: '1 1 8rem', minWidth: 0, overflowWrap: 'anywhere' }}
          >
            {first?.categoryName}
          </span>
          {first?.brand && (
            <span className="ob-order-eyebrow" style={{ whiteSpace: 'nowrap', flex: 'none' }}>
              {first.brand}
            </span>
          )}
          <span
            className="ob-small"
            style={{ color: 'var(--fg-tertiary)', whiteSpace: 'nowrap', flex: 'none' }}
          >
            {editing ? t('lead.add.draft.editing') : t('lead.add.draft.new')}
          </span>
          <button
            type="button"
            className="ob-btn ob-btn--ghost"
            aria-label={t('lead.add.products.clear')}
            title={t('lead.add.products.clear')}
            style={{ flex: 'none', padding: 0, minWidth: rem(24), minHeight: rem(24) }}
            onClick={onClear}
          >
            <Icon name="close" size={14} />
          </button>
        </>
      }
      footer={
        // The Master's footer row: the key hint, then the pieces and Add sub product, which keeps
        // to the right when the row wraps.
        <div className="ob-order-product__footrow">
          <span className="ob-order-hint">{t('lead.add.card.shiftQ')}</span>
          <span style={{ flex: 1, minWidth: 0 }} />
          <span
            className="ob-small"
            style={{ color: 'var(--fg-secondary)', whiteSpace: 'nowrap', flex: 'none' }}
          >
            {t('lead.add.card.thisProduct')}{' '}
            <span className="ob-body-strong" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {pieces.toLocaleString('en-IN')}
            </span>{' '}
            {t('unit.pieces')}
          </span>
          {/*
           * The end of the card's Enter walk: Enter on the last field comes here and Enter here
           * adds. `data-field` makes it a stop of the screen's Escape walk too, back to the last
           * field. Short of something it is drawn disabled but keeps the caret: Enter or a click on
           * it goes to what the card lacks.
           */}
          <Button
            variant="secondary"
            className="ob-order-add"
            data-field
            data-add-card
            data-walk="add"
            onKeyDown={addKey}
            aria-disabled={!ready || undefined}
            style={{ flex: 'none', whiteSpace: 'nowrap' }}
            aria-label={editing ? t('lead.add.draft.saveChanges') : t('lead.add.draft.saveProduct')}
            onClick={addCard}
          >
            {editing ? t('lead.add.draft.saveChanges') : t('lead.add.draft.saveProduct')}
            <span className="ob-order-kbd" aria-hidden="true">
              Enter
            </span>
          </Button>
        </div>
      }
    >
      {colourOptions.length === 0 && rows.some((row) => row.rule === 'selectable') && (
        <p
          role="note"
          className="ob-small"
          style={{ margin: `${rem(8)} ${rem(14)} 0`, color: 'var(--state-conflict)' }}
        >
          {t('lead.add.draft.noColourList')}
        </p>
      )}

      {offered.length > 0 && (
        <div
          style={{ display: 'flex', justifyContent: 'flex-end', padding: `${rem(4)} ${rem(14)} 0` }}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              for (const row of offered) {
                onRow(row.key, { packaging: suggestedPackaging(row.productId) ?? '' });
              }
            }}
          >
            {t('lead.add.products.useSuggested', {
              value: suggestedPackaging(offered[0]!.productId) ?? '',
            })}
          </Button>
        </div>
      )}

      <div
        onKeyDown={stepBack}
        onFocus={(event) => {
          const field = (event.target as HTMLElement).closest<HTMLElement>('[data-row]');
          if (field?.dataset.row) setActiveRow(field.dataset.row);
        }}
      >
        <SubGrid
          bodyRef={bodyRef}
          labels={{
            code: t('lead.add.products.col.code'),
            sub: t('lead.add.products.col.product'),
            colour: t('lead.add.draft.colour'),
            weight: t('lead.add.products.col.weight'),
            qty: t('lead.add.draft.col.qty'),
            grade: t('lead.add.draft.grade'),
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
          }}
        >
          {rows.map((row) => {
            const fixedColour = row.rule === 'fixed' ? row.variantLabel : null;
            return (
              <Fragment key={row.key}>
                <SubRow muted={!isCounted(row)}>
                  <span className="ob-order-cell--code" title={row.code}>
                    {row.code}
                  </span>
                  <span className="ob-order-cell--name" title={row.productName}>
                    {row.productName}
                  </span>
                  {asksColour(row) ? (
                    <ColourSelect
                      value={row.colour}
                      options={colourOptions}
                      labelOf={labelOf}
                      hexOf={colourHex}
                      ariaLabel={`${t('lead.add.draft.colour')} — ${row.code}`}
                      placeholder={t('lead.add.card.pickColour')}
                      hint={t('lead.add.card.colourHint')}
                      noMatches={t('common.noMatches')}
                      attention={isCounted(row) && !row.colour.trim()}
                      inputRef={(element) => {
                        if (!element) return;
                        element.dataset.walk = 'colour';
                        element.dataset.row = row.key;
                      }}
                      // Open as the walk arrives; reached by Tab or Escape, the first Enter opens
                      // it (`openOnEnter`).
                      onPick={(colour) => onRow(row.key, { colour })}
                      onAdvance={(picked) =>
                        stepOn(document.activeElement, picked ? row.key : undefined)
                      }
                    />
                  ) : fixedColour ? (
                    <span className="ob-order-cell--fixed">
                      <ColourChip name={labelOf(fixedColour)} hex={colourHex(fixedColour)} />
                      <span>{labelOf(fixedColour)}</span>
                    </span>
                  ) : (
                    <span className="ob-order-cell--fixed">—</span>
                  )}
                  <span className="ob-order-cell--num">
                    <WeightCell kg={row.weightKg} />
                  </span>
                  <Input
                    value={row.qty}
                    inputMode="numeric"
                    placeholder="0"
                    aria-label={`${t('lead.add.draft.col.quantity')} — ${rowName(row)}`}
                    data-walk="qty"
                    data-row={row.key}
                    style={{ textAlign: 'right', minWidth: 0, width: '100%' }}
                    onChange={(event) =>
                      onRow(row.key, { qty: event.target.value.replace(/[^0-9]/g, '') })
                    }
                    onKeyDown={(event) => quantityKey(event, row)}
                  />
                  {/*
                   * Packaging and grade beside the quantity, the same box (owner's instructions,
                   * 2026-09-30): the kit's pick-only `Select` is an `Input` with a list under it.
                   * Type a letter or arrow down, Enter takes it and steps on; "—" is none. A box
                   * whose list is empty (a shop with no grades) is no step of the walk.
                   */}
                  <span style={{ minWidth: 0 }} onKeyDown={pickKey}>
                    <Select
                      value={row.packaging}
                      aria-label={`${t('lead.add.draft.packaging')} — ${rowName(row)}`}
                      aria-required={packagingRequired || undefined}
                      aria-invalid={
                        (packagingRequired && isCounted(row) && !row.packaging.trim()) || undefined
                      }
                      data-walk={
                        packagingOptions.length > 0 || row.packaging ? 'packaging' : undefined
                      }
                      data-row={row.key}
                      onChange={(event) => picked(row.key, { packaging: event.target.value })}
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
                      value={row.grade}
                      aria-label={`${t('lead.add.draft.grade')} — ${rowName(row)}`}
                      data-walk={gradeOptions.length > 0 || row.grade ? 'grade' : undefined}
                      data-row={row.key}
                      onChange={(event) => picked(row.key, { grade: event.target.value })}
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
              </Fragment>
            );
          })}
        </SubGrid>
      </div>

      {someSelectable && (
        <div className="ob-order-more">
          <button
            type="button"
            disabled={!moreTarget}
            onClick={() => moreTarget && onAnotherColour(moreTarget)}
          >
            <Icon name="plus" size={14} /> {t('lead.add.card.anotherColour')}
          </button>
        </div>
      )}

      {/* What is still missing, under the table: the footer keeps the artboard's one short hint. */}
      <p
        className="ob-small"
        data-card-hint
        style={{ margin: 0, padding: `${rem(6)} ${rem(14)} 0`, color: 'var(--fg-tertiary)' }}
      >
        {hint}
        {counted.length > 0 && previewKg > 0 && (
          <>
            {' · '}
            {t('lead.add.summary.weight', { kg: formatKg(previewKg) })}
          </>
        )}
      </p>

      {packagingOptions.length === 0 && rows.length > 0 && (
        <p
          className="ob-micro"
          style={{ margin: `${rem(4)} ${rem(14)} 0`, color: 'var(--fg-tertiary)' }}
        >
          {t('lead.add.draft.packagingEmpty')}
        </p>
      )}
      {gradeOptions.length === 0 && rows.length > 0 && (
        <p
          className="ob-micro"
          style={{ margin: `${rem(4)} ${rem(14)} 0`, color: 'var(--fg-tertiary)' }}
        >
          {t('lead.add.draft.gradeEmpty')}
        </p>
      )}
    </ProductCard>
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
