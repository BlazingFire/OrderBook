# Roles & Users (as built)

Ported from the owner's three supplied documents — `roles-database.md`,
`roles-software-flow.md`, `roles-ui.md`. Like the lead-generation guide, they were written against a
different system: **SQLite**, **Electron** (renderer/main-process IPC), an `ops`/`applied_ops`
log, and companion documents (`1-PLAIN-ENGLISH.md`, `2-PRODUCT-SPEC.md`, `3-ARCHITECTURE.md`,
`5-BUILD-ORDER.md`) that do not exist here.

This file is the version that is true of OrderBook. §16 lists every deliberate difference.

Schema: `docs/schema/06-tenancy-permissions-and-sync.md`. Related flow:
`docs/LEAD_GENERATION_FLOW.md`.

---

## 1. What this module owns

| Table | Holds |
|---|---|
| `roles` | one named permission map per company |
| `users` | one person who signs in |

It reads from and appends to the shared sync substrate — `applied_mutations`, `id_map`,
`sync_conflicts`, `activity_log` — and creates none of it. It does **not** own sessions (in memory)
or paired panels (`office_panels`, which *references* a role).

---

## 2. Base columns

Both tables carry the full set: `tenant_id`, text `id`, `created_by`/`created_at`,
`updated_by`/`updated_at`, `deleted_at`/`deleted_by`, `version`, `hlc`, plus `field_hlc` and
`temporary_id` from the sync layer.

`version` drives optimistic concurrency for online saves; `hlc` drives offline merge. **They are
not redundant and one does not replace the other**: `version` answers "did somebody save while I
had this form open", `hlc` answers "which of two disconnected edits happened first".

---

## 3. `roles`

`id` carries the `RL` tag — 12 chars permanent (`RL0000000004`), 15 while offline.

| Column | Notes |
|---|---|
| `name` | Unique per tenant, case-insensitive, **among live rows** |
| `tier` | `office` / `management` / `admin`, a `CHECK` not a lookup table |
| `permissions` | JSONB array of keys, sorted — see §5 |
| `is_system` | True on the seeded Administrator only: undeletable, tier-locked |

### 3.1 Why `tier` is a CHECK and not a lookup table

Three values, fixed by the product, never company-configurable. A lookup table would imply they can
be added to; they cannot, because the ceiling in `shared/src/domain/permissions.ts` enumerates all
three by name. Contrast with a lead's *stage* and a product's *category*, which **are**
company-configurable and therefore live in data.

---

## 4. `users`

`id` carries the `US` tag.

| Column | Notes |
|---|---|
| `username` | Sign-in identifier. Unique per tenant, case-insensitive, among live rows |
| `display_name` | Required. Was the optional `full_name` before this module |
| `password_hash` | `scrypt$…` prefixed. Never plaintext, never reversible, never leaves the server — but see §4.2, which is how a password can nonetheless be shown again |
| `role_id` | FK **by convention only** — see §4.1 |
| `is_active` | Deactivation. Distinct from deletion |
| `last_sign_in_at` | Written on success |

### 4.1 No SQL foreign key on `role_id`

Two reasons, and both are load-bearing:

1. **Sync arrival order.** Once roles and users can be created offline (not built yet, §15.5), a
   mutation creating a user can reach the Master before the one creating its role. A hard FK would
   reject the write and break idempotent replay.
2. **Soft deletes.** A restored role must reattach to the users still pointing at it, which
   `ON DELETE` semantics fight.

Referential integrity lives in the service guards instead (G5: a role held by a live user cannot be
deleted). Every *other* reference to `users(id)` — six of them — does keep its foreign key, because
users are never hard-deleted.

---

### 4.2 The password vault, and what it changes about the sentence above

`password_hash` is still a one-way hash and nothing reverses it. What changed on 2026-08-29 is that
an installation may **also** keep the plaintext, sealed, in a separate table.

`user_password_vault` holds an AES-256-GCM-sealed copy of the password, under a key file at
`dataDir/secrets/vault.key` that is deliberately outside the database and outside every backup. It
is **off by default**: nothing is written until an administrator sets
`security.passwordRevealEnabled`, and setting it back to `false` deletes every stored plaintext in
the same transaction as the flag. Rows fill themselves as people sign in online — there is no
back-fill migration, because a successful sign-in is the one moment the Master legitimately holds
somebody's plaintext.

Reading one back needs `users.viewPassword` (admin tier), the setting switched on, a
re-authentication by the caller, and a fingerprint that still matches the live hash; every reveal
writes an `activity_log` row before the response is built.

**The honest statement of what this costs** is in `docs/overhaul/workstream-F.md` §1.8 and belongs
here too: once it is switched on, every password of every person who signs in afterwards is
recoverable by anyone who can read the Master PC's data directory. The encryption stops a copied
database file and a stolen backup, and nothing else. Misuse is visible in the audit trail, not
prevented.

## 5. The `permissions` column — one JSON array, deliberately

**Chosen:** a single JSONB array. **Rejected:** a `role_permissions(role_id, permission)` join table
— which is what this repository actually had until this module replaced it.

| | JSON array | Join table |
|---|---|---|
| Reads | one row, one seek | N rows, a join per resolution |
| Sync | one field-level mutation | one per key toggled |
| Merge on conflict | whole array, highest HLC wins | per-key union |

The join table's per-key merge looks like an advantage and is not. A union of two concurrent edits
**grants a combination neither administrator approved** — one removes `stock.adjust` offline while
the other adds `products.delete` offline, and the union keeps both as though they had been reviewed
together. Permission sets are approved as a whole, so they merge as a whole.

The cost is accepted, and is *meant* to be made visible: a same-field clash writes the losing array
to `sync_conflicts` and the role editor shows it for review.

**Not yet true.** Roles carry no mutation kind (§15.5), so no role edit can currently reach the
merge path and no `sync_conflicts` row for a role's `permissions` can ever be written —
`conflict.service.ts`'s column map has no role entry. The editor therefore has no conflict banner
and no Compare view. This becomes real work the moment roles become syncable, and is recorded here
rather than described as though it already shipped.

**Storage rules**, all enforced on write:

- always an array of strings, never null, never an object
- **sorted** before write, so an identical set is identical bytes and a reorder is not an edit
- **validated against the frozen catalogue** — an unknown key fails the whole save rather than
  being silently ignored
- **within the tier ceiling** — a key above the role's tier fails the whole save

---

## 6. Indexes

```sql
CREATE UNIQUE INDEX roles_name_unique     ON roles (tenant_id, lower(name))     WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_username_unique ON users (tenant_id, lower(username)) WHERE deleted_at IS NULL;
CREATE INDEX        users_by_role         ON users (tenant_id, role_id)         WHERE deleted_at IS NULL;
CREATE INDEX        users_active          ON users (tenant_id, is_active)       WHERE deleted_at IS NULL;
```

Every index leads with `tenant_id`, so a query that forgets the tenant filter degrades into a
visibly wrong scan rather than a silent cross-company leak.

The two unique indexes are **partial**. Without that, a soft-deleted user permanently reserves
their username and somebody who left and came back cannot be re-created.

`users_by_role` is what makes the "is this role in use?" and "how many admins remain?" guards seeks
rather than scans.

**No full-text index.** Search is for products, parties and line items. Roles and users are small
bounded lists; a tenant-scoped `LIKE` is correct and an FTS table would be a trigger-sync liability
for no gain.

---

## 7. The write path

```
  service guard (G1–G8)
       |
  requirePermission ---- fails ---> 403 naming the key
       |
  +---------------- ONE transaction ----------------+
  |  1. write the row, bump version, stamp hlc      |
  |  2. append a hash-chained audit entry           |
  +-------------------------------------------------+
```

If the audit append fails, the change rolls back with it. The projection and the trail can never
disagree about what happened.

### 7.1 What makes that true, and what it costs

`recordActivity` takes the caller's transaction and is **required** to. It used to insert on the
root pool — a different connection — and catch its own errors into a warning, so the guarantee
above was false in both directions: a failed append left the change committed and unrecorded, and
an entry written inside a transaction that later rolled back survived, describing something that
never happened. `master/tests/audit-trail.integration.test.ts` pins both.

The cost is real and was accepted deliberately. The `activity_log` chain trigger takes a per-tenant
advisory lock to serialise the hash chain; holding it inside the caller's transaction means every
audited write for one company queues behind the others. At this product's scale — one company, a
handful of panels, human-paced actions — that is not a constraint worth trading a trustworthy trail
for.

**Still best-effort:** leads, orders, parties, products, inventory and panels call
`recordDetachedActivity`, which preserves the old behaviour but is named honestly. Those call sites
record *after* their transaction closes, so making them atomic is a restructuring of each service
rather than a parameter change. Roles, users and authentication — the module these documents govern
— are atomic.

---

## 8. Guards

| | Rule | Where |
|---|---|---|
| G1 | Only tier `admin` may create or restructure roles | `domain/access.ts` |
| G2 | Every key must exist and be within the role's tier | `domain/access.ts` |
| G3 | You cannot mint a role or a user above your own tier | `domain/access.ts` |
| G4 | **The company must not lose its last administrator** | `domain/access.ts` + `access-guard.repository.ts`, *inside the transaction, under a lock* |
| G5 | A role held by a live user cannot be deleted | `domain/access.ts`, *inside the transaction* |
| G6 | The system role cannot be deleted or re-tiered | `domain/access.ts` |
| G7 | Usernames unique per tenant among live rows | `domain/access.ts` |
| G8 | Role names unique per tenant among live rows | `domain/access.ts` |

### 8.1 G4, the lockout guard

The most expensive bug this module can ship. `setup.service.ts` refuses to re-bootstrap once
`master_config` exists, so a company with no working administrator cannot be repaired from inside
the product at all — recovery means direct database access. Three things make the guard hold, and
each replaced a version that did not.

**It covers role edits, not just people.** The obvious route is deactivating the last
administrator, and that was guarded. The route that was not: editing the only admin-tier role until
nobody can administer anything — dropping its tier, or stripping `users.manage` from it — which
removes every administrator's authority without touching a single user row. So G4 is stated as
*capability*, not headcount: the admin population must retain both `users.manage` and `roles.edit`
between them.

**It takes a lock before it reads.** Counting inside the transaction is not enough. The connection
runs at READ COMMITTED, and two transactions deactivating two *different* administrators touch
disjoint rows — neither blocks the other, and both see one admin remaining. Row locks cannot help,
because the rows that must not change are the ones nobody is touching. `lockTenantAccessGuards`
takes a per-tenant advisory lock in the two-argument lock space, deliberately separate from the
one-argument space the `activity_log` chain trigger uses.

**It applies the change, then asserts.** The previous version enumerated which edits could remove an
administrator and checked only those — and role edits were not on the list. Asking the database
after the write is one indexed read and cannot be out-thought by a case nobody enumerated.

It is a **preservation** rule, comparing before against after: a company with no administrator yet
is a normal state (every fresh install before first-run setup), and a guard that cannot tell that
apart from a lockout would make the seeded roles uneditable on a brand-new machine.

`master/tests/access-lockout.integration.test.ts` covers both routes.

---

## 9. Audit entries

Every write produces one. `activity_log` is now **hash-chained and append-only**: each row commits
to its predecessor's hash, and triggers refuse `UPDATE` and `DELETE` outright.

| Action | Recorded |
|---|---|
| Role created | name, tier, the full permission array |
| Role permissions changed | **from-array and to-array in full**, not a diff |
| Role tier changed | from, to, and the keys the ceiling dropped |
| User created | username, display name, role. **Never the password or its hash** |
| User role reassigned | from role id+name, to role id+name |
| Activated / deactivated / deleted / restored | id, username, actor |
| Password reset | that a reset occurred, by whom, for whom. **No password material** |
| Sign-in success / failure | username, timestamp |

Recording the whole before-and-after array rather than a diff is deliberate: the question an auditor
asks is *"what could this role do on 14 March"*, and a chain of diffs makes that a replay instead of
a lookup.

---

## 10. Sync

**Designed, not built** — no role or user can be created offline yet (§15.5); this is how it is to
behave once it can. A role or user created on two offline panels gets two temporary ids and becomes
**two records**, not one merged record. That is correct — they are two distinct objects that happen
to share a name. The unique-name index rejects the second on promotion and the panel is told to
rename or discard. They are never auto-merged, because a merged permission set is one nobody
approved.

---

## 11. Redaction happens in the repository

Not in the route, not in the UI.

```ts
const { password_hash: _passwordHash, ...safe } = row;   // the key is now ABSENT
```

Every user-returning function goes through `mapUser`, and the `User` type does not declare a
`passwordHash` property at all, so a future caller cannot even ask for it.

`readCredentialForVerification` is the **only** function that selects the column. A grep for it must
return exactly one call site, forever.

The test asserts **absence**, not null: `expect('passwordHash' in user).toBe(false)`. Asserting
`user.passwordHash === null` passes against a broken implementation that merely blanked it.

---

## 12. Sign-in

1. Verify with scrypt against the stored `scrypt$…` form.
2. A wrong password and an unknown username return **the same message**. Anything else is a
   username oracle. Three failures lock the username for 60 seconds.
3. A deactivated account gets a *different*, actionable message — that is not a guessing signal, it
   is a fact the person needs in order to ask someone to fix it.
4. `effectivePermissions = role.permissions ∩ allowedForTier(role.tier)` — applied here **as well
   as** on save, so a role row that arrived over sync from a tampered replica carrying an admin key
   on an office tier is stripped before it enters the session.

### 12.1 bcrypt to scrypt, without locking anyone out

Existing installations were created with bcrypt. `verifyPassword` accepts either form and reports
whether the stored hash should be upgraded; sign-in then rewrites it to scrypt **in the same
transaction**, at the one moment the correct plaintext is in hand. The migration completes itself,
account by account, with nobody locked out and no admin action.

---

## 13. A permission change takes effect on the next call

Every session resolution re-reads the role's `version`:

```
resolveSession(token):
    if the role is gone or the account deactivated -> invalidate, force sign-out
    if role.version != session.roleVersion         -> rebuild the session's permissions
```

That read is a primary-key seek. **There is deliberately no TTL cache in front of it.** A
time-based cache means a revoked permission keeps working for the length of the TTL, which is
precisely the failure this rule exists to prevent. The role repository's cache is keyed on
`version`, so a version change is an eviction rather than an expiry.

Reassigning a user's role changes `roleId`, so the same check picks it up. A user whose role is
*deleted* is signed out rather than falling back to anything.

---

## 14. Deactivate, delete, restore — three different things

| Action | Effect | Reversed by |
|---|---|---|
| **Deactivate** | `is_active = false`. Cannot sign in. Every record, timeline entry and audit row is untouched | Activate |
| **Delete** | Soft — `deleted_at` set, row stays | Restore |
| *hard delete* | **Does not exist in this product** | — |

Restoring a role reattaches every user still pointing at it, which is only possible because
`role_id` is not a SQL foreign key (§4.1).

---

## 15. Signing in on an Office Panel

An Office Panel used to authenticate only as a *machine*: it paired once, held a panel secret, and
everyone who walked up to it acted under the panel's own role. It now asks who is using it.

### 15.1 Two paths, chosen by reachability

| The Master is… | Verified by | Permissions come from |
|---|---|---|
| reachable | the Master, which holds the hash | the Master, fresh |
| unreachable | a verifier this panel minted itself | the set cached at the last online sign-in |

The rule that keeps this honest: **a rejection is final, only silence falls back.** If the Master is
reachable and says no, the panel must not then try its local verifier — otherwise a password changed
or an account deactivated on the Master would keep working here, and the panel would quietly become
the weakest door into the company's data. `signInAgainstMaster` distinguishes the two by inspecting
the failure, and `office/tests/user-session.test.ts` pins it.

### 15.2 The panel mints its own verifier

The Master strips `password_hash` from everything it serves a panel (§8.1 of `roles-database.md`), so
a panel can never hold a copy of the Master's hash. Instead, at the one instant a successful online
sign-in puts the plaintext in the panel's hands, the panel derives a scrypt verifier of its own,
stores it in `data/users.json` (mode `0600`), and forgets the plaintext.

Two properties follow, and both are the point:

- this panel's disk says nothing about anybody who has never signed in *here*;
- offline sign-in is available exactly to the people who have used this machine before, which is the
  same set the shop actually needs it for.

A session the Master later refuses — deactivated, deleted, role removed — takes the local verifier
with it (`invalidateCurrent`). Leaving it behind would let somebody the company has just locked out
carry on working by pulling the network cable.

### 15.3 The panel presents a token, never an identity

Once signed in, the panel sends `auth:assume` with the Master-issued token and every subsequent
command on that socket runs as that person. The Master re-reads their `roles` row each time, so:

- a modified panel gains nothing by lying — it can present a token, and the Master alone decides what
  that token is worth;
- a permission revoked on the Master applies to the panel's **next command**, not its next reconnect;
- a token that resolves to nothing fails *closed*, back to the panel's own role.

The decision lives in `master/src/services/panel-actor.service.ts` rather than in the hub, because
whose authority a command carries is policy, not transport. `master/tests/panel-actor.integration.test.ts`
covers the three negative cases: an invented token, a token from another company, and a token whose
owner has since been deactivated.

The panel's device code is kept even when a person is acting, because a temporary id and an HLC
timestamp identify the machine that minted them, not the person at it.

### 15.4 What this does not cover

One signed-in person per panel at a time — an Office Panel is one PC at one counter, and the Master
keys the acting user to that panel's socket, so "who is acting" has to have exactly one answer.
Signing in replaces any previous session.

The session is held in memory by the panel's server, so restarting the panel signs the person out.
That is the same call the Master already makes for its own admins.

### 15.5 Creating roles and users offline — not built

The **schema** supports it: roles and users carry `RL`/`US` text ids, `temporary_id`, `hlc`,
`field_hlc` and `version`, exactly as leads do.

The **sync layer** does not. `MutationKind` is a closed union in `shared/src/sync/mutations.ts` and
has no `role.*` or `user.*` member, so no role or user edit can be queued in a panel's outbox,
pushed, merged or promoted. Everything about roles and users goes through the Master's own API while
it is reachable.

An earlier version of this section claimed both halves were done. They are not, and the distinction
matters: it is why §5's conflict banner does not exist, and why the Office Panel has no Roles & Users
*management* screen (§16) rather than merely lacking the screen.

---

## 15a. Developer mode sits outside the role model

Two actions — erasing an installation back to first run, and seeding the
documented test accounts — are guarded by a **developer password** rather than by
any key in the catalogue above. Nothing in §5 grants them, and no role can be
given them, deliberately: the person who needs them is usually not a user of this
company at all, and a permission would have to be granted by exactly the
administrator account that is locked out.

They are not a hole in this model either. Every developer route requires a
signed-in session *as well as* the password, unlocking grants no permission of any
kind, and the two tools it opens are the only things the token can reach.

Full behaviour, the password itself, and the honest statement of what that shared
secret costs: `docs/DEVELOPER_MODE.md`.

## 16. Where this deliberately differs from the supplied documents

| Document says | Here | Why |
|---|---|---|
| SQLite, `TEXT`/`INTEGER` columns | PostgreSQL, `TEXT`/`BOOLEAN`/`JSONB` | Postgres is a confirmed decision (`HANDOFF.md` #2); the schema *design* ports unchanged |
| Electron renderer / main process / named IPC | Browser / Express server / named HTTP routes | Same trust boundary, different runtime — the server is the trusted process |
| `ops` / `applied_ops` op log | `applied_mutations` + the panel outbox | The equivalent substrate, built with the lead-generation flow |
| `audit_entries`, `AU`-tagged | `activity_log`, hash-chained and trigger-protected | The existing table gained the chain rather than a second audit table appearing beside it |
| `active` column | `is_active` | Matches the convention already used by `parties` and `products` |
| Sign-in works offline against the local replica | **Built** — see §15 | The panel verifies against a verifier it minted itself at the last online sign-in, rather than against a replica of the Master's hashes, which the Master never sends. Only people who have signed in on that machine before can sign in there offline |
| Roles and users are *managed* from any panel | Managed on the Master only | The Office Panel signs people in; it has no role editor or user list. Nothing in the schema prevents one — it has not been built |
| Every audited write is atomic with its entry | True for roles, users and auth; still best-effort for leads, orders, parties, products, inventory and panels | Those call sites record after their transaction closes, so the fix is a restructuring of each service rather than a parameter change. They call `recordDetachedActivity`, which is named for what it does — see §7.1 |
| The database refuses to open unencrypted | **Not implemented, and undecided** | SQLCipher is a SQLite-file mechanism and community PostgreSQL has no upstream equivalent, so the swap removed the mechanism with no in-schema replacement. Every `password_hash` is already an irreversible digest and the cluster is loopback-bound, but "data at rest is unreadable without a key" is a guarantee this build does not make. Open question for the owner |
| Recycle Bin module (`2-…` §4.12) | Soft delete and restore work; there is no cross-entity Recycle Bin screen | Restore is reachable through the API and for roles/users through this module |
| API keys (`api_keys` referencing `role_id`) | **Not built** | A separate entity the documents describe but do not specify here |
| Developer Panel vendor support session | **Not built** | There is no Developer Panel in OrderBook |
| i18n via `labelToken` from the first commit | Tokens are in the catalogue and served; **there is no translation layer yet**, so the UI renders humanised keys | The contract is in place so adding the layer is a renderer change, not a schema one |
