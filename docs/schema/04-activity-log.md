# Schema — Activity Log

Backs both the audit trail and the "live updating" feel described in
`PROJECT_PLAN.md` §1/§8 — every write the Master makes gets one row here, and the
same row's data is what gets broadcast over the `data:changed` Socket.IO event to
every connected panel. PostgreSQL DDL — see `00-overview.md` for the type/
convention rationale.

```sql
CREATE TABLE activity_log (
  id          BIGSERIAL PRIMARY KEY,                 -- sequential; order of events matters, cross-table refs don't
  entity_type TEXT NOT NULL,                          -- e.g. 'lead', 'product', 'party', 'office_panel'
  entity_id   UUID NOT NULL,
  action      TEXT NOT NULL,                          -- e.g. 'created', 'updated', 'status_changed', 'deleted'
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user', 'office_panel', 'system')),
  actor_id    UUID,                                    -- users.id or office_panels.id, null for 'system'
  details     JSONB,                                   -- before/after snapshot or diff
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activity_log_entity  ON activity_log(entity_type, entity_id);
CREATE INDEX idx_activity_log_created ON activity_log(created_at);
```

| Column | Notes |
|---|---|
| `entity_type` / `entity_id` | Point at any table's row without a hard foreign key — deliberately loose so this one table can log every entity type without a schema change each time a new entity is added. |
| `actor_type` / `actor_id` | `'system'` covers automatic changes (e.g. a scheduled stock recalculation) with no human/panel behind them. |
| `details` | `JSONB` rather than separate `before`/`after` columns since the shape of a "change" differs wildly by entity type (a lead status change vs. a product price edit) — this is one of the places a JSON column is the right call for everything, not just an escape hatch, because activity_log entries are read as whole records, not filtered by their payload contents the way `products.parameters` is. |

## Why `BIGSERIAL` here (unlike most other tables)

`00-overview.md` establishes `UUID` as the default primary key. `activity_log`
(and `stock_movements`) are the exception: nothing else in the schema ever
references an activity-log row by ID, the table is purely append-only, and its
natural read pattern is "give me the last N events" or "events after event #X" —
both of which a sequential integer serves better than a UUID (smaller index,
naturally chronological, cheap `WHERE id > ?` cursor pagination for the live feed).

## Retention

This table grows forever by design (it's the audit trail). See
`05-scaling-and-operations.md` for the partitioning/archiving strategy once it
gets large — the short version: nothing needs deleting for a very long time at
this business's scale, and when it eventually does, old rows get exported and
pruned, never silently dropped.
