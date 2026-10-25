/**
 * The panel's local view of the world (docs/LEAD_GENERATION_FLOW.md §2, §4.1).
 *
 * Two layers:
 *  · the last **snapshot** the Master sent, persisted to disk so a panel that
 *    restarts while the Master is off still has something to show;
 *  · an **optimistic overlay** built from the outbox, so a lead saved thirty
 *    seconds ago appears on the board immediately rather than when the link
 *    returns.
 *
 * The overlay is derived, never stored. Rebuilding it from the outbox on every
 * read means there is exactly one source of truth for "what have we not sent
 * yet" — a cached overlay that drifted from the queue would show staff a lead
 * that no longer exists, or hide one that does.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  CompanyFeatures,
  Lead,
  Order,
  LineItem,
  Mutation,
  Party,
  Product,
  SyncDeltaCursor,
  SyncSnapshot,
} from '@orderbook/shared';

import { paths } from '../config/paths.js';
import { createLogger } from '../lib/logger.js';
import { outboxRevision, pending } from './outbox.store.js';

const log = createLogger('local-store');

/**
 * Who is signed in at this PC, for the view. Injected by the sign-in module, like the sync
 * queue's acting user, so this module stays free of it.
 */
let viewer: () => string | null = () => null;
export function setViewer(provider: () => string | null): void {
  viewer = provider;
}

/**
 * Whether work queued by `author` may be drawn for the person signed in. Work with no
 * author is everybody's; anything else is its author's alone until the Master has
 * confirmed it, at which point it is in the snapshot and the Master's own party scoping
 * decides who sees it. Without this, a party or lead one person queued offline appeared
 * to whoever signed in next on the same PC.
 */
/** How many queued changes belong to the person signed in (or to nobody): what they are told is unsent. */
export async function viewerPendingCount(): Promise<number> {
  const signedIn = viewer();
  return (await pending()).filter((mutation) => shownTo(mutation.actorUserId, signedIn)).length;
}

/** Who is signed in at this PC right now, for the link's choice between a delta and a full snapshot. */
export function currentViewer(): string | null {
  return viewer();
}

function shownTo(author: string | null | undefined, signedIn: string | null): boolean {
  return !author || author === signedIn;
}

let snapshot: SyncSnapshot | null = null;
let cursor: SyncDeltaCursor | null = null;
let loaded = false;

/**
 * Bumped whenever the snapshot changes at all, including in place.
 *
 * `setSnapshot` stores the object it is handed and `applyChange` mutates that
 * same object, so identity is useless as a change signal — a memo keyed on the
 * reference would never invalidate. This counter is what the view memo keys on
 * instead.
 */
let revision = 0;

/**
 * Pending orders the Master has numbered whose permanent record has not reached
 * this snapshot yet, by temporary id.
 *
 * The push answer settles the queue entry the view drew the lead from, and the
 * Master's `data:changed` for the new record can land after it. Until it does,
 * the lead stays on screen under its temporary id (now carrying its number)
 * rather than vanishing for a moment from an open screen.
 */
const numbered = new Map<string, { mutation: Mutation; permanentId: string; poNumber?: string }>();

/** Called by the sync service just before it settles an accepted `lead.create`. */
export function holdNumbered(mutation: Mutation, permanentId: string, poNumber?: string): void {
  if (snapshot?.leads.some((lead) => lead.id === permanentId)) return;
  numbered.set(mutation.entityId, { mutation, permanentId, ...(poNumber ? { poNumber } : {}) });
  revision += 1;
}

/**
 * Store the snapshot, and — in the **same disk write** — the cursor that
 * describes it.
 *
 * The pair has to be written together. A cursor saved separately can survive a
 * crash that the snapshot it refers to did not, and the panel would then ask
 * for the changes after a position it never actually reached: it would look
 * caught up while silently missing every row in between.
 */
export async function setSnapshot(
  next: SyncSnapshot,
  nextCursor: SyncDeltaCursor | null = null,
): Promise<void> {
  snapshot = next;
  cursor = nextCursor;
  loaded = true;
  revision += 1;
  // A whole snapshot already holds every record the Master has numbered, or
  // the record is not one this person may see.
  numbered.clear();
  await persist();
}

export function getRawSnapshot(): SyncSnapshot | null {
  return snapshot;
}

/**
 * The company's switches as this panel last heard them, read from disk if they
 * are not already in memory.
 *
 * This exists for the one caller that runs **because** the Master cannot be
 * reached, so `getSetting` is not available to it by construction — the same
 * shape that made `security.signInLockoutAttempts` impossible. It works because
 * `restore()` is a bare `readFile` of a file the panel already owns: no socket,
 * no Master, and `master-connection.ts` already restores before it opens the
 * socket so a cold offline start has this too.
 *
 * `getRawSnapshot()` is deliberately not enough. After a panel restart memory
 * is empty and only the file survives, which is exactly the case a switch about
 * signing in offline has to answer correctly.
 *
 * `null` when the panel has never synced, or the file is unreadable. Every
 * caller resolves that to the setting's own declared fallback rather than
 * deciding for itself.
 */
export async function cachedFeatures(): Promise<CompanyFeatures | null> {
  const current = snapshot ?? (await restore());
  return current?.features ?? null;
}

/** What this panel already has, for the Master to answer with a delta. */
export function getCursor(): SyncDeltaCursor | null {
  return cursor;
}

/**
 * Note that the in-memory snapshot moved on, without writing to disk yet.
 *
 * Replayed and live changes mutate the snapshot object in place, so memory is
 * current while disk is stale — `persistCurrent` is what closes that, on a
 * trailing edge rather than once per row.
 */
export function noteApplied(seq: number | undefined, bootId: string | null): void {
  // Always bumped, even with no cursor to record: the view memo keys on this,
  // and a change applied against a Master too old to send a boot id still
  // changed what the browser should be shown.
  revision += 1;

  if (seq === undefined || !bootId) return;
  cursor = { bootId, lastSeq: seq };
}

/** Write whatever is in memory now. Debounced by the caller, not here. */
export async function persistCurrent(): Promise<void> {
  if (!snapshot) return;
  await persist();
}

/**
 * Restore the last snapshot from disk, so an offline start still has data.
 *
 * Concurrent callers share one read. `loaded = true` used to be set before the
 * `readFile` was awaited, so a second caller arriving in that window was told
 * the store was loaded and handed a `snapshot` still sitting at `null`. That
 * was harmless while every reader treated null as "no data yet"; it stopped
 * being harmless when `cachedFeatures()` below started answering a security
 * question from it.
 */
export async function restore(): Promise<SyncSnapshot | null> {
  // The in-flight read is checked FIRST. Checking `loaded` first is what the
  // first attempt at this fix did, and it left the window exactly where it
  // was — because the read still had to mark the store loaded, and a caller
  // arriving mid-read took that branch and got the `null` snapshot.
  if (restoring) return restoring;
  if (loaded) return snapshot;

  restoring = (async () => {
    try {
      return await readSnapshotFile();
    } finally {
      restoring = null;
    }
  })();

  return restoring;
}

let restoring: Promise<SyncSnapshot | null> | null = null;

async function readSnapshotFile(): Promise<SyncSnapshot | null> {
  try {
    const raw = await fs.readFile(paths().snapshotFile, 'utf8');
    const parsed = JSON.parse(raw) as StoredSnapshot | SyncSnapshot;

    // A file written before the cursor existed is a bare snapshot. Reading it
    // as one — rather than failing, or worse, treating its absent cursor as
    // position zero — is what lets a panel upgrade without re-syncing.
    if (isStored(parsed)) {
      snapshot = parsed.snapshot;
      cursor = parsed.cursor;
    } else {
      snapshot = parsed;
      cursor = null;
    }

    revision += 1;
    log.info('Restored the last snapshot from disk');
  } catch {
    snapshot = null;
    cursor = null;
  } finally {
    // Set once the read is over, never before it: `loaded` means "the file has
    // been consulted", and until it has, saying so hands out a null snapshot.
    loaded = true;
  }

  return snapshot;
}

/** The on-disk shape. `version` is what tells it apart from a bare snapshot. */
interface StoredSnapshot {
  version: 2;
  snapshot: SyncSnapshot;
  cursor: SyncDeltaCursor | null;
}

function isStored(value: StoredSnapshot | SyncSnapshot): value is StoredSnapshot {
  return (value as StoredSnapshot).version === 2;
}

/**
 * What the browser should render: the server's snapshot with everything still
 * queued applied on top.
 */
export type ViewOf = SyncSnapshot & {
  pendingCount: number;
  /**
   * The temporary ids of the parties the person signed in has queued and the Master has not
   * confirmed. The one reliable way to tell "my own new party" from a server row: a server row
   * can carry any `sync.hlc`, an empty one included.
   */
  ownQueuedPartyIds?: string[];
};

export async function getView(): Promise<ViewOf | null> {
  const base = snapshot ?? (await restore());
  if (!base) return null;

  const queued = await pending();

  /*
   * Memoised on the two revisions the view is derived from.
   *
   * This is built and stringified on every SSE push and on every
   * `/api/snapshot`, and rebuilding it is a full copy of three collections plus
   * a replay of the queue. Keyed on counters rather than on object identity
   * because `setSnapshot` stores the object it is handed and `applyChange`
   * mutates that same object — a memo keyed on the reference would never
   * invalidate.
   */
  const signedIn = viewer();
  const key = `${revision}:${outboxRevision()}:${signedIn ?? ''}`;
  if (memo && memo.key === key) return memo.view;

  const view =
    queued.length === 0 && numbered.size === 0
      ? { ...base, pendingCount: 0, ownQueuedPartyIds: [] }
      : buildView(base, queued, signedIn);
  memo = { key, view };
  return view;
}

let memo: { key: string; view: ViewOf } | null = null;

function buildView(base: SyncSnapshot, queued: Mutation[], signedIn: string | null): ViewOf {
  const view: SyncSnapshot = {
    ...base,
    leads: [...base.leads],
    parties: [...base.parties],
    products: [...base.products],
  };

  for (const [temporaryId, held] of numbered) {
    if (!shownTo(held.mutation.actorUserId, signedIn)) continue;
    if (base.leads.some((lead) => lead.id === held.permanentId)) {
      numbered.delete(temporaryId);
      continue;
    }
    // Still queued (the settle after the hold failed): the overlay below draws it.
    if (queued.some((mutation) => mutation.entityId === temporaryId)) continue;
    const lead = provisionalLead(view, held.mutation);
    view.leads = [held.poNumber ? { ...lead, poNumber: held.poNumber } : lead, ...view.leads];
  }

  // Only this person's own work is drawn, and only it is counted: a number of unsent changes
  // would otherwise say that somebody else queued something.
  const own = queued.filter((mutation) => shownTo(mutation.actorUserId, signedIn));
  for (const mutation of own) applyOverlay(view, mutation);

  return {
    ...view,
    pendingCount: own.length,
    ownQueuedPartyIds: own
      .filter((mutation) => mutation.kind === 'party.create')
      .map((mutation) => mutation.entityId),
  };
}

/**
 * Apply one queued mutation to the view.
 *
 * Only the kinds a person watches for are modelled.
 */
function applyOverlay(view: SyncSnapshot, mutation: Mutation): void {
  switch (mutation.kind) {
    case 'lead.create':
      view.leads = [provisionalLead(view, mutation), ...view.leads];
      return;

    case 'lead.update':
      view.leads = view.leads.map((lead) =>
        lead.id === mutation.entityId
          ? {
              ...lead,
              ...pickLeadFields(mutation),
              // The clocks the Master's merge will write for these fields, so a
              // second edit queued before this one is acknowledged sends this
              // one as its base instead of clashing with it.
              sync: {
                ...lead.sync,
                fieldHlc: { ...lead.sync.fieldHlc, ...stampedFields(mutation) },
              },
            }
          : lead,
      );
      return;

    case 'order.update':
      // The Dispatch note saved tick boxes (and the vehicle number): queued,
      // so the note screen reads them back before the Master answers.
      view.orders = view.orders.map((order) =>
        order.id === mutation.entityId
          ? {
              ...order,
              ...pickOrderFields(mutation),
              sync: {
                ...order.sync,
                fieldHlc: { ...order.sync.fieldHlc, ...stampedFields(mutation) },
              },
            }
          : order,
      );
      return;

    case 'lead.setStage': {
      const stageId = String(mutation.payload.stageId ?? '');
      const stage = findStage(view, stageId);
      view.leads = view.leads.map((lead) =>
        lead.id === mutation.entityId
          ? {
              ...lead,
              stageId,
              stageName: stage?.name ?? lead.stageName,
              stageSequence: stage?.sequence ?? lead.stageSequence,
            }
          : lead,
      );
      return;
    }

    case 'party.create':
      view.parties = [provisionalParty(mutation), ...view.parties];
      return;

    case 'product.create':
      view.products = [provisionalProduct(mutation), ...view.products];
      return;

    default:
      return;
  }
}

/**
 * Build a lead that looks like one the Master would have returned.
 *
 * Everything it needs is already local: the payload has the lines, the snapshot
 * has the party, the product catalogue and the pipeline. Building it here is
 * what lets the board render a queued lead identically to a synced one — the
 * only visible difference is the pending badge the UI adds from `sync.hlc`
 * being empty.
 */
function provisionalLead(view: SyncSnapshot, mutation: Mutation): Lead {
  const payload = mutation.payload as {
    partyId?: string;
    ownerId?: string;
    sourcePlatform?: string | null;
    followUpDate?: string | null;
    partyWiseMode?: boolean;
    notes?: string | null;
    customFields?: Record<string, unknown>;
    items?: Array<Record<string, unknown>>;
  };

  const party = view.parties.find((candidate) => candidate.id === payload.partyId);
  const pipeline = view.pipelines.find((candidate) => candidate.kind === 'lead');
  const stage = pipeline?.stages.find((candidate) => candidate.isDefault) ?? pipeline?.stages[0];

  const items = (payload.items ?? []).map((item, index) =>
    provisionalLine(
      view,
      mutation.entityId,
      item,
      index,
      payload.partyWiseMode ? payload.partyId : undefined,
    ),
  );

  return {
    id: mutation.entityId,
    tenantId: party?.tenantId ?? '',
    partyId: payload.partyId ?? '',
    partyName: party?.name ?? 'Unknown party',
    ownerId: payload.ownerId ?? '',
    ownerName: null,
    stageId: stage?.id ?? '',
    stageName: stage?.name ?? 'New',
    stageSequence: stage?.sequence ?? 1,
    sourcePlatform: payload.sourcePlatform ?? null,
    followUpDate: payload.followUpDate ?? null,
    partyWiseMode: payload.partyWiseMode ?? false,
    notes: payload.notes ?? null,
    customFields: payload.customFields ?? {},
    incomplete: false,
    missingFields: [],
    convertedOrderId: null,
    convertedAt: null,
    totalWeightKg:
      Math.round(items.reduce((sum, line) => sum + (line.lineWeightKg ?? 0), 0) * 1000) / 1000,
    linesWithoutWeight: items.filter((line) => line.lineWeightKg === null).length,
    sourcePanelId: null,
    createdByUserId: null,
    createdAt: mutation.createdAt,
    updatedAt: mutation.createdAt,
    // An empty `hlc` is the panel's marker for "not yet acknowledged"; the UI
    // reads it to draw the pending badge.
    sync: { version: 0, hlc: '', fieldHlc: {}, temporaryId: mutation.entityId },
    items,
    timeline: [],
  };
}

function provisionalLine(
  view: SyncSnapshot,
  parentId: string,
  item: Record<string, unknown>,
  index: number,
  /** Set when the lead is party-wise: the party's own record names the product, as on the Master. */
  variantPartyId?: string,
): LineItem {
  const product = view.products.find((candidate) => candidate.id === item.productId);
  // The product variant is where the code, the colour text and the weight
  // come from; the party's own record is where a party-wise name comes from.
  const variant = product?.variants.find((candidate) => candidate.id === item.variantId);
  const partyRecord = variantPartyId
    ? view.partyVariants.find(
        (candidate) =>
          candidate.partyId === variantPartyId && candidate.productId === item.productId,
      )
    : undefined;

  const quantity = Number(item.quantity) || 0;
  const weightKg = (item.weightKg as number | null | undefined) ?? variant?.weightKg ?? null;

  return {
    id: `${parentId}-line-${index}`,
    tenantId: product?.tenantId ?? '',
    parentType: 'lead',
    parentId,
    productId: String(item.productId ?? ''),
    variantId: String(item.variantId ?? ''),
    productName: String(item.productName ?? partyRecord?.productName ?? product?.name ?? ''),
    categoryName: (item.categoryName as string | null) ?? product?.categoryName ?? null,
    categoryCode: (item.categoryCode as string | null) ?? product?.categoryCode ?? null,
    brandName: (item.brandName as string | null) ?? product?.brand ?? null,
    alias: (item.alias as string | null) ?? partyRecord?.alias ?? product?.alias ?? null,
    code: (item.code as string | null) ?? variant?.code ?? null,
    variantLabel: (item.variantLabel as string | null) ?? variant?.label ?? null,
    colour: (item.colour as string | null) ?? null,
    size: (item.size as string | null) ?? partyRecord?.size ?? product?.size ?? null,
    weightKg,
    packaging: (item.packaging as string | null) ?? null,
    grade: (item.grade as string | null) ?? null,
    sequence: index + 1,
    fromPartyVariant: Boolean(item.fromPartyVariant),
    imagePath: null,
    notes: (item.notes as string | null) ?? null,
    quantity,
    lineWeightKg: weightKg === null ? null : Math.round(weightKg * quantity * 1000) / 1000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function provisionalParty(mutation: Mutation): Party {
  const payload = mutation.payload as Record<string, string | null>;

  return {
    id: mutation.entityId,
    tenantId: '',
    partyCode: 'pending',
    name: String(payload.name ?? ''),
    phone: payload.phone ?? null,
    altPhone: payload.altPhone ?? null,
    email: payload.email ?? null,
    addressLine1: payload.addressLine1 ?? null,
    addressLine2: payload.addressLine2 ?? null,
    city: payload.city ?? null,
    state: payload.state ?? null,
    pincode: payload.pincode ?? null,
    gstNumber: payload.gstNumber ?? null,
    notes: payload.notes ?? null,
    customFields: {},
    isActive: true,
    createdByUserId: null,
    createdAt: mutation.createdAt,
    updatedAt: mutation.createdAt,
    sync: { version: 0, hlc: '', fieldHlc: {}, temporaryId: mutation.entityId },
  };
}

function provisionalProduct(mutation: Mutation): Product {
  const payload = mutation.payload as Record<string, never>;
  const variants = Array.isArray(payload.variants)
    ? (payload.variants as Array<Record<string, unknown>>)
    : [];

  return {
    id: mutation.entityId,
    tenantId: '',
    name: String(payload.name ?? ''),
    alias: payload.alias ?? null,
    categoryId: String(payload.categoryId ?? ''),
    categoryName: String(payload.categoryName ?? ''),
    // Read through the category on the Master; a provisional row only knows
    // what its payload said.
    categoryCode: payload.categoryCode ?? null,
    brand: payload.categoryBrand ?? null,
    sortOrder: payload.sortOrder ?? null,
    size: payload.size ?? null,
    hasVariants: Boolean(payload.hasVariants),
    // The Master mints the variant ids; until it answers, these rows carry
    // placeholder ids for display. The lead screen leaves a still-provisional
    // product alone for exactly that reason.
    variants: variants.map((variant, index) => ({
      id: typeof variant.id === 'string' ? variant.id : `${mutation.entityId}-v${index + 1}`,
      productId: mutation.entityId,
      code: String(variant.code ?? ''),
      label: typeof variant.label === 'string' && variant.label ? variant.label : null,
      weightKg: typeof variant.weightKg === 'number' ? variant.weightKg : null,
      sequence: typeof variant.sequence === 'number' ? variant.sequence : index + 1,
      isActive: true,
    })),
    multiColour: Boolean(payload.multiColour),
    customFields: {},
    isActive: true,
    createdAt: mutation.createdAt,
    updatedAt: mutation.createdAt,
    sync: { version: 0, hlc: '', fieldHlc: {}, temporaryId: mutation.entityId },
    // A product created offline has no images yet — images are online-only
    // (`7-IMAGE-PIPELINE.md` port notes), so this can never be non-empty for
    // a still-provisional record.
    images: [],
  };
}

function pickOrderFields(mutation: Mutation): Partial<Order> {
  const payload = mutation.payload as Partial<Order>;
  const patch: Partial<Order> = {};

  for (const field of mutation.fields) {
    if (field in payload) {
      Object.assign(patch, { [field]: payload[field as keyof Order] });
    }
  }

  return patch;
}

function pickLeadFields(mutation: Mutation): Partial<Lead> {
  const payload = mutation.payload as Partial<Lead>;
  const patch: Partial<Lead> = {};

  for (const field of mutation.fields) {
    if (field in payload) {
      Object.assign(patch, { [field]: payload[field as keyof Lead] });
    }
  }

  return patch;
}

function stampedFields(mutation: Mutation): Record<string, string> {
  const stamped: Record<string, string> = {};
  for (const field of mutation.fields) stamped[field] = mutation.hlc;
  return stamped;
}

function findStage(view: SyncSnapshot, stageId: string) {
  for (const pipeline of view.pipelines) {
    const stage = pipeline.stages.find((candidate) => candidate.id === stageId);
    if (stage) return stage;
  }
  return null;
}

async function persist(): Promise<void> {
  if (!snapshot) return;

  const stored: StoredSnapshot = { version: 2, snapshot, cursor };
  await fs.mkdir(path.dirname(paths().snapshotFile), { recursive: true });
  await fs.writeFile(paths().snapshotFile, JSON.stringify(stored), { mode: 0o600 });
}

/** Test seam. */
export function resetLocalStore(): void {
  snapshot = null;
  cursor = null;
  loaded = false;
  revision += 1;
  memo = null;
  numbered.clear();
}
