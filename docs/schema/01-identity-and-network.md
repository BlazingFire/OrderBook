# Schema — Identity & Network

Covers the tables behind Master Panel setup, sign-in, and Office Panel pairing
(`PROJECT_PLAN.md` §4–5).

## `master_config`

Singleton table — exactly one row, created by the first-run setup screen and never
duplicated (`CHECK (id = 1)` enforces this at the DB level).

```sql
CREATE TABLE master_config (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  master_unique_id    TEXT    NOT NULL UNIQUE,   -- UUID, generated on first run
  company_name        TEXT,
  lan_ip              TEXT    NOT NULL,           -- detected at setup, refreshed on IP change
  port                INTEGER NOT NULL,
  pairing_password_hash TEXT  NOT NULL,           -- bcrypt hash of the pairing password
                                                    -- shown once on first-run screen (PROJECT_PLAN §5.1)
  setup_completed_at  TEXT    NOT NULL,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
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
  id            TEXT PRIMARY KEY,                 -- UUID
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                    -- bcrypt
  full_name     TEXT,
  role          TEXT NOT NULL DEFAULT 'admin'
                CHECK (role IN ('admin', 'staff')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
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
  id            TEXT PRIMARY KEY,                 -- UUID, issued by Master at pairing time
  name          TEXT NOT NULL,                    -- e.g. "Front Office PC", editable by admin
  secret_hash   TEXT NOT NULL,                    -- bcrypt hash of the panel's permanent pairing secret
  lan_ip        TEXT,                              -- last-known IP, informational only
  mac_address   TEXT,                              -- optional, helps re-identify a panel across DHCP lease changes
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'active', 'revoked')),
  paired_at     TEXT,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX idx_office_panels_status ON office_panels(status);
```

| Column | Notes |
|---|---|
| `secret_hash` | The plaintext secret is generated once, sent to the Office Panel over the pairing handshake, and stored locally on that Office PC (outside the DB, e.g. a local config file) — Master only ever stores the hash, same pattern as a password. |
| `status` | `pending` while a discovery handshake is in progress, `active` once paired, `revoked` if the admin removes it from Master's "Connected Office Panels" screen — a revoked panel's secret is rejected on its next reconnect attempt even though the row is kept for history/audit. |
| `last_seen_at` | Updated on every Socket.IO heartbeat; drives the live connected/offline indicator in `PROJECT_PLAN.md` §5.4. |

### Why not delete a panel row on removal?

`leads.source_panel_id` (see `03-leads-orders-inventory.md`) references
`office_panels.id`. Deleting the row would either cascade-delete lead history or
leave a dangling reference. `status = 'revoked'` preserves "this lead came from the
panel that used to be called X" without either problem.
