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
 * a *category* and a sub product a *model*). The search box is first the
 * **product bar**: a product by name or code, rows `CODE · Name · Brand`. The
 * chosen product becomes a chip in front of the box and the same box turns into
 * the **sub-product bar**: every sub product of that product in catalogue
 * order, narrowed locally as somebody types. Choosing one replaces the box with
 * it and opens a draft card underneath, which asks what the sub product's
 * colour rule (`colourRuleOf`) leaves to ask:
 *  · `fixed` — the colour is the variant's label, shown and not chosen; a
 *    quantity;
 *  · `dedicated` — nothing about colour at all; a quantity;
 *  · `selectable` (multicolour) — colours from the company's colour list,
 *    several if the customer wants several, each with its own quantity.
 * Each row's packaging sits right beside its quantity, a pick from the
 * company's `line.packaging` list (Box, Grass and Paper to start; Settings →
 * Fields keeps it), required only while the company requires it. Grade sits
 * beside the packaging, the same box over the company's `line.grade` list, and
 * is always optional.
 *
 * Keys, the way the counter works:
 *  · **Colour is the first step of a multicolour card** (a `selectable` sub
 *    product): the card opens on the colour box with the company's colour list
 *    down and the first colour highlighted, so Enter takes it. The box stays
 *    for the next colour (type to narrow, Enter takes the highlighted one), and
 *    Enter on the empty box — the list closed — goes on to the quantities. A
 *    `fixed` colour is shown and has no stop; a `dedicated` sub product has no
 *    colour at all, so its card opens on the first quantity;
 *  · **Enter** walks each row's quantity, its packaging and its grade (a pick
 *    in either moves on by itself), then the next row; after the last grade
 *    it lands on Add product, whose Enter adds the sub product and returns to
 *    the sub-product bar, the product still chosen. **Escape** walks back one
 *    field, Add product to grade to packaging to quantity to the row above;
 *  · **Shift+Q** (or Complete sub product) adds a pending valid one and goes
 *    to the product bar; with nothing pending and an empty sub-product box it
 *    just finishes the product. Anywhere it would do nothing it is a capital Q;
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

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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
  ProductVariant,
  SyncSnapshot,
} from '@orderbook/shared';
import {
  PICK_MAX_LIMIT,
  colourRuleOf,
  lineColourText,
  resolveCompanyFeatures,
  shownColour,
} from '@orderbook/shared';

import { Button } from './Button.js';
import { Card } from './Card.js';
import { ColourChip, ColourName, StatusPill, useColourHex } from './DataDisplay.js';
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

/** What every line and every draft row knows about its variant. */
interface VariantFacts {
  variantId: string;
  /** The colour or pattern; null on a product that comes in one form. */
  variantLabel: string | null;
  code: string;
  /** Per piece, or null while the master has no figure for it yet. */
  weightKg: number | null;
}

/** One variant of the model on the draft card, in one colour, with the quantity as typed. */
interface DraftRow extends VariantFacts {
  /**
   * The colour chosen from the colour list — only ever on a `selectable` sub
   * product, where each colour added is its own row. Blank everywhere else.
   */
  colour: string;
  /** Kept as text so a half-typed number stays half-typed. */
  qty: string;
  /** From the company's packaging list, beside the quantity; blank until somebody picks. */
  packaging: string;
  /** From the company's grade list, beside the packaging; blank is no grade. */
  grade: string;
}

/** What is decided once for the whole card, and copied onto every line it adds. */
interface ProductFacts {
  productId: string;
  productName: string;
  categoryName: string;
  /** Snapshots of the product's code and brand, sent with each line (§3). */
  categoryCode: string | null;
  brand: string | null;
  alias: string | null;
  size: string | null;
  /** Decides what the card asks about colour (§2). */
  rule: ColourRule;
  fromPartyVariant: boolean;
  notes: string;
}

/** The card one model is built in: the product's facts and a row per variant (and colour). */
interface DraftProduct extends ProductFacts {
  rows: DraftRow[];
  /** What a colour added to a `selectable` card is ordered in — one row per variant here. */
  variants: VariantFacts[];
  /** Where the line goes back to when the draft is a `Modify` of a saved one. */
  at: number | null;
  /** The saved line's key, kept so a modified line stays the same line. */
  editKey: string | null;
}

/** One line on the lead: one variant, one colour, one quantity. */
interface DraftLine extends ProductFacts, VariantFacts {
  key: string;
  colour: string;
  packaging: string;
  grade: string;
  quantity: number;
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

/** The variant's name as a line shows it: the colour, or the code when it has none. */
function variantName(facts: { variantLabel: string | null; code: string }): string {
  return facts.variantLabel ?? facts.code;
}

/** A draft row's identity: the same variant appears once per colour on a multicolour card. */
function rowKey(row: { variantId: string; colour: string }): string {
  return `${row.variantId}|${row.colour}`;
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
  const [draft, setDraft] = useState<DraftProduct | null>(null);
  /** Which panel rows are expanded, ticked, and what is filtering them. */
  const [openKey, setOpenKey] = useState<string | null>(null);
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
      lead
        ? [[lead.partyId, { id: lead.partyId, name: lead.partyName } as unknown as Party]]
        : [],
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
    seenParties.current.get(partyId) ?? null;

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

  const partyPick = partyRows.length ? Math.min(partySel, partyRows.length - 1) : 0;
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
        if (!cancelled) setSubRows(inCatalogueOrder(page.items));
      } catch {
        if (!cancelled) setSubRows([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [categoryId, catalogueRevision]);

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
    for (const line of lines) if (!line.key.startsWith('saved-')) byId.set(line.productId, line.productName);
    if (draft) byId.set(draft.productId, draft.productName);
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
            transportRef.current.liveProducts?.(ids.slice(index * LIVE_CHECK_BATCH, (index + 1) * LIVE_CHECK_BATCH)),
          ),
        );
        if (cancelled) return;
        if (answers.some((answer) => !answer || !answer.live)) {
          setGone([]);
          return;
        }
        const live = new Set(answers.flatMap((answer) => answer!.live!));
        setGone(checkedProducts.filter(([id]) => !live.has(id)).map(([id, name]) => ({ id, name })));
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

  const rows: Array<ProductCategory | Product> = category ? subMatches : categoryRows;
  const pick = rows.length ? Math.min(sel, rows.length - 1) : 0;
  const listOpen = !draft && searchOpen;
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row on screen as the arrows walk past the list's
  // visible rows. `?.()`: jsdom has no `scrollIntoView`.
  useEffect(() => {
    if (!listOpen) return;
    const rowEls = listRef.current?.querySelectorAll<HTMLElement>('button.ob-suggest-row');
    rowEls?.[pick]?.scrollIntoView?.({ block: 'nearest' });
  }, [listOpen, pick, category]);

  function chooseCategory(next: ProductCategory): void {
    setCategory(next);
    setQuery('');
    setSel(0);
    setSearchOpen(true);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }

  function clearCategory(): void {
    setCategory(null);
    setQuery('');
    setSel(0);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }

  // --- Draft --------------------------------------------------------------

  function factsFor(variant: ProductVariant): VariantFacts {
    return {
      variantId: variant.id,
      variantLabel: variant.label,
      code: variant.code,
      weightKg: variant.weightKg,
    };
  }

  function openDraft(product: Product, typed = ''): void {
    const partyRecord = partyRecordFor.get(product.id) ?? null;
    const rule = colourRuleOf(product);
    // A variant taken off the form stays sellable on old lines, not new ones.
    const active = product.variants.filter((variant) => variant.isActive);
    // A code typed exactly names one variant, so the card opens on that one
    // alone — the way Modify opens a saved line.
    const exact = active.find(
      (variant) => variant.code.toLowerCase() === typed.trim().toLowerCase(),
    );
    const variants = (exact ? [exact] : active).map(factsFor);

    setDraft({
      productId: product.id,
      productName: partyRecord?.productName ?? product.name,
      categoryName: product.categoryName,
      categoryCode: product.categoryCode,
      brand: product.brand,
      alias: partyRecord?.alias ?? product.alias,
      size: partyRecord?.size ?? product.size,
      rule,
      fromPartyVariant: partyRecord !== null,
      notes: '',
      /*
       * A multicolour card starts with no rows: the colours are the first
       * thing it asks, each one adding its own row. Every other card has a row
       * per variant, blank until somebody types. With no colour list at all
       * there is nothing to choose from, so a multicolour card falls back to
       * the plain rows rather than become impossible to add.
       *
       * Packaging starts empty on purpose (§3.2): the party's saved packaging
       * is offered on the card as a suggestion, never applied. Grade starts
       * empty too — there is no grade on a party's record to carry over.
       */
      rows:
        rule === 'selectable' && colourOptions.length > 0
          ? []
          : variants.map((variant) => ({
              ...variant,
              colour: '',
              packaging: '',
              grade: '',
              qty: '',
            })),
      variants,
      at: null,
      editKey: null,
    });
    setQuery('');
    setSel(0);
    setSearchOpen(false);
  }

  function patchRow(key: string, patch: Partial<DraftRow>): void {
    setDraft((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((row) => (rowKey(row) === key ? { ...row, ...patch } : row)),
          }
        : current,
    );
  }

  /** A colour added to a multicolour card: a row for it on every variant the card orders. */
  function addColour(colour: string): void {
    setDraft((current) =>
      current
        ? {
            ...current,
            rows: [
              ...current.rows,
              ...current.variants
                .filter(
                  (variant) =>
                    !current.rows.some((row) => rowKey(row) === rowKey({ ...variant, colour })),
                )
                .map((variant) => ({ ...variant, colour, packaging: '', grade: '', qty: '' })),
            ],
          }
        : current,
    );
  }

  function removeColour(colour: string): void {
    setDraft((current) =>
      current ? { ...current, rows: current.rows.filter((row) => row.colour !== colour) } : current,
    );
  }

  function draftIsReady(candidate: DraftProduct): boolean {
    const filled = candidate.rows.filter((row) => Number(row.qty) > 0);
    // `leads.packagingRequiredOnConvert` off: a shop that packs to order
    // cannot state the packaging at the counter, so a line may go in without.
    // On, every row that becomes a line needs its own.
    return filled.length > 0 && !filled.some((row) => packagingRequired && !row.packaging.trim());
  }

  /**
   * One line per row with a quantity — per variant, and on a multicolour card
   * per colour: White ×10 and Ivory ×5 are two lines on the same variant.
   */
  function saveDraft(): void {
    if (!draft || !draftIsReady(draft)) return;

    const { rows: draftRows, variants: _variants, at, editKey, ...facts } = draft;
    const added: DraftLine[] = draftRows
      .filter((row) => Number(row.qty) > 0)
      .map((row, index) => {
        const { qty, ...variant } = row;
        return {
          ...facts,
          ...variant,
          quantity: Number(qty),
          // A modified line keeps its key, so a tick or an open row stays put.
          key: editKey && index === 0 ? editKey : `line-${nextKey.current++}`,
        };
      });

    setLines((current) => {
      const next = current.slice();
      if (at === null) next.push(...added);
      else next.splice(Math.min(at, next.length), 0, ...added);
      return next;
    });
    setDraft(null);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }

  /**
   * Lift one saved line back into the card, on its own — the variant is fixed,
   * and so is its colour; a colour added now becomes a line of its own.
   */
  function modifyLine(line: DraftLine, index: number): void {
    setLines((current) => current.filter((candidate) => candidate.key !== line.key));
    setOpenKey(null);
    forget(line.key);
    const {
      key,
      quantity,
      colour,
      packaging,
      grade,
      variantId,
      variantLabel,
      code,
      weightKg,
      ...facts
    } = line;
    const variant: VariantFacts = {
      variantId,
      variantLabel,
      code,
      weightKg,
    };
    setDraft({
      ...facts,
      rows: [{ ...variant, colour, packaging, grade, qty: String(quantity) }],
      variants: [variant],
      at: index,
      editKey: key,
    });
  }

  function removeLine(line: DraftLine): void {
    setLines((current) => current.filter((candidate) => candidate.key !== line.key));
    setOpenKey((current) => (current === line.key ? null : current));
    forget(line.key);
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
  const selectedLines = lines.filter((line) => selected[line.key]);
  const shownKeys = panelLines.map((line) => line.key);
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
    setOpenKey((current) => (current && doomed.has(current) ? null : current));
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
    if (draft) {
      if (!draftIsReady(draft)) return false;
      saveDraft();
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
    if (draft) return t('lead.add.errors.draftOpen');
    // The Master refuses a whole new order that names a deleted product: stop here, keep the form.
    const goneLines = lines.filter((line) => gone.some((product) => product.id === line.productId));
    if (goneLines.length > 0) {
      return t('lead.add.errors.goneLines', { names: [...new Set(goneLines.map((line) => line.productName))].join(', ') });
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
      const answer =
        ids.length > 0 && ask ? await ask.call(transportRef.current, ids).catch(() => null) : null;
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
        // Only what changed, checked against the clocks it was opened at.
        const changes = changedLeadFields(editBase.opened, input, editBase.base);
        const saved = changes
          ? ((await transportRef.current.updateLead(lead.id, changes)) as Lead | undefined)
          : undefined;
        onSaved(lead.id, saved);
      } else {
        const { ownerId: chosen, ...rest } = input;
        const created = await transportRef.current.createLead(chosen ? { ...rest, ownerId: chosen } : rest);
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

  const searchPlaceholder = category
    ? t('lead.add.products.productPlaceholder', { category: category.name })
    : t('lead.add.products.categoryPlaceholder');

  return (
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-20)' }}>
      {/* --- Header ------------------------------------------------------ */}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
        <h1 className="ob-title" style={{ margin: 0 }}>
          {lead ? t('lead.edit.title') : t('lead.add.title')}
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
      {editBase.conflicted && !busy && (
        <StaleEditNotice
          lastWrite={remoteChange}
          busy={busy}
          onReload={onReload}
          onKeepMine={editBase.keepMine}
        />
      )}

      {/*
       * Two columns that become one when there is no room for two: the form on
       * the left, and everything already added on the right, where it stays in
       * view while the next product is being built rather than pushing the Save
       * button off the bottom of a growing page.
       */}
      <div className="ob-lead-cols">
        <div className="ob-lead-form" ref={formRef}>
          {/* --- The enquiry: party, source, follow-up -------------------- */}

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
                    {/*
                     * The name and nothing else (owner's instruction,
                     * 2026-09-22). The code, the phone number and the town
                     * belong to the *picker*, where they tell two Sharma
                     * Traders apart; once one has been chosen they are four
                     * more things to read on the field somebody is typing
                     * past, and the party is already decided.
                     */}
                    <span className="ob-body-strong ob-ellipsis">{selectedParty.name}</span>
                    {/* The key keeps its name from when party records carried
                        rates; the text says what it is now — the party's own
                        product names are in use. No money is shown. */}
                    {partyWiseMode && (
                      <StatusPill tone="ok">{t('lead.add.party.ownRates')}</StatusPill>
                    )}
                    <span style={{ flex: 1, minWidth: 0 }} />
                    {/*
                     * `data-field` puts this button back into the Enter/Escape
                     * walk. Choosing a party replaces the search box with this
                     * chip, so without it Escape from the source select would
                     * find no party field to go back to — it is the first step
                     * of the form, and it has to stay reachable as one.
                     */}
                    <Button
                      variant="secondary"
                      size="sm"
                      data-field
                      onClick={() => {
                        setPartyId('');
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
                          setPartySel(Math.min(partyPick + 1, Math.max(0, partyRows.length - 1)));
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
                            }}
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
              </div>

              <div className="ob-lead-enquiry">
                <div style={{ display: 'flex', flexDirection: 'column', gap: rem(5), minWidth: 0 }}>
                  <Eyebrow>{t('lead.add.source.label')}</Eyebrow>
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
                    style={{ width: '100%', maxWidth: rem(280) }}
                    onChange={(event) => setSourcePlatform(event.target.value)}
                  >
                    {sourceOptions.map((option) => (
                      <option key={option.id} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: rem(5), minWidth: 0 }}>
                  <Eyebrow>{t('lead.add.followUp.label')}</Eyebrow>
                  <span
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: 'var(--s-8)',
                    }}
                  >
                    <DateField
                      value={followUpDate}
                      aria-label={t('lead.add.details.followUp')}
                      onChange={(event) => setFollowUpDate(event.target.value)}
                    />
                    {/*
                     * The chips are one group: when the card is too narrow for the date and
                     * all three they drop below the date together, evenly spaced, instead of
                     * one chip trailing alone onto a second line (Office, 1280 px wide).
                     */}
                    <span
                      data-follow-up-chips
                      style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-8)' }}
                    >
                      {QUICK_FOLLOW_UPS.map(({ days, token }) => {
                        const iso = isoDate(days);
                        return (
                          <Chip
                            key={token}
                            active={followUpDate === iso}
                            onClick={() =>
                              setFollowUpDate((current) => (current === iso ? '' : iso))
                            }
                          >
                            {t(token)}
                          </Chip>
                        );
                      })}
                    </span>
                  </span>
                </div>

                {/* Raising a pending order for somebody else: only for whoever the
                    Master sent the list to (`record.reassignOwner`). */}
                {view.owners && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: rem(5), minWidth: 0 }}>
                    <Eyebrow>{t('lead.add.owner')}</Eyebrow>
                    <Select
                      value={ownerId}
                      aria-label={t('lead.add.owner')}
                      style={{ width: '100%', maxWidth: rem(280) }}
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
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* --- Products ----------------------------------------------------- */}

          <section ref={productsRef} style={{ display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: `${rem(6)} ${rem(10)}`,
                marginBottom: 'var(--s-6)',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: rem(17),
                  height: rem(17),
                  flex: 'none',
                  borderRadius: '50%',
                  background: lines.length > 0 ? 'var(--accent)' : 'var(--bg-sunken)',
                  color: lines.length > 0 ? 'var(--fg-on-accent)' : 'var(--fg-tertiary)',
                  fontSize: rem(11),
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                1
              </span>
              <span className="ob-body-strong">{t('lead.add.products.title')}</span>
              <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                {lines.length
                  ? t('lead.add.products.searchAdds')
                  : t('lead.add.products.searchFirst')}
              </span>
              <span style={{ flex: 1, minWidth: 0 }} />
              {lines.length > 0 && (
                <span className="ob-small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {summary}
                </span>
              )}
            </div>

            {/* The search field, or the model it turned into. */}
            <div style={{ position: 'relative' }}>
              {draft ? (
                <div className="ob-picked">
                  <span
                    className="ob-mono ob-body-strong"
                    style={{ fontSize: rem(14), color: 'var(--accent)' }}
                  >
                    {draft.variants.length === 1
                      ? draft.variants[0]!.code
                      : t('lead.add.products.variantCount', { count: draft.variants.length })}
                  </span>
                  <span className="ob-body-strong">{draft.productName}</span>
                  <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                    {[draft.categoryName, draft.size]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {draft.rule === 'selectable' && (
                    <StatusPill tone="accent">{t('product.multiColour.pill')}</StatusPill>
                  )}
                  <span style={{ flex: 1, minWidth: 0 }} />
                  <Button
                    variant="primary"
                    disabled={!draftIsReady(draft)}
                    onClick={() => saveDraft()}
                  >
                    {draft.editKey
                      ? t('lead.add.draft.saveChanges')
                      : t('lead.add.draft.saveProduct')}
                  </Button>
                  <Button
                    variant="secondary"
                    aria-label={t('lead.add.products.clear')}
                    title={t('lead.add.products.clear')}
                    onClick={() => {
                      setDraft(null);
                      window.setTimeout(() => searchRef.current?.focus(), 0);
                    }}
                  >
                    ✕
                  </Button>
                </div>
              ) : (
                <div className="ob-lead-search">
                  {category && (
                    <span className="ob-chip" aria-pressed="true" style={{ cursor: 'default' }}>
                      <span className="ob-ellipsis">
                        {category.name}
                      </span>
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
                      // a token in a search field is deleted.
                      if (event.key === 'Backspace' && query === '' && category) {
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
                       * something was typed. The sub-product bar reopens on
                       * its whole list after every line, and a Tab out of it
                       * took the first sub product as one nobody chose. A
                       * chord is never a pick: Ctrl+Enter here is the review.
                       */
                      const takes =
                        !chorded(event) &&
                        (event.key === 'Enter' || (event.key === 'Tab' && query.trim() !== ''));
                      if (takes && listOpen && rows[pick]) {
                        // Claimed, so the Enter walk does not step past a
                        // choice that has only just been made.
                        event.preventDefault();
                        if (category) openDraft(rows[pick] as Product, query);
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
                </div>
              )}

              {listOpen && !category && (
                <div role="listbox" className="ob-suggest" ref={listRef}>
                  <div
                    className="ob-suggest-row ob-eyebrow"
                    style={{ gridTemplateColumns: 'minmax(0, 1fr)', color: 'var(--fg-tertiary)' }}
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
                <div role="listbox" className="ob-suggest" ref={listRef}>
                  <div
                    className="ob-suggest-row ob-eyebrow"
                    style={{ gridTemplateColumns: SUGGEST_GRID, color: 'var(--fg-tertiary)' }}
                  >
                    <span>{t('lead.add.products.col.code')}</span>
                    <span>{t('lead.add.products.col.product')}</span>
                    <span>{t('lead.add.products.col.variant')}</span>
                    <span style={{ textAlign: 'right' }}>{t('lead.add.products.col.weight')}</span>
                  </div>
                  {subMatches.map((row, index) => {
                    const active = row.variants.filter((variant) => variant.isActive);
                    const first = active[0] ?? row.variants[0];
                    const weights = active.map((variant) => variant.weightKg);
                    const rule = colourRuleOf(row);
                    // A colour-named sub product (a fixed colour, or MAGENTA
                    // sold in Magenta) carries its swatch beside the name.
                    const swatch =
                      rule === 'fixed' && first?.label ? colourHex(first.label) : undefined;
                    return (
                      <button
                        key={row.id}
                        type="button"
                        /*
                         * Out of the Tab order: the rows are for the pointer,
                         * the box's arrows and Enter are the keyboard's. A Tab
                         * from an empty bar landed on the first row, the box's
                         * blur then closed the list under it, and the caret
                         * was left on nothing at all.
                         */
                        tabIndex={-1}
                        className="ob-suggest-row"
                        style={{
                          gridTemplateColumns: SUGGEST_GRID,
                          background: index === pick ? 'var(--bg-selected)' : undefined,
                        }}
                        onMouseEnter={() => setSel(index)}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          openDraft(row, query);
                        }}
                      >
                        <span
                          className="ob-mono ob-body-strong"
                          style={{
                            fontSize: rem(14),
                            color: index === pick ? 'var(--accent)' : undefined,
                          }}
                        >
                          {active.length > 1
                            ? t('lead.add.products.variantCount', { count: active.length })
                            : (first?.code ?? '—')}
                        </span>
                        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                          <span
                            className="ob-ellipsis"
                            style={{ display: 'flex', alignItems: 'center', gap: rem(6) }}
                          >
                            {swatch && first?.label && (
                              <ColourChip name={first.label} hex={swatch} />
                            )}
                            {row.name}
                          </span>
                          <span
                            className="ob-mono ob-micro"
                            style={{ color: 'var(--fg-tertiary)' }}
                          >
                            {row.size ?? ''}
                          </span>
                        </span>
                        <span className="ob-small ob-ellipsis" style={{ minWidth: 0 }}>
                          {active.length > 1
                            ? active.map((variant) => variant.label ?? variant.code).join(', ')
                            : rule === 'selectable'
                              ? t('product.multiColour.pill')
                              : (shownColour(first?.label, row.name) ?? '')}
                        </span>
                        <span
                          className="ob-small"
                          style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                        >
                          {weights.length === 1
                            ? formatKg(weights[0] ?? null)
                            : weights.some((weight) => weight === null)
                              ? t('product.weight.missingShort')
                              : formatKg(weights.reduce<number>((sum, w) => sum + (w ?? 0), 0))}
                        </span>
                      </button>
                    );
                  })}
                  {subMatches.length === 0 && (
                    <p className="ob-small" style={{ margin: 0, padding: 'var(--s-8)' }}>
                      {t('lead.add.products.noProduct')}
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
                  : category
                    ? t('lead.add.products.productHint')
                    : t('lead.add.products.categoryHint')}
              </p>
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

            {/* The card one model is built in before it joins the lead. */}
            {draft && (
              <DraftCard
                draft={draft}
                ready={draftIsReady(draft)}
                packagingRequired={packagingRequired}
                packagingOptions={packagingOptions}
                gradeOptions={gradeOptions}
                colourOptions={colourOptions}
                suggestedPackaging={partyRecordFor.get(draft.productId)?.packaging ?? null}
                colourHex={colourHex}
                onRow={patchRow}
                onAddColour={addColour}
                onRemoveColour={removeColour}
                onSave={saveDraft}
                onComplete={completeSubProduct}
              />
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

          {/* --- Save --------------------------------------------------------- */}

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
              title="Ctrl+S · Ctrl+Enter"
              onClick={() => void save()}
            >
              {busy ? t('lead.add.saving') : t('lead.add.save')}
            </Button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: rem(2) }}>
              <span className="ob-small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {summary}
                {lines.length > 0 && (
                  <>
                    {' · '}
                    {t('lead.add.summary.weight', { kg: formatKg(totalWeight) })}
                  </>
                )}
              </span>
              <span
                className="ob-micro"
                style={{ color: ready ? 'var(--fg-tertiary)' : 'var(--state-offline)' }}
              >
                {unweighed > 0
                  ? t(
                      unweighed === 1
                        ? 'lead.add.summary.noWeightOne'
                        : 'lead.add.summary.noWeight',
                      { count: unweighed },
                    )
                  : statusLine}
              </span>
            </div>
            <span style={{ flex: 1 }} />
            <span className="ob-title" style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>
              {totalQty.toLocaleString('en-IN')}{' '}
              <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
                {t('unit.pieces')}
              </span>
            </span>
          </div>
        </div>

        {/* --- Added products ------------------------------------------- */}

        <aside className="ob-lead-panel" aria-label={t('lead.add.panel.title')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
            <Eyebrow>{t('lead.add.panel.title')}</Eyebrow>
            <span
              className="ob-micro"
              style={{ color: 'var(--fg-tertiary)', fontVariantNumeric: 'tabular-nums' }}
            >
              {lines.length === 0
                ? ''
                : panelTerm
                  ? t('lead.add.panel.countFiltered', {
                      shown: matchedLines.length,
                      total: lines.length,
                    })
                  : String(lines.length)}
            </span>
            <span style={{ flex: 1, minWidth: 0 }} />
            <span className="ob-small" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {summary}
            </span>
          </div>

          <Input
            value={lineQuery}
            placeholder={t('lead.add.panel.search')}
            aria-label={t('lead.add.panel.search')}
            autoComplete="off"
            onChange={(event) => setLineQuery(event.target.value)}
          />

          {selectedLines.length > 0 && (
            <div className="ob-lead-selbar">
              <span
                className="ob-small ob-body-strong"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {t('lead.add.panel.selected', { count: selectedLines.length })}
              </span>
              <span style={{ flex: 1, minWidth: 0 }} />
              <Button variant="secondary" size="sm" onClick={() => setSelected({})}>
                {t('lead.add.panel.clear')}
              </Button>
              <Button variant="danger" size="sm" onClick={removeSelected}>
                {t(
                  selectedLines.length === 1
                    ? 'lead.add.panel.removeSelectedOne'
                    : 'lead.add.panel.removeSelected',
                  { count: selectedLines.length },
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

          {panelLines.length === 0 && (
            <p
              className="ob-small"
              style={{ margin: 0, padding: `${rem(12)} ${rem(2)}`, color: 'var(--fg-tertiary)' }}
            >
              {t(lines.length === 0 ? 'lead.add.panel.emptyNone' : 'lead.add.panel.emptyFiltered')}
            </p>
          )}

          <div className="ob-lead-lines">
            {panelLines.map((line) => (
              <LeadLine
                key={line.key}
                line={line}
                open={openKey === line.key}
                checked={Boolean(selected[line.key])}
                packagingRequired={packagingRequired}
                colourHex={colourHex}
                onToggle={() => setOpenKey((current) => (current === line.key ? null : line.key))}
                onCheck={() => toggleSelect(line.key)}
                onModify={() => modifyLine(line, lines.indexOf(line))}
                onRemove={() => removeLine(line)}
              />
            ))}
          </div>

          {matchedLines.length > panelLines.length && (
            <p className="ob-micro" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
              {t('lead.add.panel.truncated', { shown: panelLines.length })}
            </p>
          )}
        </aside>
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
        summary={summary}
        busy={busy}
        error={error}
        onClose={() => setReviewOpen(false)}
        onConfirm={() => void save()}
      />

      <PartyFormModal
        transport={transport}
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

const SUGGEST_GRID = `${rem(84)} minmax(0, 1fr) minmax(0, 0.7fr) ${rem(84)}`;
/*
 * Six columns in the form column's width — code, variant, weight, quantity,
 * packaging, grade. It shares the screen with the Added-products panel, so at
 * the 1024-wide floor the minimums must fit about 27rem: the figures get as
 * little as they need, packaging and grade shrink from a comfortable width to
 * a word and the chevron, and the variant's name takes what is left.
 */
const VARIANT_GRID = `${rem(64)} minmax(${rem(48)}, 1fr) ${rem(60)} ${rem(56)} minmax(${rem(72)}, ${rem(96)}) minmax(${rem(72)}, ${rem(96)})`;

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
 * A row's colour with its dot, when the palette knows the colour: the fixed
 * colour (the variant's label), or the one chosen on a multicolour row.
 *
 * The words are left off when they only repeat the sub product's name —
 * MAGENTA in Magenta (§2); the dot stays. A dedicated sub product has no
 * colour at all and shows the table's em-dash.
 */
function VariantName({
  colour,
  productName,
  hex,
}: {
  colour: string | null;
  productName: string;
  hex: string | undefined;
}) {
  return (
    <span
      className="ob-small"
      style={{ display: 'inline-flex', alignItems: 'center', gap: rem(7), minWidth: 0 }}
    >
      {colour && (
        <span
          aria-hidden="true"
          style={{
            width: rem(13),
            height: rem(13),
            borderRadius: '50%',
            flex: 'none',
            background: hex ?? 'var(--bg-sunken)',
            border: '1px solid var(--line-strong)',
          }}
        />
      )}
      <span className="ob-ellipsis">{colour ? (shownColour(colour, productName) ?? '') : '—'}</span>
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
 * One variant already on the lead, as the panel draws it.
 *
 * Collapsed it is one line — code, name, colour, quantity — so twenty lines
 * can be scanned for the one that is wrong. Opened it adds **one wrapping row**
 * of everything else the line knows, and the two things that can be done about
 * it.
 *
 * One row, not five. It was five: a variant line, a weight line, a packaging
 * line, and a button line, each the full width of the panel and
 * mostly empty — expanding one product pushed the next three off the screen.
 * The facts are short words; they belong beside each other, separated by a
 * middot, and they wrap when there is no room.
 *
 * A line with no variant name of its own no longer draws an em-dash for it.
 * The placeholder is right in the draft card's *table*, where a column has to
 * have a cell; here it sat immediately in front of the colour swatch and read
 * as though something were missing.
 *
 * The tick box sits outside the toggle rather than inside it: expanding a row
 * to read it must not select it for removal.
 */
function LeadLine({
  line,
  open,
  checked,
  packagingRequired,
  colourHex,
  onToggle,
  onCheck,
  onModify,
  onRemove,
}: {
  line: DraftLine;
  open: boolean;
  checked: boolean;
  packagingRequired: boolean;
  colourHex: (name: string) => string | undefined;
  onToggle: () => void;
  onCheck: () => void;
  onModify: () => void;
  onRemove: () => void;
}) {
  const kg = lineWeight(line);
  const packaging = line.packaging.trim();
  const grade = line.grade.trim();

  /*
   * The colour to show a swatch for: the one chosen on the line, or the
   * variant's own when nothing was chosen. A product that comes in one
   * unlabelled form has neither, and then there is simply no swatch — the
   * em-dash that used to stand in for it said nothing the row did not already
   * say by leaving the space empty. Nor when the variant's colour only
   * repeats the name (`MAGENTA` in Magenta), as the head above leaves it out.
   */
  const swatch = line.colour.trim() || shownColour(line.variantLabel, line.productName);

  /*
   * Everything the collapsed head has no room for, in the order somebody reads
   * it: what it is, then how it goes out, then what it weighs. Each entry is a
   * few words; `null` drops out rather than leaving a gap.
   */
  const facts: ReactNode[] = [
    swatch ? <ColourName key="colour" name={swatch} hex={colourHex(swatch)} /> : null,
    line.categoryName ? <span key="category">{line.categoryName}</span> : null,
    grade ? (
      <span key="grade">
        {t('lead.add.line.grade')} {grade}
      </span>
    ) : null,
    // "no packaging" is a warning only while the company requires packaging;
    // otherwise a line without it is simply how the shop sells.
    packaging || packagingRequired ? (
      <span key="packaging" style={packaging ? undefined : { color: 'var(--state-offline)' }}>
        {packaging || t('lead.add.line.noPackaging')}
      </span>
    ) : null,
    // The long wording, not the table's `missingShort`. In the draft card's
    // variants table a bare "missing" sits under a Weight column header; in a
    // row of middot-separated words it would be missing *what*.
    line.weightKg === null ? (
      <StatusPill key="weight" tone="offline">
        {t('product.weight.missing')}
      </StatusPill>
    ) : (
      <span key="weight">{t('lead.add.line.lineWeight', { kg: formatKg(kg) })}</span>
    ),
  ].filter(Boolean);

  return (
    <div className="ob-lead-line" data-open={open ? 'true' : undefined}>
      <div className="ob-lead-line__head">
        <input
          type="checkbox"
          className="ob-lead-check"
          style={{ marginLeft: 'var(--s-8)' }}
          checked={checked}
          aria-label={t('lead.add.panel.select', { product: line.productName })}
          onChange={onCheck}
        />
        <button
          type="button"
          className="ob-lead-line__toggle"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span aria-hidden="true" style={{ flex: 'none', color: 'var(--fg-tertiary)' }}>
            {open ? '▾' : '▸'}
          </span>
          <span className="ob-mono ob-body-strong" style={{ flex: 'none' }}>
            {line.code}
          </span>
          <span className="ob-body-strong ob-ellipsis" style={{ flex: 1, minWidth: 0 }}>
            {line.productName}
            {shownColour(line.variantLabel, line.productName) && (
              <span className="ob-small" style={{ fontWeight: 450, color: 'var(--fg-secondary)' }}>
                {' · '}
                {line.variantLabel}
              </span>
            )}
            {line.colour && (
              <span className="ob-small" style={{ fontWeight: 450, color: 'var(--fg-secondary)' }}>
                {' · '}
                {line.colour}
              </span>
            )}
            {line.grade && (
              <span className="ob-small" style={{ fontWeight: 450, color: 'var(--fg-secondary)' }}>
                {' · '}
                {line.grade}
              </span>
            )}
          </span>
          <span
            className="ob-micro"
            style={{
              flex: 'none',
              color: 'var(--fg-tertiary)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {t('lead.add.line.qtyShort', { count: line.quantity })}
          </span>
        </button>
      </div>

      {open && (
        <div className="ob-lead-line__body">
          <span className="ob-lead-line__facts ob-micro">
            {facts.map((fact, index) => (
              <Fragment key={index}>
                {index > 0 && (
                  <span aria-hidden="true" className="ob-lead-line__sep">
                    ·
                  </span>
                )}
                {fact}
              </Fragment>
            ))}
          </span>

          <span className="ob-lead-line__acts">
            {/*
             * Icons on a tinted square, not words (owner's instruction). Two
             * verbs repeated down a list of twenty lines is twenty times the
             * same two words; the pencil and the bin are read once. The square
             * is what makes them look pressable — as bare ghost text they read
             * as part of the sentence in front of them.
             *
             * `title` for the pointer, `aria-label` naming the product for
             * everything else: "Remove" on its own, twenty times over, tells a
             * screen reader nothing about which line is about to go.
             */}
            <button
              type="button"
              className="ob-lead-line__act"
              title={t('lead.add.line.modify')}
              aria-label={t('lead.add.line.modifyProduct', { product: line.productName })}
              onClick={onModify}
            >
              <Icon name="edit" size={14} />
            </button>
            <button
              type="button"
              className="ob-lead-line__act ob-lead-line__act--danger"
              title={t('lead.add.products.remove')}
              aria-label={t('lead.add.line.removeProduct', { product: line.productName })}
              onClick={onRemove}
            >
              <Icon name="trash" size={14} />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The card one sub product is built in before it joins the lead.
 *
 * Nothing here is on the voucher yet, which is the point: what the sub
 * product's colour rule leaves to ask, packaging while the company requires
 * it, and at least one quantity are all decided in one place, and Add is
 * refused until they are. The hint along the bottom says what is missing
 * rather than making somebody guess at a disabled button.
 *
 * One row per variant — per variant *and colour* on a multicolour card — the
 * code and weight already filled from the master; what is left to say is how
 * many and, right beside it, how they are packed and in which grade. A row
 * with no quantity simply adds nothing.
 *
 * Enter walks quantity → packaging → grade on each row, then on to Add
 * product; Enter there adds the card (§6.6–6.7). Escape walks the same stops
 * back — the screen's `useEscapeToPrevious` does that, the Add button being a
 * `data-field` stop of it.
 */
function DraftCard({
  draft,
  ready,
  packagingRequired,
  packagingOptions,
  gradeOptions,
  colourOptions,
  suggestedPackaging,
  colourHex,
  onRow,
  onAddColour,
  onRemoveColour,
  onSave,
  onComplete,
}: {
  draft: DraftProduct;
  ready: boolean;
  /** `leads.packagingRequiredOnConvert`, already coalesced by the screen. */
  packagingRequired: boolean;
  packagingOptions: OptionListItem[];
  gradeOptions: OptionListItem[];
  colourOptions: OptionListItem[];
  suggestedPackaging: string | null;
  colourHex: (name: string) => string | undefined;
  onRow: (key: string, patch: Partial<DraftRow>) => void;
  onAddColour: (colour: string) => void;
  onRemoveColour: (colour: string) => void;
  onSave: () => void;
  /** Shift+Q's button: add the card and go to the product bar. */
  onComplete: () => boolean;
}) {
  const quantitiesRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const filled = draft.rows.filter((row) => Number(row.qty) > 0);
  const pieces = filled.reduce((sum, row) => sum + Number(row.qty), 0);
  const previewKg = filled.reduce(
    (sum, row) => sum + (lineWeight({ weightKg: row.weightKg, quantity: Number(row.qty) }) ?? 0),
    0,
  );
  /** A multicolour card with a colour list to choose from (else it fell back to plain rows). */
  const choosing = draft.rule === 'selectable' && colourOptions.length > 0;

  /** A counted row still waiting for its packaging, while the company requires one. */
  const unpacked = (row: DraftRow): boolean =>
    packagingRequired && Number(row.qty) > 0 && !row.packaging.trim();

  const hint =
    choosing && draft.rows.length === 0
      ? t('lead.add.draft.hintColour')
      : filled.length === 0
        ? t('lead.add.draft.hintQuantity')
        : filled.some(unpacked)
          ? t('lead.add.draft.hintPackaging')
          : t('lead.add.draft.hintPieces', { count: pieces });

  function stepQty(row: DraftRow, delta: number): void {
    const current = Number(row.qty) || 0;
    onRow(rowKey(row), { qty: String(Math.max(0, current + delta)) });
  }

  /**
   * One stop on: each row's quantity, packaging and grade, then Add product.
   * A disabled Add takes no focus, so a card still short of something keeps
   * the caret on its last grade and the hint says what is missing.
   */
  function stepOn(from: Element | null): void {
    const stops: HTMLElement[] = [
      ...Array.from(quantitiesRef.current?.querySelectorAll('input') ?? []),
      ...Array.from(addRef.current?.querySelectorAll<HTMLElement>('[data-add-card]') ?? []),
    ];
    const index = stops.indexOf(from as HTMLElement);
    if (index >= 0) stops[index + 1]?.focus();
  }

  function quantityKey(event: ReactKeyboardEvent<HTMLInputElement>, row: DraftRow): void {
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
    // Claimed, not left to the screen's walk, which would run on past the Add
    // button into the notes.
    event.preventDefault();
    stepOn(event.currentTarget);
  }

  /**
   * A packaging or grade box's Enter, heard after the list inside it has
   * taken the highlighted value (a wrapper's handler runs after the box's
   * own). Escape needs nothing here: the list closes on its first press when
   * somebody opened it, and otherwise the screen's walk steps back.
   */
  function pickKey(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Enter' || chorded(event)) return;
    event.preventDefault();
    stepOn(event.target as Element);
  }

  /**
   * A pick — by Enter or by mouse — moves on by itself (owner's instruction,
   * 2026-09-30). The list keeps focus in its box while it is clicked, so the
   * box is the focused element here; on Enter `pickKey` then steps from the
   * same box to the same next stop.
   */
  function picked(key: string, patch: Partial<DraftRow>): void {
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
  /**
   * The party's saved packaging, offered — never applied (§3.2) — to the rows
   * still without one. An offer, not a refusal, so the switch does not enter
   * into it; a picked value is never blank-with-spaces, so no trim either.
   */
  const offerSuggested = draft.rows.some((row) => row.packaging === '');

  /*
   * Where the caret lands when the card replaces the search box: the first
   * thing the card asks. Without it the caret lands on the body and the Enter
   * walk has nowhere to start from.
   */
  const focusQuantity = !choosing;

  return (
    <Card padded={false} style={{ marginTop: 'var(--s-8)' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: `${rem(6)} ${rem(12)}`,
          padding: `${rem(8)} ${rem(14)}`,
          borderBottom: '1px solid var(--line)',
        }}
      >
        <Eyebrow>{t('lead.add.draft.title')}</Eyebrow>
        <span style={{ flex: 1, minWidth: 0 }} />
        <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
          {draft.editKey ? t('lead.add.draft.editing') : t('lead.add.draft.new')}
        </span>
      </div>

      <div style={{ padding: `${rem(12)} ${rem(14)} ${rem(14)}` }}>
        {/*
         * The colours of a multicolour sub product: asked before the
         * quantities, each colour adding its rows.
         */}
        {choosing && (
          <label
            className="ob-small"
            style={{
              display: 'block',
              maxWidth: rem(340),
              marginBottom: 'var(--s-12)',
              color: 'var(--fg-secondary)',
            }}
          >
            {t('lead.add.draft.colour')}
            <ColourAdder
              autoFocus
              options={colourOptions}
              taken={draft.rows.map((row) => row.colour)}
              hasRows={draft.rows.length > 0}
              colourHex={colourHex}
              onAdd={onAddColour}
            />
            {/*
             * The key hint lives under the box, wrapping, not in its placeholder: a
             * placeholder is one clipped line, and at 157 % the sentence did not fit.
             */}
            <span
              className="ob-micro"
              data-colour-keys
              style={{ display: 'block', marginTop: rem(4), color: 'var(--fg-tertiary)' }}
            >
              {t('lead.add.flow.colourKeys')}
            </span>
          </label>
        )}

        {draft.rule === 'selectable' && colourOptions.length === 0 && (
          <p
            role="note"
            className="ob-small"
            style={{ margin: `0 0 ${rem(12)}`, color: 'var(--state-conflict)' }}
          >
            {t('lead.add.draft.noColourList')}
          </p>
        )}

        {draft.rows.length > 0 && (
          <>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: `${rem(4)} ${rem(8)}`,
                marginBottom: rem(6),
              }}
            >
              <span className="ob-eyebrow" style={{ color: 'var(--fg-tertiary)' }}>
                {draft.rows.length > 1
                  ? t('lead.add.draft.quantityTitleVariants')
                  : t('lead.add.draft.quantityTitle')}
              </span>
              <span style={{ flex: 1, minWidth: 0 }} />
              {suggestedPackaging && offerSuggested && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    for (const row of draft.rows) {
                      if (row.packaging === '') {
                        onRow(rowKey(row), { packaging: suggestedPackaging });
                      }
                    }
                  }}
                >
                  {t('lead.add.products.useSuggested', { value: suggestedPackaging })}
                </Button>
              )}
            </div>

            <div
              className="ob-eyebrow"
              style={{
                display: 'grid',
                gridTemplateColumns: VARIANT_GRID,
                gap: `0 ${rem(8)}`,
                paddingBottom: rem(4),
                color: 'var(--fg-tertiary)',
              }}
            >
              <span>{t('lead.add.products.col.code')}</span>
              <span>{t('lead.add.products.col.variant')}</span>
              <span style={{ textAlign: 'right' }}>{t('lead.add.products.col.weight')}</span>
              <span style={{ textAlign: 'right' }}>{t('lead.add.draft.col.qty')}</span>
              <span>
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
              </span>
              <span>{t('lead.add.draft.grade')}</span>
            </div>
          </>
        )}
        <div ref={quantitiesRef}>
          {draft.rows.map((row, index) => {
            // The chosen colour on a multicolour row, else the fixed one.
            const colour = row.colour || row.variantLabel;
            const named = row.colour || variantName(row);
            const key = rowKey(row);
            return (
              <div
                key={key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: VARIANT_GRID,
                  gap: `0 ${rem(8)}`,
                  alignItems: 'center',
                  padding: `${rem(3)} 0`,
                }}
              >
                <span className="ob-mono ob-body-strong ob-ellipsis">{row.code}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: rem(4), minWidth: 0 }}>
                  <VariantName
                    colour={colour}
                    productName={draft.productName}
                    hex={colour ? colourHex(colour) : undefined}
                  />
                  {row.colour && (
                    <button
                      type="button"
                      className="ob-btn ob-btn--ghost"
                      aria-label={t('lead.add.draft.removeColour', { colour: row.colour })}
                      title={t('lead.add.draft.removeColour', { colour: row.colour })}
                      style={{ padding: 0, minWidth: rem(20) }}
                      onClick={() => onRemoveColour(row.colour)}
                    >
                      ✕
                    </button>
                  )}
                </span>
                <span style={{ textAlign: 'right' }}>
                  <WeightCell kg={row.weightKg} />
                </span>
                <Input
                  value={row.qty}
                  autoFocus={focusQuantity && index === 0}
                  inputMode="numeric"
                  placeholder="0"
                  aria-label={`${t('lead.add.draft.col.quantity')} — ${named}`}
                  style={{ textAlign: 'right', minWidth: 0, width: '100%' }}
                  onChange={(event) =>
                    onRow(key, { qty: event.target.value.replace(/[^0-9]/g, '') })
                  }
                  onKeyDown={(event) => quantityKey(event, row)}
                />
                {/*
                 * Packaging and grade beside the quantity and the same box
                 * (owner's instructions, 2026-09-30): the kit's pick-only
                 * `Select` is an `Input` with a list under it. Type a letter or
                 * arrow down, Enter takes it and steps on; "—" is none.
                 */}
                <span style={{ minWidth: 0 }} onKeyDown={pickKey}>
                  <Select
                    value={row.packaging}
                    aria-label={`${t('lead.add.draft.packaging')} — ${named}`}
                    aria-required={packagingRequired || undefined}
                    aria-invalid={unpacked(row) || undefined}
                    onChange={(event) => picked(key, { packaging: event.target.value })}
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
                    aria-label={`${t('lead.add.draft.grade')} — ${named}`}
                    onChange={(event) => picked(key, { grade: event.target.value })}
                  >
                    <option value="">—</option>
                    {valuesFor(gradeOptions, row.grade).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </span>
              </div>
            );
          })}
        </div>
        {draft.rows.length > 0 && packagingOptions.length === 0 && (
          <p className="ob-micro" style={{ margin: `${rem(4)} 0 0`, color: 'var(--fg-tertiary)' }}>
            {t('lead.add.draft.packagingEmptyFields')}
          </p>
        )}
        {draft.rows.length > 0 && gradeOptions.length === 0 && (
          <p className="ob-micro" style={{ margin: `${rem(4)} 0 0`, color: 'var(--fg-tertiary)' }}>
            {t('lead.add.draft.gradeEmptyFields')}
          </p>
        )}

        <div
          ref={addRef}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'var(--s-8)',
            marginTop: 'var(--s-16)',
            paddingTop: 'var(--s-12)',
            borderTop: '1px solid var(--line)',
          }}
        >
          <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
            {hint}
            {filled.length > 0 && previewKg > 0 && (
              <>
                {' · '}
                {t('lead.add.summary.weight', { kg: formatKg(previewKg) })}
              </>
            )}
          </span>
          <span style={{ flex: 1, minWidth: 0 }} />
          <Button
            variant="secondary"
            disabled={!ready}
            title="Shift+Q"
            onClick={() => onComplete()}
          >
            {t('lead.add.flow.completeSubProduct')}
          </Button>
          {/*
           * The last stop of the card's Enter walk, after the last grade: Enter
           * over a button is a click. `data-field` makes it a stop of the
           * screen's Escape walk too, back to that grade. While the draft is
           * short of something the button is disabled, which takes it out of
           * both.
           */}
          <Button variant="primary" data-field data-add-card disabled={!ready} onClick={onSave}>
            {draft.editKey ? t('lead.add.draft.saveChanges') : t('lead.add.draft.saveProduct')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * The colour range for a multicolour sub product (§6.6), from the company's
 * colour list: type to narrow, Enter adds the highlighted colour and stays for
 * the next; Enter on the empty box goes on to the quantities — left to the
 * Enter walk, which is the field after this one.
 *
 * Not the kit's `Combobox`: that takes its first row on any Enter, so the
 * empty box could never step on to the quantities. And not a native select,
 * which on Windows commits a value on every arrow press.
 */
function ColourAdder({
  options,
  taken,
  hasRows,
  colourHex,
  autoFocus,
  onAdd,
}: {
  options: OptionListItem[];
  /** Colours already on the card, which are not offered twice. */
  taken: readonly string[];
  /** Whether there is a quantity to walk on to yet. */
  hasRows: boolean;
  colourHex: (name: string) => string | undefined;
  autoFocus: boolean;
  onAdd: (colour: string) => void;
}) {
  const [query, setQuery] = useState('');
  // A card with no colour yet opens with the list down and the first colour
  // highlighted, so the Enter walk is Enter to take it and Enter to go on: the
  // colour is a step of the flow, not a box to find and type into.
  const [open, setOpen] = useState(autoFocus && !hasRows);
  const [sel, setSel] = useState(0);

  const term = query.trim().toLowerCase();
  const matches = options.filter(
    (option) =>
      !taken.includes(option.value) &&
      (option.label.toLowerCase().includes(term) || option.value.toLowerCase().includes(term)),
  );
  const pick = matches.length ? Math.min(sel, matches.length - 1) : 0;

  function add(colour: string): void {
    onAdd(colour);
    setQuery('');
    setOpen(false);
    setSel(0);
  }

  return (
    <span style={{ position: 'relative', display: 'block', marginTop: rem(4) }}>
      <Input
        autoFocus={autoFocus}
        value={query}
        placeholder={t('lead.add.flow.addColourPlaceholder')}
        aria-label={t('lead.add.flow.addColour')}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        style={{ width: '100%' }}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setSel(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (open) setSel(Math.min(pick + 1, Math.max(0, matches.length - 1)));
            setOpen(true);
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSel(Math.max(0, pick - 1));
            return;
          }
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
            return;
          }
          if (event.key !== 'Enter' || chorded(event)) return;
          const chosen = open ? matches[pick] : undefined;
          if (chosen) {
            event.preventDefault();
            add(chosen.value);
          } else if (!hasRows) {
            // No colour yet, so no quantity to walk on to: Enter opens the list
            // again (after an Escape closed it) rather than doing nothing.
            event.preventDefault();
            setOpen(true);
          }
        }}
      />
      {open && (
        <div role="listbox" className="ob-suggest">
          {matches.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              // Out of the Tab order, for the bars' reason: the box's blur closes this list.
              tabIndex={-1}
              aria-selected={index === pick}
              className="ob-suggest-row"
              style={{
                gridTemplateColumns: 'minmax(0, 1fr)',
                background: index === pick ? 'var(--bg-selected)' : undefined,
              }}
              onMouseEnter={() => setSel(index)}
              // `mousedown`, not `click`: the box's blur would close the list first.
              onMouseDown={(event) => {
                event.preventDefault();
                add(option.value);
              }}
            >
              <ColourName name={option.label} hex={colourHex(option.value)} />
            </button>
          ))}
          {matches.length === 0 && (
            <p className="ob-small" style={{ margin: 0, padding: 'var(--s-8)' }}>
              {t('common.noMatches')}
            </p>
          )}
        </div>
      )}
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
                    lineColourText(group, first.productName),
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
