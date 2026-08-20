# Scaling & Migration Strategy

Direct answer to "is this compatible if data becomes bigger": **yes, comfortably,
for this business's realistic scale — and the schema/tooling choices below mean
switching to a bigger database engine later is a low-risk, mechanical change, not
a rewrite.**

## 1. How big is "bigger," realistically?

A single ceramic company's order/inventory data, even a large one, over many
years:

| Table | Rough growth | 10-year estimate |
|---|---|---|
| `parties` | tens per week at most | low tens of thousands |
| `products` | catalog changes rarely | hundreds to low thousands |
| `leads` + `lead_items` | busiest table — say 50–200 leads/day across all Office Panels | low millions of rows |
| `stock_movements` | one row per inbound/outbound event | similar order to `lead_items` |
| `activity_log` | one row per write, several per lead | several million rows |

SQLite is proven in production at **far** larger scale than this — single database
files well into the tens/hundreds of GB and tables with hundreds of millions of
rows are routine for it (it's what's inside every browser, most phones' local
storage, and plenty of desktop apps handling far more data than one shop's order
book). The realistic ceiling above is well inside SQLite's comfort zone; you will
not "outgrow" it from row count or file size in this business's lifetime.

## 2. What could actually force a change (and what wouldn't)

**Would force a change:**
- Wanting **multiple Masters** that each accept writes and sync with each other
  (e.g. separate factories/branches, each with their own Master, needing a shared
  view) — SQLite has no built-in multi-writer replication story. This is a genuine
  architecture change (multi-master replication), not just a bigger database.
- Wanting the Master itself to be reachable **over the internet** (cloud-hosted,
  multiple remote sites) — at that point a client-server database (PostgreSQL) run
  as a proper service makes more sense than a single file, mainly for operational
  reasons (backups, connection pooling from many remote clients), not because
  SQLite would fail.

**Would NOT force a change (SQLite handles these fine as-is):**
- More Office Panels on the same LAN — they don't touch the database at all, they
  only ever talk to the Master over Socket.IO (`PROJECT_PLAN.md` §2). Adding a
  10th Office Panel has zero database-scaling implication.
- More leads/orders/products/parties, even at the high end of the table above.
- More concurrent *readers* — WAL mode means dashboard reads on the Master never
  block or get blocked by writes.

## 3. Why the schema is portable even though it's written for SQLite

Every choice in `00-overview.md`'s conventions section was picked to also be valid,
idiomatic SQL on PostgreSQL or MySQL if that day ever comes:
- UUID text primary keys — not SQLite `ROWID` tricks.
- ISO 8601 text timestamps — not SQLite's `DATETIME()` functions.
- Integer money, not float.
- Standard `FOREIGN KEY ... REFERENCES` and `CHECK` constraints, all supported
  the same way across SQLite/PostgreSQL/MySQL.
- JSON confined to specific `parameters`/`details` columns via a query builder,
  not raw SQLite `json_extract()` calls sprinkled through application code.

## 4. The actual migration path, if/when it's needed

1. **Query layer is already engine-agnostic.** The app talks to the database
   through **Knex.js** (`PROJECT_PLAN.md` §3), not raw SQLite-specific SQL
   strings. Knex supports SQLite, PostgreSQL, MySQL, and others behind the same
   `.select()`/`.insert()`/`.where()` API. Migrating means changing Knex's
   connection config and re-running the same migration files against the new
   engine — application code that reads/writes data does not need to change.
2. **Migration files are the schema.** Every `CREATE TABLE` in these docs will be
   expressed as a Knex migration file from Phase 1 onward (not applied by hand),
   so "set up a fresh PostgreSQL instance with this exact schema" is `knex migrate:latest`
   pointed at the new connection string, not a manual translation exercise.
3. **Data move**: export each table to CSV/JSON (or use a tool like `pgloader` for
   a direct SQLite→PostgreSQL copy) and bulk-load into the new engine. At the row
   counts in the table above (single-digit millions), this is a one-time job
   measured in minutes, run once during a planned cutover.
4. **Nothing in the Office Panel changes at all** — it never talks to the database
   directly, only to the Master over Socket.IO, so this entire migration is
   invisible to it.

## 5. Practical scaling hygiene to follow from Phase 1 (no engine change needed)

- Always paginate list queries (`LIMIT`/`OFFSET` or keyset pagination on
  `created_at`/`id`) — never `SELECT *` an entire table for a UI list, regardless
  of how small the table is today.
- Keep the indexes defined in each domain file in place; add new ones as real
  query patterns emerge (e.g. if reporting-by-date-range on `leads` becomes
  common, index `leads(order_date)`).
- Run `PRAGMA optimize` / periodic `ANALYZE` and occasional `VACUUM` on the
  Master's SQLite file (a scheduled low-traffic-hours job) to keep the query
  planner's statistics fresh as tables grow.
- If `activity_log` or `stock_movements` ever become large enough to matter for
  backup size or query speed (well beyond this business's realistic scale per §1),
  archive rows older than N years to a separate `archive_activity_log` table or an
  exported file — never a silent `DELETE` of audit history.
