# Schema — Identity & Network

Covers the tables behind Master Panel setup, sign-in, and Office Panel pairing
(`PROJECT_PLAN.md` §4–5). PostgreSQL DDL describing the current shape — see
`00-overview.md` for the type/convention rationale and how this was checked, and
`06-tenancy-permissions-and-sync.md` for `tenants` and `roles`.

## `master_config`

Singleton table — at most one row, written by first-run setup (or by a restore from a
backup run from the first-run screen) and never duplicated: `CHECK (id = 1)`
enforces this at the DB level. A freshly migrated database has **no** row;
`isSetupComplete()` is exactly "does the row exist".

```sql
CREATE TABLE master_config (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  master_unique_id       UUID    NOT NULL UNIQUE,   -- generated at first-run setup
  company_name           TEXT,
  lan_ip                 TEXT    NOT NULL,           -- detected at setup, refreshed at every boot
  port                   INTEGER NOT NULL,
  pairing_password_hash  TEXT    NOT NULL,           -- bcrypt hash of the pairing password
                                                       -- shown once on the first-run screen (PROJECT_PLAN §5.1)
  setup_completed_at     TIMESTAMPTZ NOT NULL,
  tenant_id              UUID REFERENCES tenants(id), -- the installation's tenant; nullable
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

| Column | Notes |
|---|---|
| `master_unique_id` | Shown on the first-run screen and to Office Panels doing manual connection. |
| `lan_ip` | Best-effort detected IP; `refreshStoredLanIp()` re-checks it at every boot since DHCP can reassign it. Office Panels reconnect using the last-known IP first, then fall back to auto-discovery if it doesn't respond. |
| `pairing_password_hash` | Only used to authorize a **new** Office Panel manual pairing — not the same as any `users` sign-in password. Already-paired panels keep their own `office_panels.secret_hash` (below), so replacing it never unpairs anyone. It is set at first-run setup and replaced only by a restore, which regenerates it (and revokes every panel); there is no rotate action in Settings. |
| `tenant_id` | Added by `20260301000000_tenancy_access_and_sync`, nullable because the table predates tenancy. Setup fills it with the tenant the migration seeded. |

## `users`

Sign-in accounts for people, on both panels (`PROJECT_PLAN.md` §5.2). The behaviour
behind these columns is in `docs/ROLES_AND_USERS.md`: the columns themselves in §4,
the tier ceiling in §3.1 and §5, sign-in in §12, deactivate versus delete versus
restore in §14, and why users cannot yet be created offline in §15.5.

```sql
CREATE TABLE users (
  id                  TEXT PRIMARY KEY,                 -- 'US' + 10 digits
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  username            TEXT NOT NULL,
  password_hash       TEXT NOT NULL,                    -- scrypt (see below)
  display_name        TEXT NOT NULL,
  role_id             TEXT,                             -- roles.id; deliberately no foreign key
  is_active           BOOLEAN NOT NULL DEFAULT true,
  last_sign_in_at     TIMESTAMPTZ,
  -- profile picture (20260312000000_user_avatars)
  avatar_id           UUID,                             -- names the avatar's folder on disk
  avatar_blurhash     TEXT,
  avatar_size         INTEGER,                          -- px; the stored `full` variant is square
  avatar_byte_size    INTEGER,
  avatar_uploaded_at  TIMESTAMPTZ,
  -- plumbing: audit, soft delete, sync
  created_by          TEXT,
  updated_by          TEXT,
  deleted_at          TIMESTAMPTZ,
  deleted_by          TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  hlc                 TEXT,
  field_hlc           JSONB NOT NULL DEFAULT '{}',
  temporary_id        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_username_unique ON users (tenant_id, lower(username)) WHERE deleted_at IS NULL;
CREATE INDEX        users_by_role         ON users (tenant_id, role_id)   WHERE deleted_at IS NULL;
CREATE INDEX        users_active          ON users (tenant_id, is_active) WHERE deleted_at IS NULL;
CREATE INDEX        idx_users_deleted     ON users (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX        idx_users_tenant      ON users (tenant_id);
```

No user is seeded by a migration. First-run setup inserts one, username `admin`,
display name `Administrator`, holding the seeded Admin role; every other account is
created by an administrator.

| Column | Notes |
|---|---|
| `id` | A text id, like every record type in `SYNCABLE_ENTITIES`, so the schema can take a user minted on a panel before the Master has seen it. The sync layer does not do that yet: there is no `user.*` mutation kind, so every user is created through the Master's own API and gets a permanent id at once, and `temporary_id` stays NULL (`docs/ROLES_AND_USERS.md` §15.5). |
| `username` | Unique per tenant, case-insensitively, **among live rows only**: without the `WHERE deleted_at IS NULL` a deleted user would reserve their username forever, and someone who left and came back could not be re-created. |
| `password_hash` | `scrypt$N$r$p$salt$hash` (`master/src/lib/password.ts`). Hashes written before scrypt are bcrypt; sign-in accepts either and rewrites a bcrypt hash to scrypt on the next successful sign-in. First-run setup still writes the `admin` hash as bcrypt, so it is upgraded on that account's first sign-in. |
| `role_id` | Points at `roles.id` with **no** SQL foreign key (`docs/ROLES_AND_USERS.md` §4.1). Roles are soft-deleted, so a restored role must reattach to the users still pointing at it. And once users and roles can be created offline — not built yet (§15.5) — a mutation creating a user could arrive before the one creating its role, and a hard FK would reject the projection and break idempotent replay. The service layer checks the reference. |
| `is_active` / `deleted_at` | Deactivating (`is_active = false`) and deleting (the Recycle Bin) are different acts; neither removes the row. Nothing hard-deletes a single user — Developer mode's **Erase everything** (`resetAllData` in `developer.service.ts`) drops the whole schema, and the catalogue reload script (`catalog-reload-cli.ts`) keeps `users` — which is why the columns that *do* reference `users(id)` with a foreign key — `leads.owner_id`, `leads.created_by_user_id`, `orders.owner_id`, `orders.created_by_user_id`, `parties.created_by_user_id`, `stock_movements.created_by_user_id`, `timeline_entries.actor_user_id`, `sync_conflicts.resolved_by_user_id` — can never dangle. |
| `avatar_*` | Metadata only: the image variants are files under `<dataDir>/uploads/images/<tenantId>/avatars/<avatar_id>/` (`00-overview.md` §4). `avatar_id` is a plain UUID, not a reference into `product_images`: an avatar shares none of a gallery's semantics, and reusing that table would make every product-image query exclude avatars. |

*History:* the initial schema created `users` with a UUID `id`, a globally unique
`username`, an optional `full_name`, a two-value `role` (`admin`/`staff`) and
`last_login_at`. `20260301000000_tenancy_access_and_sync` added `tenant_id`, made the
username unique per tenant and replaced `role` with a `role_id` into the new `roles`
table. `20260303000000_roles_and_users` moved `id` to text, renamed `full_name` to a
required `display_name` (backfilled from `username`) and `last_login_at` to
`last_sign_in_at`, added soft delete and sync bookkeeping, and re-created `role_id` as
TEXT without a foreign key.

## `office_panels`

One row per paired Office Panel PC (`PROJECT_PLAN.md` §4.1, §5.4).

```sql
CREATE TABLE office_panels (
  id                  UUID PRIMARY KEY,                 -- issued by the Master at pairing time
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  name                TEXT NOT NULL,                    -- e.g. "Front Office PC", editable by admin
  secret_hash         TEXT NOT NULL,                    -- bcrypt hash of the panel's permanent pairing secret
  device_code         TEXT NOT NULL,                    -- 6 chars, derived from id; prefixes its temporary ids
  role_id             TEXT,                             -- roles.id, no FK; NULL = the seeded Office role
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'active', 'revoked')),
  paired_at           TIMESTAMPTZ,
  last_seen_at        TIMESTAMPTZ,
  lan_ip              TEXT,                             -- last-known IP, informational only
  mac_address         TEXT,                             -- never written (see below)
  secret_rotated_at   TIMESTAMPTZ,
  master_proof_key    TEXT,                             -- HMAC of the secret, for rediscovery (below)
  notes               TEXT,                             -- free text an admin keeps against the panel
  -- what the panel says about its own machine (next section)
  hostname            TEXT,
  platform            TEXT,
  os_version          TEXT,
  app_version         TEXT,
  node_version        TEXT,
  data_dir            TEXT,
  images_dir          TEXT,
  storage_bytes       BIGINT,
  disk_free_bytes     BIGINT,
  disk_total_bytes    BIGINT,
  local_port          INTEGER,
  panel_started_at    TIMESTAMPTZ,
  device_reported_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_office_panels_device ON office_panels (tenant_id, device_code);
CREATE INDEX        idx_office_panels_status ON office_panels (status);
CREATE INDEX        idx_office_panels_tenant ON office_panels (tenant_id);
```

| Column | Notes |
|---|---|
| `secret_hash` | The plaintext secret is generated once, sent to the Office Panel over the pairing handshake, and stored locally on that Office PC (outside any database, in its `pairing.json`) — the Master only ever stores the hash, same pattern as a password. |
| `device_code` | `deviceCodeFromSeed(id)` — derived from the panel id rather than random, so a panel that loses its local files recovers the same code, and the temporary ids it minted (`<device code><counter>`) stay attributable to it. Unique per tenant. |
| `role_id` | Which role the panel's own commands act under. `NULL` falls back to the seeded **Office** role (`06-tenancy-permissions-and-sync.md` §2): enough to raise and progress a lead and nothing more. |
| `status` | `active` once paired, `revoked` if the admin removes it from the Master's "Connected Office Panels" screen (or a restore revokes every panel) — a revoked panel's secret is rejected on its next reconnect attempt even though the row is kept for history/audit. `pending` is allowed by the CHECK but nothing writes it today: pairing inserts the row as `active`. |
| `last_seen_at` | Stamped when the panel's socket connects and again when it disconnects (`markPanelConnected` / `markPanelDisconnected` in `panel.service.ts`), with `lan_ip` refreshed on connect. The live connected/offline indicator (`PROJECT_PLAN.md` §5.4) comes from the Master's in-memory set of connected sockets, not from this column; the column is what "last seen" shows for a panel that is off. |
| `mac_address` | From the initial schema, meant to re-identify a panel across DHCP lease changes. Nothing in `master/src` writes or reads it. |
| `master_proof_key` | HMAC-SHA256 of the panel secret over `'orderbook/master-proof/v1'`, hex (`MASTER_PROOF_CONTEXT`, `shared/src/protocol/discovery.ts`). `POST /api/panel/prove` answers an HMAC of the panel's nonce with it, so a panel that finds its Master at a new address can check it is the same Master before sending its secret. Written at pairing and at secret rotation; a panel paired before 1.3 gets it the next time it connects (`authenticatePanel`), and until then its proof is a 404. Left out of the `.obbackup` export (`dumpTable`), and cleared when that restore revokes the panels: with the panels revoked the key has no use, so it is not put in a file. The Phase 8 archive keeps the pairing, so its export must carry this column for a restored Master to prove itself. |

*History:* the initial schema had the identity columns and `status` only.
`20260301000000_tenancy_access_and_sync` added `tenant_id`, `device_code` and a
UUID `role_id`; `20260303000000_roles_and_users` re-created `role_id` as TEXT without
a foreign key; `20260312000000_office_panel_administration` added the rest;
`20261002000001_office_panel_master_proof` added `master_proof_key` (1.3).

### What the panel says about its own machine

`20260312000000_office_panel_administration` adds the columns behind the
Master's per-panel administration screen. None of them can be discovered: an
Office Panel binds its HTTP server to loopback, so the Master has no way to ask
it a question — the panel volunteers all of this over `panel:report` on connect
and on a five-minute timer.

| Column | Notes |
|---|---|
| `hostname` … `device_reported_at` | Nullable, and nothing is backfilled. A panel paired before this existed has reported nothing, and "unknown" has to stay distinguishable from "zero" — a `disk_free_bytes` defaulted to 0 reads as a full disk on every panel in the company. `platform` is Node's token (`win32` / `darwin` / `linux`); `data_dir` and `images_dir` are absolute paths **on that PC**; `panel_started_at` is the panel process, not the machine. |
| `device_reported_at` | Stamped from the Master's clock, never from the payload. A panel whose PC has the wrong date must not be able to claim its figures are newer than they are. |
| `secret_rotated_at` | Separate from `updated_at`, which a rename also touches. "When did this panel's credentials last change" is a question about exactly one event. |
| `data_dir` | Follows a `panel:setStoragePath` immediately rather than waiting for the panel's next timed report, so the screen agrees with what just happened. |

Every `ADD COLUMN` in that migration carries `IF NOT EXISTS` because `app_version`
also shipped separately, on `dev`, as `20260313000000_panel_app_version`; that file
stays in the registry as an idempotent no-op so databases that ran it still boot.

Figures that are only true while a panel is connected — queued mutations,
cached images, snapshot age, who is signed in — are deliberately **not** here.
They live in a memory map on the Master (`panel.service.ts`), because a stored
"12 changes pending" would keep asserting a backlog for a panel that has been
switched off for a week.

### Why not delete a panel row on removal?

`leads.source_panel_id` and `orders.source_panel_id` (see
`03-leads-orders-inventory.md`) reference `office_panels.id`, and the activity log
names panels as actors. Deleting the row would either cascade-delete lead history or
leave a dangling reference. `status = 'revoked'` preserves "this lead came from the
panel that used to be called X" without either problem.

### There is no credentials table

The pairing password's hash is on `master_config`, each panel's secret hash on
`office_panels`. The verifiers a panel keeps so people can sign in on it while the
Master is off live on that panel, not here; `panel-credential.repository.ts` tells a
panel whether they are still valid by returning a digest of each user's
`password_hash` (`fingerprintForUser`), never the hash itself.

## `user_notifications`

One notice for one person: the bell on both panels (1.3 Phase 3,
`20261002000000_user_notifications`).

```sql
CREATE TABLE user_notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind ~ '^[a-z]+[.][a-zA-Z]+$'),  -- e.g. panel.offlineLong
  params      JSONB NOT NULL DEFAULT '{}',                       -- fills notification.<kind>
  link        JSONB,                                             -- { kind, id } to open, or NULL
  dedupe_key  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);

CREATE INDEX        idx_user_notifications_user_created ON user_notifications (tenant_id, user_id, created_at DESC);
CREATE INDEX        idx_user_notifications_unread       ON user_notifications (tenant_id, user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX uq_user_notifications_unread_dedupe ON user_notifications (tenant_id, user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND read_at IS NULL;
```

| Column | Notes |
|---|---|
| `kind` | One of `NOTIFICATION_KINDS` (`shared/src/domain/notifications.ts`); the CHECK only holds the shape, so a later kind needs no migration. |
| `dedupe_key` | While an unread notice with this key exists for a person, another is not added (a panel that keeps dropping is one notice until it is read). |
| `read_at` | Set when the person marks it read. Read notices older than 60 days, and anything past a person's newest 500, are pruned every six hours by the notification service (`startNotificationPruner`), not by a migration. |

Not carried in a backup (`EXCLUDED_TABLES`): the notices are about this installation's
own events and point at ids a restore may give to other records.


## Chatroom tables — `chat_rooms`, `chat_members`, `chat_messages`

Added in 1.3 Phase 6 (migration #5, `20261005000000_chatroom`). Text-only chat; the shapes are in
`shared/src/domain/chat.ts`, the SQL in `master/src/repositories/chat.repository.ts`. None of the
three is a sync table: they never enter the change ring or the offline merge, and posts from an Office
travel as `chat.post` mutations (`docs/LEAD_GENERATION_FLOW.md` section 4). Every column that names a
person is `TEXT REFERENCES users(id)`; users are soft-deleted and restorable, so the reference cannot
dangle. All three carry `tenant_id`, so a backup in `selected` scope takes them without a
transitively-scoped entry. `wipe:business` empties them and restarts the `chat_message` counter.

```sql
CREATE TABLE chat_rooms (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('group','direct','announcement')),
  name            TEXT NULL CHECK (kind = 'direct' OR char_length(btrim(name)) BETWEEN 1 AND 60),
  description     TEXT NULL CHECK (description IS NULL OR char_length(description) <= 280),
  direct_key      TEXT NULL CHECK ((kind = 'direct') = (direct_key IS NOT NULL)),  -- the two user ids, ordered
  last_seq        BIGINT NOT NULL DEFAULT 0,        -- bumped under the row lock, gap-free
  last_message_at TIMESTAMPTZ NULL,
  created_by      TEXT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ NULL,
  archived_by     TEXT NULL REFERENCES users(id)
);
CREATE UNIQUE INDEX chat_rooms_direct_key_uq ON chat_rooms (tenant_id, direct_key) WHERE direct_key IS NOT NULL;
CREATE UNIQUE INDEX chat_rooms_group_name_uq ON chat_rooms (tenant_id, lower(name))
  WHERE kind <> 'direct' AND archived_at IS NULL;
CREATE INDEX chat_rooms_recent_idx ON chat_rooms (tenant_id, last_message_at DESC);

CREATE TABLE chat_members (
  room_id       UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id),
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  muted         BOOLEAN NOT NULL DEFAULT false,
  last_read_seq BIGINT NOT NULL DEFAULT 0,          -- unread = chat_rooms.last_seq - last_read_seq
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX chat_members_user_idx ON chat_members (tenant_id, user_id);

CREATE TABLE chat_messages (
  id            TEXT PRIMARY KEY CHECK (id ~ '^CM[0-9]{10}$'),   -- permanent-id scheme, entity 'chat_message'
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_id       UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  seq           BIGINT NOT NULL,                              -- per room, from 1, gap-free
  author_id     TEXT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('text','task','system')),
  body          TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 4000),
  refs          JSONB NOT NULL DEFAULT '[]',                  -- [{kind:'lead'|'order', id}] - no label, no party
  mentions      JSONB NOT NULL DEFAULT '[]',                  -- user ids
  system        JSONB NULL,                                   -- {event, params} for kind = 'system'
  client_id     TEXT NULL,                                    -- the Office mutation id, for replay
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at     TIMESTAMPTZ NULL,
  deleted_at    TIMESTAMPTZ NULL,                             -- a tombstone: the body stays, is never served
  deleted_by    TEXT NULL REFERENCES users(id),
  pinned_at     TIMESTAMPTZ NULL,
  pinned_by     TEXT NULL REFERENCES users(id),
  task_assignees JSONB NULL,
  task_due_on   DATE NULL,
  task_done_at  TIMESTAMPTZ NULL,
  task_done_by  TEXT NULL REFERENCES users(id),
  CONSTRAINT chat_messages_task_only CHECK (kind = 'task' OR task_assignees IS NULL),
  CONSTRAINT chat_messages_room_seq_uq UNIQUE (room_id, seq)
);
CREATE UNIQUE INDEX chat_messages_client_uq ON chat_messages (tenant_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX chat_messages_room_seq_idx ON chat_messages (room_id, seq DESC);
CREATE INDEX chat_messages_pinned_idx ON chat_messages (room_id) WHERE pinned_at IS NOT NULL;
CREATE INDEX chat_messages_open_tasks_idx ON chat_messages (tenant_id)
  WHERE kind = 'task' AND task_done_at IS NULL AND deleted_at IS NULL;
```

- **Gap-free numbering.** `postMessage` locks the room row (`SELECT ... FOR UPDATE`), bumps
  `last_seq`, allocates the `CM` id from `id_sequences` and inserts, in one transaction, and moves the
  author's own `last_read_seq` with it. Lock order is the room row, then `id_sequences`; nothing takes
  them the other way round.
- **Kinds.** `announcement` is a group only its admins (and `chat.manage` holders) may post in; a group
  becomes one and back by changing `kind`. A direct chat has no name and a `direct_key`.
- **Tombstones.** A deleted message keeps its body in the table for the record and the mapper serves
  `''`, no chips and no task. Messages are not in the Recycle Bin and are never purged.
- **Receipts.** A task's "seen by n of m" is `members.last_read_seq >= message.seq`; there is no
  receipt table.
- **Grant.** The same migration unions `chat.*` into `roles.permissions` (all six for `admin` and
  `server_master`, `chat.use` + `chat.shareRecords` for `office` and `management`); see
  `docs/ROLES_AND_USERS.md` section 5.
