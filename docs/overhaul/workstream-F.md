# Workstream F — Recoverable password vault and a real server-side settings system

sound=false

## Findings
- **blocker**: False claim, verified against the code: "The migration grants it to nobody ... this one has to be ticked in the grid deliberately." `master/src/db/migrations/20260303000000_roles_and_users.ts:331` does `.update({ permissions: JSON.stringify(allPermissions()), is_system: true })` on the admin-tier role using a LIVE `@orderbook/shared` import. `allPermissions()` (`shared/src/domain/permissions.ts:288`) is derived from `PERMISSIONS`, which is derived from `CAPABILITIES`. So adding `users.viewPassword` to `CAPABILITIES` auto-grants it to the seeded Administrator on every FRESH install. `20260309000000_new_module_permission_grant.ts:7` says this out loud ("where 20260303's live allPermissions() import already granted them"). Separately `master/tests/helpers/fixtures.ts:244` builds `ALL_PERMISSIONS` from live `PERMISSIONS`, so every `testActor()` silently gains the key.
  - FIX: State the truth: on a fresh install the Administrator role holds `users.viewPassword` from day one; only an upgraded installation starts with nobody holding it. The real gate is therefore `security.passwordRevealEnabled`, which starts `false` on both — so make that the load-bearing control and stop claiming the permission is the deliberate ticking step.
- **blocker**: `writePermission: 'users.viewPassword'` on `security.passwordRevealEnabled` deadlocks on exactly the installations the design says it protects. On an upgraded install nobody holds `users.viewPassword` (per the design's own §1.5), so nobody can turn the feature ON — you must first grant the key through the permission grid, which needs `roles.edit`, not `settings.manage`. Worse, it also gates turning the feature OFF: the purge switch the owner asked for becomes unreachable for an administrator who revoked the key from their own role, leaving the plaintexts in the database with no way to delete them.
  - FIX: Drop `writePermission` from `SettingDefinition` entirely (it is also not type-safe — `Permission = string` at `shared/src/domain/permissions.ts:172`). Gate every settings write on `settings.manage` alone; gate the reveal endpoint on `users.viewPassword`. Two keys, two distinct acts: `settings.manage` decides whether the vault exists at all, `users.viewPassword` decides who may read from it.
- **blocker**: `SyncSnapshot` gains a REQUIRED `settings: SharedSettings`. Every field added to that interface since it shipped is optional and says why on the field: `partyGrants?` (`shared/src/protocol/socket.ts:295`, "so a panel built against this field still reads a snapshot from an older Master"), `builtForUserId?`, `serverVersion?`. `office/src/sync/local-store.ts:56` does `JSON.parse(raw) as SyncSnapshot` on a file the PREVIOUS version wrote — a required field is `undefined` at runtime while typed present, so any consumer dereferencing `view.settings.x` throws on an offline start, which is the one scenario that file exists for. It also breaks compilation of `office/tests/dashboard-staleness.test.ts:29` (`Omit<SyncSnapshot, 'dashboard' | 'permissions'>`), a file the design never names. And there is no shipped consumer: `externalApi.enabled` and `reports.defaultRange` are read by nothing.
  - FIX: Cut `audience`, `SharedSettings`, `readSharedSettings`, the `snapshot.service.ts` change and the `SNAPSHOT_POLICY` entry out of this workstream. Every setting here is Master-only. Workstream J adds `settings?: SharedSettings` — optional, with a documented absent-means-default rule — when it has a consumer, and pays for the `SNAPSHOT_POLICY` entry and the two office fixtures then.
- **major**: The two proposed invariant tests contradict each other. §1.7 test 2: "the literal `user_password_vault` appears in exactly two files under `master/src`: the migration and `password-vault.repository.ts`." §1.6(6) and §1.7 test 5 require `backup.repository.ts:40` to contain `'user_password_vault'` in its exclusion set. That is three files. Test 2 fails the moment test 5's requirement is implemented.
  - FIX: Test 2 asserts exactly three files and names them: the migration, `password-vault.repository.ts`, and `backup.repository.ts`.
- **major**: Missed file: the settings cache is never invalidated between tests. `master/tests/helpers/fixtures.ts:220-223` calls `invalidateRoleCache()`, `invalidatePipelineCache()`, `invalidateFieldCache()` and `resetAuthState()` inside `resetData()` precisely because in-memory caches survive `TRUNCATE`. A version-counter cache in `settings.service.ts` bumped only by `writeSetting` will carry `security.passwordRevealEnabled: true` from one test into the next after the table is truncated, and `vitest.config.ts` `fileParallelism: false` on a shared database means the symptom appears in an unrelated suite. The same hole exists after a restore: `backup-restore.service.ts:91-105` replaces the table wholesale without going through `writeSetting`.
  - FIX: Export `invalidateSettingsCache()` from `settings.service.ts`; call it in `resetData()` beside the other three, and after the restore transaction commits in `backup-restore.service.ts`. (The pre-existing absence of `invalidateRoleCache()` after a restore is the same defect and worth fixing in the same commit.)
- **major**: `loadOrCreateKey()` is called only from `master/src/index.ts`. No integration suite runs `main()` — `master/tests/helpers/fixtures.ts:97-101` does `startTestPostgres` + `initDatabase` + `runMigrations` and nothing else, and `createApp()` is imported directly. Every `seal`/`open` in every test would throw `SecretBoxError('no_key')`. Additionally `config.dataDir` defaults to `path.join(packageRoot, 'data')` (`master/src/config/index.ts:31-33`), so if the key were created lazily the test run would write a real key into the developer's live `master/data/secrets/`.
  - FIX: `secret-box.ts` load-or-creates lazily on first `seal`/`open`; `loadOrCreateKey()` at boot becomes an eager pre-flight inside the `try` in `index.ts` under `bootStep('Preparing secure storage')`, so a permissions failure surfaces on the boot screen. `master/tests/helpers/db.ts` sets `ORDERBOOK_DATA_DIR` to the throwaway cluster directory before `config` is imported.
- **major**: The sign-in back-fill seals the wrong fingerprint on the bcrypt→scrypt upgrade path. `auth.service.ts:98-108` rewrites `password_hash` to a fresh scrypt hash inside the same transaction the design wants to seal in, and `:134-137` already carries the comment "Read after any bcrypt→scrypt rewrite above, so the panel stores a marker for the hash that is now on disk." Sealing `credential.passwordHash` stores the PRE-upgrade bcrypt fingerprint, so the very first reveal after enabling the feature reports `stale` and shows nothing. This is not rare: `setup.service.ts:51` hashes the first administrator with `bcrypt.hash(password, 10)`, so the shop's own admin account hits it.
  - FIX: Seal AFTER the transaction, computing the fingerprint with `panelCredentialRepo.fingerprintForUser(tenantId, userId)` — the exact call `signIn` already makes at `:137` for exactly this reason. Same rule at `setup.service.ts`.
- **major**: The `recordActivity` call is malformed and the proposed i18n templates cannot render. `ActivityEntry` (`activity-log.repository.ts:45-53`) requires `tenantId`, `entityType`, `entityId`, `action`, `actorType`, `actorId`; the design's literal supplies three of six and will not compile. And `renderActivity` (`shared/src/i18n/activity.ts:47-49`) copies only `string | number` values into params, while `translate.ts#fill` leaves an unmatched placeholder VERBATIM in the sentence. `activity.setting.updated` with `details: { key, from, to }` therefore renders "…from {from} to {to}" whenever the value is a boolean or an object — i.e. for `security.passwordRevealEnabled` and `ai.provider`, most of the registry.
  - FIX: Pass the full six-field entry, copying the shape at `log.service.ts:238-252`. Stringify: `details: { name: key, from: String(before), to: String(after) }`, and write the EN/HI templates against `{name}`/`{from}`/`{to}` — matching the `{name}` convention every existing `activity.user.*` token uses.
- **major**: Over-engineering: `shared/src/domain/vault.ts` and `RevealedPassword` duplicate `OneTimeSecret` (`shared/src/domain/inputs.ts:313-317`), which is already `{ userId, username, password }`, already exported, already returned by `POST /users/:id/reset-password`, and already rendered by `OneTimeSecretDialog` at `master/web/src/screens/AccessScreen.tsx:276`. The stated justification — "not in entities.ts, so User can never grow a password property" — is equally satisfied by `OneTimeSecret`, which is not in `entities.ts` either.
  - FIX: Return `OneTimeSecret` from `revealPassword`. Put `VaultStatus` beside it in `inputs.ts`. Delete the new shared file and the `shared/src/index.ts` edit; the reveal dialog then needs no new component.
- **major**: Sealed SETTINGS have no recovery story and no key version. The `settings` table stays inside the backup (only the vault is excluded), so a `.obbackup` carries `ai.apiKey`'s ciphertext while `dataDir/secrets/vault.key` does not travel. Restoring on a new machine — or losing the key file, after which `loadOrCreateKey()` mints a fresh one — makes every sealed setting permanently unopenable. `getSetting`'s stated fallback covers a `parse` throw; `open()` throws `SecretBoxError` BEFORE `parse` runs, so the behaviour is undefined and `readSettings` can 500 the entire Settings screen for one unreadable row.
  - FIX: `getSetting` catches `SecretBoxError` and treats it exactly like a missing row (return `fallback`, log once at warn). `readSettings` reports `configured: false` for an unopenable secret rather than throwing. Give `settings` the same `key_version INT NOT NULL DEFAULT 1` column the vault has, and say in the Settings UI copy that a restore on a new machine requires re-entering secret settings.
- **major**: The re-authentication cache is not actually swept. The design says `noteRecentReauth`/`hasRecentReauth` are "swept by the existing `purgeExpiredSessions()`", but that function (`auth.service.ts:297-302`) iterates the `sessions` map only. A second map needs its own loop inside it. It also must be cleared by `resetAuthState()` (`:292-295`), or it reproduces exactly the cross-test leak the comment at `:286-291` was written for — a reveal in one test satisfying the re-auth in the next.
  - FIX: Add the second map's sweep inside `purgeExpiredSessions()` and its `.clear()` inside `resetAuthState()`, in the same two functions, keyed by session token with an absolute expiry.
- **minor**: `clearVault(trx)` takes no tenant argument, but `backup-restore.service.ts:85-95` supports a `selected`-tenant restore (`tenantIds !== null`), where `loadTables` touches only the named tenants' rows. Wiping every tenant's vault on a single-tenant restore is wrong in principle even though the product is single-tenant today.
  - FIX: `clearVault(trx, tenantIds: string[] | null)`, deleting all rows when `null` and scoping otherwise — matching `loadTables`' own contract. Keep the call unconditional, since `user_password_vault` will no longer appear in `tables`.
- **minor**: The `SETTINGS` registry as written does not compile. `tsconfig.base.json:8` sets `strict: true`, so `parse: (raw) => raw === true` under `... as const satisfies Record<string, SettingDefinition<unknown>>` leaves `raw` implicitly `any`. Several entries are also written as `{ …, fallback: ... }` with `labelToken`, `descriptionToken` and `parse` elided — an implementer cannot write them without asking.
  - FIX: Annotate every parser `(raw: unknown)`. Write all six entries out in full, each with its own `parse` and both tokens.
- **minor**: Missed documentation and comment drift. `docs/ROLES_AND_USERS.md:69` states of `password_hash`: "Never plaintext, never recoverable, never leaves the server" — this change makes the middle clause false. `master/web/src/api.ts` (comment above `resetPassword`) states "A stored password cannot be read back — it is a scrypt hash — so setting a known one is the only way an administrator can tell somebody what theirs is" — that becomes the second way. `docs/schema/` has no entry for either new table.
  - FIX: Update both comments in the same commit and add the two tables to `docs/schema/06-tenancy-permissions-and-sync.md`. A codebase whose greppable claims are false is the defect `credential-invariants.test.ts` exists to prevent.
- **minor**: `app.use('/api/settings', settingsRoutes)` must be mounted before `app.use('/api', dataRoutes)` at `master/src/http/app.ts:64` — that line is a catch-all router. The design says only "beside the others".
  - FIX: Mount it at line 59, after `/api/documents` and before the image routers.
- **minor**: "Back-fill on sign-in" is stated as "every successful sign-in", but an Office Panel signs people in OFFLINE against its own locally-minted scrypt verifier (`office/src/services/user-session.service.ts`), and that never reaches `auth.service.ts#signIn`. A counter clerk who works offline for weeks signs in daily and still fills no vault row.
  - FIX: Say "every successful ONLINE sign-in (HTTP, or the `auth:signIn` socket command at `hub.ts:573`)", and make `vaultStatus()`'s coverage figure the way an administrator discovers the gap.
- **minor**: `vaultCoverage`'s `total` is unspecified. If it counts every row in `users` it includes soft-deleted people and coverage can never reach 100%.
  - FIX: `total` counts live users only — reuse `userRepo.countUsers(tenantId)` (`user.repository.ts:303`), which already filters `whereNull('deleted_at')`.
- **minor**: `revealPassword` names `requirePermission(actor, ...)` without saying where it comes from; it is exported from `master/src/domain/actor.ts:55`, not from a service. Minor, but the design elsewhere gives file:line for everything.
  - FIX: Cite `master/src/domain/actor.ts:55`.

## Corrected design

## F — Recoverable password vault and a real server-side settings system (corrected)

**Verdict:** Two tables behind one migration. `user_password_vault` holds AES-256-GCM-sealed plaintexts under a key file outside the database and outside every backup; `settings` is a row-per-key JSONB store that is the single answer for the reveal toggle and for the AI and external-API configuration that workstreams I and J will consume. The vault is **off by default and self-purging**: `security.passwordRevealEnabled` starts `false`, nothing is written until an administrator turns it on, and turning it off deletes every stored plaintext in the same transaction. Back-fill is free — every successful online sign-in already holds the plaintext, so existing accounts seal themselves as people arrive at work.

Two things this design does **not** do, corrected from the first draft: it adds nothing to `SyncSnapshot`, and it does not pretend the new permission is ungranted on a fresh install.

---

## Part 1 — The password vault

### 1.1 The key, and what it honestly protects

The Master boots unattended on a shop PC, so the key sits on the same disk as the data. **A key beside the data is obfuscation against copying, not protection against possession.** Anyone with Administrator on that PC can read `dataDir\secrets\vault.key` and `dataDir\postgres\` together. What the separation actually buys: a stolen `.obbackup` yields nothing (§1.6); a raw `psql`/`pg_dump`/query-log read sees ciphertext; and the key never leaves `master/`.

New module `master/src/lib/secret-box.ts`, sibling to `lib/backup-crypto.ts` and copying its IV/tag/ciphertext layout (`backup-crypto.ts:45-140`) — a portable file needs a passphrase KDF, a resident secret does not, which is the only reason it is a sibling rather than a caller.

```ts
export interface SealedValue { v: 1; iv: string; tag: string; ct: string; } // base64
export class SecretBoxError extends Error {
  constructor(readonly reason: 'no_key' | 'unreadable') { super(reason); }
}
export function loadOrCreateKey(): void;
export function seal(plaintext: string, aad: string): SealedValue;
export function open(sealed: SealedValue, aad: string): string; // throws SecretBoxError
```

AES-256-GCM, 12-byte IV, 16-byte tag, 32-byte key. Key file `path.join(config.dataDir, 'secrets', 'vault.key')`, written `{ mode: 0o600 }`, holding `{"version":1,"key":"<base64>","createdAt":"…"}`.

**The key is created lazily, on first `seal`/`open`.** `loadOrCreateKey()` is called from `master/src/index.ts` inside the startup `try`, under `bootStep('Preparing secure storage')`, purely so a permissions failure is loud on the boot screen — it is a pre-flight, not the only initialiser. This matters because no integration suite runs `main()`: `master/tests/helpers/fixtures.ts:97-101` does `startTestPostgres` + `initDatabase` + `runMigrations` and imports `createApp()` directly, so a boot-only initialiser would make every vault test throw `no_key`. `master/tests/helpers/db.ts` sets `ORDERBOOK_DATA_DIR` to the throwaway cluster directory before `config` is imported, so a test run never writes a key into the developer's live `master/data/`.

**AAD, not a derived per-row key.** Every call passes ``aad = `vault:${tenantId}:${userId}` `` (or ``` `setting:${tenantId}:${key}` ``` in Part 2). GCM authenticates it, so a ciphertext copied from one user's row onto another's fails to open.

### 1.2 The tables' shape

```sql
CREATE TABLE user_password_vault (
  tenant_id              UUID NOT NULL REFERENCES tenants(id),
  user_id                TEXT NOT NULL,
  key_version            INT  NOT NULL DEFAULT 1,
  sealed                 JSONB NOT NULL,
  credential_fingerprint TEXT NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             TEXT,
  PRIMARY KEY (tenant_id, user_id)
);
```

A separate table, not a column on `users`: `USER_COLUMNS` (`user.repository.ts:39-62`) is one `u.*` regression away from carrying a new column into every list — the drift `credential-invariants.test.ts:57` exists to catch — and a named table can be excluded from the backup scan and truncated wholesale.

No FK on `user_id`, matching `party_access.user_id` (`20260313000000_party_access.ts:50`) and `users.role_id`: users are soft-deleted and restorable (`user` is a recycle-bin entity, `shared/src/domain/recycle-bin.ts:22`, with no hard-purge path), and a restored person must come back with their vault row intact.

`credential_fingerprint` is `credentialFingerprint(passwordHash)` from `panel-credential.repository.ts:44`, **reused not reimplemented**, with the live value read through `fingerprintForUser()` at `:46` — which also keeps the vault out of `user.repository.ts` entirely, so `credential-invariants.test.ts:56` ("exactly one query selects `password_hash`" in that file) stays literally true. At reveal time stored is compared to live; a mismatch reports `stale` rather than showing a password that no longer works.

### 1.3 Repository and service

`master/src/repositories/password-vault.repository.ts`:

```ts
export interface VaultRow { userId: string; sealed: SealedValue; credentialFingerprint: string; updatedAt: Date; }
export async function upsertVaultEntry(tenantId, userId, sealed, fingerprint, actorId, trx): Promise<void>;
export async function readVaultEntry(tenantId, userId, runner?): Promise<VaultRow | null>;
export async function deleteVaultEntry(tenantId, userId, trx): Promise<void>;
export async function clearVault(trx, tenantIds: string[] | null): Promise<number>;
export async function vaultCoverage(tenantId, runner?): Promise<{ stored: number; total: number }>;
```

`clearVault` takes `tenantIds` because `backup-restore.service.ts` supports a `selected`-tenant restore; `null` means all. `vaultCoverage.total` is `userRepo.countUsers(tenantId)` (`user.repository.ts:303`), which already excludes soft-deleted rows, so coverage can reach 100%.

`master/src/services/password-vault.service.ts` exposes `rememberPassword`, `revealPassword`, `forgetAll`, `vaultStatus`. `rememberPassword` no-ops when `settingsService.getSetting(tenantId, 'security.passwordRevealEnabled')` is `false`, so the write path is dead code on a default install, and it takes the fingerprint from its caller — no new `password_hash` select anywhere.

### 1.4 The write path — five moments, all already holding the plaintext

1. `user.service.ts#createUser` — `password` and `passwordHash` both in scope; inside the existing `db().transaction`.
2. `user.service.ts#resetPassword` — same, inside its transaction.
3. `auth.service.ts#changeOwnPassword` (`:234-236`) — `input.newPassword` and `passwordHash`, inside the transaction.
4. `setup.service.ts#runFirstTimeSetup` — the first administrator. Wired but a no-op while the toggle is false.
5. **Every successful ONLINE sign-in** — `auth.service.ts#signIn`, and therefore also the `auth:signIn` socket command at `hub.ts:573`. This is the back-fill.

**Correction on 4 and 5, and it is load-bearing.** `signIn` rewrites `password_hash` from bcrypt to scrypt inside its transaction (`auth.service.ts:98-108`), and `setup.service.ts:51` hashes the first administrator with `bcrypt.hash(password, 10)`. Sealing `credential.passwordHash` would store a pre-upgrade fingerprint that never matches, so the shop's own admin account would report `stale` on its first reveal. **Seal after the transaction, taking the fingerprint from `panelCredentialRepo.fingerprintForUser()`** — the exact call `signIn` already makes at `:134-137`, whose comment says why. Seal when `readVaultEntry()` is `null` or its fingerprint differs.

An Office Panel signing somebody in **offline** verifies against its own locally-minted scrypt verifier and never reaches the Master, so a clerk who works offline for weeks fills no vault row. `vaultStatus()` returns `{ enabled, stored, total }` so the Settings screen shows that gap as a number.

### 1.5 The read path

New permission `users.viewPassword` in `CAPABILITIES` (`shared/src/domain/permissions.ts:117`, group `'admin'`, `labelToken: 'permission.users.viewPassword'`) and in `MINIMUM_TIER` as `'admin'`.

**Stated plainly, against the first draft:** the migration grants it to nobody, but on a **fresh** install the seeded Administrator holds it anyway, because `20260303000000_roles_and_users.ts:331` updates that role with a *live* `allPermissions()` import. Only an upgraded installation starts with nobody holding it. `master/tests/helpers/fixtures.ts:244` inherits the same widening, so every `testActor()` holds the key — which is why the permission is **not** the safety control. The control is `security.passwordRevealEnabled`, `false` on both.

Route, in `access.routes.ts` after the reset-password handler:

```ts
accessRoutes.post('/users/:id/reveal-password', needs('users.viewPassword'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await passwordVaultService.revealPassword(String(req.params.id),
      String(req.body?.confirmPassword ?? ''), actorFromRequest(req), req.sessionToken));
  }));
```

POST so it never enters a URL, history, referrer or proxy log; `no-store` so it is not cached; a route of its own so it cannot ride along in `GET /api/access/users`, which `master/web/src/api.ts` refetches on every AccessScreen mount. Handlers 16→17, guards 14→15, so `credential-invariants.test.ts:88`'s `- 2` still holds — but note that file's guard filter (`:78`) does **not** strip comments, unlike its fields/logs/reports siblings, so a comment containing `needs(` added to this router breaks it.

`revealPassword` runs, in order: `requirePermission(actor, 'users.viewPassword')` (`master/src/domain/actor.ts:55`); refuse with `ForbiddenError('users.viewPassword', 'error.forbidden.passwordRevealDisabled')` when the toggle is off; `userRepo.findById` → `NotFoundError('User')`; **re-authentication** via `userRepo.readCredentialById` (`:165`) + `verifyPassword` (`lib/password.ts:51`), failing to `UnauthorizedError('error.unauthorized.currentPasswordIncorrect')`, cached five minutes per session token; staleness check against `fingerprintForUser()`, mismatch or missing → `ConflictError('error.conflict.passwordNotStored', {})`; `open(...)`, a `SecretBoxError` becoming `ConflictError('error.conflict.vaultUnreadable', {})` with **no ciphertext, lengths or key path** in message, params or details, because `error-handler.ts:30-36` echoes all three verbatim; **audit before responding**, committed first; then return `OneTimeSecret`.

The re-auth cache is two exports beside the `sessions` map — `noteRecentReauth(token)` / `hasRecentReauth(token)` — swept by a second loop **added inside** `purgeExpiredSessions()` (`auth.service.ts:297`, which today iterates `sessions` only) and cleared by `resetAuthState()` (`:292`), or it reproduces the cross-test leak that function's own comment was written for.

**Return type:** `OneTimeSecret` (`shared/src/domain/inputs.ts:313-317`), already `{ userId, username, password }`, already rendered by `OneTimeSecretDialog` (`AccessScreen.tsx:276`). No new shared file, no `shared/src/index.ts` edit, no new dialog. `VaultStatus` goes beside it in `inputs.ts`.

No rate limit: the caller is admin-tier, holds a deliberately-checked key, has re-authenticated, and every use is an `activity_log` row on a table that refuses UPDATE and DELETE by trigger. An unswept `Map` would repeat the defect at `auth.service.ts:48`.

### 1.6 The six guarantees that it never reaches Office

1. **Snapshot** gains no vault key; `snapshot.service.ts` returns a literal.
2. **`SNAPSHOT_POLICY`** (`office/src/http/app.ts:949`) is untouched and must not be softened.
3. **Socket:** there is no `access:*` or `user:*` command in `hub.ts` (verified across every `socket.on`), and `DIRECTORY_ENTITIES` (`:199`) already withholds `user` change events from `ROOM_OFFICE_PANELS`. The vault write path calls no `publishChange` at all.
4. **Activity log:** `renderActivity` (`shared/src/i18n/activity.ts:47-49`) copies every string or number in `details` into the rendered sentence, so `details` may carry `name` (the username) and nothing else, forever.
5. **CSV/reports:** `exportLogs` (`log.service.ts:207`) builds rows from `activity_log` only, so (4) covers it.
6. **Backups:** `backup.repository.ts:40` becomes `EXCLUDED_TABLES = new Set(['knex_migrations','knex_migrations_lock','user_password_vault'])`, filtered by `listUserTables()` (`:42`) — export omits it and `loadTables` never truncates or writes it. **This must land in the same commit as the table**, or every backup taken between the two commits carries the ciphertext out of the building. Because `loadTables` no longer truncates it, `backup-restore.service.ts` calls `clearVault(trx, tenantIds)` unconditionally beside the existing `revokeAllOfficePanels` (`:97`): a restore reinstates different `users` rows and surviving vault entries would be orphans keyed to ids that may now mean somebody else.

### 1.7 Tests

`credential-invariants.test.ts` is **not relaxed**. Its three credential assertions were traced against the new write path and none is in the way: the vault never calls `readCredentialForVerification` (count stays 1 in `auth.service.ts`); it lives in its own table and reuses `panel-credential.repository.ts` for the fingerprint (the `password_hash` select count in `user.repository.ts` stays 1); `mapUser` is untouched.

New `master/tests/password-vault-invariants.test.ts`, source-reading:

1. `open(` from `secret-box.ts` has exactly one caller outside `lib/`: `password-vault.service.ts#revealPassword`.
2. The literal `user_password_vault` appears in exactly **three** files under `master/src`, and they are the migration, `password-vault.repository.ts`, and `backup.repository.ts`. (The first draft said two, which contradicted its own §1.6(6).)
3. `office/src` and `office/web/src` contain zero occurrences of `user_password_vault`, `revealPassword`, `reveal-password`, `secret-box`.
4. `shared/src/domain/entities.ts` matches no `/^\s*password\??:/m`.
5. `backup.repository.ts` lists the vault table in its exclusion set and `backup-restore.service.ts` calls `clearVault`.
6. No `recordActivity` window inside `password-vault.service.ts` contains `password` or `plaintext`.
7. The reveal route is declared `post` and sets `no-store`.

### 1.8 Residual risk, plainly

Once switched on, every password of every person who signs in online afterwards is recoverable by anyone who can read the Master PC's `dataDir`. The encryption stops a copied database file and a stolen backup, and nothing else. Inside the app it is one admin-tier permission — which a fresh install's Administrator already holds — plus a re-typed password away, and every use is a permanent audit row: misuse is visible, not prevented. People reuse passwords, so the blast radius is their email and their bank. Off by default, purged when switched off, and every reveal logged is the most that can honestly be offered.

---

## Part 2 — The settings system

### 2.1 Shape

Rejected: typed columns on `master_config` (a migration per toggle is what makes people stop adding toggles). Rejected: one JSONB blob (no per-key audit, no per-key secret handling, a read-modify-write race on every save). Chosen: a row per key, the shape `option_lists` already establishes.

```sql
CREATE TABLE settings (
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  "key"       TEXT NOT NULL,
  "value"     JSONB,
  is_secret   BOOLEAN NOT NULL DEFAULT false,
  key_version INT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  PRIMARY KEY (tenant_id, "key")
);
```

Columns quoted because `key`/`value` read badly unquoted in raw SQL. No `version`/`hlc`/`field_hlc`: settings never sync, and `settings` is deliberately absent from `sync.service.ts`'s `COLUMN_MAP`. A secret stores a `SealedValue` as its `value` with ``aad = `setting:${tenantId}:${key}` ``. `key_version` exists for the same reason the vault has one. Absent row means the declared default, so the migration inserts nothing and an upgraded installation behaves exactly as it did the minute before.

### 2.2 Declared once, typed end to end

`shared/src/domain/settings.ts`, modelled on `fields.ts`'s `FIELD_LIST_KEYS`:

```ts
export interface SettingDefinition<T> {
  labelToken: MessageKey;
  descriptionToken: MessageKey;
  fallback: T;
  parse: (raw: unknown) => T;   // the single validation site; throws on anything it will not accept
  secret?: boolean;             // stored sealed; the read endpoint returns `configured`, never the value
}
```

Every parser is explicitly annotated `(raw: unknown)` — `tsconfig.base.json` sets `strict: true`, and `as const satisfies` does not contextually type a parameter through the assertion. Five keys, each written out in full with both tokens and its own parser: `security.passwordRevealEnabled` (`false`), `ai.provider` (`{ kind: 'off' }`), `ai.apiKey` (`''`, `secret: true`), `externalApi.enabled` (`false`), `externalApi.connectors` (`[]`). `SettingKey = keyof typeof SETTINGS`; `SettingValue<K> = ReturnType<(typeof SETTINGS)[K]['parse']>`, the same technique `ParamsFor<K>` uses in `shared/src/i18n/keys.ts`.

**There is no `audience` field and no `writePermission` field.** Every setting here is Master-only, and every write is gated on `settings.manage` alone. `writePermission: 'users.viewPassword'` on the reveal toggle was a deadlock: on an upgraded install nobody holds that key, so nobody could turn the feature on; and it gated turning the feature **off**, leaving an administrator who revoked the key with plaintexts they could not purge.

### 2.3 Service, cache, audit

`master/src/services/settings.service.ts` exports `getSetting<K>`, `readSettings(actor)`, `writeSetting<K>`, and `invalidateSettingsCache()`.

`getSetting` is the internal accessor with **no permission check** — the vault service reading its own toggle is not a user-facing read. It is cached per tenant behind an in-process version counter bumped on write, deliberately not a TTL, for the reason `auth.service.ts:11-15` states. It falls back to `definition.fallback` on a missing row, on a `parse` throw, **and on a `SecretBoxError`**, logging a warning each time — the last is not optional: `settings` travels inside backups while `vault.key` does not, so a restore on a new machine leaves every sealed value unopenable, and `open()` throws before `parse` ever runs.

`readSettings` requires `settings.manage` and returns `{ key, value, isDefault, updatedAt, updatedBy }` per key; for `secret: true` it returns `{ configured: boolean }` with **no `value` field at all** — absent, not null, the rule `shared/src/domain/visibility.ts` applies to masked rates — and `configured: false` when the value cannot be opened.

`writeSetting` requires `settings.manage`, runs `parse` (failure → `ValidationError('validation.setting.invalid', { key })`), seals when secret, upserts, and bumps the cache version. **One named special case:** setting `security.passwordRevealEnabled` to `false` calls `clearVault(trx, [actor.tenantId])` in the same transaction, with the count in the audit details. A switch that stops the display while leaving the plaintexts is a switch that lies.

Every write is audited through `activityLog.recordActivity(entry, actor, trx)` with the **full six-field entry** the type requires (`activity-log.repository.ts:45-53`) — `tenantId`, `entityType: 'setting'`, `entityId: key`, `action: 'updated'`, `actorType`, `actorId` — copying the shape at `log.service.ts:238-252`. Details are `{ name: key, from: String(before), to: String(after) }` for plain values and `{ name: key }` for secrets: `renderActivity` copies only `string | number` into params and `translate.ts#fill` leaves an unmatched placeholder **verbatim**, so a raw boolean or object would render "…from {from} to {to}" in the Logs screen.

**Cache invalidation is a two-call obligation the first draft missed.** `master/tests/helpers/fixtures.ts:220-223` calls `invalidateRoleCache()`, `invalidatePipelineCache()` and `invalidateFieldCache()` inside `resetData()` precisely because in-memory caches survive a `TRUNCATE`; `invalidateSettingsCache()` joins them, or a `true` toggle leaks into the next suite and, with `fileParallelism: false`, surfaces somewhere unrelated. It is also called after the restore transaction commits in `backup-restore.service.ts`, which replaces the table without going through `writeSetting`. (The same file's failure to call `invalidateRoleCache()` after a restore is the identical pre-existing defect and is worth fixing in this commit.)

### 2.4 Reaching the frontend

New `master/src/http/routes/settings.routes.ts`, mounted `app.use('/api/settings', settingsRoutes)` **before** `app.use('/api', dataRoutes)` at `master/src/http/app.ts:64`, which is a catch-all. `GET /` and `PUT /:key` need `settings.manage`; `GET /vault-status` needs `users.viewPassword`. Zero exemptions.

`master/web/src/api.ts` gains `settings()`, `saveSetting(key, value)`, `vaultStatus()`, `revealPassword(userId, confirmPassword)` beside the existing access calls. The screens are frontend work; this design fixes the wire shapes only.

**No `SyncSnapshot` change.** The first draft added a required `settings` field. Every field added to that interface since it shipped is optional and says why — `partyGrants?`, `builtForUserId?`, `serverVersion?` (`shared/src/protocol/socket.ts:295-321`) — because `office/src/sync/local-store.ts:56` parses a file the *previous* version wrote, and a required field is `undefined` at runtime while typed present, breaking the offline start the file exists for. It would also break `office/tests/dashboard-staleness.test.ts:29` and `office/tests/snapshot-masking.test.ts`. And nothing reads a shared setting today. Workstream J adds `settings?: SharedSettings` — optional, absent-means-default — when it has a consumer, and pays for the `SNAPSHOT_POLICY` entry then.

**Per-machine settings stay in `localStorage`**, via `master/web/src/ui/theme.ts` (`ob.theme.v2`, `ob.density`, `ob.motion`, plus workstream C/E's UI-scale and keybinding keys). The rule, written into the settings module's header: *if two people at the same PC should see it differently, it is localStorage; if it is a decision the company made once, it is the settings table.* A 4K screen is a property of the desk, not the company.

### 2.5 Migration and registry bookkeeping

One file, `master/src/db/migrations/20260314000000_settings_and_password_vault.ts`, creating both tables, inserting no rows and granting no permission. `down()` drops both.

1. Import it in `master/src/db/migrations/index.ts`.
2. Insert `{ name: '20260314000000_settings_and_password_vault', ... }` **after `20260313000000_party_access` (`:76`) and before the pinned `20260309000000_new_module_permission_grant` (`:81-84`)**. `migration-registry.test.ts:73` filters `DELIBERATELY_LAST` out of the ascending check; `:80` pins `20260309` last. The 14-digit rule and the name-uniqueness rule are met.
3. Do **not** touch `SHIPPED` (`:108-126`) now — that list means "has run on a real installation". Append when it has; never remove.
4. `master/tests/helpers/fixtures.ts:25` `DATA_TABLES` gains `'user_password_vault'` before `'users'` and `'settings'` before `'master_config'`. Neither has an FK to `users`, so order is free; both must be listed or every integration suite leaks rows into the next. No `seededX` capture is needed — no migration seeds either table, so every row is unconditionally test data.

### Files

**New:** the migration; `master/src/lib/secret-box.ts`; `master/src/repositories/password-vault.repository.ts`; `master/src/repositories/settings.repository.ts`; `master/src/services/password-vault.service.ts`; `master/src/services/settings.service.ts`; `master/src/http/routes/settings.routes.ts`; `shared/src/domain/settings.ts`; and the tests below.

**Modified:** `master/src/db/migrations/index.ts`; `master/src/index.ts` (boot pre-flight); `master/src/http/app.ts` (mount before `:64`); `master/src/http/routes/access.routes.ts`; `master/src/services/user.service.ts`, `auth.service.ts` (seal after the transaction, plus the re-auth map in `purgeExpiredSessions` and `resetAuthState`), `setup.service.ts`; `master/src/repositories/backup.repository.ts` (`EXCLUDED_TABLES`); `master/src/services/backup-restore.service.ts` (`clearVault` + `invalidateSettingsCache`); `shared/src/domain/permissions.ts` (`CAPABILITIES`, `MINIMUM_TIER`); `shared/src/domain/inputs.ts` (`VaultStatus` beside `OneTimeSecret`); `shared/src/index.ts` (export `./domain/settings.js`); `shared/src/i18n/en.ts` **and** `hi.ts` (`permission.users.viewPassword`, `activity.user.password_revealed`, `activity.setting.updated`, the `setting.*` label/help pairs, `error.forbidden.passwordRevealDisabled`, `error.conflict.passwordNotStored`, `error.conflict.vaultUnreadable`, `validation.setting.invalid` — `shared/tests/i18n-coverage.test.ts` fails on any EN key missing from HI, and on a placeholder-set mismatch); `master/web/src/api.ts` (four calls, **and** the now-false comment above `resetPassword` claiming a stored password cannot be read back); `master/tests/helpers/fixtures.ts` and `master/tests/helpers/db.ts`; `docs/ROLES_AND_USERS.md:69` (which currently asserts `password_hash` is "never recoverable"); `docs/schema/06-tenancy-permissions-and-sync.md` (the two new tables).

### Tests

`master/tests/password-vault-invariants.test.ts` (the seven guards above). `master/tests/password-vault.integration.test.ts`: refused while the toggle is false even for a key holder; no row written on a sign-in while false; back-fill after true; a bcrypt-hashed account sealed correctly on its **first** sign-in, not stale; a subsequent `resetPassword` re-seals; a hand-mutated `password_hash` reports stale rather than a wrong password; wrong `confirmPassword` throws `UnauthorizedError`; exactly one `activity_log` row per reveal, `details` containing only `name`. `master/tests/settings.integration.test.ts`: fallback for an absent row; `ForbiddenError` without `settings.manage`; secret round-trip with `value` structurally absent from `readSettings`; an unopenable sealed value reported as `configured: false` rather than throwing; the toggle set to false deleting every vault row in the same transaction; two consecutive writes both visible immediately. `master/tests/access.integration.test.ts`: 403 for a caller holding `users.manage` but not `users.viewPassword`. `master/tests/backup-chain.integration.test.ts`: exported payload has no `user_password_vault` key; the live table is empty after a restore. `shared/tests/settings.test.ts`: every key has EN and HI label and help tokens, and every `parse` accepts its own `fallback` and rejects a wrong-shaped value. `master/tests/i18n-tokens.test.ts` and `migration-registry.test.ts` pass unchanged once the tokens and the registry entry exist — both are forcing functions, not chores.

### Not doing

No key rotation loop (`key_version` exists on both tables so it needs no schema change later; the plaintexts are right there to re-seal). No TPM/DPAPI/hardware store — none survives an unattended boot, and each buys the appearance of protection against the same attacker. No rate limit on the reveal endpoint (audit row is the control; an unswept `Map` would repeat `auth.service.ts:48`). No recovery for accounts that never sign in online again. No per-setting UI schema — five settings do not justify a form generator, and `parse` is the one validation site the server trusts. No settings history table — the `activity_log` row carries `{ name, from, to }`. No office-side settings write path, and no shared-audience read path in this workstream. No relaxation of `credential-invariants.test.ts`.