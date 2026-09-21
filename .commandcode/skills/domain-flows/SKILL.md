---
name: domain-flows
description: OrderBook domain map — where entities, the Master/Office contract, and the schema live. Use when touching leads, orders, parties, products, inventory, sync, or pairing.
---

# Domain flows

## Where things live

- Entities and validation: `shared/src/domain/` (`entities.ts` is the core
  model; `inputs.ts`, `permissions.ts`, `settings.ts` beside it).
- Master/Office contract: `shared/src/protocol/socket.ts` (Socket.IO events),
  `discovery.ts` + `pairing.ts` (LAN pairing).
- Schema truth: `docs/schema/` (start at `00-overview.md`); screen flows and
  requirements: `docs/PROJECT_PLAN.md`; backend module notes:
  `docs/backend-modules/`.

## The flows that must not be re-designed per task

- **Single-writer**: the Master owns every write and all persistent state.
  Office panels queue and forward over Socket.IO; they never persist
  authority. Office-side code that writes its own database is a regression.
- **Leads → orders**: Office staff create leads and manage parties/products;
  leads are promoted to orders through the Master. Keep the lead's identity
  through promotion — do not re-enter it as a new order.
- **Settings and secrets**: app settings live in the settings table and
  connector secrets in the password vault (Stage 4). No new `.env` keys for
  per-installation state; `.env` stays optional (see `.env.example`).

## Migrations are permanent

Never delete or rewrite a migration under `master/src/db/migrations/` —
`master/tests/migration-registry.test.ts` pins the registry. Add a new
migration instead of editing one that may have run anywhere.
