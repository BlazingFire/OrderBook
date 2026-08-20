# Schema — Activity Log

Backs both the audit trail and the "live updating" feel described in
`PROJECT_PLAN.md` §1/§8 — every write the Master makes gets one row here, and the
same row's data is what gets broadcast over the `data:changed` Socket.IO event to
every connected panel.

```sql
CREATE TABLE activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,     -- sequential; order of events matters, cross-table refs don't
  entity_type TEXT NOT NULL,                          -- e.g. 'lead', 'product', 'party', 'office_panel'
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL,                          -- e.g. 'created', 'updated', 'status_changed', 'deleted'
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user', 'office_panel', 'system')),
  actor_id    TEXT,                                    -- users.id or office_panels.id, null for 'system'
  details     TEXT,                                    -- JSON: before/after snapshot or diff
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_activity_log_entity  ON activity_log(entity_type, entity_id);
CREATE INDEX idx_activity_log_created ON activity_log(created_at);
```

| Column | Notes |
|---|---|
| `entity_type` / `entity_id` | Point at any table's row without a hard foreign key — deliberately loose so this one table can log every entity type without a schema change each time a new entity is added. |
| `actor_type` / `actor_id` | `'system'` covers automatic changes (e.g. a scheduled stock recalculation) with no human/panel behind them. |
| `details` | Kept as JSON rather than separate `before`/`after` columns since the shape of a "change" differs wildly by entity type (a lead status change vs. a product price edit) — this is the one place in the schema where a JSON blob is the right call for everything, not just an escape hatch, because activity_log entries are read, not queried/filtered by their payload contents. |

## Why `INTEGER AUTOINCREMENT` here (unlike most other tables)

`00-overview.md` establishes UUIDs as the default primary key. `activity_log`
(and `stock_movements`) are the exception: nothing else in the schema ever
references an activity-log row by ID, the table is purely append-only, and its
natural read pattern is "give me the last N events" or "events after event #X" —
both of which a sequential integer serves better than a UUID (smaller index,
naturally chronological, cheap `WHERE id > ?` cursor pagination for the live feed).

## Retention

This table grows forever by design (it's the audit trail). See
`05-scaling-and-migration.md` for the archiving strategy once it gets large — the
short version: nothing needs deleting for a very long time at this business's
scale, and when it eventually does, old rows get exported and pruned, never
silently dropped.
