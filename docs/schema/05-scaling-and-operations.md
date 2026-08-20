# Scaling & Operations

Direct answer to "is this fast, accurate, efficient, and powerful even if data
becomes big": PostgreSQL was chosen specifically to remove the ceiling a simpler
embedded database would eventually hit, while `embedded-postgres` keeps it a
zero-install, zero-admin experience for the shop-floor operator (see
`00-overview.md` §1).

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

PostgreSQL is proven in production at table sizes and write volumes **far**
beyond this — hundreds of millions of rows and multi-terabyte databases are
routine for it. The realistic ceiling above is nowhere near where Postgres starts
to need real tuning effort; a single local instance on ordinary shop-PC hardware
will stay fast for this workload for the business's entire foreseeable lifetime.

## 2. What "powerful at scale" actually buys you here, concretely

- **GIN indexes on `JSONB`** (`products.parameters`, `lead_items.parameters`) —
  filter/search on flexible ceramic attributes at full index speed, not a table
  scan, even before those fields graduate to typed columns.
  See `02-parties-and-products.md`.
- **Expression indexes** (`lower(name)` on `parties`/`products`) — case-insensitive
  search stays index-backed as the catalog and customer list grow.
- **Table partitioning** — if `activity_log` or `stock_movements` ever grow large
  enough to matter (well beyond the estimate in §1), both can be converted to
  Postgres **declarative partitioning by month/year on `created_at`** with no
  application-code change: old partitions become trivial to archive or drop, and
  queries scoped to a recent date range only touch the relevant partition.
- **Real replication path** — if the business ever opens a second location with
  its own Master, Postgres's logical replication (or a simple scheduled `pg_dump`/
  `pg_restore` sync) is a supported, documented path to keeping two Masters in
  sync. This was the one scenario a single-file embedded database (SQLite) has no
  good native answer for — it's the main reason Postgres was chosen up front
  instead of migrating to it later.
- **Standards-compliant SQL** — window functions, `WITH` (CTEs), and rich
  aggregate queries are available from day one for whatever Phase 2 reporting
  (`PROJECT_PLAN.md` §11) ends up needing, without hitting feature gaps.

## 3. Keeping it "zero-install" as it runs (not just at first launch)

- `embedded-postgres` starts the bundled Postgres binary as a child process of the
  Master's Node server, bound to `localhost` only — no exposed network port beyond
  what the Master's own Express/Socket.IO layer needs, and no separate Windows/Linux
  service for the operator to manage, start, or troubleshoot.
- The Postgres data directory lives inside the app's own `data/` folder, right next
  to `data/uploads/` — the Master's "Storage" screen (`PROJECT_PLAN.md` §5.4) reports
  on both together as "this app's disk usage."
- **Backups** are a straightforward file operation: stop-or-checkpoint, copy the
  `data/` folder (Postgres data dir + uploads) to a USB drive or a second machine on
  the LAN. A `pg_dump` export can be added later (Phase 2, `PROJECT_PLAN.md` §11) for
  a human-readable/portable backup format on top of the raw file copy.
- **Autovacuum** (Postgres's built-in background maintenance) runs automatically —
  no manual `VACUUM`/`ANALYZE` scheduling needed for a workload this size, unlike
  the manual hygiene a file-based engine would need as it grows.

## 4. Practical scaling hygiene to follow from Phase 1

- Always paginate list queries (`LIMIT`/`OFFSET` or keyset pagination on
  `created_at`/`id`) — never fetch an entire table for a UI list, regardless of how
  small the table is today.
- Keep the indexes defined in each domain file in place; add new ones as real query
  patterns emerge (e.g. if reporting-by-date-range on `leads` becomes common, the
  existing `idx_leads_created_at` already covers it — confirm others as features are
  built).
- Use connection pooling at the Knex layer (a small fixed pool, e.g. 5–10
  connections) even though there's only one application process — this is Knex's
  default behavior and needs no extra setup, just don't override it down to 1.
- If `activity_log` or `stock_movements` ever become large enough to matter for
  backup size or query speed (well beyond this business's realistic scale per §1),
  convert to partitioned tables (see §2) and archive old partitions — never a
  silent `DELETE` of audit history.
