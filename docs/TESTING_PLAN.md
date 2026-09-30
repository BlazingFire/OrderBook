# OrderBook — Manual QA Test Plan (v1.2.0)

Three PCs on one LAN:

- **PC-A** — Master Panel (`OrderBook-Master-1.2.0-Setup.exe`)
- **PC-B** — Office Panel #1 (`OrderBook-Office-1.2.0-Setup.exe`)
- **PC-C** — Office Panel #2 (same installer)

Test in the order below — later sections depend on state created earlier (users, parties, leads). Log every failure with: step number, expected result, actual result, screenshot, and the exact panel + user account used.

---

## 0. Pre-flight

- [ ] Confirm PC-A, PC-B, PC-C are on the same subnet, can ping each other by IP.
- [ ] Note Windows Firewall state on each PC (on/off) — needed for Section 9.
- [ ] Copy `OrderBook-Master-1.2.0-Setup.exe` to PC-A, `OrderBook-Office-1.2.0-Setup.exe` to PC-B and PC-C.
- [ ] Confirm none of the three PCs has a prior OrderBook install/data directory (`%APPDATA%\OrderBook`) unless this run is specifically testing upgrade/restore.

---

## 1. Master installation (PC-A)

1. Run `OrderBook-Master-1.2.0-Setup.exe`.
   - [ ] SmartScreen warning appears (unsigned build) — confirm "More info → Run anyway" works and is the only way through.
   - [ ] Installer lets you choose install directory (not one-click).
   - [ ] Desktop shortcut and Start Menu shortcut created.
2. Launch OrderBook Master.
   - [ ] App window opens, no console/crash dialog.
   - [ ] `%APPDATA%\OrderBook` created with a data subfolder.
3. Uninstall/reinstall check (do this once, early):
   - [ ] Uninstall via Control Panel → confirm program files removed.
   - [ ] Confirm `%APPDATA%\OrderBook` (company data) is **not** deleted.
   - [ ] Reinstall for the real test run.

---

## 2. First-run setup wizard (Master, PC-A)

Screen: **FirstRunScreen**.

1. **Fresh site path:**
   - [ ] Choose "Set up new site" (not restore).
   - [ ] Wizard generates: Master identity/ID, admin username, admin password, pairing password, and lists this PC's LAN IP(s).
   - [ ] Credentials are shown **once** — confirm there's an explicit "I have saved these" acknowledgement before continuing, and reopening the app never shows them again.
   - [ ] Record admin username/password and pairing password somewhere safe for later steps.
2. [ ] After confirming, app proceeds to Sign In screen (or auto-signs-in) — no error.
3. [ ] Restart Master app — confirm it does **not** re-run first-run setup (setup status persisted).
4. **Restore path (separate pass, optional but recommended once):**
   - [ ] From a second clean install, choose "Restore from backup" and point at a backup file (produced later in Section 11) + passphrase — confirm it restores parties/leads/users instead of creating a blank site.

---

## 3. Sign-in & session (Master, PC-A)

Screen: **SignInScreen**.

- [ ] Sign in with admin credentials from Section 2 — succeeds, lands on Dashboard.
- [ ] Sign out — returns to Sign In screen.
- [ ] Wrong password × 3 in a row → account locked for 60s; 4th attempt within the window is rejected even with the correct password.
- [ ] Wait out the 60s lockout → correct password now succeeds.
- [ ] Restart the Master app while signed in → confirm you are signed **out** (sessions are in-memory, don't survive restart) and must sign in again.

---

## 4. Users & Roles (Master only, PC-A)

Screen: **AccessScreen**.

1. Roles:
   - [ ] Create a new role with a limited permission subset (e.g., Leads + Orders read-only, no Access/Settings/Integrations).
   - [ ] Edit an existing role's permissions.
   - [ ] Soft-delete a role, confirm it appears under "deleted roles", restore it.
2. Users:
   - [ ] Create a new user, assign the limited role from above. Record username/password.
   - [ ] Edit a user (name/role change).
   - [ ] Reset a user's password as admin.
   - [ ] "Reveal password" for a user (admin-only plaintext reveal) — confirm it's gated by a permission and shows the correct value.
   - [ ] Soft-delete a user, confirm under "deleted users", restore it.
   - [ ] **Live permission check:** while the limited user is signed in on another device/session, revoke one of their permissions from the admin side — confirm their very next action is blocked (no need for them to re-login).
- [ ] Change your **own** password — **Change password** in the Master's topbar, on
      every screen. The dialog says up front that it signs you out everywhere;
      confirm that after it succeeds the window lands on the sign-in screen with
      a message naming the reason, and that the new password works.

---

## 5. Parties, fields and stock (Master, PC-A)

Screens: **Parties**, **PartyAccess**, **Inventory**, plus the party/product
pickers used elsewhere.

> **Which panel owns what — settled 2026-09-17, recorded in `HANDOFF.md`.**
> **Parties are on both panels**; the Master gained a Parties screen, and both
> render the same `PartyFormModal` from `ui/`. **The product catalogue is
> Office-owned**: there is no Master products screen and there is not going to
> be one, so the catalogue steps below moved to §6. Earlier revisions of this
> plan asked for all of it on the Master — written against the API surface and
> the permission catalogue rather than against the screens that render — which
> is how four of the owner's ten QA findings came back as bug reports for
> features nobody had built.

1. Parties (customers) — screen **Parties**:
   - [ ] Create a party. Confirm it appears in the list and the total in the
         filter strip counts every party, not the page.
   - [ ] Open a row — it opens a **centred modal**, not a drawer — and edit it.
   - [ ] Sort by name, then by code; confirm the caret follows the active column.
   - [ ] Search; confirm the request settles after you stop typing, not per keystroke.
   - [ ] Delete a party, find it in the Recycle Bin, restore it.
   - [ ] Delete a party that a live lead references; confirm the refusal **names
         what is blocking it** rather than saying "could not delete".
   - [ ] With a role lacking `parties.create`, confirm the **New party** button is
         absent, not greyed.
   - [ ] Confirm **Master cannot create a lead directly** tied to party creation — leads are Office-only (see Section 7).
2. Stock/inventory — screen **Inventory**:
   - [ ] Record inbound stock for a product.
   - [ ] Manually adjust stock (correction) and confirm a stock movement entry is logged.
   - [ ] Set a reorder level and confirm a low-stock indicator appears once stock drops below it.
   - [ ] Stock is per variant: a sub product has one row whatever colours its leads carry (the
         catalogue v2 inventory checks are in §8a.6).
3. Custom fields & pipeline stages — screen **FieldsScreen**:
   - [ ] Add a custom field, use it on a party/lead, confirm the value round-trips.
   - [ ] Reorder pipeline stages; archive a stage; confirm archived stage no longer selectable for new leads but historical leads keep it; restore the stage.
4. Party-level access control — **PartyAccessScreen**:
   - [ ] Restrict a party so only specific users/roles can see it.
   - [ ] Confirm a user without access cannot see that party from Office (Section 7) or Master search.
   - [ ] Confirm the summary line counts the **whole company**, not the loaded
         page: with more than 200 parties, page to the end and check the totals
         did not move.
   - [ ] Export party-access list to CSV, confirm the file opens and matches
         on-screen data — and with **more than 200 parties**, confirm every one
         of them is in the file. (It used to stop at 200 and say it was complete.)
   - [ ] With a role holding `party.accessAll` but not `parties.export`, confirm
         the export is refused on the Office panel too, not just the Master.

---

## 6. Office installation & pairing (PC-B and PC-C)

Screen: **ConnectionScreen** (first screen before sign-in on Office).

Do this for **both** PC-B and PC-C independently.

1. Install `OrderBook-Office-1.2.0-Setup.exe` (same SmartScreen/shortcut checks as Section 1).
2. **Auto-discovery path:**
   - [ ] Launch Office, choose "Auto" — Master (PC-A) appears in the discovered list, correctly showing whether pairing is open.
   - [ ] On Master, open the pairing window (**PanelsScreen** → open pairing).
   - [ ] From Office, select the discovered Master and pair using the pairing password from Section 2.
   - [ ] Confirm the new panel now appears in Master's **PanelsScreen** list.
   - [ ] Close the pairing window on Master, confirm a *new* pairing attempt is now rejected while an already-paired panel keeps working.
3. **Manual pairing path** (test on PC-C instead of auto, to cover both):
   - [ ] Choose "Manual", type PC-A's LAN IP + pairing password directly, confirm pairing succeeds without discovery.
4. **Panel admin (Master, PC-A):**
   - [ ] Open **PanelDetailScreen** for each paired panel — confirm name, status, last-seen update as the Office app runs (`panel:report`).
   - [ ] Revoke one panel from Master — confirm that Office instance is kicked to a "revoked/reconnect" state and cannot act until re-paired.
   - [ ] Re-pair the revoked panel.
5. **Restore path** (optional pass): pick "Restore" on Office's ConnectionScreen with a prior Office backup — confirm it restores local state without going through pairing again.

---

## 7. Sign-in on Office (PC-B, PC-C)

- [ ] Sign in on PC-B with the limited-role user created in Section 4.
- [ ] Sign in on PC-C with the admin user (or a second distinct user) at the same time — confirm both sessions are independent.
- [ ] **Offline sign-in:** disconnect PC-B from the network (disable Wi-Fi/Ethernet), relaunch Office, sign in with a user who has signed in before — confirm offline verifier lets them in without Master reachable.
- [ ] Reconnect PC-B, confirm any pending revocation/permission change from Master is now applied (re-check via `revokedTokens`/reconcile).
- [ ] On Master, delete/deactivate a user that has an offline session cached on an Office panel — reconnect that panel and confirm the offline verifier is destroyed (user can no longer sign in offline afterward).

---

## 7a. Office: the product catalogue (PC-B)

Screen: **Catalog**, Products tab. This is where the catalogue lives — see the
ownership note in §5.

1. Products & categories (the screens say **Product** for a category and **Sub product** for a
   model since catalogue v2 — §8a.2 has the checks for codes, brands and order):
   - [ ] Create a Product (category), then a sub product under it.
   - [ ] Look up a product by one of its variant codes.
   - [ ] Upload, reorder and delete product images; confirm the variants render
         (micro in a table row, thumb in the form).
   - [ ] Import products from CSV/Excel with a template; confirm the row-numbered
         error report names the rows it refused.
   - [ ] Through the **dev server** as well as the packaged app, confirm product
         images load. They are served from `/uploads`, which the dev server did
         not proxy — every photo 404'd and it read as "there is no image flow".
2. Permission gates — sign in with a role lacking each key in turn:
   - [ ] Without `products.create`, the **New product** button is **absent**, not greyed.
   - [ ] Without `parties.create`, the **New party** button is **absent**, not greyed.
   - [ ] Pressing Enter in the **Name** field advances to the next field rather
         than saving the form.

---

## 8. Leads & Orders — cross-panel workflow (core business flow)

This is the most important end-to-end path — run it fully, both directions.

1. **Create a lead from Office (PC-B):**
   - [ ] `AddLeadScreen` → create lead against an existing party.
   - [ ] Confirm it appears immediately on **Master's LeadsOrders board** (PC-A) — verify realtime `data:changed`/`dashboard:changed` push, not just on manual refresh.
   - [ ] Confirm it also appears on **PC-C's LeadBoard** in near-real-time.
2. **Confirm Master cannot create leads directly** — no "new lead" action should exist on Master's LeadsOrders screen (by design).
3. **Move lead through pipeline stages** from Master (PC-A):
   - [ ] Change stage, add a remark.
   - [ ] Confirm stage + remark sync to both Office panels.
4. **Convert lead → order** (Master or Office, whichever role permits):
   - [ ] Convert, confirm an Order record is created and linked back to the source lead.
5. **Order lifecycle:**
   - [ ] Update order stage.
   - [ ] Dispatch the order (`/orders/:id/dispatch`) — confirm dispatch info (date/notes) is recorded and reflected on all panels.
6. **Simultaneous edit conflict:**
   - [ ] On PC-B and PC-C, open the **same** lead at the same time, edit different fields, save both — confirm no data loss (fields merge) or, if they collide on the same field, confirm a conflict is raised.
   - [ ] Go to **ConflictsScreen** on Master — confirm the conflict is listed with a field-level diff, resolve it, confirm resolution propagates to both Office panels.
7. **Offline lead creation (Office outbox):**
   - [ ] Disconnect PC-C from network, create 2–3 leads while offline.
   - [ ] Reconnect — confirm the outbox drains automatically and all offline-created leads appear on Master and PC-B without duplication.
8. **Delete & Recycle Bin:**
   - [ ] Delete a lead/order/party (as a user with delete permission) — confirm it disappears from active lists on all panels.
   - [ ] On Master's **RecycleBinScreen**, confirm the deleted item appears with the deleter's name/time, restore it, confirm it reappears everywhere.
   - [ ] Attempt the same delete as a user **without** the recycle-bin/delete permission — confirm it's blocked.

---

## 8a. Catalogue v2 — Brand → Product → Sub product (2026-09-29)

The spec is `docs/catalogue/CATALOGUE_MODEL.md`; section numbers below (§1–§9) are its. Run on a
database with parties and a few leads from §8, so the reload and the lead PDF have data to act on.

1. **Upgrade and catalogue load** (PC-A):
   - [ ] On a copy of a 1.2.0 database, start the new Master: it boots, and
         `npm run migrate --workspace @orderbook/master -- --status` lists
         `20260323000000_catalogue_brands_and_codes` and
         `20260326000000_catalogue_brands_and_codes_port` as applied, nothing pending.
   - [ ] **A database a stale `catalogue-v2-stale` checkout booted** (the owner's PC): take a
         `pg_dump` first (`HANDOFF.md`, "Live databases") — main's first boot wipes its
         product-linked tables. Confirm the Master boots rather than stopping on "migration
         directory is corrupt".
   - [ ] Settings → Developer → *Load catalogue*: 41 products, 549 sub products, the 21-colour
         range with swatches, one brand (Swisware+). Run it again — everything is skipped, nothing
         doubles.
   - [ ] Every sub product's code is its product's code and four digits in catalogue order
         (`OPT-0001`, `OPT-0002`, …), and weights are blank ("weight missing").
2. **Brands and Products** (Office catalogue sub-pages, and Settings → Fields → Brand on the
   Master):
   - [ ] Add a brand, rename its label, remove it to the Recycle Bin, restore it. Logs shows each
         as an option-list entry.
   - [ ] Create a Product with a code, a brand and an order. A second Product with the same code
         in another case (`opt` vs `OPT`) is refused; a code with a space or a hyphen is refused;
         a brand that is not on the Brand list is refused.
   - [ ] The same Product name under a **different** brand is accepted; under the **same** brand it
         is refused.
   - [ ] Edit a Product's name, code, brand and order; Logs shows `product_category.updated` with
         each field's from → to. Lists follow the new order.
   - [ ] Deleting a Product that still has live sub products is refused and names them; deleting
         an empty one puts it in the Recycle Bin, and restoring it brings it back; its code is free
         for another Product while it is in the Bin — and if another Product took that code
         meanwhile, the restore is refused, while a name taken meanwhile offers a rename.
   - [ ] A sub product in the Bin cannot be restored while its Product is still in the Bin.
   - [ ] With the Office offline, the Products list still shows (from the snapshot) and a create
         or edit is refused as unavailable rather than queued.
3. **Sub products**:
   - [ ] Create a sub product under a Product chosen by code; leave the variant code blank — it
         gets the next `CODE-####` for that Product.
   - [ ] A second live sub product of the same name inside one Product is refused; the same name
         under another Product is accepted.
   - [ ] Edit a sub product; Logs names its Product and shows each changed field from → to.
4. **Lead entry** (Office, PC-B, `AddLeadScreen`):
   - [ ] Party: no list shows on focus; typing shows matches.
   - [ ] Source: only the active list values; no free-text "Other" box.
   - [ ] Follow-up starts at today + 3; change the default on Settings → Leads (item 7) and the
         form moves to the new value without a reload, and again after a save.
   - [ ] Product bar: typing `OPT` puts One Piece Toilet first; typing a name or a brand also
         finds it. Rows read `CODE · Name · Brand`.
   - [ ] Sub-product bar: **all 56** One Piece Toilet and **all 69** Table Top Vitrosa Basin
         sub products are reachable in catalogue order, and typing filters them; colour-named
         rows show a swatch.
   - [ ] Fixed sub product (e.g. a White one): colour shown locked, quantity only. A sub product
         named after its colour (`MAGENTA`) shows no separate colour.
   - [ ] Dedicated sub product (a numbered designer piece such as `1111`): quantity only, no
         colour anywhere.
   - [ ] Multicolour sub product (Orissa Pan, Water Closet): add White ×10 and Ivory ×5 — two
         lines on one sub product; the Ctrl+Enter review groups them into one row.
   - [ ] Packaging and then Grade sit beside every quantity, the same box each. Packaging offers
         Box, Grass and Paper only; it is marked required (*) and blocks the card only while the
         Master's Settings → Leads requires packaging. Grade is always optional.
   - [ ] Enter goes quantity → packaging → grade → next row; typing `g` in packaging narrows to
         Grass and Enter takes it and moves to Grade (a mouse pick moves on too). After the last
         grade Enter lands on **Add product**; Enter there adds the sub product and returns to
         the sub-product bar. Escape walks back: Add product → grade → packaging → quantity.
         Shift+Q (or **Complete sub product**) adds a pending sub product and returns to the
         product bar; with nothing pending it just finishes the product. A capital Q still types
         in the notes and in the party box.
   - [ ] Ctrl+Enter opens the review; Ctrl+Enter again saves exactly one lead (hold the keys
         down — still one). The form resets.
5. **Lead PDF**:
   - [ ] **Preview PDF** on the Master's Leads list and on the Office lead detail opens the PDF
         (in the Electron app, in a PDF window).
   - [ ] The header names the company, the lead id and today's date; the party block shows
         its name, address, phone and GST number.
   - [ ] Columns `# | Main product | Model | Size | Colour | Code | Qty`; an alphanumeric sub
         product fills Model, a numeric one fills Code (right-aligned) — never both — and the
         software code (`OPT-0001`) appears nowhere. A sub product entered in two colours is
         one row with the quantities summed.
   - [ ] Colour: blank for dedicated; the fixed colour, unless it only repeats the name; the
         multicolour lines of one sub product as `White ×10, Ivory ×5`.
   - [ ] A long product or sub-product name wraps and the row grows; quantities stay on one line.
   - [ ] A Brand column appears only when the lead's lines span two brands (add a second brand
         and Product to test). No rate, amount or total anywhere.
   - [ ] A role without `leads.export` gets no button, and the route answers 403; an Office
         panel offline says the Master is unreachable; a lead still queued in the Office outbox
         (marked not synced) shows no button, since the Master renders the PDF.
6. **Inventory** (Master, **Inventory**):
   - [ ] Every live sub product is listed — 549 after a fresh load — stocked or not, at zero
         when never stocked; a deleted or deactivated one is not.
   - [ ] Columns Brand, Product (`CODE · Name`), Sub product, Size, Colour (fixed colour only),
         Code, weight, on hand / reserved / free (the last two only with free-to-sell on),
         reorder, min, max, status.
   - [ ] Search by sub product, product code and brand; brand chips; product filter; low only.
   - [ ] The Dashboard's low-stock count equals the Inventory's low-only count, including after a
         sub product with a reorder level is deleted.
   - [ ] Stock-in and count: product bar → sub-product bar → the sub product.
7. **Settings → Leads** (both panels):
   - [ ] On the Office, a user with `settings.manage` saves the follow-up default; the Master's
         Settings shows the new value and Logs records it with from → to.
   - [ ] A user without `settings.manage` cannot save it on either panel; neither can the panel
         itself with nobody signed in.
   - [ ] The lead-source list edits here and on Settings → Fields are the same list.
8. **Conversion**:
   - [ ] With packaging not required (the default), a lead with no packaging converts.
   - [ ] Switch it on: the same conversion is refused naming the lines without packaging.
9. **`reload:catalog`** (PC-A, do last in this section):
   - [ ] With the Master running, `npm run reload:catalog --workspace @orderbook/master` refuses
         and says to stop the Master first.
   - [ ] With the Master stopped (and every Office outbox drained), it runs: afterwards parties,
         users, roles, settings, option lists and the whole activity log are still there; leads,
         orders, stock and the old products are gone; the catalogue is back; Logs has one
         `catalog.reloaded` entry and **Verify** reports the chain intact.
   - [ ] `npm run seed:demo-parties --workspace @orderbook/master` adds 13 dealers; running it
         again adds none.

---

## 9. Network resilience & discovery (LAN-specific)

Run once with each combination:

- [ ] **Both firewalls ON (default Windows Firewall):** verify auto-discovery (UDP) and live sync (TCP/Socket.IO) both work — if not, confirm the installer/app prompts for or documents the firewall rule needed on Master.
- [ ] **Master's port blocked, Office allowed:** confirm auto-discovery fails gracefully and **manual pairing by IP** still works if the TCP port is open (isolates UDP vs TCP failure).
- [ ] **Master restarts while Office panels are connected:** confirm both Office panels detect the disconnect, show a reconnecting state, and auto-recover once Master is back — no crash, no duplicate data on resync.
- [ ] **Office panel put to sleep/resumed** (laptop lid close/open, if applicable): confirm reconnect happens without manual restart.

---

## 10. Standalone build (Windows)

1. [ ] Run `OrderBook-Master-1.2.0-Standalone.exe` on a PC with no installation — it starts without administrator rights and writes nothing under Program Files.
2. [ ] Its Updates screen says to replace the file rather than offering Install.
3. [ ] Install `OrderBook-Master-1.2.0-Setup.exe` over the same data folder — every record is still there.
4. [ ] Start a newer version once: `%APPDATA%\OrderBook\master\backups\before-<version>-…` appears with a README naming the restore steps.

---

## 11. Settings, Storage, Backup/Restore (Master, PC-A)

Screen: **SettingsScreen**.

- [ ] View storage usage numbers — confirm they look sane (non-zero, grows after adding data).
- [ ] Signed in as a role without `settings.manage`, open Settings through **Help → Uninstall OrderBook** (it lands on the Developer tab): there is no Storage tab unless the role holds `storage.manage`, and then it offers export and restore with no usage figures (`GET /api/storage` needs `settings.manage`).
- [ ] Export a full backup (passphrase-protected) — save the file.
- [ ] Preview a restore from that backup file without committing — confirm preview shows what would change.
- [ ] Perform the actual restore into a **separate clean Master install** (see Section 2, restore path) and confirm parties/leads/users all come back correctly, including custom fields and role/permission setup.
- [ ] Check password vault status indicator reflects actual vault state.
- [ ] Office `SettingsScreen` — confirm it has no company settings: Appearance and Shortcuts are this machine's preferences, Machine is read-only, and Storage holds this panel's own data folder (plus backup actions for `storage.manage`); Developer (shown to everybody signed in, unlocked by the developer password) holds this panel's reset and the uninstall.
- [ ] Office Settings → Storage — moving the data folder to a drive root, the home folder, or a folder already holding other files is refused with the folder named; a move to an empty folder succeeds, and after quitting and relaunching the app the panel is still using the new folder with its queued work intact.

---

## 12. Reports & Logs (Master only)

- [ ] **ReportsScreen:** run Dispatches report, Lead-Outcomes report, Top-Parties report — confirm numbers match manually-counted test data from Sections 5 & 8.
- [ ] Export a report, confirm file downloads and matches on-screen figures.
- [ ] **LogsScreen:** confirm actions taken throughout this test pass (sign-ins, lead creation, deletes, role changes, an order edit, an order stage move, a reorder level and a party-wise record) appear in the audit log with correct actor/timestamp.
- [ ] Use log filters/facets to narrow by action type or user.
- [ ] Run the hash-chain integrity **verify** action — confirm it reports "intact" on an untampered log.
- [ ] Export logs to file.

---

## 13. Integrations (Master only)

Screen: **IntegrationsScreen**.

- [ ] Create an API key, confirm it's shown once (or however the UI indicates it), then revoke it and confirm revoked keys are rejected by the public API.
- [ ] Create a connector, configure field mapping, run "test connection", confirm pass/fail is reported accurately.
- [ ] Trigger a connector run, confirm run history (`/:id/runs`) records the result.
- [ ] Call the public API (`public-api.routes.ts`) directly (e.g., via curl/Postman) with a valid key — confirm expected data returned; with a revoked/invalid key — confirm 401/403.

---

## 14. Auto-update flow (do this last — it replaces the running app)

Setup: build a **newer** version (e.g., bump to `1.2.1` via `npm run release -- 1.2.1`) and drop the output into `C:\OrderBook-Releases\{master,office}-panel\` on the Master PC, exactly as the release script's own instructions say.

1. **Master update (PC-A):**
   - [ ] Open **UpdatesScreen** — confirm it detects `1.2.1` is available with correct version/notes.
   - [ ] Trigger install — confirm the app quits, the new installer runs, and relaunching shows `1.2.1` in the UI (check About/version display or window title).
   - [ ] Confirm all data (parties/leads/users) is intact after the update — installer must not touch `%APPDATA%\OrderBook`.
2. **Office update (PC-B, PC-C):**
   - [ ] Confirm Office's **UpdatesScreen** asks Master over the LAN (`/office/latest`) and detects `1.2.1`.
   - [ ] Trigger download — confirm progress is shown, and the downloaded file's hash is verified against the manifest before install.
   - [ ] Confirm install/relaunch succeeds and Office reconnects/re-pairs with Master automatically.
3. **Failure paths** (fails soft — never crashes):
   - [ ] Temporarily rename/remove both manifests, `latest-win32.json` and `latest.json`, in the release folder (the reader falls back from one to the other, and with `ORDERBOOK_RELEASES_GITHUB_REPO` set the next check writes them back) — confirm Master reports "nothing to install" cleanly, no error dialog.
   - [ ] Corrupt the installer file's bytes (flip a byte) without updating its hash in the manifest — confirm the hash check on Office rejects it and refuses to run the corrupted installer.
   - [ ] Confirm an **unsigned** release (as built in this session, no `ORDERBOOK_RELEASE_KEY`) is accepted only because `ORDERBOOK_ALLOW_UNSIGNED_RELEASES` is understood to be needed for unsigned installs — verify actual behavior matches this expectation (either it installs with a visible "unsigned" warning, or it refuses outright — confirm which, and that it isn't silently installing unsigned code with no indication).

---

## 15. Cross-cutting regression pass

After all sections above, do one more full-data sanity check:

- [ ] All 3 panels show identical counts for parties, leads, orders on their respective dashboards.
- [ ] Sign out and back in on all 3 panels — data still consistent.
- [ ] Reboot all 3 PCs, relaunch all apps — Master re-serves the embedded Postgres correctly, both Office panels reconnect and re-sync without manual pairing.

---

## Defect log template

For every failure found, record:

```
ID:
Section/Step:
Panel + PC (Master/Office, PC-A/B/C):
User account used:
Expected:
Actual:
Repro steps:
Screenshot/log attached: yes/no
Severity: blocker / major / minor / cosmetic
```
