# Scaling & Operations

Direct answer to "is this fast, accurate, efficient, and powerful even if data
becomes big": PostgreSQL was chosen specifically to remove the ceiling a simpler
embedded database would eventually hit, while the Master's own managed cluster
(`master/src/db/postgres-server.ts`) keeps it a zero-install, zero-admin experience
for the shop-floor operator (see `00-overview.md` §1).

## 1. How big is "bigger," realistically?

A single ceramic company's order/inventory data, even a large one, over many
years:

| Table | Rough growth | 10-year estimate |
|---|---|---|
| `parties` | tens per week at most | low tens of thousands |
| `products` + `product_variants` | catalog changes rarely | hundreds of models, low thousands of variants |
| `leads` + `orders` | busiest records — say 50–200 leads/day across all Office Panels | hundreds of thousands |
| `line_items` | a few lines per lead, copied again onto each order | low millions of rows |
| `stock_movements` | one row per arrival, adjustment or dispatched variant | similar order to `line_items` |
| `activity_log` | one row per audited write, several per lead | several million rows |

PostgreSQL is proven in production at table sizes and write volumes **far**
beyond this — hundreds of millions of rows and multi-terabyte databases are
routine for it. The realistic ceiling above is nowhere near where Postgres starts
to need real tuning effort; a single local instance on ordinary shop-PC hardware
will stay fast for this workload for the business's entire foreseeable lifetime.

One limit that is **not** PostgreSQL's: party codes are drawn as
`'P-' || lpad(n, 4, '0')`, and `lpad` truncates, so the 10,000th party's code
collides with an earlier one (`02-parties-and-products.md`). The "low tens of
thousands" above reaches it.

## 2. What "powerful at scale" actually buys you here, concretely

- **GIN indexes for full-text search** — `parties`, `products` and `line_items`
  each carry a trigger-maintained `search_vector`, indexed `GIN (tenant_id,
  search_vector)` through the `btree_gin` extension, so the tenant filter and the
  match are served by one index (`06-tenancy-permissions-and-sync.md` §6).
- **Partial indexes** — the unique codes and names ignore Recycle-Bin rows
  (`WHERE deleted_at IS NULL`); the Bin's own keyset indexes cover only deleted rows;
  the open-leads, follow-up, dispatched-orders and active-reservation indexes hold
  only the rows those screens ask about. Each stays small however large its table
  grows.
- **Expression indexes** — `lower(code)` on `product_variants`, `lower(name)` on
  `product_categories` and `roles`, `lower(username)` on `users`: case-insensitive
  uniqueness enforced by the database.
- **Table partitioning** — if `stock_movements` ever grows large enough to matter
  (well beyond the estimate in §1), it can be converted to Postgres **declarative
  partitioning by month/year on `created_at`**: old partitions become trivial to
  archive, and queries scoped to a recent date range only touch the relevant
  partition. `activity_log` is harder: its hash chain, the unique
  `(tenant_id, sequence)` index (which a partitioned table would need to extend with
  the partition key) and its append-only triggers would all have to be carried
  across — a piece of design work, not a switch.
- **Real replication path** — if the business ever opens a second location with
  its own Master, Postgres's logical replication (or a scheduled dump/restore) is a
  supported, documented path to keeping two Masters in sync. This was the one
  scenario a single-file embedded database (SQLite) has no good native answer for —
  it's the main reason Postgres was chosen up front instead of migrating to it later.
  Every table is already keyed by `tenant_id` (`06-tenancy-permissions-and-sync.md`
  §1), which a merge of two companies' data would need.
- **Standards-compliant SQL** — window functions, `WITH` (CTEs), and rich
  aggregate queries are available for reporting without hitting feature gaps.

## 3. Keeping it "zero-install" as it runs (not just at first launch)

- The Master starts its bundled PostgreSQL as a child process of its own Node
  server, listening on `127.0.0.1:55432` only — no port exposed beyond what the
  Master's own Express/Socket.IO layer needs, and no separate Windows/Linux service
  for the operator to manage, start, or troubleshoot.
- The Postgres data directory is `<dataDir>/postgres/`, right next to
  `<dataDir>/uploads/` — the Master's Storage screen (`PROJECT_PLAN.md` §5.4) reports
  both together as "this app's disk usage".
- **Backups** (Settings › Storage, `storage.manage`) are an **encrypted export of the
  table rows**, not a copy of the folder: `backup-export.service.ts` reads every table
  through the ordinary `pg` connection (found via `information_schema`), and
  `backup-crypto.ts` seals it with a key derived from a passphrase of at least ten
  characters into one `.obbackup` file. It never carries `user_password_vault`,
  `master_clock` or Knex's bookkeeping tables, nor the uploaded image files, nor the
  key in `<dataDir>/secrets/`. A restore loads the rows in one transaction, verifies
  the activity-log hash chain, revokes every Office Panel and issues a new pairing
  password; if anything fails, the transaction rolls back and the live data is as it
  was.
- **Before an upgrade** the Master copies the stopped cluster folder to
  `<dataDir>/backups/before-<version>-<stamp>/` (with a `README.txt` of restore
  steps) whenever the booting version differs from the one in
  `<dataDir>/booted-version` — the version that last booted, recorded only after its
  migrations succeeded — and keeps the newest two
  (`master/src/db/cluster-snapshot.ts`). The copy fails soft: the boot carries on
  without one, and logs why, when `ORDERBOOK_UPGRADE_SNAPSHOT=0`, when a PostgreSQL
  process is still running on the cluster (a copy would not be consistent), when the
  drive lacks room for the copy plus 256 MB of headroom, or when the copy itself
  fails. There is no cluster to copy on first run, and none under `DATABASE_URL`,
  whose owner keeps their own backups. Migrations after 1.2.0 may only add
  (`docs/PRODUCTION_READINESS.md`), so an update replaces the program and never the
  data.
- **Autovacuum** (Postgres's built-in background maintenance) runs automatically —
  no manual `VACUUM`/`ANALYZE` scheduling needed for a workload this size, unlike
  the manual hygiene a file-based engine would need as it grows.

## 4. Practical scaling hygiene

- Always paginate list queries (keyset pagination on `created_at`/`id`, as the Logs
  screen and the Recycle Bin do, or `LIMIT`/`OFFSET` for short lists) — never fetch an
  entire table for a UI list, regardless of how small the table is today.
- Keep the indexes defined in each domain file in place; add new ones as real query
  patterns emerge (reporting-by-date-range on leads and orders is already covered by
  `idx_leads_created` and `idx_orders_created`, both `(tenant_id, created_at)`).
  Every new index goes in a new migration — migrations after 1.2.0 only add.
- Knex keeps a small fixed connection pool (`master/src/db/knex.ts`: min 2, max 10,
  with a 10-second acquire timeout so a leak surfaces as an error rather than a
  frozen panel) even though there's only one application process — don't override
  it down to 1: concurrent socket commands still benefit from more than a single
  connection.
- If `stock_movements` or `activity_log` ever becomes large enough to matter for
  backup size or query speed (well beyond this business's realistic scale per §1),
  partition and archive as in §2 — never a silent `DELETE` of audit history, which
  the database refuses anyway (`04-activity-log.md`).
