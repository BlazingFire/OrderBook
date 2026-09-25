# Permissions — the engine, the new keys, and where each one is enforced

Status: **specification.** Built since, apart from the PDF Designer, which was built and then removed (see the banner in `docs/BACKEND_MODULES.md`); the code is the truth now, so check a claim here against the tree before acting on it. This document owns every permission decision in the
batch: the eleven new keys, the nine existing keys that get their first enforcement site, the one
tier change, the single grant migration, and the endpoint-by-endpoint enforcement matrix.

Read `01-ARCHITECTURE.md` first. This document assumes its cross-cutting decisions and does not
restate them, except where a permission consequence follows from one.

The catalogue itself — `shared/src/domain/permissions.ts` — is the frozen list every layer imports.
Nothing in this document invents a key that is not added there, and nothing enforces a string that is
not in `PERMISSIONS` (`permissions.ts:130-133`), because a key absent from that list fails validation
on write (`master/src/domain/access.ts:49-52`) and is filtered out of any set that somehow holds it
(`master/src/repositories/role.repository.ts:144`).

---

## 1. How the permission engine works today

None of this is new work. It is stated because every decision later in the document is a consequence
of it, and because getting one of these wrong is the difference between a permission that protects
something and a checkbox that decorates a screen.

### 1.1 Three kinds of key, one flat namespace

`permissions.ts:9-13` names them, and the distinction is not cosmetic — it decides where a key is
declared, how the grid draws it, and what the i18n layer must translate.

| Kind | Example | Declared in | How the grid draws it |
|---|---|---|---|
| **Module action** | `leads.edit` | `MODULES` + `MODULE_ACTIONS` (`permissions.ts:41-74`) | A cell in the module × action matrix; an undeclared pair renders `—`, "not applicable" |
| **Capability** | `lead.convert`, `fields.manage` | `CAPABILITIES` (`permissions.ts:89-113`) | A checkbox tile inside its group (`workflow` / `pricing` / `stock` / `admin`) |
| **Field action** | `field.saleRate.view` | `CAPABILITIES`, and additionally `FIELD_PERMISSIONS` (`permissions.ts:144`) | A tile, with the absent-versus-null explanation attached (`PermissionGrid.tsx:204-209`) |

Module-action keys are **derived**, not listed: `moduleKeys()` (`permissions.ts:117-121`) flattens
`MODULE_ACTIONS`, so adding `documents: ['view','create','edit','delete']` mints four keys and puts
four cells on the grid with no other edit. That is why this batch adds two modules rather than eight
loose capabilities — and why adding a *new action verb* would be expensive: `ACTIONS`
(`permissions.ts:53`) is shared by every module row, so a `verify` action would render `—` in seven
other rows to serve one. Chain verification is therefore a capability, `logs.verifyChain`, not
`logs.verify`.

The field kind matters for a reason the catalogue header states plainly (`permissions.ts:14-17`): a
role without `field.saleRate.view` receives records with `rate` **absent**, not nulled. `maskFields()`
(`permissions.ts:300-312`) `delete`s the key and returns a copy. A null would say "this line has no
rate", which is a different and wrong statement, and one a client totals to zero.

### 1.2 The tier ceiling, and why `tier` is a CHECK

`ROLE_TIERS = ['office','management','admin']` (`permissions.ts:26`) is ordered, so "at or below my
own tier" is `tierRank` arithmetic rather than a lookup (`permissions.ts:35-37`). The column is a
`CHECK` constraint — `tier TEXT NOT NULL CHECK (tier IN ('admin','management','office'))`
(`20260301000000_tenancy_access_and_sync.ts:162`) — and `docs/ROLES_AND_USERS.md` §3.1 gives the
reason: three values fixed by the product, never company-configurable. A lookup table would imply
they can be added to, and they cannot, because the ceiling map in `permissions.ts` enumerates all
three by name. Contrast a lead's *stage* and a product's *category*, which **are** configurable and
therefore live in data — which is exactly what the Fields module manages.

`MINIMUM_TIER` (`permissions.ts:157-181`) records the **lowest** tier that may hold each key; a key
absent from the map is available to every tier. Two things follow, and both are load-bearing later:

- **The ceiling is not the grant.** It says who *may* hold a key, never who *does*. An admin-tier role
  holds nothing it was not given.
- **The ceiling filters upward only.** `keysAboveTier` (`permissions.ts:204-206`) removes keys the
  tier may not hold and adds nothing. So **lowering** a ceiling is free — no stored row changes
  meaning — while **raising** one silently disables stored keys and needs a repair migration to make
  disk match enforcement. `20260304000000_role_tier_ceiling_repair.ts` exists because that was
  discovered the hard way.

### 1.3 Permissions are one JSONB array on the role

`roles.permissions JSONB NOT NULL DEFAULT '[]'` (`20260303000000_roles_and_users.ts:65`), replacing
the `role_permissions` join table that this repository actually had until that migration dropped it
(`:78`). `docs/ROLES_AND_USERS.md` §5 carries the argument; the short form is that the join table's
per-key merge only became wrong once offline sync existed. Two administrators editing one role while
disconnected — one removing `stock.adjust`, the other adding `products.delete` — merge per key into a
**union granting a combination neither of them approved**. Permission sets are approved as a whole,
so they merge as a whole.

Storage rules, all enforced on write: always an array of strings; **sorted** before write so an
identical set is identical bytes and a reorder is not an edit; validated against the frozen catalogue;
within the tier ceiling.

For this batch the consequence is narrow and worth stating: **granting a new key to an existing role
is a rewrite of that role's array**, which is why there is one grant migration (§5) rather than five,
and why it unions rather than replaces.

### 1.4 `effectivePermissions` — the intersection, on every resolution

```ts
// shared/src/domain/permissions.ts:213-220
export function effectivePermissions(permissions, tier) {
  return [...new Set(permissions)]
    .filter((p) => isPermission(p) && isPermittedForTier(p, tier))
    .sort();
}
```

Two filters, both mandatory: the key must exist in today's catalogue, and it must be permitted for
the role's tier. `permissionSetForRole` (`role.repository.ts:107-149`) applies it on every resolution,
behind a small version-keyed cache (`:134-135`), so a key left in the database after being removed
from the code stops granting the moment the code changes — no data migration required.

That is the guarantee behind §5's grant policy: even a stored key nobody approved cannot be exercised
if the tier forbids it. It is not, however, a reason to store one — `20260304`'s header explains why
the *stored* row still has to match (an above-tier key renders checked-but-disabled, is resubmitted
on save, and then fails the whole save, which made both shipped non-admin roles uneditable).

### 1.5 Enforcement happens four times, and the fourth is the only one that always runs

| # | Where | What it does | Code |
|---|---|---|---|
| 1 | **On save** | `assertPermissionsWithinTier` rejects the *whole save* if any key is unknown or above the tier — never silently drops | `master/src/domain/access.ts:45-60` |
| 2 | **At sign-in** | The session's permission array is `effectivePermissions(...)` of the role, not the raw column | `master/src/services/auth.service.ts:124` |
| 3 | **At the route** | `requirePermissionMiddleware(key)` refuses before a transaction is opened | `master/src/http/middleware/require-auth.ts:65-73` |
| 4 | **In the service** | `requirePermission(actor, key)` throws `ForbiddenError` naming the key | `master/src/domain/actor.ts:46-48` |

Checking the ceiling at both (1) and (2) is not redundant — `permissions.ts:152-155` says why: a role
row that arrived over sync from a tampered replica carrying `users.manage` on an office tier is
stripped at sign-in and never enters the session. `resolveSession` re-reads the role's version on
every request and rebuilds the set in place when it moved (`auth.service.ts:164-172`), which is what
makes a revoked permission take effect on the next call rather than the next sign-in
(`docs/ROLES_AND_USERS.md` §13).

**Layer 3 exists only on the Master's HTTP path.** An Office Panel command arrives over Socket.IO and
never passes an Express router, so layer 4 is its only gate. That is the security-critical invariant
this whole document builds toward; it has its own section (§6.1).

### 1.6 The Administrator seed has no wildcard, deliberately

```ts
// shared/src/domain/permissions.ts:224-233
/**
 * There is no wildcard, deliberately. A wildcard would silently add every
 * permission the product ever gains to a role somebody approved before those
 * permissions existed.
 */
export function allPermissions(): Permission[] { return [...PERMISSIONS].sort(); }
```

This is the rule §5's grant policy obeys. Granting `recycleBin.view` to every existing role, as one
module design proposed, is the same act as a wildcard with extra steps: it adds a permission to a set
somebody approved before that permission existed. The seeded Administrator is the one role for which
"everything" is the reviewed answer, and even there the list is enumerated rather than starred.

`ROLE_TEMPLATES` (`permissions.ts:240-280`) are **templates, not seeded rows** — offered when creating
a role, never written by a migration, because a seeded role nobody reviewed is a permission set nobody
approved. This batch adds no template and changes neither existing one.

### 1.7 `labelToken` is served and not yet used

Every catalogue entry carries a translation token — `permission.<key>` on capabilities
(`permissions.ts:90-112`), `module.<module>` and `capabilityGroup.<group>` from
`buildPermissionCatalogue()` (`permissions.ts:335-353`) — with a comment that "the renderer never
hard-codes the English" (`permissions.ts:85-86`).

Honest current state: the renderer does hard-code it. `PermissionGrid.tsx:183` draws
`humanise(capability.key)`, `:88` draws the raw `module.key`, `:74` the raw action verb; `labelToken`
is sent and ignored. The contract is real and load-bearing — it is why the i18n module is cheap — but
until that module lands, **a new key's English label is derived from the key string itself**
(`PermissionGrid.tsx:211-216`: last segment de-camel-cased, prefixed by the earlier segments). So key
names must humanise sensibly: `logs.verifyChain` → "Logs verify chain", `recycleBin.viewAll` →
"RecycleBin view all". The second is the ugliest label in this batch and is accepted, because renaming
the key to satisfy a renderer that is about to be replaced would be the wrong trade.

Every new key in §2 therefore carries a `labelToken`, and the i18n module's coverage test
(`shared/tests/i18n-coverage.test.ts`, `docs/BACKEND_MODULES.md` §4.5) is what makes it load-bearing:
every key in `PERMISSIONS` must have a `permission.<key>` token, and `hi.ts` is a **total**
`Record<MessageKey, string>`, so an untranslated new key turns the build red rather than shipping
English into a Hindi UI.

---

## 2. The new keys

Eleven keys. Five module actions across two new modules, six capabilities. Every one is added to
`shared/src/domain/permissions.ts` and to nothing else — there is no second list.

| Key | Kind | Module / group | `labelToken` | Minimum tier | What it actually gates |
|---|---|---|---|---|---|
| `logs.view` | module action | `logs` | `module.logs` | office | The audit-trail feed and its facets: `GET /api/logs`, `GET /api/logs/facets` |
| `logs.export` | module action | `logs` | `module.logs` | office | The CSV route only — a separate handler, not a `format=csv` flag, so the key gates a distinct code path |
| `logs.verifyChain` | capability | `admin` | `permission.logs.verifyChain` | office | `POST /api/logs/verify` — re-walking and re-computing the hash chain in SQL |
| `recycleBin.view` | capability | `admin` | `permission.recycleBin.view` | office | The Bin feed and counts, **scoped to records you deleted**, further intersected with the per-entity delete keys you hold |
| `recycleBin.viewAll` | capability | `admin` | `permission.recycleBin.viewAll` | **management** | Lifts the `deleted_by = me` restriction so the Bin shows everyone's deletions |
| `fields.view` | capability | `admin` | `permission.fields.view` | office | The Fields **management read** surface (`GET /api/fields/*`) only. It does not gate the three existing reads the Add Lead form and the panel snapshot depend on (§3.2) |
| `documents.view` | module action | `documents` | `module.documents` | office | Template list and detail, asset files, export history and stored PDFs |
| `documents.create` | module action | `documents` | `module.documents` | office | Creating a template |
| `documents.edit` | module action | `documents` | `module.documents` | office | Editing a template; uploading its logo or signature asset |
| `documents.delete` | module action | `documents` | `module.documents` | **management** | Soft-deleting **and restoring** a template — matching `leads.delete` / `parties.delete` / `products.delete` |
| `documents.render` | capability | `workflow` | `permission.documents.render` | office | Rendering or previewing a PDF — **always alongside the subject's own view key** (§6.3) |

### 2.1 The catalogue diff

```ts
// shared/src/domain/permissions.ts

export const MODULES = [
  'leads', 'orders', 'parties', 'products', 'inventory', 'reports', 'roles',
  'logs',       // NEW
  'documents',  // NEW
] as const;

export const MODULE_ACTIONS: Record<PermissionModule, readonly PermissionAction[]> = {
  // … unchanged rows …
  logs:      ['view', 'export'],                     // NEW — no create/edit/delete: the trail is
                                                     // append-only and the triggers refuse both
  documents: ['view', 'create', 'edit', 'delete'],   // NEW — no export/bulk: rendering is a
                                                     // capability, and there is no bulk surface
};

export const CAPABILITIES: readonly CapabilityDefinition[] = [
  // … unchanged entries …
  { key: 'documents.render',  group: 'workflow', labelToken: 'permission.documents.render' },
  { key: 'logs.verifyChain',  group: 'admin',    labelToken: 'permission.logs.verifyChain' },
  { key: 'recycleBin.view',   group: 'admin',    labelToken: 'permission.recycleBin.view' },
  { key: 'recycleBin.viewAll',group: 'admin',    labelToken: 'permission.recycleBin.viewAll' },
  { key: 'fields.view',       group: 'admin',    labelToken: 'permission.fields.view' },
] as const;

const MINIMUM_TIER: Record<string, RoleTier> = {
  // … unchanged entries …
  'fields.manage': 'management',      // CHANGED from 'admin' — see §4
  'documents.delete': 'management',   // NEW — matches the other *.delete keys
  'recycleBin.viewAll': 'management', // NEW
};
```

No new `CAPABILITY_GROUPS` member. `documents.render` joins `workflow` beside `lead.convert` and
`orders.dispatch` because it is an act performed on a record, not an administrative setting; the other
four join `admin` beside `fields.manage` and `settings.manage` because they govern how the product
itself is configured or inspected. Minting a sixth group to hold five tiles would add a heading and no
meaning.

### 2.2 Consequences of adding two modules

- `PERMISSIONS` gains six entries automatically (four `documents.*`, two `logs.*`) through
  `moduleKeys()`, and therefore so does `allPermissions()`.
- `buildPermissionCatalogue().modules` gains two rows, so the grid draws them with no UI edit — which
  is the property `permissions.ts:19-21` claims and this batch is the first real test of. The `logs`
  row shows `—` in four columns and `documents` in two; that is the intended "not applicable"
  statement, not a gap.
- **`allPermissions()` is imported live by an applied migration** (`20260303000000_roles_and_users.ts:21`,
  spent at `:331`). Adding these keys therefore changes what that migration does *on a fresh install* —
  a fresh Administrator role comes out already holding them. That is the defect §5.3 records a decision
  about; it makes the grant migration a no-op on fresh installs and the actual grant on the owner's
  database, and the union makes both outcomes identical.
- `docs/ROLES_AND_USERS.md` §5 describes the catalogue as it stood after `20260303`. When this batch
  lands, that section and its §16 "not built" list need updating — the translation layer and the
  cross-entity Recycle Bin both move out of it.

### 2.3 Why `recycleBin.view` sits at the office ceiling even though it can show an office user nothing

Worth stating because it looks like an error. Every entity the Bin can restore is gated by a key at
`management` or above: the four `*.delete` keys are management, `roles.delete` and `users.manage` are
admin, `documents.delete` is management, and Fields values are restored under `fields.manage`
(management after §4). An office-tier role holding `recycleBin.view` therefore sees an **empty Bin**,
always — the service filters the feed to the entity types whose delete key the actor holds (§6.4).

That is accepted rather than fixed, for one reason: **ceilings are cheap to lower and expensive to
raise** (§1.2). Minting `recycleBin.view` at `office` and later raising it costs a `20260304`-style
repair migration; minting it at `management` and later lowering it costs nothing. The reversible
choice is the lower ceiling, and the emptiness is a UI concern the Bin screen can state honestly
("nothing you deleted is here") rather than a security one.

It is listed in §8 as a question the owner may close the other way.

---

## 3. Reused keys, and the first enforcement site each one gets

Nine existing keys. Seven of them are, today, controls that change nothing — they are in the frozen
catalogue, they render as grid cells or tiles, an administrator can untick them, and no code path
reads them. `HANDOFF.md`'s rule is blunt about what that is worth:

> **A permission that enforces nothing is worse than a missing one.** It renders as a control, an
> administrator unticks it believing something changed, and nothing does. Either wire it up or delete
> it from the catalogue.

This batch is where seven of them stop being decoration. That is a stated deliverable, not a
side effect — the same defect was found and fixed for `field.saleRate.edit` in the audit's second wave
(`master/src/domain/visibility.ts:30-45`), and these are the remaining instances.

| Key | Tier | Enforced anywhere today | First enforcement site this batch gives it |
|---|---|---|---|
| `reports.view` | office | **No** — grep finds it only in the catalogue and the templates | `GET /api/reports/dispatches`, `/lead-outcomes`, `/top-parties` and their socket commands |
| `reports.export` | office | **No** | `GET /api/reports/:report/export`. Deliberately **not** reused for PDF rendering — overloading it would make unticking one silently disable the other |
| `leads.delete` | management | **No** — there is no delete path for a lead | `DELETE /api/leads/:id` |
| `orders.delete` | management | **No** | `DELETE /api/orders/:id` (which also releases the order's live stock reservations in the same transaction) |
| `parties.delete` | management | **No** | `DELETE /api/parties/:id` |
| `products.delete` | management | **No** | `DELETE /api/products/:id` |
| `field.saleRate.view` | office | **Yes** — `canSeeRates` (`visibility.ts:26-28`), across every read path including search | Extended, not introduced: money columns in Reports, and rate columns in a rendered PDF |
| `roles.delete` | admin | **Yes** — `role.service.ts:205` (delete) and `:258` (restore) | Extended: the same key governs the role rows appearing in the cross-entity Bin |
| `users.manage` | admin | **Yes** — eight sites in `user.service.ts` | Extended: the same key governs user rows in the Bin |

Two rules this table encodes, both worth keeping:

- **Restore reuses the entity's own delete key.** `RESTORE_PERMISSION[entityType]` maps to
  `leads.delete`, `orders.delete`, `parties.delete`, `products.delete`, `roles.delete`, `users.manage`,
  `documents.delete`, `fields.manage`. No `recycleBin.restore` key is minted, and there is no purge at
  all. This follows the existing precedent exactly — `restoreRole` is already gated by `roles.delete`
  (`role.service.ts:258`) — and it makes restore structurally incapable of being a back door onto an
  entity you may not delete.
- **`field.saleRate.view` is the rate key.** The PDF brief called it `products.rate.view`; that string
  does not exist in the catalogue and would fail `isPermission` on write. There is exactly one rate
  key and it already has a masking helper.

### 3.1 What "first enforcement site" obliges

For each of these, the acceptance bar is the same as for a new key: a route guard, a service check,
and a test that proves refusal names the key. A key that gains an endpoint but no service check has
not been wired up — it has been moved from enforcing nothing to enforcing nothing over Socket.IO.

### 3.2 What deliberately stays ungated

`GET /api/pipelines`, `GET /api/option-lists` and `GET /api/custom-fields`
(`master/src/http/routes/data.routes.ts`) keep `requireAuth` and gain no `fields.view` check. The
reason is mechanical, not philosophical: `buildSnapshot` reads those three inside a `Promise.all`, and
a rejected `buildSnapshot` produces **no snapshot at all**, swallowed into a log line. Gating them
would lock a user out of the entire Office Panel over a key that governs a management screen. The new
`/api/fields/*` surface is separate and is where `fields.view` applies.

`GET /api/access/permission-catalogue` also stays ungated (`access.routes.ts:40-42`) — it is static
product configuration, not company data, and `credential-invariants.test.ts:84-88` accounts for it
explicitly in its guard-count assertion.

**The locale picker is ungated, and that is a ruling, not an oversight.** Choosing the interface
language mints **no permission key at all** — not `settings.manage`, not a new `locale.set`, nothing.
The reasoning is the same shape as the `/me/password` exception the guard-count comment already
records: `settings.manage` sits at tier `admin` (`permissions.ts:162`), so gating the picker behind it
would mean an **office-tier user could never read their own screen in Hindi**, which inverts the
entire purpose of the i18n module. A permission that stops somebody reading the language they read is
not access control.

It is also, mechanically, not a server decision. Locale is per-machine and never synced: the
catalogues are compiled into each panel's bundle, the picker writes `localStorage`, and switching
languages makes **no server call at all** — it works with the Master switched off. There is no request
to guard. The only server involvement is `defaultLocale` on `/api/auth/me` and the Office's
`/api/session`, which seeds a fresh browser profile; the Office's `/api/session` is registered
**before** the `requireUser` gate at `office/src/http/app.ts:133` precisely so the sign-in screen
renders in the right language before anybody has signed in.

This is the one surface in the batch that is deliberately ungated for the user's own benefit rather
than for a mechanical reason, and `07-UI-SPEC.md` §10.2 states the same rule from the UI side. The
picker component itself is a UI-phase file and is not written in this batch; the permission decision
is settled now so the UI phase does not re-open it.

---

## 4. `fields.manage`: `admin` → `management`

**The change:** `MINIMUM_TIER['fields.manage']` moves from `'admin'` (`permissions.ts:163`) to
`'management'`.

**Why it is safe:** lowering a ceiling never strips a stored key. `keysAboveTier` and
`effectivePermissions` filter upward only (`permissions.ts:204-220`), so every role that holds
`fields.manage` today keeps it, and a management-tier role that did not hold it still does not — the
ceiling permits, it does not grant. No repair migration is needed. This is the exact inverse of the
`20260304` situation, which was a *raise* in effect and required rewriting stored rows.

**Why it was proposed:** the Fields design argued that at `admin`, no Office Panel user below admin
could ever hold it, contradicting the owner's decision that Fields is reachable from both panels.

**Why that argument does not survive on its own, and the critique is right.** An unattended Office
Panel falls back to the seeded **office**-tier role (`panel.service.ts:176-183`), so at `management`
the stated goal is still unmet by its own reasoning. Lowering the ceiling one step does not make the
key reachable by an office-tier panel; it makes it reachable by a management-tier *person* signed in
on a panel, which is a different claim.

**The resolution, stated plainly rather than left implied:**

> **Fields reading is available to every tier; Fields editing is management or above, on both panels.**

Concretely: `fields.view` is minted with no `MINIMUM_TIER` entry, so any tier may hold it and both
panels can render the Fields screen read-only. `fields.manage` sits at `management`, so editing a
value set, a custom-field definition or a pipeline stage requires a person of at least management tier
signed in — on either panel. An unattended panel can read the field catalogue and cannot change it.

That is defensible on its own merits and does not need the reachability argument: renaming a pipeline
stage reorders every Kanban board in the company, and removing an option-list value changes what every
picker in both panels offers. It is a company-configuration act, not a desk act. `docs/BACKEND_MODULES.md`
§10 question 4 asks the owner to confirm exactly this, and it remains open until they do — but the
specification is written to `management`, not to "every user".

---

## 5. The grant migration — `20260309000000_new_module_permission_grant`

One migration, last in the batch, granting every new key to `tier = 'admin'` only.

Three module designs each wrote their own grant migration with three different policies, and one of
them granted the new keys to **every existing role**. That is the act §1.6's no-wildcard rule exists to
prevent. Consolidating to one migration also removes a subtler hazard: three separate rewrites of the
same JSONB array, each reading what the previous one wrote, is three chances to lose a key to a
last-writer-wins update.

### 5.1 Policy

| Question | Answer | Why |
|---|---|---|
| Which roles? | `tier = 'admin'` only, across every tenant | The seeded Administrator is the one role for which "everything" is the reviewed answer. Every other role gets keys from an administrator using the grid |
| Union or replace? | **Union**, then sort | Converges on both a fresh install (where `20260303`'s live import already granted them) and the owner's already-migrated database (where it did not). Replacing would discard whatever else that role holds |
| Where do the key strings come from? | **Inlined and frozen** in the migration file | Importing from `@orderbook/shared` is the `20260301` defect: editing the live catalogue retroactively changes what an applied migration did. A migration is a fixed historical fact, not a view of today's code |
| Soft-deleted admin roles too? | **Yes** | A role restored after this migration would otherwise come back missing keys, with nothing to explain why. The Bin makes restore a real path now |
| Non-admin roles? | **Nothing** | Deliberate. See §1.6 |
| How is "already granted" detected? | `NEW_KEYS.every((key) => stored.includes(key))` — **never a length comparison** | See the box below. This is the ruled form and `11-BUILD-SEQUENCE.md` conforms to it |
| `down()`? | Empty, with a justifying comment | `Migration.down` is a required member (`migrations/index.ts:27`). Revoking is not the inverse of granting: a key an administrator added through the grid after this ran would be removed by a rollback that never granted it |

> **The no-op test is `NEW_KEYS.every((key) => stored.includes(key))`, and a length comparison is a
> defect.** `stored` is a JSONB array. Nothing in the database enforces that it holds no duplicate —
> the sort-and-validate rules in §1.3 are application-level, and a row that arrived over sync from an
> older replica, or was hand-edited, can carry `['leads.view', 'leads.view', …]`. Compare
> `merged.length === stored.length` and that row reads as "no change needed" and is **skipped —
> while still missing every key this migration exists to grant**. It is the quietest possible
> failure: the migration reports success, the role silently lacks the keys, and the symptom surfaces
> weeks later as an administrator who cannot open the Logs screen.
>
> The inverse is also true and is why `20260304` is not a counterexample: that migration *filters*,
> so a shorter result genuinely means something was removed, and a length comparison is the correct
> test there. A *union* can shorten an array. A *filter* cannot lengthen one. The test must match the
> operation, and here the operation is a union.
>
> This is the ruled form for the batch. `11-BUILD-SEQUENCE.md` previously described a length
> comparison; it now conforms to this.

### 5.2 Shape

```ts
/**
 * Grant this batch's new permission keys to administrator-tier roles.
 *
 * Union, not replace, so this converges on a fresh install (where 20260303's
 * live allPermissions() import already granted them) and on an installation
 * migrated before these keys existed (where it did not).
 *
 * Administrator tier only. Handing every existing role a new capability is the
 * act the no-wildcard rule at shared/src/domain/permissions.ts:224-231 exists to
 * prevent — "a permission the product gains, added to a role somebody approved
 * before it existed". Non-admin roles receive these keys from an administrator
 * who chooses them in the grid.
 *
 * The key list is INLINED AND FROZEN as of 2026-08-24, never imported from
 * @orderbook/shared. That import is the 20260301 defect: editing the live
 * catalogue would retroactively change what this migration had already done.
 */
import type { Knex } from 'knex';

const NEW_KEYS = [
  'documents.create',
  'documents.delete',
  'documents.edit',
  'documents.render',
  'documents.view',
  'fields.view',
  'logs.export',
  'logs.verifyChain',
  'logs.view',
  'recycleBin.view',
  'recycleBin.viewAll',
] as const;

interface RoleRow { id: string; tenant_id: string; permissions: unknown }

export async function up(knex: Knex): Promise<void> {
  // No tenant filter and no deleted_at filter: every administrator role in the
  // database, including soft-deleted ones, which can be restored later.
  const roles = await knex<RoleRow>('roles')
    .where({ tier: 'admin' })
    .select('id', 'tenant_id', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    // The no-op test is "already holds every new key", not a length comparison:
    // a union can shorten an array that happened to contain a duplicate, so
    // comparing lengths (as 20260304 legitimately does for a *filter*) would
    // rewrite rows that need no change and skip rows that do.
    if (NEW_KEYS.every((key) => stored.includes(key))) continue;

    const merged = [...new Set([...stored, ...NEW_KEYS])].sort();

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(merged) });
  }
}

export async function down(): Promise<void> {
  // Deliberately empty. Revoking is not the inverse of granting: by the time a
  // rollback runs, an administrator may have granted these keys to other roles
  // through the grid, and this migration has no way to tell its own grant from
  // theirs. Leaving the keys costs nothing — a key whose module no longer exists
  // is filtered out by effectivePermissions on every resolution.
}
```

Registry entry, appended last (`master/src/db/migrations/index.ts`):

```ts
import * as newModulePermissionGrant from './20260309000000_new_module_permission_grant.js';
// …
{ name: '20260309000000_new_module_permission_grant', ...newModulePermissionGrant },
```

The `name` string must equal the filename minus `.ts`. The registry is hand-maintained and does not
scan the directory, so a file written but not imported is a silent no-op — which is why the batch adds
a migration registry guard test before the first new migration lands.

### 5.3 The recorded decision about `20260303`'s live import

`20260303000000_roles_and_users.ts:21` does `import { allPermissions } from '@orderbook/shared'` and
spends it at `:331` to set the Administrator role's permissions. That is live, and it is exactly what
the registry header and `HANDOFF.md`'s trap list forbid. But the same header also forbids editing an
applied migration. Both rules cannot hold at once.

**Decision: leave it.** Two reasons.

1. The union-based grant migration makes the outcome correct on every installation regardless. On a
   fresh install the import has already granted the new keys and `20260309` is a no-op; on the owner's
   database it has not and `20260309` performs the grant. The two paths converge.
2. Editing an applied migration is the more dangerous rule to break. It changes history on machines
   that already ran it, and Knex's checksum-free registry gives no warning.

This is `docs/BACKEND_MODULES.md` §10 question 2 and belongs in `HANDOFF.md` once accepted, so it is
not rediscovered as a bug a third time.

---

## 6. The enforcement matrix

Every endpoint this batch adds, with **both** gates named. The convention throughout: the Master's
Express route carries `needs('<key>')` — the local alias for `requirePermissionMiddleware`
(`access.routes.ts:36`) — and the service's first statement is `requirePermission(actor, '<key>')`.
Every new router copies `access.routes.ts`, the only existing router that mounts the middleware.

### 6.1 The invariant: the socket path bypasses route middleware entirely

**This is the security-critical statement in this document.** An Office Panel command does not travel
through Express. It arrives on the Socket.IO link, is dispatched by `registerCommands`
(`hub.ts:204-206`), and calls the same service function the Master's HTTP route calls:

```ts
// master/src/realtime/hub.ts:205-206
const run = <T>(ack: CommandAck<T>, operation: (actor: ActorContext) => Promise<T>): void =>
  respond(ack, async () => operation(await actorFor()));
```

There is no router, no middleware chain, and no `needs(...)`. **The service-level `requirePermission`
is the only gate an Office command passes.** Four consequences follow, and every module in this batch
depends on all four:

1. **A service check is mandatory, never optional.** An endpoint whose permission lives only in route
   middleware is unguarded for every Office Panel user. The route guard is an optimisation — it
   refuses a doomed request before a transaction opens (`require-auth.ts:58-63`) — not the guarantee.
2. **The Office server cannot enforce anything, and must not pretend to.** It has no database, no
   `roles` table and no `permissionSetForRole`. Its routes are `forward(res, '<event>', payload)` after
   the positional `app.use('/api', requireUser)` gate (`office/src/http/app.ts:133`), and `requireUser`
   only asserts that *somebody* is signed in (`app.ts:417-424`). Whether that person may perform the
   command is decided on the Master, per command.
3. **The actor is resolved per command, never captured at connect time** (`hub.ts:196-203`,
   `panel-actor.service.ts:53-100`). A socket outlives sign-ins, sign-outs and role edits. The panel
   presents a Master-issued token, never an identity, and the Master re-reads the `roles` row every
   time — which is what makes a revoked permission apply to the next command rather than the next
   reconnect.
4. **A refusal must arrive as a refusal.** `respond()` sets `missingPermission` for a `ForbiddenError`
   (`hub.ts:398-400`), `MasterCommandError` carries it, and `forward()` maps `code === 'forbidden'` to
   403 with `details.permission` (`office/src/http/app.ts:448-459`). Without the socket-ack `details`
   prerequisite — **Stage 0** in `11-BUILD-SEQUENCE.md`, built before anything else in the batch —
   everything that is not a `ForbiddenError` reaches the Office browser as a bare 502 with an English
   string. That is why it is Stage 0 and not a later cleanup.

A proposed gate: extend the source-reading invariant test that already exists for this exact class of
mistake. `master/tests/credential-invariants.test.ts:73-89` asserts
`guards.length === handlers.length - 2` for `access.routes.ts`; the analogous assertion for each new
router (`log.routes.ts`, `report.routes.ts`, `recycle-bin.routes.ts`, `fields.routes.ts`,
`document.routes.ts`) plus one asserting that every service function reachable from
`registerCommands` opens with a `requirePermission` call would make the invariant greppable rather
than remembered. Pure suites, no `describe.skipIf`.

### 6.2 Logs and Reports

| Master endpoint | Route guard | Service check | Socket command | Additional |
|---|---|---|---|---|
| `GET /api/logs` | `needs('logs.view')` | `requirePermission(actor,'logs.view')` | `log:list` | — |
| `GET /api/logs/facets` | `needs('logs.view')` | `requirePermission(actor,'logs.view')` | `log:facets` | — |
| `POST /api/logs/verify` | `needs('logs.verifyChain')` | `requirePermission(actor,'logs.verifyChain')` | `log:verifyChain` | Writes an audit entry with `recordActivity(entry, actor, trx)` — the three-argument form, landed in Stage 1 |
| `GET /api/logs/export` | `needs('logs.export')` | `requirePermission(actor,'logs.export')` | `log:export` | Separate handler from the list, so the key gates a distinct path |
| `GET /api/reports/dispatches` | `needs('reports.view')` | `requirePermission(actor,'reports.view')` | `report:dispatches` | Money keys **absent** unless `canSeeRates(actor)` |
| `GET /api/reports/lead-outcomes` | `needs('reports.view')` | `requirePermission(actor,'reports.view')` | `report:leadOutcomes` | No money columns |
| `GET /api/reports/top-parties` | `needs('reports.view')` | `requirePermission(actor,'reports.view')` | `report:topParties` | Money keys absent without `field.saleRate.view`; the response carries `orderedBy` because a rate-blind caller is ordered by `orderCount` |
| `GET /api/reports/:report/export` | `needs('reports.export')` | `requirePermission(actor,'reports.export')` | `report:export` | Redaction applies to the CSV identically — a redacted column is absent from the header row, not blank |

### 6.3 Documents

| Master endpoint | Route guard | Service check | Socket command | Additional |
|---|---|---|---|---|
| `GET /api/documents/templates` | `needs('documents.view')` | `requirePermission(actor,'documents.view')` | `document:listTemplates` | — |
| `GET /api/documents/templates/:id` | `needs('documents.view')` | same | `document:getTemplate` | — |
| `POST /api/documents/templates` | `needs('documents.create')` | `requirePermission(actor,'documents.create')` | `document:createTemplate` | Duplicate name → 409 with `{field:'name', value}` |
| `PUT /api/documents/templates/:id` | `needs('documents.edit')` | `requirePermission(actor,'documents.edit')` | `document:updateTemplate` | `expectedVersion` mandatory |
| `DELETE /api/documents/templates/:id` | `needs('documents.delete')` | `requirePermission(actor,'documents.delete')` | `document:deleteTemplate` | Soft delete; `expectedVersion` mandatory |
| `POST /api/documents/templates/:id/restore` | `needs('documents.delete')` | `requirePermission(actor,'documents.delete')` | `document:restoreTemplate` | Restore reuses the delete key (§3) |
| `POST /api/documents/assets` | `needs('documents.edit')` | `requirePermission(actor,'documents.edit')` | `document:uploadAsset` | — |
| `GET /api/documents/assets/:id/file` | `needs('documents.view')` | `requirePermission(actor,'documents.view')` | `document:assetFile` | Path resolved from config + `storage_key`, never from a client string |
| `POST /api/documents/render` | `needs('documents.render')` | `requirePermission(actor,'documents.render')` **and** `requirePermission(actor, subjectKind === 'lead' ? 'leads.view' : 'orders.view')` | `document:render` | Rate columns absent unless `canSeeRates(actor)`; `rates_included` recorded on the export row |
| `POST /api/documents/preview` | `needs('documents.render')` | same pair | `document:preview` | Nothing persisted; watermark forced |
| `GET /api/documents/exports` | `needs('documents.view')` | `requirePermission(actor,'documents.view')` | `document:listExports` | Rows whose subject the caller may not view are **filtered out**, not refused — the `search.service.ts:59` pattern |
| `GET /api/documents/exports/:id` | `needs('documents.view')` | `documents.view` + the subject's view key | `document:getExport` | 404 for another tenant's id, never 403 — a 403 confirms the id exists |
| `GET /api/documents/exports/:id/file` | `needs('documents.view')` | `documents.view` + the subject's view key | `document:exportFile` | Re-checks permission and tenant on every download |

Thirteen rows, matching `04-API-CONTRACT.md` §9.3's PDF Designer block exactly. An earlier draft of
this table carried a fourteenth row for `GET /api/dashboard`; that was a misfiling — the Dashboard is
not a Documents endpoint and has nothing to do with `documents.*`. It has its own subsection, §6.6.

**Two view keys, never one.** Rendering requires `documents.render` *and* the subject's own view key,
so document access can never exceed record access. Without the second check, `documents.render` would
be a way to read a lead you may not open, formatted as a PDF.

### 6.4 Recycle Bin

| Master endpoint | Route guard | Service check | Socket command | Additional |
|---|---|---|---|---|
| `GET /api/recycle-bin` | `needs('recycleBin.view')` | `requirePermission(actor,'recycleBin.view')`, then filter to entity types whose delete key the actor holds, then narrow to `deleted_by = actor.userId` unless the actor also holds `recycleBin.viewAll` | `recycleBin:list` | Three-stage narrowing, in that order |
| `GET /api/recycle-bin/counts` | `needs('recycleBin.view')` | Same three stages | `recycleBin:counts` | Counted only over branches the caller may see, so the chips and the list agree |
| `POST /api/recycle-bin/restore` | `needs('recycleBin.view')` | `requirePermission(actor, RESTORE_PERMISSION[entityType])` — the entity's own delete key | `recycleBin:restore` | The route guard is the weaker of the two here **by design**: the entity type is in the body, so only the service can know which key applies |
| `DELETE /api/leads/:id` | `needs('leads.delete')` | `requirePermission(actor,'leads.delete')` | `lead:delete` | First enforcement site for the key |
| `DELETE /api/orders/:id` | `needs('orders.delete')` | `requirePermission(actor,'orders.delete')` | `order:delete` | Also releases live reservations in the same transaction |
| `DELETE /api/parties/:id` | `needs('parties.delete')` | `requirePermission(actor,'parties.delete')` | `party:delete` | — |
| `DELETE /api/products/:id` | `needs('products.delete')` | `requirePermission(actor,'products.delete')` | `product:delete` | — |

**The restore route is the one place the two layers are deliberately asymmetric.** Express middleware
runs before the handler parses the body, so it cannot know whether this request is restoring a party
or a role. `needs('recycleBin.view')` is therefore all the route can assert, and the meaningful check —
the entity's delete key — happens in the service. This is a worked example of §6.1: the service check
is the gate, and the route guard is an early refusal where one is possible.

**A consequence worth surfacing to the owner rather than burying.** A deletion performed by an
unattended Office Panel has `deleted_by = NULL` (`actorUserId` returns null for panel and system
actors, `actor.ts:31-33`), so it is scoped to nobody and is visible **only** to `recycleBin.viewAll`
holders. That is correct behaviour for a scoping rule keyed on identity, and it is also a way for a
deletion to become hard to find. It argues for the Bin screen labelling those rows explicitly.

### 6.5 Fields

Seventeen commands, and the event names are **`04-API-CONTRACT.md` §9.3's, not this document's**.
An earlier draft of this table wrote them as `field:listValues`, `field:listDefinitions` and
`field:listStages`; that was wrong on both counts — the prefix is **`fields:`** and the read verbs are
**`values`, `definitions`, `stages`**, not `listX`. `04-API-CONTRACT.md` is the sole authority for
socket event names and the names below are copied from it verbatim.

| Master endpoint | Route guard | Service check | Socket command |
|---|---|---|---|
| `GET /api/fields/catalogue` | `needs('fields.view')` | `requirePermission(actor,'fields.view')` | `fields:catalogue` |
| `GET /api/fields/values` | `needs('fields.view')` | same | `fields:values` |
| `GET /api/fields/usage` | `needs('fields.view')` | same | `fields:usage` |
| `GET /api/fields/definitions` | `needs('fields.view')` | same | `fields:definitions` |
| `GET /api/fields/stages` | `needs('fields.view')` | same | `fields:stages` |
| `POST /api/fields/values` | `needs('fields.manage')` | `requirePermission(actor,'fields.manage')` | `fields:createValue` |
| `PUT /api/fields/values/:id` | `needs('fields.manage')` | same | `fields:updateValue` |
| `DELETE /api/fields/values/:id` | `needs('fields.manage')` | same | `fields:deleteValue` |
| `POST /api/fields/values/reorder` | `needs('fields.manage')` | same | `fields:reorderValues` |
| `POST /api/fields/definitions` | `needs('fields.manage')` | same | `fields:createDefinition` |
| `PUT /api/fields/definitions/:id` | `needs('fields.manage')` | same | `fields:updateDefinition` |
| `DELETE /api/fields/definitions/:id` | `needs('fields.manage')` | same | `fields:deleteDefinition` |
| `POST /api/fields/definitions/reorder` | `needs('fields.manage')` | same | `fields:reorderDefinitions` |
| `PUT /api/fields/stages/:id` | `needs('fields.manage')` | same | `fields:updateStage` |
| `POST /api/fields/stages/reorder` | `needs('fields.manage')` | same | `fields:reorderStages` |
| `POST /api/fields/stages/:id/archive` | `needs('fields.manage')` | same | `fields:archiveStage` |
| `POST /api/fields/stages/:id/restore` | `needs('fields.manage')` | same | `fields:restoreStage` |
| `GET /api/pipelines`, `/api/option-lists`, `/api/custom-fields` | **unchanged — `requireAuth` only** | none | unchanged |

The last row is not an omission; §3.2 gives the reason.

**Two write routes carry a mandatory `expectedVersion`.** `PUT /api/fields/values/:id` and
`PUT /api/fields/definitions/:id` refuse a save that does not say which version it was based on, and
refuse a stale one with 409 carrying `storedVersion` — the `assertVersionMatches` contract at
`master/src/domain/access.ts:183-192`. `option_lists` and `custom_field_definitions` gain the
`version` column for it; see `03-DATABASE.md`. This is a concurrency rule, not a permission rule, and
it is stated here only so the two gates above are not mistaken for the whole of what these routes
enforce.

### 6.6 The Dashboard

One endpoint, and the only one in the batch with **no key of its own**.

| Master endpoint | Route guard | Service check | Socket command |
|---|---|---|---|
| `GET /api/dashboard` | `requireAuth` only, as today | Per-figure: each figure is omitted unless the actor holds the key governing the data behind it | `dashboard:get` |

**A figure the caller may not see is absent, never `0`.** This is `maskFields()`'s rule (§1.1) applied
to a summary object rather than a record, and for the same reason: a zero is a claim about the
business, and "you may not see this" is a claim about the reader. A dispatch clerk without
`orders.view` who is shown `0` open orders will act on it.

Minting a `dashboard.view` key was considered and rejected. Every figure the Dashboard shows is
already governed by the module key that owns its data, so a Dashboard key would either duplicate
those checks or — worse — override them, and a screen that is one card wide because the reader holds
one module key is an honest screen. The Dashboard is a *view over* permissions, not a permission.

The two sync figures follow the same rule with a specific owner: **`openConflictCount` and
`pendingSyncCount` are optional and gated on `sync.resolveConflicts`**, absent when the actor does not
hold it. `04-API-CONTRACT.md` owns the `DashboardSummary` type, including the shape of
`pipelineBreakdown`; this document owns only which key gates which figure.

### 6.7 The Office side of every row above

Uniform, and it invents nothing. For each command: one event in `ClientToServerEvents`
(`shared/src/protocol/socket.ts`), one line in `registerCommands()` using the existing
`run(ack, actor => …)` shape, and one route in `office/src/http/app.ts` registered **after** the
positional `app.use('/api', requireUser)` gate at line 133:

```ts
app.get('/api/logs', (req, res) => forward(res, 'log:list', req.query));
```

`forward()` (`office/src/http/app.ts:438-462`) already maps `MasterCommandError.unreachable` to 503
`{error:'unavailable'}` and passes a Master refusal through with its code and the permission it named.
Offline is decided from the transport flag, never by reading the error message — a Postgres
"canceling statement due to statement timeout" is a message the Master *sent*, so it means refused,
not silent.

**No Office route carries a permission check, and none should.** Adding one would put an enforcement
decision on a machine with no `roles` table, using a permission array the Master handed it, which is
the definition of a client-side check.

---

## 7. Test obligations

Permission-specific. The module documents carry their own functional suites; these are the ones that
exist to keep this document true.

**`10-TESTING.md` is the sole authority for the test register.** The three suites this document
proposed — `shared/tests/permissions.test.ts`, `master/tests/permission-enforcement.test.ts` and
`master/tests/migration-grant.integration.test.ts` — have been **accepted** and now appear in that
register and in `02-FILE-STRUCTURE.md`'s file counts. The table below states what each one asserts
*about permissions*; it is not a second register, and where the two ever disagree about a suite's
existence, path or count, `10-TESTING.md` wins.

One correction to the earlier draft, because it changes a file count: **`shared/tests/permissions.test.ts`
is a NEW file, not an extension.** `shared/tests/` currently holds exactly two files —
`discovery.test.ts` and `sync.test.ts` — and there is no permissions suite there to extend.

| Suite | Kind | Asserts |
|---|---|---|
| `shared/tests/permissions.test.ts` (**new**) | pure | The eleven new keys are in `PERMISSIONS`; `minimumTierFor` returns the tier this document's §2 table states, for every new key; `allowedForTier('office')` excludes `documents.delete` and `recycleBin.viewAll` and includes `fields.view` |
| `shared/tests/i18n-coverage.test.ts` | pure | Every key in `PERMISSIONS` has a `permission.<key>` token; every module in `MODULES` has `module.<key>`; `hi.ts` is total. This is what makes `labelToken` load-bearing rather than decorative (§1.7) |
| `master/tests/permission-enforcement.test.ts` (**new**) | pure, source-reading | Every key in `PERMISSIONS` appears in at least one `requirePermission(` call in `master/src/services/`, or in a named indirect-enforcement helper (`canSeeRates`, `canEditRates`, `RESTORE_PERMISSION`, `REQUIRED_PERMISSION`). The allow-list is explicit, so adding to it is a visible act. This is the automated form of `HANDOFF.md`'s "a permission that enforces nothing" rule, in the established `credential-invariants.test.ts` style |
| `master/tests/credential-invariants.test.ts` (extend) | pure, source-reading | Each new router mounts a guard on every handler except a stated exception list — the `guards.length === handlers.length - N` assertion, per router |
| `master/tests/access.integration.test.ts` (extend) | integration | The tier change: a management-tier role can now be saved holding `fields.manage`; an office-tier role still cannot, and the whole save is rejected naming the key |
| `master/tests/permissions.integration.test.ts` (extend) | integration | For each new endpoint, a role lacking the key is refused with the key named in the error — the pattern already at `permissions.integration.test.ts:82` |
| `master/tests/migration-grant.integration.test.ts` (**new**) | integration | Running `20260309` twice is idempotent; an admin role holding a hand-added key keeps it (union, not replace); a management-tier role gains nothing; a soft-deleted admin role is granted too; **and an admin role whose stored array contains a duplicate is still granted** — the case a length-comparison no-op test silently skips (§5.1) |

The refusal test matters more than it looks. A route that answers 404 or 500 instead of a 403 naming
the key is indistinguishable from a broken screen, which is the failure `requirePermission`'s comment
(`actor.ts:39-45`) exists to prevent.

---

## 8. Open questions

Genuinely open. None is answered by assumption here.

| # | Question | Recommendation |
|---|---|---|
| 1 | **Confirm Fields editing is management+**, not genuinely every user (§4). This is `docs/BACKEND_MODULES.md` §10 q4 | Management+. Renaming a stage reorders every board in the company |
| 2 | **Should `logs.verifyChain` sit at the office ceiling?** §2 places it there per `docs/BACKEND_MODULES.md` §7, so an administrator *may* grant chain verification to an office-tier role. It is an expensive integrity assertion, and "reachable from both panels" and "this pins the single Master process for up to 30 seconds" pull in opposite directions | Leave it at office. The ceiling is not the access control — the grant is, and no non-admin role receives the key without an administrator choosing it. Lowering later is free; raising later is a repair migration |
| 3 | **Should `recycleBin.view` sit at the office ceiling** when every restorable entity is management+ (§2.3), so an office-tier holder can only ever see an empty Bin? | Leave it at office, for the same asymmetry reason. Revisit if the Bin ever gains an office-tier entity |
| 4 | **Accept leaving `20260303`'s live `allPermissions()` import alone** (§5.3), and record it in `HANDOFF.md`? | Yes |
| 5 | **Is `messageKey` required on `AppError`?** It is not a permission question, but it changes every `ForbiddenError` in this document's matrix. The count is **129 across `master/src`, 0 in `office/src`** (126 by grep; `master/src/domain/conversion.ts` contains a literal NUL byte so grep classifies it binary and skips 4 sites — verify with `grep -a`). The number of hand-written *tokens* is **68**, not 129, because many sites share one; `05-EXISTING-CODE-CHANGES.md` carries the per-class breakdown | Required, with `message` derived from the EN catalogue so existing tests asserting English text stay byte-identical |

Two items are **known-open and deliberately not closed here**, mentioned so they are not mistaken for
gaps in this specification: the Office snapshot has no module-level filtering (`forCurrentUser()` at
`office/src/http/app.ts:395-407` re-masks `field.saleRate.view` correctly for whoever is signed in now,
but does not filter rows by `leads.view` / `orders.view`), and `panel:revoked` is defined in the socket
contract and still never emitted. Both need their own owner; this batch must not widen either.
