# Design: Server Master tier, master key, two Server Master users, highlight badge, report-scope rule, complete audit logging (rule 4)

> Written before the code (2026-10-01). Where it disagrees with docs/plans/1.3-BATCH-DETAIL.md, the integrated plan wins.

## Overview

A fourth role tier, 'server_master', is appended last to ROLE_TIERS. That ranks it above admin through tierRank, so G3, MINIMUM_TIER, keysAboveTier and effectivePermissions need no change. RoleTierName becomes an alias of RoleTier, and the hand-typed tier unions in inputs.ts point at RoleTier. One migration widens roles_tier_check and seeds one reserved is_system role, 'Server Master', per tenant, holding a frozen inline copy of today's 53 keys. This tier is reserved for that one role: no other role may be created at it or moved to it, and the role itself is frozen (no rename, no permission edit, no delete). G1 assertAdminTier, readAdministrativeCapability (G4) and catalogue-seed administratorActor are changed to count tier >= admin. A new pure target-tier guard (assertMayManageUser) refuses any user operation whose target ranks above the actor: update, deactivate, delete, restore, reset, password reveal and avatar. So an admin sees Server Master rows, highlighted, but has no controls on them. A new preservation rule (assertServerMastersRetained) runs under the existing lockTenantAccessGuards advisory lock and refuses any change that would leave fewer than two active Server Masters. Panels can never be assigned the Server Master role.

Sign-in: authService.signIn gains an onMasterPc option. Only the Master HTTP route sets it, from isLoopback(req), now exported from master/src/lib/network.ts. A Server Master is refused on LAN browsers and on every Office panel, including an Office running on the Master PC itself, because the panel path checks the tier, not the address. Session resolution refuses a Server Master session presented from a non-loopback address or through auth:assume or resolvePanelActor. The Office also refuses to mint a verifier for a server_master user, and auth:reconcile tells panels to forget any cached verifier for a user who is now a Server Master.

Master key '<master key, see docs/MASTER_KEY.md>': stored as MASTER_KEY_HASH (scrypt) in shared/src/domain/master-key.ts, with the plaintext only in docs/MASTER_KEY.md. It is verified by a second instance of the existing createDeveloperGate (5 failures lock it for 60 s; it issues a 5-minute token sent in the x-master-key-token header). The token is required to:
- change a Server Master's username or password (own change or reset of the other);
- move any user onto, or off, the Server Master role;
- deactivate or delete a Server Master;
- change the Master pairing password (a new small feature in Settings > Connection).
On the Master PC sign-in screen, 'Forgot Server Master password?' uses the key to reset a Server Master's password.

First run: SetupFlow asks the owner to type two Server Master accounts (prefilled 'master' and 'master-backup', each password entered twice). No 'admin' is created, and the pairing password is still generated and shown once. Existing installs, or a restore from an older backup: GET /api/setup/status reports serverMasterSetupNeeded while fewer than two active Server Masters exist. On the Master PC the sign-in screen then opens a one-time flow (master key, then the missing accounts) with a 'Not now' exit, so existing users keep working. /api/setup/initialize and /api/setup/restore(/preview) become loopback-only.

Highlight: tier.* tokens and a shared TierPill / ServerMasterBadge with a new 'master' pill tone. Avatar gains a highlight ring and DataTable a rowHighlight hook. Together these are used in the Users list, the footer, the Logs actor (ActivityActor.tier, optional), and by the presence, chat and printroom domains.

Reports: shared/src/domain/report-scope.ts exports reportScopeFor and canReportOn. Office and Management users can report only on themselves; admins and Server Masters can report on anyone. The reports domain calls these.

Audit: every gap from map 2 is closed with the existing recordActivity (last statement in the transaction) or recordDetachedActivity (attempts, sign-out/expiry, uploads from another machine). New tokens go in under append-only rules, and new audit kinds are defined for chat admin actions, printroom jobs, the master key, Server Master accounts and backups. An optional richer-sentence layer, activityDetail.<entity>.<action>, renders delete entries with the PO number and party, and setting.updated with the translated label and from→to, without touching old rows. *Token detail fields are translated at render time. The Logs screen moves to ui/ so both panels mount it: the Office gains it under logs.view, the dropdowns are translated, and the CSV gains 'sentence' and 'details' columns.

## decisions

- Server Master is a TIER (ROLE_TIERS = ['office','management','admin','server_master']) with exactly one reserved is_system role 'Server Master'. createRole/updateRole refuse tier 'server_master' (validation.role.serverMasterReserved), and the role itself is fully frozen (validation.role.serverMasterLocked): name, permissions, tier, delete. Reason: one obvious authority and no second 'super' role to audit.
- The migration is the FIRST migration of this batch (20261001000000) so every later grant migration in the batch sees the role. Rule for other domains: grant to whereIn('tier',['admin','server_master']). An integration test pins 'Server Master role === allPermissions()' on a fresh DB, so a missed grant fails CI.
- Admins SEE Server Master users (highlighted) but every control on them is absent: edit, deactivate, delete, reset, reveal and avatar. The service refuses regardless (assertMayManageUser: target rank > actor rank -> ForbiddenError('users.manage','error.forbidden.serverMasterTarget')). Admins may still manage other admins, as today.
- A Server Master may manage the other Server Master. Credential changes (username/password), role moves onto or off Server Master, deactivation and deletion of a Server Master all need a live master-key token. At least two ACTIVE Server Masters must always remain (assertServerMastersRetained). Enforcement is 'after < min(before, 2)', so an upgrade with zero Server Masters is never blocked.
- Master key = scrypt MASTER_KEY_HASH in shared/src/domain/master-key.ts. The plaintext '<master key, see docs/MASTER_KEY.md>' lives only in docs/MASTER_KEY.md. ORDERBOOK_MASTER_KEY in .env overrides it, mirroring ORDERBOOK_DEVELOPER_PASSWORD, so tests never embed the plaintext. The hash is generated once with master/src/lib/password.ts hashPassword and pasted in.
- Gate: reuse createDeveloperGate by adding options {passwordHash, overrideEnv, wrongPasswordKey, tokenTtlMs} with unchanged defaults. masterKeyGate is a second instance (5 failures -> 60 s lock, process-wide counter, 5-minute in-memory tokens, header x-master-key-token).
- Server Master sign-in only on the Master PC: the HTTP sign-in passes onMasterPc = isLoopback(req). signIn refuses tier server_master unless onMasterPc, AFTER the password verifies, so it is not a username oracle, and it records sign_in_failed with details.reason='masterPcOnly'. Admins may still sign in from LAN browsers.
- Defence in depth for sessions: resolveSessionWithPermissions(token, remoteAddress) returns null for a Server Master session unless the address is loopback. auth:assume and resolvePanelActorAllowingRefusal reject Server Master tokens outright (reason 'expired', since the panel never held a verifier). findRevokedOfflineCredentials forgets any claim whose user is now a Server Master. The Office signInAgainstMaster refuses to remember a server_master user.
- Forgot password: on the Master PC sign-in screen the master key lets you reset a Server Master's PASSWORD (not username). It also clears that username's sign-in lockout and ends that user's sessions.
- The Master ID (master_unique_id) is NOT made changeable: changing it would orphan every paired panel's credentials.masterUniqueId. The pairing password IS changeable by a Server Master on the Master PC with the master key. Already-paired panels are unaffected because they use their own secrets.
- Fresh setup: the owner types both accounts (username, display name, password + confirm; min length via assertPasswordLongEnough; usernames distinct). Passwords are hashed with scrypt (hashPassword), not bcrypt. The response no longer echoes passwords. The pairing password is still generated and shown once.
- Existing installs: the upgrade flow is non-blocking. The Master-PC sign-in screen opens 'Set up Server Master accounts' first, with a 'Not now' link, every time until two active Server Masters exist. It asks for (2 - active) accounts. ensureServerMasterRole() re-creates the role if a restore from an older backup lacks it.
- /api/setup/initialize, /api/setup/restore/preview and /api/setup/restore become loopback-only (requireLoopback middleware -> 403 error.forbidden.masterPcOnly). /api/setup/status stays open and adds onMasterPc and serverMasterSetupNeeded.
- Report scope rule: office/management -> self only (owner_id = self). Admin -> anyone, including other admins and Server Masters (owner said 'anyone's'). Server Master -> anyone. 'All users' aggregate reports only for tier >= admin.
- Display names: tier.server_master 'Server Master', tier.admin 'Admin' (the owner's 'Normal Admin'), tier.management 'Management', tier.office 'Office'. Hindi: 'सर्वर मास्टर' / 'एडमिन' / 'मैनेजमेंट' / 'ऑफ़िस'.
- Highlight: a new PillTone 'master' (solid var(--accent) fill, var(--fg-on-accent) text). The Avatar prop highlight draws a 2px var(--accent) ring. DataTable rowHighlight sets data-highlight, styled with var(--accent-tint) plus a 3px var(--accent) left rail. Only semantic tokens are used.
- The sign-in username prefill 'admin' is removed (empty, autofocused), because fresh installs have no 'admin'.
- Audit scope (rule 4): every business, settings, user, security, panel-admin, export and backup operation is logged. NOT logged into the hash chain: individual chat messages, presence heartbeats, print status ticks and natural panel connect/disconnect. These would serialise every tenant write on the chain lock.
- Richer sentences without breaking append-only: renderActivity first tries activityDetail.<entity>.<action> and uses it only when every placeholder is present in the details. Detail fields ending in 'Token' are translated (e.g. labelToken -> {label}). Old rows keep their existing sentence. activity.* tokens are never changed.
- Panel revoke gets its own action 'revoked' (new token), and admin disconnect gets 'disconnected'. recordPanelActivity gains an action parameter. Old rows stay 'updated'.
- Conflict resolution is logged under the conflicted entity's own type (lead/order/party/product) with actions conflict_kept / conflict_restored, so partyScopeLogSql still narrows it. A 'sync_conflict' type would leak to party-restricted readers.
- Sign-out is logged (detached). Session expiry is logged by the sweep (detached, one row per expired session; Session gains username, displayName, source). Office offline sign-ins are queued locally (capped at 500, oldest dropped) and uploaded on reconnect through the new auth:offlineEvents command. They are written detached, with the real time in details.at.
- Developer tools: unlock / unlock_failed / lock are logged (detached). resetAllData writes developer.data_erased into the fresh database after the reset (system actor). seedDummyUsers logs developer.dummy_users_seeded and never touches a Server Master. When seeding runs setup itself it creates the documented dummy Server Masters 'master' / 'master-backup' (passwords in docs/DEVELOPER_MODE.md).
- The Logs screen moves to ui/src/LogsScreen.tsx with an injected LogsApi. The Master mounts it as today. The Office mounts it gated by logs.view (party scope applies server-side) with no Alt chord (OFFICE_NAV is full), reachable from the sidebar System group, a Basic Home tile and the command palette.
- Log CSV keeps its 9 columns in order and appends 'sentence' (rendered in the requested ?locale=en|hi, default en) and 'details' (JSON) at the end, so existing consumers keep working.
- No new permission keys: Server-Master-only actions are gated by tier plus the master key, not by a grid key that an admin might try to grant.

## dataModel

- 20261001000000_server_master_tier.ts (new; appended to master/src/db/migrations/index.ts AFTER '20260401000000_order_vehicle_number' and to the DELIBERATELY_LAST tail in master/tests/migration-registry.test.ts). up():
-   1) ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_tier_check; ALTER TABLE roles ADD CONSTRAINT roles_tier_check CHECK (tier IN ('admin','management','office','server_master')). DROP CONSTRAINT is allowed by migration-data-safety.test.ts.
-   2) For each tenant (SELECT id FROM tenants), skip if a live role with tier='server_master' already exists (idempotent). Otherwise allocate the id from id_sequences entity 'role' with an inline UPDATE ... RETURNING / INSERT ... ON CONFLICT ('RL' + lpad(n,10,'0'), the same format as identity.repository allocatePermanentId). INSERT INTO roles (id, tenant_id, name, tier, permissions, is_system, created_by, hlc, field_hlc) VALUES (…, 'Server Master', 'server_master', <FROZEN_53_KEYS JSON sorted>, true, NULL, NULL, '{}'). The name falls back to 'Server Master (system)' if a live role already uses lower(name)='server master' (roles_name_unique).
-   FROZEN_53_KEYS is inlined and never imported from @orderbook/shared (precedent 20260304): leads.view/create/edit/delete/export/bulk; orders.view/edit/delete/export/bulk; parties.view/create/edit/delete/export/bulk; products.view/create/edit/delete/export/bulk; inventory.view/edit/export; reports.view/export; roles.view/create/edit/delete; logs.view/export; lead.convert; orders.dispatch; record.reassignOwner; stock.adjust; users.manage; users.viewPassword; roles.assign; panels.manage; settings.manage; storage.manage; fields.manage; api.manage; logs.verifyChain; sync.resolveConflicts; recycleBin.view; recycleBin.viewAll; fields.view; party.accessAll; party.assign.
-   down(): empty (comment: widening a CHECK and a seeded system role are not reversed; restore from a backup).
- No other tables or columns. Users need no column: 'main' vs 'backup' Server Master is only a setup-form label. Owner-id indexes for report scoping belong to the reports domain's migration.
- No backfill: existing admins stay admins. Server Master users are created by the upgrade flow (master key) on the Master PC.

## permissions

- No new permission keys and no MINIMUM_TIER entries. Every existing key is held by the server_master tier, because isPermittedForTier ranks it above admin.
- Seeded role 'Server Master' (tier server_master, is_system=true) holds the frozen 53-key list, i.e. allPermissions() as of today, which includes record.reassignOwner, leads.create/delete, orders.delete and party.accessAll. That satisfies 'master panel has all users' pending order creation and delete authority'.
- Rule binding on every other domain's grant migration in this batch: grant new keys to whereIn('tier',['admin','server_master']), with timestamps after 20261001000000. master/tests/server-master.integration.test.ts asserts the role's stored permissions equal allPermissions() on a fresh DB.
- Tier gates (not keys): Server-Master-only operations are master-key verify/recover/setup accounts, pairing-password change, managing Server Master users and assigning the Server Master role. They are enforced by actor.permissions.tier === 'server_master' plus masterKeyGate.assertUnlocked(token).

## interfaces

- NEW REST (master/src/http/routes/master-key.routes.ts, mounted at /api/master-key, every route behind requireLoopback):
-   POST /api/master-key/verify {key} -> {token, expiresAt}. Unauthenticated, so recovery works before sign-in. 401 error.unauthorized.masterKey, 429 while locked. Writes master_key.verified / master_key.failed (detached).
-   POST /api/master-key/lock (header x-master-key-token) -> {ok:true}
-   GET /api/master-key/server-masters (token) -> {accounts:[{id,username,displayName,isActive}], needed:number}
-   POST /api/master-key/server-masters (token) {accounts:[{username,displayName,password}]} -> 201 {accounts:[{id,username,displayName}]}. Creates exactly `needed` accounts (2 - active), calling ensureServerMasterRole first. Refused if needed=0.
-   POST /api/master-key/recover (token) {userId,newPassword} -> 204. Target must be a live Server Master.
- NEW REST: POST /api/setup/pairing-password (requireAuth, requireLoopback, actor tier server_master, header x-master-key-token) -> {pairingPassword}, shown once. Writes master_config.pairing_password_changed.
- CHANGED REST:
-   GET /api/setup/status -> {setupComplete, onMasterPc?: boolean, serverMasterSetupNeeded?: boolean}
-   POST /api/setup/initialize (loopback-only) body {companyName?, accounts:[{username,displayName,password},{...}]} -> FirstRunCredentials {masterUniqueId, accounts:[{username,displayName}], pairingPassword, lanIps, port}. The username/password fields are removed and the duplicate type in master/web/src/api.ts is updated.
-   POST /api/setup/restore/preview and /api/setup/restore become loopback-only.
-   POST /api/auth/sign-in now passes {onMasterPc: isLoopback(req)}. A Server Master off the Master PC gets 401 error.unauthorized.serverMasterMasterPcOnly.
-   POST /api/access/users, PUT /api/access/users/:id, DELETE /api/access/users/:id, POST /api/access/users/:id/reset-password and POST /api/access/me/password read the optional header x-master-key-token and pass it to the service as {masterKeyToken}. The needs() lines are unchanged, so the credential-invariants count is unchanged.
-   GET /api/logs/export?locale=en|hi (Master and Office forward) gains columns sentence, details.
- NEW socket C->S (shared/src/protocol/socket.ts ClientToServerEvents, registered in hub.ts registerAuthCommands): 'auth:offlineEvents': (events: OfflineAuthEvent[], ack: CommandAck<{recorded:number}>). Accepts at most 500 events per call; each is validated (username <= 100 chars, at = ISO, success boolean).
- Changed socket handling, no shape change: 'auth:signIn' refuses server_master. 'auth:assume' rejects a server_master token with {status:'rejected', reason:'expired'}. 'auth:reconcile' forgets server_master users.
- No new S->C pushes and no Office SSE event types: user/role changes keep riding publishChange('user'|'role').
- Wire types (shared):
-   RoleTier gains 'server_master'.
-   RoleTierName = RoleTier, the alias in entities.ts. inputs.ts RoleInput.tier, PartyAccessAssignee.roleTier and AssignablePerson.roleTier become RoleTier.
-   ActivityActor.tier?: RoleTier (optional; filled by listEntries via a LEFT JOIN users->roles when actor_type='user').
-   OfflineAuthEvent {username: string; userId?: string; success: boolean; at: string}.
-   MASTER_KEY_TOKEN_HEADER = 'x-master-key-token'; MasterKeyUnlock {token, expiresAt}; ServerMasterAccountInput {username, displayName, password}.
-   SERVER_MASTER_TIER const plus isServerMasterTier(tier) in permissions.ts.
-   reportScopeFor(actor:{userId,tier}) -> {kind:'everyone'} | {kind:'self',userId} and canReportOn(actor:{userId,tier}, target:{userId,tier}): boolean, in shared/src/domain/report-scope.ts.
-   The UI component TierPill({tier}) / ServerMasterBadge exported from ui/src/index.ts, for the presence, chat and printroom domains.
- Desktop IPC: none.

## settings

- None. No SETTINGS entries or CompanyFeatures fields are needed: Server Master behaviour is fixed by tier and master key, and the Reports-visibility settings belong to the reports domain.

## uiScreens

- ui/src/TierPill.tsx (new, shared): TierPill renders StatusPill with tone by tier (server_master->'master', admin->'conflict', management->'accent', office->'default') and label t(`tier.${tier}`), falling back to the raw tier for an unknown tier from a newer Master. ServerMasterBadge = TierPill for server_master plus a crown-less 'shield' glyph from ui/src/icons.tsx (add one icon). Exported from ui/src/index.ts.
- ui/src/DataDisplay.tsx: PillTone += 'master'. ui/src/base.css: add .ob-pill--master, .ob-avatar[data-highlight], .ob-table tr[data-highlight] using only semantic tokens.
- ui/src/Avatar.tsx: optional prop highlight?: boolean, which sets data-highlight.
- ui/src/DataTable.tsx: optional prop rowHighlight?: (row:T)=>boolean, which sets data-highlight on the <tr>.
- ui/src/LogsScreen.tsx (moved from master/web/src/screens/LogsScreen.tsx, with an injected `api: LogsApi` {logs, facets, verifyLogChain?, exportUrl}).
-   The entity, action and actor dropdowns show t('logs.entity.<type>') / t('logs.action.<action>') with a raw fallback.
-   An actor whose tier is server_master shows ServerMasterBadge in the list and the detail.
-   The detail sub-screen (existing pattern) shows the rendered sentence and the details.
-   The export link passes ?locale=.
-   The master/web screen file becomes a thin wrapper, or the import moves into App.tsx.
- master/web/src/screens/AccessScreen.tsx: Users list.
-   Role column uses TierPill. Server Master rows are highlighted (rowHighlight) and the avatar is highlighted.
-   For non-SM actors, Server Master rows render NO edit/deactivate/delete/reset/reveal/avatar controls.
-   For SM actors, those controls open a MasterKeyPrompt before the call, and the token goes in the header.
-   lastAdminReason counts tier admin+server_master; a new lastServerMastersReason applies when active SM <= 2.
-   The role editor tier picker filters out 'server_master' and shows t('tier.*') labels instead of the raw value. The Server Master role row shows TierPill and the system badge, with no edit or delete actions.
-   The raw tier text at lines ~259, ~715 and ~1286 is replaced by TierPill.
- master/web/src/components/MasterKeyPrompt.tsx (new): a small Modal with a password-type key field. It calls api.verifyMasterKey and resolves to the token, and shows the lockout seconds on 429. This is a credential prompt, not record detail, so a dialog is allowed.
- master/web/src/screens/FirstRunScreen.tsx: SetupFlow asks for company name plus two account blocks ('Main Server Master' prefilled username 'master', 'Backup Server Master' prefilled 'master-backup'). Each block has display name, password and confirm, with client-side min length and distinct-username checks. The 'ready' step shows both usernames, the generated pairing password and the LAN IPs. The RestoreFlow is unchanged.
- master/web/src/screens/ServerMasterSetupFlow.tsx (new): Step 1 is the master key. Step 2 shows `needed` account blocks (same fields as SetupFlow), with a 'Not now' link back to sign-in. It is shown by SignInScreen when status.onMasterPc && status.serverMasterSetupNeeded.
- master/web/src/screens/MasterKeyRecoveryFlow.tsx (new): reached from the SignInScreen link 'Forgot Server Master password?' (rendered only when onMasterPc). Steps: key, pick the Server Master (list from GET /api/master-key/server-masters), new password + confirm, done.
- master/web/src/screens/SignInScreen.tsx: drop the 'admin' prefill. Add the recovery link and the setup-flow switch, both only when onMasterPc.
- master/web/src/components/ChangePasswordDialog.tsx: when user.roleTier==='server_master', add a 'Master key' field. Verify it first, then send the header.
- master/web/src/screens/SettingsScreen.tsx: the Connection tab gets a 'Change pairing password' button (server_master and onMasterPc only). Flow: MasterKeyPrompt, then a confirm, then the new password shown once in a LabeledValue.
- master/web/src/App.tsx: the footer signedInAs adds a ServerMasterBadge for a Server Master. The setup-status fetch passes onMasterPc/serverMasterSetupNeeded to SignInScreen. The Logs screen mounts ui LogsScreen.
- office/web/src/App.tsx plus office/web/src/api.ts: a Logs entry (sub-page in the System group, no Alt chord, gated by can('logs.view')) mounting ui LogsScreen with the Office api (the /api/logs* forwards already exist). The nav slot is coordinated with the Basic Home / UI-shell domain.
- No new keyboard chords from this domain. The Ctrl+F screen search on Logs keeps <Input data-screen-search>.

## steps

### 1. 1. Shared tier, key and scope primitives

Files: `shared/src/domain/permissions.ts`, `shared/src/domain/entities.ts`, `shared/src/domain/inputs.ts`, `shared/src/domain/master-key.ts (new)`, `shared/src/domain/report-scope.ts (new)`, `shared/src/domain/developer.ts`, `shared/src/protocol/socket.ts`, `shared/src/index.ts`

permissions.ts:
- Set ROLE_TIERS = ['office','management','admin','server_master'] (last = highest rank).
- Export SERVER_MASTER_TIER and isServerMasterTier().
- buildPermissionCatalogue keeps tiers: ROLE_TIERS; the UI filters the picker.

entities.ts:
- RoleTierName = RoleTier (import type from permissions.ts; no runtime cycle).
- ActivityActor gets optional `tier?: RoleTier`.

inputs.ts: the three literal unions become RoleTier.

master-key.ts:
- MASTER_KEY_HASH (scrypt of '<master key, see docs/MASTER_KEY.md>', generated with hashPassword).
- MASTER_KEY_TOKEN_HEADER, MASTER_KEY_TOKEN_TTL_MS = 5 min.
- Reuse DEVELOPER_UNLOCK_MAX_FAILURES and LOCKOUT_MS.
- MasterKeyUnlock, ServerMasterAccountInput, SERVER_MASTER_MIN_ACTIVE = 2, SUGGESTED_SERVER_MASTER_USERNAMES = ['master','master-backup'].

report-scope.ts:
- reportScopeFor(actor) and canReportOn(actor, target), pure, with tierRank >= admin -> everyone, else self.

developer.ts: add DUMMY_SERVER_MASTERS [{username:'master', password:'Master@1234'}, {username:'master-backup', password:'Backup@1234'}] (tier server_master), used only when seeding runs setup itself.

socket.ts: add the 'auth:offlineEvents' command and the OfflineAuthEvent type.

index.ts: re-export the new modules.

### 2. 2. Migration

Files: `master/src/db/migrations/20261001000000_server_master_tier.ts (new)`, `master/src/db/migrations/index.ts`, `master/tests/migration-registry.test.ts`

Write the migration as specified in dataModel, with an inline frozen key list and an inline id allocation from id_sequences (entity 'role'). Append the registry entry after 20260401000000_order_vehicle_number, with a comment that it must be the first migration of the 1.3 batch so later grant migrations see the role. Append its name to DELIBERATELY_LAST, with a comment.

### 3. 3. Domain guards

Files: `master/src/domain/access.ts`, `master/src/repositories/access-guard.repository.ts`, `master/src/services/catalogue-seed.service.ts`

access.ts:
- assertAdminTier: refuse unless tierRank(actor tier) >= tierRank('admin').
- New assertMayManageUser(actor, targetTier): throws ForbiddenError('users.manage', 'error.forbidden.serverMasterTarget') when target rank > actor rank.
- New assertTierAssignable(tier): ValidationError('validation.role.serverMasterReserved') for 'server_master'.
- New assertServerMasterRoleFrozen(role): ValidationError('validation.role.serverMasterLocked').
- New assertServerMastersRetained(before:number, after:number): throws 'validation.user.serverMastersRequired' when after < Math.min(before, SERVER_MASTER_MIN_ACTIVE).
- New assertMasterKeyFor(needed:boolean, token, gate): throws 401 error.unauthorized.masterKeyRequired.

access-guard.repository.ts:
- readAdministrativeCapability uses .whereIn('r.tier', ['admin','server_master']).
- New countActiveServerMasters(tenantId, trx), with the same join, tier='server_master'.

catalogue-seed.service.ts: administratorActor uses whereIn tier ['admin','server_master'].

### 4. 4. Master key gate and loopback helpers

Files: `master/src/services/developer.service.ts`, `master/src/services/master-key.service.ts (new)`, `master/src/lib/network.ts`, `master/src/http/health.ts`, `master/src/http/middleware/require-loopback.ts (new)`

developer.service.ts: createDeveloperGate gains options {passwordHash?, overridePassword?, wrongPasswordKey?, tokenTtlMs?}. The defaults keep the developer behaviour byte-for-byte.

master-key.service.ts:
- masterKeyGate = createDeveloperGate({passwordHash: MASTER_KEY_HASH, overridePassword: () => process.env.ORDERBOOK_MASTER_KEY, wrongPasswordKey: 'error.unauthorized.masterKey', tokenTtlMs: MASTER_KEY_TOKEN_TTL_MS}).
- verifyMasterKey(key, actor|null, source) wraps unlock and writes master_key.verified / master_key.failed through recordDetachedActivity (actor = the signed-in user, or systemActor with actorName 'Master PC').

network.ts: export isLoopbackAddress(addr) ('127.0.0.1', '::1', '::ffff:127.0.0.1') and isLoopback(req).

health.ts imports isLoopback from network.ts instead of its private copy.

require-loopback.ts: requireLoopback middleware returning 403 AppError 'error.forbidden.masterPcOnly'.

### 5. 5. Server Master service (setup accounts, recovery, pairing password)

Files: `master/src/services/server-master.service.ts (new)`, `master/src/repositories/user.repository.ts`

- ensureServerMasterRole(tenantId, trx): returns the live server_master role id, inserting it (the same frozen list, via insertRole with isSystem:true) if a restore removed it.
- validateAccounts(inputs): trimmed lower-case usernames, display names required, assertPasswordLongEnough, distinct usernames, assertNameAvailable.
- createServerMasters(tenantId, inputs, actor, trx), shared by setup and the upgrade flow. It inserts users with hashPassword and writes user.created per account (details {username, displayName, roleId, roleName}). After commit it calls rememberPassword.
- setUpMissingServerMasters(inputs, token): masterKeyGate.assertUnlocked, then lockTenantAccessGuards, then countActiveServerMasters. It requires inputs.length === 2 - active, creates the accounts, and writes user.server_masters_set_up {names} last.
- recoverServerMasterPassword(userId, newPassword, token): the target must be a live server_master. It updates password_hash with a new HLC, writes user.password_recovered {name, username}, calls rememberPassword, invalidateSessionsForUser(userId, {reason:'expired'}), and authService.clearSignInFailures(username) (new tiny export).
- changePairingPassword(actor, token): requires tier server_master plus the gate. It calls generateReadableSecret and bcrypt-hashes like setup, then regeneratePairingPasswordHash(trx, hash) plus recordActivity master_config.pairing_password_changed. It returns the plaintext once.
- listServerMasters(token).

user.repository.ts: roleIdForTier already works for 'server_master'; no change beyond types.

### 6. 6. First-run setup and routes

Files: `master/src/services/setup.service.ts`, `master/src/http/routes/setup.routes.ts`, `master/src/http/routes/master-key.routes.ts (new)`, `master/src/http/app.ts (router mount; exact file per existing mount list)`

runFirstTimeSetup(companyName, accounts: ServerMasterAccountInput[]):
- Requires exactly 2 accounts and validates them.
- In one transaction: insertMasterConfig, createServerMasters (role via roleIdForTier(tenant,'server_master')), then master_config.set_up {companyName} last, with systemActor.
- No 'admin' user is created.
- FirstRunCredentials becomes {masterUniqueId, accounts, pairingPassword, lanIps, port}.

New serverMasterSetupNeeded(): isSetupComplete && countActiveServerMasters < 2.

setup.routes.ts:
- /status adds onMasterPc and serverMasterSetupNeeded.
- requireLoopback goes on /initialize, /restore/preview and /restore.
- /initialize parses body.accounts.
- New POST /pairing-password.

master-key.routes.ts: verify, lock, server-masters GET/POST, recover, all with requireLoopback, mounted at /api/master-key.

### 7. 7. Sign-in, sessions, sign-out and expiry

Files: `master/src/services/auth.service.ts`, `master/src/http/routes/auth.routes.ts`, `master/src/http/middleware/require-auth.ts`, `master/src/realtime/hub.ts`, `master/src/services/panel-actor.service.ts`, `master/src/repositories/panel-credential.repository.ts`

auth.service.ts:
- signIn(username, password, source?, options?: {onMasterPc?: boolean}). In attemptSignIn, after the permissionSet resolves: if permissionSet.tier === 'server_master' && !options?.onMasterPc, call recordSignInAttempt(fail, reason 'masterPcOnly') and throw UnauthorizedError('error.unauthorized.serverMasterMasterPcOnly'). Do not call recordFailure, because the password was right.
- Session gains username, displayName, tier and source.
- resolveSession, resolveSessionWithPermissions and resolveSessionDetailed* gain an optional remoteAddress. They return null / rejected('expired') for tier server_master unless isLoopbackAddress(remoteAddress).
- signOut(token): look up the session, then delete it, then fire void recordSessionEnd(session, 'signed_out') detached.
- purgeExpiredSessions and tokenSession's expiry branch both route through expireSession(token, session), which writes user.session_expired detached.
- New exports clearSignInFailures(username) and recordOfflineAuthEvents(tenantId, deviceCode, events), which writes user.offline_sign_in / user.offline_sign_in_failed detached with details {username, source, at}.

auth.routes.ts: sign-in passes {onMasterPc: isLoopback(req)}.

require-auth.ts attachSession passes req.socket.remoteAddress.

hub.ts:
- The Master-browser handshake (~309) and adminActor (~861, ~1030, ~1129) pass socket.handshake.address.
- auth:signIn keeps passing no onMasterPc.
- auth:assume rejects when resolution.user.roleTier === 'server_master'.
- Register 'auth:offlineEvents'.

panel-actor.service.ts: treat a server_master resolution as rejection 'expired'.

panel-credential.repository.ts findRevokedOfflineCredentials: select r.tier; forget when the tier is 'server_master'.

### 8. 8. User and role services: target guard, two-SM guard, master-key gating

Files: `master/src/services/user.service.ts`, `master/src/services/role.service.ts`, `master/src/services/password-vault.service.ts`, `master/src/services/avatar.service.ts`, `master/src/services/panel.service.ts`, `master/src/http/routes/access.routes.ts`, `master/src/services/developer.service.ts`

user.service.ts: every mutation takes options {masterKeyToken?}.
- createUser: if role.tier==='server_master', require actor SM plus the token.
- updateUser:
  - assertMayManageUser(actor, existing.roleTier).
  - Require the token when the target is SM and username, isActive or roleId changes, or when the new role is SM.
  - Inside the existing lock, read countActiveServerMasters before and after, then call assertServerMastersRetained.
- deleteUser: assertMayManageUser; token if the target is SM; SM count guard.
- restoreUser: assertMayManageUser.
- resetPassword: assertMayManageUser, plus the token if the target is SM.
- changeOwnPassword (auth.service.ts): if the caller's tier is SM, require the token.

role.service.ts:
- createRole calls assertTierAssignable(tier).
- updateRole calls assertServerMasterRoleFrozen(existing) when existing.tier==='server_master', and assertTierAssignable(tier).
- deleteRole is already blocked by G6.

password-vault.service.ts revealPassword and avatar.service.ts uploadAvatar/removeAvatar (when the target is another user): assertMayManageUser.

panel.service.ts updatePanel role branch: if set.tier==='server_master', throw ValidationError('validation.panel.serverMasterRole').

access.routes.ts: read req.header(MASTER_KEY_TOKEN_HEADER) and pass it through; no needs() changes.

developer.service.ts seedDummyUsers:
- When it runs setup itself, pass DUMMY_SERVER_MASTERS.
- Skip, never re-arm, any existing user whose role tier is server_master (outcome 'skipped').
- Log developer.dummy_users_seeded {count}.

### 9. 9. Office panel hardening and offline sign-in upload

Files: `office/src/services/user-session.service.ts`, `office/src/services/offline-auth-events.store.ts (new)`, `office/src/realtime/master-connection.ts`

user-session.service.ts:
- signInAgainstMaster: if session.user.roleTier === 'server_master', send auth:signOut for the token, do NOT call userStore.remember, and throw SignInError('error.unauthorized.serverMasterMasterPcOnly').
- signInOffline success and its 'unknown_here' failure append {username, userId?, success, at} to offline-auth-events.store.

offline-auth-events.store.ts: a JSON file in the Office data dir. Same durable-write pattern as sign-in-attempts.store.ts. Capped at 500 entries, dropping the oldest. Exposes append, peek and drop(n).

master-connection.ts: on connect, beside reconcile, send pending events via command('auth:offlineEvents') and drop them on ack. On failure keep them and retry on the next connect.

### 10. 10. Audit completeness (rule 4)

Files: `master/src/services/lead.service.ts`, `master/src/services/order.service.ts`, `master/src/services/conflict.service.ts`, `master/src/services/panel.service.ts`, `master/src/http/routes/panel.routes.ts`, `master/src/services/developer.service.ts`, `master/src/http/routes/developer.routes.ts`, `master/src/services/update.service.ts`, `master/src/http/routes/update.routes.ts`, `master/src/services/product-import.service.ts`, `master/src/services/party-access.service.ts`, `master/src/services/backup-export.service.ts`, `master/src/services/backup-restore.service.ts`, `master/src/services/settings.service.ts`, `master/src/services/log.service.ts`, `master/src/repositories/activity-log.repository.ts`

- lead.service addRemark: recordActivity lead.remark_added {text: first 120 chars} as the last statement of its trx.
- lead.service deleteLead/restoreLead: details {number: lead.number ?? lead.id, party: partyName}. The number field comes from the numbering domain and is optional.
- order.service delete/restore: same details. convertLead additionally writes lead.converted {orderId, number} after order.created; both are last, one after the other.
- conflict.service resolveConflict: after markResolved, recordActivity under entityType conflict.entity, action dismiss ? 'conflict_kept' : 'conflict_restored', details {field, conflictId}. These are two literal call sites, not a ternary, so the extractor sees both.
- panel.service:
  - recordPanelActivity(panel, actor, details, trx, action='updated'); revoke passes 'revoked'.
  - New openPairingWindow(actor) / closePairingWindow(actor) wrappers write pairing_window.opened/closed (details {minutes?}) in a small own trx.
  - disconnectPanel stays pure. The route calls a new panelService.disconnectPanelByAdmin(id, actor), which writes office_panel.disconnected {name} detached, because nothing is changed in the DB.
  - panel.routes.ts passes actorFromRequest.
- developer: the routes call new developer.service unlockDeveloper(password, actor) / lockDeveloper(token, actor), writing developer.unlocked / developer.unlock_failed / developer.locked detached (attempts). resetAllData writes developer.data_erased detached after runMigrations, with systemActor.
- update.service prepareMasterUpdate(actor): writes master_update.install_started {version} detached after the installer is prepared (the shell then quits).
- product-import.service exportProducts: catalog.exported {count}. party-access.service exportRows: party_access.exported {count}. Both use an own small trx after building the file, like log export.
- backup-export.service exportBackup(actor): backup.exported {scope, fileName}. backup-restore.service: after commit, write backup.restored {fileName?, appVersion} in the restored DB (actor name kept, actorId null since the user id may not exist), and on failure backup.restore_failed detached. The backup-all domain keeps these calls and adds backup.auto_ran / backup.auto_failed.
- settings.service writeSetting: add labelToken: SETTINGS[key].labelToken. For boolean controls add fromToken/toToken ('settingValue.on' | 'settingValue.off'). The existing name/from/to are unchanged.
- log.service: CSV_HEADERS += ['sentence','details']; rowFor renders via createTranslator(locale) + renderActivity and JSON.stringify(details); exportLogs takes locale.
- activity-log.repository listEntries/streamForExport: LEFT JOIN users u ON u.id = activity_log.actor_id AND activity_log.actor_type='user' LEFT JOIN roles r ON r.id = u.role_id; select r.tier as actor_tier into actor.tier.

### 11. 11. Rendering: activityDetail.* and Token fields

Files: `shared/src/i18n/activity.ts`

renderActivity:
- Build params as today.
- For each details field ending in 'Token' whose value is a key in EN_MESSAGES, set params[field minus 'Token'] = t.t(value).
- Then, if `activityDetail.${pair}` exists in EN_MESSAGES and every {placeholder} of its EN template is present in params, render that key; else render activity.* as today.
- About 12 lines. ACTIVITY_TOKENS is unchanged because the activityDetail.* prefix is not under activity.*.

### 12. 12. i18n catalogue (EN + real Hindi + lock)

Files: `shared/src/i18n/en.ts`, `shared/src/i18n/hi.ts`, `shared/tests/activity-tokens.lock.json`

New activity.* tokens (EN shown; Hindi must put a postposition after {actor}, e.g. '{actor} ने …'):
- lead.remark_added '{actor} added a remark on this pending order'
- lead.converted '{actor} converted this pending order into a final order'
- lead|order|party|product .conflict_kept '{actor} kept the current value after a sync conflict on this …' (4 tokens)
- lead|order|party|product .conflict_restored '{actor} restored the overwritten value after a sync conflict on this …' (4 tokens)
- user.signed_out '{actor} signed out'
- user.session_expired 'The session for {name} expired'
- user.offline_sign_in '{actor} signed in on {source} while the Master was off'
- user.offline_sign_in_failed 'An offline sign-in failed for {username} on {source}'
- user.server_masters_set_up '{actor} set up the Server Master accounts {names}'
- user.password_recovered '{actor} reset the password for {name} with the master key'
- master_key.verified '{actor} entered the master key'
- master_key.failed 'A wrong master key was entered on the Master PC'
- master_config.set_up '{actor} set up this Master for {companyName}'
- master_config.pairing_password_changed '{actor} changed the pairing password'
- office_panel.revoked '{actor} revoked the office panel {name}'
- office_panel.disconnected '{actor} disconnected the office panel {name}'
- pairing_window.opened '{actor} opened the pairing window'
- pairing_window.closed '{actor} closed the pairing window'
- developer.unlocked '{actor} unlocked developer mode'
- developer.unlock_failed 'A wrong developer password was entered'
- developer.locked '{actor} locked developer mode'
- developer.data_erased '{actor} erased all data back to first run'
- developer.dummy_users_seeded '{actor} created {count} test accounts'
- master_update.install_started '{actor} started installing Master update {version}'
- catalog.exported '{actor} exported {count} products'
- party_access.exported '{actor} exported the party access list'
- backup.exported '{actor} exported a backup'
- backup.restored '{actor} restored a backup'
- backup.restore_failed 'A backup restore failed'
- backup.auto_ran '{actor} saved the scheduled backup to {folder}'
- backup.auto_failed 'The scheduled backup to {folder} failed'
- chat_group.created / archived / restored / updated '{actor} created|archived|restored|updated the chat group {name}'
- chat_group.admin_only_on '{actor} made {name} an admin-only group'
- chat_group.admin_only_off '{actor} let everyone post in {name} again'
- chat_group.member_added '{actor} added {member} to the chat group {name}'
- chat_group.member_removed '{actor} removed {member} from the chat group {name}'
- chat_message.pinned '{actor} pinned a message in {group}'
- chat_message.unpinned '{actor} unpinned a message in {group}'
- chat_task.created '{actor} shared the task {title} in {group}'
- chat_task.deleted '{actor} removed the task {title} from {group}'
- print_job.printed '{actor} marked the print job {title} as printed'
- print_job.unprinted '{actor} marked the print job {title} as not printed'
- print_job.deleted '{actor} removed the print job {title}'

activityDetail.*:
- lead.deleted / lead.restored / order.deleted / order.restored '{actor} deleted the pending order {number} for {party}' etc.
- setting.updated '{actor} changed {label} from {from} to {to}'

Also:
- settingValue.on / settingValue.off
- tier.office / management / admin / server_master
- logs.entity.<every entityType in ACTIVITY_TOKENS> and logs.action.<every action>
- errors: error.unauthorized.serverMasterMasterPcOnly, error.unauthorized.masterKey, error.unauthorized.masterKeyRequired, error.forbidden.masterPcOnly, error.forbidden.serverMasterTarget
- validations: validation.role.serverMasterReserved, validation.role.serverMasterLocked, validation.user.serverMastersRequired, validation.panel.serverMasterRole, validation.setup.twoServerMastersRequired, validation.setup.usernamesDistinct, validation.masterKey.required
- UI strings: firstRun.serverMaster.*, signIn.serverMaster.*, masterKey.*, access.users.serverMasterBadge / lastServerMastersReason, settings.connection.changePairing*, logs.export.locale

Append every new activity.* key to activity-tokens.lock.json.

### 13. 13. Highlight UI and Logs move

Files: `ui/src/TierPill.tsx (new)`, `ui/src/DataDisplay.tsx`, `ui/src/Avatar.tsx`, `ui/src/DataTable.tsx`, `ui/src/base.css`, `ui/src/icons.tsx`, `ui/src/index.ts`, `ui/src/LogsScreen.tsx (moved)`, `master/web/src/screens/LogsScreen.tsx`, `master/web/src/screens/AccessScreen.tsx`, `master/web/src/App.tsx`, `office/web/src/App.tsx`, `office/web/src/api.ts`

Implement as described in uiScreens. AccessScreen:
- Replace the 'admin' literals (lines ~251, 475-481, 1268) with tier helpers.
- Hide SM row controls for non-SM actors.
- Thread masterKeyToken for SM actors.

The Office Logs entry slot is agreed with the UI-shell domain.

### 14. 14. Master web flows

Files: `master/web/src/api.ts`, `master/web/src/screens/FirstRunScreen.tsx`, `master/web/src/screens/SignInScreen.tsx`, `master/web/src/screens/ServerMasterSetupFlow.tsx (new)`, `master/web/src/screens/MasterKeyRecoveryFlow.tsx (new)`, `master/web/src/components/MasterKeyPrompt.tsx (new)`, `master/web/src/components/ChangePasswordDialog.tsx`, `master/web/src/screens/SettingsScreen.tsx`

api.ts:
- setupStatus adds onMasterPc and serverMasterSetupNeeded.
- initialize(companyName, accounts).
- verifyMasterKey, lockMasterKey, listServerMasters(token), setUpServerMasters(token, accounts), recoverServerMaster(token, userId, pw), changePairingPassword(token).
- updateUser/resetPassword/deleteUser/createUser/changeOwnPassword accept an optional masterKeyToken header.
- logsExportUrl(query, locale).

FirstRunCredentials type is updated. The screens are as in uiScreens.

### 15. 15. Docs

Files: `docs/MASTER_KEY.md (new)`, `docs/ROLES_AND_USERS.md`, `docs/DEVELOPER_MODE.md`, `docs/STRUCTURE.md`, `HANDOFF.md`, `AI_COLLABORATION.md`

MASTER_KEY.md: the plaintext key, what it gates, the lockout, the .env override and 'Security, stated honestly' (a shared secret).

ROLES_AND_USERS.md: the server_master tier and reserved role, G1 change, G9 target-tier guard, G10 two-SM rule, Master-PC-only sign-in, the upgrade flow and recovery.

DEVELOPER_MODE.md: dummy Server Masters and the skip rule.

STRUCTURE.md: §3.6 tiers, §6.5 users and roles, §11.2 sign-in, new routes, the audit catalogue additions, the activityDetail mechanism, the Logs move to ui.

HANDOFF.md / AI_COLLABORATION.md: entries for this change.

## tests

- NEW master/tests/server-master-domain.test.ts (pure):
- assertMayManageUser matrix (office/management/admin/SM actor x target).
- assertServerMastersRetained cases (0->0 ok; 2->1 refuse; 3->2 ok; 1->0 refuse; 1->1 ok).
- assertTierAssignable and assertServerMasterRoleFrozen.
- assertAdminTier accepts admin and SM, refuses management.
- isLoopbackAddress.
- masterKeyGate via createDeveloperGate with a fake clock: 5 failures lock it for 60 s; the token expires after 5 minutes; wrongPasswordKey is used.
- NEW shared/tests/server-master.test.ts:
- tierRank order.
- effectivePermissions(allPermissions(), 'server_master') equals allPermissions().
- isPermittedForTier for every admin-ceiling key.
- reportScopeFor/canReportOn matrix (office self only; management self only; admin anyone incl. other admins and SM; SM anyone).
- MASTER_KEY_HASH verifies the documented key, read from process.env in CI rather than hard-coded, or skipped when unset.
- NEW master/tests/server-master.integration.test.ts:
- The migration widened roles_tier_check (inserting tier 'server_master' succeeds; 'bogus' fails).
- Exactly one is_system 'Server Master' role per tenant, and its permissions equal allPermissions(), so a later grant migration that forgets SM fails here.
- runFirstTimeSetup creates two SM users and no 'admin'.
- signIn without onMasterPc is refused with serverMasterMasterPcOnly and writes sign_in_failed reason masterPcOnly.
- signIn with onMasterPc succeeds.
- resolveSessionWithPermissions(token, '192.168.1.5') returns null for SM and works for an admin.
- auth:assume / resolvePanelActorAllowingRefusal reject an SM token.
- findRevokedOfflineCredentials forgets an SM.
- An admin cannot update, deactivate, delete, reset, reveal or change the avatar of an SM (403 serverMasterTarget).
- A panel cannot get the SM role.
- An admin cannot create a role at tier server_master or edit the SM role.
- An SM deactivating one of two SMs is refused; with three it is allowed with a token and refused without one.
- An SM changing their own password without a token gets 401; with a token it succeeds.
- The upgrade flow creates exactly the missing count.
- Recovery resets the password and clears the lockout.
- changePairingPassword returns a new secret, verifyPairingPassword accepts it, and it is logged.
- POST /api/setup/initialize over supertest (loopback) works.
- NEW master/tests/audit-coverage.integration.test.ts: one assertion per closed gap that the expected entityType/action/details row exists:
- remark, convert-on-lead, conflict kept/restored
- sign-out, session expiry (sweep with a fake expiresAt), offline events upload
- developer unlock/fail/lock, setup
- pairing window open/close, panel disconnect, panel revoke = 'revoked'
- update install (stubbed), products export, party-access export
- backup export/restore
- lead/order delete with number+party
- setting.updated carrying labelToken
- master_key verified/failed
- user.server_masters_set_up, user.password_recovered
- NEW office/tests/offline-auth-events.test.ts:
- An offline sign-in appends; the cap drops the oldest.
- Upload on connect drops on ack and keeps on failure.
- signInAgainstMaster refuses to remember a server_master user (extend office/tests/user-session.test.ts).
- EXTEND shared/tests/i18n-coverage.test.ts:
- Apply the Hindi postposition rule to activityDetail.* as well.
- Every activityDetail.<pair> has a matching activity.<pair>.
- Every entityType and action in ACTIVITY_TOKENS has logs.entity.* and logs.action.* tokens.
- tier.<t> exists for every ROLE_TIERS member.
- EXTEND shared/tests/i18n.test.ts (or a new activity-render test):
- renderActivity uses the activityDetail variant only when all placeholders are present.
- A *Token field is translated.
- Old rows render unchanged.
- EXTEND master/tests/i18n-tokens.test.ts with hand-written cases for variable actions:
- office_panel revoked/disconnected via recordPanelActivity's action parameter
- conflict_kept/conflict_restored for all four entities
- developer unlocked/unlock_failed
- user signed_out/session_expired/offline_sign_in(_failed)
- CHANGE master/tests/auth-pairing.integration.test.ts (lines ~24-140): pass two accounts to runFirstTimeSetup. Assert credentials.accounts usernames are ['master','master-backup'] instead of username 'admin' plus a generated password. Sign in with {onMasterPc:true}. The 'generates passwords without misreadable chars' test now covers only pairingPassword. Reason: setup no longer creates 'admin', and owner-typed passwords are not generated.
- CHANGE master/tests/developer.integration.test.ts (~82, ~112) and developer-service.test.ts: setup now creates dummy SMs; the 'admin' dummy is still created by seeding; SM users are skipped on re-arm; the gate factory options have unchanged defaults.
- CHANGE master/tests/audit-atomicity.integration.test.ts (runFirstTimeSetup call sites ~337, 556, 814-831): new signature. The setup transaction now ends with the master_config.set_up audit insert, so assert it is the last statement.
- CHANGE master/tests/helpers/fixtures.ts:
- Add a createServerMasterUser helper and a test actor with tier server_master.
- The setup helpers pass accounts.
- G4 fixtures may count SMs.
- CHANGE master/tests/access-lockout.integration.test.ts and access.integration.test.ts: G4 now counts admin plus server_master (add a case where only SMs exist and removing the last admin-tier user is allowed). minimumTierFor assertions are unchanged.
- CHANGE master/tests/migration-registry.test.ts: append '20261001000000_server_master_tier' to DELIBERATELY_LAST (it must also be appended to the index.ts array).
- CHANGE master/tests/logs.integration.test.ts: CSV header gains sentence, details; actor.tier is present for user actors.
- CHANGE master/tests/panel-administration.integration.test.ts: a revoke now logs action 'revoked' (previously 'updated' with status 'revoked'); disconnect logs office_panel.disconnected.
- CHANGE master/tests/audit-trail.integration.test.ts: delete entries now carry number and party; conversion adds lead.converted.
- CHANGE master/tests/http-api.integration.test.ts and any test posting /api/setup/initialize: body includes accounts; sign-in over supertest is loopback, so it stays green.
- CHANGE shared/tests/activity-tokens.lock.json: append-only additions.
- CHECK, unchanged but must stay green:
- master/tests/credential-invariants.test.ts (no new access.routes handlers; the master-key router is separate; readCredentialForVerification stays the single reader; findRevokedOfflineCredentials only adds r.tier).
- password-vault-invariants.test.ts (the vault table is not named in new files).
- migration-data-safety.test.ts (only DROP CONSTRAINT plus INSERT).
- wire-optionality.test.ts (ActivityActor.tier and status fields optional).
- socket-contract.test.ts (no new S->C events).
- ui/tests/master-shell.test.tsx (setup/status mock lacks the new fields, which is handled as falsy).
- ui/tests/permission-labels.test.tsx.
- web-reachability/screen-reachability tests (update if they import master LogsScreen by path).
- keys-nav-order.test.ts (the Office Logs nav entry is coordinated with the UI-shell domain).

## docs

- docs/MASTER_KEY.md (new): the key '<master key, see docs/MASTER_KEY.md>' in plaintext (the only place), what it unlocks, the lockout, the ORDERBOOK_MASTER_KEY override, recovery steps on the Master PC, and an honest security note.
- docs/ROLES_AND_USERS.md: the server_master tier and reserved frozen role, the G1 change, G9 target-tier guard, G10 at-least-two-Server-Masters rule, Master-PC-only sign-in and session refusal, the panel role ban, the master-key-gated operations, the upgrade setup flow and the report-scope rule.
- docs/DEVELOPER_MODE.md: dummy Server Masters master/master-backup with their passwords; seeding never touches an existing Server Master.
- docs/STRUCTURE.md: §3.6 permissions/tiers, §6.5 users/roles, §11.2 sign-in, §11.8 setup/restore loopback-only, new routes (/api/master-key/*, /api/setup/pairing-password), the auth:offlineEvents command, the audit catalogue additions, activityDetail.* and *Token rendering, the Logs screen in ui/ mounted on both panels, the CSV columns.
- HANDOFF.md: record the change, the new invariants, and that the batch's grant migrations must include server_master.
- AI_COLLABORATION.md: working-agreement note that every new audited action needs an activity token, EN plus real Hindi, a lock entry, and must not log chat messages, presence or print ticks.

## risks

- Session refusal by address: if any caller of resolveSessionWithPermissions is missed and passes no remoteAddress, a Server Master's own Master-window requests return 401. Mitigation: the default remoteAddress is undefined and refuses Server Master sessions; the integration test signs in over supertest (loopback) and exercises /me, sockets and an admin route. Grep every resolveSession* caller (require-auth, hub ~309/861/1030/1129, panel-actor).
- Electron's Master window loads http://localhost:4100. If Windows resolves localhost to ::1 the address is '::1'; IPv4-mapped is '::ffff:127.0.0.1'. All three are covered by isLoopbackAddress. A reverse proxy in front of the Master would break the rule; none is shipped.
- Grant migrations in this batch from other domains (chat, printroom, reports, numbering) MUST include server_master and run after 20261001000000. Otherwise the Server Master silently lacks new keys. The allPermissions() equality test is the backstop.
- Locking out the company: Server Master credentials are recoverable only with the master key on the Master PC. If the master key is lost (the docs plaintext) and both Server Master passwords are forgotten, only Developer erase or DB access helps. Admin-tier users keep working regardless.
- Test churn: about 10 integration tests assume setup creates 'admin' and that signIn works without options. They need deliberate updates (listed). Missing one turns CI red rather than causing silent breakage.
- Mixed versions: an old Office paired to a new Master sees the role tier 'server_master' in role lists and is refused when signing in as a Server Master (correct). It ignores the auth:offlineEvents command it does not know, because the command is Office->Master only. A new Office on an old Master gets a 15 s timeout on auth:offlineEvents; it keeps the queue and retries, so nothing breaks.
- Hash-chain load: the new detached audit entries (sign-out, session expiry, offline uploads) each take the per-tenant chain lock. Expiry is batched by the 60 s sweep and offline uploads are capped at 500 per call. Chat messages, presence and print ticks are explicitly excluded.
- renderActivity's activityDetail selection reads EN templates for the placeholder list. If a Hindi template uses a different placeholder set, i18n-coverage parity already fails, so this stays consistent.
- The setup and restore routes becoming loopback-only blocks a LAN-browser first-run, which may have been how some installers worked. The Electron Master always runs locally, so the owner's flow is unaffected (stated in the docs).
- Restore from an older backup removes the Server Master role and users. Until two Server Masters are set up again, only restored admins can sign in. ensureServerMasterRole plus the upgrade flow restores this, and the backup domain must not block sign-in in the meantime.

## dependsOn

- Migrations (all domains): this domain's 20261001000000_server_master_tier must be the first entry of the batch in master/src/db/migrations/index.ts and DELIBERATELY_LAST. Every later grant migration grants to tier IN ('admin','server_master').
- Reports domain: calls reportScopeFor/canReportOn from shared/src/domain/report-scope.ts for owner scoping. It owns the leads/orders owner_id indexes and the Reports-visibility settings. Report rows and pickers show TierPill for owners.
- Pending-order numbering domain: provides lead.number / order.number (optional on the wire). The delete/restore/convert audit details use number ?? id.
- Presence domain (avatars on open pending orders): include `tier?: RoleTier` in the presence payload and render <Avatar highlight={isServerMasterTier(tier)}> plus TierPill in the hover card.
- Chatroom domain: include sender tier in message payloads and render ServerMasterBadge. Write ONLY the defined chat_group.* / chat_message.pinned|unpinned / chat_task.created|deleted audit pairs (literal entityType/action, details keys exactly as the tokens' placeholders), never per-message entries. Chat grant migration includes server_master.
- Printroom domain: include sender tier, render ServerMasterBadge. Write print_job.printed|unprinted|deleted with details {title}, not status ticks. Grant migration includes server_master.
- Backup-all / magic-restore domain: keeps the backup.exported / backup.restored / backup.restore_failed calls and writes backup.auto_ran / backup.auto_failed {folder}. The magic-restore first-run path stays loopback-only and lands on the Server Master setup flow when fewer than two Server Masters exist. It must never include user_password_vault or secrets/vault.key.
- UI-shell / Basic Home domain: an Office nav entry and Basic Home 'System' tile for Logs (logs.view, no Alt chord). The Master sidebar Admin group keeps Logs. The footer 'user · role' segment uses TierPill / ServerMasterBadge. Basic Home vs Dashboard landing treats server_master like admin (lands on Dashboard).
- Sync/realtime domain: no change needed. The disconnected > 1 h notification is theirs; natural panel connect/disconnect is deliberately not in the audit chain.
- Party import/export domain: writes its own party import/export audit tokens following the same rules (EN + Hindi + lock).

## openQuestions

- Should a Normal Admin be able to run reports on a Server Master's own pending orders? I defaulted to yes, because you said admins can report on 'anyone'. If Server Master data should be hidden from admins, it is a one-line change in canReportOn.
- The master key '<master key, see docs/MASTER_KEY.md>' can be overridden through ORDERBOOK_MASTER_KEY in .env, the same as the developer password. Is that acceptable, or must it never be changeable?

## effort

About 50 files touched: roughly 18 master/src, 9 master/web, 8 shared, 7 ui, 4 office, 5 docs, plus about 14 test files. Around 2,600-3,200 new or changed lines: about 900 service/guard/route code, about 700 UI (three small flows, the TierPill, the Logs move), about 600 i18n lines (EN + real Hindi for about 75 activity tokens, the logs.entity/action labels, errors and UI strings), and about 900 tests. That is 3-4 focused sessions in this order: shared + migration + guards; auth/sessions/master key/setup; the audit sweep + i18n; UI + docs.
