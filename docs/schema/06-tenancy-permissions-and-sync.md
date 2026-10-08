# Schema — Tenancy, Permissions & Offline Sync

The three cross-cutting subsystems the lead-generation rebuild added
(`20260301000000_tenancy_access_and_sync`), and what later migrations built on them: party-level
access (`20260313000000_party_access`) and the company's settings with the password vault
(`20260314000000_settings_and_password_vault`). Every table in chapters 01–03 carries a
`tenant_id` from here, and the offline-creatable ones carry the sync columns, which is why this
chapter is worth reading before them rather than after. PostgreSQL DDL describing the current
shape — see `00-overview.md` for how this was checked.

Behavioural narrative: `docs/LEAD_GENERATION_FLOW.md` §1, §4 and §7.

---

## 1. Tenancy

```sql
CREATE TABLE tenants (
  id         UUID PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Every table carries `tenant_id UUID NOT NULL REFERENCES tenants(id)`, except `tenants` itself,
`master_config` (a nullable `tenant_id`), `master_clock` (one per installation) and
`pipeline_stages` (scoped through its pipeline — which is why `backup.repository.ts` lists it in
`TRANSITIVELY_SCOPED`). Almost every index leads with `tenant_id`. One installation currently
serves one company — the migration seeds a single tenant, named from `master_config.company_name`
on an installation that already had one and `Default` (slug `default`) on a fresh database, where
setup has not run yet — but keying everything by tenant now means a second one is a new row rather
than a data migration later. The company's name lives on `master_config.company_name`; nothing
renames the tenant row.

Names and codes are unique **per tenant**, never globally, and where the table has a Recycle Bin
(or, for variant codes, mirrors its product's), among live rows only:

```sql
CREATE UNIQUE INDEX idx_parties_code_tenant         ON parties (tenant_id, party_code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_product_variants_code_tenant ON product_variants (tenant_id, lower(code)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_categories_brand_name       ON product_categories (tenant_id, lower(coalesce(brand, '')), lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_categories_code             ON product_categories (tenant_id, lower(code)) WHERE code IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX users_username_unique           ON users (tenant_id, lower(username)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX roles_name_unique               ON roles (tenant_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_office_panels_device        ON office_panels (tenant_id, device_code);
-- and api_connectors UNIQUE (tenant_id, slug)
```

The one deliberate exception is `api_keys.token_prefix`, unique across the whole database: it is
how an incoming API request is found, before anything is known about its tenant (`07-integrations.md`).

**The tenant is never accepted from a request body.** It comes from the authenticated session or
the paired panel, so there is no signature a client could use to name someone else's tenant.

*History:* `20260301` added the column everywhere and turned the global UNIQUE constraints on
`party_code`, `product_code`, category `name` and `username` into per-tenant indexes;
`20260303000000_roles_and_users` and `20260305000000_soft_delete_columns` made the username, role
name and party code indexes partial; `product_code` itself went with `20260323`, and variant codes
took its place. `20260326000000_catalogue_brands_and_codes_port` replaced the category name index
(`idx_categories_name_tenant (tenant_id, lower(name))`) with the per-brand, live-rows-only one above,
and added the category code index.

---

## 2. Roles & permissions

`docs/ROLES_AND_USERS.md` is the schema of record for this table and for `users`; what follows is
the shape as it stands.

```sql
CREATE TABLE roles (
  id          TEXT PRIMARY KEY,          -- 'RL' + 10 digits
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  tier        TEXT NOT NULL CHECK (tier IN ('admin', 'management', 'office')),
  permissions JSONB NOT NULL DEFAULT '[]',   -- a sorted array of permission keys
  is_system   BOOLEAN NOT NULL DEFAULT false,
  -- audit, soft delete + sync bookkeeping
  created_by  TEXT,
  updated_by  TEXT,
  deleted_at  TIMESTAMPTZ,
  deleted_by  TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  hlc         TEXT,
  field_hlc   JSONB NOT NULL DEFAULT '{}',
  temporary_id TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_name_unique ON roles (tenant_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_roles_deleted        ON roles (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
```

`users.role_id` and `office_panels.role_id` both point here, and neither carries a foreign key
(`01-identity-and-network.md`). A panel with no role falls back to the seeded **Office** role:
enough to raise and progress a lead and nothing more. Defaulting to no permissions would leave a
freshly paired panel unable to do the one job it exists for; defaulting to admin would make
pairing a privilege escalation.

**Seeded roles.** A fresh database has three: **Admin** (tier `admin`, `is_system = true`, so it
cannot be deleted) and **Management** and **Office**, templates a company may edit or remove
(`is_system = false` since `20260303`; `20260301` had marked all three). Which of them gets
`RL0000000001`, `02` and `03` is **not deterministic** — `20260303` numbered roles by
`created_at, id`, and all three were inserted in one transaction with random UUIDs — so code looks
a seeded role up by `tier` or `name`, never by id, and `id_sequences` for `role` starts at 4.

**Why one array rather than a join table** (`docs/ROLES_AND_USERS.md` §5): a per-key merge of two
concurrent offline edits produces a *union*, granting a combination neither administrator approved.
Permission sets are approved as a whole, so they merge as a whole. (That merge is designed but not
reachable yet: roles have no mutation kind, so a role is only ever edited through the Master's own
API — §15.5 there.) The array is sorted on the way in, so two identical sets are identical bytes
and a reorder never reads as an edit.

The runtime check reads that array, never the tier name — but it *intersects* it with the tier
ceiling on every resolution, and `effectivePermissions` drops any key the catalogue no longer
knows, so a key left in the row after the ceiling moved or the feature went cannot keep granting.
A fresh database's rows do hold such keys: all three store `ai.use`, and Admin also `ai.manage`
and `ai.write`, from the removed assistant (`07-integrations.md`).

Seed values are **inlined and frozen** in the migrations that grant keys, rather than imported
from `@orderbook/shared`: `20260301` once imported the live catalogue, which meant editing that
catalogue retroactively changed what an already-applied migration had done (it now inlines
`SEEDED_TIER_PERMISSIONS`, though its header comment still describes the import). The exception
left is `20260303000000_roles_and_users`, which sets the Admin role's array from the live
`allPermissions()` — so a fresh database's Admin row reflects the catalogue of the build that first
migrates it.

One kind of permission lives in the column (since 2026-09-21):

- **module actions and capabilities** (`leads.create`, `lead.convert`, `orders.dispatch`, …). A
  missing one is a **403 that names the permission**, so an operator can tell a broken screen
  from one they lack access to.

There used to be a second kind — **field actions** (`field.saleRate.view`), where a missing key
omitted a value from the response, absent rather than null. They went with pricing:
`20260324000000_product_master_trim` strips the four keys from every stored role, and no record
carries a value that one role may see and another may not.

*History:* `20260301` created `roles` with a UUID id and a `role_permissions (role_id,
permission)` join table; `20260303` folded that table into the `permissions` array (remapping the
coarse `parties.manage`, `products.manage` and `inventory.manage` keys (the last is gone since 1.4: stock was removed and a stored `inventory.*` or `stock.adjust` string is silently filtered by `isPermission`) onto their finer
successors), moved the id to text and added soft delete and sync bookkeeping; `20260304` re-filtered
every stored array through its tier ceiling.

---

## 2a. Party Access — row-level scoping

Added by `20260313000000_party_access`. Module permissions answer "may this role see leads at all";
this answers "may **this person** see *this* party's leads".

```sql
CREATE TABLE party_access (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  party_id     TEXT NOT NULL REFERENCES parties(id),
  user_id      TEXT NOT NULL,             -- no FK, deliberately
  access_level TEXT NOT NULL CHECK (access_level IN ('view', 'manage')),
  granted_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_party_access_unique ON party_access (tenant_id, party_id, user_id);
CREATE INDEX idx_party_access_user  ON party_access (tenant_id, user_id);
CREATE INDEX idx_party_access_party ON party_access (tenant_id, party_id);
```

**A party with no row here is open to everyone.** That is the rule the whole feature turns on, and
the reason the migration backfills nothing: an installation looks exactly as it did the minute
before, and only the parties an administrator actually assigns become restricted. The alternative —
assignment mandatory — would empty every staff member's screens on upgrade day. There is no
cached "is restricted" flag on `parties`: whether a party is restricted is an `EXISTS` on this
table, which `idx_party_access_party` answers directly.

**Who gets a row at birth (party visibility, 2026-10).** The rule above still decides every read,
but a party no longer always starts without a row. `createParty` writes one `manage` row for the
creator, in the same transaction as the party, when the creator is a real user who does **not** hold
`party.accessAll` (`creatorGrantee` in `master/src/domain/party-scope.ts`, written by
`partyAccessRepo.grantCreator`, `granted_by` = the creator). So an office-role user's new party is
visible only to them and to `party.accessAll` holders from its first instant. The same row is written for
each party a person imports (`party-import.service.ts`). No row is written, and the party stays
open to everyone, when the creator:
- holds `party.accessAll` (an administrator; they restrict a party in Party Access when they want);
- is not a person: a panel with nobody signed in, the system, a connector run, the catalogue reload CLI
  or sample data.

Parties that existed before are untouched (nothing is backfilled).

The creator's row is an ordinary grant. An administrator can raise, lower or remove it in Party Access,
and **removing the last row makes the party open to everyone again**. A hidden party is
indistinguishable from one that does not exist: `requirePartyAccess` answers 404 `Party` for a person
with no access (a `view` holder asked to `manage` still gets the refusal naming the missing level),
and an id that names no party reads as `none` for anyone who cannot see every party.

`user_id` carries **no foreign key**, for the same reason `users.role_id` has none: users are
soft-deleted and restorable, and a restored person must come back holding the parties they were
assigned rather than having had those rows cascaded away. The service validates the account exists
and is live when a grant is written. One grant per (party, person): a second would make "what may
this person do here" ambiguous rather than additive.

Two capabilities, both in the `admin` group, granted by the migration to admin-tier roles only:

| Key | Minimum tier | Meaning |
|---|---|---|
| `party.accessAll` | `management` | Bypasses every party scope. Held by admin roles; grantable to a senior manager. |
| `party.assign` | `admin` | May edit the grants. |

The predicate every read narrows by is *"nobody is assigned to this party **or** I am"*, written once
in `master/src/repositories/party-access.repository.ts` (`applyPartyScope` for query builders,
`partyScopeSql` for the hand-written SQL in search, the dashboard, reports and the recycle bin, and
`partyScopeLogSql` for the activity log, where the subject is named indirectly by
`(entity_type, entity_id)`). Sync conflicts are narrowed by the same predicate for all three party-scoped entities
(`lead`, `order` and `party`, in `sync.repository.ts#listConflicts`, which the open-conflict count
shares), and a panel's activity feed (`activity-log.repository.ts#listPanelActivity`) takes the
caller's scope. Writes go through `requirePartyAccess(partyId, 'manage', actor)` in the
**service** layer, never a route guard — an Office Panel reaches the same functions over Socket.IO.

---

## 2b. `settings` and `user_password_vault`

Added by `20260314000000_settings_and_password_vault`. Neither table is seeded and the migration
grants no permission, so an installation that runs it behaves exactly as it did the minute before.

```sql
CREATE TABLE settings (
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  "key"       TEXT NOT NULL,
  "value"     JSONB,
  is_secret   BOOLEAN NOT NULL DEFAULT false,
  key_version INT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  PRIMARY KEY (tenant_id, "key")
);
```

A row per key, the shape `option_lists` already establishes — not a column per toggle (a migration
per switch is what makes people stop adding switches) and not one JSONB blob (no per-key audit, no
per-key secret handling, a read-modify-write race on every save). **An absent row means the default
declared in `shared/src/domain/settings.ts`**, which is why the migration inserts nothing.

No `version`/`hlc`/`field_hlc`: settings never sync. `setting` is not one of the
`SYNCABLE_ENTITIES` (`shared/src/sync/ids.ts`) and has no entry in `MERGEABLE_COLUMNS`
(`shared/src/domain/columns.ts`); what a panel needs of them reaches it as the company's feature
switches. Since catalogue v2 (2026-09-29) an Office panel may also *write* one key,
`leads.followUpDefaultDays`, from its Settings → Leads tab: the panel forwards the save online
(`settings:save`), as the signed-in user and never as the panel's own role, and the Master writes
the row after its usual `settings.manage` check. Nothing is queued offline. A `secret: true` key stores a sealed envelope as its `value`, with
`aad = setting:<tenant>:<key>`; the read endpoint answers `configured: true|false` and never the
value.

```sql
CREATE TABLE user_password_vault (
  tenant_id              UUID NOT NULL REFERENCES tenants(id),
  user_id                TEXT NOT NULL,
  key_version            INT  NOT NULL DEFAULT 1,
  sealed                 JSONB NOT NULL,
  credential_fingerprint TEXT NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             TEXT,
  PRIMARY KEY (tenant_id, user_id)
);
```

A row is written only while the `security.passwordRevealEnabled` setting is on (it defaults to
off, so a fresh installation's vault stays empty). A separate table rather than a column on `users`,
for two reasons that are both about blast radius: `USER_COLUMNS` is one `u.*` regression away from
carrying a new column into every user list, and a named table can be excluded from the backup scan
and truncated wholesale. `user_id` carries **no foreign key**, matching `party_access.user_id` and
`users.role_id` — a restored person must come back with their vault row intact.

`credential_fingerprint` is the same digest of the user's `password_hash` that
`panel-credential.repository.ts` gives panels (`fingerprintForUser`), reused rather than
reimplemented. At reveal time the stored value is compared to the live one; a mismatch reports
"stale" instead of showing a password that has since been changed.

**This table is in `backup.repository.ts`'s `EXCLUDED_TABLES`.** It never enters an export, and a
restore clears the live copy — the key that opens these rows lives in `<dataDir>/secrets/` and does
not travel with the data, so a restored row would be unopenable ciphertext keyed to a user id that
may now mean somebody else. See `docs/ROLES_AND_USERS.md` §4.2 for the residual risk, stated plainly.

---

## 2c. The notice board: `notices`, `notice_audiences`, `notice_reads`

Added by `20261014000000_notice_board`: three tables and two grants, all additive and safe to run twice. No data is
touched and no column is dropped.

| Table | One row is | Notes |
|---|---|---|
| `notices` | a notice | `title` (1 to 120 characters after trimming, a CHECK), `body` (plain text, at most 4000, a CHECK, default empty), `priority` (`normal` or `important`), `pinned`, `show_until` (a calendar `DATE`, the last day it is shown, compared by the Master in the company's time zone, null = until removed), `audience_all`, `author_id` (a user; users are soft-deleted and restorable, so the reference cannot dangle), `version` (rises on every edit, so two administrators cannot overwrite each other), `created_at`, `updated_at`, `deleted_at`, `deleted_by`; and, since `20261016000000_notice_placement`, `show_on_home` and `show_at_sign_in` (see below). Index `notices_board_idx (tenant_id, pinned DESC, created_at DESC, id)` over live rows |
| `notice_audiences` | one role a notice is for | Used only when `audience_all` is false. Primary key `(notice_id, role_id)`; `role_id` references `roles`, which are soft-deleted too, so it never dangles. A notice for roles with none left alive is seen by nobody but managers |
| `notice_reads` | one person has read one notice | Primary key `(notice_id, user_id)`, so reading twice is a no-op. It is what the unread badge counts and what a manager sees as "read by" |

**Who sees a notice.** The audience is decided by the reader's **role**, taken from the session or the panel's acting
person, never from a request. `notices.view` reads the board: the notices for everybody or for the reader's role, not
deleted, not past `show_until`. `notices.manage` sees every notice (expired ones too, marked `expired`), each audience's
role names, how many people have read it and who. Nobody else can learn who read what.

**The grants.** `notices.view` goes to **every** role, whatever its tier, so nobody loses anything; `notices.manage` to
every role of the `admin` and `server_master` tiers (the minimum tier for `notices.manage` is `admin`, so a role below
that cannot hold it). A role created after the migration gets `notices.view` from the role form's default, not from the
server. The key lists are inline in the migration, never read from `@orderbook/shared`.

**Delete and restore.** A notice is soft-deleted and comes back from the Recycle Bin (`notices.manage`, entity
`notice`). A restored notice keeps who has read it.

**Where else it shows (`20261016000000_notice_placement`, 2026-10-08).** Two columns, `show_on_home BOOLEAN NOT NULL
DEFAULT true` (the band at the top of Basic Home) and `show_at_sign_in BOOLEAN NOT NULL DEFAULT true` (the pop-up of
unread notices right after sign-in). Every notice is on the board whatever they say. The defaults keep a notice that was
up before the update showing in both places, and a create from an older panel that sends neither gets both. At least
one stays true: the Master refuses both false (`validation.notice.placementEmpty`), checking an edit that sends one alone
against the stored other; that rule is the service's, not a constraint. Additive and safe to run twice; `down()` drops the
two columns. The company can also turn either surface off as a whole (`notices.showOnHome`, `notices.showAtSignIn` in
`settings`), which needs no column.

---

## 3. Configurable pipelines

```sql
CREATE TABLE pipelines (
  id         UUID PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  kind       TEXT NOT NULL CHECK (kind IN ('lead', 'order')),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_pipelines_tenant_kind ON pipelines (tenant_id, kind);

CREATE TABLE pipeline_stages (
  id          UUID PRIMARY KEY,
  pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sequence    INTEGER NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  is_terminal BOOLEAN NOT NULL DEFAULT false,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  colour      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_stages_seq_unique UNIQUE (pipeline_id, sequence) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT pipeline_stages_archived_not_default CHECK (NOT (is_archived AND is_default))
);
CREATE INDEX idx_pipeline_stages_pipeline ON pipeline_stages (pipeline_id);

-- Exactly one landing place per pipeline, enforced by the database rather than
-- by convention: a new record with nowhere (or two places) to go is a bug that
-- would otherwise surface as a NULL stage_id much later.
CREATE UNIQUE INDEX idx_pipeline_stages_one_default
    ON pipeline_stages (pipeline_id) WHERE is_default;
```

Seeded, one pipeline of each kind per tenant: lead pipeline `New` (default) → `Quoted` →
`Negotiating` → `Won` (terminal) → `Lost` (terminal); order pipeline `In Progress` (default) →
`Postpone` → `Dispatched` (terminal) → `Cancelled` (terminal). Because stages are data, the boards
never name a stage in code, and the only movement rules that survive are the two that protect
history — a stage must belong to the same pipeline, and a converted lead stops moving.

A company renames, recolours, reorders and archives stages and moves the default under Settings →
Fields; nothing adds or deletes a stage row, so every tenant keeps its nine, and the timeline
entries that name a stage (`from_stage_id`, `to_stage_id`) always resolve. A stage can be archived
only once no lead or order stands in it (`error.conflict.stageOccupied`), and never while it is the
default — the CHECK makes the second a database rule. The sequence constraint is **deferrable** because dragging a stage above another
writes sequences that collide for a moment: a reorder runs
`SET CONSTRAINTS pipeline_stages_seq_unique DEFERRED` and is checked at commit, while every other
write is checked at once. (A unique *index* cannot be deferrable, which is why
`20260306000000_field_values_and_stage_ordering` replaced the original `idx_pipeline_stages_seq`
with this constraint, and added `is_archived`.)

---

## 4. Option lists & custom fields

```sql
CREATE TABLE option_lists (
  id         UUID PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  list_key   TEXT NOT NULL,     -- one of FIELD_LIST_KEYS, e.g. 'lead.sourcePlatform'
  value      TEXT NOT NULL,     -- what a record stores; never renamed
  label      TEXT NOT NULL,     -- what a person sees; a rename changes this, never value
  sequence   INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  hex        TEXT,              -- a swatch, for 'stock.colour' only
  created_by TEXT,
  updated_by TEXT,
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT,
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT option_lists_hex_format CHECK (hex IS NULL OR hex ~ '^#[0-9A-Fa-f]{6}$')
);
CREATE UNIQUE INDEX idx_option_lists_key_value ON option_lists (tenant_id, list_key, value) WHERE deleted_at IS NULL;
CREATE INDEX idx_option_lists_deleted ON option_lists (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;

CREATE TABLE custom_field_definitions (
  id          UUID PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  entity      TEXT NOT NULL CHECK (entity IN ('lead','order','party','product')),
  key         TEXT NOT NULL,
  label       TEXT NOT NULL,
  field_type  TEXT NOT NULL CHECK (field_type IN ('text','number','date','select','boolean')),
  is_required BOOLEAN NOT NULL DEFAULT false,
  options     JSONB NOT NULL DEFAULT '[]',
  sequence    INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  deleted_at  TIMESTAMPTZ,
  deleted_by  TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_custom_fields_key ON custom_field_definitions (tenant_id, entity, key) WHERE deleted_at IS NULL;
CREATE INDEX idx_custom_fields_deleted ON custom_field_definitions (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
```

`option_lists` holds the five managed sets in `FIELD_LIST_KEYS` (`shared/src/domain/fields.ts`):
`lead.sourcePlatform`, `stock.colour`, `product.brand`, `line.packaging` and `line.grade`. A fresh
database has six `lead.sourcePlatform` values (whatsapp, call, website, walk_in, referral, other)
and, since `20260328000000_line_packaging_defaults` (owner's instruction, 2026-09-30), Box, Grass and
Paper in `line.packaging` — added after whatever an existing list held, never doubling a value it
already had. The other three start empty for a company to fill under Settings → Fields, and the
catalogue loader fills `product.brand` (value = label = the brand name) and `stock.colour` (the
catalogue's colour range, with hex). On an installation that already had data, `20260306` backfilled
`stock.colour`, `line.packaging` and a `product.productType` set from the distinct values in use,
keeping their case exactly; the trim later deleted every `product.*` set and the `line.grade`
values. `product.brand` came back on 2026-09-29 as the list a category's `brand` names
(`02-parties-and-products.md`), with no migration: an option list is rows, not schema. A record stores `value`, and `label` is what a rename
changes, so renaming never touches the identity a record holds. A deleted value is a Recycle Bin
entry (`option_list_item`).

Custom field values live in each record's `custom_fields JSONB` (leads, orders, parties,
products). A **required** custom field flags the record `incomplete` with a `missingFields` list —
it never blocks the save. A panel that has been offline all afternoon must not lose a lead because
head office added a mandatory field this morning.

`version` on both tables is an edit counter for the Fields screens ("did somebody save while I had
this form open"), not sync bookkeeping: neither table is written offline.

*History:* `20260301` created both tables with plain (non-partial) unique indexes and no soft
delete; `20260306000000_field_values_and_stage_ordering` added soft delete, `version`, `hex` and
the audit columns, made the unique indexes partial and added the Bin indexes.

---

## 5. Offline sync

### 5.1 Per-record bookkeeping

Seven tables carry the full sync bookkeeping — `leads`, `orders`, `parties`, `products`,
`party_product_variants`, `roles` and `users`:

| Column | Purpose |
|---|---|
| `version` | Edit counter |
| `hlc` | Hybrid logical clock of the last write — orders edits across disconnected panels |
| `field_hlc` | **Per-field** map of who wrote what last |
| `temporary_id` | The id the origin panel minted, if any |

On `roles` and `users` the columns are ahead of the code. The Master's own writes stamp `version`,
`hlc` and `field_hlc`, but there is no `role.*` or `user.*` mutation kind, so no panel edit reaches
either table through sync and `temporary_id` is always NULL (`docs/ROLES_AND_USERS.md` §15.5).

The other four syncable entities — line items, product categories, product variants and timeline
entries — carry no clock of their own, and the Master names each one with a
permanent id when it applies the write that makes it (the `allocatePermanentIds` calls in their
repositories). Three are only ever made as part of a parent's write; a product category is made that
way too (a product form naming a new category), and since catalogue v2 also has its own online-only
create, edit and soft delete — never queued, so never offline. A panel mints a temporary id only for the
record a mutation is about — a lead, party, product or party variant — so none of the four ever
appears in `id_map`.

`field_hlc` is the column that makes the guide's §4.5 promise achievable: edits to *different*
fields both survive, because each field remembers its own writer. A single row-level timestamp
would force an all-or-nothing choice and silently drop the other panel's untouched fields.

### 5.2 HLC encoding

```
0001755870000000-00003-A3F9K2
└ physical ms ─┘ └cnt┘ └device┘
```

Fixed-width, so **lexicographic order is causal order** — Postgres sorts it with a plain btree and
the merge compares with `<`. The device code at the end means two panels can never produce
byte-identical timestamps, which gives the total order a free deterministic tie-break. The Master's
own device code is `MASTER`.

### 5.3 Supporting tables

```sql
-- A temporary id and the permanent one it became. Kept forever: a docket
-- printed offline must stay findable by the number on the paper.
CREATE TABLE id_map (
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  entity       TEXT NOT NULL,
  temporary_id TEXT NOT NULL,
  permanent_id TEXT NOT NULL,
  device_code  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, temporary_id)
);
CREATE INDEX idx_id_map_permanent ON id_map (tenant_id, permanent_id);

-- Makes an outbox flush idempotent: a panel that crashes mid-push and resends
-- gets the stored result back instead of applying twice.
CREATE TABLE applied_mutations (
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  mutation_id TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  status      TEXT NOT NULL,
  result      JSONB NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, mutation_id)
);
CREATE INDEX idx_applied_mutations_at ON applied_mutations (tenant_id, applied_at);

-- Field-level edits that lost a merge, kept visible so a human can put the
-- losing value back if it was the right one.
CREATE TABLE sync_conflicts (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  entity              TEXT NOT NULL,
  entity_id           TEXT NOT NULL,
  field               TEXT NOT NULL,
  losing_value        JSONB,
  losing_hlc          TEXT NOT NULL,
  losing_device_code  TEXT NOT NULL,
  winning_value       JSONB,
  winning_hlc         TEXT NOT NULL,
  winning_device_code TEXT NOT NULL,
  resolved_at         TIMESTAMPTZ,
  resolved_by_user_id TEXT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sync_conflicts_entity ON sync_conflicts (tenant_id, entity, entity_id);
CREATE INDEX idx_sync_conflicts_open   ON sync_conflicts (tenant_id) WHERE resolved_at IS NULL;

-- Per-entity counters behind permanent ids.
CREATE TABLE id_sequences (
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  entity     TEXT NOT NULL,
  next_value BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, entity)
);

-- The Master's own clock, persisted so a restart cannot rewind it.
CREATE TABLE master_clock (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  device_code TEXT NOT NULL,                 -- 'MASTER'
  physical    BIGINT NOT NULL DEFAULT 0,
  counter     INTEGER NOT NULL DEFAULT 0
);
```

`applied_mutations` is never pruned; `idx_applied_mutations_at` serves the dashboard's "mutations
from panels in the last hour" figure. `id_sequences` has one row per syncable entity per tenant — 12
on a fresh database (one of them, `reservation`, is retired in 1.4 and no longer used), every one at 1 except `role` at 4. Since 1.3 it also holds one row per
financial year for the pending order numbers, `po:2026-27` and so on: seeded by
`20261003000000_pending_order_numbers` past the numbers it back-filled, created by the first save
of a new year, never reset by the business-data wipe, and restarted only by a developer factory
reset. `master_clock` is seeded with its single
row by the migration and is in `backup.repository.ts`'s `EXCLUDED_TABLES`: it is this
installation's clock, and a restored copy would be wrong for it.

**Why `id_sequences` is a table and not a Postgres `SEQUENCE`.** A sequence is faster precisely
because it gives up the two things permanent ids need: it leaves gaps, and it hands out numbers in
whatever order sessions arrive. Ids here are printed on dockets and read down a phone, and they are
assigned in `(hlc, device_code)` order so two panels reconnecting in either sequence produce
identical numbering. The row lock (`FOR UPDATE`) is the feature.

**Why `master_clock` is persisted.** A rewound clock would let an edit made after a restart sort
*before* one made just prior to it, and the merge would then prefer the older value — silently.

### 5.4 The merge rule

For each field a mutation asserts:

1. If the stored `field_hlc` equals the `baseFieldHlc` the panel sent, the editor was looking at
   the value they replaced. Ordinary edit, applied, nothing reported.
2. Otherwise the field moved under the editor. The higher HLC wins, and the value that loses —
   whichever side it is — is written to `sync_conflicts`.

Step 1 is what stops the engine crying wolf. Without `baseFieldHlc`, an ordinary sequential edit
from a second panel is indistinguishable from a genuine offline clash: both are "different device,
different value, higher timestamp".

---

## 6. Full-text search

`products`, `parties` and `line_items` each carry a `search_vector tsvector`, maintained by a
BEFORE INSERT OR UPDATE trigger on the base table and indexed with `GIN (tenant_id, search_vector)`
— which needs the `btree_gin` extension to carry the plain `tenant_id` column alongside the vector,
so the tenant filter and the match are served by one index. All three use the `simple` text-search
configuration (no stemming — codes and names are not English prose).

| Table | Trigger function | Weights |
|---|---|---|
| `parties` | `parties_search_refresh()` | A: `name`, `party_code` · B: `phone`, `alt_phone` · C: `email`, `city` |
| `products` | `products_search_refresh()` | A: `name`, the codes and labels of its live variants · B: `alias` · C: `size` |
| `line_items` | `line_items_search_refresh()` | A: `product_name`, `code` · B: `alias`, `variant_label`, `colour` · C: `size`, `packaging` · D: `notes` |

A product's vector reads its variants, so `product_variants` has an AFTER INSERT/UPDATE/DELETE
trigger (`product_variants_search_refresh()`) that re-fires the product's own trigger by updating
its `search_vector` to itself (`02-parties-and-products.md`). The vector is never written by the
service layer — application-side maintenance is exactly how a search index drifts from the data it
claims to describe.

The guide specifies SQLite FTS5; this is the PostgreSQL equivalent, and
`docs/LEAD_GENERATION_FLOW.md` §9 maps every one of its rules onto what is built here. The rule
that carries the most weight: **line items are indexed separately from products**, over the
snapshot text, so a product renamed today is still findable under the name it was quoted at.
