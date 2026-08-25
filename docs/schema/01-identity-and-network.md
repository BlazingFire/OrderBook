# Schema — Identity & Network

Covers the tables behind Master Panel setup, sign-in, and Office Panel pairing
(`PROJECT_PLAN.md` §4–5). PostgreSQL DDL — see `00-overview.md` for the type/
convention rationale.

## `master_config`

Singleton table — exactly one row, created by the first-run setup screen and never
duplicated (`CHECK (id = 1)` enforces this at the DB level).

```sql
CREATE TABLE master_config (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  master_unique_id       UUID    NOT NULL UNIQUE,   -- generated on first run
  company_name           TEXT,
  lan_ip                 TEXT    NOT NULL,           -- detected at setup, refreshed on IP change
  port                    INTEGER NOT NULL,
  pairing_password_hash  TEXT    NOT NULL,           -- bcrypt hash of the pairing password
                                                       -- shown once on first-run screen (PROJECT_PLAN §5.1)
  setup_completed_at     TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

| Column | Notes |
|---|---|
| `master_unique_id` | Shown on the first-run screen and to Office Panels doing manual connection. |
| `lan_ip` | Best-effort detected IP; re-checked at server startup since DHCP can reassign it. Office Panels reconnect using the last-known IP first, then fall back to auto-discovery if it doesn't respond. |
| `pairing_password_hash` | Only used to authorize a **new** Office Panel manual pairing — not the same as any `users` sign-in password. Rotatable from Master Settings without affecting already-paired panels (they keep their own `office_panels.secret_hash`, see below). |

## `users`

Master Panel sign-in accounts (`PROJECT_PLAN.md` §5.2). v1 ships with a single
admin created during first-run setup; the table supports more from day one since
adding staff logins later shouldn't require a migration.

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                    -- bcrypt
  full_name     TEXT,
  role          TEXT NOT NULL DEFAULT 'admin'
                CHECK (role IN ('admin', 'staff')),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_users_username ON users(username);
```

`role` is deliberately just two values for v1 (full Phase 2 permissions model is
listed as deferred in `PROJECT_PLAN.md` §11) but exists now so `leads.created_by_user_id`
and `activity_log.actor_id` have something stable to point at.

## `office_panels`

One row per paired Office Panel PC (`PROJECT_PLAN.md` §4.1, §5.4).

```sql
CREATE TABLE office_panels (
  id            UUID PRIMARY KEY,                 -- issued by Master at pairing time
  name          TEXT NOT NULL,                    -- e.g. "Front Office PC", editable by admin
  secret_hash   TEXT NOT NULL,                    -- bcrypt hash of the panel's permanent pairing secret
  lan_ip        TEXT,                              -- last-known IP, informational only
  mac_address   TEXT,                              -- optional, helps re-identify a panel across DHCP lease changes
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'active', 'revoked')),
  paired_at     TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_office_panels_status ON office_panels(status);
```

| Column | Notes |
|---|---|
| `secret_hash` | The plaintext secret is generated once, sent to the Office Panel over the pairing handshake, and stored locally on that Office PC (outside the DB, e.g. a local config file) — Master only ever stores the hash, same pattern as a password. |
| `status` | `pending` while a discovery handshake is in progress, `active` once paired, `revoked` if the admin removes it from Master's "Connected Office Panels" screen — a revoked panel's secret is rejected on its next reconnect attempt even though the row is kept for history/audit. |
| `last_seen_at` | Updated on every Socket.IO heartbeat; drives the live connected/offline indicator in `PROJECT_PLAN.md` §5.4. |

### What the panel says about its own machine

`20260312000000_office_panel_administration` adds the columns behind the
Master's per-panel administration screen. None of them can be discovered: an
Office Panel binds its HTTP server to loopback, so the Master has no way to ask
it a question — the panel volunteers all of this over `panel:report` on connect
and on a five-minute timer.

```sql
ALTER TABLE office_panels
  ADD COLUMN notes              TEXT,        -- free text an admin keeps against the panel
  ADD COLUMN hostname           TEXT,
  ADD COLUMN platform           TEXT,        -- Node's token: win32 / darwin / linux
  ADD COLUMN os_version         TEXT,
  ADD COLUMN app_version        TEXT,
  ADD COLUMN node_version       TEXT,
  ADD COLUMN data_dir           TEXT,        -- absolute path of its data folder ON THAT PC
  ADD COLUMN images_dir         TEXT,
  ADD COLUMN storage_bytes      BIGINT,
  ADD COLUMN disk_free_bytes    BIGINT,
  ADD COLUMN disk_total_bytes   BIGINT,
  ADD COLUMN local_port         INTEGER,
  ADD COLUMN panel_started_at   TIMESTAMPTZ, -- that panel process, not the machine
  ADD COLUMN device_reported_at TIMESTAMPTZ, -- stamped by the MASTER on receipt
  ADD COLUMN secret_rotated_at  TIMESTAMPTZ;
```

| Column | Notes |
|---|---|
| every column above | Nullable, and nothing is backfilled. A panel paired before this existed has reported nothing, and "unknown" has to stay distinguishable from "zero" — a `disk_free_bytes` defaulted to 0 reads as a full disk on every panel in the company. |
| `device_reported_at` | Stamped from the Master's clock, never from the payload. A panel whose PC has the wrong date must not be able to claim its figures are newer than they are. |
| `secret_rotated_at` | Separate from `updated_at`, which a rename also touches. "When did this panel's credentials last change" is a question about exactly one event. |
| `data_dir` | Follows a `panel:setStoragePath` immediately rather than waiting for the panel's next timed report, so the screen agrees with what just happened. |

Figures that are only true while a panel is connected — queued mutations,
cached images, snapshot age, who is signed in — are deliberately **not** here.
They live in a memory map on the Master (`panel.service.ts`), because a stored
"12 changes pending" would keep asserting a backlog for a panel that has been
switched off for a week.

### Why not delete a panel row on removal?

`leads.source_panel_id` (see `03-leads-orders-inventory.md`) references
`office_panels.id`. Deleting the row would either cascade-delete lead history or
leave a dangling reference. `status = 'revoked'` preserves "this lead came from the
panel that used to be called X" without either problem.
