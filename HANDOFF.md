# HANDOFF — Session Context

Read this first in any new Claude Code session on this repo. It captures what
was decided and why, so work can resume without re-litigating settled
questions. Update it whenever a session makes a decision or finishes a chunk
of work — it should always reflect current reality, not just history.

## What this project is

**OrderBook** — an offline, LAN-only order & inventory management web app for a
ceramic company. No internet access at any point, ever. Two cooperating web
apps:
- **Master Panel** — one PC, owns the database and all files, connected to the
  local router.
- **Office Panel** — one or more other PCs on the same LAN, thin clients used
  by staff to create leads, manage parties/products, and promote leads to
  orders. No database of its own — everything goes through the Master live.

Full requirements, screen-by-screen flows, network pairing design, and the
phased build plan: **`docs/PROJECT_PLAN.md`**. Read that in full before
touching architecture — this file summarizes it, PROJECT_PLAN.md is the source
of truth.

Full database schema (every table, columns, indexes, and rationale):
**`docs/schema/`**, starting at `docs/schema/00-overview.md`.

## Key decisions made so far (do not re-decide these without a reason)

1. **Two Node.js/Express + Socket.IO servers**, one per panel type, each
   serving its own built React frontend on `localhost`. Master owns all
   persistent state; Office Panel is a thin client with only a small
   reconnect cache.
2. **Database: PostgreSQL**, not SQLite — chosen explicitly by the user after
   a comparison (see `docs/schema/05-scaling-and-operations.md`) for its
   headroom on JSONB/indexing/partitioning and a real replication path if a
   second Master (branch/factory) is ever added. Deployed via
   **`embedded-postgres`** (bundled binaries, started as a child process of
   the Master server) so the shop-floor operator never installs or manages a
   database service — same "just works" experience SQLite would have given.
3. **Query layer: Knex.js** talking to Postgres via the `pg` driver.
4. **Network pairing**: custom UDP broadcast discovery protocol (not mDNS —
   picked for reliability across mixed Windows/Linux LAN setups) with both
   an auto-discovery flow and a manual IP/ID/password fallback. Full protocol
   in `docs/PROJECT_PLAN.md` §4.
5. **`leads` doubles as `orders`** via a `status` column (`new` → `verified` →
   `order` → `cancelled`) — not two separate tables — matching the user's
   description of "moving" a lead to the order tab, not copying it.
6. **A lead can hold multiple products** (`lead_items` line-item table), even
   though the original brief described one product per lead — this avoids a
   painful schema change the first time a real order needs two products.
7. **Language: TypeScript** across `shared`, `master`, and `office` packages,
   npm workspaces monorepo — chosen for a "production-professional"
   architecture per the user's explicit request in this session, with shared
   types (entities, Socket.IO event contract, discovery protocol messages)
   living in `packages/shared` so Master and Office can never drift out of sync on
   the wire format.

## Open questions (still unresolved — confirm with the user before finalizing)

From `docs/PROJECT_PLAN.md` §12:
- Exact product attribute set for ceramics (size, finish/glaze, series, box
  quantity, price tiers, etc.) beyond the placeholder columns already in the
  schema — the `parameters` JSONB column is the escape hatch until this is
  nailed down.
- Party fields needed for this business (GST/tax ID, credit terms, multiple
  contacts?) beyond what's already in `parties`.
- Whether more than one Office Panel can edit the same lead concurrently, and
  how conflicts should be resolved (last-write-wins is the current default
  assumption, not yet confirmed).
- Desired app name/branding (currently just "OrderBook" per the repo name).

## Repo layout

Docs and code are strictly separated — prose under `docs/`, code under
`packages/`:

```
OrderBook/
├── HANDOFF.md              this file (kept at root by user request)
├── README.md
├── package.json            npm workspaces root
├── tsconfig.base.json
├── docs/
│   ├── PROJECT_PLAN.md      full requirements + architecture + phased plan
│   └── schema/              full DB schema, table by table
└── packages/
    ├── shared/              TS types, Socket.IO event contract, discovery protocol
    ├── master/              Master Panel server + React frontend
    └── office/              Office Panel server + React frontend
```

Each package uses the same internal layout (`src/config`, `src/services`,
`src/repositories`, `src/http`, `src/realtime`, `src/discovery`, `web/`) —
see `docs/PROJECT_PLAN.md` §10 for the layering rule (transport never queries
the database directly; only `repositories/` does).

Package contents land incrementally during Phase 1 — check `git log` or the
working tree for what actually exists if this section reads stale.

## Status

- Requirements gathering and full architecture/schema design: **done**
  (`docs/PROJECT_PLAN.md`, `docs/schema/`).
- Database engine decision (Postgres over SQLite): **done**, user confirmed.
- **Phase 1: done and verified end to end.** Everything in
  `docs/PROJECT_PLAN.md` §11 Phase 1 is built and working:
  - Master: self-managing PostgreSQL cluster (initdb/pg_ctl lifecycle, loopback
    only, no install step for the operator), Knex migrations implementing the
    full documented schema, first-run identity screen, sign-in, repositories →
    services → HTTP/realtime layering, UDP discovery responder, Socket.IO hub.
  - Office: UDP discovery client, auto + manual pairing, persisted panel
    credentials, reconnecting Socket.IO link with snapshot cache, local API
    forwarding commands to the Master, SSE stream to its own browser.
  - Both React frontends: Master (first-run, sign-in, dashboard, office panel
    management, leads/orders, settings/storage) and Office (connection screen
    with link indicator + auto/manual, home, Add Lead with inline party/product
    creation, leads/orders with promotion, catalog browsing).
  - Verified in a real browser across two running servers: fresh install →
    setup → auto-pairing with no IP typed → lead created on Office appearing
    live on Master → promotion to order updating the Master's list and
    dashboard with no reload → Master restart with automatic Office reconnect
    and data intact.

**What Phase 1 deliberately does not include** (deferred per the user's "make
it beautiful later" instruction and `docs/PROJECT_PLAN.md` §11 Phase 2): visual
polish, product image upload UI, inventory stock screens (tables exist, no UI),
reporting, per-user roles inside the Office Panel, and backup/restore tooling.

### Known gaps worth picking up next

- `panel:revoked` is defined in the socket contract and handled by the Office
  Panel, but the Master does not emit it yet — a revoked panel currently finds
  out on its next reconnect attempt rather than immediately.
- No automated test suite yet; verification so far has been manual/browser
  driven. Worth adding before Phase 2 changes start landing.
- Product images: schema and static route exist, no upload UI.

## Working agreements for this repo

- Branch: `claude/ceramic-offline-web-app-6wjqq5` — all work happens here per
  the session's git instructions.
- Phase 1 is explicitly scoped as **working, not polished** — the user has
  deferred visual/branding polish to Phase 2. Don't gold-plate UI in Phase 1.
- Any architecture decision that contradicts or extends what's listed above
  should update this file and/or `docs/PROJECT_PLAN.md`, not just live in chat
  history.
