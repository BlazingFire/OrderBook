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
   The PostgreSQL **server binaries are declared as per-platform optional
   dependencies** (`@embedded-postgres/<platform>`). That distribution
   contains server binaries only — `initdb`, `pg_ctl`, `postgres`. There is
   no `psql`, so anything that talks to the database must use the `pg`
   driver, never a client executable. **Caveat (unresolved):** those packages
   fetch their binaries in a postinstall script, and npm ignores failures in
   optional-dependency scripts — so `npm install` can "succeed" leaving no
   binaries, which is exactly what happened on the owner's Windows PC. The
   supported fallbacks are `DATABASE_URL` (existing server; what the owner's
   dev PC uses) and `ORDERBOOK_PG_BIN` (existing binaries). Making the
   bundled path reliable — or failing loudly — is still open work.
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
   living in `shared/` so Master and Office can never drift out of sync on
   the wire format.
8. **Configuration comes from a `.env` file** (gitignored; `.env.example`
   documents every setting), loaded by a small dependency-free parser in
   `<package>/src/lib/env-file.ts`. Package-level `.env` is read before the
   repo-root one, and a real environment variable always wins over both. The
   parser handles CRLF endings and quoted Windows paths — pinned by tests in
   `master/tests/env-file.test.ts` — because the file is edited in Notepad on
   the shop PC.

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

Documentation lives under `docs/`; each code package sits at the repo root:

```
OrderBook/
├── HANDOFF.md              this file (kept at root by user request)
├── README.md
├── package.json            npm workspaces root
├── tsconfig.base.json
├── docs/
│   ├── PROJECT_PLAN.md      full requirements + architecture + phased plan
│   └── schema/              full DB schema, table by table
├── shared/                  TS types, Socket.IO event contract, discovery protocol
├── master/                  Master Panel server + React frontend
└── office/                  Office Panel server + React frontend
```

Each of `shared/`, `master/` and `office/` uses the same internal layout (`src/config`, `src/services`,
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

- **Test suite: done.** ~200 tests (`npm test`). Unit tests run anywhere;
  integration suites drive a real PostgreSQL cluster in a temp directory and
  skip automatically when the binaries are missing or the process is root. CI
  runs lint + typecheck + tests + build on every push.
- **Phase 2 — inventory stock tracking: done and verified in the browser.**
  Ledger + snapshot, stock-in, physical-count adjustment, reorder levels and
  low-stock flagging, automatic deduction on lead → order inside the same
  transaction as the status change, and restoration on cancellation. Stock
  shows on the Master's Inventory tab and on the Office Panel's product list
  and Add Lead screen, updating live.

  **Policy worth knowing before changing it:** an order is never blocked by
  insufficient stock — a dealer routinely sells against an undelivered factory
  order, so stock may go negative and the shortfall is surfaced instead.

- **Running on the owner's Windows PC: confirmed.** The Master Panel runs at
  `http://localhost:4100` (LAN address `192.168.1.235`) on
  `C:\Users\Z\Desktop\OrderBook`, signed in, all tabs working. It uses a
  locally installed PostgreSQL via `.env`:
  `DATABASE_URL=postgres://postgres:...@localhost:5432/order_book`
  (the bundled-binaries path failed silently there — see decision 3). Getting
  it running surfaced and fixed two fresh-clone failures:
  - `shared/` compiled output missing → `prepare` + `pre*` scripts now build
    it before install/dev/start/migrate/test.
  - Frontend `web/dist` missing (gitignored build artefact) → `predev:*` and
    `prestart:*` now build the panel UIs too, and a request hitting the SPA
    fallback with no built `index.html` gets a plain "UI not built" page with
    the command to run, instead of the JSON 404 that read as a broken app.
  Next milestone on real hardware: pairing an Office Panel from a second PC
  (the owner has the step-by-step guide; firewall rules for TCP 4100 and UDP
  45789 on the Master PC are the known tripwire).

### Still to do in Phase 2

The user was asked to prioritise and chose inventory first. Remaining, roughly
in the order the plan lists them:
- Visual polish / branding pass (the user's "make it beautiful later").
- Reporting/analytics and printable order sheets.
- Product images upload, richer product parameters, bulk import from Excel/CSV.
- Multi-user roles/permissions within the Office Panel.
- Backup/restore tooling.

### Known gaps

- `panel:revoked` is defined in the socket contract and handled by the Office
  Panel, but the Master does not emit it yet — a revoked panel currently finds
  out on its next reconnect attempt rather than immediately.
- Product images: schema and static route exist, no upload UI.
- No frontend component tests; UI verification is browser-driven.
- **Bundled PostgreSQL is not reliable yet.** The `@embedded-postgres/*`
  packages (pinned `17.10.0-beta.17`; the binaries are official PostgreSQL
  17.10 builds) download ~60–100MB in a postinstall script, and npm treats
  optional-dependency script failures as non-events — a clean-looking
  `npm install` can leave no binaries. This bit on the owner's Windows PC;
  dev there now runs on `DATABASE_URL` instead. To make the shop-PC
  "nothing to install" promise real: verify the binaries exist at startup
  (already done — the error names the fix), but also make installation
  fail loudly or fetch the binaries ourselves at first launch.

### Traps worth knowing

- **`shared/` is consumed as compiled output**, not source. Anything importing
  `@orderbook/shared` fails on a clean checkout until `tsc` has run, which is
  why `prepare` and the `pre*` scripts exist. Do not remove them.
- **A PostgreSQL major-version change orphans the data directory.** The Master
  refuses to start and explains how to migrate, rather than deleting anything
  (`assertClusterVersionMatches`). The *test* helper does the opposite and
  rebuilds its throwaway cluster, since that data is disposable.
- **`npm install --save-optional --workspace` can record nothing** while still
  placing files in `node_modules` — which is how the embedded-postgres
  dependency was once "verified working" yet absent from the lockfile. Declare
  dependencies by editing the workspace `package.json` directly, then run
  `npm install`, and check the lockfile actually changed.
- **The frontends are build artefacts too.** `master/web/dist` and
  `office/web/dist` are gitignored; a server started without them serves the
  "UI not built" page. The `pre*` scripts handle this — same rule as
  `shared/`: do not remove them.

## Working agreements for this repo

- **Branching:** `main` is never pushed to directly. All work lands on `dev`,
  and reaches `main` only through a pull request.
- **Workflow:** the Claude cloud session develops, verifies what it can, and
  pushes to `dev`; the owner pulls on their PC
  (`C:\Users\Z\Desktop\OrderBook`) and runs there. The cloud session has
  no access to the owner's machine — anything Windows-specific is verified by
  the owner running it and reporting back.
- **The owner's dev PC uses an external PostgreSQL** via `.env`
  (`DATABASE_URL` → database `order_book`). The `.env` file is gitignored;
  never commit one, and never put credentials anywhere tracked.
- Phase 1 is explicitly scoped as **working, not polished** — the user has
  deferred visual/branding polish to Phase 2. Don't gold-plate UI in Phase 1.
- Any architecture decision that contradicts or extends what's listed above
  should update this file and/or `docs/PROJECT_PLAN.md`, not just live in chat
  history.
