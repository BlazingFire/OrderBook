# Lead Generation — Full Flow (as built)

Ported from the `lead-generation-full-flow.md` guide the owner supplied. That guide was written
against a different system — multi-tenant **SQLite/FTS5**, Electron (it refers to "the main
process, not the renderer"), and documents (`1-PLAIN-ENGLISH.md`, `2-PRODUCT-SPEC.md`,
`3-ARCHITECTURE.md`, `5-BUILD-ORDER.md`) that do not exist in this repository. This file is the
version that is actually true of OrderBook, and §11 lists every place the two deliberately differ
and why.

Read alongside `docs/schema/03-leads-orders-inventory.md` (tables) and
`docs/schema/06-tenancy-permissions-and-sync.md` (tenancy, permissions, offline sync).

---

## 1. Who can raise a lead

Any signed-in user whose role holds the `leads.create` permission. Three role tiers ship seeded:

| Role tier | Can create leads? |
|---|---|
| **Admin** | Yes — holds every permission |
| **Management** | Yes |
| **Office** | Yes — this is the day-to-day job |

Enforcement happens **twice**, as the guide requires:

1. In the Office Panel's **server process** (`office/src/`) — the trusted half of the panel, which
   the browser cannot bypass — before a mutation is even queued locally.
2. Again in the Master's mutation path, which is the only writer to the database.

A role without the permission gets a **403 naming the missing permission** (`ForbiddenError`
carries the permission key, and the message reads `Missing permission: leads.create`) rather than a
silently hidden button.

Every lead records who raised it in `created_by_user_id`, stamped by the service on write. It is
never accepted from the request body.

---

## 2. Where a lead is created

The **Leads module in the Office Panel**. The Master Panel's Leads & Orders screen is read-only
oversight — it has no create form. The Master's API does accept one (`POST /api/leads`, behind
`leads.create`), but no Master screen calls it.

A lead can be created **fully offline**. It is written to the Office Panel's durable local store
immediately, given a temporary ID, and pushed to the Master when the link returns. See §7.

---

## 3. Fields required to create a lead

### 3.1 Lead-level fields

| Field | Required? | Notes |
|---|---|---|
| `partyId` | **Required** | Picked from the Party list — the customer |
| `ownerId` | **Required** | Defaults to the creating user; reassignment needs `record.reassignOwner` |
| `sourcePlatform` | Configurable option list | WhatsApp / call / website / walk-in — company-defined rows in `option_lists`, not a hardcoded enum. The form offers the **active** `lead.sourcePlatform` values only; its free-text "Other" path was removed with catalogue v2, and the Master refuses a source that is not on the list. The list is managed from Settings → Leads on either panel (the same editor and permissions as the Master's Fields → Values) |
| `stageId` | Auto-set | The lead pipeline's first configured stage (also the first Kanban column) |
| `lineItems[]` | **Required** — at least one | See §3.2 |
| `followUpDate` | Optional | Drives the reminder surfaced in the panel. The form starts it at today + `leads.followUpDefaultDays` (**3** unless the company changed it; 0 means today), re-seeds it when the setting changes and after a save, and keeps the quick chips beside it |
| `partyWiseMode` | Optional toggle | Pulls that party's saved product records (their own name/alias/size for a model, and a packaging suggestion) instead of catalogue defaults |
| `notes` | Optional | Free text |
| `timeline[]` | Auto-generated | Stage changes log themselves; users may add remarks |

Custom fields defined for the Lead entity in Fields Management can be marked required; a lead
missing one is flagged `incomplete` with a `missingFields` list rather than being rejected, so an
offline draft is never lost to validation.

### 3.2 Per line item

**A line is one variant of one product** (2026-09). The product master is *category → model →
variant*, where every variant owns the code, the colour or pattern text and the weight; a model
with no colour choices has exactly one, unlabelled variant. White ×5 and Blue ×10 of the same
model are therefore two lines, each with its own code, weight and total.

Since catalogue v2 (2026-09-29, `docs/catalogue/CATALOGUE_MODEL.md`) the screens use the owner's
words: a **Product** is a category (`OPT · One Piece Toilet · Swisware+`) and a **Sub product** is
a model with exactly one variant (`102`, `1111`, `MAGENTA`). A sub product's colour rule is
derived (`colourRuleOf`): **fixed** (its one variant's label is the colour), **dedicated** (no
colour at all) or **selectable** (a multi-colour model: any colour of the colour range).

Picking a variant snapshots these onto the line **at that moment**:

| Field | Source |
|---|---|
| `productId`, `variantId` | Selected model and variant — kept live for traceability; the variant must belong to the product and still be active (`validation.lead.variantMissing`) |
| `code`, `variantLabel`, `weightKg` | Copied from the **variant** — a party's record never changes what a basin weighs |
| `productName`, `alias`, `size` | Copied from the product, or from the party's record when `partyWiseMode` is on |
| `categoryName`, `categoryCode`, `brandName` | Copied from the product's category (the owner's Product) — its name, code and brand — unless the panel sent them with the line, as its catalogue had them (`categoryCode` and `brandName` since 2026-09-29) |
| `colour` | **Chosen manually**, from the company's colour list, and only on a `selectable` (multi-colour) sub product; several colours are several lines, one per colour with its own quantity. Sent for any other product it is **dropped** (`colour = null`), not refused — a queued offline lead must not bounce on it (until catalogue v2 it was refused with `validation.lead.colourUnexpected`). Blank means the variant's own colour |
| `quantity` | **Required**, greater than zero (`validation.lead.quantityRequired`) |
| `packaging` | **Chosen manually** — never auto-filled, even in `partyWiseMode`. The form shows the field only while the company requires packaging on convert (`leads.packagingRequiredOnConvert`, **off** unless switched on) |
| `grade` | **Chosen manually**, from the company's `line.grade` list. Allowed on any product — a grade says what this line was sold as, not what the article is. Blank is a legal answer |
| `sequence` | Display order, auto-assigned |
| `fromPartyVariant` | Auto-set `true` when the values came from a party variant |
| `imagePath`, `notes` | Optional |

**How a lead is entered, on the screen** (the Office's `AddLeadScreen`, catalogue v2; the Master
still has no New lead page). The keyboard path, in order:

1. **Party** — a typeahead; the list appears only once something is typed.
2. **Source** — the active `lead.sourcePlatform` values (§3.1). A source the company stops
   listing while the form is open is dropped for the first listed one, never sent.
3. **Follow-up** — today + `leads.followUpDefaultDays` (§3.1); the quick chips stay.
4. **Product bar** — finds a Product (category) by name, code or brand, never a sub product (and
   only a Product that holds a live sub product). Rows read
   `CODE · Name · Brand`; an exact code match comes first, then catalogue order. Matched on the
   panel over every Product, like the sub-product bar, so a code and Enter typed at speed take
   that code rather than the list from before it.
5. **Sub-product bar** — lists **every** sub product of the chosen Product in catalogue order
   (`sort_order`), filtered as you type; a row shows the printed name, the size and, for a
   colour-named one, a swatch. The pick limit is `PICK_MAX_LIMIT` (1000; it was 50), because
   the largest SWISWARE product, Table Top Vitrosa Basin, holds 69 and One Piece Toilet 56.
6. **Colour and quantity**, by the sub product's rule — `fixed`: the colour shown locked and a
   quantity; `dedicated`: a quantity only; `selectable`: the colour range, several colours each
   with its own quantity (one line per colour). **Packaging** and **Grade** sit right beside each
   quantity, the same box each (owner's instructions, 2026-09-30): picks from `line.packaging`
   (Box, Grass, Paper to start) and `line.grade`; "—" is none. Packaging is required only while
   the company requires it; grade is always optional.
7. **Enter** walks each row's quantity, packaging and grade (a letter narrows a list; Enter takes
   the highlighted one and steps on — a mouse pick steps on too), then the next row; after the
   last grade it lands on **Add product**, whose Enter adds the sub product and returns to the
   sub-product bar. A card still short of something keeps the caret on its last grade (Add
   product is disabled). **Escape** walks back one field, Add product included.
   **Shift+Q**, or the **Complete sub product** button, adds a pending valid sub product and
   moves to the product bar; with nothing pending and an empty sub-product box it just finishes
   the product. A capital Q still types in any other field, the colour and packaging boxes
   included.
8. **Ctrl+Enter** opens a review of the lead once it is ready (the lines of one sub product
   grouped back into one row); Ctrl+Enter again saves it, once (key repeat is swallowed).
   Ctrl+S still saves directly. The form resets after a save.

`packaging` and `grade` are pointedly excluded from every auto-fill. A variant whose weight nobody
has entered yet shows **weight missing** rather than a zero, on the card, on the line and in the
footer, which also counts such lines beside the total weight it could compute.

### 3.3 Deliberately not on a lead

- No invoice, tax or GST fields — permanently out of scope. (The legacy `parties.gst_number`
  column predates this and is customer reference data, not a computation input.)
- No user-typed `id`. The system generates it: a temporary ID the moment the Office Panel saves
  it, online or not, and a permanent one once the Master applies it (§7).

---

## 4. Lead lifecycle — before conversion

1. **Draft entry** — party, line items, quantities. Saved to the Office Panel's local store the
   instant it is submitted, before any network call.
2. **Stage movement** — anyone with `leads.edit` drags it across Kanban columns (default pipeline:
   New → Quoted → Negotiating). Each move writes a system timeline entry automatically.
3. **Follow-ups** — a `followUpDate` surfaces in the panel's due list when it comes round.
4. **Editing** — line items, quantities, party and notes stay editable until conversion. Every edit
   bumps `version` and stamps `hlc`.
5. **Two people editing offline** — edits to *different* fields both survive the reconnect. Edits to
   the *same* field resolve to the higher HLC, and the losing value is retained in `sync_conflicts`
   for review. Nothing is silently discarded.
6. **A stage move made offline** (1.3) — follows the same rule as a field edit. The queued
   `lead.setStage` / `order.setStage` carries the HLC of the moment it was made. If the stage has
   moved since by a newer change, the offline move does not win: it is recorded as a `stageId`
   conflict (the push answers `merged`), and restoring it from Conflicts makes the move through
   `setStage` again, so the move rules, the timeline entry and the activity row apply. A move that
   is newer than the stored stage applies, and stamps `fieldHlc.stageId` with the move's own HLC,
   not the time it arrived (`assertStageFresh` in `master/src/domain/pipeline.ts`). A stale move to
   the stage the record is already in is a no-op. The check applies only to moves from an Office on
   protocol 3 or later (`STAGE_CLOCK_MIN_PROTOCOL` in `master/src/services/sync.service.ts`); a move
   from an older Office keeps the last-arrival rule and applies when it arrives.
7. **Somebody else's save while the form is open** (1.3) — an edit sends only the fields the
   person changed since opening the record, plus the field clocks it opened at (`baseFieldHlc`;
   `changedLeadFields` in `ui/src/LeadStaleEdit.tsx`, used by both copies of the form). Lines go
   only when they really changed (`sameLines`). On the Master, `updateLead` / `updateOrder` refuse
   a field saved by somebody else since with 409 `error.conflict.staleEdit`; on an Office the edit
   is queued and the Master's merge records a conflict instead. The form then says who saved and
   when ("Ravi saved this at 10:42", from the presence push) and offers **Reload theirs** (open the
   form again on their version) or **Keep mine** (carry on; the next save is checked against their
   version). Nothing is overwritten silently.
8. **Who else has it open** (1.3, rule 3) — a record's header shows the other people on it, an
   accent ring for anyone editing and a shield for a Server Master (`AvatarStack`). Held in the
   Master's memory only: each open record screen beats every 10 s and drops off 30 s after it stops.
   Presence is never stored, logged or put in the change ring. A provisional lead is never
   announced.
9. **Raising one for somebody else** (1.3) — a person holding `record.reassignOwner` (a Server
   Master, usually) gets an **Owner** picker on the Master's New pending order form, and may delete
   any user's pending order with `leads.delete` and `party.accessAll`. Both are logged under their
   own name.

---

## 5. Converting a lead to an order

Trigger: a user holding **`lead.convert`** presses **Convert to Order**.

### 5.1 Step by step

1. **Permission check** — `lead.convert`, verified in the Office Panel's server process and again
   on the Master.
2. **A new Order record is created**, carrying `leadId`, and `partyId`/`ownerId` unchanged.
3. **Line items are copied unchanged.** Leads and orders share one `line_items` table
   discriminated by `(parent_type, parent_id)`, so conversion inserts copies with
   `parent_type = 'order'` — a straight copy, never a re-derivation. Snapshotted values are **not**
   re-read from the product.
4. **Nothing is reserved.** *(Superseded in 1.4: stock and inventory were removed, so conversion
   no longer reserves stock and nothing replaced it.)*
5. **The lead is marked converted** — `converted_order_id` and `converted_at` are set. The lead is
   never deleted; it stays as history pointing at its order.
6. **The order starts its own pipeline** — a separate configurable pipeline (seeded In Progress /
   Postpone / Dispatched), independent of the lead's.
7. **Order-only fields open up**: `dispatchAddressLabel`, `expectedDispatchDate`, `totalWeightKg`
   (always auto-summed from the lines' `weightKg × quantity`, over the lines that have a weight —
   `linesWithoutWeight` counts the rest) and `totalWeightKgOverride` — when the override is set
   the UI labels the weight "manual" instead of "computed".

### 5.2 Guarantees that are explicitly tested

- Conversion copies line items **unchanged** — product, variant, code, colour, weight, quantity —
  no silent recalculation.
- A line's snapshotted `weightKg` and `colour` do **not** move when the product or its variant is
  edited afterwards; an order already raised is untouched by a weight entered later.
- `packaging` is **never** auto-filled during conversion — it keeps exactly what was entered.
- A variant of another product, or one taken off the form, is refused on a new lead; a line with
  no quantity is refused.

---

## 6. After conversion

- **Dispatch** — marking an order dispatched stamps it (`dispatched_at`), moves it to the
  Dispatched stage, adds the timeline message `Dispatched` and logs `order.dispatched` with empty
  details. *(Superseded in 1.4: it used to consume reservations and write a signed stock movement;
  stock was removed, so dispatch now has no stock side.)*
- **Handoff to accounting** — the confirmed order leaves for the company's separate accounting
  software. This system does no invoicing, tax or GST.

**The lead PDF** (catalogue v2, 2026-09-29) is a fixed-layout document, not a designer:
`GET /api/leads/:id/pdf` on the Master, behind `leads.export`, forwarded by the Office server while
the Master is reachable. It is drawn by the report-table renderer (`master/src/pdf/`), extended to
wrap text cells: the company name, the lead's id and the print date, the party block (name,
address, phone, GST number), then one row per sub product —
`# | [Brand] | Main product | Model | Size | Colour | Code | Qty`. What prints where is decided
in `master/src/domain/lead-pdf.ts`; the headings are English, like the report PDFs.

- The lines of one sub product print as **one row**, their quantities summed.
- A sub product whose name is not purely numeric prints in **Model**; a purely numeric one
  (`1111`, `41`) in **Code**, right-aligned. Exactly one of the two is filled
  (`subProductCells`, `shared/src/domain/colour-rule.ts`). The software code (`OPT-0001`) never
  prints.
- **Colour** is empty for a dedicated sub product, the fixed colour unless it only repeats the
  name, and for a multicolour one its lines grouped as `White ×10, Ivory ×5` (`lineColourText`).
- Left-aligned cells wrap and grow the row; figures stay on one line.
- The **Brand** column appears only when the lines span more than one brand. No money anywhere.
- **Preview PDF** opens it from the Master's Leads list and the Office's lead detail (not for a
  lead still waiting in the Office outbox — the Master renders the PDF); the Electron shell lets
  that one same-origin URL, `/api/leads/<id>/pdf`, open a sandboxed PDF window that can neither
  navigate nor open another.

Templates (the PDF Designer, removed on 2026-09-19) and the `Order.exports[]` log are named in the
guide but are **not built**; see §11.

---

## 7. ID handling through the whole flow

Records that sync use **text IDs**, not UUIDs, because the design lets an offline panel name a
record before the Master has ever seen it (`shared/src/sync/ids.ts`):

- **Temporary ID — 15 chars**: a 6-char device code plus a 9-digit zero-padded local counter, e.g.
  `A3F9K2000000123`. The device code is derived from the panel id the Master issued (from the
  hostname until the panel is paired), and the counter is saved to disk on every allocation so a
  crash cannot reuse one (`office/src/sync/device.ts`).
- **Permanent ID — 12 chars**: a 2-char entity prefix plus a 10-digit sequence, e.g.
  `LD0000000042` for a lead, `OD…` order, `PT…` party, `PR…` product, `LI…` line item (the full
  list is `ENTITY_PREFIX`). Only the Master mints these, from `id_sequences`, as it applies the
  write that creates the record.

**Who gets a temporary ID.** Every lead, party, product and party-wise record an Office Panel
creates goes through its outbox, online or not, and the Office server's `queue()`
(`office/src/http/app.ts`) mints a temporary ID for the one record the queued create names. The
creates the panel forwards live instead — a bulk product import, an image upload, a field value or
definition — work only while the Master is reachable and never have one. Everything a
create makes along the way — the lead's line items and timeline entries, a product's variants —
and everything the Master makes itself is named by the Master, straight to a permanent ID. That
includes the order from a conversion queued offline: the panel queues `lead.convert` against the
lead, and the Master creates the order when it applies it. A lead raised on the Master's own
`POST /api/leads` never has a temporary ID either.

**Promotion.** When a create arrives, the Master inserts the record under a new permanent ID and
writes the pair to `id_map` (`mapTemporaryId` in `master/src/services/sync.service.ts`); the
record's own `temporary_id` column stays empty. The push answers with the pairs, and the panel
rewrites any follow-up still in its outbox ("move lead X to Quoted") to the permanent ID.

> **The outbox also carries `chat.post` (1.3 Phase 6).** A chat message is an offline-able write like
> any other: the Office server queues it (`queue()`), answers `202` with the mutation id, and the
> outbox sends it with the rest. Two differences. It is **held per author**: the batch leaves out any
> `chat.post` whose `actorUserId` is not the person signed in now, so it waits for them to sign in
> again and never goes up under the panel actor or another person (which would earn the whole batch a
> refusal and stall lead and order sync). And the Master refuses, and records, one that arrives under
> the wrong person (`validation.chat.wrongAuthor`). The mutation id doubles as the message's
> `client_id`, so a resend returns the message it already made. See
> `docs/backend-modules/04-API-CONTRACT.md` section 14.4.

**Order across panels (1.3, rule 6).** Every push goes through the Master's push gate
(`master/src/services/push-gate.ts`). The gate collects the pushes that arrive within a gather
window, sorts all their mutations together by HLC physical time, then HLC counter, then device
code, then mutation id (`compareForIdAssignment`), and applies them one at a time. The window is
measured from the oldest push waiting:

- **100 ms** when a push carries a live create;
- **6 s** when a push carries a create whose HLC is more than 10 s old, an offline backlog, so
  panels that come back online together are numbered in the order their work was done.
  Given once per connection, and only within a minute of the panel connecting: the rest
  of a backlog's batches drain at once behind the first, and a live create from a PC
  whose clock is behind the Master's does not wait 6 s on every save;
- **until 5 s after the Master started**, so panels reconnecting after a Master restart are
  sorted together;
- anything else applies on the next tick.

The order holds within one gather window only. A panel whose push arrives after a window has
closed is numbered after everything already applied, however old its work, because a permanent ID
once minted is never moved. So the slowest a push waits is about 6 s. Two pushes from the same
panel (a 1.2 Office's ack retry) are merged in the gate rather than queued twice.

**Pending order numbers (1.3, rule 2).** Besides its `LD…` id, every pending order has a PO
number the owner reads everywhere — list rows, record headers, toasts, the lead PDF, the Filling and
Dispatch notes, search and the Dashboard: `PO/2026-27/00042`.

- **One series per Indian financial year**, 1 April 00:00 to 31 March, in the company's time zone
  (`config.locale.timeZone`, Asia/Kolkata by default; `financialYearLabel` in
  `shared/src/domain/pending-order-number.ts`). The year is read from the Master's clock at the
  moment the lead is created, the same instant as its `created_at`, so the number's year always
  matches the created date shown. An offline lead saved on 31 March and synced on 2 April is
  numbered in the new year, which matches its stored `created_at`.
- **Master-only, gap-free, never reused.** `insertLead` mints it inside `createLead`'s
  transaction from the `id_sequences` row `po:<fy>` (`nextInSeries` in
  `identity.repository.ts`). The row lock holds until commit, so two saves can never take one
  number, and a rolled-back or refused create gives its number back. A deleted pending order keeps
  its number (the unique index covers deleted rows), so a number is never handed out twice.
- **At least five digits**, growing past them rather than wrapping.
- **A final order has no number of its own**: it shows its pending order's, read through the lead
  it came from. An order with no lead shows its `OD…` id, and the order lists keep the `OD…` id in
  a small **Order ref** column beside the number.
- **Existing leads were back-numbered** by migration `20261003000000_pending_order_numbers`, per
  financial year in `(created_at, id)` order, deleted ones included, using UPDATE only; the
  counters were seeded past what the backfill used. A pre-1.3 `.obbackup` restore numbers its
  leads the same way (`backfillPendingOrderNumbers`).

**Provisional.** An Office save is still queued in its outbox first, online or not. While the
link is up, `POST /api/leads` then waits up to 5 s (`OFFICE_SAVE_NUMBER_WAIT_MS`) for the push
that carries it and answers with the number, so the toast reads "Pending Order
PO/2026-27/00042 saved". Offline, or when the Master is slower than that, it answers at once and
the lead shows a **Provisional** pill beside its temporary id (`RecordNumber`) — never a guessed
number. When the push lands, the panel's `numbered` event names the number; an open provisional
lead stays open under its permanent id. A lead whose save reached the Master more than a minute
after it was made also gets a `lead.numbered` entry in its author's notification bell.

**The ordering ceiling.** Numbers follow the gate's order above: within one gather window, by when
the work was done; outside it, by when it reached the Master. A panel that reconnects late gets
later numbers than work applied before it arrived, however old its own work, because a number once
minted is never moved. Numbers stay unique and gap-free either way; only their relative order is
affected. Hard-deleting leads (sample data removal) leaves holes, since numbers are never reused.

**The counters survive the reload CLI.** Erasing the business data (`wipe:business` in
`master/src/services/catalog-reload-cli.ts`) resets the per-entity id counters by name and never
the `po:%` rows, so a PO number once printed is never handed out again; `reload:catalog` touches
no counter at all. Only a developer factory reset, which drops the schema, starts the series
again.

**`id_map` keeps a temporary ID resolvable for writes.** A mutation addressed by it, and a
`partyId`, `ownerId` or `productId` inside a payload, or a line's `productId`, that names one — a
lead raised on a party created offline in the same session — are resolved through it
(`resolveId`). The outbox sends the party's create ahead of the lead's, so the pair exists by the
time the lead is applied. Search and the list screens do not consult `id_map`. The pair is kept
until the business data is wiped (the Master workspace's `wipe:business` and `seed:parties`
scripts clear the table; since catalogue v2 `reload:catalog` keeps it, along with the parties it
maps and every id counter). A party-wise record's temporary ID never reaches `id_map`: the Master
does not map it, since `partyVariant.upsert` is keyed by party and product rather than by the ID.

Tables only the Master writes keep other keys: `tenants` and `office_panels` a UUID, the logs a
`BIGSERIAL` (`docs/schema/00-overview.md` §2). Roles and users have text IDs so the schema can take
one minted offline, but no `role.*` or `user.*` mutation exists yet, so both are created only
through the Master's API, always with a permanent ID.

---

## 8. Lead line item — full field reference

The same shape is reused unchanged on orders.

### 8.1 Snapshotted at add time

Frozen the moment the line is added; editing the product or its variant later does not change them.

`productName`, `categoryName`, `categoryCode`, `brandName`, `alias`, `code`, `variantLabel`,
`colour`, `size`, `weightKg`

### 8.2 Other fields

| Field | Notes |
|---|---|
| `productId`, `variantId` | Live references, for traceability |
| `sequence` | Display order |
| `packaging` | Manual on every line — never auto-filled |
| `grade` | Manual on every line, from `line.grade`; never auto-filled. Copied to the order like the rest of the snapshot |
| `quantity` | Pieces of this one variant; greater than zero |
| `lineWeightKg` | Derived: `weightKg × quantity`, or null while the weight is missing |
| `fromPartyVariant` | `true` when the values came from a party variant |
| `imagePath`, `notes` | Optional |

### 8.3 Why the snapshot exists

An order printed last month must keep the spec it was quoted at — the code, the colour, the
weight. Without the copy, correcting a product's weight would silently rewrite the history of
every order ever printed — which is exactly what §5.2's conversion guarantees exist to prevent.

---

## 9. Inter-searchable fields — PostgreSQL, not FTS5

The guide specifies SQLite **FTS5**. OrderBook runs **PostgreSQL** by an explicit, user-confirmed
decision (`HANDOFF.md` decision 2), and FTS5 is a SQLite-only feature. The guide's *design* ports
across intact; only the mechanism changes — `tsvector` + **GIN**, which is Postgres's equivalent
and is already used in this schema for `products.parameters`.

Every rule from the guide's §9 is preserved:

| Guide's rule | How it is met here |
|---|---|
| One index per searchable entity, never a merged one | A `search_vector` column on `products`, `parties` and `line_items` separately, so a hit knows what it matched |
| Kept in sync by triggers, never by application code | A trigger per base table rebuilds the vector; the mutation service never writes it |
| Line items indexed separately from products | `line_items.search_vector` indexes the **snapshot** text, so searching an old product name still finds the historical leads and orders that show it |
| A hit resolves back to its parent | `line_items.parent_type` + `parent_id` route the result to the right detail screen |
| Filter by tenant first, never rely on ranking | Every search query is `WHERE tenant_id = ? AND search_vector @@ ...`; the GIN indexes are composite on `(tenant_id, search_vector)` |
| Universal search consumes the indexes, it does not own one | `search.service.ts` queries the three vectors and merges; adding a new entity means adding a vector to the merge |

What the guide says to avoid is avoided: no in-memory `.filter()` over full tables, no external
search engine (it would break the offline-only rule), and the tenant/parent columns are stored but
excluded from the vector itself.

---

## 10. Full flow

```
 [Office Panel — user with leads.create]
        |
        v
 Party -> source -> follow-up -> product bar -> sub-product bar -> colour(s) + qty -> Ctrl+Enter review -> save
        |                                   |
        |                    Saved to the local store instantly
        |                    (temporary ID until the Master applies it)
        v
 Lead sits in its pipeline (Kanban)
        |
        +- follow-ups, edits, timeline notes
        +- pushes to the Master and out to every peer when the link is up
        |
        v
 User with lead.convert presses "Convert to Order"
        |
        v
 +------------------------------------------+
 | New Order:                                |
 |  - line items copied unchanged            |
 |  - lead.convertedOrderId / convertedAt set|
 +---------------------+--------------------+
                       |
                       v
           Order pipeline (its own stages)
                       |
                       v
                 Mark dispatched
                       |
                       v
   Order stamped dispatched, moved to the Dispatched stage
                       |
                       v
           Handed off to accounting software
```

---

## 11. Where this deliberately differs from the supplied guide

| Guide | Here | Why |
|---|---|---|
| SQLite + FTS5 virtual tables | PostgreSQL `tsvector` + GIN | FTS5 is SQLite-only. Postgres was chosen over SQLite by the owner (`HANDOFF.md` decision 2); the search *design* is ported unchanged (§9) |
| Electron main process vs renderer | Office Panel **server process** vs browser | Same trust boundary, different runtime — OrderBook is an Express-served web app, not Electron |
| Offline store implied to be the same SQLite database | Durable file-backed local store (outbox + snapshot overlay) in the Office Panel server | Office PCs are thin clients. Installing and maintaining a second database on every office PC contradicts the project's "operator installs nothing" rule; the outbox provides the same guarantee — a write survives a crash and syncs later |
| PDF Designer, pixel-identical export, `Order.exports[]` | A **fixed-layout lead PDF** only (§6); no designer, no templates, no export log | The owner asked for the lead PDF back without the Designer (2026-09-28). Named here so the rest is not mistaken for an oversight |
| Universal search across Products and Parties | Built as part of this work | It did not exist yet |
| Dashboard and Notifications modules | Follow-up dates are surfaced in the Office Panel; no separate notifications module | Out of scope of the lead flow |
