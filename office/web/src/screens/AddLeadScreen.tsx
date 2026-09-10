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
 * The unit of work is **one product in one colour**. That pair has its own short
 * code (`InventoryStockLevel.variantCode`), so the search box answers a typed
 * code with exactly one row — code, product, colour and what is free to sell —
 * instead of a product somebody then has to pick a colour on. Choosing one
 * replaces the search field with the product itself and opens a draft card
 * underneath: packaging, grade and rate at the top, a quantity per colour
 * below. Nothing joins the lead until that card is added, so a half-filled
 * product cannot ride along unnoticed, and the search field comes straight back
 * for the next one.
 *
 * Three rules are enforced visibly rather than only on the server:
 *  · **Packaging is never auto-filled.** Picking a code fills every other field
 *    and pointedly leaves packaging empty — the draft cannot be added until
 *    somebody chooses one.
 *  · **A rate can be switched off.** "To be quoted later" and "nobody has typed
 *    it yet" are different facts, and the line stores them differently: the
 *    switch sends `rateUnset`, which stops the catalogue fallback that an empty
 *    field falls into.
 *  · **A party's own rates change where money comes from**, but a party's saved
 *    packaging is only ever a suggestion.
 *
 * The rate a line opens on is the last rate actually used for this party and
 * this product, read out of the leads and orders already in this panel's
 * snapshot; failing that the party's variant rate, failing that the catalogue.
 * The note under the field says which of the three it is, and a changed rate
 * offers to go back. No endpoint and no request — it works with the Master
 * switched off, like everything else here.
 *
 * Saving works with no link to the Master: the lead is queued locally with a
 * temporary id and appears on the board immediately.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  CustomFieldDefinition,
  Lead,
  LineItemInput,
  OptionListItem,
  Order,
  Party,
  PartyProductVariant,
  ProductVariantPick,
} from '@orderbook/shared';

import { api, type LocalView } from '../api';
import { CustomFields } from '../components/CustomFields';
import { PartyDrawer, type CreatedParty } from '../components/PartyDrawer';
import {
  Button,
  Card,
  ConflictBanner,
  DateField,
  Input,
  Select,
  SuggestInput,
  StatusPill,
  Textarea,
  formatMoney,
  rem,
  t,
  useColourHex,
  useDebounced,
  useEnterToAdvance,
  useEscapeToPrevious,
  useResetGuard,
  useCommand,
  useSubNav,
} from '@orderbook/ui';

interface Props {
  view: LocalView;
  /** From the signed-in person's own resolved set, not the snapshot's. */
  canEditRate: boolean;
  /** Carries the queued lead's temporary id, so the shell can name it. */
  onSaved: (id: string) => void;
  onCancel: () => void;
}

/** One colour of a line, with the quantity as typed. */
interface ColourEntry {
  colour: string;
  /** Kept as text so a half-typed number stays half-typed. */
  boxes: string;
  variantCode: string | null;
  availableBoxes: number;
}

/** What the draft card is editing, and what a saved line holds — one shape. */
interface DraftLine {
  key: string;
  productId: string;
  productName: string;
  code: string | null;
  alias: string | null;
  sin: string | null;
  size: string | null;
  grade: string | null;
  productType: string | null;
  weightKg: number | null;
  packaging: string;
  /** The rupee text as typed; see `ratePaise`. `null` is a rate this person may not see. */
  rateText: string | null;
  /**
   * False when this line deliberately carries no price — quoted later.
   *
   * Distinct from a blank `rateText`, which is a rate nobody has got to yet and
   * which the server fills from the catalogue. This one sends `rateUnset` and
   * the line stays priceless all the way to the docket.
   */
  rateOn: boolean;
  /**
   * True once somebody has typed in the rate cell.
   *
   * Which is the difference between a rate the line *derived* and a rate a
   * person *decided*. Changing the party re-rates every untouched line and must
   * leave the decided ones exactly where they were, or choosing a party
   * silently overwrites somebody's negotiation.
   */
  rateTouched: boolean;
  fromPartyVariant: boolean;
  notes: string;
  colours: ColourEntry[];
  /** Where the line goes back to when the draft is a `Modify` of a saved one. */
  at: number | null;
  isEdit: boolean;
}

/** Where a line's opening rate came from, for the note under the field. */
interface RateOrigin {
  /** In paise, or null when this person may not see rates at all. */
  rate: number | null;
  note: string;
  fromPartyVariant: boolean;
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

function boxesOf(line: DraftLine): number {
  return line.colours.reduce((sum, entry) => sum + (Number(entry.boxes) || 0), 0);
}

/**
 * The line's rate in paise, or null when there is no rate to show.
 *
 * The draft holds the rupee text somebody typed rather than the paise number,
 * because a controlled field rendered back from paise cannot be typed into: the
 * "." in "12." parses to 12, the state does not change, and React restores the
 * field to "12" as the key is pressed — so ₹12.50 is entered as ₹1250.
 *
 * A blank or unparseable field is unknown rather than free, the same rule the
 * order total follows.
 */
function ratePaise(line: { rateText: string | null }): number | null {
  if (line.rateText === null || !line.rateText.trim()) return null;
  const rupees = Number(line.rateText);
  return Number.isFinite(rupees) ? Math.round(rupees * 100) : null;
}

/** What a line is worth, or null when it has no rate to be worth anything at. */
function lineTotal(line: DraftLine): number | null {
  if (!line.rateOn) return null;
  const rate = ratePaise(line);
  return rate === null ? null : Math.round(rate * boxesOf(line));
}

/** A short, local date for the "last used" note — never a full timestamp. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function AddLeadScreen({ view, canEditRate, onSaved, onCancel }: Props) {
  const colourHex = useColourHex(view.optionLists);

  const [partyId, setPartyId] = useState('');
  const [partyQuery, setPartyQuery] = useState('');
  const [partyOpen, setPartyOpen] = useState(false);
  const [partySel, setPartySel] = useState(0);
  const [partyRows, setPartyRows] = useState<Party[]>([]);
  const [partyDrawerOpen, setPartyDrawerOpen] = useState(false);

  const [sourcePlatform, setSourcePlatform] = useState('');
  const [otherSource, setOtherSource] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [notes, setNotes] = useState('');
  const [customFields, setCustomFields] = useState<Record<string, unknown>>({});

  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [variantRows, setVariantRows] = useState<ProductVariantPick[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [draft, setDraft] = useState<DraftLine | null>(null);
  /** Which panel rows are expanded, ticked, and what is filtering them. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, true>>({});
  const [lineQuery, setLineQuery] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const partyRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLSelectElement>(null);
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
  /** Every variant row this session has seen, so a saved line keeps its codes. */
  const seenVariants = useRef(new Map<string, ProductVariantPick>());
  /** Parties the picker has fetched, so a chosen one survives the term changing. */
  const seenParties = useRef(new Map<string, Party>());

  /*
   * The sidebar has no New-lead item of its own — it is not a module, it is a
   * thing you are doing to the Leads module. Registering it as Leads' nested
   * entry is what puts Leads back under the cursor while the form is open;
   * without it nothing at all was highlighted and the header read "Office
   * Panel".
   */
  useSubNav('addLead', {
    parentId: 'leads',
    items: [{ id: 'addLead.new', label: t('lead.add.title'), icon: 'leads' }],
    activeId: 'addLead.new',
  });

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

  const gradeOptions = useMemo(
    () =>
      view.optionLists.filter(
        (option: OptionListItem) => option.listKey === 'line.grade' && option.isActive,
      ),
    [view.optionLists],
  );

  /*
   * The enquiry came from somewhere, and on this screen it always came from the
   * first thing in the list until somebody says otherwise. A blank required
   * answer on a form nobody has touched reads as a fault rather than a question.
   */
  useEffect(() => {
    setSourcePlatform((current) => current || (sourceOptions[0]?.value ?? ''));
  }, [sourceOptions]);

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

  /** The party's own variants, which are also what makes the "own rates" badge true. */
  const variantsForParty = useMemo(
    () =>
      new Map(
        view.partyVariants
          .filter((variant) => variant.partyId === partyId)
          .map((variant): [string, PartyProductVariant] => [variant.productId, variant]),
      ),
    [partyId, view.partyVariants],
  );
  const partyWiseMode = variantsForParty.size > 0;

  /*
   * A rate this role may not see is absent on every product alike, so the whole
   * money column goes with it rather than rendering a confident zero.
   */
  const canSeeRates = view.permissions.includes('field.saleRate.view');

  /**
   * The last rate this party actually paid for each product, newest first.
   *
   * Read out of the leads and orders already on the snapshot rather than asked
   * of the Master: it is the same data the Master would answer from, it costs
   * no request, and it is still right with the link down. A record whose rate
   * is absent — this role may not see rates — contributes nothing rather than
   * a zero.
   */
  const lastRateFor = useMemo(() => {
    const best = new Map<string, { rate: number; at: string }>();

    const consider = (record: Lead | Order): void => {
      if (record.partyId !== partyId) return;
      for (const item of record.items) {
        if (item.rate === undefined || item.rate === null) continue;
        const previous = best.get(item.productId);
        if (previous && previous.at >= record.createdAt) continue;
        best.set(item.productId, { rate: item.rate, at: record.createdAt });
      }
    };

    for (const lead of view.leads) consider(lead);
    for (const order of view.orders) consider(order);
    return best;
  }, [partyId, view.leads, view.orders]);

  /** Stock rows for one product, from the snapshot and from anything searched. */
  const coloursFor = useCallback(
    (productId: string): ColourEntry[] => {
      const byColour = new Map<string, ColourEntry>();

      for (const level of view.stock) {
        if (level.productId !== productId) continue;
        byColour.set(level.colour, {
          colour: level.colour,
          boxes: '',
          variantCode: level.variantCode,
          availableBoxes: level.availableBoxes,
        });
      }

      // Anything the Master answered with that this panel's snapshot page does
      // not hold — a catalogue past `SNAPSHOT_LIMIT` still has to be sellable.
      for (const row of seenVariants.current.values()) {
        if (row.productId !== productId || byColour.has(row.colour)) continue;
        byColour.set(row.colour, {
          colour: row.colour,
          boxes: '',
          variantCode: row.variantCode,
          availableBoxes: row.availableBoxes,
        });
      }

      return [...byColour.values()].sort((a, b) => a.colour.localeCompare(b.colour));
    },
    [view.stock],
  );

  function rateOriginFor(productId: string): RateOrigin {
    if (!canSeeRates) return { rate: null, note: '', fromPartyVariant: false };

    const last = lastRateFor.get(productId);
    if (last) {
      return {
        rate: last.rate,
        note: t('lead.add.draft.rateLast', { date: shortDate(last.at) }),
        fromPartyVariant: false,
      };
    }

    const variant = variantsForParty.get(productId);
    if (variant?.rate !== undefined && variant?.rate !== null) {
      return { rate: variant.rate, note: t('lead.add.draft.rateParty'), fromPartyVariant: true };
    }

    const product = view.products.find((candidate) => candidate.id === productId);
    const rate = product?.rate ?? null;
    return { rate, note: t('lead.add.draft.rateCatalogue'), fromPartyVariant: false };
  }

  // --- Party search -------------------------------------------------------

  const partyTerm = useDebounced(partyQuery, 200);

  useEffect(() => {
    if (partyId) return;
    let cancelled = false;

    void (async () => {
      try {
        const page = await api.pick<Party>('party', { term: partyTerm });
        if (cancelled) return;
        for (const row of page.items) seenParties.current.set(row.id, row);
        setPartyRows(page.items.filter((party) => !readOnlyParties.has(party.id)).slice(0, 6));
      } catch {
        // The picker answers from the cached snapshot when the link is down, so
        // a failure here is a real one — and an empty list says so without a
        // banner over a field somebody is still typing in.
        if (!cancelled) setPartyRows([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [partyTerm, partyId, readOnlyParties]);

  const partyPick = partyRows.length ? Math.min(partySel, partyRows.length - 1) : 0;

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

  // --- Product search -----------------------------------------------------

  const term = useDebounced(query, 200);

  useEffect(() => {
    if (!term.trim() || draft) {
      setVariantRows([]);
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        const page = await api.pick<ProductVariantPick>('variant', { term });
        if (cancelled) return;
        for (const row of page.items)
          seenVariants.current.set(`${row.productId}|${row.colour}`, row);
        setVariantRows(page.items.slice(0, 7));
      } catch {
        if (!cancelled) setVariantRows([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [term, draft]);

  const variantPick = variantRows.length ? Math.min(sel, variantRows.length - 1) : 0;

  /**
   * Re-rate the lines nobody has priced by hand.
   *
   * Choosing a party changes what every line on the voucher costs. It used to
   * change only the lines added *after* the switch, so a voucher built before
   * the party was chosen quietly quoted catalogue prices — the kind of wrong
   * that reaches a customer. Only untouched lines move: a rate somebody typed
   * is a decision, and so is a rate somebody switched off.
   */
  useEffect(() => {
    setLines((current) =>
      current.map((line) => {
        if (line.rateTouched || !line.rateOn) return line;
        const origin = rateOriginFor(line.productId);
        return {
          ...line,
          rateText: origin.rate === null ? null : String(origin.rate / 100),
          fromPartyVariant: origin.fromPartyVariant,
        };
      }),
    );
    // `rateOriginFor` closes over exactly these; listing the function instead
    // would re-run this on every render and undo somebody's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId, lastRateFor, variantsForParty, view.products]);

  // --- Draft --------------------------------------------------------------

  function openDraft(row: ProductVariantPick): void {
    const origin = rateOriginFor(row.productId);
    const variant = variantsForParty.get(row.productId) ?? null;
    const known = coloursFor(row.productId).find((entry) => entry.colour === row.colour);

    setDraft({
      key: `draft-${row.productId}-${row.colour}`,
      productId: row.productId,
      productName: variant?.productName ?? row.productName,
      code: row.productCode,
      alias: variant?.alias ?? row.alias,
      sin: variant?.sin ?? row.sin,
      size: variant?.size ?? row.size,
      grade: variant?.grade ?? row.grade,
      productType: variant?.productType ?? row.productType,
      weightKg: variant?.weightKg ?? row.weightKg,
      // Left empty on purpose (§3.2). The party's saved packaging is offered
      // below as a suggestion, never applied.
      packaging: '',
      rateText: origin.rate === null ? null : String(origin.rate / 100),
      rateOn: true,
      rateTouched: false,
      fromPartyVariant: origin.fromPartyVariant,
      notes: '',
      colours: [
        known ?? {
          colour: row.colour,
          boxes: '',
          variantCode: row.variantCode,
          availableBoxes: row.availableBoxes,
        },
      ],
      at: null,
      isEdit: false,
    });
    setQuery('');
    setSel(0);
    setVariantRows([]);

    // The rest of this product's colours, so "add another colour" is complete
    // even for a product past this panel's snapshot page.
    void (async () => {
      try {
        const page = await api.pick<ProductVariantPick>('variant', { term: row.productCode });
        for (const found of page.items) {
          seenVariants.current.set(`${found.productId}|${found.colour}`, found);
        }
        // Re-render so the newly known colours reach the dropdown.
        setVariantRows([]);
      } catch {
        // Nothing to add — the colour that was picked is already on the draft.
      }
    })();
  }

  function patchDraft(patch: Partial<DraftLine>): void {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function setColourBoxes(colour: string, boxes: string): void {
    setDraft((current) =>
      current
        ? {
            ...current,
            colours: current.colours.map((entry) =>
              entry.colour === colour ? { ...entry, boxes } : entry,
            ),
          }
        : current,
    );
  }

  function draftIsReady(candidate: DraftLine): boolean {
    const filled = candidate.colours.filter((entry) => Number(entry.boxes) > 0);
    if (!candidate.packaging.trim() || filled.length === 0) return false;
    if (!canSeeRates || !candidate.rateOn) return true;
    return (ratePaise(candidate) ?? 0) > 0;
  }

  function saveDraft(): void {
    if (!draft || !draftIsReady(draft)) return;

    const filled = draft.colours.filter((entry) => Number(entry.boxes) > 0);
    const line: DraftLine = {
      ...draft,
      key: draft.isEdit
        ? draft.key
        : `line-${draft.productId}-${lines.length}-${draft.colours.length}`,
      colours: filled,
      at: null,
      isEdit: false,
    };

    setLines((current) => {
      const next = current.slice();
      if (draft.at === null) next.push(line);
      else next.splice(Math.min(draft.at, next.length), 0, line);
      return next;
    });
    setDraft(null);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }

  function modifyLine(line: DraftLine, index: number): void {
    setLines((current) => current.filter((candidate) => candidate.key !== line.key));
    setOpenKey(null);
    forget(line.key);
    setDraft({ ...line, at: index, isEdit: true });
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
   * Matched on the same words the row shows — codes, product, system code and
   * every colour on the line — so what somebody reads is what they can search.
   */
  const matchedLines = panelTerm
    ? lines.filter((line) =>
        [
          line.colours.map((entry) => entry.variantCode ?? '').join(' '),
          line.productName,
          line.sin ?? '',
          line.code ?? '',
          line.colours.map((entry) => entry.colour).join(' '),
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

  // --- Save ---------------------------------------------------------------

  const isOther = sourcePlatform === 'other';
  const resolvedSource = isOther ? otherSource.trim() || sourcePlatform : sourcePlatform;

  async function save(): Promise<void> {
    if (!partyId) {
      setError(t('lead.add.errors.partyRequired'));
      return;
    }
    if (lines.length === 0) {
      setError(t('lead.add.errors.noProducts'));
      return;
    }
    if (draft) {
      setError(t('lead.add.errors.draftOpen'));
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const items: LineItemInput[] = lines.map((line, index) => ({
        productId: line.productId,
        productName: line.productName,
        alias: line.alias,
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
        /*
         * Three states, not two. A rate this role cannot see is sent as no key
         * at all so the server fills it from the catalogue exactly as it would
         * have; a rate switched off is sent as `rateUnset`, which stops that
         * fallback dead; anything else is what was typed.
         */
        ...(canSeeRates
          ? line.rateOn
            ? { rate: ratePaise(line) }
            : { rate: null, rateUnset: true }
          : {}),
        quantities: line.colours
          .filter((entry) => entry.colour.trim() && Number(entry.boxes) > 0)
          .map((entry) => ({
            colour: entry.colour.trim(),
            quantity: Number(entry.boxes),
            variantCode: entry.variantCode,
          })),
      }));

      const queued = await api.createLead({
        partyId,
        sourcePlatform: resolvedSource || null,
        followUpDate: followUpDate || null,
        partyWiseMode,
        notes: notes.trim() || null,
        customFields,
        items,
      });

      onSaved(queued.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('lead.add.errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  const totalBoxes = lines.reduce((sum, line) => sum + boxesOf(line), 0);
  /**
   * The order total, or null when any line's rate is hidden from this person.
   *
   * `rate ?? 0` treated a rate this role may not see as free, so a rate-blind
   * user was shown a confident ₹0.00 total in perfect good faith — the exact
   * failure the masking rule exists to prevent (`roles-ui.md` §6). A line whose
   * rate was deliberately switched off is a different matter: it is genuinely
   * worth nothing yet, and contributes nothing rather than voiding the total.
   */
  const total = lines.reduce<number | null>((sum, line) => {
    if (!line.rateOn) return sum;
    const amount = lineTotal(line);
    return sum === null || amount === null ? null : sum + amount;
  }, 0);

  const ready = Boolean(partyId) && lines.length > 0 && !draft;
  const doneSteps = (partyId ? 1 : 0) + (resolvedSource ? 1 : 0) + (lines.length > 0 ? 1 : 0);

  const statusLine = !partyId
    ? t('lead.add.status.party')
    : lines.length === 0
      ? t('lead.add.status.products')
      : draft
        ? t('lead.add.status.draft')
        : t('lead.add.savingHint');

  useCommand('record.save', busy ? null : () => void save());

  /*
   * Enter forward, Escape back — one field at a time, down the whole column:
   * party, source, follow-up, the product search, the draft card's packaging,
   * grade, rate and quantities, then the notes and any custom fields.
   *
   * A select opens its list on Enter instead of skipping past it, and the
   * native popup then owns the arrows and its own Enter; the Enter after it
   * closes moves on. Both halves are in `useEnterToAdvance`.
   */
  useEnterToAdvance(formRef);
  useEscapeToPrevious(formRef);

  /*
   * Resetting throws away a lead somebody is part-way through typing, so it asks
   * first — but only when there is something to lose.
   */
  useResetGuard(
    partyId || lines.length > 0 || draft || notes.trim()
      ? () => window.confirm(t('lead.add.discardConfirm'))
      : null,
  );

  const leadFieldDefinitions = view.customFields.filter(
    (definition: CustomFieldDefinition) => definition.entity === 'lead',
  );

  const summary =
    lines.length === 0
      ? t('lead.add.summary.empty')
      : t(lines.length === 1 ? 'lead.add.summary.countOne' : 'lead.add.summary.count', {
          count: lines.length,
          boxes: totalBoxes,
        });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-20)' }}>
      {/* --- Header ------------------------------------------------------ */}

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
                          setPartySel(Math.min(partyPick + 1, Math.max(0, partyRows.length - 1)));
                        }
                        if (event.key === 'ArrowUp') {
                          event.preventDefault();
                          setPartySel(Math.max(0, partyPick - 1));
                        }
                        if (
                          (event.key === 'Enter' || event.key === 'Tab') &&
                          partyRows[partyPick]
                        ) {
                          event.preventDefault();
                          chooseParty(partyRows[partyPick]);
                        }
                      }}
                    />
                    {partyOpen && (
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
                   */}
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

          {/* --- Products ----------------------------------------------------- */}

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

            {/* The search field, or the product it turned into. */}
            <div style={{ position: 'relative' }}>
              {draft ? (
                <div className="ob-picked">
                  <span
                    className="ob-mono ob-body-strong"
                    style={{ fontSize: rem(14), color: 'var(--accent)' }}
                  >
                    {draft.colours.map((entry) => entry.variantCode ?? entry.colour).join(', ')}
                  </span>
                  <span className="ob-body-strong">{draft.productName}</span>
                  <span className="ob-mono ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                    {draft.sin ?? draft.code ?? ''}
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-6)' }}>
                    {draft.colours.map((entry) => (
                      <Swatch
                        key={entry.colour}
                        colour={entry.colour}
                        hex={colourHex(entry.colour)}
                        dotOnly
                      />
                    ))}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }} />
                  <Button variant="primary" disabled={!draftIsReady(draft)} onClick={saveDraft}>
                    {draft.isEdit
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
                <Input
                  ref={searchRef}
                  value={query}
                  placeholder={t('lead.add.products.codePlaceholder')}
                  aria-label={t('lead.add.products.searchLabel')}
                  autoComplete="off"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSel(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setSel(Math.min(variantPick + 1, Math.max(0, variantRows.length - 1)));
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setSel(Math.max(0, variantPick - 1));
                    }
                    if (
                      (event.key === 'Enter' || event.key === 'Tab') &&
                      variantRows[variantPick]
                    ) {
                      event.preventDefault();
                      openDraft(variantRows[variantPick]);
                    }
                  }}
                />
              )}

              {!draft && query.trim() !== '' && (
                <div role="listbox" className="ob-suggest">
                  <div
                    className="ob-suggest-row ob-eyebrow"
                    style={{
                      gridTemplateColumns: SUGGEST_GRID,
                      color: 'var(--fg-tertiary)',
                    }}
                  >
                    <span>{t('lead.add.products.col.code')}</span>
                    <span>{t('lead.add.products.col.product')}</span>
                    <span>{t('lead.add.products.col.colour')}</span>
                    <span style={{ textAlign: 'right' }}>{t('lead.add.products.col.free')}</span>
                  </div>
                  {variantRows.map((row, index) => (
                    <button
                      key={`${row.productId}|${row.colour}`}
                      type="button"
                      className="ob-suggest-row"
                      style={{
                        gridTemplateColumns: SUGGEST_GRID,
                        background: index === variantPick ? 'var(--bg-selected)' : undefined,
                      }}
                      onMouseEnter={() => setSel(index)}
                      onClick={() => openDraft(row)}
                    >
                      <span
                        className="ob-mono ob-body-strong"
                        style={{
                          fontSize: rem(14),
                          color: index === variantPick ? 'var(--accent)' : undefined,
                        }}
                      >
                        {row.variantCode ?? row.productCode}
                      </span>
                      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span className="ob-ellipsis">{row.productName}</span>
                        <span className="ob-mono ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                          {[
                            row.sin,
                            row.rate === undefined
                              ? null
                              : `${formatMoney(row.rate ?? null)}/${t('unit.box')}`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <Swatch colour={row.colour} hex={colourHex(row.colour)} />
                      <span
                        className="ob-small"
                        style={{
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          color: row.availableBoxes <= 0 ? 'var(--state-offline)' : undefined,
                        }}
                      >
                        {row.availableBoxes}
                      </span>
                    </button>
                  ))}
                  {variantRows.length === 0 && (
                    <p className="ob-small" style={{ margin: 0, padding: 'var(--s-8)' }}>
                      {t('lead.add.products.noHit')}
                    </p>
                  )}
                </div>
              )}

              <p
                className="ob-micro"
                style={{ margin: `${rem(7)} 0 0`, color: 'var(--fg-tertiary)' }}
              >
                {draft ? t('lead.add.products.pickedHint') : t('lead.add.products.codeHint')}
              </p>
            </div>

            {/* The card one product is built in before it joins the lead. */}
            {draft && (
              <DraftCard
                draft={draft}
                canEditRate={canEditRate}
                canSeeRates={canSeeRates}
                ready={draftIsReady(draft)}
                packagingOptions={packagingOptions}
                gradeOptions={gradeOptions}
                suggestedPackaging={variantsForParty.get(draft.productId)?.packaging ?? null}
                rateOrigin={rateOriginFor(draft.productId)}
                colourHex={colourHex}
                moreColours={coloursFor(draft.productId).filter(
                  (entry) => !draft.colours.some((used) => used.colour === entry.colour),
                )}
                onPatch={patchDraft}
                onBoxes={setColourBoxes}
                onAddColour={(entry) => patchDraft({ colours: [...draft.colours, entry] })}
                onRemoveColour={(colour) =>
                  patchDraft({
                    colours:
                      draft.colours.length === 1
                        ? draft.colours
                        : draft.colours.filter((entry) => entry.colour !== colour),
                  })
                }
                onSave={saveDraft}
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
            <CustomFields
              definitions={leadFieldDefinitions}
              values={customFields}
              onChange={setCustomFields}
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
              title="Ctrl+S"
              onClick={() => void save()}
            >
              {busy ? t('lead.add.saving') : t('lead.add.save')}
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
            <span style={{ flex: 1 }} />
            <span className="ob-title" style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>
              {formatMoney(total)}
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

      <PartyDrawer
        open={partyDrawerOpen}
        onClose={() => setPartyDrawerOpen(false)}
        onCreated={(party: CreatedParty) => {
          seenParties.current.set(party.id, party as unknown as Party);
          setPartyId(party.id);
          setPartyDrawerOpen(false);
          window.setTimeout(() => searchRef.current?.focus(), 0);
        }}
        onError={setError}
      />
    </div>
  );
}

// --- Pieces ---------------------------------------------------------------

const SUGGEST_GRID = `${rem(70)} minmax(0, 1fr) minmax(0, 0.6fr) ${rem(74)}`;
const COLOUR_GRID = `${rem(70)} minmax(0, 1fr) ${rem(120)} ${rem(110)} ${rem(30)}`;

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

function Swatch({
  colour,
  hex,
  dotOnly = false,
}: {
  colour: string;
  hex: string | undefined;
  dotOnly?: boolean;
}) {
  const dot = (
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
  );

  if (dotOnly) return <span title={colour}>{dot}</span>;

  return (
    <span
      className="ob-small"
      style={{ display: 'inline-flex', alignItems: 'center', gap: rem(7), minWidth: 0 }}
    >
      {dot}
      <span className="ob-ellipsis">{colour}</span>
    </span>
  );
}

/**
 * One product already on the lead, as the panel draws it.
 *
 * Collapsed it is one line — codes, name, boxes, money — so twenty products can
 * be scanned for the one that is wrong. Opened it shows every colour with what
 * was ordered against what is free, the packaging, grade and rate, and the two
 * things that can be done about it.
 *
 * The tick box sits outside the toggle rather than inside it: expanding a row
 * to read it must not select it for removal.
 */
function LeadLine({
  line,
  open,
  checked,
  colourHex,
  onToggle,
  onCheck,
  onModify,
  onRemove,
}: {
  line: DraftLine;
  open: boolean;
  checked: boolean;
  colourHex: (name: string) => string | undefined;
  onToggle: () => void;
  onCheck: () => void;
  onModify: () => void;
  onRemove: () => void;
}) {
  const over = line.colours.some((entry) => Number(entry.boxes) > entry.availableBoxes);
  const boxes = boxesOf(line);
  const amount = lineTotal(line);

  const meta = [
    line.packaging.trim() || t('lead.add.line.noPackaging'),
    line.grade ?? '—',
    line.rateOn ? `${formatMoney(ratePaise(line))}/${t('unit.box')}` : t('lead.add.line.toQuote'),
  ].join(' · ');

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
            {line.colours.map((entry) => entry.variantCode ?? entry.colour).join(', ')}
          </span>
          <span className="ob-body-strong ob-ellipsis" style={{ flex: 1, minWidth: 0 }}>
            {line.productName}
          </span>
          {over && (
            <span
              className="ob-lead-short"
              title={t('lead.add.products.overFree')}
              aria-label={t('lead.add.products.overFree')}
            />
          )}
          <span
            className="ob-micro"
            style={{
              flex: 'none',
              color: 'var(--fg-tertiary)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {t('lead.add.line.boxesShort', { count: boxes })}
          </span>
          <span
            className="ob-small"
            style={{
              flex: 'none',
              fontWeight: line.rateOn ? 600 : 450,
              color: line.rateOn ? undefined : 'var(--fg-tertiary)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {line.rateOn ? formatMoney(amount) : t('lead.add.line.rateNa')}
          </span>
        </button>
      </div>

      {open && (
        <div className="ob-lead-line__body">
          {line.colours.map((entry) => {
            const short = Number(entry.boxes) > entry.availableBoxes;
            return (
              <span
                key={entry.colour}
                className="ob-small"
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}
              >
                <Swatch colour={entry.colour} hex={colourHex(entry.colour)} dotOnly />
                <span className="ob-mono ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                  {entry.variantCode ?? '—'}
                </span>
                <span className="ob-ellipsis" style={{ flex: 1, minWidth: 0 }}>
                  {entry.colour}
                </span>
                <span className="ob-body-strong" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {entry.boxes || '0'}
                </span>
                <span
                  className="ob-micro"
                  style={{
                    color: short ? 'var(--state-offline)' : 'var(--fg-tertiary)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {t('lead.add.line.ofFree', { free: entry.availableBoxes })}
                </span>
              </span>
            );
          })}

          <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
            {meta}
          </span>

          <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
            <Button variant="secondary" size="sm" onClick={onModify}>
              {t('lead.add.line.modify')}
            </Button>
            <Button variant="secondary" size="sm" onClick={onRemove}>
              {t('lead.add.products.remove')}
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}

function ColourRows({
  rows,
  colourHex,
  quantityHeader,
  freeHeader,
  codeHeader,
  colourHeader,
  onBoxes,
  onRemove,
  removeLabel,
}: {
  rows: ColourEntry[];
  colourHex: (name: string) => string | undefined;
  codeHeader: string;
  colourHeader: string;
  quantityHeader: string;
  freeHeader: string;
  onBoxes: (colour: string, boxes: string) => void;
  onRemove?: (colour: string) => void;
  removeLabel: (colour: string) => string;
}) {
  function step(entry: ColourEntry, delta: number): void {
    const current = Number(entry.boxes) || 0;
    onBoxes(entry.colour, String(Math.max(0, current + delta)));
  }

  return (
    <>
      <div
        className="ob-eyebrow"
        style={{
          display: 'grid',
          gridTemplateColumns: COLOUR_GRID,
          gap: `0 ${rem(12)}`,
          paddingBottom: rem(4),
          color: 'var(--fg-tertiary)',
        }}
      >
        <span>{codeHeader}</span>
        <span>{colourHeader}</span>
        <span style={{ textAlign: 'right' }}>{quantityHeader}</span>
        <span style={{ textAlign: 'right' }}>{freeHeader}</span>
        <span />
      </div>
      {rows.map((entry) => {
        const over = Number(entry.boxes) > entry.availableBoxes;
        return (
          <div
            key={entry.colour}
            style={{
              display: 'grid',
              gridTemplateColumns: COLOUR_GRID,
              gap: `0 ${rem(12)}`,
              alignItems: 'center',
              padding: `${rem(3)} 0`,
            }}
          >
            <span className="ob-mono ob-body-strong">{entry.variantCode ?? '—'}</span>
            <Swatch colour={entry.colour} hex={colourHex(entry.colour)} />
            <Input
              value={entry.boxes}
              inputMode="numeric"
              placeholder="0"
              invalid={over}
              aria-label={`${quantityHeader} — ${entry.colour}`}
              style={{ textAlign: 'right' }}
              onChange={(event) => onBoxes(entry.colour, event.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={(event) => {
                const by = event.shiftKey ? 10 : 1;
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  step(entry, by);
                }
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  step(entry, -by);
                }
              }}
            />
            <span
              className="ob-small"
              style={{
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
                color: over ? 'var(--state-offline)' : 'var(--fg-secondary)',
              }}
            >
              {entry.availableBoxes}
            </span>
            {onRemove ? (
              <button
                type="button"
                className="ob-btn ob-btn--ghost"
                aria-label={removeLabel(entry.colour)}
                style={{ padding: 0, minWidth: rem(24) }}
                onClick={() => onRemove(entry.colour)}
              >
                ✕
              </button>
            ) : (
              <span />
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * The card one product is built in before it joins the lead.
 *
 * Nothing here is on the voucher yet, which is the point: packaging, a rate and
 * at least one quantity are all decided in one place, and Add is refused until
 * they are. The hint along the bottom says which of the three is missing rather
 * than making somebody guess at a disabled button.
 */
function DraftCard({
  draft,
  canEditRate,
  canSeeRates,
  ready,
  packagingOptions,
  gradeOptions,
  suggestedPackaging,
  rateOrigin,
  colourHex,
  moreColours,
  onPatch,
  onBoxes,
  onAddColour,
  onRemoveColour,
  onSave,
}: {
  draft: DraftLine;
  canEditRate: boolean;
  canSeeRates: boolean;
  ready: boolean;
  packagingOptions: OptionListItem[];
  gradeOptions: OptionListItem[];
  suggestedPackaging: string | null;
  rateOrigin: RateOrigin;
  colourHex: (name: string) => string | undefined;
  moreColours: ColourEntry[];
  onPatch: (patch: Partial<DraftLine>) => void;
  onBoxes: (colour: string, boxes: string) => void;
  onAddColour: (entry: ColourEntry) => void;
  onRemoveColour: (colour: string) => void;
  onSave: () => void;
}) {
  const filled = draft.colours.filter((entry) => Number(entry.boxes) > 0);
  const rate = ratePaise(draft);
  const preview =
    rate === null ? null : rate * filled.reduce((sum, entry) => sum + Number(entry.boxes), 0);

  const hint = !draft.packaging.trim()
    ? t('lead.add.draft.hintPackaging')
    : filled.length === 0
      ? t('lead.add.draft.hintQuantity')
      : !canSeeRates || !draft.rateOn
        ? t('lead.add.draft.hintNoRate')
        : (rate ?? 0) > 0
          ? t('lead.add.draft.hintTotal', { amount: formatMoney(preview) })
          : t('lead.add.draft.hintRateOrOff');

  function step(delta: number): void {
    const current = Number(draft.rateText ?? '0') || 0;
    onPatch({ rateText: String(Math.max(0, current + delta)), rateTouched: true });
  }

  /*
   * The grade the line already carries has to stay pickable even when nobody
   * has put it on the list — it came off the product, and a select that cannot
   * show its own value silently rewrites the line the moment it renders.
   */
  const gradeValues = [
    ...gradeOptions.map((option) => ({ value: option.value, label: option.label })),
    ...(draft.grade && !gradeOptions.some((option) => option.value === draft.grade)
      ? [{ value: draft.grade, label: draft.grade }]
      : []),
  ];

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
          {draft.isEdit ? t('lead.add.draft.editing') : t('lead.add.draft.new')}
        </span>
      </div>

      <div style={{ padding: `${rem(12)} ${rem(14)} ${rem(14)}` }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `minmax(0, 1fr) minmax(0, 1fr) minmax(${rem(160)}, ${rem(220)})`,
            gap: 'var(--s-12)',
            marginBottom: 'var(--s-12)',
          }}
        >
          <label className="ob-small" style={{ display: 'block', color: 'var(--fg-secondary)' }}>
            {t('lead.add.draft.packaging')}{' '}
            <span style={{ color: 'var(--state-offline)' }}>{t('lead.add.step.required')}</span>
            {/* Typed or picked, one control — `line.packaging` ships unseeded,
                so a shop that has never filled it in must still be able to
                type, and one that has should not have to.

                `autoFocus` because the card has just replaced the search box
                somebody was typing in: without it the caret lands on the body
                and the Enter walk has nowhere to start from. Packaging is the
                right place to start anyway — it is the one field a picked code
                deliberately leaves empty. */}
            <SuggestInput
              autoFocus
              value={draft.packaging}
              invalid={!draft.packaging.trim()}
              placeholder={t('lead.add.products.packagingPlaceholder')}
              optionsLabel={t('lead.add.draft.showOptions', {
                field: t('lead.add.draft.packaging'),
              })}
              options={packagingOptions.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              onChange={(next) => onPatch({ packaging: next })}
            />
            {suggestedPackaging && !draft.packaging && (
              <Button
                variant="ghost"
                size="sm"
                style={{ marginTop: rem(4) }}
                onClick={() => onPatch({ packaging: suggestedPackaging })}
              >
                {t('lead.add.products.useSuggested', { value: suggestedPackaging })}
              </Button>
            )}
          </label>

          <label className="ob-small" style={{ display: 'block', color: 'var(--fg-secondary)' }}>
            {t('lead.add.draft.grade')}
            {/* The same control as packaging beside it: a grade is a short word
                from a short list, and the two sitting in one row must not be a
                dropdown and a text box. */}
            <SuggestInput
              value={draft.grade ?? ''}
              optionsLabel={t('lead.add.draft.showOptions', {
                field: t('lead.add.draft.grade'),
              })}
              options={gradeValues.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              onChange={(next) => onPatch({ grade: next || null })}
            />
          </label>

          {canSeeRates && (
            <div className="ob-small" style={{ color: 'var(--fg-secondary)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
                <span>{t('lead.add.draft.ratePerBox')}</span>
                <button
                  type="button"
                  className="ob-rate-switch"
                  role="switch"
                  aria-checked={draft.rateOn}
                  aria-label={t('lead.add.draft.rateSwitch')}
                  title={t('lead.add.draft.rateSwitchHint')}
                  disabled={!canEditRate}
                  onClick={() => onPatch({ rateOn: !draft.rateOn, rateTouched: true })}
                >
                  <span aria-hidden="true" className="ob-rate-switch__knob" />
                </button>
                <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                  {draft.rateOn ? t('lead.add.draft.rateOn') : t('lead.add.draft.rateOff')}
                </span>
              </span>

              {draft.rateOn ? (
                <span
                  className="ob-rate-field"
                  data-invalid={(rate ?? 0) > 0 ? undefined : 'true'}
                  style={{ marginTop: rem(4) }}
                >
                  <span
                    aria-hidden="true"
                    style={{ padding: `0 ${rem(2)} 0 ${rem(9)}`, color: 'var(--fg-tertiary)' }}
                  >
                    ₹
                  </span>
                  <input
                    value={draft.rateText ?? ''}
                    inputMode="numeric"
                    // A courtesy only — the Master ignores a rate from anybody
                    // without `field.saleRate.edit`, whatever the panel sends.
                    disabled={!canEditRate}
                    aria-label={t('lead.add.draft.ratePerBox')}
                    onChange={(event) =>
                      onPatch({
                        rateText: event.target.value.replace(/[^0-9.]/g, ''),
                        rateTouched: true,
                      })
                    }
                    onKeyDown={(event) => {
                      const by = event.shiftKey ? 10 : 1;
                      if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        step(by);
                      }
                      if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        step(-by);
                      }
                    }}
                  />
                </span>
              ) : (
                <span
                  className="ob-small"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    height: rem(32),
                    marginTop: rem(4),
                    padding: `0 ${rem(9)}`,
                    border: '1px dashed var(--line-strong)',
                    borderRadius: 'var(--r-sm)',
                    color: 'var(--fg-tertiary)',
                  }}
                >
                  {t('lead.add.draft.noRate')}
                </span>
              )}

              <span
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: rem(8),
                  marginTop: rem(4),
                }}
              >
                <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                  {draft.rateOn ? rateOrigin.note : t('lead.add.draft.rateLater')}
                </span>
                {draft.rateOn && rateOrigin.rate !== null && rate !== rateOrigin.rate && (
                  <button
                    type="button"
                    className="ob-btn ob-btn--ghost ob-micro"
                    style={{ padding: 0, color: 'var(--accent)', textDecoration: 'underline' }}
                    onClick={() =>
                      onPatch({
                        rateText: String((rateOrigin.rate ?? 0) / 100),
                        rateTouched: false,
                      })
                    }
                  >
                    {t('lead.add.draft.rateReset', { amount: formatMoney(rateOrigin.rate) })}
                  </button>
                )}
              </span>
            </div>
          )}
        </div>

        <div className="ob-eyebrow" style={{ color: 'var(--fg-tertiary)', marginBottom: rem(6) }}>
          {t('lead.add.draft.quantityTitle')}
        </div>

        <ColourRows
          rows={draft.colours}
          colourHex={colourHex}
          codeHeader={t('lead.add.products.col.code')}
          colourHeader={t('lead.add.products.col.colour')}
          quantityHeader={t('lead.add.draft.col.quantity')}
          freeHeader={t('lead.add.draft.col.freeToSell')}
          onBoxes={onBoxes}
          onRemove={draft.colours.length > 1 ? onRemoveColour : undefined}
          removeLabel={(colour) => t('lead.add.draft.removeColour', { colour })}
        />

        {moreColours.length > 0 && (
          <Select
            value=""
            className="ob-select--dashed"
            aria-label={t('lead.add.draft.addColour')}
            style={{ marginTop: 'var(--s-8)', maxWidth: rem(340) }}
            onChange={(event) => {
              const found = moreColours.find((entry) => entry.colour === event.target.value);
              if (found) onAddColour(found);
            }}
          >
            <option value="">{t('lead.add.draft.addColour')}</option>
            {moreColours.map((entry) => (
              <option key={entry.colour} value={entry.colour}>
                {t('lead.add.draft.colourOption', {
                  code: entry.variantCode ?? '—',
                  colour: entry.colour,
                  free: entry.availableBoxes,
                })}
              </option>
            ))}
          </Select>
        )}

        <div
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
          </span>
          <span style={{ flex: 1, minWidth: 0 }} />
          {/*
           * `data-field` makes this the last stop of the Enter walk through the
           * card, and Enter over a button is a click — so the last quantity,
           * Enter, Enter adds the product and puts the caret back in the search
           * box for the next one. While the draft is short of something the
           * button is disabled, which takes it out of the walk, and Enter runs
           * on past it to the notes instead.
           */}
          <Button variant="primary" data-field disabled={!ready} onClick={onSave}>
            {draft.isEdit ? t('lead.add.draft.saveChanges') : t('lead.add.draft.saveProduct')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
