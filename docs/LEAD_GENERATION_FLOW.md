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
oversight — it has no create form, and the Master's own HTTP API rejects lead creation.

A lead can be created **fully offline**. It is written to the Office Panel's durable local store
immediately, given a temporary ID, and pushed to the Master when the link returns. See §7.

---

## 3. Fields required to create a lead

### 3.1 Lead-level fields

| Field | Required? | Notes |
|---|---|---|
| `partyId` | **Required** | Picked from the Party list — the customer |
| `ownerId` | **Required** | Defaults to the creating user; reassignment needs `record.reassignOwner` |
| `sourcePlatform` | Configurable option list | WhatsApp / call / website / walk-in — company-defined rows in `option_lists`, not a hardcoded enum |
| `stageId` | Auto-set | The lead pipeline's first configured stage (also the first Kanban column) |
| `lineItems[]` | **Required** — at least one | See §3.2 |
| `followUpDate` | Optional | Drives the reminder surfaced in the panel |
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

Picking a variant snapshots these onto the line **at that moment**:

| Field | Source |
|---|---|
| `productId`, `variantId` | Selected model and variant — kept live for stock movement and traceability; the variant must belong to the product and still be active (`validation.lead.variantMissing`) |
| `code`, `variantLabel`, `weightKg` | Copied from the **variant** — a party's record never changes what a basin weighs |
| `productName`, `alias`, `size` | Copied from the product, or from the party's record when `partyWiseMode` is on |
| `colour` | **Chosen manually**, from the company's colour list, and only on a model with `multiColour` on (`validation.lead.colourUnexpected` otherwise). Blank means the variant's own colour |
| `quantity` | **Required**, greater than zero (`validation.lead.quantityRequired`) |
| `packaging` | **Chosen manually** — never auto-filled, even in `partyWiseMode` |
| `sequence` | Display order, auto-assigned |
| `fromPartyVariant` | Auto-set `true` when the values came from a party variant |
| `imagePath`, `notes` | Optional |

**How a line is found, on the screen:** the search box offers **categories only** first — typing
"toilet" shows *ONE PIECE TOILET* and never a product. The chosen category becomes a chip and the
same box then searches the models inside it, by name or by any of their codes. Picking a model
opens a card with one row per variant (code and weight already filled, a quantity to type);
adding the card adds one line per row with a quantity. On a model made in every colour the card
also offers a *Colour* select over the colour list — one colour per card, copied onto every line
it adds; the same model in a second colour is the card added again. The category chip stays for
the next product; Backspace on an empty box, or the chip's ✕, goes back to choosing a category.

`packaging` is pointedly excluded from every auto-fill. A variant whose weight nobody has entered
yet shows **weight missing** rather than a zero, on the card, on the line and in the footer, which
also counts such lines beside the total weight it could compute.

### 3.3 Deliberately not on a lead

- No invoice, tax or GST fields — permanently out of scope. (The legacy `parties.gst_number`
  column predates this and is customer reference data, not a computation input.)
- No user-typed `id`. The system generates it: temporary if offline, permanent once the Master
  assigns one (§7).

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
4. **Stock is reserved** — one `stock_reservations` row per line, keyed by the line's variant.
   A white basin in stock does not satisfy a reservation for a blue one.
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
- Reservations are per variant, never aggregated to a product total.
- A variant of another product, or one taken off the form, is refused on a new lead; a line with
  no quantity is refused.

---

## 6. After conversion

- **Dispatch** — marking an order dispatched consumes its reservations and writes the stock
  movement, always as a **signed delta**, never an absolute value.
- **Handoff to accounting** — the confirmed order leaves for the company's separate accounting
  software. This system does no invoicing, tax or GST.

Printing (PDF Designer) and the `Order.exports[]` log are named in the guide but are **not built**;
see §11.

---

## 7. ID handling through the whole flow

Syncable business records use **text IDs**, not UUIDs, because an offline panel must mint an ID
before the Master has ever seen the record:

- **Temporary ID — 15 chars**: a 6-char device code plus a 9-char zero-padded local counter, e.g.
  `A3F9K2000000123`. Every record created offline starts here.
- **Permanent ID — 12 chars**: a 2-char entity prefix plus a 10-digit sequence, e.g.
  `LD0000000042` for a lead, `OD…` order, `PT…` party, `PR…` product, `LI…` line item. Only the
  Master mints these.
- **Promotion order is `(hlc, device_code)`** — never the order devices happened to reach the
  Master. Two panels syncing in either order produce the same numbering.
- **`id_map` keeps the temporary ID working forever**, so a lead printed while offline is still
  findable after renumbering.
- The Order created by an offline conversion follows the same path.

Infrastructure tables that can only ever be written by the Master — tenants, users, roles, office
panels, sessions — keep UUIDs. They are never created offline, so they need none of this.

---

## 8. Lead line item — full field reference

The same shape is reused unchanged on orders.

### 8.1 Snapshotted at add time

Frozen the moment the line is added; editing the product or its variant later does not change them.

`productName`, `categoryName`, `alias`, `code`, `variantLabel`, `colour`, `size`, `weightKg`

### 8.2 Other fields

| Field | Notes |
|---|---|
| `productId`, `variantId` | Live references, for stock movement and traceability |
| `sequence` | Display order |
| `packaging` | Manual on every line — never auto-filled |
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
 Pick party (required) -> add line items (product, variant+qty, colour, packaging) -> Save
        |                                   |
        |                    Saved to the local store instantly
        |                    (temporary ID when offline)
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
 |  - stock reserved per (product, colour)   |
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
   Reservations consumed -> signed stock movement written
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
| PDF Designer, pixel-identical export, `Order.exports[]` | **Not built** | Out of the lead-generation flow. Named here so it is not mistaken for an oversight |
| Universal search across Products and Parties | Built as part of this work | It did not exist yet |
| Dashboard and Notifications modules | Follow-up dates are surfaced in the Office Panel; no separate notifications module | Out of scope of the lead flow |
