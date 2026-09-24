# Schema — Public API, Connectors & `ai_runs`

The seven `api_*` tables behind the two ways OrderBook talks to other systems, both off by default:
the **public API** (`/api/v1`, `docs/STRUCTURE.md` §5.8.2), where another program calls the
Master with a key, and **connectors**, where the Master pulls parties and products from another
system's HTTP API. All seven come from `20260316000000_public_api_and_connectors`. The last section
is `ai_runs`, a table the removed assistant left behind. PostgreSQL DDL describing the current
shape — see `00-overview.md` for how this was checked.

Shared traits of the seven, which differ from the rest of the schema because they were built with
Knex's schema builder rather than raw SQL:

- Ids are UUIDs with a database default (`gen_random_uuid()`), except `api_connector_runs`, which
  is `BIGSERIAL`. Nothing here is created on an Office Panel, so nothing needs a text id.
- **Every table carries `tenant_id`, child tables included, with `ON DELETE CASCADE`** — with
  `ai_runs`, the only tenant foreign keys in the schema that cascade. `backup.repository.ts` decides what a
  `selected`-scope export and restore touches purely by the presence of a `tenant_id` column, so a
  child table without one would survive a selected restore still bound to ids that no longer
  exist. Each child also cascades from its parent.
- Timestamps default to `CURRENT_TIMESTAMP` (the same as `now()`).
- The enumerations (`auth_kind`, `schedule_kind`, `entity`, `method`, `transform`, `on_conflict`,
  `mode`, `trigger`, `status`) have **no CHECK constraints**; the services validate them against
  the types in `shared/src/domain/connectors.ts`.

The master switch is the `externalApi.enabled` setting (fallback `false`), not a column: with it off
the whole `/api/v1` namespace answers 404 and the connector scheduler skips the tenant. Managing
keys and connectors needs `api.manage`, which the migration granted to every role holding
`settings.manage`.

## `api_keys` and `api_key_scopes`

```sql
CREATE TABLE api_keys (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label              TEXT NOT NULL,
  token_prefix       TEXT NOT NULL UNIQUE,     -- the lookup handle; shown, not secret
  token_hash         TEXT NOT NULL,            -- sha256 of the secret half, hex
  owner_user_id      TEXT NOT NULL,            -- users.id; no FK
  rate_limit_per_min INTEGER NOT NULL DEFAULT 120,
  expires_at         TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  last_used_at       TIMESTAMPTZ,
  created_by_user_id TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX api_keys_tenant_id_index ON api_keys (tenant_id);

CREATE TABLE api_key_scopes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  api_key_id  UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL,                   -- a permission key, e.g. 'parties.view'
  UNIQUE (api_key_id, permission)
);
```

A key is presented as `obk_<prefix>_<secret>`. The prefix (12 hex characters) is the handle: unique
across the whole database, because it is what a request is found by before its tenant is known,
and not a secret, so it can be listed. The secret is stored only as a **sha256** digest, compared
with `timingSafeEqual` (`api-key.repository.ts`): unlike a person's password it is 256 bits of
machine entropy and is checked on every request, where scrypt's work factor would cap the whole
API near 25 requests a second on one core. The token is shown once, at creation.

What a key may do is its owner's **current** role intersected with its scopes, re-resolved on every
request, so demoting or deactivating the owner narrows or stops the key at once.
`owner_user_id` is TEXT with no foreign key, like `party_access.user_id`: users are soft-deleted
and restorable, and a cascade would silently delete the keys of somebody who was deactivated and
then brought back. The service checks the owner exists and is live when a key is issued.

A key is never deleted: revoking sets `revoked_at`, and an expired or revoked key is refused.
`last_used_at` is written in batches by the connector scheduler's tick, not on every request.
`rate_limit_per_min` is enforced in memory by the API middleware. Changes made through a key are
audited with `actor_type = 'api_key'` (`04-activity-log.md`).

## `api_connectors`

```sql
CREATE TABLE api_connectors (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug              TEXT NOT NULL,
  label             TEXT NOT NULL,
  base_url          TEXT NOT NULL,
  auth_kind         TEXT NOT NULL DEFAULT 'none',     -- none | header | bearer | basic
  auth_header       TEXT,                             -- for 'header': which header carries the credential
  auth_username     TEXT,                             -- for 'basic'
  credential_sealed JSONB,                            -- sealed by secret-box; never plaintext
  direction         TEXT NOT NULL DEFAULT 'inbound',  -- never read or written by the code
  schedule_kind     TEXT NOT NULL DEFAULT 'manual',   -- manual | on_change | periodic
  interval_min      INTEGER,                          -- for 'periodic'; at least 5
  run_as_user_id    TEXT,                             -- whose authority an import writes with; no FK
  mapping_version   INTEGER NOT NULL DEFAULT 1,       -- bumped by every mapping write
  profile_slug      TEXT,                             -- the ready-made profile it was created from
  is_enabled        BOOLEAN NOT NULL DEFAULT false,
  last_run_at       TIMESTAMPTZ,
  last_status       TEXT,                             -- running | ok | partial | failed
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, slug)
);
```

A connector is data, not a code path: a base URL, how to authenticate, which remote path holds which
entity, and a list of `local field ← JSON pointer` pairs. Adding a second system is a profile
somebody fills in, not a module somebody writes.

- **The credential** is sealed with this row's own additional data
  (`connector:<tenant>:<connector id>`), never stored as plaintext and never in a column whose
  name invites grepping an unencrypted backup. `openCredential` in `connector.repository.ts` is the
  only unsealer, and it answers `null` rather than throwing when the key cannot open it — the
  normal state after a restore onto a new machine, whose `<dataDir>/secrets/` key is different; the
  connector then needs its credential entered again.
- **`run_as_user_id`** is nullable so a connector can exist before somebody decides, but a run
  without it is refused rather than falling back to the system actor, which holds no permissions.
  Imports go through the ordinary services as that user, audited with `actor_type = 'connector'`.
  TEXT with no foreign key, for the same reason as `api_keys.owner_user_id`.
- **`mapping_version`** makes a mapping impossible to change and then run blind: a real import is
  refused unless a successful dry run exists at the current version.
- **`direction`** was meant to distinguish inbound from outbound connectors; only inbound exists,
  and nothing in `master/src` reads or writes the column.

A connector is hard-deleted, taking its resources, field maps, links and runs with it.

## `api_connector_resources` and `api_connector_field_maps`

```sql
CREATE TABLE api_connector_resources (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id       UUID NOT NULL REFERENCES api_connectors(id) ON DELETE CASCADE,
  entity             TEXT NOT NULL,              -- 'party' | 'product'
  path               TEXT NOT NULL,              -- appended to base_url
  method             TEXT NOT NULL DEFAULT 'GET',  -- GET | POST
  items_pointer      TEXT NOT NULL DEFAULT '',   -- JSON pointer to the array of rows; '' = the root
  remote_id_pointer  TEXT NOT NULL,              -- JSON pointer to the remote record's own id
  updated_at_pointer TEXT,
  page_param         TEXT,
  page_size_param    TEXT,
  page_size          INTEGER,
  watermark          TEXT,                       -- high-water mark; advanced only by a real import
  UNIQUE (connector_id, entity)
);

CREATE TABLE api_connector_field_maps (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource_id    UUID NOT NULL REFERENCES api_connector_resources(id) ON DELETE CASCADE,
  local_field    TEXT NOT NULL,                  -- a Party or Product field name
  remote_pointer TEXT NOT NULL,                  -- JSON pointer into the remote row
  transform      TEXT,                           -- trim | upper | lower | digits; never an expression
  on_conflict    TEXT NOT NULL DEFAULT 'remote_wins',  -- remote_wins | local_wins | flag
  is_required    BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (resource_id, local_field)
);
```

One resource per entity per connector. Saving a connector's mapping **replaces** its resources and
field maps wholesale and bumps `mapping_version`: the watermark is the only state on a resource worth
keeping, and a mapping change is exactly when it should start again.

Conflicts are resolved per field by `on_conflict`, **not** by the sync clock: a remote system's
`updated_at` is not causally ordered with this installation's HLC. `flag` writes nothing and raises a
row on the Conflicts screen (`sync_conflicts`), and is offered only for the fields the conflict
restorer can put back (`CONNECTOR_FLAGGABLE_FIELDS`). `20260324000000_product_master_trim` deleted
every field map whose `local_field` named a product field it dropped.

## `api_connector_links`

```sql
CREATE TABLE api_connector_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id UUID NOT NULL REFERENCES api_connectors(id) ON DELETE CASCADE,
  entity       TEXT NOT NULL,
  remote_id    TEXT NOT NULL,
  local_id     TEXT NOT NULL,                    -- parties.id / products.id; no FK
  remote_hash  TEXT NOT NULL,                    -- digest of the remote row as last imported
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (connector_id, entity, remote_id)
);
```

The two idempotency layers of an import: a link turns a re-import into an update rather than a
duplicate, and `remote_hash` turns an unchanged row into a zero-write skip — which is also the loop
guard for an `on_change` connector, since a change event carries no actor and "would this write
anything?" is the only way to tell our own echo from a real remote edit.

`local_id` has **no foreign key** on purpose: a local record can go to the Recycle Bin while the
remote one lives on, and a link whose target is gone is treated as a create on the next run — what
somebody expects after deleting a row by mistake. `id_map` was deliberately not reused for remote
ids: its key is `(tenant_id, temporary_id)` with no connector column, and `resolveId` treats any id
as a possible temporary one, so a remote `SO-1042` in there would silently rewrite an unrelated
lookup. `20260323000000_product_variants` deleted every product link when it wiped the product
master.

## `api_connector_runs`

```sql
CREATE TABLE api_connector_runs (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id    UUID NOT NULL REFERENCES api_connectors(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL,                 -- dry_run | import
  trigger         TEXT NOT NULL,                 -- manual | schedule | change
  mapping_version INTEGER NOT NULL,              -- the mapping this run used
  started_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running',  -- running | ok | partial | failed
  read_count      INTEGER NOT NULL DEFAULT 0,
  created_count   INTEGER NOT NULL DEFAULT 0,
  updated_count   INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  errors          JSONB NOT NULL DEFAULT '[]'    -- per-row results, capped
);
CREATE INDEX api_connector_runs_connector_id_started_at_index ON api_connector_runs (connector_id, started_at);
```

The run log. Each imported row is its own transaction, so a partial failure is the normal outcome
and reads as `partial` with the failing rows in `errors` (capped, so a run that fails every row is
not a log bomb). A run is in-process state: a Master killed mid-import would leave a row claiming to
be `running` forever and blocking the next run, so `failStaleRuns` marks old `running` rows
`failed`. Nothing prunes the table.

## `ai_runs` — left behind by the removed assistant

```sql
CREATE TABLE ai_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL,               -- no FK
  panel_id          UUID,
  kind              TEXT NOT NULL CHECK (kind IN ('ask','draft','summarise','vision','narrate')),
  model             TEXT,
  subject_kind      TEXT,
  subject_id        TEXT,
  prompt            TEXT NOT NULL,
  answer            TEXT,
  tool_trace        JSONB NOT NULL DEFAULT '[]',
  proposal          JSONB,
  applied_at        TIMESTAMPTZ,
  applied_by        TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  status            TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','done','cancelled','failed')),
  error_code        TEXT,
  latency_ms        INTEGER,
  rates_visible     BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at       TIMESTAMPTZ
);
CREATE INDEX ai_runs_tenant_id_user_id_created_at_index ON ai_runs (tenant_id, user_id, created_at);
CREATE INDEX ai_runs_tenant_id_created_at_index         ON ai_runs (tenant_id, created_at);
```

`20260317000000_ai_assistant` created this table for the assistant's transcripts — the prompt, the
answer, what the model looked at and what it cost — and granted `ai.manage` and `ai.write` to roles
holding `settings.manage` and `ai.use` to roles holding `leads.view`. The assistant was removed on
2026-09-11 and there is no AI in the product; the table and the keys were not.

- **Nothing in `master/src` reads or writes `ai_runs`.** It is empty on any installation created
  since, and holds whatever transcripts an installation recorded before. Its only other reference
  is the list of tables `master/tests/helpers/fixtures.ts` empties between tests. A backup export
  carries it like any other table.
- **The `ai.*` keys stay in stored roles.** On a fresh database all three seeded roles store
  `ai.use`, and Admin also `ai.manage` and `ai.write`. They grant nothing: the catalogue no longer
  knows them, and `effectivePermissions` drops unknown keys on every resolution.
- **Dropping the table is an owner decision.** Migrations after 1.2.0 only add
  (`docs/PRODUCTION_READINESS.md`): a `DROP TABLE` would need an `EXEMPT` entry in
  `master/tests/migration-data-safety.test.ts`, and it would discard any transcripts a pre-removal
  installation still holds. The keys are harmless where they are; stripping them from stored roles
  would be a rewrite of role rows like the one `20260324000000_product_master_trim` made for the
  pricing keys.

`rates_visible` recorded whether the asker could see prices when they asked, so an old transcript
would not be shown to someone who had since lost that right; with pricing gone it means nothing.
