# OrderBook

Offline, LAN-only order & inventory management for a ceramic company. Runs
entirely on the shop's own network with no internet access at any point.

Two programs work together:

- **Master Panel** — runs on one PC connected to the router. Owns the database
  and all files. Every write goes through it.
- **Office Panel** — runs on other PCs on the same WiFi/LAN. Staff create leads,
  manage parties and products, and move finalised leads to orders. It keeps no
  database of its own; everything is live from the Master.

Both are web apps: each PC runs a small local server and staff open a browser.

## Documentation

| Document | What it covers |
|---|---|
| [`HANDOFF.md`](HANDOFF.md) | Session context and the decisions already made — read first |
| [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md) | Requirements, architecture, screen flows, phased plan |
| [`docs/schema/`](docs/schema/00-overview.md) | Database schema, table by table, with rationale |

## Repository layout

Documentation and code are kept strictly separate.

```
docs/       all documentation
shared/     types, Socket.IO event contract, UDP discovery protocol
master/     Master Panel — server (src/) + React frontend (web/)
office/     Office Panel — server (src/) + React frontend (web/)
```

## Running it

Node.js 20+ is the only prerequisite. PostgreSQL ships with the app — `npm
install` pulls the server binaries for your platform, and the Master starts and
stops its own private instance on loopback. Nothing to install or configure.

```bash
npm install
npm run build          # builds shared, then both servers and both frontends

npm run start:master   # on the Master PC  → http://localhost:4100
npm run start:office   # on each Office PC → http://localhost:4200
```

For development, `npm run dev:master` and `npm run dev:office` run the servers
with reload. If you are editing `shared/`, run `npm run dev:shared` alongside
them so its output recompiles as you go. The frontends have their own Vite dev
servers (`npm run dev --workspace @orderbook/master-web`) that proxy to them.

Notes:

- **Do not run the Master as root/Administrator** — PostgreSQL refuses to start
  that way. Use a normal user account.
- **`shared/` must be compiled** before anything can import it. The `prepare`
  and `pre*` scripts handle this automatically; `npm run build:shared` does it
  by hand if you ever need to.
- **To use an existing PostgreSQL server** instead of the bundled one, set
  `DATABASE_URL`. To point at a different set of binaries, set
  `ORDERBOOK_PG_BIN` to a directory containing `initdb` and `pg_ctl`.
- **Upgrading across a PostgreSQL major version** (e.g. bundled 17 → 18) cannot
  reuse an existing data directory. The Master detects this and stops with an
  explanation rather than touching your data; migrate with `pg_upgrade` or a
  dump/restore, or pin the old version via `ORDERBOOK_PG_BIN`.

## First run

1. Start the Master Panel and open it in a browser. It generates this PC's
   connection details and an admin ID/password, shown **once** — write them down.
2. Sign in to the Master, open **Office Panels → Add Office Panel**. It waits for
   a panel.
3. Start the Office Panel on the other PC, open it in a browser, and press
   **Proceed with Auto Connection**. The two find each other over the LAN with no
   IP addresses to type.

If automatic connection is blocked on your network, the Office Panel's **Manual
Connection** tab accepts the address and pairing password from step 1.
