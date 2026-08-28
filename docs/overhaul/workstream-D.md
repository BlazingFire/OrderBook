# Workstream D — Searchable dropdowns everywhere and Miracle-style dense forms + grid entry

sound=false

## Findings
- **blocker**: master/tests/party-access-screen-parity.test.ts asserts master/web/src/screens/PartyAccessScreen.tsx and office/web/src/screens/PartyAccessScreen.tsx are BYTE-IDENTICAL. The design's Files list names only the master copy for the Combobox→Picker change. The test fails the moment that edit lands.
  - FIX: Change both PartyAccessScreen copies identically. That forces ui/Picker.tsx to exist byte-identically in both master/web/src/ui/ and office/web/src/ui/, and api.pick() to exist identically in both api.ts clients, NOW — not after the shared-ui workstream. The design's 'blocks on the shared package' framing is wrong for this one file.
- **blocker**: The office offline fallback calls pickFromView(kind, query, await localStore.getView()). getView() returns the RAW view. Every other consumer wraps it: office/src/http/app.ts:217 and :1284 both call forCurrentUser(view), which applies withoutAnotherPersonsParties (party-scope) and maskLead/maskOrder/maskProduct/maskVariant (rate masking). The design's picker leaks another person's restricted parties and leaks rate to an actor without field.saleRate.view.
  - FIX: pickFromView must take forCurrentUser(view), never getView() directly. It must also gate on userSession.sessionPermissions(): return [] for products when 'products.view' is absent and for parties when 'parties.view' is absent — the offline counterpart of the master's requirePermission, which the design has no substitute for.
- **blocker**: maskParty does not exist. shared/src/domain/visibility.ts exports only maskLineItem, maskProduct, maskVariant, maskLead, maskOrder, withPermittedRate. The design instructs the implementer to mask parties with it.
  - FIX: Drop the claim. Parties carry no money field, so the party pick needs no field masking — only partyScopeSql. Product pick uses the real maskProduct via master/src/domain/visibility.ts, which re-exports it alongside canSeeRates.
- **blocker**: Every new string is a multi-file change the design never mentions. ValidationError's first argument is typed MessageKey = keyof typeof EN_MESSAGES, so 'validation.pick.kind.unknown' must be added to shared/src/i18n/en.ts AND shared/src/i18n/hi.ts — shared/tests/i18n-coverage.test.ts asserts hi.ts is total and placeholder-identical to en.ts and will fail otherwise. Separately, every UI string (Pinned, Recent, Type to search, No match for X, Create 'X', the offline footer, every report column label, every LineGrid cell error) must be hand-added to BOTH master/web/src/i18n/strings.ts and office/web/src/i18n/strings.ts, which are forked flat dictionaries with untyped t(key: string).
  - FIX: Enumerate the keys. Add validation.pick.kind.unknown and validation.reports.column.unknown to en.ts and hi.ts. Add the ~12 picker/grid/report UI keys to both web strings.ts files. ReportColumnDef.labelToken cannot be MessageKey and also be resolvable by the web t() — either type it as a plain string and add the label to both web dictionaries, or resolve it server-side.
- **blocker**: Dropping money columns for a rate-blind actor breaks a pinned existing test and contradicts the repo's stated CSV rule. master/tests/reports.integration.test.ts:196-199 asserts lines[0] === 'month,orderCount,boxCount,totalValue' for an actor with reports.view+reports.export and no rate permission, and asserts the trailing cell is empty. master/src/lib/csv.ts's header comment states the rule: 'A redacted money column is an empty cell, never 0'. Absent-key is the JSON wire rule, not the tabular rule. The design's own two report tests also contradict each other: 'byte-identical CSV to today' cannot hold alongside 'every money column absent from the header row'.
  - FIX: Keep the header, empty the cell — for csv, xlsx and pdf alike. The column stays in REPORT_COLUMNS and in the emitted header; its value is '' (csv), a blank cell (xlsx), an em dash (pdf). The existing test then still passes and the compatibility pin is achievable.
- **blocker**: Deleting office/web/src/components/ProductDrawer.tsx and PartyDrawer.tsx breaks four office screens the design never names: CatalogScreen.tsx (both drawers, in create AND edit mode, ~10 call sites), PartyDetail.tsx (edit via onEdit), ProductDetail.tsx (edit), AddLeadScreen.tsx:570 (inline new-party). The stated replacement — ProductEditorScreen published through useSubNav — is impossible in office: office/web/src/ui/ has no SubNavSlot.tsx (it is master-only, along with TopbarSlot, AvatarPicker, PermissionSummary, permissionLabels). Office would lose product and party editing entirely.
  - FIX: Either keep the office drawers and only widen their field sets, or port SubNavSlot.tsx into office/web/src/ui/ and write office copies of PartyModal/ProductsScreen/ProductEditorScreen. screens/ is not covered by the shared-ui workstream — the two panels have different api clients — so any screen shared between them is a second hand-maintained copy, exactly like PartyAccessScreen. Name that cost or do not delete the drawers.
- **major**: ORDER BY exact_prefix DESC sorts NULLs FIRST in Postgres. exact_prefix = (product_code ILIKE ? OR name ILIKE ? OR alias ILIKE ?) evaluates to NULL whenever the name does not match and product_code or alias is NULL (false OR NULL = NULL). Those non-matching rows sort above the true exact-prefix matches — the exact inverse of the stated intent, and the design's own 'exact prefix outranks fuzzy at limit=1' test would fail.
  - FIX: COALESCE(p.product_code ILIKE ?, false) OR COALESCE(p.name ILIKE ?, false) OR COALESCE(p.alias ILIKE ?, false) AS exact_prefix, or ORDER BY exact_prefix DESC NULLS LAST.
- **major**: pfx = term + '%' is an unescaped ILIKE pattern. A term containing % or _ — '600x600_', '100%' — becomes a wildcard and boosts the wrong rows silently. Real product codes and tile sizes in this domain contain both.
  - FIX: Escape backslash, % and _ in the term before appending '%', and add ESCAPE '\\' to each ILIKE.
- **major**: Empty-term behaviour is undefined. prefixTsQuery returns null for an empty or punctuation-only term; to_tsquery('simple', NULL) is NULL and search_vector @@ NULL is NULL, so no row matches. The design's idle state ('pinned then recent then Type to search') and the include branch both depend on rows coming back with no term, and it does not say how.
  - FIX: Branch explicitly: when prefixTsQuery returns null, run an include-ids-only query (no tsquery, no ranking, ORDER BY name). Do not paper over it with a NULL-safe tsquery expression.
- **major**: The include branch is ANDed with is_active AND deleted_at IS NULL, so a currently-selected product that was since deactivated or soft-deleted still vanishes from the listbox — contradicting the stated reason include exists ('a selection never vanishes mid-edit').
  - FIX: Structure the WHERE as: tenant_id = ? AND ((is_active AND deleted_at IS NULL AND search_vector @@ q) OR id = ANY(?)). Party scope stays ANDed over the whole thing — an include id must never bypass partyScopeSql.
- **major**: forward()'s non-unreachable error branch is duplicated THREE times in office/src/http/app.ts, not two: forward (1127-1167), forwardCsv (1169-1217) and forwardFile (1219-1265). Extracting failForward() for forward and the new pick route leaves the other two duplicated — a fix at the call site where the duplication is shared.
  - FIX: Extract failForward(res, error) once and call it from all four sites (forward, forwardCsv, forwardFile, pick).
- **major**: A static 'catalog' nav parent with Products/Parties children directly contradicts an explicit rule written into master/web/src/ui/AppShell.tsx:24-30: 'Never a second static tier of modules: the sidebar is a map of where you can go, and burying a module inside another module makes it a worse one.' children exists only for subNav. Worse, the design adds 'products'|'parties' to Tab (App.tsx:56) but not 'catalog', so clicking the parent nav item falls through the switch at App.tsx:515-563 and renders undefined — a blank content area.
  - FIX: Add two flat items to workItems: { id: 'products', … } and { id: 'parties', … }, gated on products.view / parties.view. Tab gains 'products' | 'parties'. The full-page product editor still uses useSubNav under the products item, which is what children is for.
- **major**: PickKind 'user' cannot serve the Recycle Bin filter. master/src/services/user.service.ts:43 listUsers requires 'users.manage'; the deleted-by Select is gated on 'recycleBin.viewAll' (RecycleBinScreen.tsx:101). A person with viewAll but not users.manage has a working filter today and would get a 403 after the change.
  - FIX: Drop the 'user' pick kind. Replace withDeleters with a server-side facet on the recycle-bin endpoint (distinct deleted_by plus names — recycle-bin.repository.ts:309 already resolves deleter names in bulk), gated on the same recycleBin.viewAll the screen already checks. Keep the native Select, now populated from the whole set instead of the pages fetched so far. That fixes the correctness bug the design correctly identified, at a lower rung and with no permission regression.
- **major**: Office's report export path is untouched. office/src/http/app.ts:641 forwards report:export through forwardCsv, which casts the ack to { csv: string } and unconditionally sets Content-Type: text/csv with filename ${report}.csv. format=xlsx or format=pdf from an office panel returns a corrupt file. The socket contract (shared/src/protocol/socket.ts) and hub.ts:510 also carry the CSV-only ack shape.
  - FIX: Widen report:export's ack to the { fileName, contentType, bytes } shape forwardFile already handles (or a discriminated union), route the office export through forwardFile for non-csv, and pass format/columns/groupBy/totals/paperSize/orientation through office's parseReportQuery.
- **major**: A remote party Picker in office AddLeadScreen loses the view-only exclusion. AddLeadScreen.tsx:115-133 deliberately drops parties granted at level 'view' with a comment explaining it exists so the picker does not walk somebody into a 403. partyScopeSql defaults level to 'view' and would return them.
  - FIX: partyScopeSql already takes a fourth argument: partyScopeSql('pa.id', tenantId, scope, 'manage'). Add an access?: 'view' | 'manage' field to PickQuery and pass it through; AddLeadScreen sends 'manage'. The existing parameter does the job — no new mechanism.
- **major**: The remote picker drops outbox-provisional rows. local-store.ts applyOverlay creates provisional parties and products from queued party.create / product.create mutations, so today's office pickers can find a party created thirty seconds ago while offline. A remote /api/pick answered by the master, which has never seen those mutations, cannot.
  - FIX: Office's /api/pick/:kind must merge overlay-only rows (those whose id is not in the master's answer) from forCurrentUser(getView()) into every response, online and offline, scored with the same scorePick, and mark them so the UI can show a pending dot.
- **major**: Virtualising an editable grid unmounts the focused cell. useRowWindow slices rows; a LineGrid built on it destroys the input under the caret as soon as it scrolls past the window edge, and paste-from-Excel writing 'downward, growing rows' will do exactly that. DataTable gets away with windowing because its cells are read-only.
  - FIX: LineGrid does not window. A voucher is tens of lines, not thousands. useRowWindow is still worth extracting for DataTable + the tab-persistence seam, but LineGrid renders every row.
- **minor**: Wrong test filenames and conventions. The existing suite is master/tests/search.integration.test.ts, not search.test.ts. DB-backed suites use the .integration.test.ts suffix and skip when no Postgres cluster is available (master/tests/helpers/db.ts); a plain master/tests/pick.test.ts would hard-fail on any machine without one.
  - FIX: master/tests/pick.integration.test.ts and master/tests/report-export.integration.test.ts; extend master/tests/search.integration.test.ts. shared/tests/pick-score.test.ts and office/tests/local-pick.test.ts stay pure.
- **minor**: The Select inventory is miscounted. There are 25 <Select> sites; three are converted, so 22 stay native, not 20. Five of the 'stays native' entries are office files (LeadDetail.tsx:68, OrderBoardScreen.tsx:436, ProductDetail.tsx:259, CustomFields.tsx:38, AddLeadScreen.tsx:537) and are not marked as such.
  - FIX: Correct the count and label the panel each path belongs to.
- **minor**: Field cannot be 'a thin wrapper over FormField adding span'. FormField (Form.tsx:33-56) renders the .ob-field div itself and takes children: (id) => ReactNode; a wrapper cannot put data-span on that div, and the inline-label density variant needs .ob-field itself to become a grid.
  - FIX: Say which: Field renders an outer <div data-span> around FormField (so .ob-fieldgrid > [data-span] targets the wrapper), and the inline variant is a CSS rule .ob-fieldgrid[data-labels='inline'] .ob-field { display: grid; grid-template-columns: 7.5rem 1fr; align-items: center }.
- **minor**: api.pick(kind, query, signal) needs request<T> to forward the signal, which the design does not state. master/web/src/api.ts:152 request<T> spreads init, so { signal } passes through — but it also sets Content-Type: application/json on GETs, which is harmless but worth not copying into a new hot path.
  - FIX: State that pick calls request<T>(path, { signal }); no change to request<T> is required.
- **minor**: Rebuilding SearchBox on Picker is a poor fit. Universal search returns SearchHit[] across four kinds and navigates to a screen; Picker's value: T / onSelect fills a form, and recentsKey, onCreate and pinning are meaningless for it.
  - FIX: Keep SearchBox as its own component but move it onto .ob-* classes, the shared 150ms debounce and the shared AbortController, and route office's topbar hits (office/web/src/App.tsx:536-540 currently only clears the box). Do not force it through Picker's contract.
- **minor**: base.css:1704-1710's comment on .ob-modal widths still cites the 1366x768 floor, and claims the largest 'leaves the list visible either side'. The new floor is 1024x768, where an 840px .ob-modal--lg leaves ~90px of gutter.
  - FIX: Update the comment when adding .ob-modal--lg's new tenant, or the next reader trusts a false claim about the floor.
- **minor**: exceljs is a rung too high on the first pass. lib/csv.ts already writes CSV (with a formula-injection guard) and pdf/primitives.ts + pdf/fonts.ts already render paginated PDF with vendored faces. Excel opens CSV. The dependency buys number formats and a frozen header row.
  - FIX: Keep xlsx in scope (the owner rejects narrowed scope) but sequence it last, behind csv and pdf, and behind the office binary-forward fix — otherwise it ships as a corrupt download on the office panel.

## Corrected design

## D — Searchable dropdowns everywhere, dense master forms, grid voucher entry, report layouts

**Verdict.** One `Picker` component replaces `Combobox` and the two genuinely unbounded native selects, fed by a new `GET /api/pick/:kind` that reuses the existing tsvector + GIN index with a prefix-capable tsquery and returns whole masked entities, so selecting fills a form with no second round trip. `searchKind()` is deleted (verified dead: the only references are its own definition and a stale `master/dist` artefact). Two structural facts govern everything below: `master/web/src/ui/` and `office/web/src/ui/` are hand-mirrored, and `master/tests/party-access-screen-parity.test.ts` already pins one screen byte-identical across both panels — so this workstream writes into **both** trees today rather than waiting on a shared package.

### 0. What exists, and the one live bug

The index is right. `20260302000000_lead_order_rebuild.ts:587-657` gives products weight A to `name`+`product_code`, B to `alias`+`sin`, C to `size`/`grade`/`series`/`product_type`, and parties A to `name`+`party_code`, B to `phone`+`alt_phone`, C to `email`+`city`. `ts_rank`'s default `{D,C,B,A} = {0.1,0.2,0.4,1.0}` gives the required ordering with no migration. **This workstream adds no column, table, index or trigger.** The hand-maintained array in `master/src/db/migrations/index.ts`, its `DELIBERATELY_LAST` pin and the `SHIPPED` list in `master/tests/migration-registry.test.ts` are untouched, and `master/tests/helpers/fixtures.ts` `DATA_TABLES` needs no entry.

Two things are missing.

**(a) Prefix matching.** `websearch_to_tsquery('simple','gla')` matches nothing until the word is complete. Add to `master/src/repositories/search.repository.ts`:

```ts
export function prefixTsQuery(term: string): string | null {
  const tokens = term.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return tokens.length === 0 ? null : tokens.map((t) => `${t}:*`).join(' & ');
}
export function likePrefix(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
}
```

**(b) A live data bug.** `search.repository.ts:92` and `:110` filter only `is_active`, but `softDeleteProduct` (`product.repository.ts:188-208`) and `softDeleteParty` (`party.repository.ts:91-109`) set `deleted_at` and leave `is_active` alone, while `baseQuery` (`product.repository.ts:25-33`) filters `deleted_at` for every list. Soft-deleted products and parties are in universal search **today**. Add `AND p.deleted_at IS NULL` / `AND pa.deleted_at IS NULL` to both existing branches, in the shared query — not in the new pick path only.

### 1. The pick endpoint

`pickProducts` / `pickParties` in `search.repository.ts` return full rows so the service can mask them.

```sql
SELECT p.*, c.name AS category_name,
       ts_rank(p.search_vector, q) AS rank,
       (COALESCE(p.product_code ILIKE ? ESCAPE '\', false)
     OR COALESCE(p.name         ILIKE ? ESCAPE '\', false)
     OR COALESCE(p.alias        ILIKE ? ESCAPE '\', false)) AS exact_prefix
  FROM products p
  LEFT JOIN product_categories c ON c.id = p.category_id
  CROSS JOIN LATERAL to_tsquery('simple', ?) q
 WHERE p.tenant_id = ?
   AND ((p.is_active AND p.deleted_at IS NULL AND p.search_vector @@ q)
        OR p.id = ANY(?))
 ORDER BY exact_prefix DESC NULLS LAST, rank DESC, p.name ASC
 LIMIT ?
```

Bindings `[pfx, pfx, pfx, tsquery, tenantId, includeIds, limit + 1]`, matching placeholder order. `= ANY(?)` with a JS array is the binding form already used at `backup.repository.ts:237`; an empty array binds as `{}` and is simply false. `COALESCE` + `NULLS LAST` is load-bearing: `false OR NULL` is `NULL`, and `DESC` in Postgres defaults to NULLS FIRST, which would sort non-matching rows *above* exact prefix hits. `limit + 1` is fetched so `truncated` is honest. The include branch sits **outside** the active/deleted guards so a selected row never vanishes mid-edit, but **inside** the tenant and party guards.

When `prefixTsQuery` returns `null` (empty or punctuation-only term) the repository runs a separate include-only query: no tsquery, no ranking, `ORDER BY name`. That is what makes the picker's idle pinned/recent state work.

Parties add `partyScopeSql('pa.id', tenantId, scope, level)` verbatim, exactly as `search.repository.ts:103` does. The level argument already exists on that function; `PickQuery` carries `access?: 'view' | 'manage'` and office's Add Lead passes `'manage'`, preserving the view-only exclusion `AddLeadScreen.tsx:115-133` documents. Products are not party-scoped; the catalogue is company-wide.

Service functions go in `catalog.service.ts` beside `listProducts` (:241) and `listParties` (:46): `requirePermission(actor,'products.view'/'parties.view')`, `clampLimit(query.limit, {defaultLimit:20,maxLimit:50})`, `resolvePartyScope(actor)`, and `maskProduct(row, canSeeRates(actor))` from `master/src/domain/visibility.ts`. **There is no `maskParty` and none is needed** — parties carry no money field.

Wire contract, in `shared/src/domain/entities.ts` beside `SearchHit` (:747-758) and `shared/src/domain/inputs.ts` beside `SearchQuery` (:263):

```ts
export type PickKind = 'product' | 'party';
export interface PickRow<T> { id: RecordId; title: string; subtitle: string | null; meta?: string; rank: number; pending?: true; value: T }
export interface PickPage<T> { rows: PickRow<T>[]; truncated: boolean; source: 'master' | 'local' }
export interface PickQuery { term: string; limit?: number; partyId?: RecordId; include?: RecordId[]; access?: 'view' | 'manage' }
```

Only two kinds. `'lead' | 'order'` are served by the existing `api.leads({search})` / `api.orders({search})`; `'user'` is dropped — `listUsers` requires `users.manage` while the Recycle Bin filter is gated on `recycleBin.viewAll`, so a pick kind there is a permission regression.

Route in `data.routes.ts` after the `/search` handler (:166-185), plus `kinds` parsing on `/search` so `SearchQuery.kinds` is finally reachable. Socket parity: `'pick:query'` beside `'search:query'` in `shared/src/protocol/socket.ts:424` and `hub.ts:423`, using the same `run(ack, (actor) => …)` wrapper. `master/tests/socket-contract.test.ts` pins only `ServerToClientEvents`, so a client→server addition is safe.

**New message keys.** `'validation.pick.kind.unknown'` and `'validation.reports.column.unknown'` must be added to `shared/src/i18n/en.ts` **and** `shared/src/i18n/hi.ts` — `shared/tests/i18n-coverage.test.ts` asserts Hindi is total and placeholder-identical. Neither string may contain a 3+ digit run or `₹`; the same test forbids both.

### 2. Office, offline

`office/src/http/app.ts` gains `GET /api/pick/:kind` beside `/api/search` (:438). It does not use `forward()`, whose 503-on-unreachable is the behaviour being replaced. First, extract `forward`'s non-unreachable branch as `failForward(res, error)` and call it from **all four** sites — `forward` (:1127), `forwardCsv` (:1169), `forwardFile` (:1219) and pick. Three copies exist today, not two.

The handler asks the master, falls back to the local snapshot when unreachable, and in **both** cases merges outbox-provisional rows:

```ts
const local = forCurrentUser(await localStore.getView());   // never getView() raw
```

`forCurrentUser` (`app.ts:1036`) is what applies `withoutAnotherPersonsParties` and `maskProduct/maskLead/maskOrder/maskVariant`. Passing the raw view — as a naive fallback would — leaks another person's restricted parties and leaks `rate` to an actor without `field.saleRate.view`. The offline path also checks `userSession.sessionPermissions()` for `products.view` / `parties.view` and returns `{rows: [], truncated: false, source: 'local'}` when absent: that is the offline stand-in for the master's `requirePermission`.

The merge matters online too. `local-store.ts` `applyOverlay` creates provisional parties and products from queued `party.create` / `product.create` mutations. A party created offline and still in the outbox is invisible to the master, so office merges overlay-only rows (ids absent from the master's answer) into every response, flagged `pending: true`.

`shared/src/domain/pick-score.ts` holds the one scorer both the office server and the browser use, so ordering matches online and off:

```ts
export const PICK_WEIGHTS = { a: 1.0, b: 0.4, c: 0.2, d: 0.1 } as const;
export function scorePick(term: string, fields: { text: string | null; weight: number }[]): number | null;
```

Tokenize both sides on `/[^\p{L}\p{N}]+/u`; exact field-token match scores `weight`, prefix match `weight * 0.6`, `+0.5` when the first field starts with the whole raw term (the SQL's `exact_prefix` boost); `null` when any query token matches nothing, and the caller drops the candidate. Exported from `shared/src/index.ts`.

Honest cost: the office snapshot is capped at `SNAPSHOT_LIMIT = 500` per collection (`snapshot.service.ts:34`). Offline the picker sees only those 500 plus the outbox. The listbox renders a `--state-offline` footer saying so. Raising the cap is the sync workstream's call.

### 3. The Picker component

`ui/Picker.tsx`, written **byte-identically into both `master/web/src/ui/` and `office/web/src/ui/`**, replacing `ui/Combobox.tsx` in both (they are already byte-identical). `PartyAccessScreen.tsx` must be edited identically in both panels or `master/tests/party-access-screen-parity.test.ts` fails, and that test's own header says the fix is to copy one file over the other — never to patch one side.

```tsx
export interface PickerSource<T> { fetch(term: string, signal: AbortSignal): Promise<PickPage<T>> }
export function localSource<T>(rows: PickRow<T>[]): PickerSource<T>;   // scorePick in-process
export function Picker<T>(props: {
  source: PickerSource<T>; value: PickRow<T> | null; onSelect(row: PickRow<T>): void;
  onCreate?(term: string): void; recentsKey?: string; placeholder?: string;
  autoFocus?: boolean; inputRef?: RefObject<HTMLInputElement>; disabled?: boolean; invalid?: boolean;
}): JSX.Element;
```

150ms debounce, replacing the two that exist (`SearchBox.tsx:41` 200ms, `office/App.tsx:316` 180ms). Every fetch carries an `AbortController` aborted by the next keystroke and by unmount; a resolved response whose signal is aborted is dropped — the out-of-order class of bug `request<T>` (`api.ts:152`) cannot prevent today. `api.pick(kind, query, signal)` passes `{ signal }` straight into `request<T>`, which already spreads `init`; no change to `request<T>` is needed.

Keyboard: ↓/↑ move, Home/End jump, PageUp/Down ±8, Enter selects the active row, **Tab selects and advances** (the Miracle/Excel muscle memory that makes grid entry fast), Escape closes, second Escape clears, Alt+↓ opens on recents, Ctrl+Enter fires `onCreate(term)` (also the last row, "Create 'X'"), Ctrl+P pins.

Recents and pins are per-machine muscle memory of the same class as theme and density, so they live in `localStorage` next to `ob.theme.v2` (`ui/theme.ts`): `ob.pick.recent.<kind>` (last 8 ids + titles, MRU) and `ob.pick.pinned.<kind>`. Pinned ids ride in `include` so they stay resolvable and current. No table: a server-side recents store would need a migration, sync and a permission for something nobody asked to share. The cost — lost on profile reset, per-browser — is real and stated.

States: idle shows pinned, then recent, then "Type to search"; loading shows `BusyMark` inside the input's right edge with the **previous results still readable**; empty shows "No match for X" plus create; error shows a one-line retry, not `ErrorState`'s full block.

CSS: reuse `.ob-combobox*` (`base.css:1638-1677`), changing `max-height: 240px` (:1647) to `min(40vh, 22rem)` so it scales with `--root-size` and fits a 768px screen. New `.ob-pick-row`, `.ob-pick-group`, `.ob-pick-foot` — into **both** `base.css` copies. New UI strings ("Pinned", "Recent", "Type to search", "No match for {term}", "Create '{term}'", the offline footer) go into **both** `master/web/src/i18n/strings.ts` and `office/web/src/i18n/strings.ts`.

### 4. Which selects change

25 `<Select>` sites exist. **Three become Pickers:** `InventoryScreen.tsx:688` (every product as an `<option>`), `DocumentsScreen.tsx:892` (unbounded lead/order subject; remote source over `api.leads({search})`/`api.orders({search})`, keeping the type rule at :817-822), and `office/web/src/screens/AddLeadScreen.tsx:354/:516` plus `PartyAccessScreen.tsx:409` migrating from `Combobox`, the last in `localSource` mode.

`RecycleBinScreen.tsx:280`'s deleted-by filter has a genuine correctness bug — `withDeleters` (:76-83) builds the option list from pages already fetched, so it silently omits people — but the fix is **not** a user Picker. It stays a native `<Select>`, populated from a new distinct-deleters facet on the recycle-bin endpoint gated on the `recycleBin.viewAll` the screen already checks (`recycle-bin.repository.ts:309` already resolves deleter names in bulk). A pick kind there would demand `users.manage` and 403 people who have a working filter today.

**22 stay native.** Every one is a closed enum, a curated `option_lists` set, a pipeline's stages, or a server-supplied facet. A native select is keyboard- and screen-reader-complete for free, and four of them are in-row controls where a popover fights `DataTable`'s windowing.

`SearchBox.tsx` is **not** rebuilt on `Picker` — universal search returns `SearchHit[]` across four kinds and navigates rather than filling a form, so `recentsKey`, `onCreate` and pinning are meaningless. It keeps its own shape but moves onto `.ob-*` classes, the shared 150ms debounce and the shared `AbortController`, dropping the inline `width: 320`. Office's topbar hits get routed (`office/web/src/App.tsx:536-540` only clears the box today).

### 5. Dense master forms

New `ui/FieldGrid.tsx` in both trees — `FieldGrid`, `FormSection`, `Field`. `Field` renders an outer `<div data-span>` around the existing `FormField` (`Form.tsx:33-56`), because `FormField` owns the `.ob-field` div and a wrapper cannot add an attribute to it. CSS into both `base.css`:

```css
.ob-fieldgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
                gap: var(--s-8) var(--s-16); align-items: start; }
.ob-fieldgrid > * { min-width: 0; }
.ob-fieldgrid > [data-span='2']    { grid-column: span 2; }
.ob-fieldgrid > [data-span='full'] { grid-column: 1 / -1; }
.ob-fieldgrid[data-labels='inline'] .ob-field {
  display: grid; grid-template-columns: 7.5rem 1fr; align-items: center; }
.ob-formsection > .ob-eyebrow { padding-bottom: var(--s-4); border-bottom: 1px solid var(--line); }
.ob-formpage { display: grid; grid-template-columns: minmax(0, 92rem) minmax(0, 1fr);
               gap: var(--s-24); align-items: start; }
@media (max-width: 1200px) { .ob-formpage { grid-template-columns: minmax(0, 1fr); } }
```

`13rem` is the column floor, so the column *count* falls as UI scale rises — exactly what a scale setting should do, with no media query. At the 1024×768 floor with the 208px sidebar the content strip is ~776px → 4 columns; at 4K the grid caps at `92rem` and the surplus goes to `ob-formpage`'s right rail (images, stock, variants, audit). At `[data-density='compact']` the grid sets `data-labels="inline"`, the true Miracle look, buying back a row of vertical space.

Tab order is DOM order is visual order (`auto-fill` is row-major; nothing uses `tabIndex > 0`). One `onKeyDown` capture handler gives Enter-advances-to-next-field; textareas keep Enter, Ctrl+Enter saves. Validation renders through the existing `FieldError` (`Form.tsx:25-31`) on blur and submit, never on keystroke; a section with errors shows a count chip; submit focuses the first invalid control.

**Allocation.** *Party* → centred modal, `.ob-modal--lg` (840px, `base.css:1726`; `.ob-modal` carries `max-width:100%`, so it fits the 1024 floor — update the stale 1366 comment at :1704-1710), one `FieldGrid` with Identity / Contact / Address sections covering all 14 columns. *Product* → its own screen: `ProductsScreen.tsx` (DataTable list, row-open showing a read-only `FieldGrid` in an `ob-modal--lg` per the standing rule) plus `ProductEditorScreen.tsx` published through `useSubNav({parentId:'products', …})` exactly as `AccessScreen.tsx:147` does.

Nav: **two flat items** in `workItems` (`App.tsx:351`) — `products` and `parties`, gated on `products.view` / `parties.view` — not a static `catalog` parent. `AppShell.tsx:24-30` states the rule outright: children exist for a large operation opened out of a module, "never a second static tier of modules". `Tab` (`App.tsx:56`) gains `'products' | 'parties'` and the switch (`App.tsx:515-563`) gains both cases; a parent with no case would render a blank content area.

**Office keeps its drawers.** `office/web/src/components/ProductDrawer.tsx` and `PartyDrawer.tsx` are used by `CatalogScreen.tsx` (both, create and edit), `PartyDetail.tsx`, `ProductDetail.tsx` and `AddLeadScreen.tsx:570`. Deleting them breaks four screens, and the master replacement cannot be reused: `office/web/src/ui/` has no `SubNavSlot.tsx`, and `screens/` is not covered by the shared-ui workstream because the two panels have different `api` clients. Instead: port `SubNavSlot.tsx` into `office/web/src/ui/`, convert both office drawers **in place** to the same `FieldGrid` sections inside `Modal` (per the standing centred-modal rule), widening ProductDrawer from 8 fields to the full set and PartyDrawer from 5 to 14. That is the change that matters — the drawer-vs-modal container is secondary to the field coverage.

### 6. Grid voucher entry

New `ui/LineGrid.tsx` in both trees. First extract the windowing and the trailing-filler `gridTemplate` out of `DataTable.tsx:50-95` into `ui/useRowWindow.ts` with an optional external `scrollTop`/`onScrollTop` — the seam the tab-persistence workstream needs, since table scroll is component state at `DataTable.tsx:50` today and dies with the screen. **`LineGrid` does not use it.** A voucher is tens of lines; windowing an editable grid unmounts the input under the caret the moment it scrolls out, and paste-from-Excel grows rows downward straight past the window edge.

Reused from `ColourQuantityGrid.tsx`: the ↑/↓ ±1 / Shift ±10 stepper (:146-159), the keep-the-typed-text-not-the-parsed-number rule (:71-82, the reason ₹12.50 can be typed at all), and the totals-footer shape (:190-203). New: horizontal Tab/Shift-Tab across cells wrapping to the next row; auto-add a blank row when Tab or Enter leaves the last cell of the last row (uncommitted, dropped on save); an item-lookup cell that is simply a `Picker` in `edit()`; a sticky totals footer showing boxes, taxable value and grand total.

Paste-from-Excel reads `text/plain`, splits `/\r?\n/` then `/\t/`, and writes from the focused cell rightward and downward. Excel emits TSV and quotes only cells containing tabs or newlines — product codes and quantities do not — so a CSV parser is the wrong tool. Picker columns resolve by exact `product_code` through the existing `GET /api/products/by-code/:code` (`data.routes.ts:243`), one deduplicated request per unresolved code; unresolved codes flag the row rather than dropping it.

Per-cell validation via `column.validate`, rendered as `aria-invalid` plus a `--state-conflict` left border with the reason in a `Tooltip`; save blocked while any cell is invalid, first offender scrolled to and focused. Validation message keys are plain strings resolved by the web `t()` and added to **both** web dictionaries — the web `t(key: string)` is untyped and unrelated to shared's `MessageKey`.

Undo: a `useState<R[][]>` ring of the last 50 whole-row snapshots pushed on commit (blur/Enter/paste), Ctrl+Z / Ctrl+Shift+Z. Fifteen lines, no library.

Party-wise rate mode: the grid takes `rateFor(productId)` built from the same `variantsForParty` map `AddLeadScreen.tsx:103-113` already computes. This fixes a live inconsistency — today toggling `partyWiseMode` or changing the party affects only lines added afterwards, because `lineFrom` (:163) runs once per add. `DraftLine` gains `rateTouched: boolean`; on party or toggle change every untouched line is re-rated and a one-line note says how many changed. Typed rates are never overwritten.

### 7. Report exports

Promote `CSV_HEADERS` (`report.service.ts:179-183`) into `shared/src/domain/reports.ts` as `REPORT_COLUMNS: Record<ReportKind, readonly ReportColumnDef[]>`, modelled on `buildFieldCatalogue()` (`fields.ts:71`). `ReportColumnDef` carries `{ key, label: string, align, type: 'text'|'int'|'money' }` — `label` is a plain string added to both web dictionaries, not a shared `MessageKey`, because the frontend does not read shared's catalogue. `ReportLayout` carries `columns`, `groupBy?`, `totals`, `page.{paperSize,orientation}`, `format: 'csv'|'pdf'|'xlsx'`, persisted per-machine under `ob.report.layout.<kind>`.

**Redaction rule: the money column stays, its cells go empty.** `master/src/lib/csv.ts`'s header states it — "A redacted money column is an empty cell, never `0`" — and `master/tests/reports.integration.test.ts:196-199` pins `lines[0] === 'month,orderCount,boxCount,totalValue'` with an empty trailing cell for a rate-blind actor. Absent-key is the JSON wire rule (`shared/src/domain/visibility.ts`), not the tabular one. Dropping the column would break that test and make the design's own byte-identical-CSV compatibility pin unsatisfiable. csv emits `''`, xlsx a blank cell, pdf an em dash.

`report.routes.ts`'s `/:report/export` gains `?format=&columns=&groupBy=&totals=&paperSize=&orientation=`, defaulting to `format=csv` with today's columns so the existing `api.reportExportUrl` + `ButtonLink` (`ReportsScreen.tsx:242`) keeps working. A `columns` value not in `REPORT_COLUMNS[kind]` is a `ValidationError` naming the field. `GET /api/reports/catalogue` returns `REPORT_COLUMNS`. `recordActivity` (`report.service.ts:213-227`) gains `format` and column count; `reports.export` stays the only gate.

**Office must be widened or the export is corrupt.** `office/src/http/app.ts:641` routes `report:export` through `forwardCsv`, which casts the ack to `{csv: string}` and always sets `text/csv` with `${report}.csv`. Widen the `report:export` ack in `shared/src/protocol/socket.ts` and `hub.ts:510` to a discriminated union — `{kind:'csv', csv, rowCount}` or `{kind:'file', fileName, contentType, bytes}` — route non-csv through the existing `forwardFile`, and pass the layout params through office's `parseReportQuery`. Without this the office panel serves a PDF labelled `dispatches.csv`.

PDF: `master/src/pdf/table-renderer.ts` exporting `renderTablePdf(model, options)`, reusing `registerFonts` (`pdf/fonts.ts`), `mm`, `runText`, `runTextRight`, `truncateToWidth`, `horizontalRule`, `pageFooter` (`pdf/primitives.ts:23-234`) and the `bufferPages` idiom (`renderer.ts:66-71`) so "Page 1 of N" works. It does not go through `renderPdf`: `DocumentColumnKey` (`domain/document-model.ts:29-37`) is a closed eight-member union whose closedness keeps a rate column out of a rate-blind PDF.

Spreadsheet: add `exceljs` to `master/package.json`. The no-CDN constraint governs what the *browser* fetches; a server-side npm dependency is vendored into the packaged app. SheetJS is rejected — npm's `xlsx` is frozen at 0.18.5 with CVE-2023-30533 and CVE-2024-22363, and current builds ship only from `cdn.sheetjs.com`. **Sequence xlsx last**, behind csv and pdf and behind the office binary-forward fix: `lib/csv.ts` and `pdf/primitives.ts` already exist and Excel opens CSV, so the dependency buys number formats and a frozen header row and nothing more. Ship it, but not first.

### 8. Files

**shared** — `domain/entities.ts` (PickKind, PickRow, PickPage, isPickKind), `domain/inputs.ts` (PickQuery), `domain/pick-score.ts` (new), `domain/reports.ts` (ReportColumnDef, REPORT_COLUMNS, ReportLayout, isReportColumn), `protocol/socket.ts` (`pick:query`; widen `report:export` ack), `index.ts` (export pick-score), `i18n/en.ts` + `i18n/hi.ts` (two new validation keys, both files).

**master server** — `repositories/search.repository.ts` (prefixTsQuery, likePrefix, pickProducts, pickParties, `deleted_at` guard on both existing branches), `services/search.service.ts` (delete `searchKind`), `services/catalog.service.ts` (pickProducts/pickParties), `services/pick.service.ts` (new, two-kind dispatcher), `http/routes/data.routes.ts` (`GET /pick/:kind`; `kinds` on `/search`; distinct-deleters facet on the recycle-bin route), `realtime/hub.ts` (`pick:query`; `report:export` ack), `http/routes/report.routes.ts`, `services/report.service.ts`, `services/report-export.service.ts` (new), `pdf/table-renderer.ts` (new), `package.json` (exceljs).

**office server** — `http/app.ts` (`GET /api/pick/:kind` merging `forCurrentUser(getView())` overlay rows and gating on `sessionPermissions()`; `failForward()` extracted and used by all four forwarders; layout params + binary path on the report export route), `sync/local-pick.ts` (new).

**both web trees, written identically** — `ui/Picker.tsx` (new), `ui/Combobox.tsx` (deleted), `ui/useRowWindow.ts` (new), `ui/DataTable.tsx`, `ui/FieldGrid.tsx` (new), `ui/LineGrid.tsx` (new), `ui/base.css`, `i18n/strings.ts`, `screens/PartyAccessScreen.tsx` (byte-identical — parity test), `api.ts` (`pick`, `reportCatalogue`, layout-aware `reportExportUrl`). Plus `office/web/src/ui/SubNavSlot.tsx` (ported from master).

**master web only** — `App.tsx` (Tab, two flat nav items, two switch cases), `components/SearchBox.tsx`, `screens/ProductsScreen.tsx` (new), `screens/ProductEditorScreen.tsx` (new), `screens/PartiesScreen.tsx` (new), `screens/InventoryScreen.tsx`, `screens/RecycleBinScreen.tsx` (facet-fed Select; delete `withDeleters`), `screens/DocumentsScreen.tsx`, `screens/ReportsScreen.tsx`.

**office web only** — `screens/AddLeadScreen.tsx` (two Pickers with `access:'manage'`; the Card stack at :379-489 becomes one LineGrid; `rateTouched` re-rating), `components/ProductDrawer.tsx` and `components/PartyDrawer.tsx` (converted in place to full-field FieldGrid modals, **not deleted**), `screens/CatalogScreen.tsx`, `screens/PartyDetail.tsx`, `screens/ProductDetail.tsx` (call-site updates), `App.tsx` (route the topbar search hits).

### 9. Tests

`master/tests/search.integration.test.ts` (extend): `prefixTsQuery('gla ser') === 'gla:* & ser:*'`; a product "Glazed Serene" is returned for `gla ser` and "Matte Ivory" is not; a soft-deleted product (`deleted_at` set, `is_active` still true — the exact state `softDeleteProduct` leaves) is absent from `/api/search` and `/api/pick/product`. That last one fails against today's code.

`master/tests/pick.integration.test.ts` (new): a party restricted to user A is absent from user B's `/api/pick/party` and present for a `party.accessAll` holder, and an unassigned party is present for both; `access:'manage'` excludes a view-only grant; an exact `product_code` prefix outranks a higher-`ts_rank` fuzzy match at `limit=1` **and** outranks a row whose `product_code` and `alias` are both NULL (the NULLS-FIRST regression); a `%` in the term does not act as a wildcard; an actor without `field.saleRate.view` gets `PickRow.value` with the `rate` key **absent**; `include` ids return even with no term, and a soft-deleted included id still returns; `truncated` is true exactly when more rows exist than `limit`.

`shared/tests/pick-score.test.ts` (new, pure): `scorePick` returns null when any token matches nothing; an A-weight hit outscores a C-weight hit; whole-term prefix wins a tie.

`office/tests/local-pick.test.ts` (new): with the master unreachable, `/api/pick/product` answers 200 with `source:'local'` instead of 503; returns nothing for a party the current session must not see (reuse the `withoutAnotherPersonsParties` fixture from `office/tests/snapshot-masking.test.ts`); omits `rate` for a session without `field.saleRate.view`; returns `[]` when the session lacks `products.view`; and includes an outbox-provisional party flagged `pending` even when the master **is** reachable.

`master/tests/report-export.integration.test.ts` (new): `/api/reports/dispatches/export` with no query params is byte-identical to today's output for both a rate-permitted and a rate-blind actor; a `columns` value outside `REPORT_COLUMNS[kind]` is a `ValidationError` naming the field; `format:'xlsx'` with a `groupBy` produces subtotal rows that sum their group, with money columns present and blank for a rate-blind actor.

Existing suites to re-run and expect green: `master/tests/party-access-screen-parity.test.ts`, `master/tests/reports.integration.test.ts`, `shared/tests/i18n-coverage.test.ts`, `master/tests/socket-contract.test.ts`, `master/tests/migration-registry.test.ts`, `office/tests/snapshot-masking.test.ts`.

### 10. Dependencies and what this is not doing

Blocks on the `columnsFrom()` fix in `product.repository.ts:323-346` and `party.repository.ts:252-267`. Both write every column unconditionally with `?? null`, so `updateProduct`/`updateParty` are full replaces. Widening the office drawers to every field makes today's data-loss bug *invisible* rather than fixed — a partial write from sync or the API still nulls columns. Land the repository patch first.

Coordinates with tab-persistence (`useRowWindow`'s external `scrollTop` is the seam; both workstreams edit the `Tab` union at `App.tsx:56`) and with keyboard shortcuts (Picker owns `/`, Alt+↓, Ctrl+Enter, Ctrl+P; LineGrid owns Ctrl+Z/Ctrl+Shift+Z — all registered in the central keymap, and none may collide with Cmd/Ctrl+K).

Not doing: routing `searchKind()` — it is verifiably dead and the pick path needs whole entities. Not converting the other 22 native selects. No server-side recents/pins table. No saved/shared report layouts. Not widening `DocumentColumnKey` for reports. Not using SheetJS. Not hand-rolling a ZIP+OOXML writer. Not touching `.ob-search{width:260px}` or `.ob-drawer{width:520px}` — they belong to the responsive workstream; only `.ob-combobox-listbox`'s 240px cap moves here because the picker owns that rule. No migration: nothing here adds a column, table or index, so the migration registry, the `DELIBERATELY_LAST` pin, the `SHIPPED` list and `fixtures.ts` `DATA_TABLES` are all untouched.