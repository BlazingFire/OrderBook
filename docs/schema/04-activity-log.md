# Schema — Activity Log

The audit trail: an audited write the Master makes appends one row here, in the same transaction
as the change it describes (`recordActivity` in `activity-log.repository.ts`), and the Master's
Logs screen reads it. Paths with no open transaction to join — a failed operation worth recording,
such as a refused sign-in, and some writes that commit on their own, such as a stock arrival or
adjustment — append through `recordDetachedActivity` instead, in a transaction of their own.

It is **not** the source of the "live updating" feel (`PROJECT_PLAN.md` §1/§8): services publish
`data:changed` Socket.IO events with the full current record through `change-bus.ts`,
independently of this table. PostgreSQL DDL describing the current shape — see `00-overview.md`
for the type/convention rationale and how this was checked.

```sql
CREATE TABLE activity_log (
  id          BIGSERIAL PRIMARY KEY,                 -- global insertion order; nothing references it
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  sequence    BIGINT NOT NULL,                       -- 1, 2, 3 … per tenant; assigned by the trigger
  entity_type TEXT NOT NULL,                         -- e.g. 'lead', 'party', 'user', 'office_panel', 'api_key'
  entity_id   TEXT NOT NULL,                         -- the record's id, whatever its shape
  action      TEXT NOT NULL,                         -- e.g. 'created', 'updated', 'deleted', 'restored', 'stage_changed'
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user', 'office_panel', 'system', 'api_key', 'connector')),
  actor_id    TEXT,                                  -- see the table below; NULL for 'system'
  actor_name  TEXT,                                  -- display name at the time; not in the hash
  details     JSONB,                                 -- before/after snapshot or diff
  prev_hash   TEXT,                                  -- the tenant's previous row's hash (64 zeros for the first)
  hash        TEXT,                                  -- SHA-256 over this row, see below
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_activity_log_sequence ON activity_log (tenant_id, sequence);
CREATE INDEX idx_activity_log_feed   ON activity_log (tenant_id, id DESC);
CREATE INDEX idx_activity_log_at     ON activity_log (tenant_id, created_at DESC);
CREATE INDEX idx_activity_log_actor  ON activity_log (tenant_id, actor_type, actor_id, id DESC);
CREATE INDEX idx_activity_log_action ON activity_log (tenant_id, action, id DESC);
CREATE INDEX idx_activity_log_entity ON activity_log (tenant_id, entity_type, entity_id, id DESC);

CREATE TRIGGER activity_log_chain_trg BEFORE INSERT ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_chain();
CREATE TRIGGER activity_log_no_update BEFORE UPDATE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_immutable();   -- RAISE 'activity_log is append-only'
CREATE TRIGGER activity_log_no_delete BEFORE DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_immutable();
```

| Column | Notes |
|---|---|
| `entity_type` / `entity_id` | Point at any table's row without a hard foreign key — deliberately loose so this one table can log every entity type without a schema change each time a new entity is added. `entity_id` is TEXT because ids come in several shapes (`LD…`, a panel's UUID, a connector's UUID). |
| `actor_type` / `actor_id` | `user` → a `users.id`; `office_panel` → the panel's UUID as text; `api_key` → the `api_keys.id` a public-API request authenticated with; `connector` → the `api_connectors.id` whose import wrote the change; `system` → no actor (`actor_id` NULL) for automatic changes with no human, panel, key or connector behind them. |
| `actor_name` | Denormalised when the row is written, so a deleted user or an unpaired panel still names who did it. For the two integration actors it reads like "Asha via API key Tally sync" or "Asha via Hermes" — the person whose authority was used, and through what. |
| `details` | `JSONB` rather than separate `before`/`after` columns since the shape of a "change" differs wildly by entity type (a lead's stage change vs. a user's role change) — this is one of the places a JSON column is the right call for everything, not just an escape hatch, because activity-log entries are read as whole records, not filtered by their payload contents. |

**What catalogue v2 records** (2026-09-29, `docs/catalogue/CATALOGUE_MODEL.md` §9). No new
column: these are new `(entity_type, action)` pairs, each with an `activity.<entity>.<action>`
template in both catalogues and in `shared/tests/activity-tokens.lock.json`.

| `entity_type` | Actions | `details` |
|---|---|---|
| `product_category` (the owner's Product) | `created`, `updated`, `deleted`, `restored` | `name`, `code`, `brand`; on `updated`, `changes` holds each field that moved as `{ field: { from, to } }` (`name`, `code`, `brand`, `sortOrder`); on a restore under a new name, `renamedTo` |
| `product` (a sub product) | the existing `created`, `updated`, `deleted`, `restored` | `name` and now `product`, its Product as `OPT · One Piece Toilet`; on `updated`, `changes` holds each moved field as `{ from, to }` (name, product, alias, size, multi-colour, sort order, variants) |
| `catalog` | `reloaded` (new), `imported` | one `reloaded` row per `npm run reload:catalog`, which keeps the trail it is written into, with the counts (brands, colours, products, sub products, skipped, leads and orders removed); an additive load (Settings → Developer, `seed:catalogue`) writes one `imported` row with `count` and `fileName` when it adds anything — one row for the whole load, not one per sub product |
| `option_list_item` | the existing actions | a brand is a `product.brand` value, so adding, relabelling or removing one is logged like any list value |

## The hash chain

`20260303000000_roles_and_users` made the table append-only and chained, and
`20260310000000_activity_log_actor_name` factored the digest into a function the trigger and the
verifier share:

- **`activity_log_chain()`** (the BEFORE INSERT trigger) takes a per-tenant advisory lock
  (`pg_advisory_xact_lock(hashtext(tenant_id))`), reads the tenant's last row, and sets
  `sequence` = last + 1, `prev_hash` = last hash (or 64 zeros), and `hash`. Without the lock two
  concurrent inserts would read the same predecessor and fork the chain. Anything the inserting
  code puts in those three columns is overwritten.
- **`activity_log_row_hash(prev_hash, sequence, entity_type, entity_id, action, actor_type,
  actor_id, details)`** is `sha256` over those eight values joined with `|` (`details` as
  Postgres's own `::text` rendering), hex-encoded. `actor_name` and `created_at` are **not**
  covered.
- **Verification** (`verifyChain`, behind `logs.verifyChain`) recomputes the digest in SQL — Node
  cannot reproduce Postgres's JSONB text rendering — and checks each row's `prev_hash` against its
  predecessor, in a read-only transaction that never queues behind the write path's lock.
- **Rows written before the chain existed** carry `hash = 'pre-chain'` and `prev_hash` = 64 zeros:
  claiming a verified chain over entries written before chaining existed would be a lie, so they
  are marked and the verifier counts and skips them.

The advisory lock is held for the rest of the caller's transaction, so every audited write for one
company queues behind the others. At this product's scale — one company, a handful of panels,
human-paced actions — that is not a real constraint, and it buys a trail that is atomic with what
it records.

**What the triggers do not stop.** They are row-level, so a `TRUNCATE` empties the table without
firing `activity_log_no_delete`: the business wipe (`catalog-reload-cli.ts` behind `wipe:business`
and `seed:parties`, which keeps users, roles and settings) and the test fixtures do exactly that.
`reload:catalog` no longer does: since catalogue v2 it keeps the whole trail and appends one
`catalog.reloaded` row. Developer mode's **Erase
everything** (`resetAllData` in `developer.service.ts`) goes further: it drops the whole `public`
schema — the trail, its triggers and every other table — and re-runs the migrations, so the chain
starts again from a first-run database. Three code paths step around them on purpose: the
`20260310` backfill of `actor_name` (drops and recreates `activity_log_no_update` around it), the
developer sample-data seeder (disables `activity_log_no_update` to backdate `created_at`, which the
hash does not cover), and a backup restore (loads under `session_replication_role = 'replica'`, so
no trigger fires and the exported hashes are kept as they were, then verifies the chain and rolls
back if it fails).

## Why `BIGSERIAL` here (unlike most other tables)

Nothing else in the schema ever references an activity-log row by ID, the table is purely
append-only, and its natural read pattern is "give me the last N events" or "events after event
#X" — both of which a sequential integer serves better than a UUID or a text id (smaller index,
naturally chronological, cheap keyset paging for the Logs screen: `idx_activity_log_feed` and the
per-actor, per-action and per-entity indexes all end in `id DESC`). `id` is global; `sequence` is
the per-tenant number the chain is built on.

*History:* the initial schema created the table with a UUID `entity_id`, a UUID `actor_id`, three
actor types and two indexes, neither tenant-scoped. `20260301` added `tenant_id`; `20260302` and `20260303`
moved `entity_id` and `actor_id` to TEXT; `20260303` added `sequence`, `prev_hash`, `hash` and the
three triggers; `20260310` added `actor_name` and replaced the indexes with the tenant-scoped set
above; `20260316000000_public_api_and_connectors` widened the `actor_type` CHECK with `api_key` and
`connector`.

## Retention

This table grows forever by design (it's the audit trail), and the database refuses row deletes.
See `05-scaling-and-operations.md` for what happens once it gets large — the short version: nothing
needs deleting for a very long time at this business's scale. The Logs screen can export entries
(`logs.export`); pruning old rows would mean deliberately taking the delete guard down and
deciding what verification means for the rows that remain — an owner decision, never a silent
`DELETE`.
