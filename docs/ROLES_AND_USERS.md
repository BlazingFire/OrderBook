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
| `tier` | `office` / `management` / `admin` / `server_master`, a `CHECK` not a lookup table |
| `permissions` | JSONB array of keys, sorted — see §5 |
| `is_system` | True on the seeded Administrator and the Server Master role: undeletable, tier-locked |

### 3.1 Why `tier` is a CHECK and not a lookup table

Four values, fixed by the product, never company-configurable. A lookup table would imply they can
be added to; they cannot, because the ceiling in `shared/src/domain/permissions.ts` enumerates all
four by name, and `ROLE_TIERS` lists them in rank order, lowest first. `tierRank` is the one place
rank is read from; no screen or service keeps a rank table of its own. Contrast with a lead's *stage* and a product's *category*, which **are**
company-configurable and therefore live in data.

On screen the tiers are named through the `tier.*` catalogue keys, never the raw value: Office,
Management, **Normal Admin** (`admin`) and **Server Master**. "Normal Admin" says that an admin is
no longer the top of the ladder.

### 3.2 The Server Master tier (1.3)

The owner's tier, above admin. It exists so that the people who own the installation cannot be
locked out of it by an administrator, and so that the operations that could lock them out need
the master key (`docs/MASTER_KEY.md`).

**One role.** Migration `20261001000000_server_master_tier` widens the tier `CHECK` and seeds one
`is_system` role named "Server Master" per company ("Server Master (system)" if that name is
taken), holding every permission. The role is **frozen**: it cannot be renamed, edited, re-tiered
or deleted (`assertServerMasterRoleFrozen`), and no other role can be given the tier
(`assertTierAssignable`), so the role editor never offers it. Its permissions always equal
`allPermissions()`; `server-master.integration.test.ts` asserts that after every migration.

**Two accounts, always.** A fresh setup asks the owner to type two Server Master accounts
(suggested `master` and `master-backup`) and creates **no `admin`**. At least two active Server
Masters must remain (`SERVER_MASTER_MIN_ACTIVE`, `assertServerMastersRetained`, checked under the
same `lockTenantAccessGuards` lock as G4): deactivating, deleting or demoting one of the last two is
refused even with the master key. An installation from before 1.3 has none; on the Master PC the
sign-in screen asks for the master key and then the missing accounts, with no skip, while LAN
admins and Office panels keep working. Existing admins stay admins; nothing is backfilled.

**Master PC only.** A Server Master signs in only over loopback (`signIn(…, {onMasterPc})`), and
their session resolves only from a loopback address: a Server Master cookie carried to a LAN
browser gets 401 there while the Master-PC session survives. "Loopback" here means the address
and the `Host` header, and any `Origin`, all name this PC (`isOnMasterPc`), so a web page that
reached the Master through a hostile name re-pointed at 127.0.0.1 does not count. Office panels refuse Server Masters
whatever their address (`auth:signIn` passes `onMasterPc:false`, `auth:assume` refuses outright),
never cache their credentials for offline sign-in, and forget any cached user who becomes one.

**Target-tier guards.** Nobody manages an account above their own tier (`assertMayManageUser`,
G9): an admin can never edit, deactivate, delete, reset, reveal the password of, change the avatar
of or demote a Server Master. The Roles & users screen leaves those controls out for them rather
than disabling them, and highlights Server Masters with a badge and a tinted row.

**The master key.** A Server Master acting on another Server Master's username, active state,
role, password or deletion needs a master-key token as well (§8, G10); so does creating one,
changing one's own password, recovering a forgotten one and changing the pairing password. The
key, its lockout and recovery: `docs/MASTER_KEY.md`.

**Logs.** A Server Master's own entries are highlighted and badged on the Logs screen on both
panels (the actor's tier is read at list time). Account changes are logged as
`user.server_masters_set_up` and `user.password_recovered`, master-key use as
`master_key.verified` / `master_key.failed`.

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
**grants a combination neither administrator approved** — one removes `orders.delete` offline while
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


### 5.1 The Chatroom keys (1.3 Phase 6)

Six keys in a `chat` capability group, rendered in the role editor from `CAPABILITY_GROUPS`:
`chat.use` (the switch), `chat.directMessages`, `chat.shareRecords`, `chat.tasks` (all office tier),
`chat.createGroups` (management and above) and `chat.manage` (admin and above). What each gates is in
`docs/backend-modules/04-API-CONTRACT.md` section 14.1.

**Default grants.** Migration `20261005000000_chatroom` unions all six into every `admin` and
`server_master` role, and `chat.use` + `chat.shareRecords` into every `office` and `management` role,
so the Chatroom works the day it ships for the people it was asked for. It is a one-time grant, not a
rule: a role created afterwards holds none until an administrator ticks them (or picks the Sales or
Dispatch template, which carry them). Taking `chat.use` away stops delivery at once, whatever rooms the
person is still a member of.

**The request flow.** A person who lacks `chat.directMessages`, `chat.shareRecords`, `chat.tasks` or
(for a management role) `chat.createGroups` sees a *Request access* button in the Chatroom. It posts to
`/api/chat/access-requests` (`chat:requestAccess` from an Office), which tells everyone holding
`roles.edit` with an `access.requested` notice linking to the requester's role. One unread request per
person and right is kept. The notice only informs; granting is the ordinary role edit.

### 5.2 The Printroom keys (1.3 Phase 7)

Two keys in the `workflow` capability group: `print.send` and `print.station`, both office tier.
`print.send` lets a person queue a pending or final order's Filling or Dispatch note for the PC with the
printer and see, and cancel while still queued, their **own** jobs. `print.station` runs a printroom:
it sees and prints **every** job, marks them printed or not printed, cancels any queued one, and turns a
PC into an auto-print station.

**`print.station` is a deliberate cross-party grant.** A sender addresses "the printroom", not a person,
so whoever is at the printer must be able to print any party's sheet; it works whatever Party Access the
holder has (the sheet is frozen from the *sender's* view when it is sent). Its label in the role editor
says so. Tick it only for the people (or the PC's signed-in user) who stand at a printer.

**Default grants.** Migration `20261006000000_printroom` unions both keys into every `admin` and
`server_master` role. Office and management roles hold neither until an administrator ticks them (or picks
the Sales template, which carries `print.send`, or Dispatch, which carries both). Sending a note also
needs the note's own export right: `leads.export` for a pending order, `orders.export` for a final one.

**An unattended printer PC.** Auto-print runs in the signed-in OrderBook window of a user who holds
`print.station` (the Master addresses its pushes to a person, and the runner is part of the signed-in UI).
Leave that user signed in on the printer PC (Windows auto-login plus the app at start-up keeps it that way)
and turn on *Auto-print new jobs on this PC* in the Printroom.

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

The entry is the **last** statement of its transaction, after `master_clock` and every row the change
locks, so a transaction holding the chain lock never waits on anything but its own commit and two
audited writes cannot deadlock over it. `master/tests/audit-atomicity.integration.test.ts` holds a row
each write has to lock and checks the chain lock is still free while the write waits for it.

Creating and editing parties, products and leads, a lead's stage move, conversion, dispatch,
and panel pairing, revocation and editing used to record *after* their transaction
closed, through `recordDetachedActivity`. A party-wise record, an order edit, an order's
stage move and an offline edit applied by the merge recorded nothing at all. Since 2026-09-24 every
one of them records inside its transaction (`master/tests/audit-atomicity.integration.test.ts`).

**Still detached, on purpose** — `recordDetachedActivity`, whose failure is only a warning:

- **Sign-in attempts** (`auth.service.ts`), one path for refused and accepted. A refused attempt
  changed nothing. An accepted one does: it stamps `users.last_sign_in`, and may rewrite a bcrypt hash
  as scrypt, in a transaction of its own — and its entry is still written after that commits. It could
  join that transaction and does not, because joining would make signing in fail whenever the trail
  cannot be written, for the administrator who has to fix the trail as much as for anyone.
- **Connector runs** — many transactions, one summary entry written after the last.
- **A panel's reissued secret and moved storage folder** — changes that have already happened on the
  panel's own machine before the Master writes, where rolling the Master's half back because the entry
  failed would leave the two machines disagreeing.

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
| G9 | Nobody manages a user above their own tier (an admin never touches a Server Master) | `assertMayManageUser`, `domain/access.ts` |
| G10 | At least two active Server Masters remain; Server Master account changes need the master key | `assertServerMastersRetained` + `user.service.ts`, *inside the transaction, under the G4 lock* |
| G11 | The Server Master tier belongs to its one frozen system role; no panel may use it | `assertTierAssignable`, `assertServerMasterRoleFrozen`, `panel.service.ts` |

G1's "admin" means *rank at least admin* since 1.3, so a Server Master passes it, and G4 counts
admins and Server Masters together (`readAdministrativeCapability`).

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
| Sign-in success / failure | username, timestamp; a Server Master refused off the Master PC is a failure with reason `masterPcOnly` |
| Sign-out, session expiry, offline sign-in (uploaded by the panel) | who, and on which panel for offline ones; written detached |
| Server Masters set up, Server Master password recovered | the names; **no password material** |
| Master key entered, wrong master key | the attempt, detached |

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

0. A Server Master signs in only on the Master PC (§3.2). The check runs after the password
   verifies and does not count as a failed attempt.
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

No screen reaches them now (the Developer tab was removed in 5a32106); the routes remain.
Full behaviour, the password itself, and the honest statement of what that shared
secret costs: `docs/DEVELOPER_MODE.md`.

## 15b. Who sees a party someone creates (party visibility, 2026-10)

`parties.create` and `parties.edit` are office-tier keys, so an administrator grants them to an
office role in Access (Roles, then the role, then Parties). The reach of what that person then
creates is decided by one more key:

| The creator | The new party |
|---|---|
| a person **without** `party.accessAll` (the usual office role) | restricted at birth: a `manage` grant for the creator, in the same transaction. Visible only to them and to `party.accessAll` holders, with its leads, orders, search hits, dashboard figures, reports, chat chips and Office snapshot |
| a person **with** `party.accessAll` (administrators; grantable to a manager) | open to everyone, as before. They restrict it in Party Access if they want |
| nobody (an unattended panel, the system, a connector) | open to everyone |

Example: 3 administrators and 5 office users. Office user A's party is invisible to office users B to E and
visible to A and all 3 administrators. Parties that existed before are unchanged (no backfill).

What an administrator should know:
- Sharing is Party Access: add people to the party, or remove A's own row to make it open again.
- A party hidden from someone answers "not found", never "not assigned to you".
- A bulk party import by an office user makes every imported party theirs alone, and its
  duplicate check counts only parties that person can see.
- On an Office PC, a person's offline work on parties waits until that person signs in again on that PC
  (`docs/STRUCTURE.md` section 11.11). If A creates a party offline and signs out, it is not
  sent under the next person's name.
- **The print room is the one deliberate exception (owner decision, 2026-10-06).** A person or PC holding
  `print.station` sees and prints every print job whatever party it is for, and whether or not they hold
  `party.accessAll`. The sender addressed the print room, not a person. Grant `print.station` knowingly: to
  the role of whoever runs the printer, not to a role used for ordinary office work.
- **Defaults the owner confirmed.** Parties that exist today stay open to everyone. A Management role sees every
  party only if it holds `party.accessAll`; otherwise it sees the parties it created or was given, like an
  office role. A party an administrator creates is open to everyone until an administrator restricts it.
- **Where an administrator sees it.** Roles: the role editor has a **Parties** card (Create parties, Edit
  parties) and each role card lists the party actions it holds. Parties (Master): a **Visible to** column
  shows **Private** (one person, and administrators) or **Shared with N**; an open party shows nothing.
  Party Access: each party's creator is tagged among the people who can see it.

## 15c. The notice board keys (Oct 2026)

Two keys, group `notices`, shown in the role editor under **Notice board** and on each role card as **Read** or
**Read and manage**:

| Key | Minimum tier | Meaning |
|---|---|---|
| `notices.view` | office | Read the notice board: the notices meant for your role. Every existing role holds it after the update, and the role form ticks it for a new role |
| `notices.manage` | admin | Put up, change, pin, expire and delete notices, choose who sees them, and see who has read each one. Granted by the update to every admin and Server Master role; a role below the admin tier cannot be given it |

Who a notice reaches is decided by the **role** of the person signed in, so changing someone's role changes what they
see on their next sign-in (a role change ends their session). On an Office PC the notice board of a person is the
one the Master built for that person; it is not shared with whoever signs in next. Management of notices is on the Master
and, for holders of `notices.manage`, on the Office (online only).

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
| Every audited write is atomic with its entry | True since 2026-09-24 for every audited write that is the Master's alone and fits in one transaction — **except** an accepted sign-in, whose `last_sign_in` stamp (and any password-hash upgrade) commits before its entry is written | Detached, on purpose: sign-in attempts, refused or accepted; connector runs (many transactions, one entry); and a panel's reissued secret or moved storage, which have already happened on the panel's machine before the Master writes its half. See §7.1 |
| The database refuses to open unencrypted | **Not implemented, and undecided** | SQLCipher is a SQLite-file mechanism and community PostgreSQL has no upstream equivalent, so the swap removed the mechanism with no in-schema replacement. Every `password_hash` is already an irreversible digest and the cluster is loopback-bound, but "data at rest is unreadable without a key" is a guarantee this build does not make. Open question for the owner |
| Recycle Bin module (`2-…` §4.12) | **Built** — soft delete and restore, and the Master's Recycle Bin screen lists the deleted records of eight entity types (`RECYCLE_BIN_ENTITIES`), roles and users among them | The Bin has no permission of its own: restoring a record needs that entity's own delete permission, so it cannot become a back door |
| API keys (`api_keys` referencing `role_id`) | **Built** — `api_keys` with `api_key_scopes`, owned by a user (`owner_user_id`), not a role | Specified in `docs/schema/07-integrations.md`, not here |
| Developer Panel vendor support session | **Not built** | There is no Developer Panel in OrderBook |
| i18n via `labelToken` from the first commit | Tokens are in the catalogue and served, and `t()` renders them in English | None |
