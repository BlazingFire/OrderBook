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
5. ~~**`leads` doubles as `orders`** via a `status` column.~~ **Superseded by
   decision 10.** Orders are now their own table, because the supplied
   lead-generation guide requires an order to run a pipeline independent of the
   lead's and to carry fields that only exist once something is a commitment —
   neither of which is possible on the row that also holds the lead's stage.
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
10. **The lead-generation rebuild** (2026-08-22), built from the owner's
    `lead-generation-full-flow.md` guide. The guide targets a different system
    — multi-tenant SQLite/FTS5, Electron — so `docs/LEAD_GENERATION_FLOW.md` is
    the version that is true of OrderBook, and its §11 lists every deliberate
    difference. What it changed, all confirmed by the owner before building:
    - **Orders are a separate record.** Conversion creates an `orders` row,
      copies the lines unchanged, and stamps `converted_order_id` on the lead,
      which survives as history rather than mutating into the order.
    - **Reserve, then dispatch.** Conversion writes `stock_reservations` per
      (product, colour); stock only leaves the ledger at dispatch. Inventory is
      therefore per-colour — a white basin does not satisfy a reservation for a
      blue one.
    - **One `line_items` table** for leads and orders, discriminated by
      `(parent_type, parent_id)`, with colour quantities as child rows. That
      shared shape is what makes conversion a copy rather than a translation.
    - **Text record ids** (`LD0000000042`, temporary `A3F9K2000000123`) with an
      `id_map`, because an offline panel must mint an id before the Master has
      seen the record.
    - **Multi-tenancy, a permission engine, and offline-first sync** — the
      owner asked for all three explicitly. Search stays on **PostgreSQL
      `tsvector` + GIN** rather than the guide's FTS5, since FTS5 is
      SQLite-only and decision 2 stands.
11. **Roles & Users** (2026-08-23), built from the owner's three supplied
    documents. Ported to this stack in `docs/ROLES_AND_USERS.md`, whose §16
    lists every divergence. The notable points:
    - **Permissions are one JSONB array on the role**, replacing the
      `role_permissions` join table added the day before. The supplied guide
      rejects the join table for a reason that only became true once offline
      sync existed: a per-key merge of two offline edits produces a *union*
      granting a combination neither administrator approved.
    - **A tier ceiling** (`office` / `management` / `admin`) caps what a role
      may hold, enforced on save and again at sign-in.
    - **scrypt**, replacing bcrypt, with legacy hashes upgraded silently on the
      next successful sign-in so nobody is locked out.
    - **`activity_log` is now hash-chained and append-only**, with triggers
      refusing UPDATE and DELETE.
    - **Soft delete** on roles and users; `users.role_id` deliberately has *no*
      SQL foreign key, so a restored role reattaches to its users and a
      user-creating mutation can arrive before its role does.
12. **Clean-architecture conventions on the Master server** (introduced in the
   2026-08-21 refactor session): pure business rules live in `master/src/domain/`
   (no I/O, no framework imports — importable by any layer, importing none);
   services orchestrate use cases against repositories; Knex types never leave
   `repositories/` — cross-repository transactional work passes the opaque
   `TransactionContext` token from `repositories/transaction.ts`; transport
   (`http/`, `realtime/`) contains no aggregation or business policy. Follow
   these when adding features: new invariants go in `domain/`, not inline in a
   service or route.

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

Each of `shared/`, `master/` and `office/` uses the same internal layout (`src/config`, `src/domain`,
`src/services`, `src/repositories`, `src/http`, `src/realtime`, `src/discovery`, `web/`) —
see `docs/PROJECT_PLAN.md` §10 for the layering rule (transport never queries
the database directly; only `repositories/` does). The master's `src/domain/`
holds pure business rules (actor identity, the lead status state machine,
paging clamps) with no I/O or framework imports; services orchestrate those
rules against repositories, and Knex types never leave the repository layer
(cross-repository transactions pass the opaque `TransactionContext` token).

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
- **Clean-architecture refactor of the Master server: done** (2026-08-21, no
  behaviour change; lint + typecheck + tests + builds verified). What moved:
  - `master/src/domain/` now holds the pure rules: `actor.ts` (`ActorContext`,
    `actorUserId` — previously defined in `catalog.service.ts` and imported
    everywhere), `lead-workflow.ts` (`canTransitionLead` +
    `stockEffectOfTransition`, keeping the status transition table and its
    inventory side effects in one place), `paging.ts` (clamps that were
    duplicated across three services).
  - `repositories/transaction.ts` exports the opaque `TransactionContext`;
    services no longer import Knex. `lead.repository`'s `onCommitted` callback
    was renamed `withinTransaction` (it runs inside the transaction, before
    commit — the old name was wrong).
  - Office Panel snapshot assembly moved from the Socket.IO hub into
    `services/snapshot.service.ts`; the hub is pure transport.
  - `LEAD_STATUSES` + `isLeadStatus` live in `@orderbook/shared` next to
    `LeadStatus`, replacing a hand-rolled guard in `data.routes.ts`.
  - Deliberately **not** abstracted: the per-mutation `recordActivity` +
    `publishChange` pairs in services. The payloads differ per call site and a
    generic "domain event" helper would hide what each mutation records
    without saving code — don't reintroduce one without a concrete need.

- **Lead-generation rebuild: done** (2026-08-22). Two migrations
  (`20260301000000_tenancy_access_and_sync`,
  `20260302000000_lead_order_rebuild`) migrate existing data rather than
  dropping it: leads keep their history, and a lead that had already reached
  `order` becomes a real order whose reservations are recorded as *consumed*,
  since it had already taken its stock under the old rules. Built end to end —
  schema, domain, repositories, services, HTTP, sockets, the Office Panel's
  offline store, and both frontends (Kanban boards, colour quantities,
  packaging, convert, dispatch, conflicts, universal search).

  **Verified against a real PostgreSQL 17**: `npm run verify` is green —
  244 tests across 15 files, including the four conversion guarantees the guide
  asks to be explicitly tested, the reserve/dispatch split, offline id
  promotion, replay idempotency, the field-level merge, permission refusals and
  field masking, and search finding a historical order under a product name
  that has since changed.

  Four real defects were found and fixed while testing, none of which a browser
  would have shown:
  - the activity log had been silently dead since `tenant_id` became NOT NULL —
    every insert failed into a bare `catch {}`. It now logs the failure.
  - `DATE` columns came back a day early anywhere east of UTC (the owner's
    machine is IST), because `toISOString()` converts to UTC first.
  - a reservation against a colour with no stock row was invisible on the
    inventory screen — exactly the case worth seeing.
  - the integration suite hung on Windows: `execFile` waits for the child's
    pipes to close, and the PostgreSQL server `pg_ctl` spawns inherits them and
    never lets go.

- **Roles & Users: done** (2026-08-23), migration
  `20260303000000_roles_and_users`. Roles and users became syncable records with
  `RL`/`US` text ids; the permission catalogue became a module x action grid plus
  grouped capabilities, served to the UI so the grid renders from it rather than
  from a list typed into the renderer. The Master Panel gained a Roles & Users
  screen with the permission grid, tier-change preview and one-time password
  dialog.

  `npm run verify` is green — **276 tests across 16 files**, including the
  supplied gate list: the last administrator cannot be deactivated (proven with
  two *concurrent* attempts), a password hash never leaves through a read path,
  an unknown permission key fails the whole save, a revoked permission takes
  effect on the next call with no re-login, and the audit chain refuses to be
  edited.

  Two defects the tests caught before they shipped:
  - **the scrypt verifier never matched anything** — the parse read six fields
    as five and took the cost parameter out of the tag, so every sign-in would
    have failed once bcrypt was gone;
  - migration `20260301` imported the *live* permission catalogue from
    `@orderbook/shared`, so editing that catalogue retroactively changed what an
    already-applied migration had done. Its seed values are now inlined and
    frozen, and `20260303` remaps the old coarse keys forward.

  **Not built** (also in §16): API keys, a cross-entity Recycle Bin screen, and
  the translation layer (the `labelToken` contract is in place, the layer is
  not). A Roles & Users *management* screen on the Office Panel does not exist
  either — roles and users are edited on the Master.

- **Office Panel per-user sign-in: done** (2026-08-24), closing the largest gap
  the supplied guides left. An Office Panel used to authenticate only as a
  *machine*, so everyone who walked up to it acted under the panel's role.
  Full design in `docs/ROLES_AND_USERS.md` §15. The three points that matter:
  - **The panel presents a token, never an identity.** The Master issues it at
    sign-in, the panel sends `auth:assume`, and every command on that socket then
    re-resolves the person's `roles` row. A modified panel cannot claim to be an
    administrator, and a revoked permission applies to the next command rather
    than the next reconnect. The decision lives in
    `master/src/services/panel-actor.service.ts` — *not* the hub, because whose
    authority a command carries is policy, not transport.
  - **Offline sign-in works against a verifier the panel minted itself**, at the
    one instant an online sign-in put the plaintext in its hands. The Master
    never sends a hash to a panel, so this is the only way the offline promise
    can hold — and it means a panel's disk says nothing about staff who have
    never used that machine.
  - **A rejection is final; only silence falls back.** If the Master is reachable
    and refuses, the local verifier must not be tried, or a password change would
    not stick on the panel. This is the single easiest thing to get backwards
    here and it is pinned by a test.

  `npm run verify` is green — **293 tests across 18 files**, up from 276.

  Not verified in a browser beyond the pre-sign-in screens: completing a signed-in
  run needs the Master's own credentials, which the session did not have. The
  server-side gate was confirmed by hand (`/api/snapshot` answers 401 until
  somebody signs in) and the sign-in paths are covered by tests.

- **Multi-agent audit against the three supplied guides: done** (2026-08-24).
  Six dimension auditors, each adversarially verified by a second agent whose job
  was to refute it; 104 gaps survived. The findings that were fixed, highest
  severity first:
  - **The integration suite was silently skipping on Windows.** The
    embedded-Postgres lookup built `${process.platform}-${process.arch}` =
    `win32-x64`, but the package installs to `windows-x64`, and the test helper
    had no Windows system-path fallback either. `canRunIntegrationTests` went
    false and every `describe.skipIf` suite — including the file that *is* the
    §15 gate list — reported skipped, which reads exactly like passing in the
    summary line. The same expression is in the production launcher, so the
    bundled-binaries promise did not hold on the target platform either. Both now
    use `embeddedPostgresPackageDir()`; the helper imports it rather than keeping
    a copy, because the copy is what drifted.
  - **Two unrecoverable lockout paths (critical).** G4 was absent from the
    role-edit path entirely, so the only admin role could be stripped of
    `users.manage` or re-tiered — no user row touched, company locked out. And
    the user-path count took no lock at READ COMMITTED, so two deactivations of
    two *different* admins both passed. See `docs/ROLES_AND_USERS.md` §8.1.
  - **The audit trail was not atomic with what it recorded.** Fixed for roles,
    users and auth; still best-effort elsewhere and now honestly named. §7.1.
  - **A Master revocation never reached a connected panel**, so an administrator
    could reset a password and the person could pull the network cable and sign
    in offline against the stale verifier. The wire now carries *why* a session
    was refused, the Master pushes it, and the panel revalidates every stored
    verifier on reconnect against a credential fingerprint.
  - **`field.saleRate.edit` enforced nothing.** It was in the catalogue and
    rendered as a toggle while appearing in no code path outside its own
    declaration — so a user who could not see rates could still set them, and
    unticking the box changed nothing.
  - **Both shipped non-admin roles were uneditable.** `20260303` expanded
    `parties.manage` into create/edit/delete without re-checking the tier
    ceiling, so the office-tier role held `parties.delete`. The grid renders an
    above-tier key as checked-but-disabled, so it could not be unticked, was
    resubmitted on save, and G2 rejected the whole save. Migration
    `20260304000000_role_tier_ceiling_repair` re-filters every role.

  `npm run verify` is green — **318 tests across 20 files**, and they now
  actually run on Windows without `ORDERBOOK_PG_BIN`.

- **Second wave of audit fixes: done** (2026-08-24). Everything above plus:
  - **The HTTP error envelope now carries `details`.** `ForbiddenError.permission`
    and `assertVersionMatches`'s `storedVersion` were attached by the domain layer
    and dropped by the transport, so `ApiError.missingPermission` was permanently
    undefined and the client's branches on it were dead code. A duplicate name is
    now `CONFLICT`/409 rather than a 400 indistinguishable from a tier rejection.
  - **`expectedVersion` is mandatory.** It was optional with an early return, so
    any caller disabled the stale-save guard by omission — and *every* user
    mutation in the shipped product did, making role reassignment and
    activate/deactivate plain last-write-wins.
  - **The role editor reports failures.** It called `onError`, which set state
    only the *list* branch renders, so with the editor open every failure looked
    like the Save button doing nothing. A 409 now shows the field diff with
    Reload / Overwrite; nothing is auto-applied.
  - **Destructive actions confirm, and a Recycle Bin exists.** `restoreRole` and
    `restoreUser` were declared, routed, and called by nobody.
  - **The realtime directory leak is closed.** Every role and user row was
    broadcast to every paired panel — whole staff list, every permission array —
    with no per-recipient check, while the request path required `users.manage`.
    A Master-admin socket also never re-checked its session, so a deactivated
    administrator kept streaming.
  - **Office Panel**: offline sign-in is throttled (3 failures / 60s, persisted
    so a relaunch does not reset it); the cached snapshot is re-masked for
    whoever is signed in *now*, not whoever it was fetched for; tabs are gated by
    permission; a hidden rate renders as `—` rather than a confident ₹0.00; and
    `UNAVAILABLE` (503) now distinguishes "the Master is not there" from "the
    Master said no".
  - **Sign-in audit completeness**: failures against an unknown username are
    recorded (that is the entire signal of a spraying attack), the deactivated
    branch records one, and entries name the source machine.
  - **Greppable invariants restored**: `readCredentialForVerification` has one
    call site again, `baseQuery` no longer selects `password_hash` via `u.*`, and
    `requirePermissionMiddleware` is mounted on every access route rather than
    defined and forgotten. `master/tests/credential-invariants.test.ts` pins all
    three by reading the source, which is unusual and is the point.
  - **Tenant-scoped identity lookups** and a within-batch `applied_mutations`
    dedupe (two copies in one push both applied; the second bookkeeping insert
    was swallowed by `onConflict().ignore()`).

  `npm run verify` is green — **333 tests across 21 files**.

  **Still not done from that audit**: `applied_mutations` is still not *atomic*
  with the effect it records (the projection, the bookkeeping row and the id
  mapping open three separate transactions — making that one is a restructuring
  of every service `route()` delegates to); the audit trail is atomic for roles,
  users and auth but still best-effort for leads/orders/parties/products/
  inventory/panels; roles and users have no mutation kind, so they cannot be
  created offline and no role conflict banner can exist; there is no username
  availability endpoint; and the permission grid has no arrow-key roving focus.

- **UI redesign + six new backend modules: backend planning done, backend implementation COMPLETE (all 9 stages)**
  (2026-08-24, foundation 2026-08-25, backend Stages 0–8 all 2026-08-25). The owner supplied a Claude Design UI system and asked for the
  backend for the screens it implies (Fields, Logs, Recycle Bin, Reports, PDF
  Designer, i18n, Office Dashboard) to be planned to implementation-ready
  detail before any code is written. That planning is done:
  - **Frontend plan**: `docs/UI_REDESIGN.md` — the mockup-to-real-screen
    mapping, the divergences between the supplied design and the two-app
    reality, the new `ui/` component workspace, and the phased build order.
    Its Phase 1 (design-system foundation) landed 2026-08-25, scoped to
    `office/web/src/ui/` to avoid root-file collisions with the concurrent
    backend session — see "Phase 1 landing notes" at the top of that document
    for what exists, what diverged and why, and what remains. The same
    foundation was ported to `master/web/src/ui/` the same day with its shell
    rewired onto it (aggregate presence rail per §4.8); see "Master Panel
    reskin" in that document.
  - **Backend plan**: a twelve-document specification set at
    `docs/backend-modules/` (`README.md` is the index) — architecture, file
    structure, database DDL, API contract, the existing-code change list,
    runtime workflows, the UI contract the backend must serve, permissions,
    i18n, the test plan, and the build sequence. Authored by parallel agents,
    then put through two adversarial consistency passes and a reconciliation
    pass against 25 arbitration rulings — the kind of thing that catches one
    document claiming a migration timestamp another document also claims, or
    a permission-grant algorithm with a subtle skip-on-duplicate bug. Both are
    fixed. **`docs/BACKEND_MODULES.md`** (singular file, no `s`) was the
    scoping pass that came before this; `docs/backend-modules/` (directory)
    is the actual spec to build from — read the directory, not the file.
  - **Owner decisions locked into the plan**: all six modules are
    permission-gated and reachable from **both** panels, not Master-admin-only;
    the `t()` translation layer **is** built (cheaper than first estimated —
    the `labelToken` contract already exists in `permissions.ts`); Orders
    keeps its Kanban board *and* gains a table view; the Master chrome goes
    permanently dark to distinguish it from the Office Panel at a glance.
  - **Implementation: all 9 stages done and verified** (2026-08-25).
    `docs/backend-modules/11-BUILD-SEQUENCE.md` owns the stage numbering.
    - **Stage 0 — socket ack `details`.** `CommandResult`'s `{ ok: false }`
      arm carries `details`/`messageKey`/`params`; `hub.ts`'s `respond()` sets
      them for any `AppError`, not only `ForbiddenError`; the Office's
      `MasterCommandError` and `forward()` carry them end to end.
    - **Stage 1 — i18n foundation.** `README.md` §8's open question is
      answered: `AppError.messageKey` **is required** (Option A) — `message`
      is derived from the English catalogue, and all **129** throw sites
      across `master/src` were swept to name a token — somewhat more than
      the plan's estimated 68 hand-written tokens, because several
      `UnauthorizedError` messages the plan would have collapsed into one
      generic token were kept distinct instead, to avoid losing information
      the product already gave (e.g. "this account has been deactivated" vs.
      "sign-in failed" vs. "too many failed attempts"). `shared/src/i18n/`
      has the full EN/HI
      catalogue (229 keys, matched and placeholder-parity-checked by a pure
      test), `t()`/`tCount()`, the Devanagari pseudo-locale, and the
      `no-untranslated-jsx-text` ESLint rule (registered `'off'`, promoted in
      the UI phase as specified). `recordActivity(entry, actor, trx)`
      landed here, ahead of Stage 4, across all 24 call sites.
      `CursorPage`/`CursorQuery` and the one cursor codec
      (`master/src/domain/cursor.ts`) are built. `config.locale.timeZone`
      plus startup validation is in `master/src/index.ts`.
    - **Stage 2 — Recycle Bin.** The first delete path that leads, orders,
      parties and products have ever had. `DELETE /api/{leads,orders,parties,products}/:id`
      (mounted in `data.routes.ts`, the first handlers there to carry a
      permission guard) plus `/api/recycle-bin` (list, counts, restore) and
      the matching Office Panel forwarding routes and socket commands.
      `RECYCLE_BIN_ENTITIES` ships with its Stage-2 six (`lead`, `order`,
      `party`, `product`, `role`, `user`); Fields and the PDF Designer append
      the rest at their own stages. Restoring a role or user now offers a
      deterministic rename on a name collision (`suggestRestoredName`) and
      correctly publishes `'restored'`, not `'updated'` — both were gaps in
      the existing roles/users Bin, closed as part of this module rather than
      filed separately. Migration `20260305000000_soft_delete_columns`.
    - **Stage 3 — Fields** (2026-08-25). Managed pipelines/stages, option-list
      values (incl. colour hex) and custom-field definitions get their first
      write surface: `/api/fields/*` (17 endpoints — catalogue, values,
      usage, definitions, stages, plus create/update/delete/reorder for each)
      mounted with the `access.routes.ts` per-handler-guard shape, matching
      Office forwarding routes, and matching socket commands. `fields.view`
      is new and ungated by tier; `fields.manage` moves `admin` → `management`
      (`shared/src/domain/permissions.ts`). `option_lists` and
      `custom_field_definitions` gain `deleted_at`/`version` and join
      `RECYCLE_BIN_ENTITIES` (six → eight); `pipeline_stages` gains
      `is_archived` (a *different* concept from soft delete — a real FK on
      `leads.stage_id`/`orders.stage_id` means a stage can never be deleted,
      only stopped from accepting new arrivals) and a deferrable sequence
      constraint so a full reorder can be written as one transiently-colliding
      permutation. Migration `20260306000000_field_values_and_stage_ordering`
      also completes `FIELD_LIST_KEYS` by seeding `stock.colour`,
      `product.productType` and `line.packaging` from whatever data already
      exists at migration time. `master/web/src/api.ts` and
      `office/web/src/api.ts` both gained their Fields wrappers — and, closing
      a Stage 2 gap found in passing, the Recycle Bin and per-entity delete
      wrappers (`deleteParty`, `recycleBin`, `restoreFromBin`, …) neither file
      had, despite the backend routes existing since Stage 2.
      - **A real gap closed beyond the file manifest:** `assertStageMove`
        (`master/src/domain/pipeline.ts`) had no rule against moving a lead or
        order *into* an archived stage — the gate list implies one
        ("an archived stage … is not a legal move target") but no stage in the
        list of files-to-change owned it. Added `Stage.isArchived` and a check
        in `assertStageMove`, token `validation.stage.archived`.
      - **The version-check race, closed properly for this module.** Every
        existing `expectedVersion` check in the codebase (roles, users,
        parties, products) reads the stored version *before* opening the
        transaction that writes it — a real check-then-act race under two
        concurrent saves that nothing currently tests for. Fields' equivalent
        (`fieldRepo.lockOptionListItem`/`lockDefinition`) takes a row lock
        (`SELECT … FOR UPDATE`) inside the transaction before comparing, which
        is what actually makes the "losing concurrent writer is refused and
        does not overwrite" gate true rather than merely likely. The same
        latent race in the older entities is not touched here — it is a
        pre-existing, wider-blast-radius issue, named so it is not
        rediscovered as a surprise.
      - **Test infrastructure gained real cross-test isolation for
        configuration tables.** `master/tests/helpers/fixtures.ts`'s
        `resetData()` previously only protected seeded *roles* from
        test-created debris; `option_lists`, `custom_field_definitions` and
        `pipeline_stages` needed the same treatment once Fields could mutate
        them, and `setupDatabase()` now force-corrects `pipeline_stages` to
        the migration's literal `LEAD_STAGES`/`ORDER_STAGES` shape before
        trusting the table's current contents as "the seed" — a *reused* test
        cluster can otherwise permanently enshrine an earlier bug's corruption
        (an `is_default` flag left on the wrong row) as the new baseline.
    - **A migration-timestamp collision, resolved by renumbering.** This repo
      had **seven other interactive sessions** running concurrently while
      Stage 3 was built (`ListAgents` — all named `orderbook-*`). One of them
      landed `master/src/db/migrations/20260307000000_product_images_pipeline.ts`
      (a product-images feature, not part of this spec set) before Stage 4
      started — but `docs/backend-modules/11-BUILD-SEQUENCE.md` §1.2 reserves
      `20260307` for Logs. **Owner decision: renumber to the next free slot.**
      Stage 4's migration is `20260310000000_activity_log_actor_name` — not
      `20260307` as the spec set says throughout — because `20260308` (PDF
      Designer) and `20260309` (the permission grant, which must run last) are
      both still reserved. Anywhere `20260307` appears in `docs/backend-modules/`
      referring to this migration is now stale; this paragraph is the correction.
    - **Stage 4 — Logs** (2026-08-25). The audit trail `activity_log` has been
      accumulating since `20260303` finally gets a read API: `/api/logs` (list,
      keyset-paginated on `id` — the only safe key, since `sequence` is
      nullable/non-unique and `created_at` ties under `now()`), `/api/logs/facets`,
      `POST /api/logs/verify` (re-walks the chain **in SQL**, since the digest
      covers Postgres's own `details::text` rendering and Node cannot reproduce
      those bytes), and `/api/logs/export` (CSV, `master/src/lib/csv.ts` —
      dependency-free, CRLF, formula-injection-guarded, shared with Reports at
      Stage 5). New `logs` module (`logs.view`, `logs.export`, office tier) plus
      `logs.verifyChain` capability. Matching Office forwarding and socket
      commands (`log:list`, `log:facets`, `log:verifyChain`, `log:export`) and
      API wrappers in both panels.
      - **A real bug found and fixed:** `activity_log.actor_name` was added by
        this migration but `recordActivity` never actually wrote it — the
        Stage 1 comment said the argument was "harmless, simply not persisted
        yet," and nothing in Stages 2–3 (Recycle Bin, Fields) needed the
        column to exist to compile, so the gap silently survived until a Logs
        test asserted on the column and got `NULL`. Fixed in
        `activity-log.repository.ts`'s `recordActivity`.
      - **A deliberate, disclosed deviation from `04-API-CONTRACT.md` §2.5:**
        the spec asks the export route to stream so a 250,000-row CSV is never
        held whole in memory. `exportLogs` buffers the assembled string
        instead, because the Office path has no streaming transport to its own
        browser for a socket-ack command and has to buffer regardless — one
        function serving both transports was judged more valuable than a
        leaner Master-only HTTP path. Bounded by the same 250,000-row hard cap
        either way; revisit if a real installation's log volume makes that
        bound itself the problem (open question O-2/O-4 in `04-API-CONTRACT.md`
        §12 — still genuinely open, decided pragmatically here for this one
        code path).
      - **Test infrastructure gained the same self-healing treatment `roles`
        already had, for `pipeline_stages`' `is_default`/`sequence`/`is_archived`.**
        Not new this stage, but confirmed still holding: `fixtures.ts`'s
        force-correction against the migration's literal seed shape is what
        made `logs.integration.test.ts`'s own tests (which create parties,
        users, fields values) reproducible across runs on the reused test
        cluster.
      - **Confirmed, not assumed: the reused integration-test Postgres cluster
        is not isolated between concurrent sessions.** Running the full suite
        while other sessions were also mid-test produced deadlocks, wrong
        minted ids and truncated-mid-flight errors having nothing to do with
        this stage's code — confirmed by re-running the same files alone
        immediately afterward, green. `master/tests/helpers/db.ts`'s
        "reuse the cluster for speed" tradeoff assumes one process at a time;
        it does not hold under this repo's current multi-session usage. Worth
        a real fix (a per-run data directory or port) if concurrent sessions
        working on this repo becomes the norm rather than the exception —
        not attempted here, since it is test infrastructure shared by every
        other session's suite too.
      - **A gap closed beyond the file manifest, matching the one Stage 3
        found:** `assertStageMove` had no rule against moving a lead or order
        into an archived stage until Stage 3 added one; Stage 4 found and fixed
        nothing further of this shape, but the pattern — a gate implied by the
        testing doc's prose with no line in `02-FILE-STRUCTURE.md` naming a
        file for it — is worth watching for at Stage 5 too.
    - **Verified:** `npm run verify` is green for everything this batch
      touched — **from 486 tests to 504** (`logs.integration.test.ts`, 18
      tests; the `credential-invariants.test.ts` and `fields.integration.test.ts`
      counts from Stage 3 stand). Confirmed by isolated re-run rather than a
      full-suite number, since a full-suite run in this session collided with
      concurrent sessions' own test runs (previous bullet) and its numbers are
      not trustworthy as a batch total right now.
    - **Stage 5 — Reports** (2026-08-25). No migration of its own — its
      indexes already landed folded into Stage 4's. `/api/reports/dispatches`,
      `/api/reports/lead-outcomes`, `/api/reports/top-parties`,
      `/api/reports/:report/export` — the **first enforcement site anywhere**
      for `reports.view`/`reports.export`, which had shipped as togglable grid
      cells gating nothing since `20260303`. Date safety is the whole module:
      `master/src/domain/report-range.ts` resolves a period from
      `{year,month,day}` components only (never a `Date`); every calendar
      boundary and month bucket is computed **in SQL** against
      `config.locale.timeZone` and returned as `'YYYY-MM'` TEXT;
      `master/src/domain/lead-outcome.ts`'s `classifyLeadOutcome` is a pure
      classifier using a proper Julian-day-number calendar difference (also no
      `Date`) that the SQL `CASE` in `report.repository.ts` is written to
      agree with exactly. Top parties is anchored on `orders.dispatched_at`,
      not `created_at` — verified by a test that creates an order in March and
      dispatches it in April and asserts it lands in April, the only gate that
      can actually tell the two anchors apart. Matching Office forwarding
      (`report:dispatches`/`report:leadOutcomes`/`report:topParties`/`report:export`)
      and API wrappers in both panels; `office/src/http/app.ts` gained a
      `forwardCsv()` helper shared with Stage 4's `log:export`, replacing that
      stage's one-off inline copy.
      - **`QUIET_AFTER_DAYS = 30` is still the designer's placeholder, not the
        owner's number** (`master/src/domain/lead-outcome.ts`) — the "went
        quiet" threshold for this business. Cheap to change (one constant,
        `report-range.test.ts` already pins the classifier's behaviour at the
        boundary) and worth the owner's actual answer before this report ships
        to a real screen. Flagged here rather than blocking Stage 5 on it,
        matching how Stage 1 proceeded on `messageKey`-required before every
        open question had a final owner sign-off.
      - **Every gate that could tell a subtly-wrong report from a right one
        passed on the first run** — RPT-6 (23:30 IST dispatch bucketing into
        the correct month), RPT-17 (the dispatched-vs-created anchor), RPT-9
        (BIGINT-as-string totals summing as numbers), RPT-12/13 (absent, not
        null-or-zero, money keys for a rate-blind caller) — no fix-and-rerun
        cycle was needed here, unlike Stages 3–4.
      - **`toIsoDate` (`master/src/repositories/mappers.ts`) got its first
        test coverage ever**, added to `mappers.test.ts` per the testing doc's
        own observation that the existing IST-defect fix had zero references
        in the test file that was supposed to pin it.
    - **Verified:** `npm run verify` is green — **from 504 tests to 562**
      (`reports.integration.test.ts` 13, `report-range.test.ts` 18 pure,
      `mappers.test.ts` +4 for `toIsoDate`, `credential-invariants.test.ts` +1).
      Confirmed both isolated and alongside Fields/Logs/Recycle-Bin/Catalog/
      Inventory in one run — 225 tests, all green, no regressions.
    - **Stage 8 — Office Dashboard** (2026-08-25). No migration of its own.
      `DashboardSummary` gained `openOrderCount`, `dispatchedThisWeekCount`
      and `pipelineBreakdown`, and every existing field became optional — a
      breaking type change for every current reader, fixed at the two call
      sites it touched (`master/web/src/App.tsx`'s low-stock badge,
      `office/tests/outbox.test.ts`'s fixture). `master/src/repositories/dashboard.repository.ts`
      is new (`leadCountsByStage` — every stage present even at zero, joined
      from `pipeline_stages` not a hardcoded list; `dispatchedThisWeek` —
      the week boundary computed **in SQL** against `config.locale.timeZone`,
      same discipline as Reports; `openOrderCount`; `countRecentMutations`,
      moved here from the service, closing the one standing `db()`-in-a-
      service violation the spec called out by name). `dashboard.service.ts`
      gates each figure independently via `actorCan` (never throws — a
      missing permission means the figure is absent, not a 403), and there is
      deliberately no `dashboard.view` key: each figure is governed by the
      module permission that already owns its data. `snapshot.service.ts`
      folds the summary into `SyncSnapshot.dashboard`; `hub.ts` gained a
      `dashboard:get` command and `broadcastDashboard()` now also pushes to
      every connected Office Panel socket, not just Master admin sockets.
      Office's `filterDashboardForCurrentUser` re-gates the cached figure set
      for whoever is signed in *now*, mirroring the existing rate-masking
      re-check; a new `SNAPSHOT_POLICY` map
      (`Record<keyof SyncSnapshot, SnapshotPolicy>`, `office/src/http/app.ts`)
      makes a newly-added `SyncSnapshot` key a compile error if nobody decides
      what `forCurrentUser` does with it, per `docs/backend-modules/10-TESTING.md`
      §6.8's `DSH-1` requirement.
      - **A real crash bug found and fixed, not just documented:** `buildSnapshot`
        called `catalogService.listParties`/`listProducts`/`listCategories`,
        `leadService.listLeads`, `orderService.listOrders` and
        `inventoryService.listStock` unconditionally, and every one of them
        throws `ForbiddenError` via `requirePermission` when the actor lacks
        the module's `.view` key. A snapshot request from an actor missing
        even one of five module permissions failed the *entire* request —
        including the dashboard figures they *did* hold — rather than
        returning those collections empty. `DSH-7` (`buildSnapshot` must not
        become all-or-nothing) caught it on the first integration run.
        Fixed by gating each of the six collections on its own `actorCan`
        check in `snapshot.service.ts`, resolving to `[]` rather than calling
        through when absent — the same "was it visible at all" pattern
        `dashboard.service.ts` already used, just not yet applied to the rest
        of the snapshot. This does not touch the separate, already-known,
        deliberately-deferred gap that `forCurrentUser` does no module-level
        *filtering* of a cached Office snapshot (`10-TESTING.md` §6.8's note
        under `DSH-1`) — that is about what a *permitted* collection still
        exposes to a session that later loses a permission on stale disk
        cache, a different problem from the Master itself refusing to build
        the snapshot at all, which is what this fix addresses.
      - **`DSH-3`'s client-rendering half is not built, and could not be
        without scope creep.** The gate's other half — "a disconnected panel
        labels every card stale except the sync card" — is a UI rule keyed
        off `dashboard.asOf`, and no Office Dashboard *screen* exists yet;
        Stage 8 as scoped by `11-BUILD-SEQUENCE.md` covers only `master/src`,
        Office forwarding, and the `office/web/src/api.ts` wrapper
        (`refreshDashboard`), the same boundary every earlier stage in this
        batch respected. `office/tests/dashboard-staleness.test.ts` covers
        the backend-testable half (`forCurrentUser` strips a figure the
        current session does not hold) and documents the deferred half in
        its header rather than fabricating a test for UI that is not there.
      - **Verified:** `office/tests/snapshot-masking.test.ts` (3 tests,
        `DSH-1`/`DSH-2`) and `office/tests/dashboard-staleness.test.ts`
        (2 tests, `DSH-3`'s backend half) are pure — drive `GET /api/snapshot`
        through `createApp()` with `localStore.getView`/`userSession` mocked,
        the same harness `module-forwarding.test.ts` already established.
        `master/tests/dashboard.integration.test.ts` (6 tests, `DSH-4`…`DSH-9`)
        needs a real cluster, per this section's own correction note about
        why those six gates cannot live in a pure suite. Full lint and
        `tsc -b --force` across all five workspaces are clean; the new and
        adjacent suites (dashboard, snapshot-masking, dashboard-staleness,
        outbox, module-forwarding, sync.integration, credential-invariants —
        47 tests across 7 files) pass in an isolated run. A full-suite total
        was not taken this time either, for the same reason Stages 4–5
        skipped it: seven other concurrent sessions were still active on this
        repo (`ListAgents`) and a full run's numbers would not be trustworthy
        as a batch total.
    - **The `11-BUILD-SEQUENCE.md` §2.2 fontkit spike: run, and it passed**
      (2026-08-25). The gate two claims, checked against `fontkit@2.0.4`
      (added as a real `master` dependency, `@types/fontkit` alongside it)
      and Noto Sans Devanagari Regular (sourced from `@fontsource/noto-sans-devanagari@5.3.0`,
      SIL OFL-1.1, for the spike only — not vendored into `master/assets/fonts/`
      yet, since that is Stage 6's own work):
      - `font.layout('हिन्दी')` returns **5 glyphs for 6 codepoints** — न्द
        (na + virama + da) shapes to one conjunct glyph (`uni0928094D`), not
        three separate marks. Conjunct formation confirmed.
      - `font.layout('कि')` (क U+0915 then ि U+093F, consonant-then-vowel in
        storage order) shapes to glyph order **[i-matra, क]** — the vowel
        sign's glyph comes first in the output stream even though its
        codepoint comes second in the input. Reordering confirmed.
      - The first check of `कि` used the wrong method (comparing the shaped
        glyph's exact id against an isolated `font.layout('ि')`'s id) and
        reported a false FAIL — the i-matra is a *contextual* glyph with a
        different exact id depending on the preceding consonant, so an
        isolated shaping is a different variant, not a mismatch. Corrected to
        compare glyph *names* (Noto's convention keeps a shared `uni093F...`
        prefix across every i-matra variant), which is what the numbers above
        reflect. Worth remembering if anyone re-runs or extends this spike:
        exact glyph-id comparison across different shaping contexts is not a
        valid test for "is this the same character."
      - **Conclusion: fontkit's Indic shaper is real and works against this
        face — proceed with fontkit + PDFKit for Stage 6, no fallback ladder
        needed.** Owner still needs to confirm Stage 6 is wanted before it
        starts (it was deferred once already, and it's the largest module in
        the batch) — the spike only clears the technical gate, not that one.
      - Scratch spike script and the `@fontsource` tarball used to source the
        font were both left in the session scratchpad, not committed —
        `fontkit`/`@types/fontkit` in `master/package.json` (and the
        lockfile) are the only durable change from this measurement.
    - **Stage 6 — PDF Designer** (2026-08-25), migration
      `20260308000000_document_templates_and_exports`. The largest module in
      the batch, and the one previously deferred on purpose. Server-side
      rendering with PDFKit + fontkit and four vendored SIL OFL faces:
      `/api/documents/*` (14 endpoints — templates CRUD + restore, assets,
      render, preview, export history and the authenticated file download),
      14 matching socket commands and 14 Office forwarding routes, plus API
      wrappers in both panels. New `documents` module
      (`view`/`create`/`edit`/`delete`, `delete` at management tier) and the
      `documents.render` capability in the `workflow` group.
      - **Rate redaction is a *layout* fact, not a rendering one.** The whole
        module hangs on this: `master/src/domain/document-model.ts` is the
        seam where an already-masked Lead or Order plus a template becomes a
        pure `DocumentModel`, and when rates are out the rate and line-total
        columns are **omitted from `model.columns`** and the totals block is
        dropped entirely. `master/src/pdf/renderer.ts` then has nothing to
        decide — it draws the columns it is given, and there is no code path
        in it that could reintroduce one. Proven end to end by `PDF-55`,
        which renders a real PDF for a rate-blind actor and asserts the
        **extracted text** carries no figure, no `Rate`/`Amount` heading and
        no total.
      - **`master/tests/document-render.integration.test.ts` extracts text
        through `pdfjs-dist`, not by grepping the bytes**, and that choice is
        load-bearing rather than fussy. PDFKit *subsets* every embedded font,
        so the content stream holds subset glyph indices, not characters —
        a substring search for a formatted rate finds nothing whether or not
        the rate is printed, and the redaction gate would have passed for
        entirely the wrong reason. The first version of that helper did
        exactly this and "passed"; `pdfjs` maps glyphs back through the
        ToUnicode CMap and is what actually reads the page.
      - **The vendored mono face is Source Code Pro, not IBM Plex Mono as
        `02-FILE-STRUCTURE.md` §3.7 names.** Every IBM Plex Mono TTF build
        available carries a space glyph whose `loca` entry points past the
        end of its `glyf` table; fontkit throws `RangeError: Offset is
        outside the bounds of the DataView` from `_getCBox` the moment PDFKit
        subsets any string containing a space — which is every page footer
        the renderer draws. The one IBM Plex source that survives (the
        official `@ibm/plex-mono` WOFF2) is not subset by PDFKit at all and
        adds ~260 KB to every document, against ~4 KB for a TTF that subsets
        properly. Source Code Pro is SIL OFL 1.1 like the other three and
        covers the rupee sign. `PDF-4` now asserts every vendored face can
        measure its own space glyph, so a font swap cannot reintroduce this.
      - **A real bug the tests caught before it shipped:** `drawTerms`
        originally drew the terms paragraph through PDFKit's own
        `text(…, { width })` wrapper, which binds **one** font for the whole
        call — so a Hindi clause in the terms silently mapped to `.notdef`
        and vanished while the English around it rendered perfectly. Fixed
        with a `wrappedRunText` primitive that word-wraps and then draws each
        line through the script-splitting path. This is the failure mode the
        whole `splitByScript` design exists to prevent, and it still got in
        once by way of the one place wrapping was wanted.
      - **A pre-existing Stage 3 defect found and fixed in passing — the
        Recycle Bin's branch list had silently diverged from its own entity
        list.** `option_list_item` and `custom_field_definition` were added to
        `RECYCLE_BIN_ENTITIES` and to `RESTORE_PERMISSION` when Fields landed,
        and `custom-field.repository.ts` grew `restoreOptionListItem`/
        `restoreDefinition` — but no service function ever called them, no
        `UNION` branch was added to `recycle-bin.repository.ts`, and
        `restoreEntity` had no `case` for either. The result: a soft-deleted
        option value or custom field was **invisible in the Bin and
        unrestorable through it**, while every type check in the codebase
        insisted it was a Bin entity. Nothing errored; the feature simply did
        not exist. Stage 6 would have made it three missing branches. Now
        fixed for all three, with `fields.service.ts` gaining the two missing
        restore functions and a new gate (`FLD-19b`) asserting every member of
        `RECYCLE_BIN_ENTITIES` has a branch behind it — the check that was
        missing is what let the divergence live. The three new branches need
        an explicit `id::text`: they sit on UUID primary keys while the six
        older ones are on TEXT record ids, and Postgres refuses a `UNION`
        mixing `uuid` with `text`.
      - **Deviations from the contract, all deliberate:** a fourteenth
        endpoint (`GET /api/documents/assets`) was added because
        `04-API-CONTRACT.md` gives the designer asset upload and fetch-by-id
        but no way to discover what a tenant already has — a gap, not a
        decision; all three surfaces (HTTP, socket, Office) agree at
        fourteen. And the Office Panel's `forwardFile` buffers PDF bytes
        whole through the socket ack, the same disclosed O-2 limitation the
        Stage 4/5 CSV exports carry, for the same reason: there is no
        streaming transport between the two servers for an ack-shaped
        command, so a Master-side stream would be re-buffered anyway.
      - **Still open, and genuinely so:** `04-API-CONTRACT.md`'s O-5 — what
        the renderer should do when the Devanagari face has no glyph for a
        character (declared fallback chain, a pre-render coverage check
        refusing with a 400 naming the character, or accept the blank box).
        Not decided, not implemented; the current behaviour is whatever
        PDFKit does, which is the blank box.
    - **Stage 7 — the shared permission grant** (2026-08-25), migration
      `20260309000000_new_module_permission_grant`. Grants the batch's eleven
      new keys (five `documents.*`, three `logs.*`, `fields.view`, two
      `recycleBin.*`) to **administrator-tier roles only**, across every
      tenant including soft-deleted roles. Union, not replace, so it converges
      identically on a fresh install (where `20260303`'s live
      `allPermissions()` import already granted them) and on the owner's
      migrated database (where it did not). Key list inlined and frozen —
      importing the live catalogue is the `20260301` defect.
      - **The no-op test is `NEW_KEYS.every(key => stored.includes(key))`,
        never a length comparison**, and `GRANT-5` exists solely to pin that.
        `permissions` is JSONB and nothing forbids a duplicate; a union
        deduplicates, so `merged.length === stored.length` can be true for a
        row missing every key the migration exists to grant. That row would
        be skipped, the migration would report success, and the symptom would
        surface weeks later as an administrator who cannot open the Logs
        screen. `20260304` is not a counterexample — it *filters*, and a
        filter cannot lengthen an array.
      - **It is registered last in the array, not last by timestamp.** Its
        `20260309` slot was reserved before concurrent sessions claimed
        `20260310`/`20260311`; what actually matters is that it runs after
        every module that mints a key, and Knex follows the hand-maintained
        array order in `migrations/index.ts`, not the filename.
    - **Verified:** lint, `tsc -b` across all five workspaces, and the test
      project all clean. **238 tests across 16 files** green in one run —
      the six new Stage 6/7 suites (`document-fonts` 5 pure,
      `document-model` 15 pure, `document-template` 17 pure,
      `document-template.integration` 17, `document-render.integration` 18,
      `migration-grant.integration` 8) alongside Fields, Recycle Bin,
      Dashboard, Reports, Logs, the credential invariants and both Office
      pure suites, with no regressions. A full-suite total was not taken, for
      the same reason Stages 4–5 and 8 skipped it: other sessions were still
      active on this repo and share the integration cluster.
    - **A pre-existing, unrelated item found in passing:** `office/web/src/ui/`
      is mid-work from the concurrent UI-redesign session (see
      `docs/UI_REDESIGN.md`'s "Phase 1 landing notes") and does not fully
      typecheck (`Splash.tsx` references a missing `./logoCells` module). Not
      touched by this batch — it belongs to that other session's scope.

- **Conservative dead-code sweep: done** (2026-08-25). An unused-dependency
  audit across all five workspaces found nothing to remove — every declared
  dependency has a real import. Four provably-orphaned exports were deleted
  after confirming zero references anywhere in code, tests, or docs:
  `role.repository.ts`'s `tierRoleId` (an exact duplicate of
  `user.repository.ts`'s `roleIdForTier`, which is the one actually called),
  `sync.repository.ts`'s singular `findAppliedMutation` (superseded by the
  batch `findAppliedMutations`, which is what `sync.service.ts` calls),
  `lead.service.ts`'s `LEAD_MERGE_FIELDS` (not even used within its own file —
  `initialFieldHlc` hardcodes the same field names inline, and
  `conflict.service.ts` has its own separate `COLUMNS.lead` map), and
  `shared/src/protocol/pairing.ts`'s `PairingFailure`/`PairingFailureReason`
  (the error-shape type was never adopted — `panel.service.ts` throws plain
  `UnauthorizedError`/`ValidationError` instead). `npm run verify` stayed
  green throughout — lint, typecheck, and all 461 tests across 30 files.
  **Deliberately left alone** despite zero call sites: `domain/i18n-tokens.ts`'s
  `assertActivityTokenExists` — `docs/backend-modules/02-FILE-STRUCTURE.md`
  names it as the intended enforcement mechanism, but the shipped
  `i18n-tokens.test.ts` independently re-implements the same check by reading
  service source directly instead of calling it. Worth a deliberate decision
  (delete the function and update the spec doc, or wire the test to call it)
  rather than a bloat-sweep guess. Also left untouched, per this repo's own
  documented reasons: `office/web/src/ui/Splash.tsx`'s missing `./logoCells`
  import (another session's scope), the per-mutation `recordActivity`/
  `publishChange` pairs (deliberately not abstracted), and the
  `styles.css`/`format.ts`/`Field.tsx` duplication between `master/web` and
  `office/web` (deferred to the UI-redesign consolidation pass).

- **Product image pipeline: done** (2026-08-25), built from the owner-supplied
  `7-IMAGE-PIPELINE.md`. That spec targets a different product shape — an
  Electron app reading files straight off local disk — so it was ported the
  same way `LEAD_GENERATION_FLOW.md` and the UI redesign were: keep the
  invariants, adapt the mechanism to what actually exists here (plain
  Express/React over HTTP, no Electron process anywhere). Every porting
  decision below was made rather than asked, since none of them is a product
  choice — they're forced by "this app has no Electron `BrowserWindow`" and
  "this app already has an offline-outbox architecture the spec's binary
  bytes don't fit into."
  - **Import pipeline**: `sharp` decodes (HEIC included — the installed
    Windows x64 build bundles `libheif 1.18.2`, confirmed by reading
    `sharp.versions` at runtime; not yet confirmed on a real HEIC photo from
    an iPhone, which needs the owner's hardware, same caveat as every other
    "verified by the owner running it" item in this file), auto-orients from
    EXIF, applies the editor's rotation, crops, then derives `master`
    (2048px/q90), `large` (800px/q82), `thumb` (240px/q78), `micro` (64px/q60)
    as WebP, plus a SHA-256 checksum and a `blurhash` placeholder — all in
    `master/src/domain/images.ts` (pure math) and
    `master/src/services/image.service.ts` (the `sharp` calls and disk I/O).
    Runs once, at upload; nothing on the render path ever resizes.
  - **Storage**: the `product_images` table already existed
    (`docs/schema/02-parties-and-products.md`) but had zero application code
    behind it (`HANDOFF.md` used to say exactly that). Migration
    `20260307000000_product_images_pipeline` reshapes it — drops the unused
    `file_path`, adds `caption`/`sequence`/`width`/`height`/`checksum`/
    `blurhash`/`byte_size` — rather than adding a new table, since a variant's
    path is now a deterministic function of its id
    (`<uploadsDir>/images/<tenantId>/<imageId>/<variant>.webp`). `id` stays a
    plain UUID (`randomUUID()`, mirroring Fields' `option_list_item`), not the
    `LD`/`PR`/… text-id scheme — images are uploaded online-only, so they
    never need offline temporary-id promotion.
  - **Online-only, like Stock and Recycle Bin.** The offline outbox
    (`office/src/sync/outbox.store.ts`) only ever queues JSON mutations; there
    is no mechanism to queue a multipart file through it, and building one was
    out of scope. Upload/caption/reorder/delete all fail with a `503` when the
    Master is unreachable, exactly like a stock movement does today.
  - **Transport**: image bytes travel over the existing Socket.IO command
    channel (`product:image:upload`/`update`/`reorder`/`delete`, `image:fetch`)
    as binary attachments, not a second HTTP surface between the two servers —
    `maxHttpBufferSize` raised on the hub to accommodate a 60 MB source photo.
    This is the same channel Fields/Recycle Bin/Stock already forward
    through, so it needed no new cross-server authentication.
  - **Serving**: `GET /api/images/:imageId/:variant` on the Master is
    permission-gated and 404s (not 403) when the caller cannot see the
    product, per the spec's own wording — `image.service.ts#resolveImageFile`
    throws the identical `NotFoundError` either way, so a disallowed caller
    cannot distinguish "doesn't exist" from "can't see it." No separate
    `images.view` permission exists; a photo is visible to anyone who can see
    the product it's on, matching the spec.
  - **Office Panel caching — the one deliberate functional gap against the
    spec.** §4.3/§5 ask for every Office Panel to hold a full proactive
    background-prefetched replica of every image (thumb/micro first) so
    rendering never touches the network, with resumable partial downloads.
    What shipped instead is a **lazy on-demand cache**:
    `office/src/http/app.ts`'s `GET /uploads/images/:imageId/:variant` serves
    from this panel's own disk on a hit, and on a miss fetches the variant
    from the Master over the socket channel and writes it to disk before
    answering — instant on every view after the first, but not before it, and
    not before the Office Panel has ever been online for that image. No
    proactive prefetch queue and no resumable-download tracking exist. Worth
    building properly as a follow-up if offline-first browsing of a
    never-before-seen photo turns out to matter in practice; flagged rather
    than silently shipped as the full spec.
  - **Recycle Bin**: images are **not** a `RECYCLE_BIN_ENTITIES` member.
    `docs/schema/02-parties-and-products.md`'s own reasoning (image rows have
    no history value once separated from their product) argues against it —
    a soft-deleted product keeps its image rows (only a hard delete cascades),
    so restoring a product already restores its gallery for free. Removing a
    single photo from a gallery is a hard delete of that one row plus a
    best-effort file removal, not a Bin entry.
  - **Frontend (Office Panel only — Master has no product-catalogue screen to
    attach one to, see "Known gaps")**: `ProductDrawer.tsx` gained edit mode
    (it was create-only before this), including an inline "Photos" section
    (`ProductImages.tsx`) — thumbnail strip, up/down reorder buttons (no
    drag-and-drop; see below), delete, set-primary. `CatalogScreen.tsx`'s
    product table gained a thumbnail column and click-to-edit. The crop/rotate
    editor (`office/web/src/ui/ImageCropModal.tsx`) is a plain `<canvas>` +
    pointer-event modal — free-form/1:1/4:3/original crop presets, rule-of-
    thirds grid, 90° buttons plus a fine-rotation slider — built on the
    existing `ui/Modal.tsx` rather than a new Electron window, the direct
    substitution the porting decision above implies. It sends the *original*
    file bytes plus the crop rect and rotation in source-pixel space; the
    server does the one real decode/crop/resize, matching §3.2's
    non-destructive-editing requirement (pinned by an integration test, not
    just asserted — see below). `office/web/src/ui/ProgressiveImage.tsx`
    paints the `blurhash` placeholder in the same frame via a small decoded
    canvas data URL, then swaps in the `<img>` with no fade (a transition on a
    cache hit would itself be a visible loading state, which is exactly what
    the "instant" requirement rules out).
  - **Not built**: drag-and-drop reordering (up/down buttons instead — adding
    a drag library for one screen was judged not worth it, see the code
    comment in `ProductImages.tsx`); re-editing an already-saved image's crop
    (§3.4 — the editor only ever runs against a freshly-picked file right
    now); a Master-side product-catalogue/edit screen (so Master's own UI has
    no image upload surface — Office's does); resumable partial downloads and
    proactive prefetch (see the caching gap above); treating images as their
    own Recycle Bin entity (a deliberate no, see above, not an oversight).
  - **Verified**: a new `master/tests/images.integration.test.ts` (9 tests)
    drives `image.service.ts` directly against a real PostgreSQL and real
    `sharp` processing — decode/orient/rotate/crop math, all four variants
    actually written to disk at the right long-edge sizes, checksum matching
    the file actually on disk, primary/sequence assignment across multiple
    uploads, primary reassignment and empty-gallery handling on delete,
    reorder's complete-permutation guard, and the permission-to-404
    translation (`products.edit` required to write, `products.view` required
    to read a variant, both enforced the same whether the image exists or
    not). `npm run typecheck`/`lint` are clean across all five TypeScript
    projects and both frontends build (`vite build`) with no errors. **Not
    verified in a live browser** — this dev machine's Master had no known
    sign-in credentials available to the session that built this, so the
    click-through (drag a photo in, crop it, watch the thumbnail appear
    instantly elsewhere) still needs the owner to do it once by hand.
  - **A migration ordering bug found and fixed in a concurrent session's
    file, not this feature's own.** `20260310000000_activity_log_actor_name.ts`
    (Stage 4 Logs, landed the same day by the other concurrently-running
    session) backfills `activity_log.actor_name` with two `UPDATE`s against a
    table an append-only trigger refuses `UPDATE` on. Its own header comment
    already said the trigger needed to come down before those `UPDATE`s and
    back up after; the code had the trigger drop/recreate positioned *after*
    them instead, so every fresh migration run failed and the shared dev
    Postgres this session was also using to verify images against went down
    with it. Fixed by moving the trigger surgery to actually wrap the two
    statements, matching what the comment already said was intended — a
    one-line reordering, not a design change. Flagged here rather than
    silently fixed and left undocumented, since it landed in another
    session's file.

- **Storage export, restore & migration — Stage 1 (on-demand export/import):
  done** (2026-08-25), built from `docs/7-STORAGE-BACKUP-RESTORE.md` while
  Stages 3–4 above ran concurrently in another session. Covers §2.2, §2.3
  (whole/selected export), §4 (the file format), §5 (restore, both panels'
  first-run fork), §5.3 and §7's failure-mode table — **except** §3's
  continuous op-journal/15-minute-snapshot system and §2.5's live storage-path
  move, both deliberately deferred (see below).
  - **Adapted, not followed literally: the trust model.** The spec assumes
    TLS with a pinned Ed25519 fingerprint and names a Cloudflare tunnel token
    as a secret to exclude from export — neither exists anywhere in this
    codebase, which pairs Office Panels over plain HTTP with a device id and a
    shared secret (`shared/src/protocol/pairing.ts`). Asked the owner whether
    to also build the TLS/Ed25519 system the spec assumes; got no answer, so
    proceeded on the more conservative reading — keep the actual feature
    (export/restore) but reinterpret §6's "re-pairing" as this project's real
    pairing flow, and exclude this codebase's actual per-installation secrets
    (`office_panels.secret_hash`, `master_config.pairing_password_hash`)
    where the spec would exclude a tunnel token or private key. Documented in
    full in `shared/src/protocol/backup.ts`'s header. **Worth a real decision
    from the owner before any TLS/pinned-fingerprint work is attempted** —
    this pass did not build it.
  - **The export payload is table rows, not a `pg_dump` or filesystem copy.**
    This installation has no `psql` and talks to Postgres only through the
    `pg` driver (decision 3), so `backup.repository.ts` enumerates every table
    generically via `information_schema` (never a hand-maintained list — the
    lesson already pinned elsewhere in this file) and dumps/loads rows through
    the same driver the app always uses. Office Panel owns no database at
    all — its "replica" is the handful of JSON files under its data directory
    (`device.json`, `clock.json`, `outbox.json`, `snapshot.json`, `users.json`,
    `sign-in-attempts.json`); export is simply their parsed contents.
  - **Restore is "verify completely, then swap in" via a Postgres transaction,
    not a filesystem copy-then-swap.** Decrypt and parse happen entirely
    before the live schema is touched; the load, the forced re-pairing state,
    and the audit-hash-chain re-verification all run inside one transaction,
    and a thrown error at any point (including a failed hash-chain check)
    rolls the whole thing back with `public` exactly as it was. Loading uses
    `SET session_replication_role = 'replica'` to disable every trigger
    (foreign-key enforcement and the hash-chain trigger both) so rows can load
    in any order with no hand-derived topological insert sequence — the
    load-bearing subtlety being that the hash-chain trigger recomputes a
    *fresh* chain on every plain `INSERT`, which would silently discard the
    exact, already-verified historical hashes the export carried if it fired.
    Requires a superuser-equivalent database role; holds for the Master's own
    embedded-Postgres cluster (bootstraps its own role as owner) but is not
    yet preflight-checked for an external `DATABASE_URL` cluster.
  - **Re-pairing after a restore is forced, not merely offered.** Every
    restored `office_panels` row is stamped `status = 'revoked'` with an
    unusable `secret_hash`, and `master_config.pairing_password_hash` is
    always regenerated and shown once (mirroring first-run) — the same
    principle §6.1 states (no automatic trust after a restore), applied to
    this codebase's actual secrets rather than the spec's assumed ones.
  - **`npm run typecheck` and `npm run lint` are clean across all five
    TypeScript projects**, verified after this session's changes alongside
    the other concurrently-running session's own edits to several of the same
    files (`shared/src/index.ts`, `shared/src/domain/permissions.ts`,
    `shared/src/i18n/{en,hi}.ts`, `master/web/src/api.ts`,
    `office/web/src/api.ts`, `office/web/src/i18n/strings.ts`) — merged
    cleanly, no collisions beyond a migration-timestamp clash caught before it
    landed (this feature's grant migration was renamed `20260311...` since
    `20260310000000_activity_log_actor_name.ts` claimed the slot first).
  - **New tests:** `master/tests/backup-crypto.test.ts` (round-trip, wrong
    passphrase vs. corrupt file distinguished, truncation and bit-flip both
    caught by `contentHash` before decryption) and
    `master/tests/backup-domain.test.ts` (format-version and passphrase-length
    rules). `npm run verify`'s full non-integration suite is green except one
    pre-existing failure in `master/tests/i18n-tokens.test.ts` against
    `report.service.ts` — an untracked file from the other concurrent
    session's own in-progress Reports module, not touched by this work.
  - **Not built, and why:** §3's continuous op-journal + 15-minute-snapshot
    system references `3-ARCHITECTURE.md` §10, a document this session did not
    have; building a guessed version of a continuously-running, multi-
    destination replication system without its actual spec risked shipping
    something that looks done but is wrong in ways only that document would
    reveal. §2.5's live storage-path move is real but was judged higher-risk
    to guess at than to skip: moving a running embedded-Postgres cluster's
    data directory from inside the same process serving the request needs
    either an orchestrated stop/copy/restart the operator triggers, or a
    supervisor process outside this app — neither exists yet. The Storage
    screen's existing read-only path/usage display (`storage.service.ts`,
    pre-dating this stage) is unchanged. No per-company export picker UI
    either — the backend supports `scope: 'selected'` with explicit tenant
    ids, but this installation currently serves one company and there is
    nowhere else in the product a company picker exists to model one on; add
    it if/when a second tenant is real.

- **Multi-agent adversarial audit of the in-flight work above, and its fixes: done**
  (2026-08-25). With Stages 0–8 and the backup module all landed but uncommitted, this
  session ran a dimension-by-dimension hunt (wiring/dead-code, backend correctness,
  security/permissions, frontend correctness, cross-package contract drift) against
  the full uncommitted diff, then verified every candidate with two independent
  adversarial agents before trusting it — 49 candidates found, 31 survived, 18
  refuted. All 31 are now fixed and `npm run verify` is green. Highest severity first:
  - **Product images were served with no authentication at all.** `imagesDir` is a
    subdirectory of `uploadsDir`, and an `express.static('/uploads')` mount handed
    out every image variant to anyone on the LAN with no session, no
    `products.view` and no tenant check — routing straight around
    `imageFilesRoutes`'s permission-to-404 gate. The mount is deleted; nothing
    reachable used it (grep confirmed zero callers of `GET /api/images/...` too —
    the Office fetches image bytes over the `image:fetch` socket command instead).
  - **Restoring any backup that had ever recorded activity was impossible.**
    `verifyActivityLogChain` recomputed the hash chain in Node with
    `JSON.stringify(details)`, but the trigger's digest covers Postgres's own
    `details::text` rendering — different whitespace, different key order. Every
    real chained row mismatched, threw `hash_chain_invalid` inside the restore
    transaction, and rolled the whole restore back with a message that read as
    "your backup has been tampered with." Fixed by recomputing in SQL via the same
    `activity_log_row_hash` function the trigger uses (`activity-log.repository.ts
    #verifyChain` already did this for the same reason). Writing the first
    integration test to actually drive `verifyActivityLogChain` against real
    trigger-written rows surfaced two more restore bugs nothing had ever caught,
    both now fixed: `SET session_replication_role = 'DEFAULT'` is invalid syntax
    (Postgres needs the bare keyword `DEFAULT`, not a quoted string) so *every*
    restore failed before this session touched anything, not just chained ones;
    and `loadTables`' `batchInsert` fed JSONB array columns (`roles.permissions`)
    to `pg` as plain JS arrays, which `pg` serializes as a Postgres array literal
    instead of JSON, so nothing with array-shaped JSONB could restore either.
  - **`RESTART IDENTITY` on a whole restore left every sequence stuck at 1** while
    the reinstated rows kept their original ids, so the next audited write anywhere
    died on a duplicate primary key — silently, after the restore had already
    reported success. `resyncSequences` now winds every serial past
    `max(column)+1` via `information_schema`, plus the two id-less display-code
    sequences (`party_code`/`product_code`) read back off the codes themselves.
  - **Two React hooks in the new `ui/` component library broke every list screen
    and every drawer/modal form in both panels**, invisibly — no compiler and no
    test catches a runaway render loop or a stolen keystroke. `useFilterBar`'s
    dependency-less effect published through a context whose value object changed
    identity on every provider render, so publishing triggered its own re-render in
    an unbounded loop; split into two contexts (a stable setter, a separate node)
    so a publisher no longer subscribes to what it publishes. `useOverlay` listed
    the `onClose` closure — rebuilt every render by every call site — as an effect
    dependency, so every keystroke in a Drawer/Modal form re-ran the effect,
    pulling focus back to the header Close button; moved into a ref. The same
    Escape-key fix closed a second bug in passing: `stopPropagation` cannot stop a
    *sibling* listener already bound to `document`, so a nested Modal-inside-Drawer
    closed both on one Escape press; now decided by DOM order (last open
    `[role="dialog"]` wins) instead of relying on propagation.
  - **The Office Panel's `forward()` silently broke six endpoints.** Socket.IO
    treats an explicit `undefined` argument as a real payload slot, not an absent
    one, so `emit(event, undefined, ack)` for a zero-argument command shifts the
    ack out of the position the Master's handler reads it from — the handler's
    `respond()` guard sees a non-function and returns without ever acking.
    Conflicts, Recycle Bin counts, the Fields catalogue and stages, document asset
    listing, and the dashboard refresh all blocked for the full 15s timeout and
    then told the operator the Master was unreachable while it sat there idle.
    `forward()` is now variadic and passes zero args through as zero args.
  - **`data:changed` broadcast unmasked sale rates to every Office Panel browser.**
    `/api/snapshot` and the SSE `snapshot` event both mask `rate`/`lineTotal`/
    `totalAmount` for a reader without `field.saleRate.view`, but the live-update
    path published the raw record straight through — the same leak class the
    `DIRECTORY_ENTITIES` role/user fix (above) closed for the Master, still open
    on the Office side. Masked at the SSE boundary in `office/src/http/app.ts`,
    the one place that already knows who is signed in on that connection.
  - **`panels.manage`/`settings.manage` gated nothing** — present in the
    permission catalogue and togglable in the grid, enforced nowhere, the same
    failure class as the `field.saleRate.edit` incident this file already
    records. Wired onto `panel.routes.ts`'s four mutating routes and
    `setup.routes.ts`'s `GET /identity`; the Master sidebar now hides Panels and
    Settings from a caller who cannot use them, matching how Access is already
    hidden. `credential-invariants.test.ts` now pins both route guards, the way
    it already pins every other module's.
  - **Deleting a soft-deletable custom field definition or option value changed
    nothing that mattered.** `listDefinitions`/`listOptions` had no
    `deleted_at` filter, so a "removed" required field kept being enforced on
    every lead/order create and kept flagging existing records incomplete, and a
    "removed" option kept validating and kept appearing in the Office Panel's
    dropdowns. Both now filter live by default, with an explicit
    `includeDeleted` escape hatch for the one management read that needs it.
  - **Every rendered PDF was dated from the host machine's UTC calendar day**,
    not the business's configured timezone — wrong for a good chunk of every IST
    morning. `buildDocumentModel` now requires its caller to supply `issuedOn`
    (resolved against `config.locale.timeZone`, the way `report.service.ts`
    already does) rather than falling back to a clock of its own; the fallback
    would have kept `buildDocumentModel` non-deterministic, contradicting the
    "pure, reads no config" invariant `10-TESTING.md` pins it to.
  - **Two concurrent image uploads to an empty gallery could both become
    primary.** The deciding read moved inside the write transaction but nothing
    serialized two overlapping transactions at READ COMMITTED; `uploadImage` now
    row-locks the product first.
  - Also fixed in the same pass: a lead's `sourcePlatform` update rejected any
    lead already carrying a since-removed option value even when every other
    field was being edited, rather than only rejecting a genuine change to that
    field; a stale `UserEditForm` kept the previously-selected user's values
    across selections; two literal untranslated i18n keys (`nav.master.conflicts`,
    `panels.revoke.cancel`) rendered instead of their text; a failed stock-in
    hid its own error behind the modal it had just closed; the Add-Lead rate
    field could not accept a decimal point; a party-create failure inside the
    Add-Lead drawer rendered behind the drawer's own scrim; the Recycle Bin tab
    showed "empty" instead of an error when its fetch failed; a product photo's
    "Move earlier" control was enabled but did nothing for the first non-primary
    image; a product photo deleted on one click with no confirmation; a custom
    numeric field could never be set to exactly `0`; and several small dead
    exports (`countImages`, a duplicate soft-delete pathway) were removed.
  - Two findings the second adversarial pass confirmed as real but this session
    deliberately did not fix, because the fix's blast radius was disproportionate
    to a risk already fully closed by an outer gate: `openPairingWindow`/
    `closePairingWindow`/`revokePanel`/`renamePanel` still take no `ActorContext`
    to re-check `panels.manage` inside the service (the route guard is the only
    reachable gate today, confirmed unreachable otherwise) — threading an actor
    through would touch roughly ten test call sites, several of which run before
    any tenant exists. Worth doing as its own change, not a drive-by inside this one.

  **A second, independent Stage 3 (Fields) implementation had landed on `origin/dev`**
  while this session's audit was in progress — two sessions had built the same
  module concurrently. Reconciled by taking the pushed implementation as
  canonical throughout (`master/src/domain/field-values.ts`,
  `fields.service.ts`, `fields.routes.ts`, `field-usage.repository.ts`,
  `custom-field.repository.ts`, the `20260306` migration, and both Fields test
  files) and re-applying this session's non-Fields fixes on top, since a
  pushed, shared, already-verified implementation should not be silently
  replaced by an unpushed local one — see the corresponding commit for the
  full file-by-file resolution. One casualty of the discarded draft is worth
  recording: it tracked `deletedBy`/`createdAt`/`updatedAt` on
  `OptionListItem`/`CustomFieldDefinition` that the landed implementation does
  not; if per-row audit timestamps on Fields configuration turn out to matter,
  that is new work, not a regression to restore.

- **Office Panel administration on the Master: done** (2026-08-25). The Master's
  Admin → Office Panels tab used to be a list with Rename and Remove on it. It
  is now a module: three sections (All panels / Add a panel / Panel activity),
  four fleet figures above them, and a per-panel screen that opens on
  double-click with five sections of its own — Overview, ID & password,
  Storage, What it may do, Activity.

  The load-bearing constraint, and the reason most of this is shaped the way it
  is: **the Master cannot reach into an Office Panel.** A panel binds its HTTP
  server to loopback (`office/src/config/index.ts`), so nothing on the LAN can
  ask it anything. Everything the screen shows about a machine — its name, its
  Windows version, where its files are, how full its disk is — is there because
  the panel *volunteered* it over the socket it already holds, and everything
  the screen *changes* on a panel is a request the panel carries out.

  - **`panel:report` (Office → Master)** carries the panel's account of itself:
    hostname, platform, OS and app versions, data folder, image cache, bytes
    used, disk free/total, local port, uptime, plus the per-connection figures
    (queued mutations, cached images, snapshot age, who is signed in). Sent on
    connect and every five minutes. The durable half lands in fifteen new
    nullable columns (`20260312000000_office_panel_administration`); the
    connection-only half stays in a memory map on the Master, because a stored
    "12 changes pending" would keep asserting a backlog for a panel that has
    been switched off for a week. Every column is nullable and nothing is
    backfilled — "unknown" must stay distinguishable from "zero", or a disk
    shown as 0 bytes free is a decision somebody acts on.
  - **`panel:describe`, `panel:credentials`, `panel:setStoragePath` (Master →
    Office)** are the three requests that go the other way. Services reach one
    panel's socket through `master/src/realtime/panel-link.ts` — a seam the hub
    registers at startup, so `panel.service.ts` never imports the hub back.
  - **Reissuing a panel's secret has one order and it is the non-obvious one.**
    The connected panel is handed the new secret and must acknowledge storing it
    *before* the Master replaces the hash. Writing the hash first would kill the
    old secret while the panel still held it, so a dropped ack would lock out a
    panel that was working a moment ago — over a network whose whole premise is
    that it goes down. A panel that is switched off cannot be told at all: the
    secret is reissued anyway and `delivered: false` sends the operator to that
    PC with the plaintext, shown once. Pinned by
    `master/tests/panel-administration.integration.test.ts`.
  - **Moving a panel's data folder actually moves it, with no restart.**
    `office/src/config/paths.ts` now owns the live data directory and every
    store reads through `paths()` rather than the frozen `config.dataDir` — that
    is what stops work saved after a move being stranded in the old folder until
    somebody restarts the process. The panel validates on its own terms (path
    absolute, writable, drive big enough, not nested either way), copies, writes
    `ORDERBOOK_OFFICE_DATA_DIR` into its own `.env` so a restart agrees, and
    **leaves the original folder in place** — this runs unattended, triggered by
    somebody who cannot see that PC's drives, so a half-finished move with the
    source deleted would be unrecoverable from where they are standing.
  - Also on the screen: notes against a panel, assigning the role its
    *unattended* commands act under (`office_panels.role_id`, which had a column
    and a reader but no way to set it), a force-disconnect that clears a wedged
    session without ending the pairing, and a per-panel activity trail that
    reads both directions — what the panel did, and what was done to it.
  - `GET /api/panels/:id` is `panels.manage`, unlike `GET /api/panels`: the list
    is what every session's presence rail counts, the detail carries the panel's
    effective permission set and the layout of its disk.

### Still to do in Phase 2

The user was asked to prioritise and chose inventory first. Remaining, roughly
in the order the plan lists them:
- Visual polish / branding pass (the user's "make it beautiful later"). A
  vendored design-review skill is now committed at
  `.claude/skills/apple-design/` (Apple HIG principles generalized to any
  framework) — invoke it as `/apple-design` when starting this work. Note the
  two frontends currently duplicate `styles.css`, `format.ts` and
  `Field.tsx` between `master/web` and `office/web`; there is no shared design
  system yet, and consolidating one is the natural first step of this pass.
  **Update (2026-08-24): the owner supplied a full Claude Design UI system**
  (tokens, typography, motion, 16 reference screens) for exactly this pass.
  Ported into a build plan at `docs/UI_REDESIGN.md` — read that before starting;
  §4 lists every place the supplied design disagrees with the real product
  (e.g. it assumes one unified shell, the real product is two separate apps),
  §5 maps every mockup to the real screen it restyles, §7–8 are the new `ui/`
  workspace plan and the phased build order. **Planning only so far — no code
  written yet.**

  The **backend** half now has its own implementation-ready spec at
  `docs/backend-modules/` — see the Status entry above. **All nine backend
  stages are now implemented and verified**; what remains of this batch is the
  frontend, which `docs/UI_REDESIGN.md` owns.
- Reporting/analytics and printable order sheets: **backend done**.
  `docs/LEAD_GENERATION_FLOW.md` §11 explains why the guide's PDF Designer and
  `Order.exports[]` were left out of that earlier build — that reasoning is
  historical and no longer stands: Reports landed as Stage 5 and the PDF
  Designer as Stage 6 of `docs/backend-modules/11-BUILD-SEQUENCE.md`, both
  verified. Exports are cross-entity (`document_exports` spanning leads and
  orders) rather than an array embedded on the order, which is the one shape
  change from the guide. **No screen consumes either yet** — the designer UI,
  the reports screens and the document history view are frontend work.
- Richer product parameters, bulk import from Excel/CSV. (Product images:
  **done** — see the Status entry below.)
- Multi-user roles/permissions within the Office Panel.
- Backup/restore tooling. (On-demand export/import: **done** — see the
  Storage Status entry above. The continuous op-journal/snapshot system and
  live storage-path move are still open, and need `3-ARCHITECTURE.md` §10
  before either is built for real.)

### Known gaps

- `panel:revoked` is defined in the socket contract and handled by the Office
  Panel, but the Master does not emit it yet — a revoked panel currently finds
  out on its next reconnect attempt rather than immediately.
- Product images: **Office-only.** No dedicated product-catalogue screen
  exists on `master/web` (products are managed from `office/web`'s Catalog
  screen), so there is nowhere on the Master's own UI to upload/view a photo
  yet — see the image pipeline Status entry below for the rest of what did and
  didn't ship.
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

- **Integration tests need PostgreSQL binaries.** They build a throwaway
  cluster in the OS temp directory and skip when they cannot. On the owner's PC:
  `ORDERBOOK_PG_BIN="/c/Program Files/PostgreSQL/17/bin" npm run verify`. The
  first run takes ~35s extra for `initdb`; later runs reuse the cluster. This
  never touches the `order_book` database.
- **Composite keys go through `stockKey()`.** A stock row is identified by a
  *pair* — (product, colour) — and two call sites that built the key inline with
  slightly different separators produced keys that never matched, which surfaced
  as reservations silently reading as zero. `master/src/domain/stock-key.ts` is
  the only place that decides the format.
- **A create stamps `field_hlc` only for fields it actually set.** Marking every
  field as written at creation makes the first edit of a never-filled field look
  like a clash, and buries the real conflicts in noise.

- **A migration must never import a live shared constant.** `20260301` did,
  and editing the permission catalogue later silently changed what that
  migration had already done on every installation. Inline the values a
  migration writes; a migration is a fixed historical fact, not a view of
  today's code.
- **Do not hand-maintain a list of columns referencing a table.** The roles
  migration originally carried one and it named a column that does not exist.
  Ask `information_schema` instead — see `userReferences()` in
  `20260303000000_roles_and_users.ts`.
- **The last-administrator guard runs inside the transaction.** Moving it out
  for tidiness lets two concurrent deactivations both succeed and locks the
  company out of its own software.
- **An Office Panel's acting user is resolved per command, never captured per
  connection.** A socket outlives sign-ins, sign-outs and role edits; caching the
  actor when the panel connects is exactly how a revoked permission survives
  until the next reconnect.
- **Offline sign-in may only be reached when the Master could not be *asked*.**
  Falling back to the panel's local verifier after the Master actively refused
  turns the panel into a way around a password change or a deactivation. Decide
  it from a transport flag, never by reading the error message — a Postgres
  "canceling statement due to statement timeout" is a message the Master *sent*,
  so it means refused, not silent.
- **A skipped test suite looks exactly like a passing one.** `describe.skipIf`
  reports "skipped" in a line most people read as green. The Windows Postgres
  lookup was broken for months and every integration gate silently did nothing.
  If a guard matters, check the suite actually ran, not just that it was not red.
- **`process.platform` is `win32`; the npm package directory is `windows`.**
  Interpolating the former into a package path silently finds nothing.
- **A permission that enforces nothing is worse than a missing one.** It renders
  as a control, an administrator unticks it believing something changed, and
  nothing does. Either wire it up or delete it from the catalogue.
- **`zIndex` and friends accept CSS `var()` in React inline styles** — prefer
  the layer tokens (`--z-toast`…) over bare numbers so layering stays in
  `tokens.css`.
- **A `UNION ALL` branch must cast to the type its siblings use.**
  `option_lists`/`custom_field_definitions` have `UUID` primary keys, unlike
  every other Recycle Bin branch's `TEXT` id; Postgres refuses the union
  outright ("UNION types text and uuid cannot be matched") rather than
  coercing silently. Cast the odd one out (`id::text`), don't change the rest.
- **A test-fixture "seeded row" set captured per test *file* is only correct
  if every file starts from an identical database.** `option_lists`/
  `custom_field_definitions` are not in `DATA_TABLES` (truncating either
  leaves no pipeline stage or source-platform option for anything to write
  against), so nothing wipes them between files sharing the one on-disk test
  cluster — meaning whatever a *previous* file's last test left behind, a
  later file's own `setupDatabase()` re-captures as "seeded" and then
  protects forever. Self-heal to a known-fixed set before capturing (as
  roles already do by name), don't just capture "whatever exists now." A
  single `npx vitest run` can be misleadingly green; the tell is running it
  twice in a row without wiping the cluster.

## Working agreements for this repo

- **Branching:** all work lands on `dev`. The long-standing default is that
  `main` is never pushed to directly and reaches `main` only through a pull
  request — `main` sits *behind* `dev` by design. On 2026-08-25, the owner
  explicitly asked for `main` to be fast-forwarded to `dev` directly (it had
  drifted 15 commits behind) rather than opened as a PR; that was a one-time
  override of the default, not a standing change to it. Treat "PR only" as
  the rule again unless the owner says otherwise in a given session.
  Historical feature branches (`claude/ceramic-offline-web-app-6wjqq5` for
  Phases 1–2, `claude/refactor-production-codebase-7gbz9v` for the
  clean-architecture refactor) are all merged into `dev`; new work branches
  from `dev`.
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
