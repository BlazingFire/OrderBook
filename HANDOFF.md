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

- **UI redesign + six new backend modules: fully specified, nothing built**
  (2026-08-24). The owner supplied a Claude Design UI system and asked for the
  backend for the screens it implies (Fields, Logs, Recycle Bin, Reports, PDF
  Designer, i18n, Office Dashboard) to be planned to implementation-ready
  detail before any code is written. That planning is done:
  - **Frontend plan**: `docs/UI_REDESIGN.md` — the mockup-to-real-screen
    mapping, the divergences between the supplied design and the two-app
    reality, the new `ui/` component workspace, and the phased build order.
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
  - **Next session starts implementation at Stage 0** of
    `docs/backend-modules/11-BUILD-SEQUENCE.md` — the ~15-line socket-ack
    `details` fix that two later modules depend on. Read `README.md` §8 first:
    it lists the open questions still needing an answer (the sharpest is
    whether `AppError.messageKey` is required — 129 throw sites depend on the
    answer and it gates Stage 1) and which stage each one blocks.

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
  `docs/backend-modules/` — see the Status entry above. Implementation has not
  started; that is the very next piece of work on this repo.
- Reporting/analytics and printable order sheets. `docs/LEAD_GENERATION_FLOW.md`
  §11 explains why the guide's PDF Designer and `Order.exports[]` were
  deliberately left out of that build — that reasoning is historical, not a
  standing decision: both are now fully specified as Stage 5 (Reports) and
  Stage 6 (PDF Designer) of `docs/backend-modules/11-BUILD-SEQUENCE.md`,
  pending the owner's go/no-go on PDF Designer specifically (`README.md` §8 —
  it is the largest single module in the batch).
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

## Working agreements for this repo

- **Branching:** `main` is never pushed to directly. All work lands on `dev`,
  and reaches `main` only through a pull request. `main` therefore sits
  *behind* `dev` by design. Historical feature branches
  (`claude/ceramic-offline-web-app-6wjqq5` for Phases 1–2,
  `claude/refactor-production-codebase-7gbz9v` for the clean-architecture
  refactor) are all merged into `dev`; new work branches from `dev`.
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
