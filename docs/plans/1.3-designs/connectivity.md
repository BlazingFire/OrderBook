# Design: Realtime connectivity & sync rules 1, 5, 6 + notification infrastructure

> Written before the code (2026-10-01). Where it disagrees with docs/plans/1.3-BATCH-DETAIL.md, the integrated plan wins.

## Overview

What the user sees. Every Office footer and PresenceRail shows one of Offline / Catching up / Syncing N / Synced / Conflicts. A silent drop (cable pulled, Master asleep) shows within about 10 s; today it takes about 45 s. A pulled cable on the Office PC itself shows within 2 s. Once the link is up, a reconnect takes at most 5 s.

Offline indicators. The sync popover says "Offline since 10:42 (1 h 5 m)". After one hour offline, three things happen once per episode: a persistent OfflineBanner appears, the notification bell gets an entry, and an OS toast plus a taskbar flash fires through a new optional DesktopBridge.notify.
- The Master web footer gets its own link state, "Reconnecting to the Master server…", and every screen re-fetches when the link returns.
- The Master Panels screen and rail popover flag panels offline for more than 1 h. Holders of panels.manage get one bell notice per offline episode.

Never needing a restart, which closes four holes:
- The Office reconnects after 'io server disconnect' (Master drop / developer reset). It does not reconnect after panel:revoked, and an auth refusal saying panelNotPaired is now treated as a revocation.
- It retries after a middleware connect_error. Verified: socket.io-client destroys the socket and never retries, so a Master whose DB was still starting stranded the panel.
- It re-finds a Master whose LAN IP changed. This uses the existing discoverMasters, matches the stored masterUniqueId, keeps the pairing secret, and persists the new host only after a successful authenticated connect.
- It flushes the outbox right after setTransport. Verified: the snapshot-triggered flush runs before reassume finishes, finds no transport and returns idle.

Lower load:
- The handshake auth becomes a function. Each reconnect then sends the current cursor and acting token, not the boot-time ones.
- The Master resolves the acting user before building the delta, and auth:assume with the same token no longer sends a second full snapshot.
- The panel disconnect handler is registered before any await, and only the current socket may clear presence.
- A panel's stale previous socket is closed when it reconnects.
- panel:revoked is emitted synchronously before the socket is closed. Verified: today's fetchSockets await loses it.

Rule 6, ordering:
- Ordering is one total chain: HLC physical ms → HLC counter → device code A-Z → mutation id A-Z. It extends compareForIdAssignment; the HLC string is untouched.
- Every sync:push now goes through a single in-process apply lane on the Master (sync-lane.ts). It gathers pushes for 100 ms, and for 5 s after Master boot, then applies them one at a time in that order across panels. Creates from simultaneous or post-outage reconnects are therefore numbered by timestamp, and at most one pooled connection is held for the advisory lock. That removes the 10-push pool starvation; the pool also goes from 10 to 16.
- lead.setStage and order.setStage from the outbox now use the same per-field HLC rule as edits. A stale offline stage change becomes a stageId sync_conflict row instead of silently overwriting a newer stage. The field clock is stamped with the edit's HLC, and the lock order stays clock then row. Remarks, convert and dispatch stay in arrival order behind their existing guards.
- The Office warns when its clock is more than 2 minutes off the Master's, because 'timestamp wins' amplifies skew.

Notification centre:
- One Master table, user_notifications, holds per-user rows: kind, params, deep link, read_at, dedupe key.
- It is written by a notify() API that the chat, task, printroom, numbering and panel-presence domains call after commit.
- It is pushed live as 'notification:new' through a change-bus side channel, never the change ring or the activity log. The push goes to that user's Master browser sockets and to the panel socket acting as that user.
- The Office relays it over SSE. Office and Master offer the same REST list and mark-read endpoints, and a shared ui NotificationBell renders it in both topbars. Office-local items (link offline > 1 h) are merged in client-side.

Version handshake. The Office sends protocol/appVersion in the socket auth, and the Master sends protocol in each snapshot/delta. A command the peer is too old for fails at once with 'error.updateNeeded.master' (HTTP 426) instead of a 15 s timeout, and the Panels screen shows "Update needed".

## decisions

- Heartbeat pingInterval 4000 / pingTimeout 6000 in master/src/realtime/hub.ts Server options: a silent drop is detected in <=10 s. It tolerates Master event-loop stalls up to ~10 s (snapshot/PDF builds), where 5000/5000 would flap. The ping frame is 1 byte, so 10 panels cost nothing.
- Office socket options: reconnectionDelayMax 10_000 → 5_000 and engine `timeout` 20_000 → 5_000, so a dead IP fails fast and recovery is <=5 s after the link returns. Kept reconnectionDelay 1000 with the default jitter.
- Network-cable detection is an Office-server poll of hasNetworkLink() every 2 s (status emitted only on change), not browser navigator.onLine. The Office UI is loopback on the same PC, so the server poll sees the same thing and also covers the Legacy Win7 build. A link regained calls masterConnection.retryNow().
- No SSE ping event: EventSource 'error'/'open' already reveal an Office-server crash or restart. A hang is the shell supervisor's job. The 25 s keep-alive comment stays.
- 'Catching up' is an Office-only phase. It is true from socket 'connect' until the first snapshot/delta is persisted and the post-connect flush returns (30 s safety cap). The rail shows it as the existing 'syncing' RailState with the label sync.catchingUp, so no new RailState is needed.
- disconnectedSince is the moment this running panel lost, or first failed to establish, the link. It is not persisted across Office restarts, because a PC switched off overnight is not 'staying disconnected'.
- The 1 h threshold is one shared constant, LONG_OFFLINE_MS = 3_600_000, in shared/src/domain/notifications.ts, used by the Office banner, Master Panels badge and Master timer. The owner fixed 1 h, so there is no setting.
- Auto sync has no off switch anywhere, and none is added: rule 5 'always on' is already true once the flush-after-setTransport hole is closed.
- A Master auth refusal 'panelNotPaired' (panel row missing or revoked) is treated exactly like panel:revoked (clearCredentials → unpaired). 'panelCredentialsInvalid' keeps retrying every 60 s and shows lastError, because a secret mid-rotation must not wipe the pairing.
- Rediscovery runs after >=3 consecutive transport connect_errors, only with a network link, at most once per 60 s, via discoverMasters({timeoutMs:3000}). It switches only when exactly one HELLO answers for the stored masterUniqueId at a different address with no conflicting second address. It persists masterHost/port only after a successful authenticated 'connect'. This is the same LAN trust model as pairing; there is no new protocol.
- Double-snapshot fix: the handshake auth gains an optional actingUserToken. handleConnection resolves it before buildDelta, and auth:assume/release/reject call onActorChanged only when socket.data.actingUserToken actually changes. Old Masters ignore the field and keep today's behaviour.
- Rule 6 tie-break chain: HLC physical ms → HLC counter → device code (A-Z) → mutationId (A-Z). This is the existing string order plus a final key. Creator username was considered and dropped as unreachable: device codes are unique per panel and HLCs never repeat within a device, so it could never decide anything. mutationId guarantees a total order even for a replayed duplicate HLC.
- Cross-panel ordering uses one in-process FIFO apply lane: gather 100 ms when idle, and up to 5 s after Master boot so panels reconnecting after a Master restart are merged by HLC. Mutations are then applied one at a time. A retryable DB error fails only that push and skips its remaining mutations this round; other panels continue. Numbers stay never-reused: a panel that syncs hours later is numbered at arrival, and no window can change that.
- The lane is global, not per tenant (single-tenant LAN product, ~30 mutations/s). Marked `ponytail:` with the upgrade path (per-tenant lanes).
- Knex pool max 10 → 16 (acquire timeout stays 10 s): 10 panels + Master UI + schedulers. PostgreSQL's default max_connections is 100, and the lane already removes the nested-acquire starvation.
- Stage changes from the outbox use mergeFields with the same synthesized-base rule as lead/order edits (the base helper is extracted to shared). A newer offline stage applies and stamps fieldHlc.stageId with the edit's HLC, not apply time. An older one is recorded as a stageId conflict, status 'merged'. restoreLoser on a stageId conflict calls lead/orderService.setStage so assertStageMove, the timeline and activity still apply.
- Remarks (append-only, never conflict), convert and dispatch (one-way, with stock side effects, already guarded by assertStageMove and convert locks) stay in arrival order. Their refusals keep landing in the Office refusals list.
- Clock skew is surfaced, not corrected: clockSkewMs = Office now − Master serverTime at each snapshot/delta. A banner plus a popover row appear when |skew| > 2 min. Merge semantics are unchanged.
- Notifications are per user and persisted in a new user_notifications table on the Master: a task assigned while someone is offline must still reach them. They are delivered live through a change-bus side channel (publishNotification/onNotification, mirroring publishConflict), never through publishChange or the hash-chained activity_log, so the change ring and chain lock are untouched.
- Notification text is rendered client-side from i18n key `notification.<kind>` plus params, so each reader sees their own language. The OS toast text is rendered by the renderer, so the main process needs no i18n.
- Read notifications older than 60 days and anything past 500 per user are pruned by a daily in-process job (connector-scheduler pattern). That DELETE lives in service code, not a migration, so migration-data-safety is unaffected.
- user_notifications is added to backup EXCLUDED_TABLES (ephemeral, and avoids dangling user FKs on restore) and to BUSINESS_TABLES (a business wipe clears links to wiped records).
- There is no new permission: a user always reads and marks only their own notifications (routes in auth.routes.ts beside /me). The panel-offline > 1 h notice goes to users whose role holds panels.manage.
- 'lead.numbered' (PO numbered after an offline save) is produced in sync.service route 'lead.create' when the mutation carries an actorUserId and its HLC physical time is more than 60 s before apply time. Dedupe key `lead.numbered:<leadId>`. The number value itself comes from the numbering domain.
- Version handshake: PANEL_PROTOCOL_VERSION = 2 and COMMAND_MIN_PROTOCOL in shared/src/protocol/socket.ts. Every command added by this batch maps to 2. The check sits in MasterConnection.command(), the one choke point, and returns HTTP 426 + error.updateNeeded.master through failForward. A missing protocol is read as 1.
- OS attention: DesktopBridge.notify?({title, body}). Only mainWindow may call it; strings are clamped in electron/lib/attention.ts. It flashes the frame when the window is not focused, stops on focus, and shows a Notification when Notification.isSupported(). The shell calls app.setAppUserModelId(appId from electron-builder.yml) so Win10/11 toasts work. In a browser with no bridge, the bell alone is the fallback, with no Notification-permission prompt.
- Master web socket: auto-reconnect after 'io server disconnect'. On a connect_error 'Session is not valid' it calls refreshUser() (the 401 path signs out). It tracks linkUp for the footer. A reconnect bumps a '*' revision that revisionOf() adds to every screen key, so every open screen re-fetches.

## dataModel

- 20261003000000_user_notifications (additive, idempotent raw SQL; appended to master/src/db/migrations/index.ts and pinned at the end of DELIBERATELY_LAST). CREATE TABLE IF NOT EXISTS user_notifications:
- id UUID PK DEFAULT gen_random_uuid()
- tenant_id UUID NOT NULL REFERENCES tenants(id)
- user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
- kind TEXT NOT NULL CHECK (kind ~ '^[a-z]+\.[a-zA-Z]+$')
- params JSONB NOT NULL DEFAULT '{}'
- link JSONB NULL ({kind,id})
- dedupe_key TEXT NULL
- created_at TIMESTAMPTZ NOT NULL DEFAULT now()
- read_at TIMESTAMPTZ NULL
- Indexes on user_notifications:
- user_notifications_user_idx (tenant_id, user_id, created_at DESC)
- partial user_notifications_unread_idx (tenant_id, user_id) WHERE read_at IS NULL
- partial UNIQUE user_notifications_dedupe_idx (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND read_at IS NULL
The last one makes notify() idempotent via ON CONFLICT DO NOTHING. down() drops the table. No backfill.
- No other schema change. Stage HLC ordering reuses leads/orders.field_hlc (key 'stageId') and sync_conflicts (field 'stageId'). The apply lane, presence, disconnectedSince, protocol and clock skew are all runtime state.
- master/tests/helpers/fixtures.ts DATA_TABLES: add 'user_notifications' before 'users'. master/src/repositories/backup.repository.ts EXCLUDED_TABLES: add it. master/src/services/catalog-reload-cli.ts BUSINESS_TABLES: add it.

## permissions

- None new. Notifications are self-scoped (actor.userId). Panel-offline > 1 h notices go to active users whose role holds the existing 'panels.manage' (the Server Master tier inherits it per the roles domain). No grant migration is needed.

## interfaces

- Socket handshake PanelAuthPayload (shared/src/protocol/socket.ts) gains three optional fields. All are ignored by old Masters.
- actingUserToken?: string
- protocol?: number
- appVersion?: string
The Office sends auth as a function `(cb) => cb({...})`, so each reconnect carries the current syncCursor and token.
- SocketData gains:
- actingUserId?: Uuid, set and cleared alongside actingUserToken in auth:signIn/assume/signOut and in sessionsEnded
- protocol?: number
- Socket.IO server options (hub.ts): pingInterval 4000, pingTimeout 6000. The middleware error now carries `err.data = { messageKey, code }` for AppErrors, so the Office can tell panelNotPaired from transient failures.
- SyncSnapshot.protocol?: number and SyncDelta.protocol?: number (both optional). SNAPSHOT_POLICY.protocol = 'passthrough'.
- Constants in shared/src/protocol/socket.ts:
- PANEL_PROTOCOL_VERSION = 2
- COMMAND_MIN_PROTOCOL: Partial<Record<keyof ClientToServerEvents, number>>, with the notification:* commands and every chat:*, print:* and presence command from other domains set to 2
- C->S 'notification:list' (input?: { limit?: number; before?: IsoTimestamp }, ack: CommandAck<{ items: UserNotification[]; unreadCount: number }>). With no acting user it answers { items: [], unreadCount: 0 }.
- C->S 'notification:markRead' (input: { ids?: string[]; all?: boolean }, ack: CommandAck<{ unreadCount: number }>)
- S->C 'notification:new' (n: UserNotification & { userId: Uuid }). It goes only to Master-admin sockets with data.userId === n.userId and to panel sockets with data.actingUserId === n.userId. It is handled in office master-connection.ts, so it is not masterBrowserOnly.
- Master REST (auth.routes.ts, requireAuth, self-scoped):
- GET /api/notifications?limit=&before= → { items, unreadCount }
- POST /api/notifications/read { ids? | all? } → { unreadCount }
- Office REST (office/src/http/app.ts behind requireUser; online-only, failForward 503 offline):
- GET /api/notifications → forward('notification:list')
- POST /api/notifications/read → forward('notification:markRead')
- Office SSE /api/events gains event type 'notification' (UserNotification). It is relayed only when n.userId equals the current panel session's user id.
- Office ConnectionStatus (GET /api/connection, GET /api/sync and the SSE 'status' frame), all optional on office/web ConnectionInfo:
- disconnectedSince: string | null
- catchingUp: boolean
- hasNetworkLink: boolean
- clockSkewMs: number | null
- masterProtocol: number | null
- rediscoveredFrom: string | null (old host, shown once)
- POST /api/sync/flush: when the link is not connected, it first calls masterConnection.retryNow() (reset backoff, reconnect now), then flushes.
- failForward: MasterCommandError code 'updateNeeded' → HTTP 426 { error:'updateNeeded', messageKey:'error.updateNeeded.master' }.
- Domain types in a new shared/src/domain/notifications.ts, exported from the shared index:
- NOTIFICATION_KINDS = ['chat.mention','task.assigned','task.done','print.printed','lead.numbered','panel.offlineLong'] as const
- type NotificationKind
- interface NotificationLink { kind: 'lead'|'order'|'chatGroup'|'chatMessage'|'task'|'printJob'|'panel'; id: string }
- interface UserNotification { id; kind; params: MessageParams; link: NotificationLink|null; createdAt; readAt: string|null }
- LONG_OFFLINE_MS
- isLongOffline(panel: OfficePanelWithPresence, nowMs): boolean
- Master service API for other domains, in master/src/services/notification.service.ts. Callers invoke it after their own commit.
- notify(tenantId, userIds: string[], { kind, params, link?, dedupeKey? })
- listNotifications(actor, opts)
- markRead(actor, { ids?, all? })
- startNotificationPruner(): () => void
- Change-bus side channel (master/src/services/change-bus.ts): publishNotification(n) and onNotification(listener), mirroring publishConflict/onConflict. Hub helper emitToUser(tenantId, userId, event, payload) is exported for chat/printroom user-targeted pushes.
- Shared sync helpers:
- compareForIdAssignment(a, b) accepts an optional mutationId as the final tie-break (shared/src/sync/ids.ts)
- new baseForUnversionedEdit(fields, storedFieldHlc, mutationHlc) in shared/src/sync/merge.ts, extracted from sync.service mergeUpdate
- lead.service setStage(input, actor, edit?) and order.service setStage(input, actor, edit?), where edit?: { hlc: string; baseFieldHlc: Record<string,string>; deviceCode: string }:
- Inside the existing transaction, after nextHlc, lock and re-read the row.
- If stale, throw StaleEditError(conflict).
- Otherwise write fieldHlc.stageId = edit.hlc.
- OfficePanelRuntime.protocol?: number | null (Master Panels screen shows an 'Update needed' badge when it is below PANEL_PROTOCOL_VERSION).
- IPC 'orderbook:notify' (mainWindow only). DesktopBridge.notify?(n: { title: string; body: string }): Promise<boolean> in shared/src/protocol/desktop.ts and electron/preload.cts.
- Interface for the UI/Basic Home domain: both shells' footers must keep `.ob-footer-sync` driven by the railState/syncLabel computed here. The Office additionally passes railState and syncLabel to DashboardScreen/Basic Home sync tiles, replacing today's 'All synced' while offline.

## settings

- None. The 1 h threshold, heartbeat and gather window are fixed constants by design. Auto-sync has no toggle (rule 5 says always on).

## uiScreens

- ui/src/NotificationBell.tsx (new, shared, exported from ui/src/index.ts). Holds no transport; the panel passes data and callbacks.
- Props: items, unreadCount, loading, offlineNote, renderText(item), onOpen(item), onMarkAllRead(), onOpenChange(open).
- A topbar IconButton 'bell' with a count badge opens a `.ob-popover` list (newest first; unread items in bold).
- Includes 'Mark all as read' and an empty state. Esc and click-away close it. Tokens only.
- Add it to the eslint swept list.
- ui/src/AppShell.tsx gains an optional `banner?: ReactNode` prop, rendered above the content area. It is used for the long-offline OfflineBanner and the clock-skew banner.
- ui/src/format.ts gains formatElapsed(ms) ('1 h 5 m', '42 m'), unit words via t(), so no bare digits sit in the catalogue.
- Icon: add 'bell' to ui/src/Icon.tsx if absent (check the existing IconName set first).
- Office shell (office/web/src/App.tsx):
- railState gains catchingUp → 'syncing' with the label sync.catchingUp.
- The popover gains rows for 'Offline since', 'Clock difference' and the master host (shows the rediscovered host).
- A long-offline banner computes from disconnectedSince with one setTimeout to the 1 h mark. When it fires: a local bell item and a single desktopBridge()?.notify() per episode.
- The bell sits in the topbar before Sign out.
- A streamEpoch state bumps on SSE 'open' after an 'error' and on status→connected. It re-fetches notifications and is exposed for the chat/printroom lists.
- New state is merged via setConnection, never as an effect dependency (keeps the one-stream guard).
- Master shell (master/web/src/App.tsx):
- linkUp state from socket connect/disconnect. When down, railState is 'offline' with the label master.sync.serverUnreachable.
- Reconnect after 'io server disconnect'. A '*' revision bump on reconnect; revisionOf() adds revisions['*'].
- The bell sits in the topbar.
- The rail popover lists panels where isLongOffline() is true.
- master/web/src/screens/PanelsScreen.tsx: an 'Offline for {duration}' warning chip when isLongOffline, and an 'Update needed' chip when runtime.protocol < PANEL_PROTOCOL_VERSION. The Dashboard KPI tile 'Panels offline > 1 h' is an interface handed to the Master UI domain.
- Notification deep links: onOpen navigates through the shells' goToTab/hash routes (lead/order/chatGroup/printJob/panel). The record deep-link route (#/lead/<id>, #/order/<id>) is owned by the chat domain; this domain only calls it.
- No new nav entry or chord. The bell is a topbar control, not a module.

## steps

### 1. Shared contracts

Files: `shared/src/protocol/socket.ts`, `shared/src/domain/notifications.ts (new)`, `shared/src/index.ts`, `shared/src/sync/ids.ts`, `shared/src/sync/merge.ts`, `shared/src/protocol/desktop.ts`, `shared/src/domain/entities.ts`

socket.ts:
- Add the optional PanelAuthPayload fields actingUserToken, protocol and appVersion.
- Add SocketData actingUserId and protocol.
- Add SyncSnapshot.protocol? and SyncDelta.protocol?.
- Add PANEL_PROTOCOL_VERSION=2 and COMMAND_MIN_PROTOCOL.
- Add C->S notification:list and notification:markRead, and S->C notification:new.

notifications.ts (new): NOTIFICATION_KINDS, UserNotification, NotificationLink, LONG_OFFLINE_MS, isLongOffline.

ids.ts: compareForIdAssignment gets an optional mutationId final key, with the doc comment corrected. It now claims cross-panel determinism only within the lane window.

merge.ts: export baseForUnversionedEdit(fields, fieldHlc, hlc), moved verbatim from sync.service.ts mergeUpdate L557-563.

desktop.ts: DesktopBridge.notify?.

entities.ts: OfficePanelRuntime.protocol?: number|null.

### 2. Master hub: heartbeat, presence race, single snapshot, revoke delivery, handshake version, notification fan-out

Files: `master/src/realtime/hub.ts`, `master/src/services/panel.service.ts`, `master/src/services/change-bus.ts`

Server options: add pingInterval 4000 and pingTimeout 6000.

authenticate():
- Wrap the AppError into an Error whose `data` carries {code, messageKey}.
- Record auth.protocol into socket.data.protocol.

handleConnection, panel branch:
1. Close any previous socket for the panel: `const prev = panelSockets.get(panelId); if (prev && prev !== socket) prev.disconnect(true)`. The previous socket is removed from the map first.
2. Set panelSockets and register socket.on('disconnect') immediately, before any await. The handler returns early unless panelSockets.get(panelId) === socket. Only then does it delete the entry, call markPanelDisconnected and broadcastPanels (this fixes the presence race and the missed-disconnect-during-await).
3. If handshake auth.actingUserToken resolves 'active' via authService.resolveSessionDetailed, set socket.data.actingUserToken and actingUserId before actorFor()/buildDelta.
4. Pass protocol into markPanelConnected(panelId, ip, protocol).

registerAuthCommands: in auth:assume/signIn/signOut, set actingUserId alongside the token, and call onActorChanged only when the token value actually changes. The ack shape is unchanged.

notifyPanelRevoked: emit synchronously via panelSockets.get(panelId)?.emit('panel:revoked'). This fixes delivery before revokePanel's disconnectPanel.

Add buildSnapshot/buildDelta protocol: PANEL_PROTOCOL_VERSION. Put it in snapshot.service and delta.service, or set it at the hub emit sites.

Notifications:
- Add emitToUser(tenantId, userId, event, payload). It covers panelSockets where data.actingUserId matches, plus `io.in(ROOM_MASTER_ADMINS).fetchSockets()` filtered by data.userId.
- Subscribe onNotification → emitToUser(..., 'notification:new', n) and unsubscribe in stop().
- Register notification:list/markRead in registerCommands via run().

change-bus.ts: add publishNotification/onNotification (an EventEmitter channel like conflicts; no ring slot).

panel.service.ts:
- markPanelConnected stores runtime.protocol and clears that panel's long-offline timer.
- markPanelDisconnected schedules a one-shot unref'd LONG_OFFLINE_MS timer. It calls notify(users with panels.manage, 'panel.offlineLong', {panel name}, link {kind:'panel'}, dedupeKey `panel.offlineLong:<id>`).
- New scheduleLongOfflineNoticesAtBoot(tenantId), called from hub creation, schedules max(lastSeenAt+1h, now+5 min) for active panels.
- Fix the disconnectPanel comment, which is now true.

### 3. Master sync: apply lane with gather window, pool size

Files: `master/src/services/sync-lane.ts (new)`, `master/src/services/sync.service.ts`, `master/src/db/knex.ts`

sync-lane.ts (~80 LOC):
- Module-level queue of {mutation, actor, pushId}.
- runInLane(actor, mutations): Promise<MutationResult[]>.
- When idle, it waits until max(now+100 ms, bootAt+5 s), drains everything queued, sorts with compareForIdAssignment (hlc → deviceCode → mutationId), and applies sequentially through an injected applyOne.
- A retryable DB error (isRetryableDatabaseError) rejects only that push's promise and skips that push's remaining items this round.
- Results come back per push in its own sorted order.
- Exports __resetLaneForTests.
- `ponytail:` comment: global lane at ~30 mut/s; per-tenant lanes if throughput ever matters.

sync.service.ts:
- applyPush keeps its sort, its 503 signInToSync pre-check and the alreadyApplied pre-read.
- Non-duplicates then go through runInLane instead of the for-loop.
- applyOne is unchanged; it keeps the advisory lock and the clock-then-row order.

knex.ts: pool max 10 → 16, comment updated.

### 4. Master sync: HLC ordering for stage changes + lead.numbered notice

Files: `master/src/services/sync.service.ts`, `master/src/services/lead.service.ts`, `master/src/services/order.service.ts`, `master/src/services/conflict.service.ts`, `master/src/lib/errors.ts`

errors.ts: add `class StaleEditError extends Error { constructor(readonly conflict: MutationFieldConflict) }`. It is not an AppError, so it is never sent to clients.

lead.service.setStage and order.service.setStage take an optional `edit`. When it is present:
1. Inside the existing db().transaction, after `nextHlc(trx)` (lock order stays clock then row), call leadRepo.lockLead / orderRepo.lockOrder and re-read the row in the trx.
2. Run mergeFields({values:{stageId}, fieldHlc}, {fields:['stageId'], values:{stageId: input.stageId}, baseFieldHlc: baseForUnversionedEdit(['stageId'], fieldHlc, edit.hlc), hlc: edit.hlc, deviceCode}).
3. If stageId is not accepted, throw StaleEditError (nothing has been written; the trx rolls back).
4. Otherwise write using the re-read fieldHlc with stageId: edit.hlc. The row hlc stays the fresh nextHlc.
The pre-transaction no-op check (same stage) and assertStageMove run as today, but only after the stale check passes, so a stale change becomes a conflict rather than a refusal.

sync.service route lead.setStage/order.setStage:
- Pass edit {hlc, baseFieldHlc, deviceCode}.
- Catch StaleEditError and record it with syncRepo.recordConflicts (entity, field 'stageId', losing = offline stage, winning = stored), then publishConflict after commit.
- Return {status:'merged', conflicts:[...]}.

conflict.service restoreLoser: when field === 'stageId', call lead/orderService.setStage({id, stageId: losingValue}, actor) before the markResolved transaction, so the service validation, timeline and activity still apply.

route 'lead.create': after mapTemporaryId, if mutation.actorUserId and Date.now() - parseHlc(mutation.hlc).physical > 60_000, call notify([actorUserId], 'lead.numbered', {number: lead.pendingOrderNumber ?? lead.id}, {kind:'lead', id}, `lead.numbered:<id>`). The number field comes from the numbering domain.

### 5. Master notification store, service, routes, pruner, migration

Files: `master/src/db/migrations/20261003000000_user_notifications.ts (new)`, `master/src/db/migrations/index.ts`, `master/src/repositories/notification.repository.ts (new)`, `master/src/repositories/user.repository.ts`, `master/src/services/notification.service.ts (new)`, `master/src/http/routes/auth.routes.ts`, `master/src/index.ts`, `master/src/repositories/backup.repository.ts`, `master/src/services/catalog-reload-cli.ts`

Migration: as specified in dataModel, appended to the registry.

notification.repository.ts:
- insertNotifications(rows) with ON CONFLICT (tenant_id,user_id,dedupe_key) WHERE … DO NOTHING RETURNING *
- listForUser(tenantId, userId, {limit<=100, before})
- countUnread
- markRead(tenantId, userId, ids|all)
- prune(): read_at < now()-60d, plus rows beyond the newest 500 per user

user.repository.ts: new findActiveUserIdsWithPermission(tenantId, permission), joining roles and checking roles.permissions membership.

notification.service.ts:
- notify() validates kind ∈ NOTIFICATION_KINDS and dedupes userIds, inserts, then publishNotification for each inserted row. It is never called inside a caller's transaction and never touches recordActivity.
- listNotifications and markRead read actor.userId. With no userId they return empty.
- startNotificationPruner(): a daily unref'd setInterval returning a disposer, pushed into the disposables in master/src/index.ts.

auth.routes.ts: GET /api/notifications and POST /api/notifications/read, using requireAuth and actorFromRequest.

Add the table to backup EXCLUDED_TABLES and to BUSINESS_TABLES.

### 6. Office link: reconnect rules, catching-up, disconnectedSince, link poll, rediscovery, version gate, clock skew

Files: `office/src/realtime/master-connection.ts`, `office/src/discovery/client.ts`, `office/src/services/credentials.store.ts`, `office/src/lib/app-version.ts`

MasterConnection:
- New fields: disconnectedSince, catchingUp, revoked, masterProtocol, clockSkewMs, connectFailures, lastRediscoveryAt, hostOverride, rediscoveredFrom.
- `auth: (cb) => cb({kind, panelId, panelSecret, protocol: PANEL_PROTOCOL_VERSION, appVersion: appVersion(), ...(cursor) , ...(this.actingToken ? {actingUserToken} : {})})`. The cursor is computed per call from this.snapshot plus localStore.getCursor().
- io options: reconnectionDelayMax 5_000 and timeout 5_000.

On 'connect':
- Reset failures. catchingUp=true. If hostOverride is set, saveCredentials with the new host/port and set rediscoveredFrom.
- After setTransport(...), call `void flush()`. This is the fix for the no-transport flush hole.

On 'disconnect' (reason):
- Set disconnectedSince ??= now.
- If reason === 'io server disconnect' && !this.revoked && this.socket === socket, schedule socket.connect() after 1 s plus jitter.

On 'connect_error' (err):
- Increment failures and set disconnectedSince ??= now.
- If err.data?.messageKey === 'error.unauthorized.panelNotPaired', run the same path as panel:revoked.
- Else if !socket.active (middleware refusal), retry with backoff 5 s→60 s.
- If failures >= 3 && hasNetworkLink() && now - lastRediscoveryAt > 60 s, call maybeRediscover().

maybeRediscover():
- Calls discoverMasters({timeoutMs:3000}) and keeps entries with masterUniqueId === credentials.masterUniqueId and no conflictingAddress.
- If there is exactly one and its address differs, it sets hostOverride and calls connect().

connect(): uses hostOverride ?? credentials for the URL.

panel:revoked: set this.revoked=true synchronously first.

sync:snapshot/sync:delta:
- Record masterProtocol and clockSkewMs = Date.now() - Date.parse(serverTime).
- After the persist and flush, set catchingUp=false and call emitStatus().
- A 30 s safety timer also clears catchingUp.

Other behaviour:
- setState('connected') clears disconnectedSince.
- A new emitStatus() emits 'status' whenever any status field changes.
- A 2 s unref'd link poll compares hasNetworkLink(). On a change it calls emitStatus(); on regain it calls retryNow().
- retryNow(): when not connected and a socket exists, call socket.disconnect() then socket.connect() (resets the backoff).
- getStatus() returns the new fields.
- command(): if COMMAND_MIN_PROTOCOL[event] > (masterProtocol ?? 1), throw MasterCommandError('Master needs an update', 'updateNeeded', undefined, false, undefined, 'error.updateNeeded.master') before emitting.
- socket.on('notification:new', n => this.emit('notification', n)).

client.ts: when a second HELLO for the same masterUniqueId arrives from a different lanIp:httpPort, set `conflictingAddress: true` on that DiscoveredMaster (new optional field).

### 7. Office HTTP: notifications relay/routes, 426 mapping, flush retry, snapshot policy

Files: `office/src/http/app.ts`, `office/web/src/api.ts`

app.ts:
- masterConnection.on('notification', n => { if (userSession.currentSession()?.user.id === n.userId) broadcast('notification', n) }).
- GET /api/notifications → forward('notification:list', {limit, before}).
- POST /api/notifications/read → forward('notification:markRead', body).
- failForward maps code 'updateNeeded' to 426.
- POST /api/sync/flush calls masterConnection.retryNow() when not connected.
- SNAPSHOT_POLICY.protocol = 'passthrough'.

api.ts (office web):
- ConnectionInfo gains disconnectedSince?, catchingUp?, clockSkewMs?, masterProtocol? and rediscoveredFrom?.
- Add notifications(params) and markNotificationsRead(input).

Mirror the same two members in master/web/src/api.ts.

### 8. Electron attention IPC

Files: `electron/lib/attention.ts (new)`, `electron/shell.ts`, `electron/preload.cts`, `electron/master.main.ts`, `electron/office.main.ts`

attention.ts: attentionText(value: unknown) → {title, body} | null. Both are strings, trimmed, clamped to 120/300 characters; anything else returns null.

shell.ts:
- ipcMain.handle('orderbook:notify'). Reject unless sender === mainWindow.webContents.
- When the window is not focused: flashFrame(true) and once('focus', () => flashFrame(false)).
- If Notification.isSupported(): show a new Notification({title, body}), whose click shows and focuses mainWindow.
- Return true.
- Call app.setAppUserModelId(config.appUserModelId) before ready. This is a new runPanelShell config field set to 'com.orderbook.master' / 'com.orderbook.office' (matching the electron-builder.yml appId). It is not an env var, so server-env.test is unaffected.

preload.cts: notify(n) → ipcRenderer.invoke('orderbook:notify', n).

The API exists in Electron 22, so the Legacy Win7 build works unchanged.

### 9. Shared UI: bell, banner slot, elapsed format

Files: `ui/src/NotificationBell.tsx (new)`, `ui/src/AppShell.tsx`, `ui/src/format.ts`, `ui/src/index.ts`, `ui/src/Icon.tsx`, `eslint.config.js`

NotificationBell as described in uiScreens. Its ref holds any callbacks used inside effects (no-transport-dep rule) and it imports no panel api.

AppShell gets the optional banner prop. format.ts gets formatElapsed. Add the barrel export, the 'bell' icon if missing, and the eslint swept-list entry.

### 10. Office shell wiring

Files: `office/web/src/App.tsx`, `office/web/src/screens/DashboardScreen.tsx`

Rail and popover:
- railState adds the catchingUp → 'syncing' branch with t('sync.catchingUp'). Offline labels gain the elapsed time from disconnectedSince.
- Popover rows: offline since, clock difference (when |skew| > 2 min) and the master host.

Banners and notices:
- When now - disconnectedSince >= LONG_OFFLINE_MS (one setTimeout re-armed when disconnectedSince changes), render the OfflineBanner via AppShell banner, add a local bell item {id:'local:offlineLong'}, and call desktopBridge()?.notify?.({title: t('notification.title'), body: t('office.link.offlineLong', {duration})}) once per disconnectedSince value.
- The clock-skew banner shows when |clockSkewMs| > 120_000.
- When rediscoveredFrom is set, show a one-time info toast.

Bell:
- Fetch api.notifications() on sign-in, on streamEpoch change and when the bell opens. A 503 sets offlineNote and leaves the local items.
- An SSE 'notification' listener prepends the item, increments unread and calls bridge.notify.
- onOpen calls markNotificationsRead({ids:[id]}) and navigates by link kind.

Stream: source.addEventListener('error') marks streamDown, and 'open' after an error bumps streamEpoch and re-runs refreshConnection/refreshSyncState/refreshSession. The effect stays keyed on signedIn only.

DashboardScreen: the sync card renders the passed railState/syncLabel instead of assuming synced.

### 11. Master shell wiring

Files: `master/web/src/App.tsx`, `master/web/src/screens/PanelsScreen.tsx`

Socket and rail:
- socket.on('connect') sets linkUp=true. If it was down before, bump revisions['*'] and refreshUser().
- socket.on('disconnect', reason) sets linkUp=false. If reason === 'io server disconnect', call setTimeout(() => socket.connect(), 1000).
- socket.on('connect_error', e) calls refreshUser() when e.message is 'Session is not valid'.
- revisionOf() adds revisions['*'] ?? 0.
- railState: !linkUp → 'offline' with t('master.sync.serverUnreachable'), checked before the panel aggregate.
- The rail popover lists panels.filter(isLongOffline).

Bell: same wiring as the Office, via api.notifications and socket.on('notification:new').

PanelsScreen: Offline-for chip (isLongOffline + formatElapsed) and an Update-needed chip.

### 12. i18n

Files: `shared/src/i18n/en.ts`, `shared/src/i18n/panel-scoped.ts`

Add these keys (no TODO stubs; no 3+ digit runs; no price words):
- Sync labels: sync.catchingUp; office.sync.offlineSince {time}; office.sync.offlineFor {duration}; office.link.offlineLong {duration}; office.link.offlineLongTitle; office.link.clockSkew {minutes}; office.link.rediscovered {host}; master.sync.serverUnreachable
- Errors: error.updateNeeded.master; error.updateNeeded.office
- Panels: panels.offlineFor {duration}; panels.updateNeeded
- Bell: notification.title, notification.markAllRead, notification.empty, notification.offlineNote, notification.open
- One key per kind: notification.chat.mention {actor} {group}, notification.task.assigned {actor} {task}, notification.task.done {actor} {task}, notification.print.printed {actor} {document}, notification.lead.numbered {number}, notification.panel.offlineLong {panel}
- Units: time.hours.short {count}, time.minutes.short {count}
- Popover: sync.popover.offlineSince, sync.popover.clockSkew

If sync.catchingUp and sync.offlineSince differ per panel, add them to PANEL_SCOPED_KEYS as pairs.

### 13. Tests and guards

Files: `master/tests/sync-lane.integration.test.ts (new)`, `master/tests/sync.integration.test.ts`, `master/tests/panel-push.integration.test.ts`, `master/tests/notifications.integration.test.ts (new)`, `office/tests/master-connection.test.ts (new)`, `office/tests/module-forwarding.test.ts`, `office/tests/snapshot-for-user.test.ts`, `shared/tests/sync.test.ts`, `shared/tests/notifications.test.ts (new)`, `ui/tests/notification-bell.test.tsx (new)`, `ui/tests/office-shell.test.tsx`, `ui/tests/master-shell.test.tsx`, `electron/tests/attention.test.ts (new)`, `master/tests/migration-registry.test.ts`, `master/tests/helpers/fixtures.ts`, `master/tests/web-reachability.test.ts`

See the 'tests' list for each assertion.

### 14. Docs

Files: `docs/STRUCTURE.md`, `docs/LEAD_GENERATION_FLOW.md`, `docs/schema/00-overview.md`, `HANDOFF.md`, `docs/AI_COLLABORATION.md`

See the 'docs' list.

## tests

- NEW master/tests/sync-lane.integration.test.ts:
- 10 panel actors each push one lead.create concurrently (Promise.all of applyPush). All are applied, with no TimeoutAcquiringConnection, and the permanent ids/numbers are distinct and consecutive.
- With the arrival order reversed inside the gather window, ids follow HLC order. Equal physical+counter falls to deviceCode, then mutationId.
- A retryable error injected for one push fails only that push; the others apply.
- Uses __resetLaneForTests with bootAt in the past.
- master/tests/sync.integration.test.ts additions, covering stage HLC ordering:
- A stale offline lead.setStage (hlc older than the stored fieldHlc.stageId) leaves the stage unchanged, writes a sync_conflicts row with field 'stageId', returns status 'merged' and publishes sync:conflict.
- A newer offline setStage applies and fieldHlc.stageId === mutation.hlc.
- The same pair of cases for order.setStage.
- Replaying the mutation id returns 'duplicate'.
- restoreLoser on a stageId conflict moves the stage through the service.
- A lead.create whose HLC is more than 60 s old with an actorUserId creates one 'lead.numbered' notification; a replay does not create a second.
- master/tests/panel-push.integration.test.ts additions, using real sockets:
- io.engine.opts pingInterval/pingTimeout are 4000/6000.
- A handshake carrying actingUserToken gets exactly one sync:snapshot/sync:delta, and a following auth:assume with the same token emits no extra snapshot.
- Panel reconnect race: open socket B for the same panel, then close the old socket A. isPanelConnected stays true and A was force-closed when B connected.
- revokePanel delivers 'panel:revoked' before the disconnect.
- A refused handshake carries err.data.messageKey 'error.unauthorized.panelNotPaired'.
- Handshake protocol is stored on runtime.protocol.
- NEW master/tests/notifications.integration.test.ts:
- notify inserts rows and pushes 'notification:new' only to the target user's admin socket and to the panel socket acting as that user. Other users and other tenants get nothing.
- The dedupe key suppresses an unread duplicate.
- list/markRead/unreadCount over GET/POST /api/notifications.
- notification:list over a panel socket with no acting user returns empty.
- prune removes old read rows.
- The panel-offline timer (fake timers) notifies only panels.manage holders, once per episode, and is cancelled by a reconnect.
- NEW office/tests/master-connection.test.ts (mocks socket.io-client io with an EventEmitter fake whose `active`/connect()/disconnect() are spies, and mocks discovery/credentials):
- A 'disconnect' with 'io server disconnect' schedules connect(). After panel:revoked it does not.
- A connect_error with active=false retries with backoff. A panelNotPaired error clears credentials and moves to unpaired.
- disconnectedSince is set on the first failure and cleared on connect. catchingUp is true until the snapshot is handled, then 'status' is re-emitted.
- auth is a function returning the current cursor and token.
- flush is called after setTransport.
- Rediscovery switches the host only for a single matching masterUniqueId with no conflicting address, and saves credentials only after 'connect'.
- command() with COMMAND_MIN_PROTOCOL above masterProtocol rejects with code 'updateNeeded' without emitting.
- The link poll emits status on a change and calls retryNow on regain.
- office/tests/module-forwarding.test.ts:
- /api/notifications and /api/notifications/read forward to the Master. Unreachable gives 503 error.unavailable; updateNeeded gives 426 with messageKey.
- The SSE 'notification' relay sends only for the current session user.
- office/tests/snapshot-for-user.test.ts: UPDATE, because SNAPSHOT_POLICY keys must equal SyncSnapshot keys and 'protocol' is new.
- shared/tests/sync.test.ts:
- compareForIdAssignment uses mutationId as the final tie-break, and the existing '(hlc, device)' expectations are unchanged.
- baseForUnversionedEdit matches the old inline behaviour: a newer edit gets base = stored, an older edit gets no base.
- NEW shared/tests/notifications.test.ts:
- Every NOTIFICATION_KINDS entry has `notification.<kind>` in EN_MESSAGES. Needed because the template-literal keys are invisible to i18n-call-sites.
- isLongOffline boundaries: connected, null lastSeenAt, and exactly 1 h.
- shared/tests/wire-optionality.test.ts: no edit expected. It must stay green, which proves SyncSnapshot.protocol and the other new fields are optional.
- NEW ui/tests/notification-bell.test.tsx: unread badge, list render via renderText, mark all, Esc/click-away close, offline note, empty state.
- ui/tests/office-shell.test.tsx additions:
- A FakeEventSource 'status' with disconnectedSince 2 h ago shows the long-offline banner and calls window.orderbook.notify exactly once.
- catchingUp shows the 'Catching up' label.
- SSE 'notification' bumps the bell count.
- 'error' then 'open' re-fetches /api/notifications.
- The existing 'stays one stream when the link reports it is connected' test must still pass unchanged.
- The fetch mock must answer /api/notifications (or the bell must swallow a 404).
- ui/tests/master-shell.test.tsx: a fake socket 'disconnect' shows 'Reconnecting to the Master server'. 'connect' after that re-fetches (revision bump). Existing Alt-digit and printPage assertions are untouched.
- NEW electron/tests/attention.test.ts: attentionText clamps lengths and rejects non-strings and missing fields.
- master/tests/migration-registry.test.ts: UPDATE, appending '20261003000000_user_notifications' (or the coordinator's final name) to DELIBERATELY_LAST.
- master/tests/helpers/fixtures.ts: UPDATE, adding 'user_notifications' to DATA_TABLES before 'users'.
- master/tests/socket-contract.test.ts: no edit. 'notification:new' is emitted in master/src and handled in office/src, so it must pass as is.
- master/tests/web-reachability.test.ts: no allow-list entries. The new api.notifications and api.markNotificationsRead members are called from both App.tsx files.
- Unchanged guards that must stay green:
- migration-data-safety (no DELETE/DROP in up())
- change-ring.test (no new ChangedEntity)
- i18n-coverage (no digit runs)
- no-transport-dep
- no-duplicate-ui (barrel export)
- tooling-config (swept-list path exists)
- credential-invariants (the new routes live in auth.routes.ts, which has no per-route needs() rule)
- electron/tests/server-env (no new env vars)
- print-options and shell-log

## docs

- docs/STRUCTURE.md:
- §3.10: protocol counts +2 C→S / +1 S→C; PANEL_PROTOCOL_VERSION and COMMAND_MIN_PROTOCOL; new handshake fields.
- §5.9 realtime: heartbeat values, presence/disconnect ordering, emitToUser, notification channel.
- §6.11: the user_notifications table.
- §8.5/8.6 Office sync and master link: reconnect rules, rediscovery, catching-up, disconnectedSince, link poll, version gate.
- §10.1: the orderbook:notify IPC and AppUserModelId.
- §11.1: the rediscovery addendum.
- §11.3: the apply lane and the full tie-break chain.
- Fix §6.2/§5.1 migration counts.
- docs/LEAD_GENERATION_FLOW.md §7: replace the 'either order gives identical ids' claim with the lane and window semantics and the HLC → counter → device → mutationId chain. §4: stale offline stage changes become conflicts.
- docs/schema/ (sync/realtime file plus 00-overview index): user_notifications.
- HANDOFF.md:
- Key decisions: Rule 1/5/6 behaviour, notification centre, version handshake.
- Correct the stale party_code and lint claims while there.
- Dated session entry.
- docs/AI_COLLABORATION.md: a change-log entry, newest first.

## risks

- Heartbeat flapping: a Master event-loop stall longer than about 10 s would drop every panel at once and reconnect them. The 4 s/6 s margin is chosen for that. If logs show flaps, raise pingTimeout first. Heavy work already runs off the hot path (sharp gate, PDF).
- Gather window and lane latency: every online save waits up to 100 ms, and up to 5 s in the first seconds after Master boot. A 100-mutation offline backlog from one panel delays other panels' saves by about 2-3 s while it drains, because the lane is FIFO across pushes per round. Acceptable at LAN scale; the `ponytail:` note names the upgrade.
- Stage-change semantics change: an offline stage move that loses on timestamp now appears as a Conflict instead of silently overwriting. Conflicts screens and counts will show more rows after long offline spells. Holders of sync.resolveConflicts must review them.
- The setStage `edit` path must keep the nextHlc-then-row-lock order. Reversing it brings back the 40P01 deadlock, which applyOne would record as a permanent rejection.
- Rediscovery trusts the LAN, the same model as pairing over HTTP. A device answering HELLO with a forged masterUniqueId while the real Master is unreachable could receive the panel secret in the handshake. Mitigations: single matching responder, conflicting-address refusal, and switching only after 3 failures. The full fix (TLS or a challenge-response) is out of scope.
- Treating a panelNotPaired refusal as revocation clears the pairing. A Master restored from a backup taken before that panel was paired will force those panels to re-pair. That is correct, but staff will notice.
- Handshake actingUserToken widens nothing: it is the same token auth:assume already sends. But the handshake is resolved before the 'connect' handler's reassume, so a revoked token still has to fall through to reassume's 'rejected' path. Covered by a test.
- Version skew during rollout: a new Office on an old Master gets 426 'update the Master' for new commands, and an old Office ignores notification:new. Master and Office must ship together, per the batch release plan.
- OS toasts on Win10/11 need the AppUserModelId to match the installed shortcut (electron-builder appId). On the Win7 legacy build, Notification.isSupported() may be false, leaving only flashFrame and the in-app bell.
- Notification volume: chat @mentions in a busy group could insert many rows. The dedupe key, the 500-per-user cap and the daily prune bound it. Producers must never call notify() inside their own transaction, and never per plain chat message.

## dependsOn

- Numbering domain: supplies lead.pendingOrderNumber (used in the 'lead.numbered' params) and allocates numbers inside createLead. Relies on this domain's sync lane for cross-panel HLC ordering of creates, and on the 'Provisional' label for temporary ids. Its migration must be ordered with 20261003000000_user_notifications in DELIBERATELY_LAST.
- Chatroom/tasks domain: calls notify() for chat.mention, task.assigned and task.done. Uses emitToUser and the Office streamEpoch for list re-fetch on reconnect. Owns the record deep links (#/lead/<id>, #/order/<id>) that the bell's onOpen navigates to. Its new commands go into COMMAND_MIN_PROTOCOL = 2.
- Printroom domain: calls notify() for print.printed. Checks runtime.protocol >= 2 before targeting a printer panel. Reuses DesktopBridge.notify for job arrival on the printer PC.
- Presence/avatars domain: reuses emitToUser and SocketData.actingUserId (set here). Clears presence on the hub disconnect path that this domain restructures.
- Master UI / Basic Home domain: footers keep `.ob-footer-sync` with this domain's railState and syncLabel, and it places the bell in the topbar. Dashboard and Basic Home get a 'Panels offline > 1 h' tile (Master) and a sync tile driven by railState (Office). AppShell gains the banner prop.
- Roles/Server Master domain: the Server Master tier must hold panels.manage so it receives panel-offline notices. Server Master tokens must never be passed in an Office handshake, which already holds because Server Master sign-in is loopback-only on the Master.
- Audit-log domain: connectivity events (reconnects, rediscovery) and notifications are deliberately NOT written to activity_log, which avoids the chain-lock serialisation.
- Backup-all domain: user_notifications is in EXCLUDED_TABLES.
- Win7 legacy Office build: master-connection.ts, the attention IPC and the socket options are all Node 16 / Electron 22 compatible (no fetch, AbortSignal.any or Readable.fromWeb added).

## openQuestions


## effort

About 38 files touched, 6 of them new source files (sync-lane.ts, notifications.ts, notification.repository.ts, notification.service.ts, NotificationBell.tsx, attention.ts), plus 1 migration and 6 new test files. Roughly 1,300 new or changed source LOC and 900 test LOC, plus about 60 i18n keys. 2 focused sessions: (1) shared contracts, hub, sync lane, stage HLC and the Office link; (2) notifications end to end, Electron IPC, both shells' UI, tests and docs.
