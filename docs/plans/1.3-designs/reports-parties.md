# Design: Reports expansion (15 kinds, counts/pieces/boxes/kg only), Excel/PDF exports with translated labels, shared Reports screen on both panels, per-tier visibility and owner scoping enforced in the service, and party CSV/XLSX import and export in a fixed format

> Written before the code (2026-10-01). Where it disagrees with docs/plans/1.3-BATCH-DETAIL.md, the integrated plan wins.

## Overview

The owner gets one Reports module on both panels. It moves from master/web to ui/src/ReportsScreen.tsx and talks to the server through a ReportsTransport. It covers 15 report kinds in four groups: Sales (user-wise, party-wise, area-wise, product-wise pieces), Dispatch (the existing Dispatches report, dispatch register, boxes dispatched, top parties), Pipeline (pending-order outcomes, stage-wise pipeline with ageing, date-wise volume, pending order register, follow-ups due or overdue) and Audit (conflicts summary, activity per user). Every figure is a count, pieces, boxes, kg or days. There is no money anywhere.

Each kind appears as a sidebar sub-page. Its filter row is generated from shared REPORT_META:
- a period (adds 'This financial year' and custom From/To dates)
- a user picker, rendered only when the actor may report on others
- party, city, state and product text filters
- stage, plus the kind-specific group by, interval, basis and follow-up choices

Every kind renders the same way: KPI tiles from the totals, then a paged DataTable of 200 rows with 'Show more'. While a refetch runs, the previous table stays on screen under a loading bar.

Export buttons: CSV (the default, still byte-identical for the three legacy kinds), Excel (.xlsx through the existing exceljs buildXlsxTable, with translated headers) and PDF (renderReportPdf, with translated headings). 'Preview PDF' hands the PDF blob to the printroom/notes domain's preview sub-screen.

The server is one generic path:
- the new socket command report:table, with the REST route GET /api/reports/table/:report;
- the new report:options, which returns the user list, the stage list, the offered kinds and canReportOnOthers;
- the existing report:export, widened with an 'xlsx' arm and a locale.

The Office forwards all of these live and answers 503 offline. The screen turns a 503 into a clear "Reports need the Master" state that retries by itself when the link comes back.

Access is decided once, in master/src/services/report.service.ts, so REST, the socket and the Office forwarding are all gated together. The steps are:
1. Hold reports.view.
2. Pass the per-tier company switches reports.visibleToOffice and reports.visibleToManagement (Normal Admin and Server Master always pass).
3. Resolve the subject. Office and Management are forced to owner_id = self; asking for anyone else is a 403. Admin may pick anyone, including other admins. Server Master may pick anyone.
4. Apply party scope (partyScopeSql), which also still applies to everyone.

DateRange gains a required ownerId, so no report query can forget the owner filter, just as none can forget scope today. The same rule lives as pure functions in shared/src/domain/report-access.ts, which both App.tsx files, the Basic Home tile and the palette use to show or hide Reports. The switches travel as optional CompanyFeatures fields and refresh live through the existing 'setting' snapshot-forcing path.

Party import/export uses a fixed 12-column spec in shared/src/domain/party-import.ts (Party code, Name, Phone, Alt phone, Email, Address 1, Address 2, City, State, Pincode, GSTIN, Notes). It reads CSV with a UTF-8 BOM or xlsx, and offers a template and an export of every party the actor can see.

Import works like this:
- It does a dry-run preview first, with modes 'create only' or 'update by party code'.
- Row-numbered issues can be downloaded as a CSV.
- Writes go in chunked transactions.
- It writes one activity row (party_list.imported) and publishes one new 'party_bulk' change, which is snapshot-forcing. Exports log party_list.exported.
- It runs through partyImportRoutes(actorOf), mounted on the Master's dataRoutes ahead of /parties/:id and on /api/panel. The Office proxies it with masterFetch, exactly as product import does.
- The UI is a PartyImportModal built on an ImportDialog extracted from ProductImportModal. The Master PartiesScreen and the Office Catalog parties tab get an Export menu (CSV / Excel) and an Import button.

One add-only migration restores the owner_id indexes that 20260303 silently dropped (STRUCTURE §5.11 item 21) and adds an activity_log (tenant_id, actor_id, created_at) index.

## decisions

- Report catalogue = 15 kinds: the 3 existing (dispatches, lead-outcomes, top-parties) unchanged plus user-summary, party-summary, area-summary, product-summary, box-summary, stage-pipeline, volume, dispatch-register, pending-register, follow-ups, conflicts-summary, activity-summary. Every owner bullet is covered, and each kind is one SQL function; secondary tables of the old bespoke views (dispatch by colour, top cities) are now box-summary groupBy=colour and area-summary, so the screen renders every kind through one generic ReportTable and the three bespoke views are deleted.
- Units are never mixed in a column: pieces come from line_items.quantity (product-summary, registers, user/party/area), boxes only from stock_movements outbound (dispatches, box-summary, dispatch-register 'Boxes' column), weight is kg (orders: COALESCE(total_weight_kg_override,total_weight_kg); leads: SUM(line weight_kg*quantity)), ages are whole days in the business time zone.
- Lead cohort rule reused from leadOutcomesByMonth: pending-order counts are anchored on leads.created_at in range and classified converted/lost/quiet/open by the same SQL CASE (shared helper string in report.repository.ts); final-order counts anchored on orders.dispatched_at in range (matches dispatchesByMonth/topParties). avgDaysToConvert = mean(converted_at::date - created_at::date) over the cohort's converted leads, 1 dp.
- Unranged ('as of now') kinds: stage-pipeline, pending-register, follow-ups — the period control is absent for them and ReportTable.range is null.
- New periods: 'thisFinancialYear' (1 April of the current Indian FY to the current month; always <= 12 months) and 'customDates' (fromDate/toDate inclusive YYYY-MM-DD, cap 366 days; volume interval=day further capped at 93 days). Existing month periods and their validation are unchanged.
- Generic transport instead of one socket command per kind: report:table {report, query} -> ReportTable and report:options -> ReportOptions. The three legacy socket events and REST routes stay for mixed-version Offices but no screen calls them any more.
- Owner scope lives on DateRange as a REQUIRED ownerId: string|null (null = everyone) so the compiler forces every one of the six existing and all new repository functions to apply it — the same reasoning the file already gives for scope.
- Who may report on others: shared mayReportOnOthers(tier) = tierRank(tier) >= tierRank('admin'), read from actor.permissions.tier (PermissionSet already carries tier — no ActorContext change needed). Server Master ranks above admin once the roles domain appends it to ROLE_TIERS, so it is covered with no extra code. Office/Management asking for another ownerId -> ForbiddenError('reports.view','error.reports.ownOnly'); a self-only actor with no signed-in user (unattended Office panel) -> ForbiddenError('reports.view','error.reports.signInRequired').
- Visibility settings: new SETTING_GROUP 'reports' with two boolean settings reports.visibleToOffice and reports.visibleToManagement, fallback true (an upgraded install behaves exactly as before: reports.view alone decides). Gate = reports.view AND tier switch, enforced in the service (403 'error.reports.hiddenForTier') and mirrored by shared reportsOffered() in both shells, Basic Home tile and palette. Configured only on the Master Settings > Company tab (rendered generically); the Office Settings screen does not show them.
- Conflicts summary additionally requires sync.resolveConflicts (admin-tier); kinds are filtered by shared offeredReportKinds(permissions) for the sidebar and by the service for options/table/export.
- Activity summary buckets actions into fixed columns (created, updated incl. stage_changed, deleted, restored, dispatched, exported, signIns, other, total) instead of raw entity/action strings, scoped by actor_id = subject and partyScopeLogSql; it reads activity_log only and writes nothing to it.
- Screen paging: 200 rows per page (max 1000) with SQL window aggregates (count(*) OVER (), sum(...) OVER ()) so totals and totalRows cover the whole result while only one page crosses the wire — keeps 3-4 GB PCs and the Office socket light. Exports are unpaged with a hard cap REPORT_EXPORT_MAX_ROWS=20000 (PDF 5000) refused with validation.reports.tooManyRows asking to narrow the range.
- Formats: ReportFormat becomes 'csv'|'xlsx'|'pdf'; CSV default stays byte-identical for the three legacy kinds (keys header, no BOM, no totals). New kinds' CSV uses the same keys header but is prefixed with a UTF-8 BOM so Excel reads non-ASCII party names. XLSX and PDF use translated column labels. Excel numbers are real numeric cells; kg 3 dp.
- Export file names: CSV of legacy kinds keeps '<kind>.csv'; everything else '<kind>_<from>_<to>.<ext>' (unranged: '<kind>_<today>.<ext>').
- Exports download through fetch + saveBlob (transport.exportReport) on both panels — never a ButtonLink — so an offline Office never navigates the window onto a JSON 503.
- PDF preview: the ReportsScreen 'Preview PDF' button is rendered only when the shell passes onPreviewPdf(blob, fileName, title), supplied by the printroom/notes-pdf domain's preview sub-screen; 'Download PDF' always available with reports.export.
- No auto-refresh on the Office (manual Refresh + automatic refetch when the Master link returns); the Master keeps revision-driven refetch via SCREEN_ENTITIES.reports (add 'party_bulk').
- Office Reports nav: no Alt chord (Alt+1..9 are taken by the Basic Home mockup order); reachable from sidebar, Basic Home tile and Ctrl+K palette. Master keeps its existing reports chord as re-laid out by the shell domain.
- Report permissions: no new keys. reports.view/reports.export are added to ROLE_TEMPLATES 'Dispatch' (office tier) so a new office role starts with them; existing Office/Management roles are NOT auto-granted (no-wildcard rule) — an admin ticks them in the role editor.
- Party import/export permissions: import + template need parties.bulk (management tier) and parties.create, upsert additionally parties.edit plus party access at 'manage' per updated party; export needs parties.view + parties.export (the existing 'Export parties' key, which keeps also gating the party-access CSV — both are party exports). No new keys, no grant migration.
- Party fixed format: exactly 12 English headers (not translated), matched case/space-insensitively with a few aliases (e.g. 'GST number'/'GST' -> GSTIN, 'Party name' -> Name, 'Code' -> Party code); unknown headers are ignored and listed. Custom fields are NOT in the fixed format; an update leaves a party's custom fields untouched (updatePartyColumns patch of the 11 fixed columns only).
- Party code policy: codes are assigned only by party_code_seq. Blank code = create. A code matching a live party the actor may manage = skipped in 'create only', updated in 'update by code' (or 'unchanged' if identical). A code that is unknown or not editable by this actor = row error 'validation.partyImport.unknownCode' (one message for both so an out-of-scope party's existence is not disclosed).
- Duplicate-name policy: a blank-code row whose trimmed, case-insensitive Name + City equals a live party's is skipped (import.skip.partyExists); the same Name + City twice in the file = error on the later rows; the same code twice in the file = error on the later rows. Same name in a different city is created (names are not unique in the business).
- Party import limits: MAX_PARTY_IMPORT_BYTES 10 MB, MAX_PARTY_IMPORT_ROWS 10000, issues capped at 1000; cells longer than 500 chars are a row error. Online-only over HTTP multipart (never the outbox or a socket frame).
- Party import change event: a new ChangedEntity 'party_bulk' (SNAPSHOT_FORCING, REQUIRED_PERMISSION parties.view, in DASHBOARD_ENTITIES) instead of reusing 'catalog', because 'catalog' is gated on products.view and a parties-only user/panel would miss the refresh; per-row 'party' events would flood the 2000-slot change ring.
- Party audit: one activity row per import (entityType 'party_list', action 'imported', details {count, created, updated, fileName, mode}) and per export ('party_list','exported', {count, format}); entityType 'party_list' is deliberately not 'party' so partyScopeLogSql does not hide it for lack of a matching parties row.
- Import dialog reuse: extract the body of ui/src/ProductImportModal.tsx into a generic ui/src/ImportDialog.tsx (pick -> dry-run preview -> run, issues CSV, template/export buttons); ProductImportModal keeps its exact props/DOM as a thin wrapper and PartyImportModal is a second thin wrapper. The Office's own duplicate office/web/src/components/ProductImportModal.tsx is left alone (out of domain).
- Party export toolbar control: an 'Export' button opening the existing ui Popover with 'CSV (.csv)' and 'Excel (.xlsx)'; 'Import' button only with parties.bulk + parties.create.

## dataModel

- 20261005000000_report_indexes.ts (master/src/db/migrations, ADD-only, every statement IF NOT EXISTS, raw SQL like 20260401000000_order_vehicle_number.ts): CREATE INDEX IF NOT EXISTS idx_leads_owner_created ON leads (tenant_id, owner_id, created_at) WHERE deleted_at IS NULL; CREATE INDEX IF NOT EXISTS idx_orders_owner_dispatched ON orders (tenant_id, owner_id, dispatched_at) WHERE deleted_at IS NULL AND dispatched_at IS NOT NULL; CREATE INDEX IF NOT EXISTS idx_activity_log_actor_created ON activity_log (tenant_id, actor_id, created_at). down(): DROP INDEX IF EXISTS for the three. Restores the owner indexes 20260303 dropped (STRUCTURE §5.11 #21). Appended to master/src/db/migrations/index.ts and pinned at the end of DELIBERATELY_LAST in master/tests/migration-registry.test.ts (after whatever the other domains of this batch append — order among them is irrelevant, no dependency).
- No new tables, no new columns, no backfill. Reads only existing columns: leads(owner_id, party_id, stage_id, created_at, updated_at, converted_at, converted_order_id, follow_up_date, deleted_at), orders(owner_id, party_id, stage_id, lead_id, dispatched_at, vehicle_number, total_weight_kg, total_weight_kg_override, deleted_at), line_items(parent_type, parent_id, quantity, weight_kg, product_name, category_name, category_code, brand_name, code, variant_label, colour, grade), stock_movements(outbound, quantity_boxes, reference_type='order'), product_variants/products/product_categories (box-summary names), pipeline_stages(name, sequence, is_terminal)+pipelines(kind), parties(name, party_code, city, state), users(display_name)+roles(tier), sync_conflicts(losing_device_code, entity, created_at, resolved_at)+office_panels(device_code, name), activity_log(actor_id, actor_name, action, created_at).
- Optional column from the PO-numbering domain: the registers read the pending-order number via leads (dispatch-register joins orders.lead_id -> leads). Column name to be whatever that domain ships (assumed leads.po_number TEXT NULL); until it exists the poNumber column is omitted.
- Settings rows: none written by migration (absent row = fallback true).

## permissions

- No new permission keys and no grant migration.
- reports.view (existing, no tier ceiling) — every report read; AND-ed with the per-tier visibility switch in the service.
- reports.export (existing) — CSV/XLSX/PDF export and PDF preview.
- sync.resolveConflicts (existing, MINIMUM_TIER admin) — additionally required for kind conflicts-summary.
- parties.export (existing) + parties.view — party records export (CSV/XLSX); continues to gate the party-access CSV too.
- parties.bulk (existing, MINIMUM_TIER management, previously unused) + parties.create — party import and template; + parties.edit and per-party manage access for 'update by code'.
- ROLE_TEMPLATES 'roleTemplate.dispatch' (office tier) gains reports.view and reports.export (template prefill only, not seeded rows; Sales already has them).
- Report scope is tier-based, not a key: mayReportOnOthers(actor.permissions.tier) — admin and server_master (rank >= admin) may choose any user incl. other admins; office/management are self only.

## interfaces

- shared/src/domain/reports.ts: ReportKind widened to the 15 ids; REPORT_KINDS widened (isReportKind unchanged); LEGACY_REPORT_KINDS = ['dispatches','lead-outcomes','top-parties']; ReportPeriod += 'thisFinancialYear' | 'customDates'; ReportRangeInput += fromDate?, toDate? ('YYYY-MM-DD', customDates only); ReportColumn += unit?: ReportUnit ('text'|'date'|'count'|'pieces'|'boxes'|'kg'|'days'); ReportFormat = 'csv'|'xlsx'|'pdf' (isReportFormat updated); ReportExportOptions += locale?: Locale.
- shared/src/domain/reports.ts new: interface ReportQuery extends ReportRangeInput { ownerId?, party?, city?, state?, product?, brand?, stageId?, groupBy?, interval?: 'day'|'week'|'month', basis?: 'dispatched'|'booked', pipeline?: 'lead'|'order', followUp?: 'overdue'|'today'|'due'|'next7'|'all', limit?, offset? }; interface ReportTable { kind; range: ReportRange|null; columns: ReportColumn[]; rows: Array<Record<string,string|number|null>>; totals: Record<string,number>|null; totalRows: number; offset: number; limit: number; subject: {userId: string; displayName: string}|null; descriptionParams?: Record<string,string|number> }; interface ReportOptions { canReportOnOthers: boolean; kinds: ReportKind[]; users: Array<{id; displayName; roleTier: string; isActive: boolean}>; stages: Array<{id; name; pipeline:'lead'|'order'}> }; REPORT_META: Record<ReportKind, {group:'sales'|'dispatch'|'pipeline'|'audit'; titleToken; descriptionToken; ranged: boolean; filters: readonly ReportFilter[]; groupBy?: readonly string[]; requires?: Permission}>; reportColumns(kind, query): ReportColumn[] (REPORT_COLUMNS kept as-is for legacy kinds); parseReportQuery(raw: Record<string,unknown>): ReportQuery and reportQueryParams(query): URLSearchParams (one serializer/parser for both servers and both web clients; drops unknown enum values, trims, caps text at 100 chars).
- shared/src/domain/report-access.ts new (pure): mayReportOnOthers(tier: string|null|undefined): boolean; reportsVisibleForTier(tier, features: Pick<ResolvedCompanyFeatures,'reportsVisibleToOffice'|'reportsVisibleToManagement'>): boolean (office/management read their switch; any other tier true); reportsOffered(permissions, tier, features): boolean; offeredReportKinds(permissions): ReportKind[].
- shared/src/domain/party-import.ts new: PARTY_IMPORT_COLUMNS (field, header, aliases, required, text) fixed order; PARTY_IMPORT_HEADERS; MAX_PARTY_IMPORT_BYTES=10MB, MAX_PARTY_IMPORT_ROWS=10000, MAX_PARTY_IMPORT_ISSUES=1000; PartyImportMode = 'create'|'upsert'; PartyImportIssue = ProductImportIssue (alias); PartyImportResult = { dryRun, mode, fileName, totalRows, created, updated, unchanged, skipped, failed, issues, issuesTruncated, ignoredColumns, sample: PartyInput[] }.
- Socket C->S (shared/src/protocol/socket.ts ClientToServerEvents): 'report:table': ({report: ReportKind, query: ReportQuery}, ack: CommandAck<ReportTable>); 'report:options': (ack: CommandAck<ReportOptions>); 'report:export' payload query type widened to ReportQuery & ReportExportOptions and ack union becomes {format:'csv'; csv; rowCount} | {format:'pdf'|'xlsx'; fileName; contentType; bytes: Uint8Array; rowCount}. Legacy report:dispatches/leadOutcomes/topParties unchanged (kept for older Offices). No new S->C pushes.
- ChangedEntity += 'party_bulk' (SNAPSHOT_FORCING_ENTITIES; fan-out REQUIRED_PERMISSION 'parties.view'; DASHBOARD_ENTITIES); published once per non-dry-run party import with payload {created, updated} and id = tenantId.
- Master REST (master/src/http/routes/report.routes.ts, every handler with needs()): GET /api/reports/options (reports.view); GET /api/reports/table/:report?<reportQueryParams> (reports.view); GET /api/reports/:report/export now accepts every kind, format=csv|xlsx|pdf, and all ReportQuery filters (reports.export). Legacy GET /dispatches, /lead-outcomes, /top-parties also accept the new filters (ownerId etc.).
- Master REST party import (partyImportRoutes(actorOf) in master/src/http/routes/panel-catalog.routes.ts): GET /parties/import/template.:format (csv|xlsx), GET /parties/export.:format, POST /parties/import (multipart file, dryRun, mode). Mounted on dataRoutes BEFORE '/parties/:id' (else GET /parties/export.csv is captured as an id) and on /api/panel via panelCatalogRoutes (requirePanel).
- Office server (office/src/http/app.ts): GET /api/reports/options -> forward 'report:options'; GET /api/reports/table/:report -> forward 'report:table' with shared parseReportQuery; /api/reports/:report/export passes format via isReportFormat (fixes the hard-coded pdf-only branch), lang and filters, and branches csv vs file; the three legacy forwards switch to parseReportQuery. Party: GET ['/api/parties/import/template.:format','/api/parties/export.:format'] and POST /api/parties/import proxied with masterFetch to /api/panel/... (the product proxy handlers generalised into two helper functions), 503 error.unavailable when the Master is off.
- Web api members (identical names on master/web/src/api.ts and office/web/src/api.ts): reportOptions(), reportTable(kind, query, signal?), exportReport(kind, query, {format, columns?, totals?, paperSize?, orientation?, locale}) -> {blob, fileName} (Master requestFile, Office fetchBlob); partyImportTemplate(format), exportParties(format), importParties(file, {dryRun, mode}). Removed: dispatchReport, leadOutcomeReport, topPartiesReport, reportExportUrl, reportRangeQuery (no callers after the move).
- ui transports: ReportsTransport { reportOptions(signal?); reportTable(kind, query, signal?); exportReport(kind, query, options) } in ui/src/ReportsScreen.tsx; PartyImportTransport { partyImportTemplate; exportParties; importParties } in ui/src/PartyImportModal.tsx. Adapters: master/web/src/transports.ts (reportsTransport, partyImportTransport), office/web/src/reportsTransport.ts (new), office/web/src/partyFormTransport.ts (adds partyImportTransport).
- Interface offered to other domains: reportsOffered()/offeredReportKinds() (shell, Basic Home tile, palette); ReportsScreen prop onPreviewPdf?(blob, fileName, title) consumed from the printroom/notes PDF preview domain.

## settings

- SETTING_GROUPS += 'reports' (shared/src/domain/settings.ts) with heading token settingGroup.reports in en.ts.
- SETTINGS['reports.visibleToOffice'] = { labelToken 'setting.reports.visibleToOffice.label' ('Show Reports to Office users'), descriptionToken '.help', group 'reports', control boolean, fallback true, parse asBoolean }.
- SETTINGS['reports.visibleToManagement'] = same shape, 'Show Reports to Management users', fallback true.
- CompanyFeatures (shared/src/domain/entities.ts) += reportsVisibleToOffice?: boolean; reportsVisibleToManagement?: boolean (optional per wire-optionality); companyFeatures() in master/src/services/company-features.ts reads both by name; ResolvedCompanyFeatures/resolveCompanyFeatures fill from SETTINGS fallbacks.
- Writes stay settings.manage on the Master (PUT /api/settings/:key); not added to PANEL_WRITABLE_SETTINGS. A change publishes 'setting' -> Office resnapshot + Master refreshUser(), so the nav/tile hide or appear live.

## uiScreens

- ui/src/ReportsScreen.tsx (new, shared; replaces master/web/src/screens/ReportsScreen.tsx which is deleted): props {transport: ReportsTransport (held in transportRef), permissions, tier, kind, onKindChange, revision?, online?, onPreviewPdf?}. Page header (title + kind description), a kind Select grouped by optgroup Sales/Dispatch/Pipeline/Audit, filter row generated from REPORT_META.filters (period Select + month/date inputs only for ranged kinds; 'User' Select with 'Everyone' + users only when options.canReportOnOthers, otherwise an ob-small 'Your figures' caption; party/city/state/product text inputs debounced with useDebounced 300 ms; stage Select; groupBy/interval/basis/pipeline/followUp Segmented), KPI tiles from totals (up to 4 numeric columns), DataTable with right-aligned numeric columns and unit suffix labels, 'Show more' paging, SkeletonRows on first load, loading bar + AbortController on refetch (no AbortSignal.any — Chromium 108), ErrorState 'Reports need the Master' for code 'unavailable' with retry, field-level range errors as today. Actions (absent without reports.export): Export menu (Popover: CSV / Excel / PDF), Preview PDF (only if onPreviewPdf), Refresh. Ctrl+F focuses the party text input (data-screen-search).
- ui/src/ImportDialog.tsx (new, shared generic extracted from ProductImportModal: pick -> dry-run preview -> run, template/export buttons, issues table + issues CSV, size checks). ui/src/ProductImportModal.tsx becomes a thin wrapper with identical props and DOM. ui/src/PartyImportModal.tsx (new thin wrapper; sample table columns Code, Name, City, State, Phone; mode Segmented 'Add new only' / 'Add new and update by party code').
- ui/src/index.ts: export * from './ReportsScreen.js', './ImportDialog.js', './PartyImportModal.js'.
- Master master/web/src/App.tsx: ScreenSpec 'reports' renders <ReportsScreen transport={reportsTransport} .../> from @orderbook/ui; canViewReports = reportsOffered(user.permissions, user.roleTier, companyFeatures); reports subPages = offeredReportKinds(permissions).map(kind -> {key: kind, label: t(REPORT_META[kind].titleToken)}); SCREEN_ENTITIES.reports += 'party_bulk'; SCREEN_ENTITIES.records/leadEntry/parties/partyAccess += 'party_bulk'; onPreviewPdf wired to the PDF-preview domain's sub-screen.
- Master master/web/src/screens/PartiesScreen.tsx toolbar: 'Export' Popover (CSV/Excel; with parties.view+parties.export) and 'Import' button (parties.bulk+parties.create) opening PartyImportModal; on import -> refetch + toast.
- Office office/web/src/App.tsx: Tab += 'reports'; nav item 'Reports' (icon 'calendar' as on Master) in the Work group when can('reports.view') && reportsVisibleForTier(session.roleTier, resolveCompanyFeatures(view?.features)); subPages.reports = offeredReportKinds(permissions); ScreenSpec renders ui ReportsScreen with officeReportsTransport, online={connection.state==='connected'}; no Alt chord (palette + sidebar + Basic Home tile).
- Office office/web/src/screens/CatalogScreen.tsx parties tab toolbar: same Export Popover and Import button as the Master, using partyImportTransport; Import/Export disabled-by-absence is not used — when offline the buttons stay and the dialog/toast says the Master is unreachable (online-only, like product import).
- Basic Home tile 'Reports' (both panels) and command-palette entry: rendered by the shell domain using reportsOffered(); icon 'calendar' gradient tile in the Work group.
- Master Settings > Company tab: new 'Reports' heading with the two switches — rendered generically by CompanySetting, no screen code change.
- eslint.config.js: add ui/src/ReportsScreen.tsx, ui/src/ImportDialog.tsx, ui/src/PartyImportModal.tsx to the orderbook-i18n/no-untranslated-jsx-text swept list.

## steps

### 1. 1. Shared wire types, catalogue and pure access rules

Files: `shared/src/domain/reports.ts`, `shared/src/domain/report-access.ts`, `shared/src/domain/party-import.ts`, `shared/src/domain/product-import.ts`, `shared/src/index.ts`, `shared/src/domain/permissions.ts`

Widen ReportKind/REPORT_KINDS/ReportPeriod/ReportFormat/isReportFormat; add ReportUnit, ReportQuery, ReportTable, ReportOptions, REPORT_META (group, title/description tokens, ranged, filters, groupBy lists, requires), reportColumns(kind, query) (REPORT_COLUMNS untouched for legacy kinds), parseReportQuery/reportQueryParams. New report-access.ts: mayReportOnOthers (tierRank >= admin, unknown tier false), reportsVisibleForTier, reportsOffered, offeredReportKinds. New party-import.ts with the fixed 12-column spec, aliases, limits, PartyImportMode/Issue/Result (Issue aliases ProductImportIssue). Export all from shared/src/index.ts. Add reports.view/reports.export to roleTemplate.dispatch.

### 2. 2. Settings + CompanyFeatures for per-tier visibility

Files: `shared/src/domain/settings.ts`, `shared/src/domain/entities.ts`, `shared/src/domain/company-features.ts`, `master/src/services/company-features.ts`

Add SETTING_GROUPS 'reports' and the two boolean SETTINGS (fallback true). Add optional CompanyFeatures.reportsVisibleToOffice/reportsVisibleToManagement, read them by name in companyFeatures(), resolve them in resolveCompanyFeatures. No migration.

### 3. 3. Index migration

Files: `master/src/db/migrations/20261005000000_report_indexes.ts`, `master/src/db/migrations/index.ts`, `master/tests/migration-registry.test.ts`

Three CREATE INDEX IF NOT EXISTS (leads owner+created partial, orders owner+dispatched partial, activity_log tenant+actor+created); down drops them. Append to the registry array and to the end of DELIBERATELY_LAST.

### 4. 4. Range resolution

Files: `master/src/domain/report-range.ts`, `master/tests/report-range.test.ts`

Add 'thisFinancialYear' (FY start = April of today.year if month>=4 else April of year-1, to today's month) and 'customDates' (parse YYYY-MM-DD, validate from<=to, cap 366 days, toDateExclusive = to+1 day computed with pure component arithmetic, months = spanned months). Keep MAX_RANGE_MONTHS for month periods. New validation keys validation.reports.range.dateInvalid / dateRequired / tooManyDays.

### 5. 5. Repository: owner on DateRange + all new SQL

Files: `master/src/repositories/report.repository.ts`, `master/src/repositories/party-access.repository.ts`

DateRange gains required ownerId: string|null; the six existing functions append `AND <alias>.owner_id = ?` when set (orders.owner_id for dispatches/colour/top parties, l.owner_id for lead outcomes). Private helpers: filtersSql(aliases, filters) for party (p.name ILIKE or p.party_code ILIKE), city/state (lower(btrim()) equality), product/brand (EXISTS line_items ILIKE on product_name/category_name/category_code/code/brand_name), stageId; LEAD_OUTCOME_CASE string shared with leadOutcomesByMonth; pagedWindow() adding count(*) OVER () and sum() OVER () columns + LIMIT/OFFSET. New functions (all take DateRange or an unranged {tenantId, scope, ownerId} + filters, all apply partyScopeSql): userSummary, partySummary, areaSummary(groupBy city|state), productSummary(groupBy brand|product|subProduct|colour|grade, basis dispatched|booked; pieces = SUM(li.quantity), weight = SUM(li.weight_kg*li.quantity)), boxSummary(groupBy product|subProduct|colour; SUM(-m.quantity_boxes) on outbound movements of orders dispatched in range), stagePipeline(pipeline lead|order; open leads converted_order_id IS NULL / orders dispatched_at IS NULL; count, pieces, kg, ageing buckets 0-7/8-15/16-30/31+, oldest days on created_at), volume(interval; generate_series of buckets in tz, LEFT JOINs for leads created, leads converted_at, orders dispatched, pieces, kg; zero-filled), dispatchRegister(per order: dispatched date, order id, PO number when present, party, city, owner name, vehicle_number, pieces via LATERAL line sum, kg COALESCE(override,total), boxes via LATERAL movements), pendingRegister(open non-terminal leads: created date, lead id, PO number, party, city, owner, stage, age days, follow_up_date, followUpState computed in SQL against today in tz, pieces, kg; followUp filter overdue|today|due|next7|all; follow-ups kind = due default, ordered by follow_up_date), conflictsSummary(per losing_device_code+entity with office_panels name: raised in range, resolved in range, open now), activitySummary(per actor_id with action buckets; partyScopeLogSql). Positional bindings with tenant first, half-open ranges, AT TIME ZONE exactly as the file header prescribes.

### 6. 6. Service: access, table builder, exports

Files: `master/src/services/report.service.ts`, `master/src/lib/spreadsheet.ts`, `master/src/pdf/table-renderer.ts`, `master/src/repositories/user.repository.ts`

Add assertReportsVisible(actor) (requirePermission reports.view; getSetting per tier via reportsVisibleForTier; ForbiddenError('reports.view','error.reports.hiddenForTier')), resolveSubject(actor, requestedOwnerId) (mayReportOnOthers -> requested or null; else self or ForbiddenError ownOnly / signInRequired), assertKindAllowed (REPORT_META.requires). Existing dispatchReport/leadOutcomeReport/topPartiesReport call these and pass ownerId (behaviour unchanged for admin actors). New reportOptions(actor) (users via userRepo.listUsers includeDeleted only when canReportOnOthers, else self; stages from pipelines; kinds = offeredReportKinds) and reportTable(kind, query, actor) dispatching to legacy reportRows() for legacy kinds or the new repository functions, clamping limit (default 200, max 1000). exportReport: requirePermission reports.export first (keeps RPT-16), builds rows unpaged with the 20000/5000 caps, label(locale, key) using t(locale, ...) instead of hard-coded 'en', CSV branch unchanged for legacy kinds and BOM-prefixed for new kinds, new 'xlsx' branch via buildXlsxTable (sheetName = translated title truncated to 31 chars, numeric cells, translated headers, totals row), PDF branch adds a preamble (subject, filters, time zone) and translated title; activity details gain subject. ExportedReport union arm widened to 'pdf'|'xlsx'. buildXlsxTemplate gains optional sheetName (default 'Products' — product output unchanged).

### 7. 7. Report routes, hub, protocol

Files: `master/src/http/routes/report.routes.ts`, `master/src/realtime/hub.ts`, `shared/src/protocol/socket.ts`

Replace parseRangeQuery with shared parseReportQuery; add GET /options and GET /table/:report each with needs('reports.view'); export route accepts xlsx and lang (isLocale) and sets Content-Type/Disposition for the file arm. Hub: socket.on('report:table') and socket.on('report:options') via run(ack, ...). socket.ts: declare the two commands and widen report:export payload/ack. Add 'party_bulk' to ChangedEntity and SNAPSHOT_FORCING_ENTITIES.

### 8. 8. Office forwarding

Files: `office/src/http/app.ts`

Use shared parseReportQuery for all report forwards; add /api/reports/options and /api/reports/table/:report forwards (online-only, failForward 503); fix the export branch to pass format through isReportFormat plus lang and filters and to treat any non-csv arm as a file. Generalise the product template/export GET proxy and the import POST proxy into two local helpers and register them for /api/parties/import/template.:format, /api/parties/export.:format and POST /api/parties/import (multer limit MAX_PARTY_IMPORT_BYTES).

### 9. 9. Party import/export domain + service + routes

Files: `master/src/domain/party-import.ts`, `master/src/services/party-import.service.ts`, `master/src/repositories/party.repository.ts`, `master/src/http/routes/panel-catalog.routes.ts`, `master/src/http/routes/data.routes.ts`, `master/src/realtime/fan-out.ts`

Pure domain: matchPartyHeaders (case/space-insensitive + aliases, missing Name refused, ignored list), parsePartyRow (trim, empty->null, 500-char cap, name required), findDuplicatesInFile (code, name+city). Repository: findLivePartiesByCodes(tenantId, codes, scope, 'manage') (scoped via partyScopeSql) and liveNameCityKeys(tenantId). Service: partyImportTemplate(format) (parties.bulk; CSV = BOM + headers, XLSX = buildXlsxTemplate sheetName 'Parties', text columns Party code/Phone/Alt phone/Pincode/GSTIN, Guide sheet), exportParties(format) (parties.view + parties.export; listParties scope-aware limit 100000 with a ponytail comment; one 'party_list.exported' activity row), importParties(file, {dryRun, mode}) mirroring importProducts: permission checks, readSheetRows, header match, row cap, parse, in-file dupes, classify create/skip/update/unchanged/error, dry-run returns before writes, chunks of 200 in db().transaction (nextHlc once, insertParty per row / updatePartyColumns patch of the 11 columns with merged field_hlc), row-by-row replay on chunk failure, then one recordActivity('party_list','imported') as the last statement of its own transaction and one publishChange({entity:'party_bulk'}). Routes: partyImportRoutes(actorOf) beside productImportRoutes; panelCatalogRoutes = Router with both; dataRoutes.use(partyImportRoutes(actorFromRequest)) inserted before the '/parties' handlers. fan-out: REQUIRED_PERMISSION.party_bulk = 'parties.view', DASHBOARD_ENTITIES += 'party_bulk'.

### 10. 10. Shared UI: ImportDialog, PartyImportModal, ReportsScreen

Files: `ui/src/ImportDialog.tsx`, `ui/src/ProductImportModal.tsx`, `ui/src/PartyImportModal.tsx`, `ui/src/ReportsScreen.tsx`, `ui/src/index.ts`, `eslint.config.js`

Extract ImportDialog (generic over sample type) from ProductImportModal without changing ProductImportModal's DOM or props; PartyImportModal wraps it with PartyImportTransport. ReportsScreen as specified in uiScreens: transport in a ref (no-transport-dep), options fetched once per mount, table fetched on kind/filters/revision/online change with AbortController, stale table kept during refetch, exports via transport + saveBlob, locale from ui locale(), Preview PDF only when onPreviewPdf is passed. Export new modules from index.ts; add files to the swept JSX-text lint list.

### 11. 11. Panel wiring (both shells)

Files: `master/web/src/api.ts`, `master/web/src/transports.ts`, `master/web/src/App.tsx`, `master/web/src/screens/ReportsScreen.tsx`, `master/web/src/screens/PartiesScreen.tsx`, `office/web/src/api.ts`, `office/web/src/reportsTransport.ts`, `office/web/src/partyFormTransport.ts`, `office/web/src/App.tsx`, `office/web/src/screens/CatalogScreen.tsx`

api.ts on both: add reportOptions/reportTable/exportReport/partyImportTemplate/exportParties/importParties using reportQueryParams; delete dispatchReport/leadOutcomeReport/topPartiesReport/reportExportUrl/reportRangeQuery. Transports wired. Master App: delete the screens/ReportsScreen.tsx import, render ui ReportsScreen, gate with reportsOffered, subPages from offeredReportKinds, SCREEN_ENTITIES additions, onPreviewPdf from the preview domain. Office App: 'reports' tab, nav item, subPages, ScreenSpec, gating via reportsVisibleForTier(session.roleTier, resolveCompanyFeatures(view?.features)). PartiesScreen and CatalogScreen parties-tab toolbars: Export Popover + Import button + PartyImportModal.

### 12. 12. i18n strings in en.ts

Files: `shared/src/i18n/en.ts`, `shared/tests/activity-tokens.lock.json`

Add: reports.kind.<id> + reports.kind.<id>.description for 12 new kinds; reports.group.{sales,dispatch,pipeline,audit}; reports.column.* for every new column key (labels state the unit, e.g. 'Weight (kg)', 'Pieces', 'Boxes', 'Age (days)'); reports.filter.* (user, everyone, yourFigures, party, city, state, product, stage, groupBy.*, interval.*, basis.*, pipeline.*, followUp.*); reports.followUp.{overdue,today,upcoming}; reports.period.{thisFinancialYear,customDates}; reports.range.{fromDate,toDate}; reports.export.{csv,xlsx,pdf,preview,menu}; reports.offline.{title,description}; reports.showMore; reports.refresh; error.reports.{ownOnly,signInRequired,hiddenForTier}; validation.reports.{tooManyRows,range.dateInvalid,range.dateRequired,range.tooManyDays}; setting.reports.visibleToOffice/Management .label/.help; settingGroup.reports; partyImport.* (title, template hint, export hint, mode labels, sample columns), catalog.parties.{import,export}, import.skip.partyExists, validation.partyImport.{unknownCode,duplicateCodeInFile,duplicateNameInFile,cellTooLong}; activity.party_list.imported ('{actor} imported {count} parties from {fileName}') and activity.party_list.exported ('{actor} exported {count} parties'). Append both activity tokens to the lock file. No price words, no 3+ digit runs.

### 13. 13. Tests and guards

Files: `master/tests/reports.integration.test.ts`, `master/tests/party-import-domain.test.ts`, `master/tests/party-import.integration.test.ts`, `master/tests/party-access.integration.test.ts`, `master/tests/screen-reachability.test.ts`, `master/tests/web-reachability.test.ts`, `master/tests/change-ring.test.ts`, `shared/tests/report-access.test.ts`, `shared/tests/report-query.test.ts`, `ui/tests/reports-screen.test.tsx`, `office/tests/module-forwarding.test.ts`

See 'tests'. Remove PANEL_ONLY.reports and the five ALLOWED_UNCALLED.office report entries; add 'party_bulk' to EVERY_ENTITY.

### 14. 14. Docs

Files: `docs/STRUCTURE.md`, `HANDOFF.md`, `docs/backend-modules/04-API-CONTRACT.md`, `docs/PARTY_IMPORT_FORMAT.md`, `docs/AI_COLLABORATION.md`

STRUCTURE: Reports section (15 kinds, ReportTable, access rule, formats), party import, settings list, migration list entry, §5.11 #21 marked fixed, §5.4 pdf/ used by reports and lead PDF. 04-API-CONTRACT §3/§10: report:table, report:options, export union with xlsx, lang, filters (fix the stale csv-only ack at ~1741). New PARTY_IMPORT_FORMAT.md: the fixed column table, aliases, code/duplicate policies, limits, example rows. HANDOFF: what shipped, that Office/Management roles need reports.view ticked, release-note line about the Office Reports module being online-only.

## tests

- master/tests/reports.integration.test.ts (extend, RPT-19..): owner scoping — an office-tier actor with userId sees only rows where owner_id = self on every kind incl. the three legacy kinds; office/management asking ownerId of someone else -> 403 error.reports.ownOnly; admin-tier actor may ask for another admin's ownerId; a self-only actor with userId null -> 403 signInRequired; visibility switches off -> office (resp. management) get 403 hiddenForTier on table, legacy endpoints and export while admin is unaffected; conflicts-summary refused without sync.resolveConflicts; user-summary counts converted/lost/quiet/open and avgDaysToConvert; product-summary pieces vs box-summary boxes never mixed; dispatch-register carries vehicle_number and the weight override; stage-pipeline ageing buckets; volume day buckets zero-filled across a 23:30 IST boundary; pending-register followUpState overdue/today/upcoming; activity-summary own-only; paging returns totalRows and whole-result totals while rows are one page; xlsx export opens with exceljs with numeric cells; PDF renders (bytes start %PDF); the default CSV of each legacy kind is byte-identical to a golden string captured before the change; export over the cap refused with validation.reports.tooManyRows.
- master/tests/report-range.test.ts (extend): thisFinancialYear on 2026-10-01 -> 2026-04-01..2026-11-01; on 2027-02-10 -> 2026-04-01..2027-03-01; customDates validation (bad format, to<from, >366 days) with field names.
- master/tests/party-access.integration.test.ts (extend PA-8): add an admin-tier actor WITHOUT party.accessAll and confirm reports still exclude the restricted party — the existing office 'outsider' case stays green but is now also explained by owner scoping, so the new case keeps party scope proven.
- master/tests/party-import-domain.test.ts (new, pure): header matching with aliases/case/spaces, missing Name refused, ignored columns listed, cell trimming and 500-char cap, in-file duplicate code and name+city detection with Excel row numbers.
- master/tests/party-import.integration.test.ts (new): template CSV/XLSX headers equal PARTY_IMPORT_HEADERS; export -> re-import in upsert mode = all unchanged; create-only skips existing code and same name+city; upsert updates by code and leaves customFields untouched; unknown code and out-of-scope code give the same error; permissions (parties.bulk, parties.create, parties.edit for upsert, parties.export for export) name the missing key; export excludes parties outside scope; exactly one activity row (party_list.imported) and one 'party_bulk' publish per real import, none on dry run; row cap refused.
- shared/tests/report-access.test.ts (new): mayReportOnOthers for office/management false, admin true, any tier ranked above admin (server_master once appended) true, unknown string false; reportsVisibleForTier truth table; offeredReportKinds hides conflicts-summary without sync.resolveConflicts.
- shared/tests/report-query.test.ts (new): parseReportQuery drops unknown enums, trims and caps text, coerces limit/offset; reportQueryParams round-trips.
- ui/tests/reports-screen.test.tsx (new): user picker absent for an office-tier user and present for admin; 'unavailable' error renders the offline state and refetches when online flips true; Preview PDF absent without onPreviewPdf; export menu absent without reports.export; Excel click calls transport.exportReport with format 'xlsx' and the current locale.
- office/tests/module-forwarding.test.ts (extend): report:table/report:options forwarded with parsed filters; export passes format xlsx and lang and returns a file; offline -> 503 error.unavailable; party template/export/import proxied to /api/panel/parties/* and 503 when the Master is off.
- Existing guards that change deliberately: master/tests/screen-reachability.test.ts (delete PANEL_ONLY.reports — Reports now exists on both panels); master/tests/web-reachability.test.ts (delete ALLOWED_UNCALLED.office reportRangeQuery/dispatchReport/leadOutcomeReport/topPartiesReport/reportExportUrl — members removed; the new members are called via transports); master/tests/migration-registry.test.ts (append to DELIBERATELY_LAST); master/tests/change-ring.test.ts (EVERY_ENTITY += 'party_bulk'); shared/tests/activity-tokens.lock.json (append two tokens); eslint swept list (tooling-config.test.ts checks the paths exist).
- Existing guards that must stay green with no edit: credential-invariants 'guards every Reports route' (every new report route carries needs()); migration-data-safety (CREATE INDEX only); i18n-tokens (literal entityType/action pairs with details covering placeholders); i18n-coverage; company-features-complete; wire-optionality (new CompanyFeatures fields optional); settings.test (new group has heading and members); no-duplicate-ui and no-transport-dep (new ui modules exported, transport in ref); ui/tests/master-catalogue.test.tsx (ProductImportModal DOM unchanged after the ImportDialog extraction); shared tests pinning ROLE_TEMPLATES, if any, updated for the Dispatch template change.

## docs

- docs/STRUCTURE.md — Reports section rewritten (15 kinds, ReportTable path, access rule, formats, caps); party import/export section; settings catalogue (+2, new group); migration table (+1); §5.11 item 21 marked fixed; §5.4 pdf/ note corrected.
- docs/backend-modules/04-API-CONTRACT.md — §3 Reports: report:table, report:options, REST /table/:report and /options, ReportQuery filters, export xlsx arm + lang; fix the stale csv-only report:export ack; party import routes.
- docs/PARTY_IMPORT_FORMAT.md (new) — the fixed column spec, aliases, code and duplicate policies, limits, example CSV, how to open in Excel.
- HANDOFF.md — shipped scope, admin action needed (tick reports.view/export on Office/Management roles; the two Reports switches), Office Reports online-only, no Office Reports Alt chord.
- docs/AI_COLLABORATION.md — note the generic ReportTable pattern (add a kind = REPORT_META + reportColumns + one repository function + tokens).

## risks

- DateRange.ownerId as a required field touches every report construction site; a missed owner predicate in any of the ~15 SQL functions would leak another user's figures to office/management. Mitigated by the per-kind owner-scope integration test looping over REPORT_KINDS.
- Legacy CSV byte-identity: the refactor of exportReport/reportRows must not change header keys, row order, number formatting, BOM or line endings for dispatches/lead-outcomes/top-parties. Capture golden strings before refactoring.
- Office forwarding of xlsx/pdf bytes in the socket ack: the 20000-row cap keeps files to a few MB, but very wide registers should be measured. The hub's maxHttpBufferSize (4 MB) limits inbound frames only.
- The ImportDialog extraction could alter ProductImportModal markup that ui/tests/master-catalogue.test.tsx relies on. Keep the DOM identical and run that suite first.
- Route ordering: if partyImportRoutes is mounted after GET '/parties/:id' on dataRoutes, '/parties/export.csv' answers 404 'Party'. The Office's '/api/parties/:id' only has PUT/DELETE today, but keep the GET proxies registered early.
- Visibility fallback true plus no automatic grant: on upgrade nothing changes for existing roles. The owner may expect Office users to see Reports immediately, but an admin must tick reports.view. This is documented in HANDOFF.
- PO number column naming depends on the numbering domain. The register SQL must follow whatever that domain ships, or the poNumber column is dropped until it does.
- Activity-summary and conflicts queries on large activity_log tables. The new (tenant_id, actor_id, created_at) index covers actor-filtered queries. 'Everyone' over 12 months is a range scan on idx_activity_log_created, which is acceptable at shop scale.
- i18n volume: roughly 150 new keys.
- Mixed versions: an older Office calling report:table on an older Master waits 15 s and then shows a 503. Ship the Master and Office together (critic map). Legacy report events stay so an old Office keeps working against a new Master.
- Party import on a 3-4 GB PC: multer memoryStorage holds up to 10 MB plus parsed rows. This is bounded by MAX_PARTY_IMPORT_BYTES and ROWS, and is far below the product import limits.

## dependsOn

- Roles/tiers domain: append 'server_master' at the END of ROLE_TIERS so tierRank puts it above admin, and carry it in PermissionSet.tier (actor.permissions.tier) and SignedInUser/PanelSession roleTier. mayReportOnOthers then covers Server Master with no extra code. If that domain also ships a canReportOn, it should call shared mayReportOnOthers rather than duplicate the rule.
- PO-numbering domain: the pending-order number column on leads (assumed leads.po_number), which dispatch-register and pending-register display. Reports implementation is sequenced after that migration.
- Shell / Basic Home / Master-UI domain: placing the Reports nav item in the Work group on both panels and the Office nav entry with no Alt chord; MASTER_NAV/OFFICE_NAV and the keys-nav-order test; the Basic Home 'Reports' tile and command-palette entry, gated with reportsOffered(); a shared LoadingBar component if one is introduced (otherwise BusyMark/SkeletonRows); the page-header component used by ReportsScreen.
- Printroom / notes / PDF-preview domain: a preview sub-screen (back button plus nested sidebar entry) that accepts (blob, fileName, title), passed to ReportsScreen as onPreviewPdf. The ReportsScreen button stays absent until it exists.
- Audit/settings domain: coordinate SETTING_GROUPS additions (this domain adds 'reports'), activity-tokens.lock.json appends, and the rule that report reads are not logged (only exports and party imports/exports are).
- Inventory-hide domain: box-summary and the legacy dispatches report keep reading stock_movements, which the owner decision keeps running. No inventory UI is involved.
- Migration coordination: the DELIBERATELY_LAST tail order across this batch's migrations. This domain's migration has no ordering dependency.
- Shared files touched by several domains: shared/src/protocol/socket.ts (ChangedEntity 'party_bulk', report commands), shared/src/i18n/en.ts, both App.tsx files, office/src/http/app.ts, master/src/realtime/hub.ts, master/src/realtime/fan-out.ts and ui/src/index.ts.

## openQuestions

- Should existing Office and Management roles be granted reports.view and reports.export automatically, so the Office Reports module appears on upgrade? The design does not grant them, following the no-wildcard rule, and an admin ticks them in the role editor. Only the Dispatch template for new roles gets them.
- Should custom party fields be included in the party CSV/Excel? The design keeps the format fixed at 12 columns, and an update leaves custom fields untouched.

## effort

About 40 files touched: about 14 new (shared report-access.ts and party-import.ts; master party-import domain and service and the report-indexes migration; ui ReportsScreen, ImportDialog and PartyImportModal; office reportsTransport; 4 new test files and 1 doc) and about 26 modified. That is roughly 3,800-4,500 new lines: about 1,300 SQL and service, 1,100 UI, 600 tests and about 150 i18n keys. Most of the SQL is in report.repository.ts (15 functions). Plan on 3-4 focused sessions: (1) shared types, range, repository and service plus the integration tests; (2) routes, hub, Office forwarding and the shared ReportsScreen wired into both shells; (3) party import/export end to end plus the ImportDialog extraction; (4) guard updates, docs and full suite runs.
