# The change plan for existing code

Status: **specification.** Built since, apart from the PDF Designer, which was built and then removed (see the banner in `docs/BACKEND_MODULES.md`); the code is the truth now, so check a claim here against the tree before acting on it. This is document 5 of the backend specification
set for the six new modules planned in `docs/BACKEND_MODULES.md`.

The other documents in this set describe code that does not exist yet, where the only cost of getting
something wrong is writing it again. This one describes edits to code that **already works, is
already tested, and is already running on the owner's PC**. A wrong edit here does not fail to
appear — it makes something that worked stop working, usually somewhere else.

So every entry below carries four things and not just the first: what changes, why, **what depends on
this file**, and **what breaks if the edit is done wrong**. Read the blast radius before you make the
edit, not after the test suite goes red.

Every claim about existing code in this document was verified by reading the file, and carries a
`path:line` reference. Where a module design in the working set contradicts what the code actually
says, the code wins and the contradiction is called out.

---

## 0. Scope — what is *not* in this batch

Stated first because three of the four module designs got it wrong, and because the largest risk in
this document is somebody helpfully "finishing" a change by wiring it into a screen.

**This batch is backend only. This is now the ruled scope boundary for the whole set** — the
authority is `02-FILE-STRUCTURE.md`, and the table below is the same boundary restated for the
existing-code side. Where `09-I18N.md` or `11-BUILD-SEQUENCE.md` schedules a web file, that
scheduling is wrong and the file belongs to the UI phase.

| Not in this batch | Why |
|---|---|
| Any file under `master/web/src/screens/` or `office/web/src/screens/` | The ten screens belong to the UI phase, `docs/UI_REDESIGN.md` §8 |
| `master/web/src/App.tsx`, `office/web/src/App.tsx` | Adding a tab whose render branch does not exist ships a tab pointing at nothing |
| The `visibleTabs` table at `office/web/src/App.tsx:163` and the `Tab` union at `:27` | Same reason. A tab entry is a screen entry |
| `master/web/src/components/PermissionGrid.tsx` | Token rendering is the UI phase's half of i18n |
| `master/web/src/screens/AccessScreen.tsx` (incl. `function RecycleBin`, ~line 963) | Replacing the inline roles/users Bin with a link into the unified Bin is a screen edit |
| `{master,office}/web/src/main.tsx`, `format.ts`, `styles.css` | `LocaleProvider`, the `en-IN` pinning and the Devanagari font stack are all renderer work |
| **`{master,office}/web/src/i18n/*`** — every file, including `storage.ts`, `LocaleContext.tsx` and `useErrorMessage.ts` | The client half of i18n is a renderer concern. Deferred to the UI phase |
| **`{master,office}/web/src/components/LocalePicker.tsx`, `Untranslated.tsx`** | Two new components with no screen to sit on. UI phase |

**The one exception**, and the only two web files this batch touches: the typed API client wrappers in
`master/web/src/api.ts` and `office/web/src/api.ts` (§7). They are functions with no UI attached, and
they are how the new endpoints get exercised before any screen exists.

**`shared/src/i18n/` is fully in scope, and the deferral does not leave i18n unverified.** The token
catalogue, `MessageKey`, `t()`, the locale list and the interpolator all live in `shared/src/i18n/`,
and every one of them is exercised end-to-end from `shared/tests/` — coverage, totality of `hi.ts`,
interpolation, and `AppError.message === t('en', messageKey, params)` — **without a single web file
existing**. What is deferred is the *rendering* of tokens, not the tokens. See `10-TESTING.md` for
the register of the `shared/tests/` suites that prove it, and `09-I18N.md` for the layer itself.

**A consequence to accept deliberately.** After this batch, `t()` and both message catalogues exist,
every error carries a `messageKey`, and **nothing in either browser calls `t()`**. That is not an
oversight — it is what "backend only" means for a layer whose consumer is a renderer. The catalogues
are compile-checked from `shared/tests/` from day one, so they cannot rot in the gap between the two
phases. The end-to-end path a token travels — and where it stops in this batch — is drawn as a
sequence in `06-WORKFLOWS.md` §5.0.

---

## 1. The change ledger

Every existing file this batch touches. `Risk` is the cost of getting the edit wrong, not the
difficulty of making it.

### shared/

| File | Change | Risk |
|---|---|---|
| `shared/src/index.ts` | 5–7 new `export *` lines | **Med** — a duplicate exported name breaks all four packages at once |
| `shared/src/domain/permissions.ts` | New keys, one lowered ceiling, `labelToken` narrowed | **High** — a key added here without the grant migration enforces nothing |
| `shared/src/domain/entities.ts` | `DashboardSummary` counters become optional; four entities gain columns | **High** — every existing reader of `DashboardSummary` must handle `undefined` |
| `shared/src/domain/inputs.ts` | `CursorQuery` + `CursorPage<T>` minted **once**; new module inputs | **High** — three designs each defined `CursorPage<T>`, two incompatibly |
| `shared/src/domain/visibility.ts` | **No change.** Reasoned in §2.5 | Low |
| `shared/src/protocol/socket.ts` | `details` on the error arm, `'restored'` action, new commands | **High** — the wire contract; both sides compile against it |
| `shared/package.json` | `"sideEffects": false` | Low |

### master/

| File | Change | Risk |
|---|---|---|
| `master/src/config/index.ts` | `locale: { timeZone, defaultLocale }`, `documents: {…}` | **High** — a bad zone silently shifts every report bucket |
| `master/src/index.ts` | Timezone validation, document directories, font assertion | Med — a wrong order means migrations run before config is proven |
| `master/src/db/migrations/index.ts` | Five new entries appended | **High** — a file written but not imported is a silent no-op |
| `master/src/http/app.ts` | Five new routers, mounted **above** line 41 | **High** — see §3.4 |
| `master/src/http/middleware/require-auth.ts` | `actorFromRequest` populates `actorName` | Med — a missed field is a `NULL` in the audit trail, not an error |
| `master/src/http/middleware/error-handler.ts` | Emit `messageKey`/`params` | Low — additive |
| `master/src/http/routes/access.routes.ts` | One optional argument on one handler | **High** — see §3.3 |
| `master/src/http/routes/data.routes.ts` | Four `DELETE` routes with guards; three reads **left alone** | **High** — see §3.5 |
| `master/src/realtime/hub.ts` | `respond()` carries `details`; **46** new commands; dashboard fan-out | **High** — the ack contract and the snapshot path |
| `master/src/domain/actor.ts` | `ActorContext.actorName` | Med — widening a type every service consumes |
| `master/src/domain/pipeline.ts` | `Stage.isArchived`; two rule changes | Med — a stage rule change moves every board |
| `master/src/domain/custom-fields.ts` | A comment. No behaviour change | Low |
| `master/src/domain/access.ts` | Guards pass tokens rather than composing English | **High** — 12 throw sites, all covered by tests asserting English |
| `master/src/lib/errors.ts` | `AppError` gains `messageKey`/`params` | **Highest in the batch** — see §3.2 |
| `master/src/repositories/activity-log.repository.ts` | Signature change + four read functions | **Highest in the batch** — see §3.1 |
| `master/src/repositories/mappers.ts` | New mappers; four existing mappers gain fields | Med |
| `master/src/repositories/{party,product,lead,order}.repository.ts` | Soft-delete pair + `deleted_at` filters on every read | **High** — a missed filter shows deleted rows |
| `master/src/repositories/custom-field.repository.ts` | Read-only → read/write | Med |
| `master/src/repositories/pipeline.repository.ts` | Stage write functions, deferred-constraint reorder | **High** — unique index vs. constraint, §5.9 |
| `master/src/repositories/{role,user}.repository.ts` | **No change.** Reasoned in §5.10 | Low |
| `master/src/services/catalog.service.ts` | Delete/restore for party and product | Med |
| `master/src/services/lead.service.ts` | Delete/restore; option-value rule | Med |
| `master/src/services/order.service.ts` | Delete/restore; reservation release | **High** — releases stock |
| `master/src/services/role.service.ts` | `restoreRole` gains `renameTo`; action becomes `'restored'` | Med |
| `master/src/services/user.service.ts` | `restoreUser` gains `renameTo`; parent check; `'restored'` | Med |
| `master/src/services/sync.service.ts` | Reject mutations targeting a tombstone | **High** — a wrong rejection loses offline work |
| `master/src/services/dashboard.service.ts` | Per-figure gating; layering fix; three new figures | **High** — figures become `undefined` |
| `master/src/services/snapshot.service.ts` | Carries `dashboard` | Med |
| `master/src/services/storage.service.ts` | Measures the documents directory | Low |
| `master/src/services/panel-actor.service.ts` | Populates `actorName` on both arms | Med |
| `master/tests/helpers/fixtures.ts` | Three tables truncated; seeded field rows preserved | **High** — order matters, and a wrong one wipes seed data |
| `master/tests/credential-invariants.test.ts` | Optionally extended | **High** — see §3.3 |
| `master/tests/mappers.test.ts` | First-ever coverage for `toIsoDate` | Low |
| `master/package.json` | `pdfkit`, `fontkit`, `@types/pdfkit` | Med — see §8.3 |

### office/

| File | Change | Risk |
|---|---|---|
| `office/src/http/app.ts` | **~46** `forward()` routes; `forCurrentUser` extended | **High** — placement relative to line 133 |
| `office/src/realtime/master-connection.ts` | `details` on the error; **`applyChange` must honour `action`** | **High** — see §6.2, a live defect this batch exposes |
| `office/src/config/index.ts` | `locale.defaultLocale` | Low |

### Tooling

| File | Change | Risk |
|---|---|---|
| `eslint.config.js` | Register the local i18n rule — as `'off'`, not `'error'` | **High** — see §8.1 |
| `package.json` (root) | One script | Low |

---

## 2. Cross-cutting edits, and why they belong to one owner

Four edits appear in more than one module's design. They are listed here once so they are made once.

### 2.1 `CursorPage<T>` — minted once, in `shared/src/domain/inputs.ts`

`shared/src/domain/inputs.ts:268` today declares only `Paginated<T>`; there is no cursor type at all.
Three of the four module designs each added one, two of them with structurally different shapes. The
whole public surface of `@orderbook/shared` is eleven `export *` lines (`shared/src/index.ts:1-11`),
so whoever landed second would either overwrite the first design's contract or produce a
duplicate-identifier error in all four packages simultaneously.

**One definition, beside `Paginated<T>`, and this exact shape:**

```ts
export interface CursorQuery {
  cursor?: string;
  direction?: 'older' | 'newer';
  limit?: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  /** null for a one-directional feed. Present so every consumer has one shape. */
  prevCursor: string | null;
  limit: number;
}
```

`prevCursor` is **required and nullable**, not optional. One-directional feeds set it to `null`. An
optional property would let two feeds have genuinely different types under one name, which is the
problem this is solving rather than a smaller version of it.

`Paginated<T>` stays exactly as it is. It is offset-based and still correct for the existing list
endpoints; the new type is a sibling. Nothing in this batch converts an existing endpoint.

> The Logs/Reports design named these fields `newerCursor`/`olderCursor`, and the Recycle Bin and PDF
> designs omitted `limit` and `prevCursor` entirely. Both are superseded. If you see either shape in a
> module document, that document is stale.

### 2.2 One cursor codec

`master/src/domain/cursor.ts` — new, pure, opaque base64url. Three designs proposed their own
(`log-cursor.ts`, `cursor.ts`, and one inline in `recycle-bin.ts`). Module-specific cursor *payloads*
build on the one codec. It is a new file, so it is specified elsewhere in this set; it is named here
only because two of the file entries below reference it.

### 2.3 One timezone key

Nothing pins a timezone today — `buildKnexConfig` passes client, connection, pool and migrations, and
no `SET TIME ZONE` exists anywhere in the repository. The Logs/Reports design put the setting at
`config.reporting.timeZone`; the PDF/Dashboard design put the same environment variable at
`config.locale.timeZone`. **`config.locale.timeZone` wins**, because the same key also serves i18n
date formatting later. See §5.1.

### 2.4 One permission-grant migration

Every new key is granted in `20260309000000_new_module_permission_grant`, last, to `tier = 'admin'`
**only**, union-not-replace, with the key strings **inlined and frozen**. Do not add a grant to any
other migration, and do not add one per module. The migration is a new file; what belongs in *this*
document is the rule that `shared/src/domain/permissions.ts` (§4.2) and the grant migration are two
halves of one change, and that landing either alone produces a key that enforces nothing or a stored
key the catalogue rejects.

`08-PERMISSIONS.md` owns the key list, the tiers and the grant algorithm — including the no-op test,
which is a membership check (`NEW_KEYS.every((key) => stored.includes(key))`) and never a length
comparison. Follow it there; do not re-derive it here.

### 2.5 `shared/src/domain/visibility.ts` — no change

Called out because it is on the list of files to consider and the correct answer is "leave it".

Report and document redaction reuses `maskFields()` from `shared/src/domain/permissions.ts:300-312`,
which already **deletes** the key rather than nulling it:

```ts
for (const { key, permission } of gated) {
  if (!hasPermission(set, permission)) delete masked[key];
}
```

That is the locked behaviour — redacted fields are **absent**, never `null` and never `0`. The five
mask helpers in `visibility.ts` are entity-shaped (`maskLead`, `maskOrder`, `maskLineItem`,
`maskProduct`, `maskVariant`) and the new modules do not return those entities; they return report
rows and document models. Adding a sixth entity-shaped helper for each new shape would duplicate the
generic one that already exists.

`master/src/domain/visibility.ts` — the actor-bound half — also does not change. `canSeeRates(actor)`
at `:26-28` is the exact predicate the new modules need, and the rate-redaction key is
`field.saleRate.view`. (The design brief for the PDF module called it `products.rate.view`. **That
string does not exist in the catalogue** — verify against `shared/src/domain/permissions.ts:98`.)

---

## 3. The high-risk edits

Five edits where the failure mode is quiet. Read all five before starting.

### 3.1 `recordActivity` gains an actor parameter

> ### ⚠ `recordActivity(entry, trx)` → `recordActivity(entry, actor, trx)` — **Stage 1**
>
> **File:** `master/src/repositories/activity-log.repository.ts:51-64`
> **Blast radius:** every one of the **24** call sites across seven services.
> **When: Stage 1 (i18n foundation), not the Logs stage.** Ruled. `11-BUILD-SEQUENCE.md` owns the
> stage numbering (Stage 0–8); this signature lands in the foundation.
>
> **Why Stage 1 and not Stage 4 (Logs).** The `actor` parameter is *harmless* before
> `activity_log.actor_name` exists — the repository simply does not persist it yet. Taking the
> compile-time hit once, in the foundation, means Recycle Bin (Stage 2) and Fields (Stage 3) are
> written against the **final** three-argument signature from their first line, instead of being
> written against the old form and swept later. A sweep across two freshly-written modules plus the
> 24 existing sites is the same work done twice, and the second pass is the one that gets rushed.
> Migration `20260307` (Logs) adds the column and starts persisting what the parameter already
> carries — see `03-DATABASE.md`, which owns the migration DDL.
>
> The Logs module adds `activity_log.actor_name TEXT` so a deleted user's name still renders in the
> Logs screen. `actor_name` sits **outside** the hash chain — the digest covers
> `prev_hash|sequence|entity_type|entity_id|action|actor_type|actor_id|details` — so adding it is
> safe, and the migration can backfill it for historical rows.
>
> The trap is the other half. `recordActivity` is called with an **object literal** at every site:
>
> ```
> recordActivity        10 sites   auth 1, role 4, user 5
> recordDetachedActivity 14 sites  catalog 4, lead 3, order 2, panel 2, inventory 2, auth 1
> ```
>
> None of them would set `actorName`. The result is a column that is correct for backfilled history
> and `NULL` for **everything written after the migration** — an Actor column that works for old data
> and breaks for new, which is strictly worse than not having the column.
>
> **Resolution: change the signature and derive the name inside.** `recordActivity(entry, actor, trx)`
> takes the `ActorContext` the caller already holds and reads `actor.actorName` itself.
>
> **Why this shape and not "add `actorName` to `ActivityEntry`":** a new optional property on a
> literal is invisible when omitted. A new required *parameter* is a compile error at all 24 sites, so
> the compiler enumerates the work instead of a reviewer having to. This is the same reasoning that
> already made `trx` required — the file header at `:44-50` states it: *"Making it optional would
> leave the old behaviour reachable by omission, and 'forgot to pass the transaction' looks identical
> to 'chose not to' at every call site."*
>
> **What breaks if done wrong:**
> - Made optional → the column is `NULL` for all new rows and nothing turns red. The Logs screen's
>   Actor column shows blanks for exactly the recent entries anyone is looking at.
> - Derived from `entry.actorType`/`entry.actorId` inside the repository by joining `users` → an
>   extra query per audited write, inside the transaction that already holds the per-tenant advisory
>   lock the chain trigger takes (`:19-24`). Every audited write for the company queues behind it.
> - `actorName` folded into the chain digest → the hash chain covers a *rendering* concern, and
>   renaming a user retroactively invalidates history. It must stay outside.
>
> **Scope note.** Changing the signature touches all 24 sites; it does **not** convert the 14
> `recordDetachedActivity` sites to the atomic form. `recordDetachedActivity` remains **forbidden in
> every new module** — the existing 14 sites keep their current best-effort semantics and simply gain
> the new argument. That conversion is listed in
> `docs/BACKEND_MODULES.md` §8 as known-open and is **not** work for this batch. New modules use
> `recordActivity` from the first line; the existing best-effort sites keep their current semantics
> and simply gain the new argument.

### 3.2 `AppError` gains `messageKey` — the open question

> ### ⚠ OPEN QUESTION — this one needs an owner decision before anything else is built
>
> **File:** `master/src/lib/errors.ts`
> **Blast radius:** **129** throw sites, and `AppError`'s constructor signature is a dependency of
> every other module in the batch.
>
> The i18n layer's founding decision is that **the server never renders a user-facing sentence** — it
> returns a stable `messageKey` plus named params and the client renders. This is forced rather than
> chosen: locale is per-machine and never synced, so one Master serving several panels has no
> recipient locale to render for.
>
> The question is whether `messageKey` is **required**. Both answers are defensible and the plan
> recommends one; it is presented here with the actual numbers rather than assumed.
>
> ### The count, stated once and precisely
>
> **129 throw sites across `master/src`; 0 in `office/src`.**
>
> State it as: *"129 (126 by grep; `master/src/domain/conversion.ts` contains a literal NUL byte so
> grep classifies the file as binary and skips 4 sites — verify with `grep -a`), minus a 1-count
> correction."* Anyone re-counting will get 126 and conclude this document is wrong; it is not, and
> the discrepancy has one cause. Use `grep -a` (or `grep --binary-files=text`) or you will re-derive
> the wrong number every time.
>
> `office/src` has no `lib/errors.ts` and throws none of these classes, so the "126 across master and
> office" figure in the working notes is off by the office half — which is **zero**, not "small".
>
> **Per-class breakdown** — this table is the authority for the set; `02` and `11` cite it rather than
> keeping their own:
>
> | Class | Sites | Needs a per-site token? |
> |---|---:|---|
> | `ValidationError` | 60 | **Yes** — each says something different |
> | `NotFoundError` | 40 | No — one class token, `{what}` as a param |
> | `UnauthorizedError` | 14 | No — one class token |
> | `ConflictError` | 5 | **Yes** |
> | `ForbiddenError` | 4 | No — one class token, `{permission}` as a param |
> | `AppError` (direct) | 3 | **Yes** |
> | `TenantViolationError` | 0 | Defined at `errors.ts:62-66`, never thrown |
> | **Subtotal, naive grep** | **126** | |
> | `+` `domain/conversion.ts`, all `ValidationError` | +4 | **Yes** — grep never saw these |
> | `−` correction, one grep hit that is not a throw site | −1 | |
> | **Total** | **129** | **68 hand-written tokens** |
>
> **The number that measures the work is 68, not 129.** The remaining 61 derive their token from the
> class plus its one argument, so they cost nothing to translate. Each of the 68 needs an English
> string and a Hindi string, because `hi.ts` is typed `Record<MessageKey, string>` and is **total,
> not partial**. Anywhere this batch is sized, size it at 68.
>
> **Option A — required.** `messageKey` is a required constructor parameter; `message` is *derived*
> from the English catalogue so existing assertions stay byte-identical.
> - The only thing that makes an untranslated error impossible.
> - Omission is a compile error, so the compiler enumerates the 68 (and finds the 4 in
>   `conversion.ts` that grep cannot see — the compiler does not care about NUL bytes).
> - `master/tests/access.integration.test.ts` and `master/tests/permissions.integration.test.ts` both
>   assert on `.message` text. Deriving `message` from the English catalogue keeps them passing
>   **only if the English strings are copied across exactly, character for character**, including the
>   curly apostrophes and the full stops. Copy them; do not retype them.
> - `master/src/domain/access.ts` alone holds 12 of the 68 (`:160-169`, `:183-202`, and the tier and
>   lockout guards), and those are the ones existing tests assert hardest on.
>
> **Option B — optional, with an `error.<code>` fallback.** Seven codes, seven generic sentences.
> - Nothing to do now; every existing throw keeps working.
> - Untranslated errors remain possible **forever**, and the fallback loses the specifics. *"Somebody
>   else saved this first. Reload to see their changes."* (`access.ts:198`) collapses to a generic
>   "conflict", which is the sentence the client already had before the code existed.
> - Adopting it makes `messageKey` exactly the kind of decorative-but-unenforced contract that
>   `HANDOFF.md` names as a trap: *"A permission that enforces nothing is worse than a missing one"*
>   — the same shape of failure, one layer over.
>
> **The plan's recommendation is Option A**, on the ground that the work is wide but genuinely
> mechanical and that "optional" is a decision that cannot be revisited cheaply once 200 more throw
> sites exist. **The owner decides.** Whichever way it goes, decide it *first*: this signature is on
> the critical path of the other five modules.
>
> **A third option, offered honestly and not recommended:** required on `AppError`, optional on the
> subclasses, with the subclasses supplying a class-level default. It ships in an afternoon and the
> 60 `ValidationError` sites keep their English forever, which is Option B wearing Option A's
> signature. Naming it so it is rejected on purpose rather than arrived at by drift.

### 3.3 `credential-invariants.test.ts` — the arithmetic is the feature

> ### ⚠ `guards.length === handlers.length - 2` applies to `access.routes.ts` **only**
>
> **File:** `master/tests/credential-invariants.test.ts:73-89`
>
> ```ts
> const handlers = routes.split('\n').filter((line) => /accessRoutes\.(get|post|put|delete)\(/.test(line));
> const guards   = routes.split('\n').filter((line) => line.includes('needs('));
> expect(guards.length).toBe(handlers.length - 2);
> ```
>
> This test reads the *source text* of `master/src/http/routes/access.routes.ts` and counts lines. The
> two exemptions are `GET /permission-catalogue` (static configuration, not company data) and
> `POST /me/password` (requiring `users.manage` to change your own password would mean nobody without
> administrative rights ever could).
>
> **Adding a handler to `access.routes.ts` without a `needs(...)` guard turns this red. That is the
> point** — the guard is not optional and the test is what makes "the two-layer check" true rather
> than merely documented. `requirePermissionMiddleware` was once defined, exported and mounted
> nowhere while the file's own header claimed otherwise; this test exists because of that.
>
> **Consequences for this batch:**
> - **Prefer not to touch `access.routes.ts` at all.** New surfaces get new router files. This is
>   also what the Logs design chose, correctly.
> - The Recycle Bin design proposed rewriting the four bodies of `GET /roles/deleted`,
>   `POST /roles/:id/restore`, `GET /users/deleted` and `POST /users/:id/restore` to delegate to the
>   Bin service. **Rewriting a body is safe; adding or removing a line matching either regex is not.**
>   Note that the guard regex is a plain `includes('needs(')` — a call to `needs(...)` inside a
>   comment, or a second guard on one route, changes the count as surely as a real one does.
> - The **only** change this batch actually needs in that file is one optional argument on
>   `POST /roles/:id/restore` (§5.5). No line count moves.
> - If you extend the test to cover a new router (the PDF design proposes exactly this for
>   `document.routes.ts`, with **zero** exemptions), write it as a **second, separate assertion**
>   against that file. Do not generalise the existing one into a loop over routers — the `- 2` is a
>   fact about `access.routes.ts` and about nothing else, and a loop would silently apply it to a
>   router where two ungated handlers are a leak.

### 3.4 `data.routes.ts` is mounted at the bare `/api`

> ### ⚠ New routers mount **above** `master/src/http/app.ts:41`, and never below `:44`
>
> ```
> master/src/http/app.ts
> 36  app.use('/api/setup',   setupRoutes);
> 37  app.use('/api/auth',    authRoutes);
> 38  app.use('/api/pairing', pairingRoutes);
> 39  app.use('/api/panels',  panelRoutes);
> 40  app.use('/api/access',  accessRoutes);   ← new routers go here
> 41  app.use('/api',         dataRoutes);     ← catch-all for the whole namespace
> 44  app.use('/uploads', express.static(config.uploadsDir));
> 49  app.use(express.static(webDist));
> 50  app.get(/^(?!\/api).*/, …)               ← SPA fallback
> ```
>
> Every other router is mounted on a specific prefix. `dataRoutes` is mounted on the **bare** `/api`,
> which makes it a catch-all layer for the entire API namespace, and it opens with
> `dataRoutes.use(requireAuth)` at `data.routes.ts:29`.
>
> Insert `app.use('/api/logs', …)`, `/api/reports`, `/api/recycle-bin`, `/api/fields` and
> `/api/documents` **between lines 40 and 41**.
>
> **Being precise about the failure, because overstating it would be its own kind of wrong:** no path
> currently declared in `dataRoutes` literally collides with any of the five new prefixes — every
> top-level path there begins with a literal segment (`/dashboard`, `/pipelines`, `/leads`, …), so a
> router registered below would still be reached by fall-through. The rule is what *keeps* that true.
> Three concrete costs of getting it wrong:
>
> 1. **A future collision lands silently.** The first time somebody adds `dataRoutes.get('/fields')`
>    or a top-level parameterised segment, a router mounted below is shadowed and answers nothing —
>    with no error and no test, because both routes exist and one simply never runs.
> 2. **The request passes two gates.** Mounted below, every request to a new router first traverses
>    `dataRoutes` and its `requireAuth`. Today that is merely wasted work; the moment `requireAuth`
>    acquires a side effect (a rate-limit counter, an audit entry, a session touch) it double-counts.
> 3. **Below line 44 or 49 is a real, immediate break.** `express.static` would answer first for any
>    path that happens to match a file on disk, and past line 50 the SPA fallback's `(?!\/api)`
>    negative lookahead means the request reaches `notFoundHandler` and returns a JSON 404 for a route
>    that exists.
>
> `express.json({ limit: '2mb' })` at `:23` is app-level and applies to every mount, so a document
> template body larger than 2 MB is refused by the body parser regardless of where the router sits.
> The PDF module needs to know that; it does not change with mount order.

### 3.5 Do **not** gate `/pipelines`, `/option-lists` or `/custom-fields`

> ### ⚠ A rejected `buildSnapshot` produces no snapshot at all — and on connect, it crashes
>
> **Files:** `master/src/http/routes/data.routes.ts:65-84`, `master/src/services/snapshot.service.ts`,
> `master/src/realtime/hub.ts:71,172-177,184`
>
> The Fields module adds a `/api/fields/*` surface. It is tempting to also route the three existing
> reads through a `fields.view` check, since they serve the same data. **Do not.**
>
> `buildSnapshot` calls `pipelineRepo.listPipelines`, `customFieldRepo.listOptions` and
> `customFieldRepo.listDefinitions` inside a `Promise.all` (`snapshot.service.ts`, second batch). If
> any of those acquires a permission check and throws for an actor lacking the key, the whole
> `Promise.all` rejects and **no snapshot is produced** — not a partial one, not one with empty lists.
> Three consumers, three different and all bad outcomes:
>
> | Call site | What happens |
> |---|---|
> | `hub.ts:184` — on connect | Inside `handleConnection`, which is invoked as `void handleConnection(io, socket)` at `hub.ts:71` with **no `.catch`**. A rejection here is an unhandled promise rejection, which on Node 22 terminates the Master |
> | `hub.ts:172-177` — `sendSnapshot()` after sign-in/out | Swallowed into `log.warn('Could not build snapshot: …')`. The panel silently keeps the **previous person's** snapshot, including their rate visibility |
> | `hub.ts:208` — `sync:request` | Correctly surfaces as a failed ack. The only one of the three that reports anything to a user |
>
> **The rule:** the three existing reads stay gated by `requireAuth` only. If the Fields service
> exposes read functions, it exposes an **unguarded pair** for `buildSnapshot` and the three existing
> routes to call, and a separate guarded pair for the `/api/fields/*` surface. Fields *reading* is
> ungated (`fields.view` has no tier ceiling and is not enforced on these three routes); Fields
> *editing* is management+.
>
> This also means `fields.view` gates the **management read surface** — the catalogue with usage
> counts and deleted values — and not the data every panel already holds in its snapshot. Say that
> out loud in the Fields document, because "we have a `fields.view` key and these three field
> endpoints are ungated" reads like an oversight until the reason is written down.

---

## 4. `shared/`

`shared` is consumed as **compiled output**, not source (`HANDOFF.md`, Traps). Every edit here is
invisible to `master` and `office` until `npm run build:shared` has run — which the `prepare` and
`pre*` scripts do, and which is why they exist. If a `master` file cannot see a type you just added
to `shared`, build shared before debugging anything else.

### 4.1 `shared/src/index.ts`

**Change.** Add `export *` lines, with explicit `.js` specifiers (NodeNext house convention), for
each new domain module and for the i18n barrel:

```ts
export * from './domain/activity.js';
export * from './domain/documents.js';
export * from './domain/fields.js';
export * from './domain/recycle-bin.js';
export * from './domain/reports.js';
export * from './i18n/index.js';
```

**Why.** `shared/package.json` declares exactly one entry in its `exports` map (`"."`), so there are
no subpath imports. A new directory is unreachable from `master` and `office` until it is re-exported
from this barrel.

**Blast radius.** All four packages. This file is the entire public surface of `@orderbook/shared`.

**Risk.** The barrel is eleven flat `export *` lines with no namespacing, so **every exported name in
the package shares one namespace**. Two modules exporting the same identifier is a compile error in
`shared`, `master`, `office`, `master/web` and `office/web` at once. Check for collisions before
adding a line — `ChainVerification`, `BinEntry`, `FieldCatalogue` and `DocumentModel` are all new, but
`ActivityEntry` already exists as a **different type** in
`master/src/repositories/activity-log.repository.ts:34`. Name the shared one `ActivityLogEntry`, as
the Logs design does, or the two will be confused at every import site even though they never collide
at the compiler.

### 4.2 `shared/src/domain/permissions.ts`

**Change.** Three separate things, all additive except the last:

1. **New module.** `MODULES += 'logs'`, `MODULE_ACTIONS.logs = ['view','export']`.
2. **New module.** `MODULES += 'documents'`,
   `MODULE_ACTIONS.documents = ['view','create','edit','delete']`.
3. **New capabilities.** `logs.verifyChain` (`admin` group), `recycleBin.view` and
   `recycleBin.viewAll` (`admin` group), `fields.view` (`admin` group), `documents.render`
   (`workflow` group) — each with its `permission.<key>` `labelToken`.
4. **Tier ceilings.** `MINIMUM_TIER` gains `'recycleBin.viewAll': 'management'` and
   `'documents.delete': 'management'`. It gains nothing for `logs.view`, `logs.export`,
   `logs.verifyChain`, `recycleBin.view`, `fields.view` or `documents.view/create/edit/render` — all
   of which therefore default to `office` and are available to every tier, which is what "reachable
   from both panels" requires.
5. **One change, not an addition:** `'fields.manage'` moves from `'admin'` to `'management'`
   (`permissions.ts:163`).
6. **Type narrowing (i18n).** `CapabilityDefinition.labelToken` narrows from `string` to `MessageKey`,
   and `PermissionCatalogue.modules[].actions` widens from `readonly PermissionAction[]` to
   `ReadonlyArray<{ key: PermissionAction; labelToken: MessageKey }>`.

**Why.** `reports.view` and `reports.export` **already exist** (`:72`) with no `MINIMUM_TIER` entry,
so they already default to `office` and are already available to every user. The Reports module is
their first enforcement site anywhere in the codebase — today they render as togglable grid cells
that gate nothing. Likewise `leads.delete`, `orders.delete`, `parties.delete` and `products.delete`
(`:171-174`) have been in the frozen catalogue and in stored role rows since `20260303`, and are
checked nowhere, because no delete path exists for any of the four. **Nine existing keys are reused
rather than minted**; seven of them currently enforce nothing.

The `labelToken` narrowing exists because the field is typed `string` today (`:86`), so a typo
compiles and renders as a missing translation at runtime. Narrowing it to `MessageKey` makes the
catalogue's own tokens compile-checked against `en.ts`.

**Blast radius.**
- `PERMISSIONS` is derived, not hand-listed (`:130-133`), so a new key propagates automatically to
  `isPermission`, `allowedForTier`, `effectivePermissions` and `buildPermissionCatalogue`.
- **The permission grid renders from this file**, so a new capability reaches the Master's Roles &
  Users screen with no UI change — that is the design working as intended, and it also means a key
  added here appears as a togglable control immediately, whether or not anything enforces it.
- `master/tests/helpers/fixtures.ts:139` uses `PERMISSIONS` for `ALL_PERMISSIONS`, so every existing
  test actor silently gains every new key. Intended, and worth knowing before you wonder why a
  permission test passed.
- `20260303000000_roles_and_users.ts:21` still does `import { allPermissions } from '@orderbook/shared'`
  and spends it at line 331. That is live. **Leave it** — the decision is recorded in
  `docs/BACKEND_MODULES.md` §2.3, and the union-based grant migration makes the outcome correct on
  every install regardless. Editing an applied migration is the more dangerous of the two rules to
  break.

**Risk.**
- **A key added here without the `20260309` grant is a key nobody holds.** It renders as an unticked
  cell, an administrator ticks it, and it works — but until somebody does, the module is invisible to
  everyone including the administrator who installed it. Land the two together.
- **Lowering `fields.manage` is safe; raising anything is not.** `effectivePermissions` (`:213-220`)
  filters **upward only** — it removes keys above the tier and never adds. Lowering a ceiling
  therefore cannot strip a stored key, so no tier-repair migration is needed. Raising one *would*
  strip keys from stored roles at the next save, silently, and that is precisely the defect
  `20260304000000_role_tier_ceiling_repair` exists to clean up. Do not raise a ceiling in this batch.
- **Do not grant new keys to every existing role.** One of the module designs proposed it. That is
  the act the no-wildcard rule at `:224-233` exists to prevent: *"a wildcard would silently add every
  permission the product ever gains to a role somebody approved before those permissions existed."*
  Granting `recycleBin.view` to a role nobody re-approved is the same act with extra steps.

### 4.3 `shared/src/domain/entities.ts`

**Change.** `DashboardSummary` is **extended, not replaced**. The declaration itself belongs to
`04-API-CONTRACT.md` §7.1, which is the sole authority for the wire shape and the per-figure gate
table; do not copy it here and do not let the two drift again. What this file's edit amounts to:

- **All ten counters become optional**, `openConflictCount` and `pendingSyncCount` included. They are
  gated on **`sync.resolveConflicts`**, exactly like every other figure is gated on its own key —
  they are not a special ungated pair. Absent when the actor does not hold the key.
- **Three new figures** — `openOrderCount`, `dispatchedThisWeekCount`, `pipelineBreakdown`.
  `pipelineBreakdown`'s element is `{ stageId, stageName, sequence, colourHex, leadCount }`;
  `sequence` is what lets a client render the board in board order without a second call, and the
  field is `colourHex` (not `colour`) and `leadCount` (not `count`) to match every other
  colour-carrying and count-carrying shape in the set.
- **`asOf: IsoTimestamp` is required**, not optional.

Plus, for the Recycle Bin and Fields modules: `OptionListItem` gains `hex: string | null`,
`deletedAt`, `createdAt`, `updatedAt`; `CustomFieldDefinition` gains `deletedAt`; `PipelineStage`
gains `isArchived: boolean`; `Role` and `User` each gain `deletedBy: RecordId | null`. **`RecordId`,
never `Uuid`** — roles and users carry `US…`-style text ids, and `Uuid` on a text id is a type that
lies. The same applies to `document_exports.rendered_by`.

**Why.** A figure the actor may not see must be **absent**, not `0` — the same rule the whole product
already applies to rates (`permissions.ts:14-17`: *"A null says 'this line has no rate', which is a
different and wrong statement — and one a client will happily total to zero."*). A dashboard reading
"Orders: 0" to somebody without `orders.view` is a false statement about the business, not a hidden
control. Optionality is what makes the type able to say "not shown".

`asOf` is required, not optional, because the Office Panel serves this figure from a **cached
snapshot** when offline and must be able to label it as stale. An optional `asOf` would let the
offline case render a confident number with no date.

**Blast radius.** `DashboardSummary` is consumed by `master/src/services/dashboard.service.ts:19`,
`master/src/realtime/hub.ts:155` and `:493-503`, `master/src/http/routes/data.routes.ts:51-56`, the
`dashboard:changed` socket event (`socket.ts:310`), and the Master's dashboard screen. **Making every
field optional is a breaking type change for every one of them.** The Master's screen currently
renders `summary.leadCount` directly; after this change it must handle `undefined` — and that
handling is a screen edit, which is UI-phase work. The server-side edits compile; the Master's
dashboard screen will show `undefined` in a card until the UI phase renders the absent case as an
em-dash, exactly as `HANDOFF.md` records was done for hidden rates.

That gap is real and should be stated to the owner rather than discovered. It is the one place where
"backend only" has a visible consequence in the shipped product.

**Risk.** Adding the three new figures without gating them (§5.22) leaks lead and order counts to
anybody with a paired panel. Making them optional without gating them makes the optionality
decorative.

### 4.4 `shared/src/domain/inputs.ts`

**Change.** `CursorQuery` and `CursorPage<T>` exactly as specified in §2.1, plus the module input
types: `RecycleBinQuery`, `RestoreInput`, `DocumentTemplateInput`, `DocumentAssetInput`,
`RenderDocumentInput`, `PreviewDocumentInput`, `DocumentExportQuery`, `ActivityLogQuery`,
`ReportRangeQuery`, `FieldValueInput`, `StageOrderInput`.

**Why.** The file header states what belongs here: write-side payloads, deliberately without `id`,
`createdByUserId` or `tenantId`, *"taken from the caller's identity, never from the body — a client
must not be able to name a tenant."* **Every new input type must honour that.** In particular no
input may carry `tenantId`, `deletedBy` or `actorUserId`.

**Blast radius.** `shared/src/protocol/socket.ts` imports 21 types from this file (`:36-57`) and both
web clients import from it. It is a type-only file with no runtime code.

**Risk.** Defining `CursorPage<T>` here a second time under a different shape. See §2.1 — it is the
single most likely compile break in the batch, because three designs each thought they owned it.

### 4.5 `shared/src/protocol/socket.ts`

**Change.** Four distinct edits:

1. **`details` on the failure arm** — the §2.5 prerequisite, built first:
   ```ts
   | {
       ok: false;
       error: string;
       code?: string;
       missingPermission?: string;
       details?: Record<string, unknown>;   // ← new
       messageKey?: MessageKey;             // ← new, i18n
       params?: MessageParams;              // ← new, i18n
     }
   ```
2. **`ChangeAction` gains `'restored'`** (`:180`).
3. **`ChangedEntity` gains `'document_template'` and `'document_export'`** (`:163-178`). It gains
   **nothing** for `option_list`, `custom_field` or `pipeline` — those three are already declared
   (`:173-175`) with nothing emitting them, and panels already hold that data in the snapshot.
4. **`SyncSnapshot` gains `dashboard: DashboardSummary`** (`:198-215`), and
   `ClientToServerEvents` gains the **46** new commands (`:218-303`) — the itemised list is
   `04-API-CONTRACT.md` §9.3, which owns it. Do not re-enumerate them here.

**Why `details` matters enough to build first.** `respond()` in `master/src/realtime/hub.ts:399-405`
sets `missingPermission` for `ForbiddenError` and nothing else — no `code`, no `details`, ever. So on
the Office Panel every structured conflict arrives as a bare English string. Two modules depend on
structured data reaching the Office browser: the Recycle Bin's `blockedBy` list and rename
`suggestion`, and the PDF Designer's `storedVersion`/`diff` from `assertVersionMatches`
(`domain/access.ts:195-202`). The HTTP path already carries `details`
(`http/middleware/error-handler.ts:28-32`); the socket path does not. This closes the asymmetry in
about fifteen lines across four files.

**Blast radius.** This file **is** the wire contract, imported by the Master hub, the Office panel's
socket client, and typed on both ends. `office/src/realtime/master-connection.ts` compiles against
`CommandResult<T>` directly (`:239` onward).

**Risk.**
- `ChangeAction` gaining `'restored'` widens a union that `office/src/realtime/master-connection.ts`
  consumes — and **that consumer ignores `action` entirely today**. See §6.2. Widening the type
  without fixing the consumer is how a restore appears on a panel as a duplicate row.
- `SyncSnapshot` gaining a key without extending `office/src/http/app.ts:395-407`'s `forCurrentUser`
  is a silent leak. There is **no test today** asserting that every `SyncSnapshot` key is accounted
  for in that function; this batch adds one (§9.3).
- All three new fields on the failure arm are **optional**. Making any of them required would break
  every existing `ack({ ok: false, error: … })` call site in `respond()` and in tests.

### 4.6 `shared/package.json`

**Change.** Add `"sideEffects": false`.

**Why.** The i18n catalogue is the **first runtime (non-type-only) import** either web bundle takes
from `@orderbook/shared` — every existing import site across both frontends is `import type`. Without
this hint, Rollup must assume the `export *` barrel has side effects and will pull `permissions.ts`,
`mutations.ts`, `hlc.ts` and `merge.ts` into the browser bundle rather than tree-shaking them.

**Risk.** `sideEffects: false` is a claim about the **whole package**, checked by nothing. It is true
today — every module in `shared/src` declares types, constants and pure functions, and the closest
thing to an initialiser is `const PERMISSION_SET = new Set(PERMISSIONS)` at `permissions.ts:137`,
which mutates nothing outside itself. It stops being true the day a module in `shared` registers a
global, patches a prototype, or writes to `process.env` at import time — at which point the bundler
will drop that module and the failure will present as a missing runtime behaviour with no error.
Write that condition into a comment beside the field.

---

## 5. `master/`

### 5.1 `master/src/config/index.ts`

**Change.** Two new blocks inside the `config` object:

```ts
locale: {
  /** Business timezone. Every calendar boundary in Reports is computed against this. */
  timeZone: process.env.ORDERBOOK_TIMEZONE ?? 'Asia/Kolkata',
  defaultLocale: isLocale(process.env.ORDERBOOK_DEFAULT_LOCALE)
    ? process.env.ORDERBOOK_DEFAULT_LOCALE
    : 'en',
},

documents: {
  dir:        path.join(dataDir, 'documents'),
  exportsDir: path.join(dataDir, 'documents', 'exports'),
  assetsDir:  path.join(dataDir, 'documents', 'assets'),
  /** Vendored SIL OFL faces. Under packageRoot, not dataDir — they ship with the code. */
  fontsDir:   path.join(packageRoot, 'assets', 'fonts'),
  maxAssetBytes:   512 * 1024,
  maxPreviewBytes: 4 * 1024 * 1024,
  retainExports: null,
},
```

**Why one key and not two.** The Logs/Reports design proposed `config.reporting.timeZone`; the
PDF/Dashboard design proposed `config.locale.timeZone`. Same environment variable, two config paths,
neither noticing the other. `locale` wins because the key also serves i18n date formatting later.
`defaultLocale` goes under `locale` too — one of the module designs put it at `config.ui.defaultLocale`,
which would put the locale and the timezone in different places for no reason.

**Why the fonts live under `packageRoot`.** `dataDir` is runtime state the operator can delete;
`assets/fonts/` is code that ships with the build. A font under `dataDir` is a font that vanishes when
somebody clears the data directory, and Devanagari support is a hard requirement.

**Blast radius.** `config` is imported by 12 files across `master/src` and is typed `as const`, so
`Config = typeof config` widens automatically. Additive; nothing existing changes shape.

**Risk.**
- **A timezone typo does not fail here.** `'Asia/Calcutta'` is a valid alias, `'Asia/Kolkota'` is
  not — and nothing in this file checks. That is what §5.2's startup validation is for, and it is the
  reason the validation is not optional.
- `intFromEnv` exists at `:21-26` and returns the fallback for anything unparseable. There is no
  equivalent for strings, so `ORDERBOOK_TIMEZONE=""` yields `''` and not the default, because `??`
  only catches `undefined`. Use `process.env.ORDERBOOK_TIMEZONE || 'Asia/Kolkata'` or trim-and-check;
  an empty-string timezone reaches Postgres and fails at startup with a confusing message.

### 5.2 `master/src/index.ts`

**Change.** Three additions, in this order:

```ts
await fs.mkdir(config.uploadsDir, { recursive: true });
await fs.mkdir(config.documents.exportsDir, { recursive: true });   // ← new
await fs.mkdir(config.documents.assetsDir,  { recursive: true });   // ← new

const postgres = await startPostgres();
initDatabase(postgres.connectionUrl);
await runMigrations();
await assertTimeZoneValid();                                        // ← new, AFTER migrations
assertFontsPresent();                                               // ← new, pure, no I/O on the DB
```

`assertTimeZoneValid()` runs `SELECT now() AT TIME ZONE $1` once with the configured zone and aborts
with a message **naming `ORDERBOOK_TIMEZONE`** if Postgres raises `invalid_time_zone`.

**Why after `runMigrations()`.** It needs a live connection, and it must not run before the schema is
in place — a failure before migrations would leave a half-migrated database and a message about
timezones. Placing it after also means a fresh install proves its own configuration on first boot.

**Why abort rather than fall back.** A silently-defaulted timezone means every month bucket in every
report is computed against the wrong day boundary, and nothing anywhere says so. The one thing worse
than a report that fails is a report that is quietly wrong. The startup order comment at `:3-7` already
states the principle: *"the database must be up and migrated before anything can serve requests."*

**Blast radius.** This is the only entrypoint. A throw here is fatal by design — `main().catch()` at
`:89-92` logs and exits 1.

**Risk.** Putting the validation before `runMigrations()` on a fresh install means the first boot
aborts on a database that has no schema, and the operator sees a timezone error where they should see
a migration. Putting it after `httpServer.listen()` means the Master serves requests for a few
milliseconds with an unvalidated zone — harmless in practice, but it also means the abort races the
"ready" log lines, and the operator reads "Master Panel ready" immediately above a fatal error.

### 5.3 `master/src/db/migrations/index.ts`

**Change.** Five imports and five array entries appended, **in timestamp order, at the end**:

```ts
import * as softDeleteColumns          from './20260305000000_soft_delete_columns.js';
import * as fieldValuesAndStageOrdering from './20260306000000_field_values_and_stage_ordering.js';
import * as activityLogActorName        from './20260307000000_activity_log_actor_name.js';
import * as documentTemplatesAndExports from './20260308000000_document_templates_and_exports.js';
import * as newModulePermissionGrant    from './20260309000000_new_module_permission_grant.js';

export const migrations: Migration[] = [
  …,
  { name: '20260305000000_soft_delete_columns',            ...softDeleteColumns },
  { name: '20260306000000_field_values_and_stage_ordering', ...fieldValuesAndStageOrdering },
  { name: '20260307000000_activity_log_actor_name',         ...activityLogActorName },
  { name: '20260308000000_document_templates_and_exports',  ...documentTemplatesAndExports },
  { name: '20260309000000_new_module_permission_grant',     ...newModulePermissionGrant },
];
```

**Why an explicit registry at all.** The header (`:1-13`) explains it: Knex can scan a directory, but
that requires the runtime to load the files itself, which means `.ts` under `tsx` and `.js` after a
build. Importing them here makes the set and its order a compile-time fact.

**Blast radius.** `RegistryMigrationSource` (`:40-52`) is what Knex's migrator sees. Nothing else
reads this file. But every table and column in the batch depends on it.

**Risk.**
- **A file written but not imported here is a silent no-op.** Nothing turns red — the migration
  simply never runs, and the first failure is a missing-column error deep inside a service, at
  runtime, on the owner's machine. With **five** files landing at once against a hand-maintained
  array, this is not a theoretical concern. `docs/BACKEND_MODULES.md` §9 requires a **migration
  registry guard test** before the first of them lands: read the directory, read the array, assert
  they match. It is a new file and belongs to §9 of this document.
- `Migration.down` is a **required** member of the interface (`:27`). Every new file must export one,
  even when it is deliberately empty with a justifying comment — `20260304000000_role_tier_ceiling_repair.ts`
  is the precedent.
- `name` must equal the filename minus `.ts`, exactly. Knex records that string in its migrations
  table; a mismatch on a database that has already run the migration makes it run again.
- The header's own rule: *"Never reorder or edit an entry that has already run on a real
  installation."* The owner's PC has run all six existing migrations.

### 5.4 `master/src/http/app.ts`

**Change.** Five `app.use` lines inserted between `:40` and `:41`. See §3.4 for the full warning.

```ts
app.use('/api/access',      accessRoutes);
app.use('/api/logs',        logRoutes);          // ← new
app.use('/api/reports',     reportRoutes);       // ← new
app.use('/api/recycle-bin', recycleBinRoutes);   // ← new
app.use('/api/fields',      fieldsRoutes);       // ← new
app.use('/api/documents',   documentRoutes);     // ← new
app.use('/api',             dataRoutes);
```

**Blast radius.** Every Master HTTP request. `createApp()` is called from `master/src/index.ts:40` and
from `master/tests/http-api.integration.test.ts`.

**Risk.** §3.4. Additionally: `express.json({ limit: '2mb' })` at `:23` caps every request body,
including a document template's JSON. If a template can legitimately exceed 2 MB — it should not, but
an embedded base64 logo would do it — the limit must be raised **per-route on the document router**,
never globally, because raising it globally raises it for the sync push endpoint too.

### 5.5 `master/src/http/routes/access.routes.ts`

**Change. One line.** `POST /roles/:id/restore` (`:94-100`) passes `req.body?.renameTo` through to
`roleService.restoreRole`. Same for `POST /users/:id/restore` (`:150-156`).

**Why.** Restoring a role or user whose name has since been reused must be able to offer a rename,
and `restoreRole` gains that optional argument (§5.16). The route is where the client's choice
arrives.

**Blast radius.** `master/web/src/api.ts:restoreRole`/`restoreUser`, and the inline Recycle Bin in
`AccessScreen.tsx`. Both keep working — the argument is optional and omitting it preserves today's
behaviour exactly (409 with a suggestion, no rename).

**Risk.** §3.3. **Do not add or remove a handler in this file, and do not add or remove a line
containing `needs(`.** `master/tests/credential-invariants.test.ts:88` asserts
`guards.length === handlers.length - 2` by counting source lines, and it is deliberately brittle.

**Explicitly not changed:** the four Bin-adjacent endpoints (`GET /roles/deleted`,
`POST /roles/:id/restore`, `GET /users/deleted`, `POST /users/:id/restore`) keep their paths, their
guards and their service calls. One design proposed re-pointing their bodies at the cross-entity Bin
service. That is a refactor with no user-visible effect, it puts the most guard-sensitive file in the
repository on the critical path of a new module, and the Bin service can reuse
`roleService.restoreRole` / `userService.restoreUser` directly. **Defer it.**

### 5.6 `master/src/http/routes/data.routes.ts`

**Change.** Two things, and one deliberate non-change.

1. **Four `DELETE` routes**, each guarded:
   ```ts
   import { actorFromRequest, requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';
   const needs = requirePermissionMiddleware;

   dataRoutes.delete('/leads/:id',    needs('leads.delete'),    asyncHandler(…leadService.deleteLead…));
   dataRoutes.delete('/orders/:id',   needs('orders.delete'),   asyncHandler(…orderService.deleteOrder…));
   dataRoutes.delete('/parties/:id',  needs('parties.delete'),  asyncHandler(…catalogService.deleteParty…));
   dataRoutes.delete('/products/:id', needs('products.delete'), asyncHandler(…catalogService.deleteProduct…));
   ```
2. **`GET /pipelines` (`:65-70`), `/option-lists` (`:72-77`) and `/custom-fields` (`:79-84`) are left
   exactly as they are.** See §3.5. This is the single most important non-change in the document.

**Why these four are the interesting part.** They are the **first delete path the product has ever
had** for leads, orders, parties and products, and therefore the first enforcement site for four keys
that have been in the frozen catalogue and in stored role rows since `20260303`
(`permissions.ts:171-174`) and are checked nowhere.

**Blast radius.** `dataRoutes` is the Master's own UI API. Adding a `needs` alias here is safe:
`credential-invariants.test.ts` reads `access.routes.ts` **only** (`:75`), and its regex is
`/accessRoutes\.(get|post|put|delete)\(/`, which cannot match `dataRoutes.delete(`.

**Risk.**
- The file's opening comment states a deliberate asymmetry: *"the Master cannot create a lead… the
  absence of a POST /leads here is what makes that true rather than merely documented"* (`:5-9`).
  Adding `DELETE /leads/:id` does not contradict it — deletion is a Master-only, online-only act — but
  **update the comment**, or the next reader will conclude the rule was forgotten.
- Every other handler in this file is guarded by `requireAuth` alone and relies on the service to
  check. Adding a route-level guard to four routes and not the rest is an inconsistency somebody will
  "fix" by removing them. Write the reason in the file: destructive operations get both gates, so a
  doomed delete never opens a transaction.
- The four services must check the same permission again. The route guard is the second gate, not the
  only one (`require-auth.ts:58-63`).

### 5.7 `master/src/http/middleware/require-auth.ts`

**Change.** `actorFromRequest` (`:81-92`) populates one more field:

```ts
return {
  tenantId: req.user.tenantId,
  actorType: 'user',
  actorId: req.user.id,
  userId: req.user.id,
  actorName: req.user.displayName ?? null,   // ← new
  permissions: req.permissions ?? null,
  deviceCode: null,
};
```

**Why.** The audit trail's `actor_name` column is derived from the `ActorContext` inside
`recordActivity` (§3.1). The name must therefore be on the context, and this is one of the two places
a context is constructed for a real person.

**Blast radius.** `actorFromRequest` is called from ~30 handlers across `data.routes.ts` and
`access.routes.ts`. Adding a required field to `ActorContext` (§5.11) makes **every** construction
site a compile error until updated — which is the intent, and enumerates the work for you. There are
five: this one, `panel-actor.service.ts` (two arms), `hub.ts:457-464` (`adminActor`),
`domain/actor.ts:51-60` (`systemActor`), and `master/tests/helpers/fixtures.ts:142-154` (`testActor`).

**Risk.** `req.user` is typed `User` (`:12`), which declares `displayName` — verified. Using
`req.user.username` instead would put the login name in the audit trail where the human name belongs,
and the two diverge the first time somebody is renamed.

Note what does **not** change here: `attachSession` (`:25-48`) resolves the session and the permission
set on every request, which is *"what makes a permission change take effect on the next request
rather than after a timeout"* (`:29-30`). No new module may cache a permission set anywhere.

### 5.8 `master/src/http/middleware/error-handler.ts`

**Change.** Emit two more fields alongside the existing envelope (`:28-32`):

```ts
res.status(error.statusCode).json({
  error: error.code,
  message: error.message,
  ...(error.details ? { details: error.details } : {}),
  messageKey: error.messageKey,
  ...(error.params ? { params: error.params } : {}),
});
```

**Why.** Purely additive. `details` is already carried and already correct — this is the i18n half.

**Blast radius.** Every HTTP error response from the Master. `master/web/src/api.ts:78-95` parses the
body and constructs `ApiError`; unknown fields are ignored until §7.1 reads them.

**Risk.** Low, unless Option B in §3.2 is chosen — in which case `messageKey` is `undefined` on most
errors and the field should be spread conditionally like `details` is, rather than emitted as an
explicit `undefined` that survives `JSON.stringify` as an absent key anyway but reads as an oversight.

### 5.9 `master/src/realtime/hub.ts`

The largest single file change in the batch. Four distinct edits.

**Change 1 — `respond()` carries the full error (`:391-406`).**

```ts
.catch((error: unknown) => {
  log.warn(`Command failed: ${toErrorMessage(error)}`);

  if (error instanceof AppError) {
    ack({
      ok: false,
      error: error.message,
      code: error.code,
      ...(error instanceof ForbiddenError ? { missingPermission: error.permission } : {}),
      ...(error.details ? { details: error.details } : {}),
      messageKey: error.messageKey,
      ...(error.params ? { params: error.params } : {}),
    });
    return;
  }

  ack({ ok: false, error: toErrorMessage(error) });
});
```

Note the `ForbiddenError` branch **collapses into** the `AppError` branch rather than sitting above
it. `ForbiddenError extends AppError` and already carries `{ permission }` in `details`
(`errors.ts:51`), so keeping both branches would emit the permission twice under two names. Keep
`missingPermission` for wire compatibility — `office/src/realtime/master-connection.ts:257` reads it.

**Change 2 — 46 new commands inside `registerCommands()` (`:204-302`).** The count and the itemised
list are `04-API-CONTRACT.md` §9.3's, not this document's. Each is one line using the
existing shape:

```ts
socket.on('log:list', (query, ack) => run(ack, (actor) => logService.listEntries(query, actor)));
```

**Change 3 — `DIRECTORY_ENTITIES` (`:114`) gains `'document_export'`.** A `document_export` row names
the lead or order it was rendered for, and the recipient may not be entitled to see that record.
`'document_template'` does **not** join the set — a template is configuration every panel may render
from. `'option_list'`, `'custom_field'` and `'pipeline'` do not join it either.

**Change 4 — `broadcastDashboard` (`:476-504`) also serves Office Panels.** Today it iterates
`ROOM_MASTER_ADMINS` only. The Office Dashboard needs the same push, re-deriving the summary per
socket through `panelActor(socket, panelId)` rather than the admin path.

**Why the actor is resolved per command and never captured.** `registerCommands`'s header
(`:195-203`) states it, and `HANDOFF.md` lists it as a trap: *"A socket outlives sign-ins, sign-outs
and role edits; caching the actor when the panel connects is exactly how a revoked permission
survives until the next reconnect."* The `run(ack, actor => …)` helper at `:205-206` awaits
`actorFor()` on every single call. **New commands must use `run`. A `socket.on` that closes over an
actor is the defect this shape exists to prevent.**

**Blast radius.** The hub is the Office Panel's entire command surface. `respond()` is on the path of
every command including the four auth commands in `registerAuthCommands` (`:311-381`).

**Risk.**
- **`registerAuthCommands` gets nothing.** Those four commands are the one group a panel may issue
  while holding no user identity (`:304-310`). A new module command placed there would run
  unauthenticated.
- **`broadcastDashboard` disconnects a socket whose session no longer resolves** (`:488-491`).
  Extending it to Office Panels must **not** copy that behaviour: a panel socket is authenticated by
  its pairing secret, not a user session, and an unattended panel has no session to resolve.
  Disconnecting it would drop the panel off the LAN every time nobody was signed in.
- **Change 4 is a fan-out, and it runs on every dashboard-moving change** (`DASHBOARD_ENTITIES` at
  `:117` covers lead, order, party, product, stock, sync_conflict). It re-resolves the actor and
  re-queries the summary **per socket**. With one Master and a handful of panels that is fine; it is
  worth a comment saying so, because the shape does not obviously scale and the next reader should
  know it was considered.
- Changing `respond()` changes the *shape* of every failure ack, including for the existing 25
  commands. `office/tests/user-session.test.ts` exercises the sign-in path; run it.

### 5.10 `master/src/domain/actor.ts`

**Change.**

```ts
export interface ActorContext {
  tenantId: string;
  actorType: 'user' | 'office_panel' | 'system';
  actorId: string | null;
  userId: string | null;
  /** Display name at the time of the action, stamped into the audit trail. */
  actorName: string | null;
  permissions: PermissionSet | null;
  deviceCode: string | null;
}
```

`systemActor` (`:51-60`) sets `actorName: null`.

**Why `string | null` and not optional.** Required-and-nullable makes every construction site declare
an answer. Optional lets four of the five sites forget, which is §3.1's failure mode arriving by a
different door.

**Why not just read the name from `users` inside the repository.** A name stamped at write time is
the name the actor had **then**. Joining at read time renders history under today's names, and a
deleted user renders as nothing at all — which is the whole reason the column exists.

**Blast radius.** `ActorContext` is the single most widely imported type in `master/src`: every
service function takes one. Adding a required field breaks the **five** construction sites listed in
§5.7 and nothing else — consumers only read fields.

**Risk.** Making it optional (see above). Also: do not add a `roleName` or `permissions` snapshot
alongside it "while we are here". The audit trail records what was done and by whom; what they were
*allowed* to do is reconstructible from the role's version history and does not belong in a hash-
chained row.

### 5.11 `master/src/domain/pipeline.ts`

**Change.** Three things:

1. `Stage` (`:14-21`) gains `isArchived: boolean`.
2. `defaultStage` (`:24-30`) skips archived stages when falling back to `stages[0]`.
3. `assertStageMove` (`:47-67`) refuses a move **into** an archived stage.

**Why.** Fields management can archive a pipeline stage. A stage that no longer accepts new records
but still holds old ones is the only safe way to retire one — deleting it would orphan every record
sitting in it.

**Blast radius.** `defaultStage` decides where every newly created lead and order lands.
`assertStageMove` gates every drag on both Kanban boards and every `lead:setStage` / `order:setStage`
command from either panel.

**Risk.**
- **`defaultStage` throws when it finds nothing** (`:26-29`). If every stage in a pipeline is
  archived, the new fallback finds none and lead creation stops working company-wide, with a message
  about the tenancy migration that has nothing to do with the cause. The Fields service must refuse
  to archive the last live stage, and this function's error message must be updated to name the real
  possibility.
- **Do not add more transition rules.** The file header is explicit about why the rule set is thin:
  *"a Kanban board whose columns refuse most drags is a board people fight rather than use."* The two
  rules that exist are about not rewriting history, not about process. Refusing a move *into* an
  archived stage is consistent with that; refusing a move *out of* one would strand records.
- `master/tests/lead.integration.test.ts` and `sync.integration.test.ts` both drive stage moves.

### 5.12 `master/src/domain/custom-fields.ts`

**Change.** A comment on `evaluateCompleteness` (`:20-30`). **No behaviour change.**

State that the function is called with **live definitions only**, so soft-deleting a required
definition makes affected records complete again, and restoring it makes them incomplete again — and
that this is correct, because completeness is a statement about today's configuration rather than a
stored fact.

**Why a comment is a real deliverable here.** The Fields module makes definitions soft-deletable for
the first time. Without the note, the first person to see a badge disappear will "fix" it by
snapshotting completeness onto the record, and the offline promise at `:5-9` dies with it: *"A panel
that has been offline all afternoon must never lose a lead because head office added a mandatory
field this morning."*

**Blast radius.** None. `normalizeCustomFields` (`:37-55`) already handles the adjacent case
correctly — *"A select whose option was later deleted keeps its value"* (`:32-35`) — which is the same
rule for values that this comment states for definitions.

**Risk.** That somebody reads the comment as a description of a bug and changes the behaviour.

### 5.13 `master/src/domain/access.ts`

**Change.** Only if §3.2 lands as Option A: the twelve throw sites pass a `messageKey` and params
instead of composing an English sentence.

```
assertPermissionsWithinTier  → 'validation.permissions.aboveTier'  { tier, keys }
assertNameAvailable          → 'error.conflict.nameTaken'          { kind, value }   :160-169
assertVersionMatches         → 'validation.expectedVersion.missing' { storedVersion } :183-192
                             → 'error.conflict.staleVersion'       { storedVersion, expectedVersion } :193-202
```

**Why this file is the sharp end.** It holds the guards the shipped product's tests assert on most
directly, and `assertNameAvailable` composes two different English sentences from one branch
(`:161-168`) — a shape that maps onto two tokens, not one.

**Blast radius.** Both `access.integration.test.ts` and `permissions.integration.test.ts` assert on
message text.

**Risk.** The details are already correct and must not be disturbed: `assertNameAvailable` throws
`ConflictError` with `{ field, value }`, and `assertVersionMatches` throws with `{ storedVersion }`
when `expectedVersion` is omitted and `{ storedVersion, expectedVersion, diff }` when it is stale.
Those are **already fixed** and are load-bearing for the Recycle Bin's rename flow and the PDF
Designer's template edits. Adding a token must not restructure `details`.

### 5.14 `master/src/lib/errors.ts`

**Change.** `AppError` gains `messageKey` and `params`; each subclass supplies a class-level token.
The `details` parameter and its long justifying comment (`:12-23`) stay exactly as they are.

See **§3.2** — this is the open question, and the whole file is downstream of it.

**Blast radius.** 129 construction sites (see §3.2 for why grep says 126), `error-handler.ts:18`,
`hub.ts:399`, `toErrorMessage` at
`:80-84`, and `office/src/http/app.ts` indirectly through the wire.

**One observation while you are in here, offered as context and not as work:** `TenantViolationError`
(`:62-66`) is constructed **nowhere** in the repository — zero `new TenantViolationError(` sites —
while `error-handler.ts:24-26` branches on it to log at error level. It is a defined, exported,
never-thrown class. That is the same shape as the `field.saleRate.edit` defect `HANDOFF.md` records,
one layer down. Not this batch's job; worth an issue.

### 5.15 `master/src/repositories/activity-log.repository.ts`

**Change.** Two things:

1. **The signature change** — `recordActivity(entry, actor, trx)`. See **§3.1**.
2. **Read functions added** — `listEntries(tenantId, filter, runner)`, `listFacets(…)`,
   `verifyChain(tenantId, window, runner)` and, as the fourth, **`chainBounds(…)`**. Extended, not
   replaced.

   **`chainBounds` and `streamForExport` are two different functions and both exist.** `chainBounds`
   returns the `(minSequence, maxSequence, count)` of the tenant's chain so `verifyLogChain` can
   clamp a window before it walks anything; `streamForExport` is the batched reader behind
   `exportLogs`, fetching 5,000 rows at a time to a hard cap. Naming one where the other is meant is
   how a 250,000-row export ends up in a function whose job was to return three integers.

   **Repository names are not service names.** The service layer above this file is `listLogs`,
   `listLogFacets`, `verifyLogChain` and `exportLogs` (and, for the Bin, `listBin`, `binCounts` and
   `restoreEntity`) — `02-FILE-STRUCTURE.md` owns that manifest. The repository functions named above
   are what those four call.

**Why verification runs in SQL.** The chain digest covers `details::text` — Postgres's own JSONB
rendering — so Node cannot reproduce the bytes. The migration factors the inline digest expression
out of `activity_log_chain()` into a reusable `activity_log_row_hash(...)` function and
`verifyChain` re-walks with it.

**Why the transaction, the `SET LOCAL statement_timeout` and the ordered walk all live *here*.** The
service clamps the window and checks the permission; it does not open a transaction. Opening
`db().transaction()` in a service is Knex in a service — the one thing the clean-architecture
convention forbids (`HANDOFF.md` decision 12). `dashboard.service.ts:51` already commits that
violation and §5.19 fixes it; do not add a second.

**Blast radius.** Every audited write in the product, plus the new Logs read API.

**Risk.** §3.1, plus: the file header (`:19-24`) records an accepted cost — the chain trigger takes a
per-tenant advisory lock, so every audited write for one company serialises. Adding a **read** that
holds a transaction open for the length of a chain walk puts every write behind it. `verifyChain`
must be read-only, bounded by an explicit window, and carry its own statement timeout.

### 5.16 `master/src/repositories/mappers.ts`

**Change.** New mappers (`mapActivityLogEntry`, `mapBinEntry`, `mapDocumentTemplate`,
`mapDocumentExport`, `mapDocumentAsset`, `mapStageCount`) and four existing ones extended:
`mapOptionListItem` gains `hex`/`deletedAt`/`createdAt`/`updatedAt`, `mapCustomFieldDefinition` gains
`deletedAt`, `mapPipelineStage` gains `isArchived`, `mapRole` and `mapUser` gain `deletedBy`.

**Why the date rule lives here.** `toIsoDate` (`:79-90`) is the existing fix for the IST day-shift
defect, and its comment is the canonical statement of it: *"Reading it back with `toISOString()`
converts to UTC first, so anywhere east of Greenwich a follow-up date of the 1st comes back as the
31st."* **Every new mapper touching a `DATE` column uses `toIsoDate`, never `toIso`.**

**Blast radius.** Every read path in the product. `mapActivityLogEntry` must emit
`actor: { type, id, name }` with `name: null` when unknown — **never a fabricated label** like
"Unknown user", which would be indistinguishable from a real display name.

**Risk.**
- **`toIso` on a `DATE`-derived value is the highest-consequence single-token mistake in the batch.**
  `toIso` (`:60-63`) calls `.toISOString()`. Month buckets in Reports are computed in SQL and returned
  as `'YYYY-MM'` **TEXT**, and must never become a JS `Date` on the way through a mapper.
- `credential-invariants.test.ts:60-70` reads this file's source and asserts two things:
  `const { password_hash: _passwordHash, ...safe } = row;` appears literally, and **no mapper emits a
  line matching `/^\s*passwordHash:/m`**. A new mapper must not introduce either pattern by accident.
- **`master/tests/mappers.test.ts` exists** and covers `toNumber`, `toIso`, `firstCount`, `mapParty`,
  `mapProduct`, `mapLineItem` and `mapLead` — but **has no test for `toIsoDate` at all**. Verified.
  Adding one is the cheapest high-value test in the batch, and it would be the first coverage the
  IST fix has ever had.

### 5.17 `master/src/repositories/{party,product,lead,order}.repository.ts`

**Change.** Per file, a matched pair plus filters:

```ts
softDeleteParty(tenantId, id, actorId, trx)   // deleted_at, deleted_by, version+1, updated_at,
                                              // hlc, field_hlc.deleted_at
restoreParty(tenantId, id, trx)               // the same, in reverse
```

and `.whereNull('deleted_at')` added to **every existing read**, with an
`options: { includeDeleted?: boolean }` escape hatch for the Bin:

| File | Reads that must gain the filter |
|---|---|
| `party.repository.ts` | `listParties` `:17`, `findPartyById` `:48`, `countParties` `:132` |
| `product.repository.ts` | `listProducts` `:31`, `findProductById` `:69`, `findProductByCode` `:79`, `countProducts` `:167` |
| `lead.repository.ts` | `listLeads` `:40`, `findLeadById` `:84`, `countOpenLeads` `:228`, `countFollowUpsDue` `:236` |
| `order.repository.ts` | `listOrders` `:45`, `findOrderById` `:81`, `countOrders` `:207` |

**Why the delete must stamp `hlc`, and why it is not a mutation kind.** All four entities carry
`version`/`hlc`/`field_hlc`, unlike roles and users. Mirroring `softDeleteRole`
(`role.repository.ts:217-231`) exactly would bump `version` without advancing `hlc`, leaving a state
the merge engine cannot interpret: a queued offline edit with a later `hlc` wins on every field and
quietly writes to a tombstone. **So stamp `hlc` and `field_hlc.deleted_at` on both delete and
restore.**

And do **not** add delete/restore `MutationKind`s. Deletes are Master-online-only, matching the
roles/users precedent; propagation to panels goes through the existing `publishChange`/`ChangedEntity`
path with the new `'restored'` action.

**Blast radius.** These four repositories are behind `catalogService`, `leadService`, `orderService`,
`searchService`, `snapshotService`, `dashboardService` and `syncService`.

**Risk.**
- **A missed `.whereNull('deleted_at')` shows a deleted record as live**, and there is no error. The
  four `count*` functions are the easiest to miss because they are far from the list functions, and a
  wrong count on the dashboard is the least likely thing anyone reports.
- `findProductByCode` (`:79`) is used by the Office Panel's Add Lead screen. A deleted product that
  still resolves by code lets a new lead reference a tombstone.
- **`search.repository.ts` is not in the table above and needs the same treatment.** Search is just
  another read — `master/src/domain/visibility.ts:9-10` says so about masking, and the same applies
  to soft deletes. `master/tests/search.integration.test.ts` includes a case about finding a
  historical order under a product name that has since changed; a deleted-row filter must not break
  it.
- The unique **indexes** `idx_parties_code_tenant` and `idx_products_code_tenant`
  (`20260301000000_tenancy_access_and_sync.ts:144-150`) are indexes, **not table constraints**, so
  `ALTER TABLE … DROP CONSTRAINT` fails. `DROP INDEX` then recreate `WHERE deleted_at IS NULL`, or a
  soft-deleted party reserves its code forever. That is migration work, named here because the
  repository is where the consequence shows up.

### 5.18 `master/src/repositories/custom-field.repository.ts` and `pipeline.repository.ts`

**Change.** Both go from read-only to read/write.

`custom-field.repository.ts` gains `insertOption`, `updateOptionColumns`, `softDeleteOption`,
`restoreOption`, `reorderOptions`, and the same five for definitions. `pipeline.repository.ts` gains
`updateStageColumns`, `reorderStages`, `setDefaultStage`, `archiveStage`, `restoreStage`.

**Every one takes a required `trx: TransactionContext`, and every one calls its cache invalidator.**

**Why the caches matter more than usual here.** Both files hold process-level caches with explicit
invalidators — `invalidateFieldCache` (`custom-field.repository.ts:20`) and `invalidatePipelineCache`
(`pipeline.repository.ts:22`). Today nothing writes to either table at runtime, so the invalidators
are called only by `master/tests/helpers/fixtures.ts:112-113`. **This batch makes them live for the
first time.** A write that does not invalidate leaves every subsequent read in that process serving
the pre-edit value, until a restart — and on the Master, "until a restart" means "until the shop
closes".

**Why the stage reorder needs deferred constraints.** `idx_pipeline_stages_seq`
(`20260301000000_tenancy_access_and_sync.ts:253`) is a unique **index**, and a unique index cannot be
`DEFERRABLE`. Reordering stages one row at a time transiently duplicates a sequence number and the
index rejects it. The migration drops the index and adds a deferrable table constraint; `reorderStages`
then runs `SET CONSTRAINTS … DEFERRED` and one `UPDATE … FROM (VALUES …)`.

`idx_pipeline_stages_one_default` (`:261`) is a **partial** unique index and genuinely cannot become a
deferrable constraint — a partial index has no constraint form. Default-swapping therefore uses
clear-then-set ordering inside one transaction.

**Blast radius.** `pipelineRepo.listPipelines` is called by `buildSnapshot`, `data.routes.ts:65-70`
and `hub.ts:294-296`. `customFieldRepo.listOptions`/`listDefinitions` are called by `buildSnapshot`,
two routes, and `evaluateCompleteness` on every lead read.

**Risk.** §3.5 — these functions are inside `buildSnapshot`'s `Promise.all`. A permission check added
to any of them takes the Master down on the next panel connect.

### 5.19 `master/src/services/` — the write services

**`catalog.service.ts`** gains `deleteParty(id, actor)` requiring `parties.delete` and
`deleteProduct(id, actor)` requiring `products.delete`, plus internal restore functions the Bin calls.
Each is one `db().transaction()` containing the soft delete **and** `recordActivity` — the atomic
form — then `publishChange` after commit.

**`lead.service.ts`** gains `deleteLead`/`restoreLead`, and `assertSourcePlatform` moves to a domain
rule that consults the option list only when the value **changes** (removing an option value must not
retroactively invalidate every lead that used it).

**`order.service.ts`** gains `deleteOrder`/`restoreOrder`. `deleteOrder` calls
`reservationRepo.releaseForOrder(orderId, trx)` **inside the same transaction**, then publishes stock
for the affected `(product, colour)` pairs after commit.

> `releaseForOrder` (`reservation.repository.ts:111`) is currently **dead code** — a repository-wide
> grep finds only its definition and its `.d.ts`. Deleting an order is its first caller, and it closes
> a real hole: without it, deleting an order leaves its stock reserved forever.

**Why these must use `recordActivity` and not `recordDetachedActivity`.** Locked decision, and worth
restating because the four services being edited are four of the six that currently use the detached
form. `catalog.service.ts` has 4 detached sites, `lead.service.ts` 3, `order.service.ts` 2 — so the
new functions will sit **directly beside** calls that do it the other way, and copying the
neighbouring line is the obvious mistake. The detached variant swallows failures into a warning
(`activity-log.repository.ts:83-92`) and exists for the narrow case of recording a *failed* operation
that has no transaction to belong to. A delete has a transaction.

**Risk.**
- **`publishChange` must fire after commit, not inside the transaction.** Every existing site does
  (e.g. `catalog.service.ts:80`, `role.service.ts:288`). Publishing inside means a panel is told about
  a row that a subsequent rollback un-did.
- **Stock.** `deleteOrder` moves inventory. `HANDOFF.md` records the policy that an order is never
  blocked by insufficient stock and that stock may go negative; releasing a reservation on delete is
  the inverse and is correct, but it changes numbers on the Inventory screen and on the dashboard.
  Publish the affected stock rows or the screens go stale.
- **`stockKey()`.** Any stock publish must build its id through `master/src/domain/stock-key.ts` —
  `HANDOFF.md` names two call sites that once built the key inline with different separators, which
  surfaced as reservations silently reading as zero.
- `catalog.service.ts` is also where `ActorContext` and `actorUserId` used to live before the
  clean-architecture refactor; do not reintroduce anything actor-shaped into it.

### 5.20 `master/src/services/{role,user}.service.ts`

**Change.** `restoreRole` (`role.service.ts:257-289`) and `restoreUser` gain an optional `renameTo`,
and their `publishChange` action changes from `'updated'` to `'restored'` (`role.service.ts:288`).
`restoreUser` additionally checks that its `role_id` resolves to a **live** role before anything else.

**Why the action changes.** A restore is not an update. The Bin needs to distinguish them, and
`ChangeAction` gains `'restored'` for exactly this.

**Why `renameTo` is optional.** `restoreRole` currently calls `assertNameAvailable` (`:265-269`) and
throws `ConflictError` with `{ field, value }` when the name has been reused. That behaviour is
correct and stays; `renameTo` is what the client sends *after* seeing the conflict and the suggested
name in `details`. Omitting it preserves today's behaviour byte for byte.

**Why the user's role check.** `users.role_id` deliberately has **no SQL foreign key**
(`HANDOFF.md` decision 11), *"so a restored role reattaches to its users and a user-creating mutation
can arrive before its role does."* That flexibility means restoring a user whose role is still
deleted silently produces a user with no resolvable permissions. The check belongs in the service, in
the same transaction.

**Blast radius.** `master/tests/access.integration.test.ts`, `access-lockout.integration.test.ts` and
`permissions.integration.test.ts` all exercise these. The last-administrator guard must stay **inside
the transaction** — `HANDOFF.md`: *"Moving it out for tidiness lets two concurrent deactivations both
succeed and locks the company out of its own software."*

**Explicitly not changed:** `role.repository.ts` and `user.repository.ts`. `softDeleteRole` /
`restoreRole` / `softDeleteUser` / `restoreUser` are already correct for **non-syncable** entities —
roles and users carry no `hlc` or `field_hlc`, so a `version` bump with no clock movement is the right
shape for them and the wrong shape for the four entities in §5.17. **Do not "make them consistent".**

### 5.21 `master/src/services/sync.service.ts`

**Change.** An early rejection in `route()` when the target row's `deleted_at` is not null, recorded
into `applied_mutations` like any other refusal.

**Why.** With no delete/restore `MutationKind`s (§5.17), the merge engine cannot see a delete. A
queued offline edit arriving for a soft-deleted record must be refused explicitly rather than merged
into a tombstone.

**Blast radius.** `route()` is the entry point for every offline mutation from every panel.
`COLUMN_MAP` is module-private at `:79` and covers lead, order, party and product; `deleted_at` is
**not** added to it — a panel may not set it.

**Risk.**
- **A rejection here loses somebody's work.** The refusal must be recorded and must reach the panel
  as a rejection it can show, not a silent drop. `office/src/http/app.ts:157-163` surfaces
  `sync.recentRejections()`, so the path exists.
- The refusal inherits the known-open `applied_mutations` atomicity gap — the projection, the
  bookkeeping row and the id mapping open three separate transactions. **That is not this batch's
  problem to solve**, but the new rejection path must not make it worse by adding a fourth.
- `master/tests/sync.integration.test.ts` covers replay idempotency and field-level merge. Run it.

### 5.22 `master/src/services/dashboard.service.ts`

**Change.** Three things:

1. **Per-figure permission gating.** Each counter returns `undefined` when the actor lacks the key.
   The gate table is `04-API-CONTRACT.md` §7.1's — read it there. The two that were previously
   unclear are settled: `openConflictCount` and `pendingSyncCount` are gated on
   **`sync.resolveConflicts`** and are **optional**, not required-and-ungated. Sync health is still
   this installation's own business, but it is business — the number of unresolved conflicts tells a
   reader how much work is stuck, and a panel operator with no sync permission has no use for it and
   no way to act on it. Consistency is the deciding argument: every other figure is per-figure gated
   and absent when not held, and one ungated pair in the middle of that rule is the exception someone
   later cites to add a second.
2. **Three new figures**, plus `asOf`. `pipelineBreakdown`'s element is
   `{ stageId, stageName, sequence, colourHex, leadCount }` — again, `04-API-CONTRACT.md` §7.1.
3. **A layering fix.** `countRecentMutations` (`:46-56`) calls `db()('applied_mutations')` **directly
   in a service**. That is a live violation of the convention that Knex types never leave
   `repositories/`. It moves into a new `dashboard.repository.ts`, along with `leadCountsByStage` and
   `dispatchedThisWeek`.

**Why absent and not zero.** Same rule as rates, same reason. `HANDOFF.md` records the Office fix:
*"a hidden rate renders as `—` rather than a confident ₹0.00."* A count is no different.

**Why the counts are not computed client-side from the snapshot.** The snapshot is capped at
`SNAPSHOT_LIMIT = 500` (`snapshot.service.ts:30`) and `listLeads` excludes converted leads by default.
Counting in the browser would be **silently wrong at scale** — right on a small dataset, wrong on a
real one, with no signal in between. Online the panel gets a correct figure; offline it gets an
honestly-labelled stale one, which is what `asOf` is for.

**Blast radius.** `data.routes.ts:51-56`, `hub.ts:155`, `hub.ts:493-503`, and (newly)
`snapshot.service.ts`. Also `broadcastDashboard`, whose comment at `:483-486` already states the rule
this change formalises: *"a dashboard is permission-filtered, so pushing one to somebody whose account
or role has since changed would show them figures their current role does not entitle them to."*

**Risk.** Gating adds `actorCan` calls to a function currently called on **every** dashboard-moving
change for **every** connected socket. `actorCan` is a pure array lookup (`domain/actor.ts:35-37`), so
it is free; the queries behind it are not. Skip the query entirely when the permission is absent —
computing a figure and then dropping it is the obvious way to write this and the wrong one.

### 5.23 `master/src/services/snapshot.service.ts`

**Change.** Add `dashboardService.getDashboardSummary(actor)` to the second `Promise.all` batch and
include it as `dashboard` in the returned object.

**No second edit is needed to keep deleted options out of the panel.** `buildSnapshot` calls
`customFieldRepo.listOptions(actor.tenantId)` and `listDefinitions(actor.tenantId)` with no runner
and no filter override (`snapshot.service.ts:42-45`), so once `20260306` adds `deleted_at` and those
two functions (`custom-field.repository.ts:30-45`, `:56-71`) carry the standard
`.whereNull('deleted_at')` as their **default**, the snapshot inherits it for free and a soft-deleted
option can never reach a panel. The one thing that must not be skipped is the cache: both functions
memoise per tenant (`fieldCache`/`optionCache`, `:16-17`), so a delete that does not call
`invalidateFieldCache` (`:19-28`) leaves the removed value being served from memory until the process restarts.

**Blast radius.** Called from `hub.ts:175`, `:184` and `:208`. **The second `Promise.all` is exactly
the one §3.5 warns about** — adding a call that can reject for a permission reason has the same
consequence as gating the field reads. `getDashboardSummary` must return `undefined` figures for a
permission it lacks; it must **never throw** for one.

**Risk.** The header states the design constraint: *"Deliberately fat. This is not only a catch-up
payload — it is the panel's offline working set."* Every addition grows a payload sent on every
connect and every sign-in. A dashboard summary is a handful of integers; a pipeline breakdown is a
handful of rows. That is proportionate. Do not use this precedent to add a collection.

### 5.24 `master/src/services/storage.service.ts`

**Change.** Measure `config.documents.dir` and report it, either folded into `uploadsBytes` or as a
new `documentsBytes` field on `StorageUsage`.

**Why.** `document_exports` writes PDFs to disk with **no retention policy** — a known-open item
(`docs/BACKEND_MODULES.md` §8.3). The Storage screen is the only place an operator would ever notice.
Measuring it is not a retention policy, and must not be described as one.

**Blast radius.** `data.routes.ts:58-63` and the Master's Storage screen. Adding a field to
`StorageUsage` is additive; **folding it into `uploadsBytes` is not** — the header states the whole
point of the split: *"Reports the database cluster and the uploads folder separately so an operator
can tell which one is growing."* Prefer the new field.

**Risk.** `directorySize` (`:32-56`) is a recursive synchronous-ish walk with no depth or count bound.
It already walks the Postgres cluster, so the exports directory is not a new order of magnitude — but
it is a directory that grows without a policy, and this endpoint is on the Master's dashboard.

### 5.25 `master/src/services/panel-actor.service.ts`

**Change.** Populate `actorName` on **both** arms: from the resolved user's `displayName` when a token
is accepted (`:64-78`), and from the panel's own name when the actor falls back to
`actorType: 'office_panel'` (`:85-101`).

**Why both.** An unattended panel's action still has an actor — the machine. Leaving `actorName` null
there is defensible, but naming the panel is what makes the Logs screen readable, and it is the same
information `auth:signIn` already puts in the audit trail (`hub.ts:317-320`: *"§9 asks for the source
device on every entry"*).

**Blast radius.** This is the policy owner for whose authority an Office Panel command carries. It is
called from `hub.ts:419` on **every** panel command.

**Risk.** The file header states the invariant this batch must not weaken: the panel presents a
**token**, never an identity, and the Master re-reads the `roles` row every time. `actorName` is
derived on the Master from the resolved user — **never** read from anything the panel sent. A panel
that could name its own actor could name someone else's.

Note also the fallback at `:95-98`: a panel with no signed-in user gets the seeded Office-tier role.
This is why `fields.manage` at `management` still does not reach an unattended panel, and why the
locked decision states Fields editing plainly as management+ rather than arguing it is reachable from
both panels. Both panels can *read* fields; editing needs a person with a management role signed in.

---

## 6. `office/`

The Office path for all six modules is **forwarded live and fails hard offline** with 503
`{ error: 'unavailable' }`. **Nothing is queued into the outbox.** i18n is the sole exception — it
needs nothing from the Master.

> A queued render would emit a legally-shaped quotation hours later against a lead whose lines had
> since changed. A queued delete or field edit has the same character. This matches the roles/users
> precedent exactly: those are Master-online-only too.

### 6.1 `office/src/http/app.ts`

**Change.** Two things.

1. **~46 `forward()` routes** — one per command in `04-API-CONTRACT.md` §9.3, which owns the count;
   earlier drafts of this document estimated 25 and were wrong. Every one is registered **after**
   `app.use('/api', requireUser)` at
   `:133`. Every one is a `forward(res, '<event>', payload)` call and **not** a `queue()` call.
2. **`forward()` (`:438-462`) passes the new fields through** — `details` from the
   `MasterCommandError`, alongside the permission it already forwards, plus `messageKey`/`params`.

**Why the placement at line 133 is not stylistic.** The comment there says it: *"Placed as one gate
rather than repeated per route so a route added later cannot be forgotten — it is behind this by
construction."* A module route registered **above** line 133 is reachable by anybody with a browser
pointed at the panel's loopback port, with no signed-in person, and would act under the panel's own
office-tier role. The pairing and sign-in routes are above it deliberately, and they are the only
things that belong there.

**Why nothing queues.** `queue()` (`:318-375`) checks `MUTATION_PERMISSIONS[kind]` and writes to the
outbox. There is no mutation kind for any new module and there must not be one. `forward()` already
maps `MasterCommandError.unreachable` to 503 `{ error: 'unavailable' }` (`:443-446`), which is exactly
the honest answer.

**Change 3 — `forCurrentUser` (`:395-407`) must account for `SyncSnapshot.dashboard`.** Today it
re-masks `field.saleRate.view` across leads, orders, products and variants, and replaces
`permissions`. The new `dashboard` key must be re-derived for the current session or dropped.

**Blast radius.** `forCurrentUser` is called from `/api/snapshot` (`:154`) and from the SSE stream
(`:496`) — *"the same payload arriving by a different door."* Both.

**Risk.**
- **Every new `SyncSnapshot` key not handled in `forCurrentUser` is a silent leak.** The function's
  own header explains the case: the snapshot on disk was built for whoever was signed in when the
  link last worked. There is **no test today** asserting that every key is accounted for; §9.3 adds
  one, and it is the cheapest guard in the batch.
- **Do not widen the known-open module-filtering gap.** `forCurrentUser` filters on **one axis only**
  — rate masking. `/api/snapshot` and the SSE `snapshot` event still hand the browser every lead and
  order row regardless of whether the session holds `leads.view`. The tab is hidden; the data is not.
  That half is genuinely open and needs its own owner. **This batch must not make it wider**, which
  in practice means: no new module adds a bulk collection to `SyncSnapshot`.
- **Do not decide offline from an error message.** `forward()` branches on
  `error.unreachable` — the transport flag — and that is correct. `HANDOFF.md`: *"a Postgres
  'canceling statement due to statement timeout' is a message the Master sent, so it means refused,
  not silent."*
- **Export size.** A CSV or PDF returned through `forward()` arrives as one value in a single ack,
  buffered whole on both sides, through a **15-second timeout** (`master-connection.ts:242`). This is
  a known-open decision (`docs/BACKEND_MODULES.md` §8.2) — cap the Office-side export far lower,
  chunk it, or declare export Master-only. **It needs answering before the export endpoints ship.**

### 6.2 `office/src/realtime/master-connection.ts`

> ### ⚠ `applyChange` ignores `event.action` — and this batch is the first thing to emit `'deleted'`
>
> **File:** `office/src/realtime/master-connection.ts:353-382`
>
> ```ts
> private applyChange(event: DataChangedEvent): void {
>   if (!this.snapshot) return;
>   switch (event.entity) {
>     case 'lead':  this.snapshot.leads = upsert(this.snapshot.leads, event.payload as Lead); break;
>     …
>   }
> }
> ```
>
> The `action` field is never read. Every event **upserts**, whatever it says.
>
> That has been harmless until now, because the only two `publishChange` sites in the whole product
> that emit `action: 'deleted'` are `role.service.ts:247` and `user.service.ts:290`, and both `role`
> and `user` are in `DIRECTORY_ENTITIES` (`hub.ts:114`) so they never reach a panel at all. Verified
> by enumerating all 30 `publishChange` call sites: every other one emits `'created'` or `'updated'`.
>
> **The Recycle Bin is the first module to emit `'deleted'` for `lead`, `order`, `party` and
> `product` — entities that *do* reach panels.** With `applyChange` unchanged, soft-deleting a lead
> broadcasts the row and the panel **re-inserts it into its cached snapshot**. The record reappears on
> the panel's board, seconds after somebody deleted it, and stays until the next full snapshot.
>
> **Required change:** `applyChange` switches on `action` before entity — `'deleted'` removes,
> `'restored'` and `'created'` and `'updated'` upsert. For `'option_list'`, `'custom_field'` and
> `'pipeline'` it requests a fresh snapshot (`sync:request`) rather than patching in place, because
> those three are not stored as flat id-keyed lists.
>
> **Also in this file:** `MasterCommandError` (`:48-60`) gains `details`, `messageKey` and `params`,
> and the ack unwrapper at `:247-259` copies them off `CommandResult`. That is the Office half of the
> §2.5 prerequisite; without it, `forward()` has nothing to forward.
>
> **Do not touch** `reassume()` (`:314-341`) or the offline-fallback semantics. *"A rejection is
> final; only silence falls back"* is pinned by a test, and `HANDOFF.md` calls it *"the single
> easiest thing to get backwards here."*

### 6.3 `office/src/config/index.ts`

**Change.** Add a `locale: { defaultLocale }` block, matching the Master's key path and precedence
convention. **No timezone** — the Office has no database and computes no date buckets.

**Why the same key path.** One of the module designs put it at `config.ui.defaultLocale` on both
sides. Two panels with the same setting under two names is how they drift.

**Risk.** Low. Note the file's existing precedence rule (`:16-17`): the package-level `.env` is read
first and wins over the repo-root one, and a real environment variable beats both. A locale set at the
repo root configures both panels; a panel can still override.

---

## 7. The two web API clients

The only two files under `web/` this batch touches. Typed functions, no UI.

### 7.1 `master/web/src/api.ts`

**Change.** Typed wrappers for the new HTTP endpoints, and two additions to `ApiError`:

```ts
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
    readonly messageKey?: string,        // ← new
    readonly params?: Record<string, unknown>,   // ← new
  ) { super(message); }

  get missingPermission(): string | undefined { … }   // exists, :51-53
  get storedVersion(): number | undefined { … }       // exists, :60-62
  get diff(): Record<string, FieldDifference> { … }   // exists, :64-66

  /** Records that must be restored first, from the Bin's ConflictError. */
  get blockedBy(): unknown[] { … }                     // ← new
  /** The name the server offers when a restore collides. */
  get suggestion(): string | undefined { … }           // ← new
}
```

`request()` (`:69-95`) reads them off the parsed body beside `detail?.details ?? {}`.

**Why the getters.** The existing three are the pattern: structured facts arrive in `details` and are
read by name, so a screen never parses prose. `blockedBy` and `suggestion` are the Recycle Bin's
equivalents.

**Risk.** The comment at `:80-83` records the defect this shape fixed: the client used to read
`body.permission`, which the server never sent at the top level, *"so `missingPermission` was
permanently undefined and every branch on it was dead code."* Read from `details`, not from the top
level, for the new getters too.

**Explicitly not changed:** `deletedRoles`, `deletedUsers`, `restoreRole` and `restoreUser` stay.
One design proposed removing them in favour of unified Bin calls. `AccessScreen.tsx` still calls them
and this batch does not touch screens; removing them breaks the build for a rewrite that happens in
the UI phase.

### 7.2 `office/web/src/api.ts`

**Change.** Typed wrappers for the new local routes, **and a real error type**.

`request()` (`:87-100`) currently does this:

```ts
if (!response.ok) {
  throw new Error((body as { message?: string } | null)?.message ?? 'Request failed');
}
```

It throws a bare `Error`, discarding `error`, `details` and everything else the panel just took
trouble to forward. So the Office browser cannot distinguish 503 `unavailable` from a 403, cannot see
`blockedBy`, and cannot see a rename suggestion. **The whole §2.5 prerequisite chain terminates in
this line.**

Give it the same `ApiError` shape as the Master's client, with `code`, `details`, `messageKey` and
`params`, plus an `isUnavailable` getter for `code === 'unavailable'`.

**Why this matters more on the Office than on the Master.** The Office is the panel that can be
offline, and 503-vs-403 is the distinction that decides whether the UI says "the Master is not there"
or "the Master said no". `HANDOFF.md` records that this distinction was already fixed on the *server*
side of the panel; the browser side still collapses it.

**Blast radius.** Every existing screen in `office/web` catches `Error` and reads `.message`.
`ApiError extends Error`, so every existing catch keeps working unchanged.

**Risk.** Low, and the change is worth making now precisely because it is low: doing it in the UI
phase means doing it while also writing screens against it.

---

## 8. Build and tooling

### 8.1 `eslint.config.js`

**Change.** Register the in-repo flat-config plugin from `tools/eslint-rules/` and add the
`no-untranslated-jsx-text` rule — **as `'off'`**, scoped to `['{master,office}/web/src/**/*.tsx']`.

> ### ⚠ RULED: `no-untranslated-jsx-text` is registered as `'off'` in this batch
>
> This is decided for the whole set, not a preference of this document. Where another document
> schedules the rule as `'error'`, that scheduling is wrong.
>
> The rule flags JSX text nodes that are not wrapped in `t()` or `<Untranslated>`. **No screen is
> converted in this batch** (§0), so enabling it as `'error'` turns `npm run lint` red across roughly
> **4,000 unswept lines** of JSX — and `lint` is the **first step** of `npm run verify`, so nothing
> after it runs. Not one test executes. The failure is total, immediate, and has nothing to do with
> the code that caused it; the next person's reasonable response is to delete the rule.
>
> Register it now so the plugin wiring is proven and the rule is reviewable; **promote it to `'error'`
> in the UI phase, screen by screen**, when there is something for it to be right about. A rule that
> is registered and off is a rule someone can turn on in one line; a rule that was deleted because it
> broke the build is gone.

The current config (20 lines) is minimal: `js.configs.recommended`, `tseslint.configs.recommended`,
and two rules. The `varsIgnorePattern: '^_'` at `:14-16` is load-bearing —
`const { rate: _rate, ...rest } = record` is how a key is dropped from an object, which is the
redaction pattern the whole product depends on. **Do not narrow it.**

### 8.2 `package.json` (root)

**Change.** One script: `"i18n:sync": "node tools/i18n-sync.mjs"` — appends missing Hindi keys with
the English text and a `TODO` marker.

**Do not touch** `prepare`, `predev:*`, `prestart:*` or `pretest`. `HANDOFF.md` lists them under
Traps: *"`shared/` is consumed as compiled output, not source. Anything importing `@orderbook/shared`
fails on a clean checkout until `tsc` has run, which is why `prepare` and the `pre*` scripts exist.
Do not remove them."* The same applies to the `web/dist` builds.

`npm run verify` is currently **333 tests across 21 files**. This batch adds 23 suites (15 pure, 8
integration) plus one committed fixture, taking it to **44 files, ≈584 cases** — `10-TESTING.md` §8
is the sole register; do not restate the count here again. Update the number in `HANDOFF.md` when it
lands, and **check the suites actually ran** — `HANDOFF.md`: *"A skipped test suite looks exactly
like a passing one."*

### 8.3 `master/package.json`

**Change.** `dependencies` gain `pdfkit` and `fontkit`; `devDependencies` gain `@types/pdfkit`.

**Why these two and not a smaller library.** Devanagari is a **hard requirement** — party names,
addresses and terms in Hindi are unrenderable without it, and that eliminates the several popular PDF
libraries that ship WinAnsi encoding only. All four vendored faces are SIL OFL 1.1, which explicitly
permits PDF embedding; `master/assets/fonts/LICENSES.md` ships alongside so the vendored binaries are
auditable with no network access.

**Risk.**
- **Declare them by editing this file directly, then run `npm install`, then check the lockfile
  actually changed.** `HANDOFF.md` Traps: *"`npm install --save-optional --workspace` can record
  nothing while still placing files in `node_modules` — which is how the embedded-postgres dependency
  was once 'verified working' yet absent from the lockfile."*
- The install must work **with no internet at build time on the target machine**. Both packages are
  pure JavaScript with no native build step, so `npm 12`'s blocked install scripts are not a factor
  here — unlike the `@embedded-postgres/*` optional dependencies already in this file, which fetch
  binaries in a postinstall and fail silently. Do not follow that pattern.
- `master/tests/document-fonts.test.ts` runs fontkit's `layout()` against the vendored face directly.
  It is a **pure** suite so the Devanagari gate cannot silently skip. That is the point of it.

---

## 9. Tests that change

### 9.1 `master/tests/helpers/fixtures.ts`

**Change.** Two edits, both fiddly.

1. **`DATA_TABLES` (`:25-46`) gains the three document tables**, children before parents:
   `'document_exports'`, `'document_assets'`, `'document_templates'`. The array is ordered
   dependency-last already (`line_item_quantities` before `line_items` before `orders`), and although
   the `TRUNCATE … CASCADE` at `:77` makes strict ordering unnecessary, the ordering is documentation
   and should be preserved.
2. **Seeded field rows must survive the truncate.** The Fields module makes `option_lists` and
   `custom_field_definitions` writable. Neither table is in `DATA_TABLES` today — they are seeded
   configuration, like roles. Apply the **exact treatment the seeded roles already get** (`:55`,
   `:64-68`, `:89-92`): capture the migration-seeded ids once in `setupDatabase()`, and in
   `resetData()` delete only rows whose id is not in that set.

**Why.** The header states the rule: *"Truncating now has to preserve the rows the migrations seeded…
Those are configuration, not test data; wiping them would leave a database no code path can write to,
since every record needs a tenant and a stage."*

**Risk.**
- **Adding `option_lists` or `custom_field_definitions` to `DATA_TABLES` breaks every integration
  suite in the repository.** A lead needs a pipeline stage and a source-platform option; truncating
  either leaves a database no test can write to. The failures will look like unrelated validation
  errors.
- `resetData()` already calls all three cache invalidators (`:111-113`). If a new repository gains a
  cache, its invalidator goes here too, or *"a stale role would let a later test pass with permissions
  the database no longer grants"* — the exact comment at `:109-110`, one table over.
- `ALL_PERMISSIONS` (`:135-140`) spreads `PERMISSIONS`, so every new key is silently granted to every
  test actor. Permission tests must use `actorWith(...)` (`:157-163`) explicitly.

### 9.2 `master/tests/credential-invariants.test.ts`

See **§3.3**. Extend it only as a **second, separate** assertion against a new router; never
generalise the existing `- 2` into a loop.

### 9.3 New guards this batch owes

Three, all cheap, all closing a gap where nothing currently turns red:

| Guard | What it asserts | Why |
|---|---|---|
| Migration registry | Every file in `master/src/db/migrations/` is in the `migrations` array, and every entry's `name` equals its filename | Five files land at once against a hand-maintained array; a file not imported is a silent no-op |
| `forCurrentUser` completeness | Every key of `SyncSnapshot` is handled or explicitly listed as pass-through in `office/src/http/app.ts:395-407` | A newly added collection is a silent leak; there is no such test today |
| `toIsoDate` | Extends the **existing** `master/tests/mappers.test.ts`, which covers `toNumber`/`toIso`/`mapParty`/`mapProduct`/`mapLineItem`/`mapLead` but has **no** `toIsoDate` case | The IST day-shift fix at `mappers.ts:79-90` has never had a test |

All three are pure suites. `HANDOFF.md`: *"If a guard matters, check the suite actually ran, not just
that it was not red."*

---

## 10. Edit order

The tree must compile between steps, and two of these edits change signatures that everything else
depends on. Land them in this order.

**This is a file-level ordering, not a stage numbering.** `11-BUILD-SEQUENCE.md` owns the stage
sequence and it runs **Stage 0–8** (0 = the socket-ack `details` prerequisite, 1 = i18n foundation,
2 = Recycle Bin, 3 = Fields, 4 = Logs, 5 = Reports, 6 = PDF Designer, 7 = the permission grant
migration, 8 = Office Dashboard). Steps 1 below is Stage 0; steps 2–7 are Stage 1; steps 8–10 recur
inside every module stage after it. Nothing in this document uses the old 1–9 "build step" scheme.

| # | Edit | Why here |
|---:|---|---|
| 1 | `shared/src/protocol/socket.ts` `details` + `hub.ts respond()` + `master-connection.ts` + `office/src/http/app.ts forward()` | ~15 lines, no dependencies, unblocks two modules |
| 2 | **Answer §3.2**, then `master/src/lib/errors.ts` | `AppError`'s signature is a dependency of everything after it |
| 3 | `shared/src/domain/inputs.ts` — `CursorQuery` / `CursorPage<T>` | Four modules import it; minting it late means four merge conflicts |
| 4 | `master/src/domain/actor.ts` + the five construction sites | The compiler enumerates the sites; do it before there are 30 |
| 5 | `master/src/repositories/activity-log.repository.ts` signature + 24 call sites | Same reason, and it is **Stage 1** work by ruling (§3.1). Before any new module writes an audit entry |
| 6 | `master/src/config/index.ts` + `master/src/index.ts` validation | Everything date-shaped depends on the timezone being proven |
| 7 | `shared/src/domain/permissions.ts` + migration `20260309` | Land the key and its grant together, always |
| 8 | Repositories, then services, then routers, then the hub | The layering order. SQL, then orchestration, then transport |
| 9 | `office/src/realtime/master-connection.ts` `applyChange` | **Before** the first `'deleted'` event can be emitted (§6.2) |
| 10 | The two `api.ts` clients | Last. They are the exercise surface for everything above |

Steps 4 and 5 are the two that get cheaper the earlier they happen and more expensive every day they
do not.

---

## 11. Files deliberately not changed

| File | Why it stays |
|---|---|
| `shared/src/domain/visibility.ts` | `maskFields()` already deletes; the five helpers are entity-shaped and the new modules return different shapes (§2.5) |
| `master/src/domain/visibility.ts` | `canSeeRates` is exactly the predicate the new modules need; the key is `field.saleRate.view` |
| `master/src/domain/stock-key.ts` | The only place the composite key format is decided. Two inline copies once produced keys that never matched |
| `master/src/repositories/{role,user}.repository.ts` | `softDeleteRole`/`restoreRole` are correct for non-syncable entities and must **not** be made "consistent" with the four that carry `hlc` (§5.20) |
| `master/src/db/migrations/20260303000000_roles_and_users.ts` | Its live `allPermissions()` import is a real defect, and editing an applied migration is the more dangerous of the two rules to break. Decision recorded, left alone |
| The five colour columns and `stockKey()` | A colour's identity is the exact string it always was. That is what makes "removing a value never touches the records that used it" true rather than aspirational |
| `master/src/http/routes/access.routes.ts` beyond one argument | §3.3 |
| `GET /api/pipelines`, `/option-lists`, `/custom-fields` | §3.5 |
| `office/src/services/user-session.service.ts`, `sign-in-attempts.store.ts` | Offline sign-in semantics. *"A rejection is final; only silence falls back"* |
| Every screen file, both `App.tsx` files, `PermissionGrid.tsx`, `AccessScreen.tsx`, `main.tsx`, `format.ts`, `styles.css`, all of `{master,office}/web/src/i18n/`, `LocalePicker.tsx`, `Untranslated.tsx` | §0. The only web files this batch touches are the two `api.ts` clients |

---

## 12. Open questions this document cannot close

1. **§3.2 — is `messageKey` required on `AppError`?** 129 throw sites, but only **68** hand-written
   tokens — that second number is the one that sizes the work. The plan
   recommends *required*. **This blocks the batch and needs answering first.**
2. **§6.1 — how do CSV and PDF exports reach the Office Panel?** One value, one ack, a 15-second
   timeout. Cap far lower, chunk, or declare export Master-only. **Needs answering before the export
   endpoints ship.**
3. **§4.3 — the Master's dashboard screen renders `summary.leadCount` directly.** Making every
   `DashboardSummary` counter optional is correct and is a visible regression on that one screen until
   the UI phase renders the absent case as an em-dash. Accept it, or pull that one screen edit into
   this batch as a stated exception to §0.
4. **§5.24 — retention.** Measuring the exports directory is not a policy. `activity_log` has an
   append-only trigger that means a pruner cannot simply `DELETE`, and `document_exports` grows on
   disk with nothing watching it. Neither is designed, and neither is this batch's job — but somebody
   has to own them before the first year of data accumulates.
5. **Module-level filtering of the Office cached snapshot** remains open on the axis that is not
   `field.saleRate.view`. This batch must not widen it and adds a completeness guard (§9.3); closing
   it properly needs its own owner.
6. **Should `party_product_variants` be soft-deletable?** **OPEN, and it is this document's question**
   because the table already exists and this batch adds `deleted_at` to four of its neighbours. A
   variant row carries a **negotiated rate** for one party and one product. Deleting one today is a
   hard `DELETE`, which silently changes what the next line for that party quotes — the line does not
   fail, it just prices at the list rate, and nobody is told. Soft-deleting it would put it in the Bin
   and make the change reversible and visible. Against: it is a join row, it is syncable, and adding
   a seventh Bin entity in Stage 2 widens a surface this batch is trying to keep narrow. **Not
   decided. `RECYCLE_BIN_ENTITIES` ships without it** — `08-PERMISSIONS.md` owns the entity list and
   `03-DATABASE.md` its per-stage index staging.

**Questions this document once carried that are now decided elsewhere**, recorded so nobody re-opens
them from here:

| Was open in an earlier draft | Now |
|---|---|
| `option_lists.version` — optimistic concurrency or last-write-wins | **Decided.** `version INTEGER NOT NULL DEFAULT 1` on `option_lists` and `custom_field_definitions` in `20260306`; `expectedVersion` is mandatory on both `PUT`s, refusing a stale save with 409 and `storedVersion`. See `03-DATABASE.md` and `04-API-CONTRACT.md` |
| Deleting a lead that has been converted to an order | **Decided.** Refused, 409 — a converted lead is an order's history. `04-API-CONTRACT.md` holds the per-entity DELETE policy table |
| The top-parties report's date anchor | **Decided.** `orders.dispatched_at` — dispatched value in the period, not business won. See `03-DATABASE.md` |

**Three more are open but belong to other documents**, listed only so this one is not read as the
place they were dropped: mid-stream CSV failure semantics (an export that dies at row 180,000 has
already streamed 180,000 rows under a `200`); `QUIET_AFTER_DAYS = 30`, a placeholder needing the
owner's real number; and the Devanagari font fallback when a vendored face lacks a glyph. All three,
and the six above, are carried in `README.md` §8 and `11-BUILD-SEQUENCE.md` §2 alongside the document
that holds the detail.
