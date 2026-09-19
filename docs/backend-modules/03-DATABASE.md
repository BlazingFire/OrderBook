# Backend modules — the complete schema specification

Every table this batch creates, every table it alters, every index it adds or replaces, and the
five migrations that carry them. Nothing here is built yet.

This is the database half of `docs/BACKEND_MODULES.md`. Where that document settles a decision, this
one implements it in DDL; where it is silent, this one decides and says why. It does not restate the
module designs — the set is organised by concern, so endpoints, wire types and socket events are in
`04-API-CONTRACT.md`, the file manifest in `02-FILE-STRUCTURE.md`, permission keys and tiers in
`08-PERMISSIONS.md`, and stage ordering in `11-BUILD-SEQUENCE.md`. Read
`docs/schema/00-overview.md` first for the conventions every table below inherits.

**This document is the sole authority for schema**: tables, columns, enums, `CHECK` constraints,
indexes, migration DDL, and each migration's `down()` policy. Where another document mentions one of
those, this one is what it must agree with.

Existing schema is documented in `docs/schema/`. Those files describe the schema **as designed**;
the migrations under `master/src/db/migrations/` are what actually ran, and where the two disagree
the migrations win. Every claim below about existing structure is cited to a migration line.

---

## 1. What this document covers

| | Tables |
|---|---|
| **New** | `document_assets`, `document_templates`, `document_exports` |
| **Altered** | `leads`, `orders`, `parties`, `products`, `option_lists`, `custom_field_definitions`, `pipeline_stages`, `activity_log` |
| **Read but untouched** | `roles`, `users` (gain Bin indexes only), `stock_movements`, `line_item_quantities`, `stock_reservations`, `inventory_stock`, `party_product_variants` |

Five migrations, `20260305000000` through `20260309000000`, in that order. The range is allocated in
`docs/BACKEND_MODULES.md` §2.2 and is not negotiable here — three module designs each claimed
`20260305` and `20260306` before the range was assigned, and the registry at
`master/src/db/migrations/index.ts:30-37` is a hand-maintained array, so a collision is a silent
overwrite rather than a build error.

**Not covered:** the permission catalogue and the grant-migration algorithm (`08-PERMISSIONS.md`),
the shared TypeScript types that mirror these columns (`04-API-CONTRACT.md`), and the i18n layer,
which adds no table and no column at all — its catalogues are compiled TypeScript precisely so that a missing key is a
compile error rather than a missing row.

---

## 2. Conventions, and the three places this batch deviates

`docs/schema/00-overview.md:59-92` fixes the house rules: `UUID` primary keys for user-facing
entities, `BIGSERIAL` only for pure append-only logs, `TIMESTAMPTZ NOT NULL DEFAULT now()` for
timestamps, money as integers in the smallest currency unit, `JSONB` for genuinely open-ended
attributes and nothing else. Every table below follows them. Three deviations are deliberate and
each is argued at the table that makes it:

1. **`document_templates` uses a `UUID` id and does not participate in sync**, unlike the syncable
   business tables which carry text ids (§9.3).
2. **`document_exports` uses `BIGSERIAL`** — it is an append-only ledger read newest-first, the same
   argument `docs/schema/04-activity-log.md:31-38` makes for `activity_log` (§5.3).
3. **`pipeline_stages` gains `is_archived`, not `deleted_at`** — it is referenced by real foreign
   keys from `leads.stage_id` and `orders.stage_id`, so it can never be a Recycle Bin entity (§6.5).

Two rules from `HANDOFF.md`'s traps apply to every migration in this batch and are not repeated
per file:

- **A migration never imports a live shared constant.** `20260301000000_tenancy_access_and_sync.ts`
  did, and editing the permission catalogue afterwards silently changed what an already-applied
  migration had done. Every key string, list key and tier name in these five files is inlined and
  frozen with a dated comment, following `20260304000000_role_tier_ceiling_repair.ts:33-55`.
- **A list of columns referencing a table is never hand-written.** Ask `information_schema` —
  `userReferences()` at `20260303000000_roles_and_users.ts:37-54` is the pattern.

Knex wraps each migration in a transaction (`master/src/db/knex.ts:10-24` sets no
`disableTransactions`), and PostgreSQL DDL is transactional, so every migration below is
all-or-nothing including its trigger surgery.

---

## 3. Migration map

| Timestamp | File | Tables touched | Existing rows | `down()` |
|---|---|---|---|---|
| `20260305000000` | `_soft_delete_columns.ts` | `leads`, `orders`, `parties`, `products` (+ Bin indexes on `roles`, `users`) | untouched — `deleted_at` defaults `NULL`, which is exactly "not deleted" | **empty**, §11.1 |
| `20260306000000` | `_field_values_and_stage_ordering.ts` | `option_lists`, `custom_field_definitions`, `pipeline_stages` | six seeded `lead.sourcePlatform` rows get timestamps; new colour/type/packaging rows are seeded | **empty**, §11.2 |
| `20260307000000` | `_activity_log_actor_name.ts` | `activity_log`, plus report indexes on `orders` and `stock_movements` | every row gets `actor_name` backfilled where it resolves | **real**, §11.3 |
| `20260308000000` | `_document_templates_and_exports.ts` | creates `document_assets`, `document_templates`, `document_exports` | none — three new tables, nothing seeded | **real**, §11.4 |
| `20260309000000` | `_new_module_permission_grant.ts` | `roles` | `permissions` unioned, sorted, rewritten only where it changed | **empty**, §11.5 |

Order matters twice. `20260307`'s report index on `orders` uses a predicate naming `deleted_at`, so
it must run after `20260305` creates that column. `20260309` is last because it grants keys that the
four preceding migrations' modules define.

### 3.1 The registry edit

`master/src/db/migrations/index.ts` gains five imports and five array entries, appended in
timestamp order. The `name` string must equal the filename minus `.ts`, and `down` is a required
member of the `Migration` interface (`index.ts:24-28`), so every file exports one even when it is
deliberately empty.

```ts
import * as softDeleteColumns from './20260305000000_soft_delete_columns.js';
import * as fieldValuesAndStageOrdering from './20260306000000_field_values_and_stage_ordering.js';
import * as activityLogActorName from './20260307000000_activity_log_actor_name.js';
import * as documentTemplatesAndExports from './20260308000000_document_templates_and_exports.js';
import * as newModulePermissionGrant from './20260309000000_new_module_permission_grant.js';

export const migrations: Migration[] = [
  // … the six existing entries, unchanged …
  { name: '20260305000000_soft_delete_columns', ...softDeleteColumns },
  { name: '20260306000000_field_values_and_stage_ordering', ...fieldValuesAndStageOrdering },
  { name: '20260307000000_activity_log_actor_name', ...activityLogActorName },
  { name: '20260308000000_document_templates_and_exports', ...documentTemplatesAndExports },
  { name: '20260309000000_new_module_permission_grant', ...newModulePermissionGrant },
];
```

**A guard test lands before the first of these files.** With five migrations arriving at once
against a hand-maintained array, a file written but not imported is a silent no-op and nothing turns
red. The test reads the migrations directory, compares the filenames to `migrations.map(m => m.name)`
and fails on any file missing from the array or any array entry with no file. It is a pure suite —
no `describe.skipIf` — because a skipped suite looks exactly like a passing one.

---

## 4. Existing structure this batch depends on

Stated once, cited, so no section below has to re-derive it.

```
parties        id TEXT PK (PT…), tenant_id, party_code TEXT NOT NULL, …,
               version, hlc, field_hlc, temporary_id, search_vector      -- 20260302:98-107, :536-544
products       id TEXT PK (PR…), tenant_id, product_code TEXT NOT NULL,
               color TEXT (US spelling, 20260101:103), …, version, hlc,
               field_hlc, temporary_id, search_vector
leads          id TEXT PK (LD…), tenant_id, stage_id UUID NOT NULL,
               converted_order_id TEXT, version, hlc, field_hlc,
               temporary_id                                              -- 20260302:114-139
orders         id TEXT PK (OD…), tenant_id, dispatched_at TIMESTAMPTZ,
               stage_id UUID NOT NULL, version, hlc, field_hlc,
               temporary_id                                              -- 20260302:141-167
option_lists   id UUID PK, tenant_id, list_key, value, label, sequence,
               is_active — and NOTHING else                              -- 20260301:286-296
pipeline_stages id UUID PK, pipeline_id UUID NOT NULL, name, sequence,
               is_default, is_terminal, colour, created_at — no tenant_id -- 20260301:243-255
activity_log   id BIGSERIAL PK, tenant_id, entity_type, entity_id TEXT,
               action, actor_type, actor_id TEXT, details JSONB,
               created_at, sequence, prev_hash, hash                     -- 20260101:200-213,
                                                                            20260302:514, 20260303:243-248
```

Unique indexes that this batch rewrites, exactly as they exist today:

```sql
-- 20260301000000_tenancy_access_and_sync.ts:149-152
CREATE UNIQUE INDEX idx_parties_code_tenant  ON parties(tenant_id, party_code);
CREATE UNIQUE INDEX idx_products_code_tenant ON products(tenant_id, product_code);

-- 20260301000000_tenancy_access_and_sync.ts:253, :260-263
CREATE UNIQUE INDEX idx_pipeline_stages_seq         ON pipeline_stages(pipeline_id, sequence);
CREATE UNIQUE INDEX idx_pipeline_stages_one_default ON pipeline_stages(pipeline_id) WHERE is_default;

-- 20260301000000_tenancy_access_and_sync.ts:296, :312
CREATE UNIQUE INDEX idx_option_lists_key_value ON option_lists(tenant_id, list_key, value);
CREATE UNIQUE INDEX idx_custom_fields_key      ON custom_field_definitions(tenant_id, entity, key);
```

**All four are unique *indexes*, not table constraints.** This is the correction the adversarial
review found: `ALTER TABLE parties DROP CONSTRAINT idx_parties_code_tenant` fails, because no such
constraint exists. `20260301:144-147` dropped the original `parties_party_code_key` **constraint**
and replaced it with an **index** — so the reversal verb is `DROP INDEX`. Every rewrite below uses
`DROP INDEX` then `CREATE UNIQUE INDEX`.

---

## 5. New tables

Three tables, created in `20260308000000_document_templates_and_exports.ts` in dependency order:
`document_assets` first, because `document_templates` has two foreign keys into it.

### 5.1 `document_assets`

A logo or a signature image, stored on disk with a row describing it.

```sql
CREATE TABLE document_assets (
  id           UUID PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  kind         TEXT NOT NULL CHECK (kind IN ('logo', 'signature')),
  filename     TEXT NOT NULL,                       -- the operator's own name, for the picker
  mime_type    TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg')),
  byte_size    BIGINT NOT NULL CHECK (byte_size > 0),
  sha256       TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path TEXT NOT NULL,                       -- relative to data/, never absolute
  uploaded_by  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX        idx_document_assets_tenant ON document_assets (tenant_id, kind);
CREATE UNIQUE INDEX idx_document_assets_sha    ON document_assets (tenant_id, sha256);
```

The bytes live under `data/documents/assets/`, never as a `BLOB` — `docs/schema/00-overview.md:113-119`
sets that rule for `product_images` and the argument is identical: the database stays small and the
Master's storage figures come from walking a directory.

`sha256` is unique per tenant deliberately. An operator who uploads the same logo again for a second
template gets the existing row rather than a second copy of the same bytes, and the digest is the
only reliable identity a file has — filenames are whatever the operator called it that day. The
consequence is that an asset row is **shared** between templates, which is why the two foreign keys
from `document_templates` are left at their default `NO ACTION`: deleting an asset any template
still points at is rejected by PostgreSQL, not by a service check that could be forgotten.

`mime_type` is a `CHECK` rather than free text because the renderer must know what it can embed;
PDFKit takes PNG and JPEG and nothing else, so a third value would be a row that renders as a crash.

### 5.2 `document_templates`

One saved document design. This is the table the PDF Designer edits.

```sql
CREATE TABLE document_templates (
  id                  UUID PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id),

  document_type       TEXT NOT NULL
                      CHECK (document_type IN ('quotation', 'order_confirmation', 'dispatch_note')),
  name                TEXT NOT NULL,
  is_default          BOOLEAN NOT NULL DEFAULT false,

  -- Page geometry
  paper_size          TEXT NOT NULL DEFAULT 'A4' CHECK (paper_size IN ('A4', 'A5', 'Letter')),
  orientation         TEXT NOT NULL DEFAULT 'portrait'
                      CHECK (orientation IN ('portrait', 'landscape')),
  margin_top_mm       INTEGER NOT NULL DEFAULT 18 CHECK (margin_top_mm    BETWEEN 0 AND 100),
  margin_right_mm     INTEGER NOT NULL DEFAULT 15 CHECK (margin_right_mm  BETWEEN 0 AND 100),
  margin_bottom_mm    INTEGER NOT NULL DEFAULT 18 CHECK (margin_bottom_mm BETWEEN 0 AND 100),
  margin_left_mm      INTEGER NOT NULL DEFAULT 15 CHECK (margin_left_mm   BETWEEN 0 AND 100),

  -- What appears on the page
  show_rates          BOOLEAN NOT NULL DEFAULT true,
  show_colour_chips   BOOLEAN NOT NULL DEFAULT true,
  show_terms          BOOLEAN NOT NULL DEFAULT true,
  show_logo           BOOLEAN NOT NULL DEFAULT true,
  show_signature      BOOLEAN NOT NULL DEFAULT false,
  show_page_numbers   BOOLEAN NOT NULL DEFAULT true,
  show_watermark      BOOLEAN NOT NULL DEFAULT false,
  show_party_block    BOOLEAN NOT NULL DEFAULT true,
  watermark_text      TEXT,
  terms_text          TEXT,
  footer_text         TEXT,
  accent_colour       TEXT CHECK (accent_colour IS NULL OR accent_colour ~ '^#[0-9A-Fa-f]{6}$'),
  locale              TEXT,

  logo_asset_id       UUID REFERENCES document_assets(id),
  signature_asset_id  UUID REFERENCES document_assets(id),

  -- Block ORDER and per-block options only. Never a switch — every switch above is
  -- a typed column. Shape: DocumentLayout, defined in 04-API-CONTRACT.md §6.1.
  -- Read whole, never filtered on.
  layout              JSONB NOT NULL DEFAULT '{"blocks":[{"kind":"lines","groupByProduct":false}]}',

  created_by          TEXT,
  updated_by          TEXT,
  deleted_at          TIMESTAMPTZ,
  deleted_by          TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX document_templates_name_unique
    ON document_templates (tenant_id, lower(name)) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX document_templates_one_default
    ON document_templates (tenant_id, document_type) WHERE is_default AND deleted_at IS NULL;

CREATE INDEX idx_document_templates_type
    ON document_templates (tenant_id, document_type) WHERE deleted_at IS NULL;

CREATE INDEX idx_document_templates_deleted
    ON document_templates (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
```

**Why every switch is a typed `BOOLEAN` column and only `layout` is `JSONB`.** The **eight** `show_*`
flags — `show_rates`, `show_colour_chips`, `show_terms`, `show_logo`, `show_signature`,
`show_page_numbers`, `show_watermark`, `show_party_block` — are permanent product decisions (a
quotation either prints rates or it does not), and `docs/schema/00-overview.md:84-92` is explicit
that `JSONB` is the escape hatch for undecided fields, not the default for everything. A typed column
means the renderer reads `template.showRates` and the compiler catches a typo; a key inside `layout`
means it reads `layout.showRates ?? true` forever and a typo renders a document that is silently
missing a column.

**The split is exact, and it is the whole of it.** `layout` holds **only** block order and per-block
options — no toggles, ever. Its shape is `DocumentLayout`, whose type, the six `DocumentBlockKind`
members and the grammar `assertTemplateValid` enforces are defined once in
**`04-API-CONTRACT.md` §6.1**; that document is the authority and this one does not restate it.
Block order and per-block options genuinely are open-ended and are read as a whole record, never
filtered on — exactly the criterion `docs/schema/04-activity-log.md:29` applies to
`activity_log.details`. `layout` therefore gets **no GIN index**.

The column default is a minimal legal document rather than `'{}'`, because the grammar makes a
`lines` block mandatory and a default that fails its own validator is a row the service would refuse
to save back unchanged.

`idx_document_templates_deleted` lands here rather than in `20260305` because
`'document_template'` joins `RECYCLE_BIN_ENTITIES` at the PDF Designer stage, not before (§6.1's
staging note). Its column order is the Bin cursor's sort key, identical to the six from `20260305`.

**Why `document_type` is a `CHECK` and `locale` is not.** `docs/ROLES_AND_USERS.md:52-59` sets the
test: a `CHECK` is right when the set is fixed by the product and can never be company-configurable.
Three document types are fixed by the product — `quotation`, `order_confirmation`, `dispatch_note`,
and **no `invoice`**: the product does not raise invoices, and a fourth member in the wire type with
no fourth member in this `CHECK` is an insert that fails at the database with a 500. The TypeScript
unions that mirror these two constraints — `DocumentType` (three members) and `PaperSize`
(`'A4' | 'A5' | 'Letter'`, matching `paper_size` above) — are declared in
`04-API-CONTRACT.md` §6.1, which owns them; the rule is simply that the two lists are the same list.
Locales are not fixed here — they are enumerated by
the compiled catalogue in `shared/src/i18n/locales.ts`, and the rule that a migration must never
import a live shared constant means a `CHECK` would be a second, hand-copied list that drifts the
day a third language is added. `locale` is therefore validated at the service, against the one list
that is authoritative.

**Why `accent_colour` carries a format `CHECK`.** The value is rendered straight into a style
attribute in the browser — the existing precedent is the stage swatch at
`office/web/src/components/KanbanBoard.tsx:83-87`, `style={{ background: stage.colour ?? 'var(--muted)' }}`.
An unconstrained string there accepts `url(http://…)`, which would make an application whose first
promise is that it never touches the internet issue a network request. A database `CHECK` is the one
place that cannot be bypassed by a write path added later. The same constraint appears on
`option_lists.hex` (§6.3) for the same reason.

**Margins are bounded in SQL, validated properly in the domain.** `BETWEEN 0 AND 100` stops
nonsense. The real rule — that left plus right must leave a printable column at the chosen paper
size and orientation — depends on three columns together and on a paper-dimension table the database
does not have; it lives in `master/src/domain/document-template.ts` as `assertTemplateValid`, where
it is unit-testable without a database.

`assertTemplateValid` is also the only validator of `layout`, for the reason no `CHECK` can be: the
grammar is about the *sequence* of array members (at most one block of each kind, `lines` mandatory,
`header` first if present, `signature` last if present, `terms.text` at most 500 characters), and a
row `CHECK` cannot express an ordering constraint over a JSONB array without a plpgsql function that
would then be a second copy of a rule the domain already owns. The rules and the 400 payload that
reports a violation are specified in `04-API-CONTRACT.md` §6.1 and §6.2.

**`version` but no `hlc`.** See §9.3. `version` drives optimistic concurrency for online saves and
is what `assertVersionMatches` (`master/src/domain/access.ts:183-192`) needs — two administrators can
have the same template open in two browsers. `hlc` drives offline merge, and templates are never
edited offline. `docs/ROLES_AND_USERS.md:29-39` makes the same distinction: the two are not
redundant and one does not replace the other.

**Nothing is seeded.** A template row nobody reviewed is configuration nobody approved — the same
argument by which role templates are offered rather than seeded. The renderer falls back to an
in-memory default when a tenant has no template of the requested type, which also keeps
`master/tests/helpers/fixtures.ts` free of seeded-id bookkeeping.

**Consequence of `document_templates_one_default`'s predicate.** Because it is partial on
`deleted_at IS NULL`, soft-deleting the default template leaves that document type with no default
at all. That is the right outcome — the renderer falls back to the built-in default rather than
promoting an arbitrary survivor — but it must be stated, because a UI that assumes a default always
exists will render a blank picker. It is also a partial unique index and therefore cannot be
deferred, so swapping the default uses the clear-then-set ordering described in §6.5.

### 5.3 `document_exports`

One rendered PDF. An append-only history, not a cache.

```sql
CREATE TABLE document_exports (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id),

  subject_type        TEXT NOT NULL CHECK (subject_type IN ('lead', 'order')),
  subject_id          TEXT NOT NULL,                 -- an LD… or OD… id; no FK, see below
  document_type       TEXT NOT NULL
                      CHECK (document_type IN ('quotation', 'order_confirmation', 'dispatch_note')),

  template_id         UUID REFERENCES document_templates(id),
  template_name       TEXT NOT NULL,                 -- frozen snapshot, survives a rename

  storage_key         UUID NOT NULL,                 -- the opaque handle the API hands out
  storage_path        TEXT NOT NULL,                 -- relative to data/, never absolute
  byte_size           BIGINT NOT NULL CHECK (byte_size > 0),
  sha256              TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  page_count          INTEGER NOT NULL CHECK (page_count > 0),

  rates_included      BOOLEAN NOT NULL,              -- was the rate column in THIS file?
  locale              TEXT,

  rendered_by_user_id TEXT REFERENCES users(id),
  rendered_by_panel_id UUID REFERENCES office_panels(id),
  superseded_by       BIGINT REFERENCES document_exports(id),

  deleted_at          TIMESTAMPTZ,
  deleted_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX        idx_document_exports_feed    ON document_exports (tenant_id, id DESC);
CREATE INDEX        idx_document_exports_subject ON document_exports (tenant_id, subject_type,
                                                                      subject_id, id DESC);
CREATE UNIQUE INDEX idx_document_exports_key     ON document_exports (storage_key);
```

**`BIGSERIAL`, not `UUID`.** `docs/schema/00-overview.md:61-70` reserves `BIGSERIAL` for pure
append-only logs where row order itself is meaningful, and `docs/schema/04-activity-log.md:31-38`
spells out the read pattern it serves: "give me the last N" and "events after event #X". That is
exactly how the export history is read — newest-first, keyset-paged on `id DESC`, never by page
number. Nothing outside this table references an export row except the self-reference below.

**`storage_key` is separate from `id` on purpose.** A download URL carrying `id` would be an
enumerable integer, so a user could walk other people's exports by incrementing it; a URL carrying
`storage_path` would leak the disk layout. `storage_key` is an opaque UUID with a unique index,
minted per export, and it is the only handle the API ever exposes.

**`byte_size` and `sha256` are not decoration.** They let the Master notice that the file on disk has
been truncated, replaced or removed under it and say so, instead of streaming a corrupt PDF to a
customer. There is no retention policy for these files — that gap is named in
`docs/BACKEND_MODULES.md` §8.3 and is not closed here — so the disk *will* accumulate, and a
detectable mismatch is what makes a future pruner safe to write.

**`rates_included` is the one column that could not be reconstructed later.** The locked rule is
that a redacted rate is **absent**, never null and never zero. A PDF rendered for someone without
`field.saleRate.view` therefore looks exactly like a PDF rendered from a template with
`show_rates = false`. Without this column, a reader six months later cannot tell "the rates were
withheld from this person" from "this template never prints rates" — and those are different facts
about a document that may have been sent to a customer. The template's own `show_rates` is not a
substitute: the template may have been edited since.

**`subject_id` has no foreign key, deliberately.** It points at either `leads` or `orders` depending
on `subject_type`, and PostgreSQL has no polymorphic foreign key. This is the same shape as
`line_items.parent_id` (`20260302:171-176`) and `timeline_entries.parent_id` (`20260302:214-225`),
both of which carry a `parent_type` `CHECK` and no key; the precedent is established and consistent.

**`template_name` is frozen alongside `template_id`.** The same snapshot discipline that
`line_items` applies to product attributes (`20260302:180-189`, "snapshotted at add time and frozen
from then on"): renaming a template must not rewrite the history of documents produced under the old
name. `template_id` stays as a live link for "show me everything this template produced".

**`superseded_by` is a self-reference, not a status column.** Re-rendering the same document after an
edit does not delete the old file; it writes a new row and points the old one at it. That keeps the
question "what exactly did we send the customer on the 14th" answerable, which is the entire reason
this table exists rather than a cache directory.

**And it has a named writer — a column nothing writes is the same defect as a permission nothing
enforces.** `POST /api/documents/render` (`04-API-CONTRACT.md` §6.4), inside the same transaction
that inserts the new row, looks up the most recent non-superseded export for
`(tenant_id, subject_type, subject_id, document_type)` and stamps it:

```sql
-- after the INSERT … RETURNING id that produced :newId
UPDATE document_exports
   SET superseded_by = :newId
 WHERE tenant_id     = :tenantId
   AND subject_type  = :subjectType
   AND subject_id    = :subjectId
   AND document_type = :documentType
   AND superseded_by IS NULL
   AND deleted_at    IS NULL
   AND id           <> :newId;
```

`idx_document_exports_subject (tenant_id, subject_type, subject_id, id DESC)` serves that predicate
directly — `document_type` and the two null tests are filters on the handful of rows one subject has
ever produced, not a scan. The `UPDATE` is unconditional over the matched set rather than "the newest
one" on purpose: if an earlier render ever failed to stamp, this repairs the chain instead of
leaving two open heads. Nothing else in the schema writes this column.

**Two conventions for "which user did this", and this table uses both.** `rendered_by_user_id`
carries a real foreign key into `users(id)`, matching `leads.created_by_user_id` and its siblings,
whose keys `20260303:208-213` restored after the id type change. `deleted_by` carries none, matching
`roles.deleted_by` and `users.deleted_by` (`20260303:114-126`), which are plain `TEXT`. The repository
genuinely has two conventions here; each column below follows whichever one its neighbours follow,
and unifying them is not this batch's job. `deleted_by` is written from `actorUserId()`
(`master/src/domain/actor.ts:31-33`), which returns a user id or `NULL` — never a panel id — so an
unattended panel's action is recorded as `NULL` rather than a borrowed identity.

**`rendered_by_panel_id` is `UUID` while `rendered_by_user_id` is `TEXT`.** That is not an
inconsistency: `office_panels.id` is still a `UUID` (`20260303` converted only `roles` and `users` to
text ids), and `users.id` is text. Two typed columns with two real foreign keys beat one polymorphic
`TEXT` column with a discriminator — `activity_log.actor_id` has to be polymorphic because it logs
`system` actors too, and it pays for that with no foreign key at all.

**`deleted_at` / `deleted_by` on an append-only table.** They let an export be withdrawn from the
history feed without breaking a `superseded_by` chain. The Recycle Bin does **not** list exports —
that is now decided (§12.2) — and these columns are not for it; withdrawing a row from a feed and
restoring a row from a bin are different capabilities, and only the first needs a PDF that may no
longer be on disk.

---

## 6. Altered tables

### 6.1 `leads`, `orders`, `parties`, `products` — soft delete

`20260305000000_soft_delete_columns.ts`, Phase A.

```sql
ALTER TABLE leads    ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN deleted_by TEXT;
ALTER TABLE orders   ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN deleted_by TEXT;
ALTER TABLE parties  ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN deleted_by TEXT;
ALTER TABLE products ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN deleted_by TEXT;
```

Both nullable, no default. Every existing row reads back `NULL`, which is exactly "not deleted" —
this migration cannot change the meaning of a single existing record.

The column names and types match `roles` and `users` verbatim (`20260303:114-126`), which is what
lets the Recycle Bin's cross-table `UNION ALL` project all six of these branches through one envelope
without per-table casting.

**The Bin's membership — and therefore its indexes — grows across stages rather than shipping
frozen.** `RECYCLE_BIN_ENTITIES` is `04-API-CONTRACT.md` §4.1's constant, staged there; the schema
side of that staging is:

| Stage | Migration | Bin partial indexes created | Entities added |
|---|---|---|---|
| 2 — Recycle Bin | `20260305` | 6 — `leads`, `orders`, `parties`, `products`, `roles`, `users` | `lead`, `order`, `party`, `product`, `role`, `user` |
| 3 — Fields | `20260306` | 2 — `option_lists`, `custom_field_definitions` | `option_list_item`, `custom_field_definition` |
| 6 — PDF Designer | `20260308` | 1 — `document_templates` | `document_template` |

Nine tables, nine partial indexes, arriving in three instalments. A gate that asserts the `UNION ALL`
has N branches belongs to the stage at which N branches exist — asserting nine at Stage 2 fails
against a correct build.

**These four tables are the first delete path the product has ever had for business records.** There
is no `deleteLead`, `deleteOrder`, `deleteParty` or `deleteProduct` anywhere today — the `is_active`
columns on `parties` and `products` are read-filtered in five places but written by nothing, a dead
switch. This migration does not fix that; it gives the delete path somewhere to write.

Phase B — the Bin's keyset indexes, on all six soft-deletable tables:

```sql
CREATE INDEX idx_leads_deleted    ON leads    (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_orders_deleted   ON orders   (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_parties_deleted  ON parties  (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_products_deleted ON products (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_roles_deleted    ON roles    (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_users_deleted    ON users    (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
```

`roles` and `users` have carried `deleted_at` since `20260303` and have **no** such index today —
`listDeletedRoles` and `listDeletedUsers` scan. At two soft-deleted roles that never mattered; as one
branch of a multi-way `UNION ALL` paged by cursor it does.

The column order is the cursor's sort key. The Bin pages on `(deleted_at, id)` descending, so a
composite in that order serves both the ordering and the `WHERE (deleted_at, id) < (…)` seek. The
partial predicate means each index holds only tombstones — on a table of 200,000 live leads and 40
deleted ones, the index is 40 entries, and the insert cost on every live row is zero because a row
with `deleted_at IS NULL` never enters it.

Phase C — two existing partial indexes gain the new predicate:

```sql
DROP INDEX idx_leads_open;
CREATE INDEX idx_leads_open
    ON leads (tenant_id) WHERE converted_order_id IS NULL AND deleted_at IS NULL;

DROP INDEX idx_leads_followup;
CREATE INDEX idx_leads_followup
    ON leads (tenant_id, follow_up_date)
    WHERE follow_up_date IS NOT NULL AND deleted_at IS NULL;
```

Both back dashboard counts (`countOpenLeads`, `countFollowUpsDue`), and both of those queries must
now add `deleted_at IS NULL` or a deleted lead keeps being counted as open. A partial index is usable
only when the query's predicate implies the index's, so extending the index predicate alongside the
query predicate keeps it usable *and* makes it tighter. Leaving them alone would still work — the
query implies the narrower old predicate — but would scan tombstones on every dashboard refresh.

**What a soft delete writes is not just these two columns.** See §9.2: on `leads`, `orders`,
`parties` and `products` a delete must also advance `hlc` and stamp `field_hlc.deleted_at`, because
these four are syncable and `roles`/`users` are not.

**Two read paths must be updated or the columns are decorative.** `parties` and `products` carry
`search_vector` maintained by `BEFORE INSERT OR UPDATE` triggers (`20260302:639-645`); a soft delete
is an UPDATE, so the trigger re-runs and recomputes an identical vector — harmless — but the deleted
row stays in the GIN index and will keep matching searches until `search.repository.ts` adds
`deleted_at IS NULL` beside the `is_active` filter it already applies. Likewise `findProductByCode`
(`master/src/repositories/product.repository.ts:79-88`) filters neither, which matters immediately —
see §6.2.

### 6.2 The unique-index correction on `parties` and `products`

`20260305000000_soft_delete_columns.ts`, Phase D.

```sql
DROP INDEX idx_parties_code_tenant;
CREATE UNIQUE INDEX idx_parties_code_tenant
    ON parties (tenant_id, party_code) WHERE deleted_at IS NULL;

DROP INDEX idx_products_code_tenant;
CREATE UNIQUE INDEX idx_products_code_tenant
    ON products (tenant_id, product_code) WHERE deleted_at IS NULL;
```

`DROP INDEX`, not `ALTER TABLE … DROP CONSTRAINT`. The originals were created as indexes at
`20260301:149-150` after the underlying constraints were dropped at `:144-145`; the constraint names
no longer exist, so the `ALTER TABLE` form fails with `constraint … does not exist` and takes the
whole migration down with it.

**Why the predicate matters, precisely — and where it does not.** The two tables are not the same
case, and saying so is worth more than one blanket claim:

- **`products` is the load-bearing case.** `product_code` is human-supplied:
  `master/src/services/catalog.service.ts:159` uses `input.productCode?.trim()` and only falls back
  to `nextProductCode()` when it is blank, and `:206-207` makes it mandatory on edit. It is the code
  printed on the box and scanned off it. A product entered under the wrong code, deleted, and
  re-entered under the right one must not be blocked forever by the tombstone — and the same catalogue
  code being reissued after a mistake is an ordinary Tuesday, not an edge case. Without the partial
  predicate, a soft delete reserves that code for the life of the installation.
- **`parties` is a consistency case, not a defect fix.** `party_code` comes from a PostgreSQL
  sequence (`master/src/repositories/party.repository.ts:71-75`, `'P-' || lpad(nextval('party_code_seq')…)`),
  which never rewinds, so no live party can ever collide with a deleted one's code today. It gets the
  same treatment anyway, so that "uniqueness in this schema is over live rows" is a rule with no
  exceptions to remember, matching `roles_name_unique` and `users_username_unique`
  (`20260303:222-237`) — whose migration comment states the principle outright.

**The DDL alone does not free the code, and this is the trap.** `findProductByCode`
(`product.repository.ts:79-88`) filters neither `is_active` nor `deleted_at`, and
`catalog.service.ts:161` and `:209` raise a 409 from its result. So after this migration the database
would permit reusing a deleted product's code while the service still refuses it — the index would be
silently pointless. **`findProductByCode` must gain `.whereNull('p.deleted_at')`**, and the Recycle
Bin's restore path must then handle the reverse collision: restoring a product whose code has since
been reissued is a 409 carrying `suggestRestoredName`'s answer in `details`, which is why the socket
ack's `details` field is a prerequisite for that module.

One more mismatch worth recording, pre-existing and not widened here: the service's duplicate check
is case-**insensitive** (`lower(p.product_code) = lower(?)`) while the index is case-**sensitive**
(plain `product_code`). The service is strictly the stricter of the two, so no database error can
escape to a user — but the index is not the guard, and anyone who assumes it is will be surprised.

### 6.3 `option_lists` — the full base-column set, plus `hex`

`20260306000000_field_values_and_stage_ordering.ts`, Phases A and B. `option_lists` is the barest
table in the schema: seven columns, no timestamps, no authorship, no soft delete
(`20260301:286-296`). The Fields module makes it editable, so it needs the rest.

```sql
ALTER TABLE option_lists
  ADD COLUMN hex        TEXT,
  ADD COLUMN created_by TEXT,
  ADD COLUMN updated_by TEXT,
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by TEXT,
  ADD COLUMN version    INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE option_lists
  ADD CONSTRAINT option_lists_hex_format
  CHECK (hex IS NULL OR hex ~ '^#[0-9A-Fa-f]{6}$');
```

**Existing rows.** The six seeded `lead.sourcePlatform` rows would otherwise claim they were created
the day this migration ran, which is false and would sort them to the top of any "recently changed"
view. One statement fixes it:

```sql
UPDATE option_lists o
   SET created_at = t.created_at, updated_at = t.created_at
  FROM tenants t
 WHERE t.id = o.tenant_id;
```

"As old as the installation" is not exactly right either — they were created by `20260301` — but it
is true to within the setup, and it is honest in a way that "created today" is not.

**`version`, but no `hlc`, no `field_hlc`, no `temporary_id`.** `option_lists` is not syncable and
this batch does not make it so (§9.4). It gains `version` anyway, and the distinction is the same one
`document_templates` draws in §9.3: `hlc` answers "which of two disconnected edits happened first"
and needs disconnected edits to be possible, which they are not here; `version` answers "did somebody
save while I had this form open", which two administrators in two browsers can ask each other in the
next minute. Without it, `assertVersionMatches` (`master/src/domain/access.ts:183-192`) — mandatory
on every other edit path in the product — would have an unexplained exception on exactly the screen
where two people curate the same short list. `expectedVersion` is therefore **mandatory** on
`PUT /api/fields/values/:id`, and a stale save is a 409 carrying `storedVersion`
(`04-API-CONTRACT.md` §5.3).

`DEFAULT 1` means the six existing `lead.sourcePlatform` rows and every row Phase D seeds start at
version 1 with no back-fill statement, and every write path bumps it in the same `UPDATE` that
touches the row.

**`hex` is nullable and the back-fill leaves it `NULL`.** A colour with no hex renders through the
two-letter ring fallback the design already specifies, so `NULL` is a working state, not a missing
one. The format `CHECK` restricts it to canonical six-digit form: one representation means string
equality is colour equality, and — as with `document_templates.accent_colour` (§5.2) — the value goes
straight into a browser style attribute, where an unconstrained string is a way to make an offline
application reach for the network.

**`is_active` and `deleted_at` are different things and both stay.** `is_active` means "configured,
but hidden from pickers" — the value still renders on records that carry it and can be switched back
on in place. `deleted_at` means "removed", it goes to the Recycle Bin, and restoring it is a Bin
operation gated by the entity's own delete key. The Fields screen exposes both because operators want
both, and conflating them at the schema level would force one to mean the other. Note the existing
asymmetry: `listOptions` (`master/src/repositories/custom-field.repository.ts:55-70`) returns inactive
rows and lets callers filter, which is fine for `is_active`; it must **not** do that for `deleted_at`,
because `optionLists` travels inside the `SyncSnapshot` and a deleted value that reaches a panel is
rendered offline forever. The `deleted_at IS NULL` filter belongs in the repository, not the caller.

Both repositories cache per tenant (`optionCache`, `fieldCache`) and expose
`invalidateFieldCache(tenantId)`, whose only callers today are the test fixtures. Every new write
path must call it, or a delete is invisible until the process restarts.

The unique index becomes partial, for exactly the reason the party/product one does — removing
"Ivory" and adding it back next season must be possible without an administrator hunting for a
tombstone:

```sql
DROP INDEX idx_option_lists_key_value;
CREATE UNIQUE INDEX idx_option_lists_key_value
    ON option_lists (tenant_id, list_key, value) WHERE deleted_at IS NULL;

CREATE INDEX idx_option_lists_deleted
    ON option_lists (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
```

> **A partial unique index changes every `ON CONFLICT` that names it.** PostgreSQL matches an
> `ON CONFLICT` inference specification against a unique index only if the statement repeats the
> index's predicate. After this change, `ON CONFLICT (tenant_id, list_key, value) DO NOTHING` fails
> with *there is no unique or exclusion constraint matching the ON CONFLICT specification*. Every
> such statement — including the seed in Phase D of this same migration — must be written
> `ON CONFLICT (tenant_id, list_key, value) WHERE deleted_at IS NULL DO NOTHING`.

#### 6.3.1 The colour back-fill

Phase D seeds three new `list_key`s from the values already present in the data. The list keys are
inlined literals in the migration file, never imported from `@orderbook/shared`.

**All four keys exist once `20260306` has run.** `FIELD_LIST_KEYS` has four members —
`'lead.sourcePlatform'`, `'stock.colour'`, `'product.productType'`, `'line.packaging'`
(`04-API-CONTRACT.md` §5.1 owns the constant). The fourth, `lead.sourcePlatform`, is not seeded here
because `20260301:315-323` already seeded its six rows; the three below complete the set. **Only
`stock.colour` is hex-bearing** — a source platform, a product type and a packaging kind have no
colour to render, so their rows leave `hex` `NULL` permanently and the Fields screen offers no
swatch for them.

| `list_key` | Sources |
|---|---|
| `stock.colour` | `inventory_stock.colour`, `line_item_quantities.colour` (joined to `line_items` for the tenant), `stock_movements.colour`, `stock_reservations.colour`, `products.color` |
| `product.productType` | `products.product_type`, `line_items.product_type`, `party_product_variants.product_type` |
| `line.packaging` | `line_items.packaging`, `party_product_variants.packaging` |

```sql
INSERT INTO option_lists (id, tenant_id, list_key, value, label, sequence, is_active, hex)
SELECT gen_random_uuid(), :tenant, 'stock.colour', v,
       v,                                            -- label starts equal to value
       row_number() OVER (ORDER BY lower(v)),
       true,
       NULL                                          -- hex assigned by a human, later
  FROM (
        SELECT DISTINCT colour AS v FROM inventory_stock       WHERE tenant_id = :tenant
    UNION SELECT DISTINCT q.colour FROM line_item_quantities q
            JOIN line_items li ON li.id = q.line_item_id AND li.tenant_id = :tenant
    UNION SELECT DISTINCT colour FROM stock_movements          WHERE tenant_id = :tenant
    UNION SELECT DISTINCT colour FROM stock_reservations       WHERE tenant_id = :tenant
    UNION SELECT DISTINCT color  FROM products                 WHERE tenant_id = :tenant
  ) s
 WHERE v IS NOT NULL AND btrim(v) <> ''
 ON CONFLICT (tenant_id, list_key, value) WHERE deleted_at IS NULL DO NOTHING;
```

`line_item_quantities` has **no** `tenant_id` of its own (`20260302:206-212`), so the tenant filter
must come through the join to `line_items`. `products.color` is the US spelling from
`20260101:103` — the one column a grep for `colour` misses entirely.

**Case is preserved exactly and nothing is trimmed or folded.** `'White'` and `'white'` become two
rows, because they are already two `inventory_stock` rows, two reservations and two ledger lines:
uniqueness is enforced case-sensitively by `idx_inventory_product_colour` and
`idx_line_item_qty_colour`, and `stockKey(productId, colour)` composes the raw string. Folding them
here would produce one option row for two stocks of goods, and whichever spelling lost would render
as "not in the list" — or worse, a later rename of the surviving option would orphan the other's
stock. `label` starts equal to `value` so an administrator can rename the *display* later without
ever touching the identity the records hold.

**This seed reads `stock_movements`; the runtime usage count does not.** `docs/BACKEND_MODULES.md`
§5.4 drops `stock_movements` from the "in use by" count because no index leads with `colour` on it
and it is the ledger that grows into the millions. That is a decision about a query run every time
somebody opens the Fields screen. This is a single `GROUP BY` at migration time, once per
installation, and omitting the ledger would mean a colour that exists only in dispatch history is
absent from the list an operator is asked to curate. The two answers differ because the questions do.

#### 6.3.2 What is deliberately *not* touched

`stockKey()` (`master/src/domain/stock-key.ts`) and the five colour columns stay exactly as they are.
No `colour_id`, no foreign key, no normalisation of the string.

A colour's identity **is** its string, at every hop from the Office Panel's free-text input through
`normalizeQuantities`, `line_item_quantities`, the reservation matcher, the ledger and
`inventory_stock`'s composite unique key. Introducing an id would mean rewriting five columns, the
composite key, the reservation matcher and the append-only ledger — and it would make "removing a
value never touches the records that used it" false, because removal would dangle a reference.

What this batch adds is a **descriptor row beside the string**, not a replacement for it. A colour
with an `option_lists` row gets a label, a hex chip and a place in a curated order; a colour without
one is still a perfectly ordinary colour that renders through the fallback. Removing a value sets
`deleted_at`; records keep their string; the UI keeps rendering it. That is what makes the promise
true rather than aspirational, and it is the same reason `HANDOFF.md` names `stockKey()` as a trap:
two call sites that disagreed about the format produced keys that never matched, and reservations
silently read as zero.

### 6.4 `custom_field_definitions`

`20260306000000`, Phase A. This table already has `created_at` and `updated_at`
(`20260301:298-312`); it needs the soft-delete pair, the same `version` column `option_lists` gains
for the same reason (§6.3), and the same index rework.

```sql
ALTER TABLE custom_field_definitions
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by TEXT,
  ADD COLUMN version    INTEGER NOT NULL DEFAULT 1;

DROP INDEX idx_custom_fields_key;
CREATE UNIQUE INDEX idx_custom_fields_key
    ON custom_field_definitions (tenant_id, entity, key) WHERE deleted_at IS NULL;

CREATE INDEX idx_custom_fields_deleted
    ON custom_field_definitions (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
```

Existing rows: none. No custom field definition is seeded by any migration, so this is columns on an
empty table for every installation that exists today — `version INTEGER NOT NULL DEFAULT 1` rewrites
nothing because there is nothing to rewrite. `expectedVersion` is **mandatory** on
`PUT /api/fields/definitions/:id`, with the same 409-carrying-`storedVersion` answer
(`04-API-CONTRACT.md` §5.4).

The partial predicate matters more here than anywhere else in the batch. A custom field's `key` is
what its values are stored under inside `leads.custom_fields`, `orders.custom_fields`,
`parties.custom_fields` and `products.custom_fields` — all `JSONB`. Deleting the definition does not
remove the values, and re-adding a field under the same key must therefore be possible, because that
is precisely how an operator recovers a definition they deleted by mistake: the data was never gone.
A non-partial unique index would make that recovery impossible and the values unreachable forever.

`created_by` / `updated_by` are **not** added. The table has no authorship columns today, and
`activity_log` records who changed a definition and when with a hash-chained guarantee that two
`TEXT` columns cannot match. Adding them would be a second, weaker answer to a question already
answered.

### 6.5 `pipeline_stages` — ordering and archiving

`20260306000000`, Phases B and C.

```sql
ALTER TABLE pipeline_stages
  ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE pipeline_stages
  ADD CONSTRAINT pipeline_stages_archived_not_default
  CHECK (NOT (is_archived AND is_default));
```

Existing rows: the nine seeded stages all take `false`, and none is both archived and default, so the
`CHECK` passes on every installation.

**Why `is_archived` and not `deleted_at`.** `pipeline_stages` is the only configurable value set in
the product referenced by a real foreign key: `leads.stage_id` and `orders.stage_id` are
`UUID NOT NULL REFERENCES pipeline_stages(id)` (`20260302:119, :147`), plus the two nullable keys on
`timeline_entries` (`20260302:221-222`). PostgreSQL will refuse to delete a stage that holds records,
which means a "soft delete" here would be a soft delete of something that can never be hard-deleted
— a Recycle Bin entry that promises a restore nobody ever needed. What operators actually want is to
stop *new* records landing in a stage while every record already in it keeps rendering. That is
archiving, and it is a different word for a reason. **`pipeline_stages` is therefore not a Recycle
Bin entity.**

The `CHECK` makes "you cannot archive the stage new records land in" a database guarantee rather than
an application convention, in the same spirit as the one-default partial index below.

#### 6.5.1 Reordering needs a deferrable constraint

```sql
DROP INDEX idx_pipeline_stages_seq;

ALTER TABLE pipeline_stages
  ADD CONSTRAINT pipeline_stages_seq_unique UNIQUE (pipeline_id, sequence)
  DEFERRABLE INITIALLY IMMEDIATE;
```

`idx_pipeline_stages_seq` is a unique **index** (`20260301:253`), and **a unique index cannot be
`DEFERRABLE`** — only a table constraint can. Dragging stage 3 above stage 1 means writing sequences
that transiently collide; with an immediate unique check, the first `UPDATE` of the reorder fails and
the operation is unimplementable without a temporary-offset dance (shift everything by +1000, then
shift back) that leaves the table in a bogus state if anything throws between the two passes.

`ADD CONSTRAINT … UNIQUE` builds its own backing index named after the constraint, so the old index
must be dropped first. The rebuild cost is nil — a tenant has two pipelines of four or five stages
each.

`INITIALLY IMMEDIATE` keeps the default behaviour for every ordinary write; only the reorder
transaction opts in:

```sql
BEGIN;
  SET CONSTRAINTS pipeline_stages_seq_unique DEFERRED;
  -- one UPDATE per stage, in any order, transiently duplicating sequences
COMMIT;   -- the constraint is checked here, once, on the final state
```

#### 6.5.2 Swapping the default stage cannot use the same trick

```sql
-- unchanged: CREATE UNIQUE INDEX idx_pipeline_stages_one_default
--              ON pipeline_stages(pipeline_id) WHERE is_default;      (20260301:260-263)
```

This one is a **partial** unique index, and PostgreSQL unique *constraints* cannot carry a `WHERE`
clause, so it genuinely cannot be converted into a deferrable constraint. It stays exactly as it is,
and the write path works around it by ordering:

```sql
UPDATE pipeline_stages SET is_default = false WHERE pipeline_id = $1 AND is_default;
UPDATE pipeline_stages SET is_default = true  WHERE id = $2;
```

**Clear, then set — never set, then clear.** The index forbids *two* defaults; it says nothing about
*zero*. Clear-then-set passes through the legal intermediate state of no default; set-then-clear
passes through the illegal state of two and fails on the first statement. Both statements run in one
transaction, so the zero-default state is never visible to another reader.

The identical rule applies to `document_templates_one_default` (§5.2). Writing it down twice is
cheaper than rediscovering it twice.

### 6.6 `activity_log` — `actor_name`

`20260307000000_activity_log_actor_name.ts`, Phases A and C. The trigger surgery it requires is
specified in §7.

```sql
ALTER TABLE activity_log ADD COLUMN actor_name TEXT;
```

Nullable, no default, no index. Not indexed because it is display-only — every filter the Logs
module offers is on `actor_type` + `actor_id`, `action`, `entity_type` + `entity_id` or `created_at`,
and an index on a denormalised name would be maintained on the hottest append-only table in the
schema to serve nothing.

**Why the column exists at all.** `activity_log` stores `actor_type` and `actor_id` and nothing else;
resolving a display name needs a join, and the join fails exactly when it matters most — a user who
has been deleted, or a panel that has been unpaired, leaves an entry whose actor column renders as an
opaque `US0000000007`. An audit trail that cannot name who did it is doing half its job. Denormalising
is right here for the same reason `line_items` snapshots the product name: the log records what was
true when the event happened, and renaming a user afterwards must not rewrite history.

**`NULL` means "could not be resolved", not "not recorded".** After the backfill, `NULL` occurs only
for `actor_type = 'system'` rows and for historical rows whose actor id matches nothing. Going
forward every insert sets it, because the write signature is `recordActivity(entry, actor, trx)` and
derives the name inside — making "forgot to set it" a compile error rather than a column that works
for backfilled history and is `NULL` for everything after, which would be worse than not having the
column.

**The signature change lands in Stage 1 (foundation), not here.** The `actor` parameter is harmless
before this column exists — it is simply not persisted yet — and introducing it early means the
Recycle Bin (Stage 2) and Fields (Stage 3) are written once against the final three-argument form
rather than swept later. This migration is what adds the column and starts persisting what that
argument already carries. `recordDetachedActivity` remains forbidden in new modules.

The backfill:

```sql
UPDATE activity_log a
   SET actor_name = u.display_name
  FROM users u
 WHERE a.actor_type = 'user' AND a.actor_id = u.id;

UPDATE activity_log a
   SET actor_name = p.name
  FROM office_panels p
 WHERE a.actor_type = 'office_panel' AND a.actor_id = p.id::text;
```

> **The `::text` cast on the second statement is mandatory.** `activity_log.actor_id` became `TEXT`
> at `20260303:173`, but `office_panels.id` is still `UUID` — `20260303` converted only `roles` and
> `users` to text primary keys. PostgreSQL will not compare `text` to `uuid` implicitly, and the
> statement fails outright without the cast rather than quietly matching nothing.

The first statement needs no cast: `users.id` is `TEXT`, and the user-shaped `actor_id` values were
rewritten from UUIDs to `US…` ids at `20260303:174-177`.

---

## 7. The hash chain, and the proof that `actor_name` is outside it

`activity_log` is append-only by trigger and hash-chained per tenant. Adding a column to it is not
an ordinary `ALTER`, and the backfill above is an `UPDATE` on a table that refuses `UPDATE`. This
section states exactly what exists, so the change can be checked rather than trusted.

### 7.1 What exists today

Three triggers, all created at `20260303:281-284` and `:305-318`:

| Trigger | Timing | Function | Effect |
|---|---|---|---|
| `activity_log_chain_trg` | `BEFORE INSERT … FOR EACH ROW` | `activity_log_chain()` | assigns `sequence`, `prev_hash`, `hash` |
| `activity_log_no_update` | `BEFORE UPDATE … FOR EACH ROW` | `activity_log_immutable()` | `RAISE EXCEPTION 'activity_log is append-only'` |
| `activity_log_no_delete` | `BEFORE DELETE … FOR EACH ROW` | `activity_log_immutable()` | same |

`activity_log_chain()` (`20260303:250-284`) does three things in order:

1. `PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text))` — serialises appends per tenant for
   the life of the transaction. Without it two concurrent inserts read the same predecessor and the
   chain forks.
2. Reads the predecessor: `SELECT hash, sequence … WHERE tenant_id = NEW.tenant_id ORDER BY sequence DESC LIMIT 1`,
   then sets `NEW.sequence := COALESCE(last_seq, 0) + 1` and
   `NEW.prev_hash := COALESCE(last_hash, repeat('0', 64))`. The genesis predecessor is 64 zeros.
3. Computes the digest, inline, at `20260303:268-276`.

**The digest input, exactly — eight expressions joined by `|`:**

```
prev_hash | sequence::text | entity_type | entity_id | action | actor_type |
COALESCE(actor_id, '') | COALESCE(details::text, '')
```

sha256 over the UTF-8 bytes of that string, hex-encoded.

**Columns that do not participate:** `id`, `tenant_id`, `created_at` — and, from
`20260307` onwards, `actor_name`.

`20260303:286-303` backfilled rows that predate chaining: `sequence` from
`ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY id)`, then `prev_hash = repeat('0', 64)` and the
literal `hash = 'pre-chain'`. Those rows are marked rather than given a forged digest, deliberately —
claiming a verified chain over entries written before chaining existed would be a lie. Any verifier
must treat `hash = 'pre-chain'` as "unverifiable", not as "broken".

**`hash` is served, not just verified.** `ActivityLogEntry` carries it as `hash: string | null`
(`04-API-CONTRACT.md` §2.1), covered by `logs.view` like every other column of the entry. It is the
only thing that makes "hash-chained" visible to a person rather than a claim in a document: an
operator reading the Logs screen sees the Entry-hash column and can hand a value to someone who
re-derives it. A row with `hash = 'pre-chain'` is served as `null`, matching `chained: false`.

### 7.2 Why adding `actor_name` is safe

Four independent reasons, each checkable:

1. **It is not in the digest input.** The eight expressions above are the complete list; `actor_name`
   is not among them, and no wildcard or row-level construct (`NEW.*`, `to_jsonb(NEW)`) appears
   anywhere in the function.
2. **The digest is computed in a `BEFORE INSERT` trigger.** A column added afterwards cannot
   retroactively enter a value that was already computed and stored, whatever the function is later
   changed to.
3. **The backfill writes only `actor_name`.** `hash`, `prev_hash`, `sequence` and every hashed column
   are untouched, so recomputing the digest of any row before and after the migration yields the same
   64 hex characters. The chain verifies identically.
4. **`activity_log_chain_trg` is `BEFORE INSERT` only.** An `UPDATE` does not fire it and cannot
   cause a hash to be re-derived from the new row.

### 7.3 Extracting `activity_log_row_hash()`

Chain verification must run **in SQL**, not in Node. The digest covers `details::text` — PostgreSQL's
own `jsonb` rendering, with key order and whitespace normalised on storage, not the bytes the
application sent through `JSON.stringify`. Node cannot reproduce those bytes reliably, so the verifier
must ask the same engine that wrote them. That means the digest expression has to exist in exactly
one place, callable from both the trigger and the verifier.

```sql
CREATE FUNCTION activity_log_row_hash(
  prev_hash   TEXT,
  seq         BIGINT,
  entity_type TEXT,
  entity_id   TEXT,
  action      TEXT,
  actor_type  TEXT,
  actor_id    TEXT,
  details     JSONB
) RETURNS TEXT AS $$
  SELECT encode(sha256(convert_to(
      prev_hash                    || '|' ||
      seq::text                    || '|' ||
      entity_type                  || '|' ||
      entity_id                    || '|' ||
      action                       || '|' ||
      actor_type                   || '|' ||
      COALESCE(actor_id, '')       || '|' ||
      COALESCE(details::text, ''), 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;
```

The body is character-for-character the expression currently inline at `20260303:268-276`, with
`NEW.` stripped and `NEW.sequence` renamed to `seq` (`sequence` is a reserved word in enough contexts
to be worth avoiding). `IMMUTABLE` is correct: `jsonb_out`, `convert_to`, `sha256` and `encode` are
all immutable, so the same eight inputs always give the same digest — which is exactly the property
a verifier depends on.

Then the trigger function is redefined to call it:

```sql
CREATE OR REPLACE FUNCTION activity_log_chain() RETURNS trigger AS $$
DECLARE
  last_hash TEXT;
  last_seq  BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text));

  SELECT hash, sequence INTO last_hash, last_seq
    FROM activity_log
   WHERE tenant_id = NEW.tenant_id
   ORDER BY sequence DESC
   LIMIT 1;

  NEW.sequence  := COALESCE(last_seq, 0) + 1;
  NEW.prev_hash := COALESCE(last_hash, repeat('0', 64));
  NEW.hash      := activity_log_row_hash(
                     NEW.prev_hash, NEW.sequence, NEW.entity_type, NEW.entity_id,
                     NEW.action, NEW.actor_type, NEW.actor_id, NEW.details);

  RETURN NEW;
END $$ LANGUAGE plpgsql;
```

`CREATE OR REPLACE FUNCTION` preserves the function's OID, and triggers bind to the OID — so
`activity_log_chain_trg` continues to work without being dropped and recreated. Nothing about the
advisory lock, the predecessor read or the genesis value changes.

The verifier then re-walks a tenant's chain entirely in SQL, comparing each stored `hash` against
`activity_log_row_hash(...)` recomputed from that row's own columns and checking that `prev_hash`
equals the predecessor's `hash` and that `sequence` increments by one. The only existing chain
assertion in the repository is `master/tests/access.integration.test.ts:500-512`, which walks the
links but never recomputes a digest; this function is what lets a real verifier exist.

### 7.4 The backfill's trigger surgery, in order

```sql
-- Phase C, all inside the migration's single transaction
DROP TRIGGER activity_log_no_update ON activity_log;

--  … the two UPDATE statements from §6.6 …

CREATE TRIGGER activity_log_no_update
  BEFORE UPDATE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_immutable();
```

Four properties make this safe, and all four should be stated in the migration's own comment:

- **`activity_log_no_delete` is never dropped.** Deletes remain refused for the entire duration. The
  window is on updates only, and only for a statement that writes one unhashed column.
- **The whole migration runs in one transaction.** Knex sets no `disableTransactions`
  (`master/src/db/knex.ts:10-24`) and PostgreSQL DDL is transactional, so a crash between the `DROP`
  and the `CREATE` rolls back to a table that still refuses updates. There is no state in which the
  trigger is permanently missing.
- **`DROP TRIGGER` takes `ACCESS EXCLUSIVE` on `activity_log`.** No concurrent insert can interleave
  with the backfill, so the advisory lock's job is not being circumvented — it is being superseded by
  a stronger one for the duration.
- **`activity_log_immutable()` itself is untouched.** Only the trigger binding is removed and
  restored; the recreated trigger must be byte-identical to `20260303:311-313`.

---

## 8. Index inventory

### 8.1 `activity_log`, before and after

Today (`20260101:211-212`, `20260301:135`, `20260303`):

| Index | Columns | Status after `20260307` |
|---|---|---|
| `activity_log_pkey` | `(id)` | kept |
| `idx_activity_log_entity` | `(entity_type, entity_id)` | **replaced** — not tenant-prefixed |
| `idx_activity_log_created` | `(created_at)` | **dropped** — not tenant-prefixed, superseded |
| `idx_activity_log_tenant` | `(tenant_id)` | **dropped** — a strict prefix of two new indexes |

After:

```sql
DROP INDEX idx_activity_log_created;
DROP INDEX idx_activity_log_tenant;
DROP INDEX idx_activity_log_entity;

CREATE INDEX        idx_activity_log_feed     ON activity_log (tenant_id, id DESC);
CREATE INDEX        idx_activity_log_at       ON activity_log (tenant_id, created_at DESC);
CREATE INDEX        idx_activity_log_actor    ON activity_log (tenant_id, actor_type, actor_id, id DESC);
CREATE INDEX        idx_activity_log_action   ON activity_log (tenant_id, action, id DESC);
CREATE INDEX        idx_activity_log_entity   ON activity_log (tenant_id, entity_type, entity_id, id DESC);
CREATE UNIQUE INDEX idx_activity_log_sequence ON activity_log (tenant_id, sequence);

ALTER TABLE activity_log ALTER COLUMN sequence SET NOT NULL;
```

Each one, and why:

- **`idx_activity_log_feed`** — the unfiltered keyset pager. `WHERE tenant_id = $1 ORDER BY id DESC
  LIMIT $2` is the default Logs view and there is no index today that serves it.
- **`idx_activity_log_at`** — the date-range filter and the facets query. The critique found this
  missing from the Logs design: `idx_activity_log_created` is `(created_at)` alone, so a tenant-scoped
  date range cannot use it as a range scan. On a single-tenant installation the old index happens to
  work, which is exactly the kind of accident that breaks the day a second tenant exists.
- **`idx_activity_log_actor`** — "everything this person did".
- **`idx_activity_log_action`** — "every sign-in failure", the highest-value single filter in an
  audit trail.
- **`idx_activity_log_entity`** — "the full history of this order". Replaces the untenanted original
  rather than adding to it, so the net index count grows by one, not two.
- **`idx_activity_log_sequence` UNIQUE** — turns a trigger convention into a database guarantee. The
  chain's correctness rests on `sequence` being unique per tenant; today only the advisory lock
  enforces that, and an advisory lock is respected only by code that takes it. Every existing row
  already satisfies it (`20260303:289-295` assigned it by `ROW_NUMBER()`), so the index builds
  without conflict.
- **`SET NOT NULL` on `sequence`** — the `BEFORE INSERT` trigger always assigns it and constraints
  are evaluated on the final row, after `BEFORE ROW` triggers, so this cannot reject a legitimate
  insert. What it does reject is a future direct `INSERT` that bypasses the trigger, which would
  otherwise produce a chainless row that no verifier could distinguish from a gap.

That is seven indexes on the fastest-growing table in the schema, and the write cost is real. It is
accepted for one specific reason: every audited write for a tenant already serialises behind
`pg_advisory_xact_lock` in the chain trigger, so index maintenance is not, and cannot become, the
bottleneck on this table.

### 8.2 Report indexes

Also `20260307`, because Reports has no migration of its own.

```sql
CREATE INDEX idx_orders_dispatched
    ON orders (tenant_id, dispatched_at)
    WHERE dispatched_at IS NOT NULL AND deleted_at IS NULL;

DROP INDEX idx_stock_movements_reference;
CREATE INDEX idx_stock_movements_tenant_ref
    ON stock_movements (tenant_id, reference_type, reference_id);
```

`orders` has **no** index on `dispatched_at` today (`20260302:572-575` creates party, stage, owner
and created indexes only), and "dispatches by month" is the first report. The predicate references
`deleted_at`, which is why `20260305` must run first — a dependency worth checking in review, because
a migration that fails on a missing column takes the whole batch down at install time.

`idx_stock_movements_reference` (`20260201:15-18`) is `(reference_type, reference_id)` with no tenant
prefix. It backs the "has this order already moved stock" check that runs on every dispatch, and the
by-colour dispatch breakdown joins the same way; the replacement serves both and scopes to the
tenant.

**The replacement's shape matches the dispatch query exactly, and the match is worth stating.** The
breakdown joins `stock_movements m` on `m.tenant_id = o.tenant_id AND m.reference_type = 'order' AND
m.reference_id = o.id AND m.movement_type = 'outbound'`, so all three of
`idx_stock_movements_tenant_ref`'s columns are consumed as equality predicates in its own leading
order; `movement_type` is a filter applied to the handful of rows one order produced, not a fourth
key column, and the index is deliberately **non-partial** so the same index still serves the
`'inbound'` and `'adjustment'` lookups the receiving path does. `stock_movements` gained `tenant_id`
at `20260301:58-68`/`:128`, which is what makes the tenant-first prefix available at all.

`idx_stock_movements_created (created_at)` is also untenanted and is **left alone**. The dispatch
report buckets on `orders.dispatched_at` rather than on movement timestamps precisely so one order
lands in one bucket even when a dispatch crosses midnight, so nothing in this batch would use it.

**Top parties is anchored on `orders.dispatched_at`, and `idx_orders_party` does not serve it.** The
report is "dispatched value in the selected period" — goods that left, not business won — so the
predicate is the same one `idx_orders_dispatched` was created for:
`tenant_id = ? AND dispatched_at >= ? AND dispatched_at < ? AND deleted_at IS NULL`, grouped by
`party_id`. `idx_orders_party` is `(tenant_id, party_id)` (`20260302:572`), whose second column is
the *grouping* key and not the *filtered* one, so it can only be used by scanning every order the
tenant has ever raised. `idx_orders_dispatched (tenant_id, dispatched_at) WHERE dispatched_at IS NOT
NULL AND deleted_at IS NULL` is the index that serves this report: a range scan bounded by the
period, then a `HashAggregate` over the rows it returns — which is at most one period's dispatches,
not the table. **No new index is added for it**, and `idx_orders_party` stays for what it is actually
for: "every order for this party" on the party detail screen.

**No new index is needed for the other two reports either.** Leads-by-month uses `idx_leads_created
(tenant_id, created_at)` (`20260302:571`); lead outcomes group by `stage_id`, served by
`idx_leads_stage`. Saying so explicitly is the point — an index added "for reporting" that duplicates
an existing one is pure write cost.

### 8.3 Complete list of new indexes, by migration

| Migration | Created | Replaced | Dropped |
|---|---|---|---|
| `20260305` | 6 Bin indexes | `idx_parties_code_tenant`, `idx_products_code_tenant`, `idx_leads_open`, `idx_leads_followup` | — |
| `20260306` | `idx_option_lists_deleted`, `idx_custom_fields_deleted` | `idx_option_lists_key_value`, `idx_custom_fields_key`, `idx_pipeline_stages_seq` → `pipeline_stages_seq_unique` | — |
| `20260307` | `idx_activity_log_feed`, `_at`, `_actor`, `_action`, `_sequence`, `idx_orders_dispatched` | `idx_activity_log_entity`, `idx_stock_movements_reference` | `idx_activity_log_created`, `idx_activity_log_tenant` |
| `20260308` | 9 across 3 new tables — 2 on `document_assets`, 4 on `document_templates` (including the Bin index `idx_document_templates_deleted`), 3 on `document_exports` | — | — |
| `20260309` | — | — | — |

---

## 9. Sync base columns — who carries what, and why

`docs/ROLES_AND_USERS.md:29-39` names the full set: `tenant_id`, a text `id`, `created_by`/`created_at`,
`updated_by`/`updated_at`, `deleted_at`/`deleted_by`, `version`, `hlc`, `field_hlc`, `temporary_id`.
Carrying all of it is what makes a table a first-class syncable entity. Most tables should not be one.

### 9.1 The matrix, after this batch

| Table | `tenant_id` | id type | `version` | `hlc` / `field_hlc` | `temporary_id` | `deleted_at`/`_by` |
|---|---|---|---|---|---|---|
| `leads` | ✅ | text `LD…` | ✅ | ✅ | ✅ | **new** |
| `orders` | ✅ | text `OD…` | ✅ | ✅ | ✅ | **new** |
| `parties` | ✅ | text `PT…` | ✅ | ✅ | ✅ | **new** |
| `products` | ✅ | text `PR…` | ✅ | ✅ | ✅ | **new** |
| `roles` | ✅ | text `RL…` | ✅ | ✅ | ✅ | existing |
| `users` | ✅ | text `US…` | ✅ | ✅ | ✅ | existing |
| `option_lists` | ✅ | `UUID` | **new** | ✗ | ✗ | **new** |
| `custom_field_definitions` | ✅ | `UUID` | **new** | ✗ | ✗ | **new** |
| `pipeline_stages` | ✗ (via `pipeline_id`) | `UUID` | ✗ | ✗ | ✗ | ✗ (`is_archived`) |
| `document_templates` | ✅ | `UUID` | ✅ | ✗ | ✗ | **new** |
| `document_assets` | ✅ | `UUID` | ✗ | ✗ | ✗ | ✗ |
| `document_exports` | ✅ | `BIGSERIAL` | ✗ | ✗ | ✗ | **new** |
| `activity_log` | ✅ | `BIGSERIAL` | ✗ | ✗ | ✗ | ✗ (append-only) |

### 9.2 Soft-deleting a syncable entity stamps `hlc`

The four business tables carry `version`, `hlc` and `field_hlc`; `roles` and `users` carry them too
but have no `MutationKind`, so in practice they are never merged. Mirroring `softDeleteRole` exactly
onto a lead would therefore be wrong. The write is:

```sql
UPDATE leads
   SET deleted_at = now(),
       deleted_by = :actorUserId,           -- actorUserId(actor); NULL for an unattended panel
       version    = version + 1,
       hlc        = :nextHlc,               -- await nextHlc(trx)
       field_hlc  = field_hlc || jsonb_build_object('deleted_at', :nextHlc),
       updated_at = now()
 WHERE tenant_id = :tenantId AND id = :id AND deleted_at IS NULL;
```

Restore is the mirror image: `deleted_at = NULL`, `deleted_by = NULL`, `version + 1`, a **freshly
allocated** `hlc`, and `field_hlc.deleted_at` re-stamped with it.

Three things this does and one it does not:

- **`version` and `hlc` move together.** Bumping `version` without advancing `hlc` leaves a row the
  merge engine cannot interpret — one clock says the row changed, the other says it did not.
- **`field_hlc.deleted_at` appears only on the first delete.** That is correct and matches the
  `HANDOFF.md` trap: a create stamps `field_hlc` only for the fields it actually set, because marking
  every field as written at creation makes the first edit of a never-filled field look like a clash.
  A record that has never been deleted has never had `deleted_at` written, and its `field_hlc` should
  say so.
- **`deleted_at` is *not* added to `COLUMN_MAP`** (`master/src/services/sync.service.ts:79-124`) and
  no delete or restore `MutationKind` is minted. Deletes are Master-online-only, matching the
  roles/users precedent; propagation to panels goes through the existing `publishChange` /
  `ChangedEntity` path with a new `'restored'` `ChangeAction`. Because `mutation.fields` is filtered
  to keys present in `COLUMN_MAP`, a panel can never assert `deleted_at` over the wire.
- **What this does *not* do is stop a queued offline edit writing to a tombstone.** The merge is
  per-field: an offline edit to `notes` still finds its `baseFieldHlc.notes` matching the stored
  `field_hlc.notes` — the delete did not touch that field — and is accepted. Only the service-layer
  rejection when `deleted_at IS NOT NULL` prevents it. The `hlc` stamp is what makes the row's history
  interpretable and what a future delete `MutationKind` would merge against; it is deliberately inert
  for merge today, and pretending otherwise would be a false sense of safety.

One operational consequence: `nextHlc(trx)` takes the `master_clock` row lock, which the roles/users
delete path never did. Deleting a lead now serialises against every other clock-stamping write, like
every ordinary edit already does.

### 9.3 Why `document_templates` uses a `UUID` and does not sync

Four reasons, in order of weight:

1. **There is no offline create.** The Office path for every module in this batch is forwarded live
   and fails hard offline with `503 { error: 'unavailable' }`; nothing is queued into the outbox. A
   text id with a prefix exists to let a panel mint an identifier before the Master has seen the
   record — a problem that does not arise here. A `UUID` generated in application code (the house
   default, `docs/schema/00-overview.md:61-70`) is enough.
2. **`ENTITY_PREFIX` is a bijection over the syncable entities** (`shared/src/sync/ids.ts`; twelve
   since `product_variant`/`VR` joined in 2026-09). Adding one more means a `MutationKind`, a
   `MUTATION_PERMISSIONS` entry, a `COLUMN_MAP` entry, an `id_sequences` seed and a
   `PREFIX_TO_ENTITY` inverse — five coordinated additions to buy a capability nobody asked for.
   (The product variant took only the prefix and the `id_sequences` seed: it is never mutated on
   its own, only as the `variants` field of a product.)
3. **`layout` is not field-mergeable.** `field_hlc` keys by flat column name; a nested block-layout
   document has no flat field names, so two offline edits to different blocks are indistinguishable
   from two edits to the same one. The merge engine would either accept both and corrupt the layout
   or record a conflict on every edit. A design that cannot be merged should not claim to be
   mergeable.
4. **The precedent is unanimous.** `pipelines`, `pipeline_stages`, `option_lists`,
   `custom_field_definitions`, `office_panels` and `inventory_stock` are all `UUID`-keyed,
   non-syncable, and reach panels one-way inside the `SyncSnapshot`. Configuration flows outward;
   business records flow both ways.

It **does** carry `version`, and that is not a contradiction. `version` answers "did somebody save
while I had this form open" — a question two administrators in two browsers on the same LAN can ask
each other in the next minute. `hlc` answers "which of two disconnected edits happened first", which
requires disconnected edits to be possible. `docs/ROLES_AND_USERS.md:29-39` states the distinction;
this table is the clean case where one applies and the other does not.

### 9.4 Why `option_lists` and `custom_field_definitions` gain `deleted_at` and `version`, and nothing else

They become Recycle Bin entities, which needs `deleted_at`, `deleted_by` and a keyset index; and they
become editable from a screen two people can have open at once, which needs `version` (§6.3). Nothing
beyond that. They do not become syncable: there is no `MutationKind` for them, no `COLUMN_MAP`
entry, and they reach panels one-way inside `SyncSnapshot.optionLists` / `.customFields`. `version`
does not change that — it is an online-save guard, not a merge clock, and it travels outward in the
snapshot only so a panel's editor can send back the number it read.

The consequence to hold on to is that a soft-deleted option **must** be excluded from the snapshot at
the repository, not the caller (§6.3). A deleted value that reaches a panel's local store is rendered
offline until the next full snapshot, which on a panel that stays offline is indefinitely.

### 9.5 Why `pipeline_stages` still has no `tenant_id`

It is tenant-scoped transitively through `pipeline_id`, and every read joins
`pipeline_stages` to `pipelines` to apply the filter
(`master/src/repositories/pipeline.repository.ts:36-39`). Adding a denormalised `tenant_id` would
create a second source of truth for which company a stage belongs to, with nothing enforcing that the
two agree. This batch does not change it, and the Bin does not list stages, so nothing in the new
work needs a tenant-first index on the table.

---

## 10. Timezone and date safety at the SQL layer

`HANDOFF.md:267-268` records the defect: `DATE` columns came back a day early anywhere east of UTC,
because `toISOString()` converts to UTC first. The fix is `toIsoDate`
(`master/src/repositories/mappers.ts:79-90`), which formats from local components — and it has **no
test coverage at all**; nothing would fail if someone replaced it.

Every date-bucketed figure in this batch is computed **in SQL**, against a configured business
timezone, and returned as `'YYYY-MM'` `TEXT`. No date-derived value ever becomes a JavaScript `Date`
that something downstream could call `toISOString()` on.

```sql
to_char(date_trunc('month', o.dispatched_at AT TIME ZONE :tz), 'YYYY-MM') AS bucket
```

`AT TIME ZONE` applied to a `timestamptz` yields a `timestamp` without a zone, so `date_trunc` then
operates in business-local wall time. The zone comes from `config.locale.timeZone`
(`ORDERBOOK_TIMEZONE`, default `'Asia/Kolkata'`), validated once at startup after `runMigrations()`
with `SELECT now() AT TIME ZONE $1` and aborting with a message naming the variable if PostgreSQL
raises `invalid_time_zone`.

**No session timezone is set, deliberately.** `buildKnexConfig` (`master/src/db/knex.ts:10-24`)
passes client, connection, pool and migrations and nothing else — no `timezone`, no
`pool.afterCreate` running `SET TIME ZONE` — and the embedded cluster is started with no `-c
timezone=`. Adding a session default would be invisible at every call site and would silently change
the behaviour of every existing query that compares a `DATE` to `now()`. Naming the zone in each
query that needs it is longer and correct.

**A latent second instance of the same trap already ships, and this batch does not close it.**
`master/src/repositories/lead.repository.ts:54` and `:244` compare the `DATE` column
`follow_up_date` to `runner.fn.now()`; PostgreSQL promotes the `DATE` to `timestamptz` at
session-timezone midnight to make that comparison, so "follow-ups due" shifts with the same unpinned
setting the month buckets would have. It is recorded here because it is a database fact discovered
while specifying this work — it is not scoped into it.

---

## 11. Migration by migration: existing rows, and `down()`

### 11.1 `20260305000000_soft_delete_columns.ts`

**Phases.** A — the four `deleted_at`/`deleted_by` pairs. B — six Bin indexes. C — the two `leads`
partial-index predicates. D — the party/product code indexes become partial.

**Existing rows.** Not one is rewritten. `deleted_at` defaults to `NULL`, which is exactly "not
deleted"; the index work is metadata only. Every installation's data means precisely what it meant
before.

**`down()` is deliberately empty**, following `20260304000000_role_tier_ceiling_repair.ts:89-94`. The
reason is stronger here than there. Dropping `deleted_at` does not undo a delete — it **resurrects**
every soft-deleted lead, order, party and product as a live record, with no trace that anyone ever
deleted it. A rollback that creates data is worse than no rollback. Recreating the non-partial unique
indexes can also fail outright, once two live products legitimately share a code because the partial
index permitted it. Leaving the columns in place costs nothing: with no code reading them they are
four nullable columns and six tombstone-only indexes.

### 11.2 `20260306000000_field_values_and_stage_ordering.ts`

**Phases.** A — `option_lists` base columns, the two soft-delete pairs, the two `version` columns, the
two partial unique index reworks, two Bin indexes. B — `option_lists.hex` with its format `CHECK`;
`pipeline_stages.is_archived` with its `CHECK`. C — `idx_pipeline_stages_seq` becomes a deferrable
constraint. D — the three list-key seeds.

**Existing rows.** The six seeded `lead.sourcePlatform` rows gain timestamps, backdated to the
tenant's `created_at` rather than to now (§6.3), and `version = 1` from the column default with no
back-fill statement. `custom_field_definitions` is empty on every installation. The nine seeded pipeline stages take `is_archived = false`. Phase D inserts new rows
and rewrites none: `ON CONFLICT … DO NOTHING` means a re-run, or a second tenant added later, is a
no-op rather than a duplicate.

**`down()` is deliberately empty.** Same `deleted_at` argument as §11.1, plus two of its own: the
seeded colour rows are user-visible configuration that an administrator may have relabelled and given
hex values to by the time anyone rolls back, and deleting them by `list_key` discards that work
silently; and reverting `pipeline_stages_seq_unique` to a plain unique index would leave the reorder
path unimplementable while the application still calls it.

### 11.3 `20260307000000_activity_log_actor_name.ts`

**Phases.** A — `ADD COLUMN actor_name`. B — `CREATE FUNCTION activity_log_row_hash` and
`CREATE OR REPLACE FUNCTION activity_log_chain`. C — drop `activity_log_no_update`, run the two
backfill `UPDATE`s, recreate the trigger. D — the index rework of §8.1 and the report indexes of
§8.2.

**Existing rows.** Every row whose `actor_id` resolves gains a name; the rest keep `NULL`. No hashed
column is touched, so every existing `hash` stays byte-identical and the chain verifies exactly as
before. `sequence` gains `NOT NULL`, which every row already satisfies.

**`down()` is real** — one of the two in the batch that gets one, the other being `20260308` (§11.4).
The reason it can is precisely the reason the migration is safe in the first place: nothing it
touches is inside the digest, and nothing it touches is a tombstone whose removal would resurrect a
deleted record. That is the dividing line across all five: `20260305`, `20260306` and `20260309` have
**deliberately empty** `down()`s, each with a comment saying why, following the `20260304` precedent;
`20260307` and `20260308` have real ones.

```sql
-- restore the original inline expression, keeping the function OID and the trigger binding
CREATE OR REPLACE FUNCTION activity_log_chain() … ;   -- 20260303:250-284, verbatim
DROP FUNCTION activity_log_row_hash(text, bigint, text, text, text, text, text, jsonb);

DROP INDEX idx_activity_log_feed, idx_activity_log_at, idx_activity_log_actor,
           idx_activity_log_action, idx_activity_log_sequence, idx_orders_dispatched,
           idx_stock_movements_tenant_ref;
-- and recreate idx_activity_log_entity, idx_activity_log_created, idx_activity_log_tenant,
-- idx_stock_movements_reference exactly as 20260101/20260201/20260301 left them

ALTER TABLE activity_log ALTER COLUMN sequence DROP NOT NULL;
ALTER TABLE activity_log DROP COLUMN actor_name;
```

The order matters: the trigger function must stop referencing `activity_log_row_hash` before that
function is dropped. `DROP COLUMN` is DDL and does not fire the row-level `UPDATE` trigger, so no
trigger surgery is needed on the way back. The only thing lost is the backfilled names, which is
display data and not history.

### 11.4 `20260308000000_document_templates_and_exports.ts`

**Phases.** A — `document_assets`. B — `document_templates` (after A, because of the two foreign
keys). C — `document_exports`.

**Existing rows.** None. Three new tables, nothing seeded, no existing table read or written. This is
the least invasive migration in the batch, which is the right shape for the largest module.

**`down()` drops the three tables in reverse dependency order** — `document_exports`,
`document_templates`, `document_assets` — and is genuinely reversible at the schema level, because
nothing else in the database references them.

It does **not** delete anything under `data/documents/`. A migration must not delete a company's
rendered quotations; an operator who wants them gone removes the directory themselves. Say so in the
file's comment, because a rollback followed by a re-migration will find orphaned files and should not
be surprised by them.

### 11.5 `20260309000000_new_module_permission_grant.ts`

**One migration, one policy: grant every new key to `tier = 'admin'` only.** Non-admin roles receive
new keys through the permission grid, by an administrator who chooses them. Three module designs each
wrote their own grant migration with three different policies, one of which granted new capabilities
to **every existing role** — the precise act the no-wildcard rule exists to prevent.

Every key string is inlined and frozen with a dated comment. The file imports `type { Knex }` and
nothing else; there is no `@orderbook/shared` import of any kind.

**Union, never replace.** For each admin-tier role: parse the stored `JSONB` array, union with the
frozen list, sort, and skip the `UPDATE` entirely when `NEW_KEYS.every((key) => stored.includes(key))`
— every new key is already present — so a role that already holds them is not touched and `updated_at`
is not churned across every installation. **This is not a length comparison.** A stored array holding
a duplicate makes `merged.length === stored.length` true even when a new key is genuinely missing, which
would skip the very row that needs the grant — the defect `08-PERMISSIONS.md` §5.1 documents and this
migration must not reintroduce. The membership check is the only correct no-op test. The union is what
makes one migration correct on both paths: `20260303000000_roles_and_users.ts:21`
still imports the live `allPermissions()` and spends it at `:331`, so on a **fresh** install the
admin role already holds the new keys the moment the catalogue gains them, while on an
**already-migrated** database it holds none of them. A replace would be right on one and wrong on the
other.

> **A recorded decision, not a rediscovered bug.** That live import at `20260303:21` breaks the rule
> the registry header states — but the same header also forbids editing an applied migration. Both
> cannot hold. The decision is to **leave it**: the union-based grant converges on the correct end
> state regardless, and editing an applied migration is the more dangerous of the two rules to break.
> This has now been found and re-argued twice; it belongs in `HANDOFF.md` so it is not found a third
> time.

**Existing rows.** Only `roles.permissions` on admin-tier rows, and only where the set actually
changes.

**`down()` is deliberately empty**, with `20260304`'s argument: re-revoking would either be a no-op
or would strip a key an administrator has since granted deliberately, and changing a role's grants on
a rollback is a privilege change dressed up as a migration.

---

## 12. Open questions

Two questions that stood here have since been decided; they are kept, marked **DECIDED**, so a reader
who remembers them open does not go looking for an answer that has already been given.

1. **DECIDED — `option_lists` and `custom_field_definitions` get `version`.** The question was whether
   the Fields module could edit option values with no optimistic-concurrency column, leaving
   `assertVersionMatches` (`master/src/domain/access.ts:183-192`) — mandatory on every other edit path
   in the product — with an unexplained exception. It cannot. Both tables gain
   `version INTEGER NOT NULL DEFAULT 1` in `20260306` (§6.3, §6.4), and `expectedVersion` is mandatory
   on `PUT /api/fields/values/:id` and `PUT /api/fields/definitions/:id`, refusing a stale save with a
   409 carrying `storedVersion`. Cost: one column each and one guard each.
2. **DECIDED — the Bin lists `document_templates`; it does not list `document_exports`.** Templates
   are a natural fit: deleting one is a mistake somebody will make, and
   `POST /api/documents/templates/:id/restore` exists from the PDF Designer stage regardless of the
   Bin. Exports are not: the Bin's contract is "put the row back as it was", and for an export that
   requires the PDF still to be on disk, which nothing guarantees and no retention policy exists to
   reason about. `document_template` therefore joins `RECYCLE_BIN_ENTITIES` at Stage 6, and
   `idx_document_templates_deleted` is created with the table in `20260308` (§5.2, §6.1). The
   `deleted_at` / `deleted_by` columns stay on `document_exports` anyway — they let an export be
   withdrawn from the history feed without breaking a `superseded_by` chain (§5.3), which is a
   different capability from Bin membership.
3. **Should `parties.city` become an option list?** It is free text with no validation of any kind
   (`20260101:72`, unchanged since; `party.repository.columnsFrom` writes it with no trim), so a
   by-city report will treat `Morbi`, `morbi` and `Morbi ` as three cities. The mechanism already
   exists and is already used for exactly this reason on `leads.source_platform`, whose schema note
   says an unknown value is rejected so that a typo cannot quietly become its own category. This is
   out of scope for this batch and is recorded so the first city report does not come as a surprise.
4. **OPEN — should `party_product_variants` be soft-deletable?** It is the one remaining table in this
   neighbourhood that gains no `deleted_at` here, and it is not obviously the same case as the others:
   a variant row carries a **negotiated rate** for one party and one product, so removing one silently
   changes what a future line item quotes, with nothing in the Recycle Bin to put back and no entry in
   any feed saying the price moved. Hard-deleting it is what the code does today; making it soft would
   need a Bin branch, a restore permission and an answer to what a restored rate means for orders
   quoted in between. Recorded here because it was found while specifying this work; it needs an
   owner's decision, not a schema guess. Promoted to `README.md` §8.

Named in `docs/BACKEND_MODULES.md` §8 and **not** closed by any migration here: retention and pruning
for `activity_log` and `document_exports` (the `activity_log_no_delete` trigger means a pruner cannot
simply `DELETE`), `applied_mutations` atomicity, and the Office snapshot's lack of module-level
filtering.
