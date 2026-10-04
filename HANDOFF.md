# HANDOFF — Session Context

Read this first in any new session on this repo. It records what is decided
and what is true *now*. Keep it current, not cumulative: when a session
changes reality, edit the section that describes it and add a short dated
entry under "Session history". The long-form history is in git — the last
cumulative version of this file is `git show 5b8ebe2:HANDOFF.md` — and in the
change log of `docs/AI_COLLABORATION.md`.

## What this project is

**OrderBook** — an offline, LAN-only order and inventory management app for a
ceramic company. No internet at runtime, ever. Two cooperating web apps, each
also shipped in an Electron shell:

- **Master Panel** — one PC, owns the PostgreSQL database and all files. Every
  write goes through it.
- **Office Panel** — other PCs on the same LAN, thin clients used by staff to
  create leads, manage parties/products and promote leads to orders. No
  database of its own; keeps a snapshot cache and an outbox for offline work.

It is order management, not billing: since 2026-09-21 the software carries
**no money at all** — no rates, amounts or totals anywhere. The AI assistant
was removed on 2026-09-11 and the PDF Designer (Documents module) on
2026-09-19; the Reports PDF export stays.

### Where the truth lives

| Question | Read |
|---|---|
| Requirements, pairing design, screen flows | `docs/PROJECT_PLAN.md` |
| The whole software and its code: every file, schema, flows, tests, where a change goes | `docs/STRUCTURE.md` |
| Every table, column, index and why | `docs/schema/` (start at `00-overview.md`) |
| Lead → order flow as built | `docs/LEAD_GENERATION_FLOW.md` |
| Roles, users, permissions, tiers | `docs/ROLES_AND_USERS.md` |
| Developer password, reset, test users | `docs/DEVELOPER_MODE.md` |
| Shipping an update, release ordering rule | `docs/UPDATES.md` |
| Shipping to customers under the "never lose data" rule | `docs/PRODUCTION_READINESS.md` |
| Manual QA script | `docs/TESTING_PLAN.md` |
| What to do next | `docs/NEXT_PHASE.md` |
| Open work items (the queue) | `docs/ai-handoffs/README.md` |
| The product master: category → model → variant; pricing removed | Key decisions 12, 14, 15 below; `docs/schema/02-parties-and-products.md` |
| Catalogue v2: Brand → Product → Sub product, colour rules, lead entry, lead PDF | `docs/catalogue/CATALOGUE_MODEL.md` (the spec); the data is `master/assets/catalogue/swisware-plus-2026.md` |
| Fields, Logs, Recycle Bin, Reports, i18n design | `docs/BACKEND_MODULES.md` + `docs/backend-modules/` |
| The 2026-08/09 overhaul designs (implemented; Workstream I, the AI section, removed) | `docs/overhaul/` |
| Multi-agent workflow and per-session change log | `docs/AI_COLLABORATION.md` |

`docs/backend-modules/` is cited from source and test comments as design
rationale (gate ids such as `DSH-3`); of `docs/overhaul/`, only `README.md` and
`workstream-F.md` are cited from source — the rest is history. They were
written before the code and several of their stated facts did not survive
contact with the tree — check a design's claim against the code before acting
on it.

## Add-connection audit, Setup-only builds + 1.4.1 (2026-10-04)

**State: released.** `main` @ `2a7649a` is the 1.4.1 version bump and is pushed. GitHub
release **v1.4.1** is Latest on `BlazingFire/OrderBook-Releases` and holds only the three
Setup files and the five `latest-*.json` manifests. Protocol is **9**. The release notes are
`docs/releases/1.4.1.md`; the API changes are in `docs/backend-modules/04-API-CONTRACT.md` §18;
the flow is in `docs/STRUCTURE.md` §8.7 and §11.1.

**Gate on the merged tree (`7fc7deb`, then only the version bump):** lint 0, build 0,
typecheck 0, test 0 (307 files passed + 1 skipped; 4,335 tests passed + 17 skipped),
`smoke:legacy` 0.

Plan and evidence: `CLAUDE_HELPER_CONN.md` (requirements C1–C7, the §2 audit list, every CH1
verdict) and the `## Connection (2026-10-04)` sections of `CLAUDE_HELPER_D1.md` … `D5.md`.
These are untracked coordination files in the main checkout.

- Second language removed (2026-10-04, owner's decision): the UI is English-only; the other locale, its language picker and its fonts are gone.

| Session | Work |
|---|---|
| D1 | Office side |
| D2 | Master side |
| D3 | Setup-only builds, then the Win7 build |
| D4 | Live baseline of 1.4.0, then an independent audit and live re-test of every D commit, then the release check |
| D5 | Merges and the final two-process pass (22 paths) |
| CH1 | Plan, verdicts, the release |

### What the owner asked, and where it landed

| ID | Owner said | Result |
|---|---|---|
| C1–C3 | Make sure the Office and Master "add connection" works perfectly; audit it and improve it | D4's live baseline found 6 problems (B1–B6). D1 and D2 found about 30 more by reading the code. All are fixed with tests that fail without the fix. D5's live pass: 22 of 22 paths after F1–F5 were fixed. |
| C4, C7 | Push a new build, 1.4.1 | `2a7649a`, signed Setups (Master, Office, Win7 Office), release v1.4.1 published. D4 verified it from GitHub: signatures, SHA-256 and sizes for all 8 assets; a 1.4.0 Master fetched both Setups by itself and notified everyone; a 1.4.0 Office was offered 1.4.1 and downloaded it. |
| C5 | Delete the GitHub release page details, keep only the setups | v1.3.0 and v1.4.0: release bodies emptied; every Standalone `.exe` and `.sha256` deleted. The manifests stay, because auto-update reads them. GitHub always shows two "Source code" archives; they cannot be removed, and here they hold only the releases repo's README. |
| C6 | No Standalone builds from now on | D3 `92c5a90`, `dfd0f19`: no `portable` target and no `.deb` in any electron-builder yml; `tools/release.mjs` has no besides, `publishBeside()` or `--fast`; the workflow uploads Setups and manifests only. `packaging-invariants` fails if any of them comes back. `electron/lib/standalone.ts` is kept on purpose, so a 1.4.0 Standalone still in use is told to install the Setup. |

### What changed in the flow

**Master (D2):**
- **Discovery:**
  - a UDP bind failure no longer stops boot (it retries every 30 s, and the screen says why automatic search is off);
  - the reply carries the address on the asker's subnet, with physical adapters ranked above virtual, VPN and link-local ones.
- **The Add Office Panel card:**
  - a countdown from the server's `closesAt`, and a "window closed" state;
  - an "automatic joining is off" notice shown before the card is pressed;
  - the Master's addresses and port, for manual pairing;
  - the wait ends when `GET /pairing-window` says the window is closed, not when the row count grows, so a revived row ends it too.
- **Rows:**
  - unique panel names;
  - re-pairing revives the PC's own row in a strict order (§18.1 of the API contract);
  - a revived row keeps its name;
  - a "Show removed" toggle;
  - the "N offline" count covers active panels only;
  - "No active office panels" when only removed rows are left;
  - "Reissue secret" for a connected panel.
- **Pairing and logging:**
  - `rate_limited` 429 with `retryAfterSeconds`;
  - the logger redacts credential-named properties.
- **Socket:** `panel:leave` (protocol 9).
- **Installer:** the firewall rules are deleted and then re-added, `profile=any`, so updates do not pile up duplicates.

**Office (D1):**
- **Messages:** every refusal is coded and translated, with a next step and the Master's name.
- **Searching:** it shows progress, can be cancelled, and pairs to the address the reply came from.
- **Manual mode:**
  - the address and port are validated first;
  - **Test connection** (`/api/health`);
  - the last address is remembered;
  - a first-sync progress screen.
- **Removed by the Master:** "This PC was removed by the Master Panel" appears at once, with no reload, and survives restarts.
- **Unpairing:**
  - unpair sends `panel:leave`;
  - `unpairAllowed()` limits unpairing without sign-in, and discarding unsent work always needs `panels.manage`;
  - re-pairing to a different Master starts from a clean cache.
- **The previous id and secret:** both are kept in `master-binding.json` until the next pairing. They are sent only to the Master whose id was stored, and the secret only after `/api/panel/prove`; D4 proved this with a throwaway listener.
- **A non-Master reply:** any reply without a `messageKey` is "not a Master Panel".

### Decisions taken (the owner can overrule)

- **Pairing-password reset** stays behind the Server Master + master key, as the 1.3 owner rule says. The pairing password cannot be viewed (it is stored hashed); the Add card and the Office hint say where to reset it.
- **"Reissue secret"** is a button for connected panels only, behind a confirmation.
- **Re-pairing** revives only a removed row, or an active row whose secret the PC proves. A hostname alone grants nothing.
- **`GET /api/panels/pairing-window`** needs `panels.manage`. There is no `panels.view` key.

### Traps found in this batch

- **A helper session detached HEAD in the main checkout** (`git checkout <hash>` during an audit). The 1.4.1 bump was committed to the detached HEAD, and `git push origin main` pushed the stale `main`. CH1 caught it and fixed it: `main` was moved to `2a7649a` and pushed again. Rules now:
  - helpers check out only inside their own worktree;
  - before a release commit, check `git symbolic-ref --short HEAD`;
  - after every push, compare `origin/main` with the commit you expected.
- **One PC cannot host two Masters.** Only one process can hold UDP 45789, so sessions took turns on the port through CH1.
- **On Windows the Office ignores `PORT`;** use `OFFICE_PORT`. In PowerShell, setting an environment variable to `''` deletes it. Scratch servers therefore also need `ORDERBOOK_RELEASES_POLL_MINUTES=0` and a scratch `ORDERBOOK_RELEASES_DIR`.
- **`master-binding.json`'s 0600 mode means nothing on Windows;** the NTFS ACL of the data folder applies.

### Owed

- **Real-PC checks:**
  - installing a Setup over an existing install;
  - the 5-minute window running out;
  - two Masters on one LAN;
  - the Master's IP changing;
  - Rename;
  - the installer actually creating the firewall rules;
  - a Win7 Office;
  - the real Electron shell.
- **Owner:** delete the 14 old `claude/*` branches and `dev` on GitHub. The permission check blocks the agent from doing it. The command is:
  `git push origin --delete dev $(git branch -r | grep "origin/claude/" | sed 's#origin/##')`

## Party Access redesign + 1.4.0 (2026-10-04)

**State: released as 1.4.0** (`main` @ `543f965`, GitHub release v1.4.0, its page cleaned to Setups only in 1.4.1). The paragraphs below were written before the merge and keep that wording. CH1 merged the two docs branches (D2's STRUCTURE and API contract, D3's HANDOFF/NEXT_PHASE/AI_COLLABORATION/release notes), bumped the version from 1.3.0 to **1.4.0**, and built. Protocol is now **8** (`PANEL_PROTOCOL_VERSION`; 7 came from R16/R22 in the batch above, 8 adds the Party Access summary socket command `partyAccess:summary`).

Last full gate, each step separate, on `59a71c4`: lint 0, build 0, typecheck 0, test 0 (294 files passed + 1 skipped, 4,171 tests passed + 17 skipped), `smoke:legacy` 0. The branch head `96d0b7f` adds one more D2 merge (`480d270`, the discard question wraps and the footer reserves its height); that commit had its own tests run by D2 but **no recorded full gate**. CH1 gates the version bump anyway.

Plan and evidence: `CLAUDE_HELPER_PA.md` (plan, requirement IDs, interface contract, CH1 messages) and the logs `CLAUDE_HELPER_D1.md`, `D2.md`, `D3.md`, `D4.md`, `D5.md` (untracked coordination files in the main checkout). Who did what: D1 the Party Access list screen, D2 the editor and the backend, D3 two independent audits (no code), D4 shared-kit and shell fixes, D5 the merges and the browser acceptance (A2), CH1 plan, verdicts and the release.

### What landed, per row

IDs are from `CLAUDE_HELPER_PA.md` section 2. PA1-PA17 are the brief-level rows; D1.x is the list screen, D2.x the editor and the backend, A1-A3 the acceptance.

| Row | What | Commits (on `d5/1.4`) |
|---|---|---|
| PA1 PA2 | The Party Access module is a **list of every party with its access state** (Open to everyone / Restricted to N people) and who holds it, with a summary strip (total, open, restricted) that filters the list when clicked; the old "pick a party, then edit" flow is gone | D1 `f4ccdf7`, `51047ad`, `66d2cbb`, `b8482b7` |
| PA3 PA4 | Search by party name, code, city **and assignee name** (debounced 250 ms, Esc clears), a person filter, server-side sort by party, code, city, access (`sort` and `dir` params, kept per machine), 48 px rows, a skeleton of the same shape while loading, the Assigned-to cell showing full names with level and "+N more" | D1 `f4ccdf7`, `3d5262d`; Assigned-to names `6372234` (also on `main`) |
| PA5 | **One editor, `PartyAccessEditor.tsx`, byte-identical in `master/web` and `office/web`** (a parity test compares the two files); the list screen imports it with a `canEdit` prop | D2 `7e53bb6`, final `5110579` |
| PA6 | No new dependency (no `package.json` changed) and no money wording anywhere | D1, D2 evidence in their logs |
| PA7 | Fits 1024x768 at 100 % and 157 % scale on both panels with no horizontal scroll: columns drop in order (city, then edit) and names end in an ellipsis with the whole text as the `title`; 6 full rows show at 157 % | D1 `66d2cbb`; D4 topbar at 157 % `2383e74` |
| PA8 | The editor reuses the kit: `Combobox`, `Segmented`, `Modal`, `StatusPill`, `Avatar`, `EmptyState`, `ConflictBanner`. The one new kit component is `MultiPicker` | D2 `5110579` |
| PA9 | Kit defects found while building were fixed once in `ui/`, with tests, not patched in the screen: `Combobox` (keyboard, `aria-activedescendant`, Home/End/Page keys, Esc claimed only while open), `comboboxPlacement` (the list flips above when there is no room), `MultiPicker`, `Segmented` accessible name, `Avatar` initials, `DataTable` sticky header and `aria-selected` rows, the permission grid scrolls, flat record tables scroll sideways | D2 `5110579`; D1 `840ea61`; D4 `754bfe9`, `c92a0f7` |
| PA10 PA11 | English for every new string; unused keys removed (`partyAccess.addPerson`, `partyAccess.editor.done`, `partyAccess.summary`, `partyAccess.showing`) | D1, D2, D5 merges, D2 `92aa49b` |
| PA12 | The gate above | D5 |
| PA13 | Every guard test was seen to fail once when the code was broken (D1, D2 each; D3 re-did D2's list independently, see below) | logs |
| D1.2-D1.7 | Search, strip, person filter, sort, sticky header, ellipsis, loading shape, arrow-key walking through the virtual window (a held key no longer drops the focus to the page body), the busy cue while refetching, no button nested in a button | D1 `f4ccdf7` ... `f076d5c` |
| D2.1-D2.6 | The editor: header with name, code, city and a state pill that follows the draft; add by type-to-filter with keyboard; **Add several** (pick many, choose the level once); **Copy access from another party** (existing levels are kept, inactive people left out); a discard question inside the same dialog; a conflict banner with Reload (`expectedVersion`); Save disabled until something changed; "Inactive user" rows shown muted with Remove; the "everyone can see this party" warning; a read-only view for a reader who has `party.accessAll` but not `party.assign`; the dark and long-name audit | D2 `7e53bb6`, `5110579`, `92aa49b`, `f9aec2e`, `43d1c87`, `480d270` |
| Backend | `GET /api/party-access/summary` (socket `partyAccess:summary`, protocol 8) with counts, `sort`/`dir`, assignee search with the LIKE wildcards escaped; `/people` is readable by `party.assign` **or** `party.accessAll`; a new grant must be a live account, a deleted user is never counted active | D2 `7e53bb6`; contract in `docs/backend-modules/04-API-CONTRACT.md` (D2) |
| A1 | Independent audit of D2's editor at `5110579`: no blocker, 3 low defects (focus after the last Remove opened the add list; the modal jumped about 11 px when the discard question appeared; two unused i18n keys), 4 guard gaps. D2 fixed all three defects and added guards | D3 audit; fixes `92aa49b`, `43d1c87`, `480d270` |
| A2 | Browser acceptance on both panels in English, light and dark at 1024x768 and 1920x1080; it found the discard sentence cut off in English (603 px of text in a 557 px box) | D5; fixed by D2 `480d270` |
| A3 | Final verdicts: D2 accepted at `f9aec2e` (then the follow-ups), D1 at `f076d5c`, D4 kit `d26a8b9` and topbar `2383e74` | CH1 |
| D4 | The Office "Update needed" screen text no longer says "Nothing is wrong" while the app is blocked | D4 `d26a8b9` |

### Decisions taken (do not re-decide without a reason)

- **Opening a row never changes who holds it.** The editor only writes when Save is pressed; Cancel, X and Esc ask first if there are unsaved changes, in the same dialog, and the question is registered with "Save all and update" like every other form.
- **A person who was deactivated keeps their grant and is shown, marked "Inactive user".** Remove drops it; saving the others never drops it silently (guard tests for both).
- **Copy access keeps what a person already has** and never copies an inactive account.
- **The reader view is part of the editor.** A role with `party.accessAll` and no `party.assign` sees the list, can filter by person and open a row read-only (levels as pills, Close only). `/people` allows both permissions for that reason.
- **The shared editor stays one file in two panels** (a copy kept identical by a test), because the two web apps do not import each other; do not let the copies drift.
- **The kit fix to `.ob-tablewrap` stays** (see the trap below): every `DataTable` header now sticks to the top of its pane.

### Traps found

- **PowerShell turns an empty environment value into a deleted variable.** `$env:ORDERBOOK_RELEASES_GITHUB_REPO = ''` removes the variable, so the server falls back to its built-in default, the real `BlazingFire/OrderBook-Releases`. D4 and D5 both ran a scratch Master that way. To keep a scratch server away from the network and from disk, set `ORDERBOOK_RELEASES_POLL_MINUTES=0` **and** point `ORDERBOOK_RELEASES_DIR` at a scratch folder inside your worktree.
- **A scratch Master wrote to the real `C:\OrderBook-Releases`.** D1's first browser pass ran with the default releases settings: it cleared 8 old Master installers, fetched the 1.3.0 Setup and left a `.part` file. CH1 removed the `.part` and accepted the rest. Never start a preview server without `ORDERBOOK_RELEASES_DIR` set.
- **`.ob-tablewrap { overflow: hidden }` made the wrapper the sticky containing block, so no `DataTable` header ever stuck.** Measured by D1: header top -20 px after scrolling 264 px. The fix is `overflow: hidden; overflow: clip;` in `ui/src/base.css` (a guard test fails with `hidden` alone). Because it is a kit change it affects every table; look for a table that relied on the wrapper scrolling.
- **Cells inherit the table's `white-space: nowrap`**, so a "clamp to two lines" needs `white-space: normal` as well. And a column given a `fr` share is assumed to need 120 px by `fitColumns`, which left a name 3 letters wide: give columns rem widths.
- **A held arrow key repeats faster than a virtual table moves its window.** Focus a row that may not exist yet and it unmounts and the focus falls to `<body>`. Keep the focus on the table's edge row nearest the target and move the target one row at a time (`PartyAccessScreen.tsx`, with a test that fails if the active element is ever `<body>`).
- **Removing a row with no other Remove button focuses the add field, and that opens its list.** Hand the focus back quietly (the `quietFocus` flag) the way closing the panel does.
- **A footer that changes height moves the modal.** The discard question replaced a one-row footer with a two-row one; the footer now reserves its height and the sentence wraps.
- **Browser pane screenshots arrive one frame late and stale after the page-zoom trick.** Read geometry from the DOM (`getBoundingClientRect`, `scrollWidth`) for anything that matters.
- **Role permissions are cached by the Master.** A permission edited straight in the scratch database is seen only after a Master restart.
- **The Office reads `OFFICE_PORT`, not `PORT`.** Older traps still apply: build before typecheck after a `shared/` change, CRLF in source-reading tests, two panels on one host share cookies (use `localhost` and `127.0.0.1`), stop only your own PIDs, one `TEMP` and PG port per session.
- **Load-sensitive tests:** `master/tests/update-check.test.ts` "answers within the wait while a slow download carries on" failed once under load and passed on the next run; same for `ui/tests/chatroom.test.tsx`.

### Not verified (carried forward)

No real Electron window, no real held key, no real printer and no Windows 7. Not captured: the Office reader in a browser on the final editor, Add several and Copy in dark at 1920x1080, a 1920x1080 capture of the admin list and editor, a 200-row list scrolled for real (jsdom only).

### Owed by the owner

1. **Install 1.4.0.** Order: install the **Master by hand over the existing one** (no uninstall, data stays), then each Office the same way. After that the Master fetches updates from the releases repository and the Offices update from it. Full wording in `docs/releases/1.4.0.md`.
2. **The real-PC checklist** from the "1.4 batch" section above (the ten items from D1, the Printroom station claim and a real printer, the Win7 VMs, the Master UI pass) is **still owed**; 1.4.0 is the first release that can be tried that way.
3. **A real-PC look at Party Access:** open a party with 20 or more people, use the keyboard only (Tab, arrows, Enter, Esc) through add, Add several, Copy and the discard question, and confirm that the list header sticks while scrolling on a real display at 125 % and 150 %.
4. **The 11 pm Master auto-update** has never run for real: leave the Master PC on overnight once with a newer signed release published and check `result.json` and that the Offices reconnect.
5. **Branches and push.** `main` is not pushed. After the 1.4.0 release CH1 and the owner decide which local branches and worktrees (`d1/party-access`, `d2/party-access`, `d3/pa-docs`, `d4/party-access-kit`, `d5/1.4` and the older ones) are retired.
6. **The master key is not in the repository** (unchanged).

### Next session

`docs/NEXT_PHASE.md` "First: 1.4.0 is built; what comes next".

## 1.4 batch (2026-10-03) — what landed, what was decided, what is owed

**State: all of it is on `main` @ `4caa3a4` (fast-forward, not pushed).** Final gate on
that commit, each step separate: lint 0, build 0, typecheck 0, test 0 (282 files passed
+ 1 skipped, 3,950 tests passed + 17 skipped; the skips are `release-workflow` and the
POSIX half of `appimage`), `smoke:legacy` 0. **The version is still 1.2.5 everywhere**
(see "Owed by the owner"). The batch also closed the 1.3 batch: see the next section.

The owner's sentence-by-sentence requirements are numbered **R0–R22** in
`CLAUDE_HELPER_D.md` §3 (a coordination file in the main checkout, untracked, in
`.git/info/exclude`; its §6 holds every review verdict, and the five logs
`CLAUDE_HELPER_D1.md` … `D5.md` hold each session's evidence, screenshots and "not
verified" lists). Protocol is now **7** (`PANEL_PROTOCOL_VERSION`).

### What landed, per requirement

| R | What | Where it came from | On `main` as |
|---|---|---|---|
| R0 | `main` holds the whole 1.3 batch: the helper's H1–H5 (party import, reports, notes/Save PDF, **Chatroom**, **Printroom**) and Phases 0–8 | `helper/1.3` @ `a1f687a`, then @ `0e41407` | `68055a8`, `6350134` |
| R1 | A password eye on every password field (`PasswordInput`, guard scan for raw inputs) | D4 `2335a15` | `498d118` |
| R2 | No menubar on Windows and Linux (a minimal one on macOS); every old item has a new home (`electron/lib/app-menu.ts`, `docs/UPDATES.md` "1.4") | D1 `d1e71c8` | `f675760` |
| R3 R4 R5 | **Lists** module (Alt+G, both panels): grades, packaging, brands, on the shared option-list editor. One key `catalog.lists.manage` (management-tier ceiling) writes the three lists; **everyone signed in reads them**. Migration `20261012000000_catalog_lists_grant` | D3 `e8a8e48`, `670dff5`, `2d3b5df`, `d6f16b4` | `de630c4` |
| R6 | "Check now" on both App update screens; poll every 2 minutes; an `update.available` notification to every active account, once per version | D1 | `f675760` |
| R7 | Download progress (bytes, speed, time left); **Save all** on every form before the update; sign out, install, relaunch; the **same-version gate in both directions** (an Office behind its Master offers the update, one ahead waits and re-checks every 10 s; Standalone is left alone) | D1 | `f675760` |
| R8 | Nightly update of the Master (default 23:00, a window that wraps past midnight), installed by a **highest-privilege scheduled task** ("option B", below), the server back without anybody signing in | D1 `48b681e`, `86881c3`, `04efd50` and hardening commits | `f675760` |
| R9 | Chatroom and Printroom visible for Office and Management: migration `20261013000000_printroom_office_management_grant` (`print.send`); a role change reaches a connected Office (`session:refresh`); Basic Home tiles | D4 `455a614`, `6702ba7` | `498d118` |
| R10 R11 | Filling and Dispatch note buttons in the list rows and board cards of Pending and Final orders on both panels, gated on **view** (not export); a Preview modal (xl) with Print and Save PDF | D4 | `498d118` |
| R12 R13 R18 | Sign-out icon with a muted red from a palette token; F1 and Ctrl+/ for help, letter chords for the Admin screens, `party.new`, `product.new`, `session.signOut`; sidebar icons are the Basic Home drawings (`NAV_ICONS`, `navGlyphs.tsx`) | D4 | `498d118`; the chord fix for text fields `9814dde` in `ae24de1` |
| R14 | A product name never carries the main-product code (`OPT`): `productLabel(name, brand)` is the one composer; the share PDF's subtitle was fixed after D5 found it (`e7902c3`); `master/tests/no-category-code-in-display.test.ts` reads every source folder | D2 `67cabcf`, D3 `e7902c3` | `2e2ab26`, `3cadb63` |
| R15 | **Stock and inventory removed everywhere** (nav, screens, columns, reports, settings, permissions, PDFs; conversion and dispatch write nothing). The tables stay (migrations only add); an old Office's stock commands are refused cleanly | D2 `082a101`, `1f7068a`, `c9adfa4` | `767df5b`, `2e2ab26`, `32c1793` |
| R16 | **Create product share**: tick products on either panel, an A4 PDF, four to a page (2x2) with photographs, no money, labels in the company language. Socket `product:sharePdf` (protocol 7), `POST /api/products/share.pdf`; 400 products with photos took about 5 s and 16 MB | D3 `25550bc` | `de630c4` |
| R17 | Sort (server-side, kept per machine) and filters on Parties (city, state, GST) and Products (size, photo, plus the existing brand and product). **Products have no grade or packaging column, so there is no such filter** (owner-accepted) | D3 `1011fa7` | `de630c4` |
| R19 | The 2026-10-01 carry-over audit (CH1): Phase 9 acceptance not done, the Printroom owner questions, the board avatars (now R22) | CH1 | this section |
| R20 | Product import and export work across versions: the 1.2.5 columns are unchanged, the xlsx carries a format version, fixtures of a 1.2.5 export import with no loss (stock columns in an old file are ignored with a notice) | D2 `3e80fdf` | `2e2ab26` |
| R21 | Plan with Opus, build with five Sonnet sessions, audit every row: each D's work was independently re-audited, then D5 merged in order and ran the gate | CH1, D5 | `4caa3a4` |
| R22 | **Faces on the board cards and rows** of Pending and Final orders on both panels (up to 3 plus "+N", an "editing" ring), a per-board `presence:board` push (protocol 7, in memory only, throttled 500 ms, Party Access per reader, never sent to an Office below 7), swept every 10 s | D2 `f806967`, `085878d` | `32c1793` |

Migrations added by the batch, in order after `20261007…`: `20261012000000_catalog_lists_grant`,
`20261013000000_printroom_office_management_grant` (both add-only unions into role
permissions; nothing else touched). New permission key: `catalog.lists.manage`.

### Owner decisions taken in this batch (do not re-decide without a reason)

- **Stock removal (R15) is code and UI only.** The tables and their data stay because migrations only add. The owner confirmed: "no need to keep inventory in check, just order management."
- **Printing a note needs the right to view the record, not an export right** (R10); the Printroom's `sendJob` follows the same rule.
- **"Without logging in" (R8) means the Master server comes back and serves the Offices.** The screen is not auto-signed-in: an unattended signed-in administrator is a security hole.
- **UAC: option B.** The installer registers a scheduled task that runs the staged setup at the highest privilege. The task verifies the signed manifest and the SHA-256 itself, trusts nothing in its environment or in a user-writable folder, and the uninstaller removes it. Independent security re-audits found no blocking hole before D1 was accepted; the real install has never been run (below).
- **The releases repository is the public `BlazingFire/OrderBook-Releases`** (installers and manifests only, no source); it is the built-in default of `ORDERBOOK_RELEASES_GITHUB_REPO` (`.env` can override; empty turns the poll off; tests turn it off) and `npm run release` publishes there.
- **"Save all" covers every form**, not just New lead: ready forms are saved, invalid ones are named in the dialog (`useUnsavedWork`, `useFormBaseline`).
- **The same-version gate works both ways** (an Office ahead of its Master also waits).
- **"Instantly" is a 2-minute poll plus Check now** (GitHub cannot push to a LAN).
- **R5 is one key**, `catalog.lists.manage`, not three; **R17 has no grade/packaging filter**; the Parties "owner/access" filter is the existing Party Access scope.
- **R22 is built in full** (the dropped board avatars of Phase 4), because the owner consistently asks for full scope.
- **The batch ships as 1.3.0** (1.3 was never released); the version is bumped before any build (the standing owner rule).

### Traps found in this batch

- **A stale `shared/dist` before typecheck.** After a merge that changes `shared/`, `npm run typecheck` reports missing members (`reservations`, `freeToSell`, `lowStockCount`) until `npm run build` has run. Gate order: lint, build, typecheck, test, smoke.
- **CRLF checkouts break source-reading tests.** A Windows checkout (`core.autocrlf`) has CRLF; a test that reads a source file and splits or matches on `\n` fails on an untouched file. `master/tests/credential-invariants.test.ts` `read()` and `electron/tests/staged-update.test.ts` now normalise; **new source-reading tests must too.**
- **Two panels on one host share a cookie jar** (cookies are not port-scoped). In a browser pass open the Master at `localhost:PORT` and the Office at `127.0.0.1:PORT`, or the sessions overwrite each other.
- **Stop only your own PIDs.** Never kill by process name or command-line pattern: one such kill took down peers' servers and test clusters. Note the PID of each server you start.
- **`pg_ctl` for the integration tests:** each session needs its own `TEMP`/`TMP`, `ORDERBOOK_TEST_PG_PORT` and the system `ORDERBOOK_PG_BIN` (`C:\Program Files\PostgreSQL\17\bin`); otherwise `pg_ctl start` exits 1 or collides with a peer's cluster. A skipped integration suite prints like a green one.
- **Load-sensitive tests** (they pass alone, and in the next full run): `master/tests/update-check.test.ts` "answers within the wait while a slow download carries on in the background", `ui/tests/chatroom.test.tsx` "shows the picker only with chat.shareRecords…", and the sign-out chord test (given a 20 s budget). Re-run the file alone before suspecting the code.
- **A screen kept alive in a hidden `<Activity>` runs its effect cleanups when hidden and its setups when shown.** A "mounted" flag that only ever goes to false swallows every later answer (the share dialog never opened); set it in the setup too (`ui/src/ProductShare.tsx`).
- **A fresh install gives Office and Management no `fields.view`.** The three catalogue lists are therefore readable by everyone on purpose, and `fields.routes.ts`'s value routes carry no middleware gate: the service decides (`requireListRead` / `requireListWrite`); `credential-invariants` names the four routes. `catalog.lists.manage` cannot be given to an office-tier role (management ceiling).
- **The Recycle Bin offers a person only what they can restore.** `fields.manage` alone sees every list except brands, packaging and grades; `catalog.lists.manage` alone sees only those three (`optionScopeFor` in `recycle-bin.service.ts`).
- **The share PDF speaks the deployment's language** (`ORDERBOOK_DEFAULT_LOCALE`), not the signed-in person's.
- **`ORDERBOOK_TEST_PG_*` and the preview servers:** a preview needs a scratch database and ports of its own; the owner's `order_book` is never used.

### Owed by the owner (an agent cannot do these)

Nothing from this batch has run on a real PC, a real printer or Windows 7.

1. **The real-PC checklist.** Run on a clean Windows 10/11 PC as a standard user with an administrator for UAC (copied from `CLAUDE_HELPER_D1.md`):
   1. **makensis compile and the `!system` bake.** Build the Master and Office installers. `installer/script-hashes.nsh` must be written (UNINSTALL_SCRIPT_SHA256 always, UPDATE_DIRS_SHA256 for the Master). Edit `uninstall-orderbook.ps1` by one byte, recompile with `electron-builder --prepackaged`, and confirm the new hash is baked. A failed bake must stop the compile. This also proves the `System::Call` calls, the backtick string and the `$$` escapes in `verified-powershell.nsh` under real NSIS.
   2. **`-Mode Install` (elevated).** Install the Master per-machine. `%ProgramData%\OrderBook\staged-update` (anybody writes) and `elevated` (Administrators and SYSTEM write, Users read) must exist with those ACLs and owners (`icacls`, `Get-Acl`); `resources\apply-update\paths.json` must be written; exit 9 means a hash mismatch. Pre-create a squatter folder or junction first: the install must clear or refuse it.
   3. **`schtasks /Query /TN "OrderBook Master Update" /XML`:** RunLevel HIGHEST, one-time trigger, action `"C:\Windows\System32\cmd.exe" /d /c ""...\resources\apply-update\apply-update.cmd""`, and a standard user cannot edit or delete the task.
   4. **A nightly run.** Set the auto-update time a minute ahead with a newer signed release published: the Master saves unsaved work, signs out, the task runs, `result.json` goes `checking` then `installing`, the setup runs `/S --force-run`, the app relaunches on the new version, and Offices behind show the blocking update screen. A refused task (tampered manifest or hash, older version) leaves the server running and writes `refused`; 90 s of silence also recovers the server; the 23:00 window runs once per night.
   5. **The UAC flow (manual update).** Install now: one UAC prompt, progress bar and speed, Save all first (8 s cap), sign-out, quit, install, relaunch. Decline the prompt: the server recovers and the app keeps working.
   6. **Uninstall.** With and without delete-data (without: data and profile stay; during an update nothing is swept); a junction inside the install folder and inside the data folder pointing at a folder with a file (the junction goes, the target survives); a data folder moved to a non-OrderBook name (`E:\CompanyData`), a drive root and a link are left alone and logged; `ORDERBOOK_RELEASES_DIR` set to a decoy is not deleted; afterwards `%ProgramData%\OrderBook\{elevated,staged-update}` and the task are gone.
   7. **Environment hardening, elevated.** With `COR_ENABLE_PROFILING=1`, `COR_PROFILER` and `COR_PROFILER_PATH` pointing at a harmless logging DLL in the user's environment, run the install, the uninstall and a nightly update: the DLL must not load (Process Explorer or Procmon). The same with a planted `Microsoft.PowerShell.Archive` in `Documents\WindowsPowerShell\Modules`, and an HKCU `Command Processor\AutoRun` that writes a file (it must not run from the task).
   8. **Fuses on the Win7 legacy binary (Electron 22).** After a real electron-builder run: `npx @electron/fuses read --app "OrderBook Master Panel.exe"`. `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` off, `RunAsNode` on; the app and its server still start; `NODE_OPTIONS=--inspect` is ignored. Repeat on the Electron 33 build and the Office build; the sentinel must be found.
   9. **Version gate and Office.** An Office one version behind and one ahead of its Master are blocked (behind: the update screen with install; ahead: waits and polls every 10 s, no install offered) and unblock when the versions match.
   10. **R2 and R6 on the real shell.** No menubar in either Electron window (Alt does not bring it back), Check now works from the Master Updates screen, and the update notification appears and links to the Updates screen.
2. **Also on real hardware:** the **Printroom station claim** (the Electron print-station runner actually printing), **a real printer** (copies, silent printing while the window is minimised, Save PDF, the PDF window, **Print from the Create product share dialog**), the **Win7 VMs** (x64 and x86 SP1 with KB2999226: install, pair, work online and offline, print, update over the LAN, Standalone, uninstall), and a **Master UI visual pass** with the owner's own eyes (the Chatroom, the Printroom and the notes were never seen by the owner before this batch; also the Lists module, filters, product share and the board faces).
3. **Bump the version to 1.3.0 before any build** (the standing rule): root, `cleaner`, `master`, `office`, `shared`, `ui`, `master/web` and `office/web` `package.json` all say 1.2.5, as do the panels' footers and update screens. Update the Master first (`npm run release`, then `npm run release -- --os win7`).
4. **Open branch and push decisions.** `main` is **not pushed**. Local branches still exist: `d1/1.4` … `d5/1.4` (and `d3/1.4-fix`, `d4/1.4-fix`, the `*-docs` branches), `helper/1.3`, `dev`; the remote still has the thirteen old `claude/*` branches and `dev`. Pushing `main` and deleting the merged branches is the owner's call (the standing rule is "delete merged branches with the owner's OK"). The git worktrees `OrderBook-d1`…`d5`, `OrderBook-helper` and `OrderBook-d4-audit` can go once their branches do.
5. **The master key is not in the repository** (`docs/MASTER_KEY.md` says so on purpose: the repo goes to GitHub). Keep it with the site's other secrets.
6. **Smaller open questions:** the Office New-lead product search placeholder still reads "Type a product name or code, e.g. OPT, one piece toilet" (an example of a code to search by, not a product name; D5 asks whether the owner wants the token gone); the four open Printroom questions from H5 (printing with nobody signed in, 30-day retention of sheets, reprint by the sender, a printer per PC; the fifth, the protocol number, is settled at 7); whether the board faces (16 px) should be 20 px.

### Next session, in this order

See `docs/NEXT_PHASE.md` "First: the 1.4 batch is done". In short: the real-PC pass above,
then release 1.3.0 (Master first), then the backlog.

## 1.3 batch — status (SUPERSEDED 2026-10-03 by the 1.4 batch above)

**Everything in the 1.3 batch is merged into `main`**: the helper's H3 (notes, Save PDF,
print copies), H4 (the **Chatroom**, which was missing for a while and is present) and
H5 (the Printroom) went in with `68055a8` and `6350134`, and the 1.4 batch then built on
them. What was "owed" and "next" here is now in the 1.4 section: the real-PC pass, the
1.3.0 version bump and release, and the branch decisions. The table and the notes below
are kept as history.

The owner's 1.3 batch was planned in `docs/plans/1.3-BATCH.md` (approved), detailed in
`docs/plans/1.3-BATCH-DETAIL.md`, with per-domain designs in `docs/plans/1.3-designs/`.
The Basic Home mockup is `docs/design/basic-home-mockup.html`.

### Where each phase stands

| Phase | What | State | Commit |
|---|---|---|---|
| 0 | Windows 7 floors + legacy Office build (Electron 22) | **done** | `8ab7d20` |
| 1 | Basic Home, Master UI refresh, Inventory UI hidden, loading bars, device code, low RAM | **done** | `14c3dca` |
| 2 | Server Master tier, master key, protocol handshake, full audit, Logs on Office | **done** | `b3b0260` |
| 5a | Party import/export (helper H1) | **merged** | `455f686` |
| 5b | Reports: 15 kinds, xlsx/pdf, both panels, visibility, owner scope (helper H2) | **merged**, with its rework and follow-ups | `455f686`, `68055a8` |
| 3 | Realtime rules 1/5/6, push gate, stage HLC, notification centre | **done** | `92c4b94` |
| 4 | PO numbers, presence, stale-edit, Master authority | **done**. The board-card avatar stack was dropped here and built in the 1.4 batch (R22). | `4fc9564` |
| 6 | Chatroom (helper H4) | **merged**; present on `main` | `68055a8` |
| 7a | Notes from pending orders, copies, Save PDF, report PDF window (helper H3) | **merged** | `68055a8` |
| 7b | Printroom + auto-print station (helper H5) | **merged** | `68055a8` |
| 8 | Backup all to external drive, Magic restore, auto-backup | **done** | `4ec0a96` |
| 9 | Acceptance on real PCs (Win10 Master, Win10 Offices, Win7 x64/x86 VMs), release 1.3.0 | not started; the checklist is in the 1.4 section above | n/a |

Nothing in the batch has been pushed to GitHub or released. Every phase was
committed to local `main` after its gate passed: lint 0, typecheck 0, build 0,
`smoke:legacy` 0, and the full test suite with integration suites run.

### How the 1.3 work was run

- **Lead session (Opus)** runs each phase as an ultracode workflow, using
  `~/.claude/projects/C--Users-Z-Desktop-OrderBook/<session>/workflows/scripts/orderbook-phase.js`.
  The script takes args `{phase, title, designs[], extraGates[], slices[{key, scope}]}`.
  For each phase it runs the slices in sequence on `main`'s tree, then the gate,
  then three adversarial reviewers, then up to three fix rounds. A browser pass
  and the commit follow. The plan's phase sections in
  `docs/plans/1.3-BATCH-DETAIL.md` are the slice source.
- **Helper session (Sonnet)** works only in the git worktree
  `C:\Users\Z\Desktop\OrderBook-helper`, on branch `helper/1.3`, with its own
  test cluster (port 55434, its own TEMP). The lead reviews each helper
  commit with an independent read-only workflow and merges the branch into
  `main` at phase boundaries.
- **Coordination file:** `C:\Users\Z\Desktop\OrderBook\CLAUDE_HELPER.md`
  (untracked, in `.git/info/exclude`). It holds the task board (H1–H5),
  Done log and Messages. Read it first when resuming. The helper rewrote
  the file's format on its first turn, and the lead's board replaced it
  afterwards.

### Traps found in the 1.3 batch

- **Integration tests on this PC need the system PostgreSQL.**
  `$env:ORDERBOOK_PG_BIN='C:\Program Files\PostgreSQL\17\bin'`. The bundled
  `pg_ctl.exe` gets "Access is denied" here.
- **A browser pass needs a scratch database**, never the owner's `order_book`.
  `.claude/launch.json` (gitignored) has `master-preview` / `office-preview`,
  pointing at `postgres://ob@127.0.0.1:55440/ob13_preview` and
  `.tmp/preview-*` data folders. Start the scratch cluster with
  `pg_ctl -D .tmp/preview-pg -o "-p 55440 -h 127.0.0.1" start`, detached
  (Start-Process): a Bash `pg_ctl start` hangs on the inherited pipes.
- **The workflow notifications are large.** A lead session spends roughly
  60–80k context per phase. Plan on about four phases per session.

## Current state (2026-09-30, order notes built; catalogue v2 on the 1.2 product master)

- **Order notes (2026-09-30):** Filling note and Dispatch note per
  `docs/ORDER_NOTES_PLAN.md`, all six steps. Pure pagination in
  `shared/src/domain/order-note.ts`; preview sub-screen `ui/src/OrderNoteScreen.tsx`;
  buttons on the Office order detail and the Master orders table
  (`orders.export`); `orders.vehicle_number` (migration `20260401`, pinned last);
  Electron `listPrinters` / `printPage`. **Not yet seen on paper or in Electron**:
  the browser and Microsoft-Print-to-PDF pass in the plan's §6 is owed, and
  the four owner decisions in §8 are still on their defaults (unit "pcs",
  grouped coded side, dialog until a printer is picked, blank vehicle line).
  Trap: the row heights live only in `NOTE_LAYOUT`; the CSS reads them.

- **Catalogue v2 (2026-09-29):** the owner's Brand → Product → Sub product
  restructure (`docs/catalogue/CATALOGUE_MODEL.md`) is ported onto `main`'s
  1.2 model and merged to `main`. A first build of it on a stale checkout
  that never took 1.2.0 (`catalogue-v2-stale`, `6549018`) was not merged: its
  pricing, `colour_policy`, PDF Designer and settings code is what `main`
  removed on purpose. **Walked in a browser** on both panels against a
  sandbox database (operator scripts, lead entry for every colour rule,
  review and save, the lead PDF's text, Products / Brands / Sub products,
  Settings → Leads on both panels, the Master's inventory and leads list);
  **not yet in Electron** — the PDF window is owed (`docs/AI_COLLABORATION.md`,
  2026-09-29 entry).
- **Branches:** `main` is the only long-lived branch; `dev` was reset to
  `main` on 2026-09-22 to develop on. Every other branch was merged or
  retired that day (see "Branch consolidation" below), and the twelve still
  on GitHub are **to be deleted by the owner**: the cloud sessions' git proxy
  refuses branch deletion and tag pushes (HTTP 403). The 2026-09-24/25 round
  was merged straight into `main` from eleven local `fix/*` branches, which
  were never pushed and hold nothing `main` lacks. On 2026-09-25 `main` and
  `dev` on GitHub were both at `7d6ae68`, the round's last commit; if `main`
  has moved since, bring `dev` level with it before working on it. Work
  lands on `main` (directly or through `dev`); do not branch from an old
  branch.
- **The 2026-09-24/25 round** audited the whole tree and fixed what it found
  on those eleven branches, each reviewed and repaired before the merge.
  Every defect this file listed as open after the 2026-09-22 structure audit
  is fixed (see "Session history"). What is still open, including that
  audit's dispatch-by-stage-name finding (`docs/STRUCTURE.md` §5.11 #7),
  which this file had not listed, is under "Owed work".
- **Version 1.2.0**, the first build meant for customers. It adds the
  **standalone `.exe`** beside each Windows setup file, the **pre-update
  database copy** (`master/src/db/cluster-snapshot.ts`), and the
  **additive-migrations guard** (`master/tests/migration-data-safety.test.ts`).
  The owner's rule from here on: *an update replaces the software and never
  the data.* `docs/PRODUCTION_READINESS.md` §2 lists what only the owner can
  decide before shipping (signing key, what happens to any 1.0.3 data,
  code-signing certificate).
- **Verify gate:** `npm run verify` = `lint` + `typecheck` (all workspaces,
  both Electron shells, the test tsconfigs) + `vitest run`. **Last full run
  2026-09-25 after the audit round: lint 0, typecheck 0, build 0, 160 test
  files / 2015 tests passing, integration suites included** (PostgreSQL
  16, run as a non-root user — see "How to run"). Run the three steps
  separately and check each exit code. As root the integration suites skip
  (the 48 `*.integration.test.ts` files) and the summary still reads green.
- **The web apps under test:** `master/web` and `office/web` still have no
  test files of their own, but `ui/tests/master-shell.test.tsx` and
  `ui/tests/office-shell.test.tsx` boot each panel's `App.tsx` whole in jsdom
  (`ui/tests/panel-harness.ts`: the real `api.ts` against a route table
  standing in for `fetch`). They pin the shell's behaviour: which screen
  Alt+N, a toast action or the gallery link lands on, the Dashboard after a
  sign-out or an ended session, the splash's "could not reach the server",
  refetches on a change event, the New lead form and the order weight
  override. Layout, styling, anything that depends on visibility, a live
  server and the Electron shell still need a browser or Electron pass.
- **Builds:** `npm run build` is green for shared, both servers and both web
  bundles on every OS: the web workspaces build through `tools/build-web.mjs`
  (resolves `tsc`/`vite` from `node_modules/.bin` by path, points
  `TEMP`/`TMP` at a gitignored `.tmp/` for the Windows esbuild/Defender lock).
- **Releases:** `.github/workflows/release.yml` builds on a three-OS matrix
  (Windows setup, macOS universal `.dmg`, Linux AppImage). **Since 1.4.1 setup
  files only**: the standalone `.exe`, the `.deb` and the `.sha256` files, and
  `TARGETS[*].besides`/`publishBeside()`/`--fast` in `tools/release.mjs`, are gone
  (batch C6); before that the standalone `.exe` and `.deb` were published
  beside the setup files and named by no manifest; the mac `.zip` is no
  longer built (nothing read it). **All three legs were green on 2026-09-25**
  (build-only run #37 on `dev` at `7d6ae68`, draft pre-release
  `build-1.2.0-7d6ae68`), so this round's release changes have built on
  every OS: both standalone `.exe`s and both `.deb`s arrived with their
  `.sha256`, and the mac leg uploaded its `.dmg`s and no `.zip`. The
  `release-workflow`, `packaging-invariants` and `release-folder-besides`
  tests cover the same ground. A push to `main`
  whose `package.json` version has no release yet publishes `v<version>`;
  unsigned (no `RELEASE_KEY` secret) it is a **draft**, which no panel
  installs. A draft counts as a release there, so the push of `7d6ae68` to
  `main` built nothing: `v1.2.0` already exists (see "Owner-only" below). A
  manual run builds into a draft pre-release `build-<version>-<sha>`;
  ticking *publish* creates the real release only on `main`, and anywhere
  else the `check` job warns and builds the draft pre-release. Existing
  releases (1.0.2, 1.0.3, 1.1.0, 1.2.0, and six `build-1.2.0-*`
  pre-releases) are all drafts. The clean-install tool (`cleaner/`) is built
  but never published into the releases folder.
- **Updates on Linux:** an AppImage copy updates in place from the Updates
  screen (the shell replaces the file and relaunches it); a `.deb` install,
  a run from source, or an unpacked copy is told to update by hand
  (`updates.systemPackageBody`). No AppImage update has been run end to end
  on a real Linux PC yet (see "Owed work").
- **Company settings: fifteen**, in five groups on the Settings tab
  (`shared/src/domain/settings.ts`): password reveal, free-to-sell, public API,
  auto pairing, developer mode, session hours, default reorder level, offline
  sign-in, adjustment note required, import creates categories, follow-up
  default days, packaging required on convert, quiet-after days, and (1.3 H2,
  group *Reports*) **show Reports to Office users / to Management users**, both
  on unless switched off and enforced by the Master on every report request. Adding one is
  a single entry there plus two i18n tokens; the screens read switches through
  `resolveCompanyFeatures()`. Since catalogue v2 two fallbacks changed, so an
  installation that never saved them changes on upgrade, as the owner asked:
  **follow-up default days 3** (was 0, today) and **packaging required on
  convert off** (was on). An Office panel may save the follow-up default from
  its own Settings → Leads tab, as the signed-in user; the Master still checks
  `settings.manage`.
- **Packaging and grade (2026-09-30, owner's instructions):** on the New lead
  card each row's packaging and then its grade sit right beside its quantity,
  the same box each (the kit's pick-only `Select`), in the Enter/Escape walk:
  quantity → packaging → grade → next row, and after the last grade **Add
  product**, whose Enter adds the card. A pick (Enter or mouse) steps on by
  itself. Grade is per line now (`DraftRow.grade`), no longer one card-level
  pick below the rows. Packaging choices are the `line.packaging` list, which
  `20260328000000_line_packaging_defaults` seeds with **Box, Grass, Paper**
  (added after any existing values, never doubling one). The owner's dev
  database held Carton, Pallet and Shrink wrap from before; on the owner's
  say-so they were soft-deleted there (Recycle bin) on 2026-09-30.
- **Product master (catalogue v2, 2026-09-29):** the owner's **Brand →
  Product → Sub product** on the 1.2 tables. A Product is a
  `product_categories` row with a software `code` (`OPT`), a `brand` (a
  `product.brand` option value) and a catalogue `sort_order`; a Sub product
  is a model (`products`) with **exactly one variant**, whose code is
  `CODE-0001…` in catalogue order. A product is name · category · alias ·
  size · *made in every colour* switch · custom fields, with variants of
  code · colour · weight. The colour rule (`fixed` / `dedicated` /
  `selectable`) is derived from the model and its variant, never stored
  (`colourRuleOf`, `shared/src/domain/colour-rule.ts`). Stock, movements and
  reservations are per **variant**. A lead line on a multi-colour product
  may name a colour from `stock.colour`, several colours being several
  lines; a line snapshots the category's name, code and brand, and carries a
  **grade** from `line.grade` (a line attribute, never a catalogue one). The
  spec is `docs/catalogue/CATALOGUE_MODEL.md`; the SWISWARE data (1 brand,
  21 colours, 41 products, 549 sub products) is
  `master/assets/catalogue/swisware-plus-2026.md`.
- **Release note for 1.3 (Phase 1, 2026-10-02) — shortcuts, home screen,
  theme.** Put these lines in the release notes:
  - *The Alt digits moved on both panels.* Basic Home Alt+1, Dashboard Alt+2,
    Pending Orders Alt+3, Final Orders Alt+4, Conflicts Alt+5, Products Alt+6,
    Parties Alt+7, Party access Alt+8, Settings Alt+9. The Master's Admin items
    (Office panels, Roles & users, Fields, Logs, Recycle Bin, Integrations), its
    Reports (now under Work) and Updates on both panels **lost their digits**;
    Ctrl+K reaches them. Shortcuts a person remapped are kept.
  - *Office and Management staff now start on Basic Home*, a page of large
    tiles for the screens they may use; admins still start on the Dashboard.
  - *Inventory is gone from the Master's screens.* Stock still moves on dispatch
    and the Dispatches report is unchanged; the server routes and the public API
    are untouched.
  - *The Master switches to the light theme once* after the update (its stored
    theme key changed to `ob.theme.v3`). Dark is still in Settings → Appearance,
    and a choice made after that sticks.
  - Loading now shows a thin bar along the top of the window after 300 ms, and
    the Office shows its device code on the sign-in and connection screens.
- **Release note for 1.3 (H2, 2026-10-03) — Reports.**
  - *Reports is on both panels and has fifteen reports,* Excel and PDF as well as
    CSV. The Office and Management tiers see their own
    figures only; an administrator can pick any user. The existing three reports
    and their CSV files are unchanged.
  - *Office and Management roles now hold `reports.view` and `reports.export`*
    after the update. A company that does not want that has two switches under
    Settings → Reports; an administrator can also untick the keys on one role.
  - *New periods:* this financial year (from 1 April) and exact dates.
  (Earlier, 2026-10-01, parity plan P2 and P4 had already moved the Master's
  digits once, to match Alt+1 to Alt+6 on the Office.)
- **Release note for 1.3 (Phase 2, 2026-10-03) — Server Masters and the master
  key.** Put these lines in the release notes:
  - *A fresh setup creates two Server Master accounts and no `admin`.* The owner
    types both on the first-run screen (suggested `master` and `master-backup`).
    Server Masters are above Normal Admin, hold every permission, and sign in
    **only on the Master PC**.
  - *An existing installation must set up two Server Masters on the Master PC.*
    After the update the Master PC's sign-in screen asks for the master key and
    then the two accounts, with no skip. **LAN admins and Office panels keep
    working meanwhile**; existing admins stay admins.
  - *Admins can no longer change a Server Master* (edit, deactivate, delete, reset
    or demote), and at least two active Server Masters must remain. The admin
    tier is now shown as **Normal Admin**.
  - *The master key* (`docs/MASTER_KEY.md`) is asked for on the Master PC to reset
    a forgotten Server Master password ("Forgot Server Master password?"), to
    change a Server Master's account, and to change the pairing password
    (Settings → Connection). Panels already paired keep working after a pairing
    password change.
  - *The activity log is on the Office too* (System → Activity log, with
    `logs.view`), names entity types and actions in the reader's language, and
    highlights a Server Master's entries. Its CSV gains `sentence` and `details`
    columns.
  - *Every remaining action is logged* (remarks, conversions, conflict choices,
    panel revoke/disconnect, pairing window, developer mode, updates, exports,
    backups, sign-out, session expiry, offline sign-ins).
  - *Update the Master before the Offices.* An Office newer than its Master says
    "update the Master" for a command the Master cannot answer yet instead of
    waiting out a timeout.
- **Release note for 1.3 (Phase 3, 2026-10-03) — the link, the order of offline
  work, the bell.** Put these lines in the release notes:
  - *An Office notices a lost link within about 10 seconds* (a pulled cable in
    about 2) and reconnects on its own within about 5 seconds of the Master being
    back; it never needs a restart. After reconnecting it reads "Catching up"
    until what it missed is in and its queued work is sent.
  - *An Office that has been offline for an hour says so*: a banner, an entry in
    the bell and, in the desktop app, one Windows notification and a flashing
    taskbar button per episode. The sync popover shows since when. Everyone who
    manages panels gets a bell notice, and the Master's Office panels screen
    and Dashboard show which panels have been away an hour.
  - *The notification bell* is in the top bar of both panels.
  - *If the Master's address changes*, an Office finds it again by itself, but
    only after it has connected once since this update, and only after the new
    address proves it is the same Master. An Office whose Master does not know
    it keeps its pairing and says "Not recognised by this Master" instead of
    forgetting it.
  - *Work done offline on several PCs is numbered in the order it was done* when
    they come back together (within about 6 seconds of each other). A stage
    change made offline that is older than a change made since becomes a
    conflict to review rather than overwriting it.
  - *A PC whose clock is more than 2 minutes off the Master's* shows a banner;
    set the right time there.
- **Release note for 1.3 (Phase 4, 2026-10-03) — PO numbers, who else is here,
  no silent overwrite.** Put these lines in the release notes:
  - *Every pending order has a PO number*, `PO/2026-27/00042`, one series per
    financial year from 1 April, shown everywhere the order appears: lists,
    headers, toasts, the PDF, the Filling and Dispatch notes, search, the
    Dashboard and the activity log. A final order shows its pending order's.
    Existing pending orders were numbered in the order they were created.
  - *A pending order saved on an Office while the Master is out of reach shows
    "Provisional"* until it syncs; online, the save names its number. One saved
    offline for a while gets a bell notice when it is numbered.
  - *A record shows who else has it open*, with a ring around anyone editing it.
  - *Nobody's save is silently overwritten*: if someone else saves a pending
    order you are editing, the form says who and when and offers "Reload theirs"
    or "Keep mine".
  - *A Server Master can raise a pending order for any user* (an Owner picker on
    the Master's form) and delete any user's; both are logged under their name.
- **Live databases:** external PostgreSQL via `.env` `DATABASE_URL` on both of
  the owner's machines (`order_book` on the PC, `order_book_new` on the
  laptop). The first Master started from a pre-1.2 database runs
  `20260323000000_product_variants` (wipes every product-linked table) and
  `20260324000000_product_master_trim` (drops the pricing/tile columns in
  place; `down()` throws). the `/api/developer/load-catalogue` route (no screen since
  5a32106) or `npm run seed:catalogue` loads the SWISWARE catalogue additively: 41
  products, 549 sub products (one variant each) and the 21-colour range, with
  blank weights.
- **Take a `pg_dump` before main first boots on the owner's PC database.**
  On 2026-09-28 `order_book` was booted by a stale checkout (branch
  `catalogue-v2-stale`, `6549018`) that never took 1.2.0, and it ran that
  checkout's `20260323000000_catalogue_brands_and_codes`. It has therefore
  never run main's `product_variants`, `drop_document_designer`, trim or
  `line_item_grade`. The first time main boots on it, `product_variants`
  **TRUNCATEs products, categories, images, party-wise records, stock,
  movements, reservations, leads, orders, their lines and timelines** —
  everything entered on the stale model — and the trim deletes the stale
  `product.brand` values; then the port migration finds its columns already
  there. With `DATABASE_URL` set the Master takes **no** automatic pre-update
  copy (`master/src/index.ts` skips `snapshotClusterBeforeUpgrade` for an
  external database), so the dump is the only way back. The owner took one on
  2026-09-29 (`pg_dump -Fc` to `C:\OrderBook-Backups\order_book-2026-09-29.dump`,
  165,135 bytes, restorable with `pg_restore --clean --if-exists`); it is only
  a way back if it was taken before main's first boot there. The laptop's
  `order_book_new` history is not recorded here: read its `knex_migrations`
  before booting main on it. After the wipe, `npm run reload:catalog` (Master
  stopped) or *Load catalogue* brings the catalogue back.

## Branch consolidation (2026-09-22)

Everything was brought onto `main` and `dev` was reset to `main`. The other
branches below are safe to delete: their work is in `main` or superseded.

| Branch | What it held | Outcome |
|---|---|---|
| `claude/amazing-lovelace-r5851k` | 1.2.0: standalone `.exe`, pre-update DB copy, migration guard, CI fixes | merged |
| `claude/hopeful-lovelace-q6f57v` | 29 commits (09-16..18): company settings, privilege fixes, Master Parties screen, lead/order delete, clean-install tool, Mac/Linux builds | merged onto main's model (see below) |
| `claude/vibrant-ride-tb43f7` | filter strip spacing, category chips dropped | merged (main had already dropped the chips) |
| `claude/serene-hawking-3dee4n`, `claude/zealous-cori-u233hm` | already in main | delete |
| `claude/exciting-brown-ufq4ka` | a TypeScript lib fix | obsolete — main typechecks without it; delete |
| `claude/backend-ui-development-e25geo`, `ceramic-offline-web-app-6wjqq5`, `claude-md-docs-0zohib`, `master-panel-office-admin-wjuqka`, `office-panel-user-signin-0x229o`, `refactor-production-codebase-7gbz9v` | August work on the pre-rewrite history (main was re-rooted since); every feature they carried is in main in later form | delete |
| `dev` | 30 commits behind main, nothing unique | **reset to `main`** (kept) |

The merged three (`amazing-lovelace`, `hopeful-lovelace`, `vibrant-ride`) are
safe to delete too. Deleting the six August branches drops history that exists
nowhere else; if that matters, tag them first
(`git tag archive/<name> origin/<name> && git push origin archive/<name>`).

**How hopeful-lovelace was merged.** It was cut before the variant
restructure and the pricing removal, so it was merged onto main's model:

- *Kept:* the settings above, the auth/panel privilege fixes, offline sign-in
  switch, the Master Parties screen with the shared `ui/PartyFormModal`
  (Office's `PartyDrawer` moved there), lead and order delete on the Master,
  the clean-install tool, the release matrix, the web-reachability guard.
- *Dropped as moot:* `pricing.enabled` and every money-field gate,
  `catalog.defaultUom` and the `select` setting control (units are gone), the
  masked image responses, and the tests written for them.
- *Adapted to per-variant stock:* the default reorder level, the
  adjustment-note check, and the import category gate.
- *Removed as dead code the guard found:* the Master api client's
  `customFields`/`partyVariants`/`products`/`createLead` and the Office's
  `stockInbound`/`stockAdjust`.

**Not on GitHub and not merged:** the local CLI session "UI improvement"
committed `a3fa9e4` (Phase 6.0 standalone flavour, 69 files) on a branch
`feat/marcwares-design-system` on the owner's machine. It was never pushed, so
it is not part of this consolidation — push it before deleting that clone if
it is still wanted.

## How to run

```
npm install
npm run verify                  # lint + typecheck + tests
npm run build                   # shared, both servers, both web bundles
npm run start:master            # → http://localhost:4100
npm run start:office            # → http://localhost:4200
npm run dev:master / dev:office # servers with reload; add dev:shared if editing shared/
npm run build:shell             # compiles electron/ and copies it into both panels
npx electron master/electron/dist/master.main.js
npx electron office/electron/dist/office.main.js
npm run release [version] [-- --panel office] [-- --os win|mac|linux]
npm run seed:dummy              # admin/Admin@1234, management/Manage@1234, office/Office@1234
```

Master-only operator scripts (`--workspace @orderbook/master`):
`wipe:business`, `seed:parties`, `reload:catalog`, `seed:catalogue`,
`seed:demo-parties`. They talk to the live database — read
`master/src/services/catalog-reload-cli.ts` before running one. Run them with
the Master stopped: each starts the database the way the Master does and
stops it when done (with `DATABASE_URL` set it stops nothing).

- `wipe:business` and `seed:parties` wipe the business data first, the whole
  activity log and every connector link with it; `seed:parties` then adds
  three sample parties.
- `reload:catalog` (catalogue v2, `--catalogue`) **keeps parties, party
  access, users, roles, settings, option lists, `id_map` and the activity
  log**, and resets no id counter. It parses
  `master/assets/catalogue/swisware-plus-2026.md` before it starts the
  database (a malformed file is refused with its line number), refuses while
  any other client is connected to the database (`pg_stat_activity` — a
  running Master always is), and warns that every Office outbox must be
  drained first: queued work that quotes the old catalogue is refused
  afterwards. Then `loadCatalogue({ replace: true })`, in one transaction,
  deletes only the catalogue and what quotes it — stock, movements,
  reservations, lines, timelines, leads, orders, their sync conflicts,
  party-wise records, photo rows, product connector links, variants, sub
  products and products — loads the file and writes one `catalog.reloaded`
  activity row. Photo files go at the Master's next boot. The pre-v2
  behaviour (wipe, then load) is `npm run wipe:business -- --with-catalog`.
- `seed:catalogue` loads the same file additively — a product found by code
  or (brand, name), a sub product already live under the same name skipped
  — as the `/api/developer/load-catalogue` route does (no screen since 5a32106), and writes one
  `catalog.imported` row when it adds anything.
- `seed:demo-parties` adds 13 demo dealers through `createParty`, wipes
  nothing and skips a name already on the books.

**Integration tests as a non-root user** (PostgreSQL refuses to start as
root). In a Linux container with PostgreSQL 16 installed: copy the checkout
somewhere the `postgres` user owns, then
`su postgres -s /bin/bash -c 'cd <copy> && TMPDIR=<copy>/.tmp HOME=<copy>/.home npx vitest run'`.
`docs/NEXT_PHASE.md` §2 has the longer recipe.

Owner's environment: Windows 11, PowerShell 5.1 (`&&` does not work — use
`;`). npm 12 blocks install scripts; approve native modules with
`npm install-scripts approve <pkg>`.

## Where things live

```
shared/        types, Socket.IO event contract, UDP discovery protocol, i18n catalogue (en), column map, settings
ui/            the one shared React kit (one barrel, consumed as source), screens/forms both panels share
master/        Master server (src/) — domain/ → services/ → repositories/ → http/ + realtime/; migrations in src/db/migrations/
master/web/    Master React frontend
office/        Office server (src/) — sync/, outbox, local snapshot store, forwarding to the Master
office/web/    Office React frontend
electron/      one desktop shell; master.main.ts / office.main.ts / cleaner.main.ts are thin configs over shell.ts
cleaner/       packaging for the standalone clean-install tool (logic in electron/lib/cleaner/)
tools/         release.mjs, build-web.mjs, make-icons.mjs, uninstall scripts, eslint rules
docs/          all prose; nothing source-of-truth lives in a code comment
.commandcode/skills/   team-shared project skills (tracked)
.agents/skills/        the UI-consistency skill in the shape Muse Code discovers
```

- **Layout:** `docs/STRUCTURE.md` is the map — every workspace and file, the
  schema, the main flows end to end. Read it before hunting for a file.
- **UI:** import from `@orderbook/ui`; never copy a component into a panel
  (`master/tests/no-duplicate-ui.test.ts`). A screen or form both panels need
  lives in `ui/` and takes a `transport`, never a panel's api client
  (`ui/tests/no-transport-dep.test.ts`) — `PartyFormModal` is the example.
- **Strings:** one catalogue `shared/src/i18n/en.ts`, kept in
  English only. A bare string in JSX fails lint; a `t('…')` naming a
  missing key fails `master/tests/i18n-call-sites.test.ts`.
- **Errors reach a screen through `apiErrorText`** (`ui/src/errorText.ts`);
  a 401 is announced through `ui/src/sessionEnded.ts`.
- **Company switches** ride on `SignedInUser.features` (Master) and
  `SyncSnapshot.features` (panels), built by
  `master/src/services/company-features.ts` and resolved by
  `resolveCompanyFeatures()`. A setting change forces a panel resnapshot.
- **Dead api-client members fail the build**
  (`master/tests/web-reachability.test.ts`): delete them, or add them to its
  allow-list with a reason.
- **Copy to the clipboard through `copyText`** (`ui/src/clipboard.ts`), never
  `navigator.clipboard` directly: a browser gives that only to a secure
  context, and the panels run over plain HTTP on the LAN.
- **Tests for the web apps' shells** live in `ui/tests/`
  (`master-shell.test.tsx`, `office-shell.test.tsx`, over `panel-harness.ts`),
  since neither web app has a test directory.
- **Desktop shell pieces:** the Office server's environment is
  `electron/lib/office-env.ts` (the Master's is still inline in
  `master.main.ts`); how a copy updates is `updateMethod()` in
  `electron/lib/installer.ts`; the AppImage replace and relaunch is
  `electron/lib/appimage.ts`.

## Working agreements

- **Verify before done.** `npm run lint`, `npm run typecheck` and
  `npm run test` each exit 0. `master/web` and `office/web` have no test
  files of their own; the jsdom shell tests in `ui/tests/` catch which screen
  a key, toast or link lands on and what a form sends, not layout, styling
  or anything visibility-dependent. For those a real browser or Electron
  pass is the verification, and a change not run in one should say so.
- **Never delete or rewrite a migration** that may have run anywhere;
  `master/tests/migration-registry.test.ts` pins the names.
- **Migrations after 1.2.0 only add.** `migration-data-safety.test.ts` fails
  on TRUNCATE / DROP TABLE / DROP COLUMN / DELETE FROM in `up()`; an exemption
  is the owner's decision. It is a tripwire, not a proof — read a migration
  for what it loses.
- **Single-writer.** The Master owns all persistent state; Office panels
  forward writes and never write their own database.
- **Offline-only runtime.** Nothing loads from a CDN or calls the internet.
- **Docs and code live separately.** `.env` is gitignored and never committed.
- **Desktop only.** Design floor 1024×768; laptop-to-4K at 79–157 % scale.
- **No pricing, no AI.** Do not reintroduce money anywhere; do not bring the
  assistant back.
- **Before you stop, `git status` for `??`.** An uncommitted migration is
  indistinguishable from a deleted one to every other machine.
- **Guards must be seen to fail.** Break the code, watch the test go red, put
  the code back — and check the assertion reaches the thing it names.
- **Agent self-documentation is a claim, not evidence.** Verify a HANDOFF or
  change-log entry against the code before relying on it.
- **New code keeps to the Windows 7 floors** (since 2026-10-02, 1.3 Phase 0;
  `docs/WINDOWS7.md`). `office/src`, `shared/src` and the shell files the
  Win7 build compiles (`electron/shell.ts`, `office.main.ts`, `preload.cts`,
  `electron/lib/*.ts`) run on Node 16.17; `ui/src` and both `web/src` run on
  Chromium 108. The `floor/*` ESLint blocks, `master/tests/legacy-floor.test.ts`
  and `office/tests/legacy-compat.test.ts` catch what they can statically;
  `npm run smoke:legacy` is the runtime check, so run it after touching the
  Office server or the shell.

## Key decisions (do not re-decide without a reason)

1. **Two Node/Express + Socket.IO servers**, one per panel, each serving its
   own built React frontend on localhost.
2. **PostgreSQL, not SQLite**, bundled via `embedded-postgres` (server
   binaries only). Fallbacks: `DATABASE_URL` or `ORDERBOOK_PG_BIN`.
3. **Knex** query layer; Knex types never leave `repositories/`.
4. **Custom UDP broadcast discovery** (not mDNS) with a manual IP/ID/password
   fallback (`docs/PROJECT_PLAN.md` §4).
5. **Orders are their own table**; conversion copies the lines and stamps
   `converted_order_id`. Reserve at conversion, dispatch moves stock;
   inventory is per variant. Text record ids with an `id_map` so an offline
   panel can mint before the Master has seen a record; ids inside a payload
   (`partyId`, `ownerId`, `productId`) are resolved through it too.
6. **Permissions are one JSONB array on the role**, capped by a tier ceiling
   (`office` / `management` / `admin`). scrypt hashes; `activity_log` is
   hash-chained and append-only.
7. **Clean architecture on the Master:** pure rules in `domain/`, services
   orchestrate, transport carries no policy.
8. **Configuration from `.env`** via `master/src/lib/env-file.ts`.
9. **Column map is one table** (`shared/src/domain/columns.ts`); `undefined` =
   not asserted, `null` = clear.
10. **Developer mode is a password, not a permission** (`docs/DEVELOPER_MODE.md`).
11. **Updates:** setup files published by `tools/release.mjs`; the Master
    serves the office build over the LAN. A standalone `.exe` is replaced by
    hand, never updated in place; a Linux AppImage is replaced in place by
    the shell; a `.deb` install is updated by installing the newer `.deb` by
    hand. Only `main` publishes a release.
12. **Product catalogue:** category → model (`products`) → variant
    (`product_variants`: code, colour/pattern label, weight). Lead entry is
    the Office panel's `AddLeadScreen`; the Master had no New lead page
    (**reversed by decisions 16 and 17** — the Master has Pending and Final Order
    modules, and from 2026-10-01 a New / Edit pending order form of its own).
    **Catalogue v2 (owner, 2026-09-28; `docs/catalogue/CATALOGUE_MODEL.md`)**
    maps the owner's Brand → Product → Sub product onto those tables without
    renaming them: a **Product** is a category, which gains a software
    `code` (alphanumeric, unique per tenant among live rows), a `brand` (an
    option value of `product.brand`; brand is read through the category and
    never copied onto `products`), a catalogue `sort_order` and a soft
    delete; a **Sub product** is a model with **exactly one variant**, its
    printed name on `products.name` and its software code `CODE-####` on the
    variant. The colour rule is **derived, not stored**: `multi_colour` →
    `selectable`; a labelled variant → `fixed` (the label is the colour);
    otherwise `dedicated` (no colour anywhere). The screens say Product and
    Sub product; the code keeps `category*` / `product*` / `variant*`.
13. **Accepted risks:** the Master's plaintext password vault (owner asked for
    it; keep the guards in `docs/overhaul/workstream-F.md`); no TLS on the LAN
    (the public API is off by default).
14. **The product restructure (owner, 2026-09-19):** seed the whole catalogue
    with weights blank (optional in storage, flagged *weight missing*, `> 0`
    when given — nobody invents a weight for a dispatch note); wipe the
    product-linked data on that install; hide the tile-only fields (the
    columns stay).
15. **The product trim (owner, 2026-09-21):** pricing removed whole — line and
    party-wise rates, totals, the switch, the rate permissions, money in
    reports. Custom fields stay on products. A multi-colour line picks its
    colour from the Settings colour list; the colour is a line attribute, not
    a stock key, and a colour missing from the list is never refused (an
    offline lead must still land). **Amended by catalogue v2 (2026-09-28):** the
    Master **coerces, never refuses** — a colour sent for a product that is
    not multi-colour is dropped (`colour = NULL`) instead of refused with
    `LineColourError`, so a queued lead cannot bounce on it; and **several
    colours of one sub product are several lines** on the same variant, one
    per colour with its own quantity (no schema change; the screens and the
    lead PDF group them as `White ×10, Ivory ×5`). Stock stays per variant.
    The two briefs that recorded these (`docs/ai-handoffs/product-model-variants.md`,
    `product-master-trim.md`) were deleted on 2026-09-25 as done; git history
    has them.

16. **The Master has Pending Orders and Final Orders modules (owner, 2026-10-01,
    parity plan P2).** The one `Leads & orders` screen is split into `leads`
    (`leads.view`) and `orders` (`orders.view`), each a list that searches on the
    server and pages 500 at a time, whose rows open as sub-screens with a back
    button and a nested sidebar entry; every action (stage, note, convert,
    dispatch, weight, delete, PDF, Filling/Dispatch note) moved from list rows into
    that record screen, and the Final Orders list lost its Products column (the
    Office's has none). The record bodies are `ui/src/LeadRecordView.tsx` and
    `ui/src/OrderRecordView.tsx`, ports of the Office's `LeadDetail` and
    `OrderDetailBody` — **the code exists twice until the Office is switched to
    the ports (owed)**, so a change to one must be made in the other. A control
    the role lacks is absent, not disabled.
17. **New / Edit pending order on the Master (owner, 2026-10-01, parity plan P3).**
    Decision 12's "the Master has no New lead page" is reversed. The form is
    `ui/src/LeadEntryScreen.tsx`, a near-verbatim port of the Office's
    `AddLeadScreen` behind a `LeadEntryTransport`; the Master mounts it through
    `master/web/src/screens/LeadEntry.tsx` as the nav-less `addLead` tab (topbar
    "New pending order", the `leads.new` sub-page, Ctrl+Shift+N — `record.new` is now
    `panel: 'both'`) and from "Edit pending order" on a lead that is not yet
    converted. Server: `PUT /api/leads/:id` (`leads.edit`) and `GET /api/lead-entry`
    (`buildLeadEntryView`: party-scoped records, option lists, stock only with
    `inventory.view`, all of the caller's grants, features; `leads.create` or
    `leads.edit`). Differences from the Office copy are listed in the port's header.

18. **The Master has the product catalogue (owner, 2026-10-01, parity plan P4).**
    Decision 12's "the Master edits the catalogue from Inventory" was false —
    Inventory only reads it — and `PANEL_ONLY.products` is gone. The Master's
    **Products** module (`products.view`, Alt+5 then, Alt+6 since 1.3 Phase 1, before Parties) has three
    sub-pages: Sub products, Products and Brands (always offered; without
    `fields.view` the page says so inside itself, as the Office does). The screens
    are `ui/src/SubProductsScreen.tsx`, `MainProductsScreen.tsx` (with
    `BrandsScreen`), `ProductDetail.tsx`, `ProductDrawer.tsx`, `ProductImages.tsx`,
    `ProductImportModal.tsx` and `catalogueSummary.ts` — ports of the Office's
    `CatalogScreen` / `MainProductsScreen` / ... behind one `CatalogueTransport`
    and `CatalogueView` (**the code exists twice until the Office is switched to
    the ports, owed**). `master/web/src/screens/ProductsScreen.tsx` loads the view
    (option lists, categories, every sub product via `GET /api/products?limit=2000`,
    free stock only with `inventory.view`) and mounts them. Controls are absent,
    not disabled: New (`products.create`), Edit and every photo control
    (`products.edit` — the Office leaves these ungated), Import (`products.bulk`).
    Sub-product delete is not offered, as on the Office, and `api.deleteProduct`
    is gone. Server: the import handlers are `productImportRoutes(actorOf)` — the
    panel path (`/api/panel/products/import…`) is unchanged, and
    `dataRoutes` mounts the same handlers for a session (the service checks
    `products.bulk`); `/uploads/images/:id/:variant` is mounted for the Master
    session, so `ProgressiveImage` shows photos; a photo upload with no file is a
    `ValidationError` (`validation.image.fileRequired`). The edit form of a lead
    now gets `products` in `GET /api/lead-entry` (with `products.view`), so a
    multicolour line reopens as multicolour. No filter chip for a missing weight
    (the Office has none).

## Owed work

**Owner decisions** (blocking a customer release — `docs/PRODUCTION_READINESS.md` §5):

1. What happens to any machine still on 1.0.3: updating to 1.2.0 runs the
   variant and trim migrations, which lose its products, leads and orders. The
   automatic pre-update copy keeps the old cluster; nothing brings the rows
   forward.
2. Create the release signing key (`npm run release:keygen`) and the
   `RELEASE_KEY` secret; until then no installed panel offers an update by
   itself.
3. Buy a code-signing certificate, or accept the SmartScreen warning.
4. The Recycle Bin has no exit — three options in
   `docs/ai-handoffs/recycle-bin-delete-actions-and-purge.md`. Do not
   implement one until the owner picks.
5. Whether to harden the uninstall scripts (`tools/uninstall/`): *Uninstall,
   delete data* removes the folder the shell's pointer names, whole
   (`Remove-Item -Recurse` / `rm -rf`). Deleting only a panel's own entries
   from a relocated folder would also cover the Master's first-run chooser,
   so it was left to the owner. The Office storage move now refuses a drive
   root, a home folder and a folder holding anything that is not a panel's
   own, which closes the path the audit found.

**Owner-only** — a cloud session cannot do these: its git proxy refuses
branch deletion and tag pushes (HTTP 403), and the last needs real Macs:

1. Delete the twelve old branches on GitHub (listed under "Branch
   consolidation").
2. **Rebuild the v1.2.0 draft before publishing it.** Its Linux files were
   built before the library-link fix (they carry absolute links into the
   build machine and cannot start PostgreSQL elsewhere) and it has no macOS
   files. Delete the draft `v1.2.0` release on GitHub, then run the Release
   workflow on `main` with *publish* ticked.
3. **Launch the macOS app on real hardware** — it has been built, never run.
   CI produces the universal `.dmg`, unsigned (electron-builder 25 has no
   ad-hoc fallback, so without an identity nothing is signed and a
   downloaded copy needs a right-click Open). Launch it on an Intel and an
   Apple silicon Mac: first boot must create the database, and a product
   photo upload exercises `sharp`.
4. **Windows 7 acceptance on real PCs** (1.3 Phase 0, `docs/WINDOWS7.md`).
   On a 64-bit and a 32-bit Windows 7 SP1 PC: install the Win7 Setup, pair
   with a Windows 10 Master, create a pending order online and offline,
   print an order note, update over the LAN to the next build, uninstall with
   and without keeping data, and open the
   Master UI in Chrome 109. That uninstall is also the first run of
   `tools/uninstall/uninstall-orderbook.ps1` on PowerShell 2.0 (only its
   constructs are tested here). The `wmic` free-disk fallback in
   `office/src/config/paths.ts` has unit tests, and the smoke requires a
   number from it wherever `wmic` exists (the CI runner; this PC has none);
   a Win7 PC is its first real run on real hardware.
5. **First GitHub runs of the Win7 jobs:** the `legacy-runtime` job in
   `ci.yml` and the `win7` leg of `release.yml` have not run on GitHub yet.

**Code** — the queue is `docs/ai-handoffs/README.md`:

1. **Product photos: no full-size view, and an offline upload's raw error.**
   The product screen does show the cover photo now (`ProductImages` on
   `ProductDetail.tsx`, the `large` size) and the photo UI is translated, but
   nothing opens a photo full size, so the 2048 px `master` size is still
   requested by nothing. An upload while the Master is unreachable answers the
   raw Node error text with no `messageKey` (`office/src/http/app.ts`, the
   `/api/products/:productId/images` route), and its "Choose an image file" is
   English only. Brief: `office-product-image-flow.md` §2 and §4.
2. **No route from a party to its access editor** (the owner's "no option for
   assign party").
3. **Password-change tail:** `invalidateSessionsForUser` records no reason, and
   Reset password has no self-exclusion warning.
4. ~~**Master-side New lead**~~ — **done 2026-10-01** (decision 17). What it
   left: **two copies of the lead form** — `office/web/src/screens/AddLeadScreen.tsx`
   and `ui/src/LeadEntryScreen.tsx` — until the Office is switched to the `ui`
   one, so a change to either must be made in both (`ui/tests/packaging-switch-reach.test.ts`
   reads both). The Master's edit form is given no `products`, so a multicolour
   line saved with no colour chosen re-opens as fixed or dedicated, not
   multicolour; add `products` to `buildLeadEntryView` if that matters.
5. **Offline product + lead in one session:** a lead line needs a variant id,
   which a panel cannot know for a product the Master has not created yet, so
   a lead cannot reference a product created offline in the same session. The
   temporary-`productId` remap in `sync.service.ts` is kept for when variants
   get temporary ids.
6. **Weights:** the catalogue's 549 variants have none; the Office
   Catalogue's *Missing weight* filter is the worklist.
7. **Real-Electron check of the 1.3 H3 print work** (Electron 33 and the legacy
   22), on a PC with a real printer, none of which `verify` can see: the
   Copies field printing N collated sets (some drivers ignore `copies`; the
   fallback is calling `print` N times), `Save PDF` (A4, no margins, the Save
   dialog, the file opens), a pending order's note printing exactly one note
   with a second note screen open behind it (the `ob-printing` CSS rule), and
   the report PDF window (a Preview PDF click opening the 960x900 viewer
   window, and how a 503 from an offline Office reads in it).

**Found by the 2026-09-24/25 audit and not fixed.** Each was confirmed by
reading the code, not in a running app. Every defect the 2026-09-22 structure
audit listed here is fixed (see "Session history").

*Server and data:*

1. **Dispatch keys on the stage named `Dispatched`**
   (`order.service.ts#dispatchOrder`), so a stage renamed on the Fields
   screen leaves a dispatched order where it was. Nothing on
   `pipeline_stages` says which stage means dispatched (`is_terminal` is also
   true of Cancelled); the fix needs a stage flag added by an add-only
   migration, a way to set it, and the owner's input.
2. **`deleteOrder` can race a dispatch:** it checks `dispatchedAt` on a read
   before its transaction and does not lock the row, so an order dispatched
   in between can still be deleted.
3. **`party_code` truncates from the 10,000th party:** `lpad(…, 4, '0')` cuts
   as well as pads, so the code repeats an earlier one (`P-1000` again) and
   the insert fails while that party is live (`docs/schema/02-parties-and-products.md`).
4. **No index on `leads.owner_id` or `orders.owner_id`:**
   `20260303000000_roles_and_users` re-created the columns as TEXT, which took
   both indexes with it (`docs/schema/03-leads-orders-inventory.md`). Needs an add-only migration.
5. ~~**The public API's tenant cache is stale after a whole restore.**~~
   **Closed 2026-10-03 (1.3 Phase 8):** the v1 restore, the archive restore and
   Developer mode's erase all call `resetProcessCaches()`
   (`master/src/services/process-caches.ts`), which includes
   `resetPublicApiTenantCache()`.
6. **The wipe/reload CLIs stop the database they start**
   (`catalog-reload-cli.ts`; `seed-catalogue-cli.ts` does the same), which
   pulls it out from under a running Master unless `DATABASE_URL` is set.
   The first one's header says to run it with the Master stopped. Since
   catalogue v2 `reload:catalog` checks — it refuses while any other client
   is connected — but `wipe:business`, `seed:parties`, `seed:demo-parties`
   and `seed:catalogue` still do not.
7. **22 of the 84 client→server socket events have no caller** in
   `office/src`; the Master still registers handlers for them
   (`docs/STRUCTURE.md` lists them).
8. *Observation:* a `partyVariant.upsert`'s temporary id never reaches
   `id_map`.

*Office Panel and desktop shell:*

9. **Work may be stranded after an early storage move.** An Office panel
   that moved its storage before this round came back up in the old folder,
   so anything saved after the move sits in the move target.
10. **After a storage move the shell's log stays in the old folder** until
    the app is relaunched. Every "where is the log" answer names that file
    (`openLogPath()`), so nothing points at the wrong one.
11. **A transient outbox read at flush time:** a flush that meets a moment's
    read error (`load()` in `office/src/sync/outbox.store.ts`) sees an empty
    queue and sends nothing that pass. A save refuses in the same case. A
    queue that reads but is not a list (corrupt, not just busy for a
    moment) is set aside beside `outbox.json` as
    `outbox.json.unreadable-<time>`, and the log names it: look there for
    queued work that never reached the Master.
12. **The Updates screen has no "fetching" reason.** While the Master
    fetches the build for a panel's OS, the panel is told "nothing new yet"
    (`docs/UPDATES.md`, "When a new build shows up").
13. **Clean Install runs a `.deb` as if it were an AppImage.** It accepts one
    as a Linux setup file (`EXTENSIONS` in `electron/lib/cleaner/setup-file.ts`,
    the file dialog in `electron/cleaner.main.ts`) but can never verify it,
    since no manifest names a `.deb`; and on Linux `cleaner:install` spawns
    the chosen file directly, which does not install a package (that takes
    `apt install ./<file>`).

*Master UI:*

14. **AccessScreen's RoleEditor asks with `window.confirm`** before
    discarding an edit, not the themed ConfirmDialog.
15. **The Master keeps drawing a screen after the person's permission for it
    is revoked.** `ScreenHost` draws the tab whatever the sidebar offers; only
    navigation checks. Sign-out and an ended session do reset to the
    Dashboard.

*Stale text:*

16. Two stale comments. `master/src/services/inventory.service.ts:179` says
    `isBlankNote` is shared with both panels' forms: only this service calls
    it (the Master's Inventory form makes its own `trim()` test, and the
    Office has no stock-correction form). The `electron/preload.cts` header
    says the shell refuses anything outside "that panel's updates folder":
    the Master's installer comes from its releases folder
    (`releaseDirFor('master')`), and an AppImage is replaced, not run.

*Found by the 2026-09-25 leftover cleanup (none is a defect today):*

17. **`ROLE_TEMPLATES`** (`shared/src/domain/permissions.ts`) are defined and
    their `roleTemplate.*` names translated, but no screen offers them when a
    role is created. Wire them into the role editor or drop them.
18. ~~**`signIn.notice.passwordChanged` is never sent**~~ — wired 2026-10-01
    (parity plan P5): `ChangePasswordDialog` calls
    `publishSessionEnded('signIn.notice.passwordChanged')` after a successful change, so
    the window lands on sign-in saying why.
19. **`fontkit` is a Master runtime dependency used only by
    `master/tests/pdf-fonts.test.ts`** (PDFKit brings its own); it could move to
    `devDependencies`.
20. **The `ai_runs` table and stored `ai.*` role keys remain** from the removed
    assistant. Migrations only add, so taking them out is the owner's decision.
21. **The sample data's `creditDays` party field is payment terms** — money by
    another name. Kept on purpose; whether it stays is the owner's call.

Deliberate, not defects: three kinds of audit entry are still written after
the fact (`recordDetachedActivity` in `activity-log.repository.ts` says why).
A sign-in attempt, accepted ones included, although an accepted one stamps
`last_sign_in` in a transaction it could join: joining would make signing
in fail whenever the trail cannot be written. A connector run, whose one
entry sums up many transactions. And a panel's reissued secret or moved
storage folder, which has already happened on the panel's machine.

**Manual:**

- **Catalogue v2 in Electron:** the Preview PDF window (`electron/lib/lead-pdf.ts`)
  has only been exercised by its unit test; the browser pass on 2026-09-29
  read the PDF's bytes, not the window. Also look at the Master's Leads
  table at 1366 px: the Preview PDF button widens the actions column and
  the Party and Products columns are cut short — which columns give way is
  the owner's call.
- A browser and Electron pass of both panels on 1.2.0. Since the
  consolidation only the Settings permission change and the Socket.IO
  Origin check (both in `d7481f7`'s run against a live Master) have been
  exercised in a real Electron window; the jsdom shell tests cover
  navigation and forms, not layout.
- An install / update / uninstall rehearsal on a real Windows PC, and a run of
  the standalone `.exe` (`docs/PRODUCTION_READINESS.md` §2 item 4).
- **An AppImage update end to end on a real Linux PC:** download, verify,
  replace, relaunch, including a copy started with
  `--appimage-extract-and-run`. Only unit tests have run it so far.
- Responsive gate: 1024×768 / 1366×768 / 1920×1080 / 3840×2160 at 79 % /
  100 % / 157 %, sidebar in all three modes.

Open questions still unanswered by the owner: extra party fields (credit
terms, multiple contacts); concurrent edits of one lead from two panels
(last-write-wins is the default); app name/branding.

## Traps worth knowing

- **The backup-everything zip is not encrypted.** It holds password hashes, the
  pairing password hash and every Office panel's secret and master proof key
  (`docs/7-STORAGE-BACKUP-RESTORE.md` §3.4). Do not add a table to it without
  asking whether it belongs on a USB drive; the excluded ones are in
  `EXCLUDED_TABLES` (`backup.repository.ts`), and the streaming and loading
  functions refuse them outright.
- **A restore signs everyone out, the window that started it included.** While
  it runs every `/api/*` call answers 503 `error.unavailable.maintenance`; only
  `/api/health` and `/api/setup/archive/job` get through, so a screen following
  a restore must poll the setup route (`useBackupJob` in `BackupAllSection` and
  `FirstRunScreen` does). After it, the Settings screen reloads into sign-in.

- **Presence is never logged and never goes through `publishChange`.** It lives
  in the Master's memory (`master/src/realtime/presence-store.ts`) and is pushed
  only as `presence:changed` through `emitToActors`. Routing it through the change
  bus would put heartbeats in the change ring, the activity chain and every
  panel's delta. A Master restart forgets it; the next beat rebuilds it.
- **`po:%` counters survive the reload CLI.** `wipe:business` (and
  `seed:parties`) reset the per-entity `id_sequences` rows by name and never the
  `po:<fy>` rows, so a PO number once printed is never handed out again;
  `reload:catalog` touches no counter. Only a developer factory reset, which
  drops the schema, starts the series again. A new per-entity counter added to
  that list must not be a `LIKE` over `id_sequences`.
- **The lead form exists twice and both copies send only what changed.**
  `ui/src/LeadEntryScreen.tsx` (Master) and `office/web/src/screens/AddLeadScreen.tsx`
  (Office) both go through `ui/src/LeadStaleEdit.tsx`. Sending the whole record
  again would make every edit a stale-edit 409 on the Master, or a conflict on the
  Office, the moment anyone else touched any field.
- **A final order has no PO number of its own.** The order query reads
  `ld.po_number` through the lead; there is no `orders.po_number` to keep in step.
- **`PRESENCE_TAB_ID` comes from `crypto.getRandomValues`.** `crypto.randomUUID`
  is undefined over plain LAN http, which is how both panels are usually opened.

- **Rediscovery needs one connect after the 1.3 update.** An Office whose
  Master moved to another address finds it only if that panel has connected to
  the Master at least once since the update: `authenticatePanel` fills
  `office_panels.master_proof_key` then, and until it is filled
  `POST /api/panel/prove` answers 404 and the Office stays with the saved
  address. A panel paired after the update has the key from pairing.
- **`master_proof_key` is left out of the `.obbackup` export** (`dumpTable` in
  `backup.repository.ts`), since that restore revokes every panel. The Phase 8
  archive keeps pairing, so its export must carry the column, or Offices cannot
  rediscover a restored Master. This differs from the plan's migration row 2a,
  which has been updated.
- **Heartbeat timings are constants, not settings.** The hub pings every 4 s and
  drops a socket silent for 6 s more (`master/src/realtime/hub.ts`), so a dead
  link shows within about 10 s and a stall up to that long is tolerated. The
  Office reconnects after 1 s growing to 5 s (±50 %), retries a refused handshake
  from 5 s doubling to 60 s, polls the network every 2 s, and looks for a moved
  Master after 3 failures at most once a minute. Lowering the 6 s timeout makes
  a busy Master drop healthy panels.
- **The shell tests must answer `/api/notifications`.** Both panels' `api.ts`
  share one in-flight GET per path for the whole test file, and the harness
  leaves an unanswered request pending for ever, so one test's unanswered bell
  read swallows every later test's (`ui/tests/office-shell.test.tsx` and
  `master-shell.test.tsx` answer it in `boot`).

- **Every grant migration after `20261001000000_server_master_tier` grants to
  `tier IN ('admin', 'server_master')`**, with a frozen inline permission list.
  The Server Master role must hold every permission there is; a grant that
  names only `admin` leaves it short, and only the `allPermissions()` check in
  `master/tests/server-master.integration.test.ts` notices.
- **`npm audit fix` will try to move undici off 5.29.0. Don't let it.** The
  Windows 7 Office build runs on Node 16, and every undici from 6.0 on needs
  Node 18, so the bump breaks that build's `fetch`. The audit's "high" for
  undici is a recorded, accepted risk (`docs/WINDOWS7.md` § Limits).
  `office/tests/legacy-compat.test.ts` fails on a bump.
- **`npm run build:shell:legacy` and `npm run release -- --os win7` leave a
  CommonJS shell in `office/electron/dist`** with a `{"type":"commonjs"}`
  marker. `npm run build:shell` (or `npm run build`) puts the normal ESM shell
  back; run it before starting the Office from source on Electron 33.
  (`smoke:legacy` puts it back by itself.)
- **Typecheck does not hold the floors for ES2022 and older APIs.** `lib`
  ES2022 makes only ES2023+ builtins a type error; a Node or DOM API newer
  than Node 16.17 or Chromium 108 has to be listed in the `eslint.config.js`
  floor blocks.
- **On the owner's PC the bundled `pg_ctl.exe` cannot start the test cluster**
  ("Access is denied", seen 2026-10-02 from a Claude Code session), so every
  `*.integration.test.ts` fails in `beforeAll` with `pg_ctl start exited with 1`.
  The system PostgreSQL 17 install works: run the suite as
  `$env:ORDERBOOK_PG_BIN='C:\Program Files\PostgreSQL\17\bin'; npm run test`.
- **An integration suite that skips is not a suite that passed.** As root
  every integration file skips and the summary reads green. Check the count.
- **Release-test fixtures publish for the host platform.** `updates.test.ts`
  publishes each fixture for `process.platform` unless the test is about
  platform; `github-releases.test.ts` pins `win32` for its duration. Either
  way a fixture's OS must match the platform the code under test defaults to,
  or a test fails off Windows or passes without reaching its check.
- **An optional `CompanyFeatures` field left unresolved typechecks cleanly.**
  `master/tests/company-features-complete.test.ts` is the only catcher. Use
  `??`, never `||` — several switches default to `true`.
- **An update used to be a full record replace** and nulled every column the
  form did not show. `columnPatch()` emits only asserted keys
  (`partial-patch.integration.test.ts`).
- **Both panels shared one Electron single-instance lock when run from
  source.** `app.setName()` must run before `requestSingleInstanceLock()`.
- **On Windows `child.kill('SIGTERM')` is `TerminateProcess`.** The shell sends
  `{type:'orderbook:shutdown'}` over the IPC stdio slot and waits.
- **A child that inherits your pipes never lets `execFile` resolve.** Spawn
  `pg_ctl` with `stdio: 'ignore'` and wait for `exit`.
- **`shared/` and both `web/dist` are build artefacts.** The `prepare` and
  `pre*` scripts exist so a clean checkout works.
- **Two branches once minted the same migration timestamp;** deleting one
  locked every database that had run it. Keep both, make both idempotent.
- **It happened again with a name, not a timestamp (2026-09-29).** The stale
  `catalogue-v2-stale` checkout ran `20260323000000_catalogue_brands_and_codes`
  on the owner's PC database; Knex refuses to boot a database whose
  `knex_migrations` names a migration the registry lacks ("The migration
  directory is corrupt"). Its real body cannot come across either: it
  touches `products.colour_policy`, which 1.2's `product_variants` drops, so
  every 1.2.0 installation would fail on it. So main keeps the **name as a
  no-op** (registered beside `product_variants`, the `panel_app_version`
  precedent) and **`20260326000000_catalogue_brands_and_codes_port` does the
  work**, every statement `IF NOT EXISTS`, pinned last in
  `DELIBERATELY_LAST`: a fresh, a 1.2.0 and the stale database all end on the
  same schema. Do not "tidy" the stub away.
- **And once more with a body (found 2026-09-29).** Three migrations have two
  bodies in history under one name (`20260301`, `20260306`, `20260312`; the
  August line merged in as `c9091c7`/`e16dcca`/`a363adf`). Only `20260306`'s
  differ in schema: the older body never added `option_lists.created_by` /
  `updated_by` and its hex check refused uppercase. The owner's PC database
  ran that one, and its first `reload:catalog` on 1.2 failed on `column
  "created_by" of relation "option_lists" does not exist`.
  `20260327000000_option_lists_repair` (additive, idempotent, pinned last)
  brings both shapes level. Before trusting that two databases share a
  schema because they share `knex_migrations`, compare the bodies:
  `git log --all --format=%h -- <migration>` then `git rev-parse <c>:<path>`.
- **A migration must never import a live shared constant.** Inline what it
  writes.
- **`20260325000000_line_item_grade` is registered after the trim** (and in
  `DELIBERATELY_LAST`), because the trim drops `line_items.grade`; in
  timestamp order a fresh database would gain the column and lose it.
- **`master/tests/i18n-tokens.test.ts` is load-bearing:** every
  `(entityType, action)` given to `recordActivity` needs an
  `activity.<entity>.<action>` string.
- **An audit entry is the last statement of its change's transaction.** A
  write stamps the clock (`nextHlc`) first, then takes its row locks, then
  calls `recordActivity(…, trx)`; the chain trigger's per-tenant advisory
  lock is taken last, so its holder only ever waits to commit. The other
  order deadlocks (`40P01`): `party-access#replaceAssignments` did.
  `master/tests/audit-atomicity.integration.test.ts` fails an entry moved
  ahead of its row write. `recordDetachedActivity` is only for the three
  kinds its comment names; it swallows a failed insert.
- **electron-builder runs `npm install --omit=dev`** and prunes the root
  `node_modules`; both `electron-builder.yml` set `npmRebuild: false`.
- **`fs.cp` rewrites a relative symlink as an absolute one** unless given
  `verbatimSymlinks: true`. PostgreSQL's `native/lib` is mostly SONAME links,
  so every packaged Master once carried links into the build machine's
  `node_modules`: it worked where it was built and nowhere else. Both copies
  in `tools/release.mjs` now keep links verbatim, and `assertUsablePostgres`
  checks every link in `pg-symlinks.json` resolves.
- **A build output folder keeps the last build.** Match the exact filename and
  clear the folder first. macOS `universal` needs both architectures'
  PostgreSQL vendored (`extraResources` is identical in both halves).
- **`npm run release` refuses a Windows or Linux Master build on a machine
  that is not x64** (`assertHostArch()` in `tools/release.mjs`): staging
  copies the build machine's own `sharp` and PostgreSQL into the Master. The
  Office panel and Clean Install carry nothing native and build their x64
  files anywhere; a Mac build is universal and is never refused.
- **One manifest, three names.** A GitHub release carries
  `latest-<panel>.json` (Windows) and `latest-<panel>-<platform>.json`
  (`manifestAsset()`); in a releases folder the same file is
  `latest-<platform>.json`, plus `latest.json` for a Windows build only (the
  one name older panels read). `readManifest` prefers the platform name, so
  a writer that leaves it out leaves the folder on a stale manifest. Each
  OS's sync sweeps only that OS's files, so one folder holds every OS's
  build.
- **A Linux AppImage is the running program, not an installer.** The
  Master's releases-folder sweep spares the file `APPIMAGE` names (compared
  by real path) as well as every pinned build; the shell trusts `APPIMAGE`
  only when its own executable runs inside `APPDIR`; the relaunch puts
  `--appimage-extract-and-run` back first when the old copy was started
  that way. `electron/tests/appimage.test.ts` skips its replace block on
  Windows (it needs POSIX file semantics), so the owner's `npm run verify`
  never runs it; CI (ubuntu-latest) does.
- **Node on Windows opens files sharing delete**, so removing a file that is
  being written or streamed succeeds on every OS. A sweep that relies on
  Windows locking it is wrong; pin what must survive.
- **The file that records where the data lives must not live in the data.**
- **An Office storage move rewrites the shell's pointer.** Under the desktop
  shell the next start reads `office-location.json`, not the settings file,
  so `relocateDataDir()` writes the pointer named by
  `ORDERBOOK_OFFICE_LOCATION_FILE`, which only `officeServerEnv`
  (`electron/lib/office-env.ts`) passes. Drop that line and every other
  server test stays green; `electron/tests/office-env.test.ts` and
  `office/tests/storage-path.test.ts` (which starts the server with
  `officeServerEnv`) catch it.
  *Uninstall, delete data* removes the pointer's folder whole, so a move
  refuses a drive root, the home folder and a folder holding anything that is
  not a panel's own. The shell's log stays where it was opened until the next
  launch: name it with `openLogPath()`, not `logPath()`
  (`electron/tests/shell-log.test.ts`).
- **A `serverEnv` variable its server never reads fails the build**
  (`electron/tests/server-env.test.ts`).
- **Party access has many read paths** — `grep applyPartyScope` /
  `grep partyScopeSql` before adding a scoped entity.
- **The last-administrator guard runs inside the transaction.**
- **An Office panel's acting user is resolved per command**, never per
  connection. Offline sign-in is reachable only when the Master could not be
  asked, and only while `security.offlineSignInEnabled` is on.
- **An Office queued write checks its shape in `queue()`'s `validate`
  step** (`office/src/http/app.ts`), which runs after the permission check.
  A shape check placed ahead of `queue()` answers a caller without the
  permission with a 400 that describes a well-formed payload.
- **`UNION ALL` branches must cast to one type** (`id::text`).
- **`request()`'s in-flight GET dedupe is keyed on path + headers.**
- **Shift+letter chords never reach the command registry while typing.**
- **The palette lists only what `offers()` says.** `KeyboardProvider`'s
  `offersCommand` answers in the same order `runCommand` does: palette and
  help commands, then a mounted registration, then a nav command only if the
  panel's `canNavigate` (the sidebar's own test) says yes, then a shell
  command only if the panel supplies one. A command `runCommand` learns to
  answer needs the same branch in `offersCommand`, or the palette hides it.
  `view.find` is left out on purpose: only the chord answers it.
- **The sidebars and `MASTER_NAV`/`OFFICE_NAV` must agree**
  (`shared/src/keys/commands.ts`; `shared/tests/keys-nav-order.test.ts` reads
  both `App.tsx` `const groups: NavGroup[] = [ … ].map((group)` literals). A
  row that leaves its chord out takes the next free digit, so a new row of that
  kind moves every Alt+N below it; say so in the release notes. Give a new
  module `null` (no chord) or an explicit chord unless it should take a digit.
- **Basic Home builds its tiles from the sidebar groups** (`ui/src/BasicHome.tsx`).
  A module with no sidebar row has no tile; there is no separate tile list to
  keep in step. On the Office it sits in `alwaysAvailable`, because it must
  draw before the first snapshot. Landing (`landingScreen(tier)`) is set on the
  boot restore and at sign-in only; setting it in `refreshSession`, which runs on
  every reconnect, would throw people back to Basic Home whenever the link
  blinked.
- **Lazy screens need `findBy` in the shell tests.** Since 1.3 Phase 1 some
  screens load on first visit (`lazyScreen` in `ui/src/ScreenHost.tsx`), so
  their text is not on screen in the same tick as the click. A lazy screen must
  not be imported statically anywhere else in its panel, or the chunk never
  splits: that is why `settingsTabs.ts` exists on both panels and
  `optionListTransport` moved to the Master's `transports.ts`.
- **Socket.IO has no CORS; the handshake checks the Origin.**
  `isAllowedSocketOrigin` (`master/src/realtime/socket-origin.ts`) admits no
  Origin (an Office server in Node) or a page served from exactly the Host it
  connected to. A page on another port of the same machine is refused and
  logged; in development go through the Vite proxy.
- **`requirePanel` runs once, at the `/api/panel` mount** in
  `master/src/http/app.ts`. A router mounted there must not `.use` it again:
  a router's `.use` runs for every request that enters it, so the request
  pays the bcrypt compare twice. Under `/api/updates`, which the Master's own
  Updates screen shares, it sits on each panel route instead, never on the
  router.
- **jsdom cannot test visibility** (`checkVisibility` is undefined).
- **A shell test must wait until the panel is listening.** A panel opens its
  event stream, its Socket.IO link, the desktop-menu subscription and its
  key listener in effects, which React may not have run when the shell is
  first on screen; an event or chord sent then reaches nobody. Send through
  the helpers that wait: `sendSnapshot()` (`office-shell.test.tsx`),
  `changed()` (`master-shell.test.tsx`) and `pressAltDigitUntil()`
  (`panel-harness.ts`). A test that expects a chord to be refused opens a
  screen with a chord first, or it passes without the chord reaching the
  panel. The first test to open a screen also pays for compiling it, which
  under a full run outlasts `findBy`'s one-second default.
- **`ui/tests/panel-harness.ts` imports each `App.tsx` through a variable
  path** on purpose: a literal import pulls both web apps into
  `ui/tests/tsconfig.json`'s stricter program and fails the typecheck for
  reasons that belong to their own `tsc -b`.
- **A token minted as `obk_<base64url>_<base64url>` split on `_`.** The
  prefix is hex; `parseToken` rejoins everything after the second separator.

## Session history

Condensed. The full entries are in `git show 5b8ebe2:HANDOFF.md` and in
`docs/AI_COLLABORATION.md`.

- **2026-10-03 — 1.4 D1 (helper): app updates end to end, no menu bar.** No menu bar
  on Windows/Linux (macOS keeps Quit/Edit/Window); Check now, a download bar,
  `update.available` / `update.installing` notices, Save all + sign out + silent
  `--force-run` install, a blocking "Update needed" screen on an Office behind its
  Master, and the Master's nightly update (23:00, copy of the data first). Poll is
  2 min, release listing cached with an etag. The unattended install declines
  rather than raise a UAC prompt nobody can answer: open owner question (D1 log).
  See `docs/UPDATES.md` "1.4".

- **2026-10-03 — 1.3 Phase 8: back up everything to a drive, Magic restore,
  automatic backup (Claude).** Migration `20261007000000_backup_all_permission_grant`
  (additive: `storage.backupAll` to the Server Master role, and taken off every
  other role, since the `20260303000000` live-catalogue seed gives it to
  Administrator; UPDATE only). Packages `archiver`
  and `yauzl` (Master, shipped). Shared: archive types in `protocol/backup.ts`,
  `storage.backupAll` (Server Master tier), `chooseFile` and
  `chooseDirectory({title})` on the bridge, `backup.autoSkipped` /
  `backup.autoFailed`. Master: `domain/archive.ts`, `lib/archive-zip.ts`,
  `backup-job.ts` (one job, maintenance), `maintenance-gate.ts`, `process-caches.ts`
  (closes known defect 5), `BOOT_ID` renewed on reset, `archive-export.service.ts`,
  `archive-restore.service.ts`, `backup-scheduler.ts`, the `/api/storage/archive*`,
  `/api/storage/auto-backup` and `/api/setup/archive/*` routes. Electron:
  `orderbook:chooseFile`, and a main-window sender check on `chooseDirectory`.
  Web: Settings › Storage & backup (`BackupAllSection`, `AutoBackupSection`), the
  first-run **Magic restore** fork, the v1 fork renamed "Restore an encrypted
  backup (.obbackup)". Docs: new `docs/7-STORAGE-BACKUP-RESTORE.md` (cited by the
  code, missing until now), `STRUCTURE.md` §1.5, §3.6, §5, §6.2, §7, §10.1,
  §11.8. **Not done:** a real run onto USB drives (FAT32, exFAT, NTFS) and a Magic
  restore on a second PC; the browser and Electron pass of the new screens.

- **2026-10-03 — 1.3 Phase 4: PO numbers (rule 2), presence (rule 3), stale-edit
  protection, Master authority (Claude).** Migration
  `20261003000000_pending_order_numbers` (additive: `leads.po_number`, UPDATE-only
  backfill per financial year, partial unique index, `po:<fy>` counters). Shared:
  `pending-order-number.ts`, `protocol/presence.ts`, `Lead`/`Order.poNumber?`,
  `baseFieldHlc?` on lead and order updates, `MutationResult.number?`,
  `DataChangedEvent.actorUserId?/actorName?`, `sameLines` moved into `merge.ts`,
  `lead.numbered`, `PANEL_PROTOCOL_VERSION = 4`. Master: the number minted in
  `createLead`'s transaction (`nextInSeries`), 409 `error.conflict.staleEdit` on
  `updateLead`/`updateOrder`, `actorStamp`, the `lead.numbered` notice, the v1
  restore back-numbering, `owners[]` on the lead-entry view,
  `presence-store.ts`/`presence.service.ts`, `presence:beat`/`presence:changed`,
  `POST /api/presence`. Office: `awaitSettled`/`onNumbered`, the 5 s number wait on
  `POST /api/leads`, `baseFieldHlc` out of queued `PUT`s, `POST /api/presence`, SSE
  `presence` and `numbered`. ui and web: `RecordNumber`, `AvatarStack`,
  `useRecordPresence`, `LeadStaleEdit` (changed fields, `StaleEditNotice`), the
  Owner picker, numbers on every list, header, toast, note, search hit, Dashboard
  and log row, an Order ref column, avatars in the lead and order headers, the bell
  opening a numbered lead. Docs: `LEAD_GENERATION_FLOW.md` §4 and §7, the API
  contract §14, `docs/schema/03` and `06`, `STRUCTURE.md`.
  The `lead.numbered` notice goes out when the save's HLC predates the pushing
  socket's connect (not "older than 60 s by the Master's clock", which a slow
  Office clock tripped on live saves), and only to an author who could open the
  lead now (`leads.view` and party access); the panel-named author proves
  nothing. A queued Office lead edit stamps its fields' clocks on the Office
  view, so a second edit before the first is acknowledged is not a conflict.
  **Not done:** the compact `AvatarStack` on board cards. The Master pushes
  presence only to people on a record, so a board has nothing to show; the
  unused `compact` prop was removed, and a board needs a per-record presence
  feed first (owner to confirm dropping it). Also not done: a browser and
  Electron walk of the avatars, the Provisional pill and the stale-edit notice.

- **2026-10-03 — 1.3 Phase 3: realtime rules 1, 5 and 6, push gate, stage HLC,
  notification centre (Claude).** Migrations `20261002000000_user_notifications`
  and `20261002000001_office_panel_master_proof` (both additive). Shared:
  `notifications.ts` (`NOTIFICATION_KINDS`, `LONG_OFFLINE_MS`, `isLongOffline`),
  `compareForIdAssignment`'s mutation-id tie-break, `baseForUnversionedEdit`,
  `PANEL_PROTOCOL_VERSION = 3`, handshake `actingUserToken`, the notification
  commands and push, the rediscovery proof types, `DesktopBridge.notify`. Master:
  hub heartbeat 4 s / 6 s, refusal codes, stale-socket close and the presence
  race, one snapshot on reconnect, `emitToActors`; `push-gate.ts` (100 ms / 6 s /
  5 s gather, coalescing, one mutation at a time, pool stays 10); stale offline
  stage moves become `stageId` conflicts; `notification.repository.ts` and
  `.service.ts` with the pruner; `/api/notifications`, `POST /api/panel/prove`;
  long-offline notices to `panels.manage` holders. Office: reconnect and refusal
  rules, credentials cleared only by its own Master's revoke, `catchingUp`,
  `disconnectedSince`, `clockSkewMs`, the 2 s network poll, `retryNow`, proven
  rediscovery, `broadcastForUser`. Electron: `lib/attention.ts`,
  `orderbook:notify`, `appUserModelId`. ui and web: `NotificationBell`,
  `formatElapsed`, the `bell` icon; the Office's Catching up label, offline-since
  row, hour-offline banner with one desktop notice per episode, clock and
  not-recognised banners, `streamEpoch`; the Office Dashboard's Sync card follows
  the footer; the Master's reconnecting state, reconnect after a server
  disconnect, `'*'` revision, "Offline for" and "Update needed" chips and the
  "Offline over an hour" tile. Docs: `LEAD_GENERATION_FLOW.md` §4 and §7,
  `docs/schema/01-identity-and-network.md`, `STRUCTURE.md`, the API contract.
  **Not done:** a browser or Electron walk of the bell, the banners and the
  Windows notification (the toast needs an installed build, whose shortcut
  carries the app id); `markRead` does not push to the same person's other
  sockets, so a second panel's count catches up on its next read.

- **2026-10-03 — 1.3 Phase 2: Server Master tier, master key, protocol
  handshake, complete audit (rule 4), Logs on Office (Claude).** Migration
  `20261001000000_server_master_tier` (adds the tier and one frozen `is_system`
  Server Master role per company). Shared: `ROLE_TIERS` gains `server_master`,
  `master-key.ts`, `DUMMY_SERVER_MASTERS`, `PANEL_PROTOCOL_VERSION = 2`,
  `COMMAND_MIN_PROTOCOL`, `auth:offlineEvents`, `activityDetail.*` rendering, and
  the `tier.*`, `masterKey.*`, `logs.entity.*`/`logs.action.*` and new
  `activity.*` strings. Master: first run makes two Server
  Masters and no admin; `requireLoopback` on setup and the new
  `/api/master-key/*`; loopback-only Server Master sign-in and sessions; the
  target-tier and two-Server-Master guards; master-key tokens on Server Master
  account changes; `POST /api/setup/pairing-password`; the audit sweep (every gap
  in rule 4) and the CSV's `sentence`/`details` columns; `actor.tier` on log
  rows; snapshots and deltas carry `protocol`. Office: never remembers a Server
  Master, uploads offline sign-ins on reconnect, sends `protocol`/`appVersion`,
  refuses a too-new command with 426 `error.updateNeeded.master`. ui and web:
  `TierPill`/`ServerMasterBadge`, `Avatar highlight`, `DataTable rowHighlight`,
  the shared `ui/src/LogsScreen.tsx` mounted by both panels, the Master's
  `ServerMasterSetupFlow`, `MasterKeyRecoveryFlow` and `MasterKeyPrompt`, two
  account blocks on first run, no `admin` prefill, Server Master controls on
  Roles & users, change pairing password in Settings, and the Office Logs row.
  Docs: new `docs/MASTER_KEY.md`; `ROLES_AND_USERS.md` §3.2; `DEVELOPER_MODE.md`;
  `STRUCTURE.md`. **Owed:** `docs/MASTER_KEY.md` carries a placeholder where the
  plaintext key goes — the implementing session never had it; the owner pastes
  it in (the hash in `shared/src/domain/master-key.ts` is already the real one).
  The restore calls `ensureServerMasterRole` for every restored company, so a
  pre-1.3 backup comes back with the role (the archive restore, when it lands,
  must do the same). Log exports stop at 250,000 rows, and at 128 MiB on the
  Master (45 MiB over the Office socket), and refuse past either rather than
  cut the file short. **Owed (owner decision):** the v1 `.obbackup` restore
  (`POST /api/storage/restore`) stays on `storage.manage` as the approved plan
  says, so an admin from any LAN PC can still restore a backup that holds no
  Server Masters, or a different set, past the rules that otherwise stop an
  admin removing one. The Master then asks for the master key to set up the
  missing accounts, so nobody gains the tier this way, but the guarantee that
  two always remain does not hold across that restore. Phase 8's archive
  restore is loopback plus master key; whether the v1 restore should follow it
  is the owner's call. A browser or Electron walk of the new flows is still to
  do.
- **2026-10-03 — 1.3 H5 (helper): the Printroom and the auto-print station (Claude, Sonnet, branch `helper/1.3`).** A shared print queue on both panels. A holder of `print.send` queues a pending or final order's Filling / Dispatch note from the note screen (*Send to Printroom*: copies, a printroom or any, vehicle, message); **the Master builds and freezes the sheet** from its own copy of the record (the sender's view and Party Access decide whether they may print it), so the printer PC never needs the record, its party or a big enough snapshot, and a later edit leaves the sheet as sent. Sending is online-only and idempotent (`UNIQUE (tenant, sender, request_id)`). `print.station` is a **deliberate cross-party grant**: it sees and prints every job, marks printed / not printed, cancels any queued job, and registers a PC as a station. **A claim belongs to the connection that made it** (`claim_socket`): released when that socket closes, stale after ten minutes, cleared at Master boot, so two stations never print one sheet; the Master PC's own window claims over its admin socket (there is no REST claim). `PrintStationRunner` (mounted at the top of both `App.tsx`) beats every minute and works the waiting queue one job at a time: claim, mount one sheet, wait a macrotask and the fonts, silent `printPage` through `printOnly`, mark printed, unmount; a failed print (an unlisted printer is a failure, never a dialog) goes back to the queue and is not retried this session. Electron: `orderbook:setStationMode` (panel window only, only `true` is on, `electron/lib/station-mode.ts`) switches background throttling off while a PC is a station. Migration `20261006000000_printroom` (two tables, user columns `TEXT REFERENCES users(id)`, add-only, grants `print.send` + `print.station` to admin / Server Master roles); eight `print:*` commands and `print:changed` at `PRINTROOM_MIN_PROTOCOL = 6` (`PANEL_PROTOCOL_VERSION` is 6 on this branch); nav id `printroom`, Alt+P, after the Chatroom; three sidebar pages (Waiting, Printed, Sent by me); the sender gets a `print.printed` bell entry; sent / printed / unprinted / cancelled are audited (`print_job.*`). The sheet of a printed or cancelled job is dropped after 30 days (one `UPDATE` per send). **Owed (cannot be seen in jsdom):** a real-printer pass in packaged Electron 33 and the legacy 22: copies on the owner's printers, silent auto-print while the window is minimised with station mode on, `savePdf` and the PDF window; the `.ob-print-*` layout in a browser; an unattended printer PC needs a person signed in on it who holds `print.station` (Windows auto-login plus the app at start-up).
- **2026-10-03 — 1.3 H4 (helper): the Chatroom (Claude, Sonnet, branch `helper/1.3`).** Text-only chat on both panels: group, direct and announcement rooms, @mentions, unread figures, search over the person's own rooms, tasks with "seen by n of m", pins, tombstones, a five-minute edit and delete window (database clock), record chips, and a "Request access" flow that notifies everyone holding `roles.edit`. **Outside the change ring and the activity chain**: it has its own bus channel (`publishChat` / `onChat`), reaches only a room's members holding `chat.use` (`emitToActors`, plus the Office's `broadcastForUser`), and only governance is audited (`chat_room.*`, `chat_message.removed/pinned/unpinned`). **A chip stores `{kind, id}` and is resolved for each reader** on every read and on every push (`personalisePush`): a reader who may not open the record sees "Restricted record" and never the party. Migration `20261005000000_chatroom` (three tables, every user column `TEXT REFERENCES users(id)`, add-only) also grants all six `chat.*` keys to admin and Server Master roles and `chat.use` + `chat.shareRecords` to office and management roles. **A post is held for its author**: an Office `chat.post` goes up only while its author is the person signed in, so it never rides the panel's role or another person's session and never stalls lead sync; the Master also rejects and records one under the wrong person. Seventeen `chat:*` commands and `chat:event` at protocol 5 (`CHAT_MIN_PROTOCOL`; `PANEL_PROTOCOL_VERSION` is 5 on this branch). Nav id `chatroom`, Alt+C, in both nav lists after Conflicts. The Office boards fetch a record their view lacks (`GET /api/leads/:id`, `/api/orders/:id`) and toast `nav.recordNotAvailable`; the Master's lists toast it too. Not done: a browser or Electron walk of the Chatroom, and nothing yet clears a deleted user's name from old messages (they keep rendering it). The Dashboard `chatUnread` tile is wired on both panels; the Basic Home tile comes from the nav row.
- **2026-10-03 — 1.3 H3 rework (helper): merge of Phase 4 and seven review items (Claude, Sonnet, branch `helper/1.3`).** `main` @ `4fc9564` merged (protocol stays 5 for chat; the chatroom migration follows Phase 4's two). `noteNumber({id, poNumber?})` returns the PO number or null and the sheet prints `number ?? id`; the source-based eyebrow stays; chat record chips are labelled with `recordNumber`. `OrderNoteScreen` has one in-flight ref for Print and Save PDF, ignores `event.repeat` on Ctrl+P and disables both buttons while either runs. `printToPDF` gets A4 and zero margins; the print stylesheet shows only the `--active` portal; the Office hides Preview PDF while the Master is unreachable (`ReportsScreen online`); STRUCTURE lists `report-hub.integration.test.ts`. Not verified: a real Electron print or Save PDF, the print CSS (jsdom cannot see it).
- **2026-10-03 — 1.3 H2 follow-ups (helper): four review items (Claude, Sonnet, branch `helper/1.3`).** `REPORT_ENTITIES` (`shared/src/domain/reports.ts`) is the one list of change entities that move a report; the Master's `SCREEN_ENTITIES.reports` uses it and the Office's Reports refresh counter now bumps on a `change` only for those (the snapshot still bumps). The report PDF subtitle prints the inclusive last day (`rangeSubtitle` in `report-range.ts`, calendar arithmetic, no `Date`) instead of the exclusive end. New tests: `report-hub.integration.test.ts` (junk payloads on `report:table` / `report:export` get the default range, `format: 'docx'` a CSV ack, the permission pair holds) and a `pg_indexes.indexdef` assertion for `idx_leads_owner_created`. Not done: the PDF subtitle is asserted on the arguments handed to the renderer, not by reading text out of the PDF bytes.
- **2026-10-03 — 1.3 H3 (helper): notes from pending orders, copies, Save PDF, report PDF window (Claude, Sonnet, branch `helper/1.3`).** Filling and Dispatch notes now open from a pending order on both panels (`leads.export`, not-converted leads only; Master `LeadsScreen`, Office `LeadBoardScreen`), headed "Pending Order No." with the lead id through one helper (`noteNumber` in `shared/src/domain/order-note.ts`, a one-line change when Phase 4 lands `poNumber`); a final order reads "Final Order No.". `OrderNoteScreen` takes `record` + `source`, a Copies field (1..50) and Save PDF; a pending order's vehicle number is print-only. `printOnly` (`ui/src/printPortal.ts`) plus one print-CSS rule keep exactly one note on the paper. Electron: `copies`/`collate` in `print-options.ts`, `DesktopBridge.printPage({deviceName?, copies?})` and `savePdf`, IPC `orderbook:savePdf` (path from the main-process dialog), and `isPdfWindowUrl` (exact path regex per kind, a `URLSearchParams` allowlist, no fragment). `GET /api/reports/:report/pdf` (inline, same two keys and scope as the export) with an Office proxy, and **Preview PDF** on `ReportsScreen`. No migration, no wire change beyond the optional desktop members. Not built (H5): print jobs, stations, Printroom, `setStationMode`. Owed: the real-printer check, "Owed work" item 7.
- **2026-10-03 — 1.3 H2 rework (helper): fourteen review findings on reports (Claude, Sonnet, branch `helper/1.3`).** An export now needs `reports.view` as well as `reports.export` (service, REST route and socket alike); Lead sources' rate column is "Conversion %"; dormant parties are those whose latest order of any date is older than the range; the new kinds' totals row sums only `SUMMABLE_UNITS` (kg rounded to 3 dp) and their CSV starts with a BOM (legacy kinds byte-identical); export options are normalised in `report.service.ts#normalizeExportOptions` and the hub runs `parseReportQuery` on `report:table` / `report:export`; the export audit row records `subjectId`; `idx_leads_owner_created` is partial (`WHERE deleted_at IS NULL`, the unreleased migration edited in place); the Dispatch role template holds the report keys; the Office's Reports refresh signal is a counter bumped on every snapshot and change; the screen says `reports.offline` for an unreachable Master and captions exact dates by the exact first and last day; 22 unused `reports.*` keys deleted. Not done: a browser or Electron walk of the Reports screen.
- **2026-10-03 — 1.3 H2 (helper): reports end to end (Claude, Sonnet, branch `helper/1.3`).** Fifteen report kinds on both panels, each answered as one `ReportTable` (`report:table`, `GET /api/reports/table/:kind`); the three legacy kinds keep their routes, socket events and CSV bytes (a golden test passes against the pre-refactor code too). **Who may ask is decided in `report.service.ts` only** (`shared/src/domain/report-access.ts` states the rule): `reports.view`, then the company switch for the tier, then the subject — the Office and Management tiers see only their own figures (`DateRange.ownerId` beside Party Access on every query; a different `subjectId` is refused), an administrator may pick any live user. Excel is streamed row by row and the PDF yields between pages (a test holds the longest stall under 400 ms; with the yields removed it is about 850 ms), both in English, capped at 100,000 / 100,000 / 10,000 rows. New periods: this financial year (from 1 April) and exact dates (inclusive, at most 366 days, no `Date`). The Office has Reports as a Work row with no chord, online-only through the Master; the Master's own `ReportsScreen` is deleted for the shared `ui/src/ReportsScreen.tsx`. Migration `20261004000000_report_indexes_and_grants` (owner-by-date indexes; `reports.view` and `reports.export` to every office and management role — add-only, idempotent). `open-pending-orders` shows the pending order's id until the Master-assigned PO number lands: **when Phase 4 adds `leads.po_number`, that column becomes `COALESCE(l.po_number, l.id)` in `report.repository.ts#openPendingOrders`.** Not done: a browser or Electron walk of the Reports screen, an Excel file opened in real Excel, and the Preview PDF link (BATCH Phase 7).

- **2026-10-03 — 1.3 H1 (helper): party import and export (Claude, Sonnet, branch `helper/1.3`).** One format (`docs/PARTY_IMPORT_FORMAT.md`), both panels, online-only. Shared `party-import.ts`; Master `domain/party-import.ts` and `services/party-import.service.ts` (modes `create` / `updateByCode`, dry run, chunks of 200, Party Access held per row, one `party_list` activity row, one `party_bulk` event); routes on `dataRoutes` before `/parties/:id` and on `/api/panel`; the Office proxies through two generalised helpers. UI: `ImportDialog` extracted from `ProductImportModal` (DOM unchanged), `PartyImportModal` and `PartyImportControls` on the Master's Parties screen and the Office's Catalog Parties tab. `party_bulk` is snapshot-forcing; a panel below `PARTY_BULK_MIN_PROTOCOL` gets a snapshot rather than the event (`hub.ts#emitGatedChange`). At the merge into `main` the minimum became 2 (the 1.3 handshake's `PANEL_PROTOCOL_VERSION`; the branch had 5) and the loose cast on `socket.data.protocol` was dropped. No migration. Not done: a browser or Electron walk of the two buttons and the dialog.

- **2026-10-02 — 1.3 Phase 1: shell, Basic Home, Master UI refresh, Inventory UI
  hidden, loading bars, device code, low RAM (Claude).** No migration. Shared:
  nav rows are `NavEntry` tuples with an optional explicit chord, both nav lists
  start with Basic Home, and `DashboardSummary` gained `convertedTodayCount` and
  `dispatchedTodayCount`. Kit: `BasicHome`/`landingScreen`, `StatTile`,
  `TopProgress` (`trackLoad`, `LoadingMark`, the one `ProgressBar`),
  `TopbarTitle`, `homeId` and a `banner` slot on `AppShell`, an LRU of 4 or 8
  live screens with pins, a freeze memo, Suspense and `lazyScreen` in
  `ScreenHost`, a 60-card cap per Kanban column, and the tile tokens and CSS.
  Master web: one `groups` literal (Work, Catalogue, Admin, System), landing on
  boot and sign-in, the company name in the footer, eleven lazy screens, light by
  default (`ob.theme.v3`), a `StatTile` Dashboard, and Inventory removed from the
  UI (screen, nav row, sub-pages, the stock column on Products, the five `api`
  members, two inventory settings hidden). Master server: `/api/setup/status`
  returns `companyName`, converted/dispatched-today counts, PostgreSQL memory
  options on small PCs and `postgres.log` rotation, `unhandledRejection` logged,
  and the revoke notice sent before the socket closes. Office: `deviceCode` on
  `GET /api/connection`, shown on sign-in and (provisional) on the connection
  screen; Basic Home in `alwaysAvailable`; four lazy screens; a `StatTile`
  Dashboard (its sync tile following the link state is Phase 3 work). Electron: a 1 GB renderer heap on PCs with 4.5 GB or
  less, one renderer reload per 5 minutes, a light window background, and log
  rotation while running. Docs: `docs/UI_REDESIGN.md` records the owner's
  override of "the busy mark is the only mover" and the tile spec; this file's
  release note above. Not done here: a browser or Electron walk of the new home
  screen, the light Master and the loading bar, and a local `vite build` (esbuild
  could not delete its temp files under this PC's sandbox), so the lazy chunks
  splitting is for the verifier's `npm run build` to confirm.

- **2026-10-02 — 1.3 Phase 0: Windows 7 legacy Office build and runtime floors
  (Claude).** A fourth release target, `win7`: the Office only, on Electron
  22.3.27 (`tools/legacy-electron.mjs`), x64 and ia32, from
  `office/electron-builder.legacy.yml` with a UCRT check in the installer, on
  its own update channel (`latest-win7.json`; a Win7 panel refuses any other
  platform's build). The Office server gained the undici 5.29 shim for Node 16
  (`office/src/lib/legacy-globals.ts`, first import of `index.ts`), tracked
  sockets instead of `closeAllConnections`, `Readable.from` for downloads and a
  feature-detected `fs.statfs` with a `wmic` fallback. The shell builds to
  CommonJS (`electron/tsconfig.legacy.json`), polls health over `node:http`
  and caps an ia32 server heap at 1 GB (`electron/lib/memory.ts`). The web
  apps lost `AbortSignal.any` (`anySignal` in `@orderbook/ui`) and name
  Chromium 108 in their Vite target. ESLint floor blocks, two static tests
  and `npm run smoke:legacy` hold the floors; the uninstall script was
  rewritten for PowerShell 2.0. Not done: real Win7 PCs and the first GitHub
  runs ("Owed work", owner-only 4 and 5).

- **2026-09-29 — Catalogue v2 ported onto the 1.2 product master (Claude).**
  The owner's 2026-09-28 restructure — Brand → Product → Sub product from the
  SWISWARE 2026 catalogue (`docs/catalogue/CATALOGUE_MODEL.md`) — had first
  been built on a checkout that never took 1.2.0 (`catalogue-v2-stale`,
  `6549018`), which also ran its migration on the owner's PC database. It was
  re-done on `main`'s model in a worktree on `catalogue-v2-port`: the no-op
  stub plus the idempotent `20260326` port migration (see "Traps"), the
  Markdown catalogue and its parser and one-transaction loader
  (`swisware-catalogue.ts` deleted), category CRUD with a Recycle Bin, derived
  colour rules, dropped stray colours, line brand/code snapshots, picks by
  code in catalogue order, the rebuilt Office lead entry, Products and Brands
  pages, Settings → Leads on both panels, the inventory listing every live
  variant, the fixed-layout lead PDF with its Electron window,
  `reload:catalog` keeping parties and the log, `seed:demo-parties`, and two
  changed setting fallbacks. Docs: this file, `docs/schema/`,
  `LEAD_GENERATION_FLOW.md`, `TESTING_PLAN.md` §8a, `STRUCTURE.md`,
  `DEVELOPER_MODE.md`, `backend-modules/04-API-CONTRACT.md` §10.2b.
  Walked in a browser on both panels; that walk found and fixed three
  defects — the Office's event stream reopening itself about sixteen times a
  second (already on 1.2.0), the sub-product list sorted A–Z instead of by
  catalogue, and a missing `inventory.piecesOnHand` string. Electron pending.

- **2026-09-25 — Leftover cleanup (Claude).** Dead exports went (`e2b7d71`);
  "1 attempt left" is singular now, and 57 unused message keys and the panels'
  dead CSS went (`cbf116b`). Text that still named removed features — money,
  the assistant, the PDF Designer, the old Picker, field "masking" — was
  reworded in sample data, test fixtures and comments; the two finished
  product briefs were deleted; status lines and counts brought up to date.
  Owed items 17–21 are what it found and left.
- **2026-09-24/25 — Audit of the whole tree, eleven fix branches (Claude).**
  The findings were fixed on `fix/schema-docs`, `audit-trail`,
  `http-hardening`, `master-tools-comments`, `release-sync`,
  `release-pipeline`, `electron-updates`, `office-storage`,
  `shared-contract`, `ui-kit` and `web-apps`; each was reviewed and repaired
  before it was merged into `main`. `d8f129e` and `8decf06` reconciled the
  tests the merges put at odds. Closed every defect this file had listed from
  the 2026-09-22 audit: audit entries written inside the change's transaction, and the
  writes that recorded nothing now record (a dispatch also bumps `version`
  and `hlc`); `GET /api/storage` needs `settings.manage`; a cross-site
  Socket.IO handshake is refused; `migrate --status` names what is pending
  and `reload:catalog` loads the catalogue (the wipe now clears connector
  links too); a GitHub setup file is no longer cut off at 15 s and a sync
  writes the platform-named manifests; Linux panels update their AppImage in
  place; an Office storage move survives a restart; the release publishes
  from `main` only, ships the `.deb` and drops the mac `.zip`; the kit's
  command priority is by mount order and Copy works over plain HTTP. Also:
  the schema docs checked against the migrated schema (new
  `docs/schema/07-integrations.md`), Parties on the Master's Alt+3, an Office outbox that cannot be read no longer
  written over (a corrupt one is set aside as
  `outbox.json.unreadable-<time>`, a busy one is read again) and one failed
  save no longer blocking every later one, and the web apps' shell defects,
  pinned by booting both panels in jsdom. `ffb69fe` made the command palette
  list only commands that would do something (`offers()`, `canNavigate`):
  screens the sidebar withholds, "New record" for a role that cannot create
  one, and the Find row that did nothing are gone (the chord still works).
  Last, `7d6ae68` made the shell tests wait until the panel is listening
  (event stream, socket, menu subscription, key listener) before sending it
  anything; under load they had lost that race one run in four, and the
  Alt+N refusal tests could pass without the chord reaching the panel. The
  documentation pass rewrote `docs/LEAD_GENERATION_FLOW.md` §7 (ID handling)
  against the code. What the audit found and left is under "Owed work".
  Verified: lint 0, typecheck 0, build 0, 160 files / 2015 tests with
  integration suites; Release run #37 (build-only, `dev` at `7d6ae68`) green
  on all three OSes.

- **2026-09-22 — `docs/STRUCTURE.md`: the whole software in one file (Claude).**
  Twelve readers mapped every workspace against `git ls-files` (one from a
  graphify code graph: 641 files, 6,152 nodes, 242 communities), one writer
  assembled the file, five fact-checkers raised 81 corrections (80 applied, 1
  rejected with evidence) and 51 gaps (all filled). It replaces
  `docs/CODE_MAP.md`. Five of the audit's defects were fixed with tests the
  same day, and the ones this file then listed in the 2026-09-24/25 round;
  dispatch keying on the stage name (§5.11 #7) is still open, as item 1 of
  the audit list under "Owed work".
- **2026-09-22 — macOS build fixed, library links fixed on every OS
  (Claude).** Vendored PostgreSQL links kept relative (`verbatimSymlinks`);
  the universal Mac build fetches and stages both architectures of every
  native package (`ensureUniversalPackages`, `universalSiblings`) and leaves
  the staged panel out of the lipo (`x64ArchFiles`). All three Release legs
  green; a local Linux build has 0 absolute links and a relocated copy of its
  PostgreSQL loads every library.
- **2026-09-22 — Branch consolidation and cleanup (Claude).** Merged
  amazing-lovelace, hopeful-lovelace and vibrant-ride into `main`, reset `dev`
  to `main`, and listed the rest for the owner to delete. Removed dead code: 15
  unused exports in `shared/` and `ui/` (`maskFields`, `Tooltip`, `Radio`, …),
  `shared/src/i18n/pseudo.ts`, 203 unused i18n keys, 22
  dead CSS rules, and the pricing leftovers in the design gallery and image
  service. Refreshed the stale docs and rewrote this file. Verified: lint 0,
  typecheck 0, build 0, 140 files / 1699 tests with integration suites.
- **2026-09-22 — 1.2.0 standalone builds (Claude, amazing-lovelace).**
  Standalone `.exe`, pre-update database copy, additive-migrations guard,
  cross-platform web build, CI green; the Release workflow built all eight
  Windows files into a draft pre-release. Left three owner decisions (above).
- **2026-09-22 — Lead-add and product add (Claude, serene-hawking).** Party
  shows its name alone, follow-up defaults to today, the suggest field's
  keyboard fixed, Enter walks the variants table, Grade back on a line as a
  pick (`20260325000000_line_item_grade`), a compact added-product row, and
  Modify/Remove as icons.
- **2026-09-22 — Product page UI (Claude, zealous-cori).** Product screens
  redesigned from the owner's artifact; stock dropped from the product detail;
  the crop editor made horizontal with load states and every image format
  (HEIC/AVIF/TIFF accepted client-side).
- **2026-09-21 — Product master trimmed, pricing removed (Claude).**
  Multi-colour lines, the catalogue PDF extracted into a spreadsheet.
- **2026-09-21 — Filter strip (Claude, vibrant-ride).** Category chips dropped,
  the strip given vertical room.
- **2026-09-19 — Product model → variant (Claude).** Swisware catalogue, PDF
  Designer removed, sample data; merged with the v1.1.0 line.
- **2026-09-16..18 — Settings, security, packaging (Claude, hopeful-lovelace).**
  Fourteen briefs closed; four privilege holes; eleven company settings and
  the forced resnapshot on a setting change; the clean-install tool; Mac and
  Linux panel builds (verified on Linux: packaged Master created its cluster
  and answered `/api/health`).
- **2026-09-14 — Build fix, dead code, bloat removal (Claude).**
- **2026-09-06..13 — v1.0.3 blockers, developer mode, uninstaller, pricing
  switch (later removed), product hierarchy, keyboard-first lead entry
  (Claude, Command Code).**

### Claude sessions retired on 2026-09-22

The owner is deleting these sessions; this is what each one was and where its
work went.

| Session | What it did | Where the work is |
|---|---|---|
| Repository cleanup and branch reset (this one) | Consolidation and cleanup above | `main` and `dev` |
| Orderbook standalone version | 1.2.0 standalone `.exe`, backup on first boot | merged to `main`; the three owner decisions are under "Owed work" |
| Lead and product add improvements | lead-add trims, suggest keyboard, Grade, icons | already on `main` (`ecd5f8b`) |
| Product page UI/UX implementation | product redesign, image picker formats and load states | already on `main` |
| Top bar filter removal and spacing | filter strip | merged to `main` |
| Project status and structure review | settings, privilege fixes, clean-install tool, Mac/Linux builds | merged to `main` |
| UI improvement (local CLI) | Phase 6.0 standalone flavour, `a3fa9e4` on `feat/marcwares-design-system` | **only on the owner's machine** — not on GitHub |
| Windows bloatware removal script (local CLI, archived) | unrelated to this repo | — |
| desktop-… sessions and "Install Andrej Karpathy skills repository" (archived) | early setup on `dev` | nothing outstanding |
