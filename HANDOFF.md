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
phased build plan: **`PROJECT_PLAN.md`** (repo root). Read that in full before
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
   in `PROJECT_PLAN.md` §4.
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
   living in `/shared` so Master and Office can never drift out of sync on
   the wire format.

## Open questions (still unresolved — confirm with the user before finalizing)

From `PROJECT_PLAN.md` §12:
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

```
OrderBook/
├── HANDOFF.md          this file
├── PROJECT_PLAN.md      full requirements + architecture + phased plan
├── README.md
├── docs/schema/          full DB schema, table by table
├── shared/               TS types, Socket.IO event contract, discovery protocol (npm workspace)
├── master/               Master Panel server + frontend (npm workspace)
└── office/               Office Panel server + frontend (npm workspace)
```

(`master/` and `office/` are created as part of Phase 1 scaffolding — check
`git log` / the working tree for what actually exists if this file is stale
about them.)

## Status as of this session

- Requirements gathering and full architecture/schema design: **done**
  (`PROJECT_PLAN.md`, `docs/schema/`).
- Database engine decision (Postgres over SQLite): **done**, user confirmed.
- Phase 1 implementation ("working condition" build per `PROJECT_PLAN.md`
  §11): **starting now, in this same session** — check the git log after this
  point in the file for what actually landed, since this paragraph will not
  be kept up to date turn-by-turn.

## Working agreements for this repo

- Branch: `claude/ceramic-offline-web-app-6wjqq5` — all work happens here per
  the session's git instructions.
- Phase 1 is explicitly scoped as **working, not polished** — the user has
  deferred visual/branding polish to Phase 2. Don't gold-plate UI in Phase 1.
- Any architecture decision that contradicts or extends what's listed above
  should update this file and/or `PROJECT_PLAN.md`, not just live in chat
  history.
