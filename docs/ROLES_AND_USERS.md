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
| `password_hash` | `scrypt$…` prefixed. Never plaintext, never recoverable, never leaves the server |
| `role_id` | FK **by convention only** — see §4.1 |
| `is_active` | Deactivation. Distinct from deletion |
| `last_sign_in_at` | Written on success |

### 4.1 No SQL foreign key on `role_id`

Two reasons, and both are load-bearing:

1. **Sync arrival order.** A mutation creating a user can reach the Master before the one creating
   its role. A hard FK would reject the write and break idempotent replay.
2. **Soft deletes.** A restored role must reattach to the users still pointing at it, which
   `ON DELETE` semantics fight.

Referential integrity lives in the service guards instead (G5: a role held by a live user cannot be
deleted). Every *other* reference to `users(id)` — six of them — does keep its foreign key, because
users are never hard-deleted.

---

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

The cost is accepted and made visible: a same-field clash writes the losing array to
`sync_conflicts` and the role editor shows it for review.

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

---

## 8. Guards

| | Rule | Where |
|---|---|---|
| G1 | Only tier `admin` may create or restructure roles | `domain/access.ts` |
| G2 | Every key must exist and be within the role's tier | `domain/access.ts` |
| G3 | You cannot mint a role or a user above your own tier | `domain/access.ts` |
| G4 | **At least one active administrator must remain** | `user.service.ts`, *inside the transaction* |
| G5 | A role held by a live user cannot be deleted | `domain/access.ts` |
| G6 | The system role cannot be deleted or re-tiered | `domain/access.ts` |
| G7 | Usernames unique per tenant among live rows | `domain/access.ts` |
| G8 | Role names unique per tenant among live rows | `domain/access.ts` |

**G4 is the one that must run inside the transaction.** Checked before it, two concurrent
deactivations each see one remaining admin and both succeed — and the company is locked out of its
own software, which is unrecoverable without vendor intervention. That makes it the most expensive
bug this module could ship, and there is a test that runs both deactivations concurrently.

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

A role or user created on two offline panels gets two temporary ids and becomes **two records**, not
one merged record. That is correct — they are two distinct objects that happen to share a name. The
unique-name index rejects the second on promotion and the panel is told to rename or discard. They
are never auto-merged, because a merged permission set is one nobody approved.

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

## 15. What still works with the Master unreachable

The schema and the sync layer support creating roles and users offline with temporary ids, exactly
as leads are. **The Office Panel's own sign-in screen is not built** — see §16.

---

## 16. Where this deliberately differs from the supplied documents

| Document says | Here | Why |
|---|---|---|
| SQLite, `TEXT`/`INTEGER` columns | PostgreSQL, `TEXT`/`BOOLEAN`/`JSONB` | Postgres is a confirmed decision (`HANDOFF.md` #2); the schema *design* ports unchanged |
| Electron renderer / main process / named IPC | Browser / Express server / named HTTP routes | Same trust boundary, different runtime — the server is the trusted process |
| `ops` / `applied_ops` op log | `applied_mutations` + the panel outbox | The equivalent substrate, built with the lead-generation flow |
| `audit_entries`, `AU`-tagged | `activity_log`, hash-chained and trigger-protected | The existing table gained the chain rather than a second audit table appearing beside it |
| `active` column | `is_active` | Matches the convention already used by `parties` and `products` |
| Sign-in works offline against the local replica | **Not built** — the Office Panel has no user sign-in screen | The panel authenticates as a *device* (panel id + secret) and acts under the panel's role. Adding per-user sign-in means a local user/role replica and a session on the panel; the schema supports it, the UI does not exist yet |
| Recycle Bin module (`2-…` §4.12) | Soft delete and restore work; there is no cross-entity Recycle Bin screen | Restore is reachable through the API and for roles/users through this module |
| API keys (`api_keys` referencing `role_id`) | **Not built** | A separate entity the documents describe but do not specify here |
| Developer Panel vendor support session | **Not built** | There is no Developer Panel in OrderBook |
| i18n via `labelToken` from the first commit | Tokens are in the catalogue and served; **there is no translation layer yet**, so the UI renders humanised keys | The contract is in place so adding the layer is a renderer change, not a schema one |
