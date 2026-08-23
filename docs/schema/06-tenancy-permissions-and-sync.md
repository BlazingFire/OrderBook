# Schema — Tenancy, Permissions & Offline Sync

The three cross-cutting subsystems the lead-generation rebuild added
(`20260301000000_tenancy_access_and_sync`). Every table in chapters 01–03 carries columns from
here, which is why this chapter is worth reading before them rather than after.

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

Every business table gains `tenant_id UUID NOT NULL REFERENCES tenants(id)` and an index on it.
One installation currently serves one company — the migration seeds a single tenant from
`master_config.company_name` — but keying everything by tenant now means a second one is a new row
rather than a data migration later.

Codes that used to be globally unique became unique **per tenant**:

```sql
CREATE UNIQUE INDEX idx_parties_code_tenant    ON parties(tenant_id, party_code);
CREATE UNIQUE INDEX idx_products_code_tenant   ON products(tenant_id, product_code);
CREATE UNIQUE INDEX idx_categories_name_tenant ON product_categories(tenant_id, lower(name));
CREATE UNIQUE INDEX idx_users_username_tenant  ON users(tenant_id, lower(username));
```

**The tenant is never accepted from a request body.** It comes from the authenticated session or
the paired panel, so there is no signature a client could use to name someone else's tenant.

---

## 2. Roles & permissions

```sql
CREATE TABLE roles (
  id         UUID PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL,
  tier       TEXT NOT NULL CHECK (tier IN ('admin', 'management', 'office')),
  is_system  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_roles_name_tenant ON roles(tenant_id, lower(name));

CREATE TABLE role_permissions (
  role_id    UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);
```

`users.role_id` and `office_panels.role_id` both point here. A panel with no role falls back to the
seeded **Office** tier: enough to raise and progress a lead and nothing more. Defaulting to no
permissions would leave a freshly paired panel unable to do the one job it exists for; defaulting
to admin would make pairing a privilege escalation.

The three tiers are **seeded, not hard-coded**. The runtime check reads `role_permissions`, never
the tier name, so an admin who re-grants a role gets the behaviour they asked for. The seed values
come from `DEFAULT_TIER_PERMISSIONS` in `@orderbook/shared` — the migration imports them rather
than restating them in SQL, because a permission list written twice is a permission list that
drifts.

Two kinds of permission live in the same column:

- **module actions** (`leads.create`, `lead.convert`, `orders.dispatch`, …). A missing one is a
  **403 that names the permission**, so an operator can tell a broken screen from one they lack
  access to.
- **field actions** (`field.saleRate.view`). A missing one omits the key from the response —
  **absent, not null**. `rate: null` is a factual claim that the line has no price, which is a
  different and wrong statement, and one a client would happily total to zero.

---

## 3. Configurable pipelines

```sql
CREATE TABLE pipelines (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL CHECK (kind IN ('lead', 'order')),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_pipelines_tenant_kind ON pipelines(tenant_id, kind);

CREATE TABLE pipeline_stages (
  id UUID PRIMARY KEY,
  pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_terminal BOOLEAN NOT NULL DEFAULT false,
  colour TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_pipeline_stages_seq ON pipeline_stages(pipeline_id, sequence);

-- Exactly one landing place per pipeline, enforced by the database rather than
-- by convention: a new record with nowhere (or two places) to go is a bug that
-- would otherwise surface as a NULL stage_id much later.
CREATE UNIQUE INDEX idx_pipeline_stages_one_default
    ON pipeline_stages(pipeline_id) WHERE is_default;
```

Seeded: lead pipeline `New → Quoted → Negotiating → Won → Lost`; order pipeline
`In Progress → Postpone → Dispatched → Cancelled`. Because stages are data, the boards never name a
stage in code, and the only movement rules that survive are the two that protect history — a stage
must belong to the same pipeline, and a converted lead stops moving.

---

## 4. Option lists & custom fields

```sql
CREATE TABLE option_lists (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  list_key TEXT NOT NULL,     -- e.g. 'lead.sourcePlatform'
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX idx_option_lists_key_value ON option_lists(tenant_id, list_key, value);

CREATE TABLE custom_field_definitions (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  entity TEXT NOT NULL CHECK (entity IN ('lead','order','party','product')),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text','number','date','select','boolean')),
  is_required BOOLEAN NOT NULL DEFAULT false,
  options JSONB NOT NULL DEFAULT '[]',
  sequence INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_custom_fields_key ON custom_field_definitions(tenant_id, entity, key);
```

Values live in each record's `custom_fields JSONB`. A **required** custom field flags the record
`incomplete` with a `missingFields` list — it never blocks the save. A panel that has been offline
all afternoon must not lose a lead because head office added a mandatory field this morning.

---

## 5. Offline sync

### 5.1 Per-record bookkeeping

Every syncable table carries:

| Column | Purpose |
|---|---|
| `version` | Edit counter |
| `hlc` | Hybrid logical clock of the last write — orders edits across disconnected panels |
| `field_hlc` | **Per-field** map of who wrote what last |
| `temporary_id` | The id the origin panel minted, if any |

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
byte-identical timestamps, which gives the total order a free deterministic tie-break.

### 5.3 Supporting tables

```sql
-- A temporary id and the permanent one it became. Kept forever: a docket
-- printed offline must stay findable by the number on the paper.
CREATE TABLE id_map (
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  entity TEXT NOT NULL,
  temporary_id TEXT NOT NULL,
  permanent_id TEXT NOT NULL,
  device_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, temporary_id)
);

-- Makes an outbox flush idempotent.
CREATE TABLE applied_mutations (
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  mutation_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result JSONB NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, mutation_id)
);

-- Field-level edits that lost a merge, kept visible for review.
CREATE TABLE sync_conflicts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  entity TEXT NOT NULL, entity_id TEXT NOT NULL, field TEXT NOT NULL,
  losing_value JSONB,  losing_hlc TEXT NOT NULL,  losing_device_code TEXT NOT NULL,
  winning_value JSONB, winning_hlc TEXT NOT NULL, winning_device_code TEXT NOT NULL,
  resolved_at TIMESTAMPTZ, resolved_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sync_conflicts_open ON sync_conflicts(tenant_id) WHERE resolved_at IS NULL;

-- Per-entity counters behind permanent ids.
CREATE TABLE id_sequences (
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  entity TEXT NOT NULL,
  next_value BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, entity)
);

-- The Master's own clock, persisted so a restart cannot rewind it.
CREATE TABLE master_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  device_code TEXT NOT NULL,
  physical BIGINT NOT NULL DEFAULT 0,
  counter INTEGER NOT NULL DEFAULT 0
);
```

**Why `id_sequences` is a table and not a Postgres `SEQUENCE`.** A sequence is faster precisely
because it gives up the two things permanent ids need: it leaves gaps, and it hands out numbers in
whatever order sessions arrive. Ids here are printed on dockets and read down a phone, and they are
assigned in `(hlc, device_code)` order so two panels reconnecting in either sequence produce
identical numbering. The row lock is the feature.

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
trigger on the base table and indexed with `GIN (tenant_id, search_vector)` — which needs the
`btree_gin` extension to carry the plain `tenant_id` column alongside the vector.

The guide specifies SQLite FTS5; this is the PostgreSQL equivalent, and
`docs/LEAD_GENERATION_FLOW.md` §9 maps every one of its rules onto what is built here. The rule
that carries the most weight: **line items are indexed separately from products**, over the
snapshot text, so a product renamed today is still findable under the name it was quoted at.
