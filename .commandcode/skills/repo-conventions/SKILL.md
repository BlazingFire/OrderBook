---
name: repo-conventions
description: OrderBook project conventions — read before writing code. Use when starting work, choosing where a file belongs, deciding whether something may be edited or deleted, or asked about this repo's rules.
---

# Repo conventions

OrderBook's non-negotiable rules. When in doubt, follow these over general
best practice.

## Offline-only at runtime

Nothing loads from a CDN or calls the internet at runtime. Bundled fonts and
assets only; `.env` is optional (see `.env.example`). Any change that would
make the shipped apps reach the network at runtime is a regression.

## Single-writer architecture

The **Master** owns every write and all persistent state. Office panels are
thin clients: they forward writes over Socket.IO and never write their own
database. Respect this split — office-side code may queue and forward, never
persist authority.

## Doc/code separation

Prose lives in `docs/`; source lives in the workspaces. Do not bury a
source-of-truth design decision in a code comment. Source of truth pointers
are in `AGENTS.md` (this file is loaded as memory) and `HANDOFF.md`.

## Migrations are permanent

Never delete or rewrite a migration that may have run anywhere
(`master/src/db/migrations/`, pinned by `migration-registry.test.ts`). Add a
new migration instead of editing an old one.

## Monorepo layout

- `shared/` — types, Socket.IO contract, UDP discovery, sync primitives.
- `ui/` — shared React kit consumed as source by both panels.
- `master/` + `master/web/` — Master server and React frontend.
- `office/` + `office/web/` — Office server and React frontend.
- `electron/` — desktop shell (one shell, two entrypoints).
- `tools/` — release/build/icon/i18n scripts.

## Don't edit vendored or local tooling

- Third-party skills are installed globally per machine, not vendored in the repo.
  `.agents/skills/ui-consistency/` is the one project-authored skill there.
- `.commandcode/skills/` is **team-shared and tracked** — edit freely, but treat
  changes as conventions that need review like any other.
- The rest of `.commandcode/` (taste, settings) is **local-only** and gitignored.

## UI conventions

Breakpoints in physical px, never rem. Hairlines/radii stay px. Lengths against
text use rem. Scale (font size) and density are orthogonal settings. Text shown
to users goes through the i18n catalogue (`shared/src/i18n/en.ts`) — a bare
string in JSX is a defect the `orderbook-i18n` rule exists to catch.
