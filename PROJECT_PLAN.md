# OrderBook — Offline LAN Order & Inventory Management System

Project spec for a ceramic company's internal order/inventory tool. This document is
the source of truth for architecture, data model, and phased build plan. Read this
before writing code in any future session.

## 1. Context & Constraints

- **No internet, ever.** The software runs entirely on a local WiFi/LAN with no
  external services, CDNs, or cloud calls. All fonts, libraries, and assets must be
  bundled locally — nothing loaded from the web at runtime.
- **Runs in a browser.** Both panels are web apps (HTML/CSS/JS delivered over HTTP),
  not native desktop apps. No Electron requirement.
- **Two cooperating programs, one network:**
  - **Master Panel** — runs on one PC, connected to the local router. It is the
    single source of truth: it owns the database and all files (images, documents).
  - **Office Panel** — runs on one or more other PCs on the same WiFi/LAN. It is a
    thin client used by staff to create leads, manage parties/products, and convert
    leads to orders. It has no independent database — everything it does talks live
    to the Master Panel.
- **Works regardless of network setup.** DHCP or static IP, doesn't matter —
  pairing must "just work" without the user typing IP addresses when possible
  (auto-discovery), with a manual fallback when it can't.
- **Everyone is a normal, non-technical ceramic-shop user.** UI must be simple,
  guided, and forgiving. Function first, polish later (explicitly deprioritized by
  the user for this pass).

## 2. High-Level Architecture

```
┌────────────────────────────── Local WiFi Router (no internet) ───────────────────────────────┐
│                                                                                                  │
│   ┌───────────────────────────────┐            ┌───────────────────────────────┐              │
│   │        MASTER PANEL PC         │            │        OFFICE PANEL PC(s)      │              │
│   │  Node.js server (Express)      │  LAN/WiFi  │  Node.js server (Express)      │              │
│   │  + WebSocket (Socket.IO) hub   │◄──────────►│  + WebSocket (Socket.IO) client│              │
│   │  + SQLite database             │  HTTP/WS   │  (thin — no local DB, just a   │              │
│   │  + local file storage (images) │            │   session cache of the last    │              │
│   │  Browser → http://localhost:PORT│           │   synced state for snappy UI)  │              │
│   │  (or http://<master-ip>:PORT   │            │  Browser → http://localhost:PORT│             │
│   │   from any PC on the LAN)      │            │                                 │              │
│   └───────────────────────────────┘            └───────────────────────────────┘              │
│                                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Each PC runs its own local Node.js server + serves its own web UI (built React app)
  on `localhost`. Staff open a browser and go to `http://localhost:<port>`.
- The **Office Panel server** is a thin proxy/client: it holds a live Socket.IO
  connection to the Master, forwards UI actions to it, and mirrors pushed state
  changes back down to its browser tab(s) in real time. It keeps a small in-memory/
  disk cache purely so its own UI doesn't flash empty on reconnect — Master remains
  the only durable store.
- **All writes happen on the Master.** Office Panel never writes its own database;
  it sends commands (create lead, update product, etc.) over the socket and Master
  persists them, then broadcasts the resulting change to every connected Office
  Panel (including the one that sent it, for confirmation).

## 3. Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js (LTS) | Single runtime for both panels, no internet needed after initial local install |
| HTTP server | Express | Minimal, well understood, easy to serve a built SPA + REST endpoints |
| Real-time sync | Socket.IO | Auto-reconnect, room support, works fine over raw LAN, easy pub/sub for "live updating" |
| Database (Master only) | SQLite (`better-sqlite3`) | Zero-config, single file, no separate DB server to install/manage on a shop PC |
| File storage (Master only) | Local filesystem under a `data/uploads/` directory, referenced by path in SQLite | Simple, no blob-in-DB overhead |
| Frontend | React + Vite, built to static assets and served by Express | Fast dev loop, but ships as plain static files — no runtime internet dependency |
| Styling | Plain CSS / CSS modules, no CDN-hosted UI kit | Keeps the app fully offline-safe; visual polish is an explicit later pass |
| Discovery protocol | UDP broadcast on the LAN subnet (custom, tiny JSON messages) | mDNS libraries are flaky across mixed Windows/Linux LAN setups; a broadcast ping/pong is simpler to reason about and debug |
| Auth | Locally generated credentials (ID/password) checked against the Master's SQLite; session cookie per browser | No external auth provider is possible/allowed |

Both panels share a `/shared` package (types, the discovery protocol, and the
Socket.IO event contract) so Master and Office never drift out of sync on the wire
format.

## 4. Network Discovery & Pairing

Two explicit modes, Office Panel always shows both:

### 4.1 Auto Connection (recommended, default)

1. On the **Master**, the operator opens **Add Office Panel** in the Master Panel.
   Master starts listening on a UDP broadcast port and shows **"Waiting for office
   panel…"**.
2. On the **Office Panel PC**, the first-run screen shows a live **router
   connectivity indicator** (are we even on a LAN with a gateway?) and a **"Proceed
   with Auto Connection"** button.
3. Pressing it makes the Office Panel broadcast a small UDP `DISCOVER` packet
   (its hostname + a randomly generated pairing nonce) on the local subnet.
4. Any Master listening responds directly (unicast, not broadcast) with a `HELLO`
   packet containing its LAN IP, port, master unique ID, and a short-lived pairing
   token.
5. Office Panel receives it, shows the discovered Master's name for confirmation,
   then completes a TCP/WebSocket handshake to register itself. Master issues the
   Office Panel a **permanent panel ID + secret** (stored locally on that Office PC)
   so future launches reconnect silently without re-pairing.
6. Master's "Add Office Panel" screen updates live the moment pairing completes,
   showing the new panel's name, IP, and connection status.
7. If multiple Masters answer (shouldn't normally happen — one Master per network
   is the assumed topology) the Office Panel lists all responders and asks the user
   to pick one.

### 4.2 Manual Connection

- Master's first-run screen (see §5.1) always displays its own **IP, port, unique
  master ID, and pairing password**, regardless of whether auto-pairing is used.
- On Office Panel, "Manual Connection" lets the user type the Master's IP, port, ID,
  and password directly and connect — used when UDP broadcast is blocked (VLANs,
  isolated WiFi client mode, restrictive firewalls).
- Both modes converge on the same result: a stored `{masterUrl, panelId, secret}`
  on the Office Panel and a corresponding row in Master's `office_panels` table.

### 4.3 Connectivity Indicator

Office Panel's first screen continuously checks:
- **Local link state** — is there an active LAN/WiFi interface with a gateway?
  (green/red dot)
- **Master reachability** — once paired, a persistent Socket.IO connection status
  (connected / reconnecting / offline) shown on every Office Panel screen, since
  Master being down blocks all writes.

## 5. Master Panel — Screens & Flows

### 5.1 First Run — Setup / Identity Screen

Shown once, the very first time the Master server starts with an empty database.
Generates and displays (and persists to SQLite):
- Master unique ID (UUID)
- LAN IP address(es) detected on the machine
- Port the server is listening on
- A generated sign-in password (shown once, must be saved/changed by the operator)
- QR-code or plain-text summary block of the above, so it's easy to hand-copy to an
  Office Panel doing a manual connection

After this screen is acknowledged, Master never shows it again (goes straight to
sign-in) — but the same info is always reachable later from Settings.

### 5.2 Sign In

Simple ID + password form, checked against the Master's local credentials. Session
cookie grants access to the rest of the Master Panel. No "forgot password" flow for
v1 (single admin, single machine, physically local) — a documented recovery path
(regenerate from server console) is enough.

### 5.3 Dashboard / Home

Landing page after sign-in. v1 scope: summary counts (leads, orders, products,
parties) and connected Office Panels' live status.

### 5.4 Office Panels Management

- **Connected Office Panels** — list of paired panels: name, IP, last-seen,
  live connected/offline indicator.
- **Add Office Panel** — the pairing screen described in §4.1, plus the manual
  connection details from §5.1 for reference.
- **Storage** — disk usage on the Master PC attributable to this app (database size
  + uploaded images), so the operator can see when they're running low.

## 6. Office Panel — Screens & Flows

### 6.1 First Screen — Connection

Described in §4. This is the entry point every time the Office Panel app starts
without an already-known, reachable Master.

### 6.2 Home

Once connected, shows quick actions — primarily the **Add Lead** button — and a
list/table of existing leads and orders (scoped to what's useful day-to-day for
office staff).

### 6.3 Add Lead

Opens a form/tab to:
- Search or select an existing **Product** (by code, name, or type), or add a new
  product on the fly if it doesn't exist yet.
- Search or select an existing **Party** (customer), or add a new one on the fly.
- Capture lead-specific details (quantity, notes, requested specs/parameters).
- Save as a **Lead**.

### 6.4 Lead → Order

Once a lead is verified/finalized by staff, it can be moved from the Leads list to
the Orders list (status transition, not a data copy — same record, new state).

### 6.5 Party & Product Management

Dedicated screens (reachable from Office Panel, data lives on Master) to view/add/
edit:
- **Parties** (customers): name, contact details, address, etc.
- **Products**: product code, name, type, and other ceramic-specific parameters
  (size, finish, series, etc. — exact field list to confirm with the user before
  building the product form, since ceramic product attributes are domain-specific).

## 7. Data Model (v1)

| Entity | Key fields |
|---|---|
| `master_config` | id, master_unique_id, lan_ip, port, password_hash, created_at |
| `office_panels` | id, name, secret_hash, lan_ip, last_seen_at, paired_at, status |
| `users` (Master sign-in) | id, username, password_hash |
| `parties` | id, name, phone, address, gst/tax id (if applicable), notes, created_by, created_at |
| `products` | id, code, name, type, parameters (JSON: size/finish/series/etc.), image_path, created_at |
| `leads` | id, party_id, product_id, quantity, parameters/notes, status (`lead`/`order`), created_by_panel_id, created_at, updated_at |
| `activity_log` | id, entity_type, entity_id, action, actor, at — for audit/live-feed purposes |

`leads` doubles as `orders`: a status field (`lead` → `verified` → `order`) avoids
duplicating the record when it's finalized, per the user's description ("move that
lead to order tab").

## 8. Real-Time Sync Contract (Socket.IO events, illustrative)

- `panel:register` / `panel:registered` — pairing handshake
- `panel:status` — Master broadcasts connected-panel list changes to all Master
  Panel dashboards
- `data:lead:create` / `data:lead:update` / `data:lead:promote` — Office → Master
  commands
- `data:changed` `{entity, id, payload}` — Master → all Office Panels + Master
  dashboard, broadcast after any successful write, so every open screen updates
  live without polling
- `sync:snapshot` — sent to an Office Panel on (re)connect so its cache is
  refreshed in one shot before incremental `data:changed` events resume

## 9. Security Notes (LAN-appropriate, not enterprise-grade)

- Passwords hashed at rest (e.g. bcrypt) even though the DB never leaves the LAN.
- Office Panel pairing secrets are per-panel, revocable from Master (remove a panel
  → its secret stops being accepted).
- No HTTPS requirement for v1 (closed LAN, no internet path to sniff from), but
  keep the transport layer abstracted enough to add TLS later if the user wants it
  for a multi-room/multi-floor deployment.

## 10. Proposed Repo Structure

```
/master        Master Panel server + its React frontend
/office        Office Panel server + its React frontend
/shared        Shared types, Socket.IO event contracts, the UDP discovery protocol
/docs          This plan + any future design notes
```

## 11. Phased Build Plan

**Phase 1 (this pass — "working condition", not polished):**
1. Repo scaffolding: `/master`, `/office`, `/shared` packages, dev scripts.
2. Master: first-run identity screen, sign-in, SQLite schema + migrations.
3. Discovery protocol (UDP) + auto/manual pairing, both directions.
4. Master dashboard: connected Office Panels list, Add Office Panel flow, basic
   storage stat.
5. Office Panel: connection screen (indicator + auto/manual), Home screen.
6. Party + Product CRUD (minimal fields, confirm ceramic-specific attributes).
7. Add Lead flow, Lead list, Lead → Order promotion.
8. Live sync verified end-to-end between two PCs (or two processes on one dev
   machine bound to different ports, simulating two PCs) on a LAN.

**Phase 2 (later, explicitly deferred by the user):**
- Visual polish / branding pass.
- Richer product parameter schema, bulk import.
- Reporting/analytics, inventory stock levels tied to orders.
- Multi-user roles/permissions within Office Panel.
- Backup/restore tooling for the Master's SQLite + uploads.

## 12. Open Questions (confirm before/while building the relevant part)

- Exact product attribute set for ceramics (size, finish/glaze, series, box
  quantity, price tiers, etc.) — placeholder JSON `parameters` field until defined.
- Party fields needed for this business (GST/tax ID, credit terms, multiple
  contacts?).
- Whether more than one Office Panel can edit the same lead concurrently, and how
  conflicts should be resolved (last-write-wins is the default assumption).
- Desired app name/branding (currently just "OrderBook" per the repo name).
