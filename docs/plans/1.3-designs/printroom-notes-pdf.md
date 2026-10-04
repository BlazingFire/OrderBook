# Design: Printroom (+ auto-print station), Dispatch/Filling notes from pending orders, Master PDF export with preview

> Written before the code (2026-10-01). Where it disagrees with docs/plans/1.3-BATCH-DETAIL.md, the integrated plan wins.

## Overview

What the owner gets: a Printroom in both panels. It is a shared print queue where anyone allowed can send an order's Filling note or Dispatch note, and the PC with a printer prints it.

1. Pending-order notes. A pending order's detail header gets the same two buttons a final order has: "Filling note" and "Dispatch note". Both panels get them, gated by leads.export. They open the existing OrderNoteScreen sub-screen. The header label reads "Pending Order No." and shows the PO number. The vehicle number on a pending order is print-only, because leads have no vehicle column.

2. Sending a job. Next to those buttons (on pending and final orders), and inside the note preview, a "Send to Printroom" button opens a small dialog. The sender picks the note kind, copies (1 to 50), a target printroom ("Any printroom" or one online station), an optional vehicle number and an optional short note.
   - The Master builds the frozen note snapshot itself at send time: it calls the same shared buildOrderNote on its own copy of the record, plus the party header and PO number. The printer PC therefore never depends on its own snapshot cap or party scope.
   - The client supplies only the vehicle number, the copies and a free-text note.
   - The send is online-only. An Office with the Master unreachable gets the standard 503 "Master not reachable", and its local Print button still works offline. A queued job printing an hour late on an unattended auto-print PC would waste paper and confuse people.
   - A client-generated requestId makes a timed-out retry return the same job instead of a duplicate.

3. The Printroom screen (shared ui/, one transport per panel).
   - Lists jobs with filters: Queued (with count), Printed, Cancelled, All.
   - Each row shows the sender's avatar, name and a Server Master badge, the PO number and party, note kind, copies, requested time and status.
   - Queued jobs are grouped by sender.
   - Opening a job is a sub-screen with a back button and a nested sidebar entry. It shows the exact sheets through the existing OrderNote renderer, a printer picker, a copies field defaulting to the job's copies, Print, Mark printed / Mark not printed, and Cancel.
   - A sender who only has print.send sees only their own jobs. Holders of print.station see everyone's.

4. Print stations and auto-print. On the desktop shell, a print.station holder can make this PC a print station: choose its printer and turn Auto-print on. Both are stored per PC in localStorage and registered on the Master in print_stations, with a 60 s heartbeat that drives the "online" dot senders see.
   - An App-level PrintStationRunner (not the screen, because hidden screens tear down their effects) reacts to live pushes and to reconnects.
   - For each new queued job addressed to this station or to any station, it atomically claims the job (a 2-minute lease, so two auto-print PCs never print the same job twice), fetches the snapshot, and mounts one print portal.
   - It then prints silently with the requested copies through the shell, marks the job printed with the printer name, and unmounts.

5. Live updates. A dedicated live-only push, print:changed, is gated per recipient the same way emitGatedConflict is. It does not go through publishChange, so it never uses up change-ring slots. It reaches Master browsers over the socket and Office browsers over the SSE relay. Each push bumps a revision that re-fetches the list, the nav badge count and the runner's queue. Reconnects bump the same revision, so nothing is lost while a stream is down.
   - The sender gets a bell notification when someone else prints their job.

6. Electron changes.
   - printPage gains a validated copies option (an integer clamped to 1..50, collated) in electron/lib/print-options.ts, the preload and DesktopBridge.
   - A new savePdf IPC (printToPDF of the print portal, then a native Save dialog) gives every note a "Save PDF" button.
   - Only one note portal ever prints: a printOnly() helper marks the active portal, and a print-CSS rule hides every other one. This also fixes a latent double print, because ScreenHost keeps hidden note screens and their portals mounted.

7. Master PDF export with preview. A path-only PDF window allowlist (isPdfWindowUrl) widens the existing lead-PDF exception to exactly /api/reports/<kind>/pdf with a strictly character-limited query. A new inline route on the Master, proxied by the Office, re-uses exportReport with format pdf.
   - Preview PDF opens in Chromium's built-in viewer, which already has Save and Print, in an Electron child window or in a new tab in a LAN browser.
   - Note PDFs come from savePdf; any list that wants a PDF becomes a report kind (Reports domain).

## decisions

- Snapshot built by the Master, not the client. print.service builds the frozen NoteDocument from its own copy of the lead or order, using shared buildOrderNote and noteDocument() plus the party header. That removes a forged-payload attack surface and a big validator, and the PO number stays authoritative. Only vehicleNumber (cleaned, 20 chars or fewer), copies and note come from the client. The Office calls sync.flush() before forwarding, so a just-edited lead reaches the Master first.
- Sending is online-only (503 'Master not reachable' on an offline Office), not queued in the outbox. A print request is time-sensitive: an hour-late auto-print wastes paper. Printing locally on the sender's own PC keeps working offline.
- Idempotent sends: the client sends a requestId of 32 hex characters, generated with crypto.getRandomValues because randomUUID is missing on insecure LAN-browser origins. UNIQUE(tenant_id, request_id) plus ON CONFLICT returns the existing job, so a 15 s ack-timeout retry never prints twice.
- Two permission keys, not three. print.send (office tier) sends jobs and sees only your own. print.station (office tier) runs a printroom: sees all jobs, prints, marks and unmarks printed, cancels any queued job, registers a station and auto-prints. A separate print.manage was dropped because the person facing the printer is the one who discards junk jobs. Senders may cancel their own queued jobs.
- Sending also requires the note gate of its source: leads.export for a pending order (the same gate as the lead PDF and the new lead note buttons) and orders.export for a final order (unchanged). The service checks both. A station operator sees the frozen sheet without needing party access, because the sender deliberately addressed it to the printroom.
- Pending-order note buttons are gated by leads.export. On a lead, the vehicle number is print-only (onSaveVehicle no-op, no new leads column). The header label is 'orderNote.pendingOrderNo' = 'Pending Order No.'. The final-order label text changes from 'Final Order ID' to 'Final Order No.', because a final order keeps its PO number. The value printed is poNumber ?? record id, and the existing 'not yet synced' tag still shows for temporary ids.
- No activity_log rows for print jobs. print_jobs is its own audit: requested_by/at, printed_by/at/printer and cancelled_by/at. This keeps hot status ticks off the hash-chained, advisory-locked activity log, as the critic warned.
- Retention: rows are kept forever, but the payload of printed or cancelled jobs older than 30 days is set to NULL by one UPDATE piggybacked on each send. There is no scheduler. This bounds the size of the database and backups. ponytail: piggyback purge; move it to the connector-scheduler pattern if sends become rare and the backlog matters.
- Stations: one row per PC. station_key is 'master' (only from a loopback request) or 'panel:<panelId>' (taken from socket.data.panelId), always derived on the server and never trusted from the body. A LAN browser cannot be a station, since it has no silent print or printer list. It can still print manually through window.print(), with a hint to set N copies in the dialog. Online means last_seen_at within 90 s, computed on the server, with a 60 s heartbeat via PUT self.
- Auto-print claim uses a 2-minute lease (claimed_station_id, claimed_at). The UPDATE ... WHERE status='queued' AND (claimed_at IS NULL OR claimed_at < now()-interval '2 min') AND (target_station_id IS NULL OR target_station_id = me) RETURNING decides the race. The runner skips job ids that failed in this session until a person prints them manually.
- A successful manual Print from the job sub-screen auto-marks the job printed. The person can undo it with 'Mark not printed', which takes the job back to queued and clears the printed fields. Cancelled is final.
- Copies: Electron webContents.print copies plus collate, clamped to 1..50 in the main process. OrderNoteScreen also gets a Copies field (default 1), so printPage is always called with {deviceName, copies}. The two shell-test assertions are updated deliberately.
- Live push is a new ServerToClient event, 'print:changed' (PrintJobSummary, no payload), sent through a new change-bus channel (publishPrintJob/onPrintJob), never publishChange. Clients re-fetch on each push and on reconnect instead of merging in place. That is a few requests per minute at shop scale, and it doubles as SSE catch-up.
- No new company settings and no CompanyFeatures fields. Visibility is permission-only ('absent, not disabled'), and the station config is per PC.
- Master PDF preview takes a path-only allowlist approach instead of a token store or an in-app pdf.js viewer. isPdfWindowUrl allows exactly /api/leads/<id>/pdf (no query, as today) and /api/reports/<kind>/pdf with a query limited to [A-Za-z0-9=&%._,:+-]. The new /pdf route always answers application/pdf inline, so a query can never turn the window into anything else. Chromium's viewer supplies Save and Print in Electron and in LAN browsers alike. No new dependency.
- Note PDFs use a new desktop savePdf IPC: printToPDF with preferCSSPageSize, which honours @page A4 margin 0, and then dialog.showSaveDialog. It uses the Electron 21+ printToPDF API, so it works on both Electron 33 and the legacy Electron 22. The browser fallback is window.print(), where Save as PDF is in the dialog.
- Grant migration gives both keys to roles with tier IN ('admin','server_master') (a frozen list, union only). Management and Office roles get them only when an admin ticks them in the grid (the no-wildcard rule). Docs suggest granting print.station to the Office panel's own role on the printer PC, so auto-print keeps running with nobody signed in.
- One migration file holds both tables and the grant, fewer files than the separate-grant precedent. Everything is additive, so migration-data-safety stays green.
- Printroom nav entry: in the Work group after Chatroom on both panels, with no Alt digit because the Office already uses Alt+1..9. It is reachable from the palette, from the Basic Home tile and through Ctrl+Shift+P? No: Ctrl+P is note print. The final chord assignment is left to the UI-shell domain.

## dataModel

- Migration 20261008000000_printroom (master/src/db/migrations/20261008000000_printroom.ts), additive and idempotent (IF NOT EXISTS everywhere); down() drops both tables and is allowed to:
- CREATE TABLE IF NOT EXISTS print_stations (id uuid PK DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), station_key text NOT NULL CHECK (station_key = 'master' OR station_key ~ '^panel:[0-9a-f-]{36}$'), display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60), printer_name text NULL CHECK (char_length(printer_name) <= 200), auto_print boolean NOT NULL DEFAULT false, last_seen_at timestamptz NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, station_key))
- CREATE TABLE IF NOT EXISTS print_jobs (id uuid PK DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), request_id text NOT NULL CHECK (request_id ~ '^[0-9a-f]{16,64}$'), kind text NOT NULL CHECK (kind IN ('filling','dispatch')), source_type text NOT NULL CHECK (source_type IN ('lead','order')), source_id text NOT NULL (permanent LD/OD id after resolveId; no FK, the snapshot stands alone), source_number text NULL (PO number at send time), party_name text NOT NULL, payload jsonb NULL (frozen NoteDocument; NULLed after 30 days once printed/cancelled), copies smallint NOT NULL CHECK (copies BETWEEN 1 AND 50), note text NULL CHECK (char_length(note) <= 200), target_station_id uuid NULL REFERENCES print_stations(id) ON DELETE SET NULL, status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','printed','cancelled')), requested_by uuid NOT NULL REFERENCES users(id), requested_from text NULL (panel device code | 'master' | 'lan'), requested_at timestamptz NOT NULL DEFAULT now(), claimed_station_id uuid NULL REFERENCES print_stations(id) ON DELETE SET NULL, claimed_at timestamptz NULL, printed_by uuid NULL REFERENCES users(id), printed_at timestamptz NULL, printed_station_id uuid NULL REFERENCES print_stations(id) ON DELETE SET NULL, printer_name text NULL, cancelled_by uuid NULL REFERENCES users(id), cancelled_at timestamptz NULL, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, request_id))
- CREATE INDEX IF NOT EXISTS print_jobs_queue_idx ON print_jobs (tenant_id, status, requested_at DESC, id DESC); CREATE INDEX IF NOT EXISTS print_jobs_requester_idx ON print_jobs (tenant_id, requested_by, requested_at DESC)
- Same migration, grant part (frozen NEW_KEYS = ['print.send','print.station']): for roles WHERE tier IN ('admin','server_master') (frozen literal list, harmless before the Server Master tier exists), union, sort and update. No tenant or deleted filter, as in 20260319. Empty down for the grant part.
- Register in master/src/db/migrations/index.ts (append import + entry) and append '20261008000000_printroom' to DELIBERATELY_LAST in master/tests/migration-registry.test.ts. The timestamp slot must be coordinated with the other batch migrations: the final order is whatever the integration session appends, and all of them follow 20260401.
- No backfill. Both tables have tenant_id, so backup.repository includes them automatically (no TRANSITIVELY_SCOPED change). Add 'print_jobs' to BUSINESS_TABLES in master/src/services/catalog-reload-cli.ts (wipe:business clears jobs that point at wiped orders); print_stations stays as configuration.

## permissions

- print.send: CAPABILITIES entry {key:'print.send', group:'workflow', labelToken:'permission.print.send'}. No MINIMUM_TIER entry, so office tier. Granted to admin and server_master by migration 20261008000000_printroom; management and office roles get it from an admin in the grid. Added to the ROLE_TEMPLATES 'sales' and 'dispatch' templates (templates only, not seeded rows).
- print.station: CAPABILITIES entry {key:'print.station', group:'workflow', labelToken:'permission.print.station'}. Office tier, so an unattended printer PC's panel role can hold it. Same grant migration, and added to the ROLE_TEMPLATES 'dispatch' template.
- Existing keys reused: leads.export (pending-order notes, and sending a lead note), orders.export (final-order notes, and sending an order note), reports.export (the new /api/reports/:report/pdf preview route).
- i18n: permission.print.send / permission.print.station in shared/src/i18n/en.ts (the i18n-coverage permission-token check).

## interfaces

- shared/src/domain/order-note.ts: buildOrderNote(source: NoteSource) where NoteSource = Pick<Order,'items'|'totalWeightKg'> & Partial<Pick<Order,'weightSource'|'totalWeightKgOverride'>>. Order and Lead both satisfy it; a missing weightSource means computed. New types: NoteHeader {source:'lead'|'order'; id: RecordId; number: string|null; createdAt: IsoTimestamp|null}, NotePartyHeader = Pick<Party,'partyCode'|'city'|'phone'|'gstNumber'>, NoteDocument {header: NoteHeader; partyName: string; party: NotePartyHeader|null; vehicleNumber: string|null; model: OrderNoteModel}. New function noteDocument(record: Lead|Order, source, party: Party|null, vehicleNumber: string|null): NoteDocument. It reads record.poNumber ?? null (an optional field from the numbering domain) and createdAt = lead.createdAt or order.leadCreatedAt.
- shared/src/domain/printroom.ts (new, exported from shared index): PRINT_JOB_STATUSES = ['queued','printed','cancelled']; PrintJobStatus; MAX_PRINT_COPIES = 50; clampCopies(v: unknown): number; STATION_ONLINE_MS = 90_000; PrintPerson {id; name; tier: RoleTier; avatarUrl?}; PrintJobSummary {id; kind: NoteKind; source:'lead'|'order'; sourceId; sourceNumber: string|null; partyName; copies; note: string|null; targetStation: {id; name}|null; status; requestedBy: PrintPerson; requestedFrom: string|null; requestedAt; printedBy: PrintPerson|null; printedAt|null; printerName|null; printedStationName|null; cancelledBy: PrintPerson|null; cancelledAt|null}; PrintJob = PrintJobSummary & {document: NoteDocument|null}; PrintJobInput {requestId; kind; source; sourceId; copies; targetStationId?: string|null; vehicleNumber?: string|null; note?: string|null}; PrintJobQuery {status?: PrintJobStatus|'all'; mine?: boolean; cursor?: string; limit?: number}; PrintJobPage {jobs: PrintJobSummary[]; nextCursor: string|null; queuedCount: number}; PrintStation {id; key; name; printerName|null; autoPrint; online: boolean; lastSeenAt|null; isSelf?: boolean}; PrintStationInput {displayName?: string; printerName: string|null; autoPrint: boolean}.
- REST, identical paths on Master (new master/src/http/routes/print.routes.ts mounted at app.use('/api', printRoutes) before dataRoutes) and Office (office/src/http/app.ts, under requireUser): GET /api/print-jobs?status&mine&cursor&limit returns PrintJobPage. GET /api/print-jobs/:id returns PrintJob. POST /api/print-jobs (PrintJobInput) returns PrintJob, needs('print.send'). POST /api/print-jobs/:id/printed {printed: boolean, printerName?: string|null} returns PrintJobSummary, needs('print.station'). POST /api/print-jobs/:id/cancel returns PrintJobSummary (the service allows the own job with print.send, or any job with print.station). POST /api/print-jobs/:id/claim returns PrintJob|null, needs('print.station'). GET /api/print-stations returns PrintStation[] (print.send or print.station). PUT /api/print-stations/self (PrintStationInput) returns PrintStation, needs('print.station'); on the Master it answers 403 validation 'printroom.stationNeedsDesktop' unless the request is loopback (reuses the isLoopback logic of master/src/http/health.ts, moved to master/src/lib/network.ts and exported).
- REST (Master + Office proxy): GET /api/reports/:report/pdf?<same range/columns/totals/paperSize/orientation params> returns application/pdf with Content-Disposition inline, needs('reports.export'). It calls reportService.exportReport(kind, {...options, format:'pdf'}). The Office forwards it through masterConnection.command('report:export', {report, query:{...format:'pdf'}}) and sends inline. That is online-only: failForward gives a 503.
- Socket commands, Client to Server (shared/src/protocol/socket.ts ClientToServerEvents; registered in master/src/realtime/hub.ts registerCommands with run(ack, ...)): 'print:list' (PrintJobQuery, ack PrintJobPage); 'print:get' (id, ack PrintJob); 'print:send' (PrintJobInput, ack PrintJob); 'print:mark' ({id, printed, printerName?}, ack PrintJobSummary); 'print:cancel' (id, ack PrintJobSummary); 'print:claim' (id, ack PrintJob|null; the station key comes from socket.data.panelId); 'print:stations' (ack PrintStation[]); 'print:station' (PrintStationInput, ack PrintStation; the station key comes from socket.data.panelId, display name defaults to office_panels.name).
- Push, Server to Client: 'print:changed' (PrintJobSummary). Master: master/src/services/change-bus.ts gains publishPrintJob({tenantId, job}) / onPrintJob(listener) on its own emitter channel (no change ring). hub.ts subscribes and calls emitPrintJob(io, event), which mirrors emitGatedConflict: recipients are panelSockets plus the ROOM_MASTER_ADMINS sockets, resolved with actorForRecipient, and receive the push only if actor.tenantId === event.tenantId && (actorCan(actor,'print.station') || (actorCan(actor,'print.send') && actor.userId === job.requestedBy.id)). The unsubscribe goes into hub stop(). Office: master-connection.ts socket.on('print:changed', job => this.emit('print', job)); app.ts masterConnection.on('print', job => broadcast('print', job)). Office web listens with source.addEventListener('print'). Master web uses socket.on('print:changed') plus socket.on('connect') and bumps revision 'print_job'.
- Office SSE: new event type 'print' (PrintJobSummary). The 'status' event moving to connected also bumps the print revision (catch-up, no replay needed).
- DesktopBridge (shared/src/protocol/desktop.ts, optional members): printPage?(options: {deviceName?: string; copies?: number}) widened; new savePdf?(options: {fileName: string}): Promise<{ok: boolean; path?: string; cancelled?: boolean; error?: string}>.
- IPC: 'orderbook:printPage' accepts copies; electron/lib/print-options.ts PrintRequest gains copies: number (clampCopies, 1..50) and collate: true. New 'orderbook:savePdf' (mainWindow sender only): webContents.printToPDF({printBackground:true, preferCSSPageSize:true}), then dialog.showSaveDialog(mainWindow, {defaultPath: path.join(app.getPath('documents'), pdfFileName(raw)), filters:[{name:'PDF', extensions:['pdf']}]}), then fs.writeFile. pdfFileName(raw) is a pure sanitizer in electron/lib/print-options.ts.
- Electron window allowlist: electron/lib/lead-pdf.ts becomes isPdfWindowUrl(origin, url). It allows /^\/api\/leads\/[^/?#]+\/pdf$/ (unchanged) or /^\/api\/reports\/[a-z-]+\/pdf(\?[A-Za-z0-9=&%._,:+-]*)?$/. shell.ts:384 isLeadPdf then uses it.
- ui exports (ui/src/index.ts): PrintroomScreen, PrintroomTransport, SendToPrintroomDialog, PrintStationRunner, printOnly, stationConfig helpers (readStationConfig/writeStationConfig, localStorage 'ob.printroom.station'). OrderNote props change from order: Pick<Order,'id'|'leadCreatedAt'> + party: Party|null to header: NoteHeader + party: NotePartyHeader|null. OrderNoteScreen props change from order: Order to record: Order|Lead, plus source: 'lead'|'order' and optional onSendToPrintroom?: (kind, vehicleNumber) => void.
- PrintroomTransport (ui) = {listJobs(q: PrintJobQuery, signal?): Promise<PrintJobPage>; getJob(id): Promise<PrintJob>; sendJob(input): Promise<PrintJob>; markJob(id, printed, printerName?): Promise<PrintJobSummary>; cancelJob(id): Promise<PrintJobSummary>; claimJob(id): Promise<PrintJob|null>; listStations(): Promise<PrintStation[]>; saveStation(input): Promise<PrintStation>}. Same member names in master/web/src/api.ts and office/web/src/api.ts: listPrintJobs, getPrintJob, sendPrintJob, markPrintJob, cancelPrintJob, claimPrintJob, listPrintStations, savePrintStation, reportPdfUrl(kind, range).

## settings

- None. No SETTINGS entries and no CompanyFeatures fields: visibility is permission-gated, and the station printer and auto-print flag are per PC (localStorage 'ob.printroom.station' = {printerName, autoPrint, displayName}, mirrored to print_stations for senders' 'online printers' list).

## uiScreens

- ui/src/PrintroomScreen.tsx (shared, transport via transportRef). The list view has:
- a filter-bar Segmented Queued (count) / Printed / Cancelled / All, a 'Mine only' FilterChip, and an Input data-screen-search that filters party / PO number / sender client-side over the loaded page;
- a DataTable whose Queued view is grouped by sender (group header shows the Avatar, name and a Server Master badge from the Server Master domain's component when requestedBy.tier==='server_master'), with columns time, PO number / party, kind, copies, target station, status pill, and row actions: Print (station holders), Mark printed / Mark not printed, Cancel (absent without the permission);
- a CursorPager;
- a 'This PC' strip, rendered only when desktop.printPage exists and the user holds print.station: printer select (DesktopBridge.listPrinters), station name, Auto-print switch (disabled until a printer is chosen, with a hint), and a list of stations with online dots.

Loading uses the shared loading bar from the UI-shell domain. An empty state or a 503 state uses States.tsx with retry.
- PrintJob sub-screen inside PrintroomScreen (record-detail rule): EditorScreen with a back button and a nested sidebar entry via useSubNav('printroom', {items:[{id:'printroom.job', label: partyName, icon:'printer'}]}). It shows the OrderNote sheets from job.document (paginateOrderNote(document.model, kind)), a printer select, a copies number field (default job.copies), Print (printOnly + printPage {deviceName, copies}, auto-marks printed on ok), Mark printed / Mark not printed, Cancel, and meta of who sent it, from which PC, when, plus the note. A null payload (purged after 30 days) shows the 'printroom.payloadExpired' state, with Print hidden.
- ui/src/SendToPrintroomDialog.tsx (Modal: a small action, not a record detail): note kind Segmented, Copies (1-50), Printroom select ('Any printroom' + stations, offline ones disabled with an '(offline)' suffix), Vehicle no. (dispatch only, cleaned with the same cleanVehicle rule, which moves to shared as cleanVehicleNumber), Note (200). Send keeps one requestId per open dialog, so a retry is idempotent. Success shows a toast 'Sent to Printroom'. Errors use apiErrorText (503 gives 'Master not reachable, print on this PC instead').
- ui/src/PrintStationRunner.tsx: an App-level, invisible component mounted by both panels' App.tsx when can('print.station') && desktop?.printPage && stationConfig.autoPrint && printerName. Props: transport, revision, desktop, onNotify. It heartbeats every 60 s (saveStation), re-lists queued jobs on mount, on revision change and on heartbeat (oldest first, limit 20), and processes them strictly sequentially: claim, getJob, render one portal, wait one macrotask (setTimeout 50 ms plus document.fonts.ready, not requestAnimationFrame, which is paused in a minimised window), printOnly(printPage {deviceName, copies}), markJob(printed, printerName), unmount. Failures go to a toast plus onNotify and are skipped for the session.
- ui/src/printPortal.ts: printOnly(portal: HTMLElement|null, run). It adds body.ob-printing and .ob-note-print-portal--active, then removes them in a finally. ui/src/order-note.css @media print gets: body.ob-printing .ob-note-print-portal:not(.ob-note-print-portal--active) { display: none !important; }.
- ui/src/OrderNoteScreen.tsx: accepts a Lead or an Order (source prop), adds a Copies field (default 1, max 50), a 'Save PDF' button (only when desktop.savePdf exists; file name '<PO number or id>-<filling|dispatch>.pdf'), and a 'Send to Printroom' button (when onSendToPrintroom is supplied; opens SendToPrintroomDialog with the current kind and vehicle prefilled). Print and Save PDF go through printOnly.
- ui/src/OrderNote.tsx: header/strip use header.number ?? header.id. The eyebrow label is t(header.source==='lead' ? 'orderNote.pendingOrderNo' : 'orderNote.orderId'), and isTemporaryId(header.id) shows the unsynced tag. No NOTE_LAYOUT or CSS height change (single value line, same as today).
- ui/src/icons.tsx: new IconName 'printer' (16px path in the existing stroke style).
- Master pending-order detail (master/web/src/screens/LeadsScreen.tsx header actions near :515-543): 'Filling note' and 'Dispatch note' Buttons (canPreviewPdf = leads.export, already computed), mounting OrderNoteScreen with source='lead' and record=openLead (party already in state :154), canEditVehicle true and onSaveVehicle a no-op (print-only). Plus 'Send to Printroom' (print.send && leads.export) and a useSubNav note entry 'leads.note' like orders.note.
- Office pending-order detail (office/web/src/screens/LeadBoardScreen.tsx :247-267): the same buttons, built from the local snapshot so local preview and print work offline. Party comes from view.parties. 'Send to Printroom' only when openLead.sync.hlc is set (the Master has the lead). New props canExportLead (leads.export, already canPreviewPdf) and canSendPrint.
- Final-order details: master/web/src/screens/OrdersScreen.tsx (:452-463) and office/web/src/screens/OrderBoardScreen.tsx (:258-265) gain a 'Send to Printroom' button beside the note buttons (print.send && orders.export) and pass onSendToPrintroom into OrderNoteScreen. Their OrderNoteScreen props change from order= to record= plus source='order'.
- Nav: a 'printroom' entry (label nav.printroom 'Printroom', icon 'printer') in the Work group of both panels' App.tsx, shown when can('print.send') || can('print.station'). NavItem.count = queuedCount for print.station holders, read from GET /api/print-jobs?status=queued&limit=1 on every print revision bump. It is added to MASTER_NAV/OFFICE_NAV at the tail of the Work group with no digit chord (the exact position and chord are owned by the UI-shell/Basic Home domain; palette reachable). Tab union, ScreenSpec and subPages entries go in both App.tsx files.
- Basic Home tile 'Printroom' (printer glyph, its own gradient face, count badge = queued jobs for stations), provided to the Basic Home domain's tile list with the same permission gate.
- Reports screen: a 'Preview PDF' ButtonLink target=_blank to api.reportPdfUrl(kind, range+columns) next to Export. It opens the allowlisted PDF window in Electron, or a new tab in a LAN browser. The button is placed by the Reports domain on its ui/ ReportsScreen; this domain supplies the route, the Office proxy, the allowlist and the api member.
- Bell entries (via the Notifications domain): 'printroom.notify.printed' ({party} printed by {name}), sent to the sender when a print:changed push has status 'printed', requestedBy.id === me and printedBy.id !== me; 'printroom.notify.autoPrintFailed' on the station PC.

## steps

### 1. Shared note model accepts a pending order

Files: `C:\Users\Z\Desktop\OrderBook\shared\src\domain\order-note.ts`, `C:\Users\Z\Desktop\OrderBook\shared\tests\order-note.test.ts`

Widen buildOrderNote's parameter to NoteSource. A missing weightSource or override means the computed totalWeightKg. Add NoteHeader, NotePartyHeader, NoteDocument, noteDocument(record, source, party, vehicle) and cleanVehicleNumber (moved from OrderNoteScreen's cleanVehicle). Add test cases: a Lead-shaped source gives the same model as the equivalent Order; noteDocument uses poNumber when present and falls back to null; the party header is trimmed to four fields; cleanVehicleNumber behaves as before.

### 2. Shared printroom types, permissions, protocol

Files: `C:\Users\Z\Desktop\OrderBook\shared\src\domain\printroom.ts`, `C:\Users\Z\Desktop\OrderBook\shared\src\index.ts`, `C:\Users\Z\Desktop\OrderBook\shared\src\domain\permissions.ts`, `C:\Users\Z\Desktop\OrderBook\shared\src\protocol\socket.ts`, `C:\Users\Z\Desktop\OrderBook\shared\src\protocol\desktop.ts`

Create printroom.ts with the types and constants above, and export it. Add the CAPABILITIES print.send and print.station (group 'workflow') and the ROLE_TEMPLATES additions. In socket.ts, add the eight print:* ClientToServer commands with typed acks and ServerToClient 'print:changed'. Widen DesktopBridge.printPage options with copies? and add savePdf?. No SyncSnapshot, CompanyFeatures or ChangedEntity changes, so wire-optionality and change-ring EVERY_ENTITY are untouched.

### 3. i18n keys in en.ts

Files: `C:\Users\Z\Desktop\OrderBook\shared\src\i18n\en.ts`

Add:
- nav.printroom, permission.print.send, permission.print.station;
- orderNote.pendingOrderNo ('Pending Order No.'), orderNote.copies, orderNote.savePdf, orderNote.savePdfFailed, orderNote.sendToPrintroom; change the 'orderNote.orderId' text to 'Final Order No.';
- printroom.title/filter.queued|printed|cancelled|all|mine/column.*/group.sender/action.print|markPrinted|markNotPrinted|cancel|open/status.*/station.thisPc|printer|autoPrint|autoPrintNeedsPrinter|online|offline|anyStation|name/dialog.title|kind|copies|target|vehicle|note|send|sent/copiesHint ('Set {n} copies in the print dialog')/payloadExpired/empty/error.offline/notify.printed/notify.autoPrintFailed;
- validation keys validation.print.copies|kind|source|note|station|requestId|notQueued|stationNeedsDesktop.

No digits of 3 or more and no price words: the copies range is spelled with {max} placeholders. There are no activity.* tokens, so the lockfile is unaffected.

### 4. Migration: print_stations, print_jobs, grant

Files: `C:\Users\Z\Desktop\OrderBook\master\src\db\migrations\20261008000000_printroom.ts`, `C:\Users\Z\Desktop\OrderBook\master\src\db\migrations\index.ts`, `C:\Users\Z\Desktop\OrderBook\master\tests\migration-registry.test.ts`, `C:\Users\Z\Desktop\OrderBook\master\tests\helpers\fixtures.ts`, `C:\Users\Z\Desktop\OrderBook\master\src\services\catalog-reload-cli.ts`

Raw SQL CREATE TABLE/INDEX IF NOT EXISTS per the data model, then the frozen union grant for tier IN ('admin','server_master'). Append the import and entry to index.ts and append the name to DELIBERATELY_LAST. Add 'print_jobs' and 'print_stations' to DATA_TABLES, listed before 'office_panels' and 'users' (FKs). Add 'print_jobs' to BUSINESS_TABLES.

### 5. Repository

Files: `C:\Users\Z\Desktop\OrderBook\master\src\repositories\print.repository.ts`

Knex-only functions taking a TransactionContext or db():
- insertJob (INSERT ... ON CONFLICT (tenant_id, request_id) DO NOTHING RETURNING, then fall back to a select by request_id);
- listJobs(tenant, {status, requestedBy?, cursor (requested_at,id), limit ≤100}), joining users (display_name, avatar) and roles (tier) for requestedBy, printedBy and cancelledBy, with payload excluded;
- countQueued(tenant, requestedBy?);
- findJob(tenant, id, {withPayload});
- markJob(tenant, id, printed, {userId, stationId, printerName}) as a guarded UPDATE: printed only from queued; unprinted only from printed, which clears the printed_* fields and the claim;
- cancelJob (only from queued);
- claimJob(tenant, id, stationId) with the lease UPDATE ... RETURNING;
- stripOldPayloads(tenant) as UPDATE ... SET payload=NULL WHERE status<>'queued' AND updated_at < now()-interval '30 days' AND payload IS NOT NULL;
- upsertStation(tenant, key, {displayName, printerName, autoPrint}) as INSERT ... ON CONFLICT (tenant_id, station_key) DO UPDATE ... last_seen_at=now();
- listStations(tenant) computing online = last_seen_at > now()-interval '90 seconds';
- findStationByKey.

The row mappers live in the same file, or in mappers.ts if credential-invariants expects them there.

### 6. Service

Files: `C:\Users\Z\Desktop\OrderBook\master\src\services\print.service.ts`, `C:\Users\Z\Desktop\OrderBook\master\src\services\change-bus.ts`

change-bus.ts: add PRINT_EVENT, publishPrintJob({tenantId, job}) and onPrintJob(listener).

print.service.ts (requirePermission first everywhere):
- sendJob(input, actor, origin {from}): requires print.send, plus leads.export or orders.export by source. It validates requestId, kind, source, copies (clampCopies refuses outside 1..50 with ValidationError), note and targetStationId (must exist in the tenant). It does resolveId, then leadService.getLead / orderService.getOrder (these enforce view and party scope), then partyRepo find, then noteDocument(..., cleanVehicleNumber(vehicle)). Then a transaction: insertJob and stripOldPayloads. After commit it calls publishPrintJob and returns the job.
- listJobs(query, actor): requires print.station, or print.send with requestedBy forced to actor.userId (mine is implied).
- getJob: the same scoping, 404 otherwise.
- markJob: requires print.station; the station is resolved from the origin key when present.
- cancelJob: print.station, or print.send on the actor's own job.
- claimJob(id, actor, stationKey): requires print.station and a stationKey; the station must exist (registered by saveStation).
- listStations: requires print.send or print.station.
- saveStation(input, actor, stationKey|null): requires print.station; a null key throws ForbiddenError with messageKey validation.print.stationNeedsDesktop. The display name defaults to office_panels.name or 'Master PC'.

Every state change calls publishPrintJob after commit, except listing and heartbeats. There is no recordActivity (see decisions).

### 7. Master HTTP routes

Files: `C:\Users\Z\Desktop\OrderBook\master\src\http\routes\print.routes.ts`, `C:\Users\Z\Desktop\OrderBook\master\src\http\app.ts`, `C:\Users\Z\Desktop\OrderBook\master\src\http\routes\report.routes.ts`, `C:\Users\Z\Desktop\OrderBook\master\src\lib\network.ts`, `C:\Users\Z\Desktop\OrderBook\master\src\http\health.ts`

print.routes.ts: the eight routes above. needs() goes on POST /print-jobs (print.send), /:id/printed (print.station), /:id/claim (print.station) and PUT /print-stations/self (print.station). The others are gated in the service and listed as exemptions with reasons. stationKeyOf(req) = isLoopback(req) ? 'master' : null; origin.from = loopback ? 'master' : 'lan'.

Mount it in app.ts before app.use('/api', dataRoutes). Move isLoopback from health.ts into lib/network.ts, exported, with health.ts importing it.

report.routes.ts: add GET '/:report/pdf' with needs('reports.export'), sharing a small helper with '/:report/export' that parses options. It forces format 'pdf' and Content-Disposition inline. The CSV default path stays byte-identical.

### 8. Realtime hub

Files: `C:\Users\Z\Desktop\OrderBook\master\src\realtime\hub.ts`

In registerCommands, add the eight socket.on('print:*') handlers via run(). print:claim and print:station pass `panel:${socket.data.panelId}`, and print:send passes origin.from = socket.data.deviceCode ?? 'panel'.

In createHub, add const unsubscribePrint = onPrintJob(e => void emitPrintJob(io, e)) and call it in stop().

emitPrintJob mirrors emitGatedConflict: recipients are panelSockets plus the admin sockets, each resolved with actorForRecipient. It checks the tenant, then print.station, or print.send for the requester only, and catches and logs per socket.

### 9. Office server forwarding + SSE

Files: `C:\Users\Z\Desktop\OrderBook\office\src\http\app.ts`, `C:\Users\Z\Desktop\OrderBook\office\src\realtime\master-connection.ts`

app.ts, after requireUser:
- GET/POST print-jobs routes and print-stations routes use forward(res, 'print:*', ...). POST /api/print-jobs first runs `await sync.flush().catch(() => undefined)` (check flush is re-entrancy-safe and bounded; if not, guard it with a flag), then forwards. All of these are online-only through failForward (503).
- GET /api/reports/:report/pdf calls masterConnection.command('report:export', {report, query:{...parseReportQuery, format:'pdf', columns, totals, paperSize, orientation}}) and replies inline, mirroring the lead PDF proxy at :933-947.
- Register masterConnection.on('print', job => broadcast('print', job)) next to the 'change' and 'conflict' registrations near :2146.

master-connection.ts: socket.on('print:changed', (job) => this.emit('print', job)). This is required by socket-contract.test.ts.

### 10. Electron: copies, savePdf, PDF window allowlist

Files: `C:\Users\Z\Desktop\OrderBook\electron\lib\print-options.ts`, `C:\Users\Z\Desktop\OrderBook\electron\lib\lead-pdf.ts`, `C:\Users\Z\Desktop\OrderBook\electron\shell.ts`, `C:\Users\Z\Desktop\OrderBook\electron\preload.cts`, `C:\Users\Z\Desktop\OrderBook\electron\tests\print-options.test.ts`, `C:\Users\Z\Desktop\OrderBook\electron\tests\lead-pdf.test.ts`

print-options.ts:
- PrintRequest gains copies: number and collate: true.
- printOptions reads requested.copies through an internal clamp: an integer in 1..50, anything else becomes 1.
- Add a pure pdfFileName(raw: unknown): string. It strips [\\/:*?"<>|] and control characters, collapses spaces, caps the name at 100 characters, forces a .pdf ending, and falls back to 'note.pdf'.

lead-pdf.ts: rename the export to isPdfWindowUrl, adding the reports pattern. Keep `export const isLeadPdfUrl = isPdfWindowUrl`? No: update its single caller, shell.ts:384.

shell.ts: add ipcMain.handle('orderbook:savePdf') guarded by event.sender === mainWindow?.webContents. It runs printToPDF({printBackground:true, preferCSSPageSize:true}), then showSaveDialog; a cancel returns {ok:false, cancelled:true}; then writeFile. The printPage handler is unchanged except that options carry copies.

preload.cts: printPage options type {deviceName?, copies?}; add savePdf.

Use only APIs available in Electron 22 for the legacy build: printToPDF's new options API exists since Electron 21, and print copies and collate long predate that.

### 11. ui kit: print helper, note renderer, note screen

Files: `C:\Users\Z\Desktop\OrderBook\ui\src\printPortal.ts`, `C:\Users\Z\Desktop\OrderBook\ui\src\order-note.css`, `C:\Users\Z\Desktop\OrderBook\ui\src\OrderNote.tsx`, `C:\Users\Z\Desktop\OrderBook\ui\src\OrderNoteScreen.tsx`, `C:\Users\Z\Desktop\OrderBook\ui\src\icons.tsx`, `C:\Users\Z\Desktop\OrderBook\ui\src\index.ts`

printPortal.ts: printOnly(), and the one print-CSS rule in order-note.css.

OrderNote.tsx: props header: NoteHeader and party: NotePartyHeader|null. It displays header.number ?? header.id and picks the label by source.

OrderNoteScreen.tsx:
- record: Order|Lead and a source prop; it builds a NoteDocument via shared noteDocument().
- a Copies field;
- Save PDF when desktop.savePdf exists;
- Send to Printroom when onSendToPrintroom is given;
- print() and savePdf wrapped in printOnly(portalRef.current, ...), with portalRef on the portal div;
- printPage({deviceName: chosenPrinter || undefined, copies});
- the browser fallback window.print() shows a copiesHint toast when copies > 1;
- the portal div gets a ref.

Add the 'printer' icon and the new barrel exports.

### 12. ui kit: Printroom screen, send dialog, station runner

Files: `C:\Users\Z\Desktop\OrderBook\ui\src\PrintroomScreen.tsx`, `C:\Users\Z\Desktop\OrderBook\ui\src\SendToPrintroomDialog.tsx`, `C:\Users\Z\Desktop\OrderBook\ui\src\PrintStationRunner.tsx`, `C:\Users\Z\Desktop\OrderBook\ui\src\index.ts`, `C:\Users\Z\Desktop\OrderBook\eslint.config.js`

Build the three components as specified in uiScreens.
- Each reads `transport` through a ref and never lists it in hook deps (no-transport-dep).
- They use tokens only, with no px literals over 3 (ui-conventions).
- The PrintroomScreen props are transport, revision, permissions {send, station}, desktop?, currentUserId, onOpenRecord?(source, id). That last prop is used for deep links once the chat/deep-link domain lands; omit it until then.
- Station config helpers use localStorage 'ob.printroom.station' with try/catch, matching the KEY_PRINTER helpers.
- Only one job portal exists at a time: in the runner while printing, and in the job sub-screen.
- Add all three files to the swept no-untranslated-jsx-text list in eslint.config.js.

### 13. Master web wiring

Files: `C:\Users\Z\Desktop\OrderBook\master\web\src\api.ts`, `C:\Users\Z\Desktop\OrderBook\master\web\src\printroomTransport.ts`, `C:\Users\Z\Desktop\OrderBook\master\web\src\App.tsx`, `C:\Users\Z\Desktop\OrderBook\master\web\src\screens\LeadsScreen.tsx`, `C:\Users\Z\Desktop\OrderBook\master\web\src\screens\OrdersScreen.tsx`

api.ts: add the nine members (listPrintJobs ... reportPdfUrl). printroomTransport.ts maps them, and gives the files their call sites for web-reachability.

App.tsx:
- socket.on('print:changed', job => {bump('print_job'); notify-if-mine-printed}) and socket.on('connect', () => bump('print_job'));
- a 'printroom' Tab, nav item (gated) with count, ScreenSpec rendering <PrintroomScreen revision={revisionOf(revisions,'print_job')} .../>, and subPages;
- mount <PrintStationRunner/> at App level under the gate.

LeadsScreen.tsx: note buttons, an OrderNoteScreen branch (source 'lead'), Send to Printroom with SendToPrintroomDialog, and the useSubNav 'leads.note' entry.

OrdersScreen.tsx: switch to the record=/source= props and add Send to Printroom.

### 14. Office web wiring

Files: `C:\Users\Z\Desktop\OrderBook\office\web\src\api.ts`, `C:\Users\Z\Desktop\OrderBook\office\web\src\printroomTransport.ts`, `C:\Users\Z\Desktop\OrderBook\office\web\src\App.tsx`, `C:\Users\Z\Desktop\OrderBook\office\web\src\screens\LeadBoardScreen.tsx`, `C:\Users\Z\Desktop\OrderBook\office\web\src\screens\OrderBoardScreen.tsx`

api.ts and the transport carry identical member names. Report PDFs go through reportPdfUrl only; Office downloads otherwise use fetchBlob, and the PDF window is an inline view, so an href is fine there.

App.tsx:
- source.addEventListener('print', ...) bumps printRevision and notifies;
- the 'status' handler going to connected bumps printRevision;
- nav, ScreenSpec, subPages, the can() gates and the runner mount.

LeadBoardScreen.tsx: Filling/Dispatch note buttons (leads.export) built from the snapshot, and the OrderNoteScreen branch with a no-op vehicle save. Send to Printroom only when sync.hlc is set.

OrderBoardScreen.tsx: record=/source= props and Send to Printroom.

### 15. Docs

Files: `C:\Users\Z\Desktop\OrderBook\docs\ORDER_NOTES_PLAN.md`, `C:\Users\Z\Desktop\OrderBook\docs\STRUCTURE.md`, `C:\Users\Z\Desktop\OrderBook\HANDOFF.md`, `C:\Users\Z\Desktop\OrderBook\docs\AI_COLLABORATION.md`, `C:\Users\Z\Desktop\OrderBook\docs\schema\00-overview.md`, `C:\Users\Z\Desktop\OrderBook\docs\backend-modules\04-API-CONTRACT.md`, `C:\Users\Z\Desktop\OrderBook\docs\backend-modules\08-PERMISSIONS.md`, `C:\Users\Z\Desktop\OrderBook\docs\catalogue\CATALOGUE_MODEL.md`

Update these docs:
- ORDER_NOTES_PLAN.md: lead notes, copies, Save PDF, the single-portal rule, and the Printroom flow with its states, claim lease and online-only send.
- STRUCTURE.md: new files in §5, the tables in §6 (fix the migration counts while there), a printroom flow in §11, and §15 'where a change goes'.
- Schema doc: add the two tables (pick the matching docs/schema file plus the overview index).
- 04-API-CONTRACT.md: the routes, commands and push, plus the stale csv-only report:export ack it still shows.
- 08-PERMISSIONS.md: the two keys.
- CATALOGUE_MODEL.md §8: the PDF window allowlist.
- HANDOFF.md: add a session entry. Record as owed a manual check in real Electron of the PDF window, silent copies, savePdf, and auto-print while minimised; and the advice to grant print.station to the printer PC's panel role.
- AI_COLLABORATION.md: add a change-log entry.

## tests

- NEW master/tests/printroom.integration.test.ts. Cover:
- sending requires print.send plus leads.export or orders.export (403 messageKey otherwise);
- party scope: a restricted party's lead is refused (404 or 403, as getLead does);
- an idempotent requestId returns the same job id;
- the snapshot is frozen: editing the lead after sending leaves job.document unchanged;
- the snapshot carries poNumber when the numbering domain is present;
- copies 0 and 51 are refused; the vehicle number is cleaned;
- list scoping: a sender sees only their own jobs, a station holder sees all, and queuedCount is right;
- claim race: two stations claim, exactly one wins; the lease expires after 2 min (time faked via an UPDATE of claimed_at); a targeted job cannot be claimed by another station;
- mark printed then unprinted clears the printed fields; cancel works only on queued; the sender can cancel their own job but not another's without print.station;
- saveStation from a non-loopback request gives 403, and online flips after 90 s;
- stripOldPayloads NULLs only old non-queued payloads;
- the publishPrintJob listener receives tenantId and a summary without a payload.
- NEW master/tests/printroom-push.test.ts (or a block in an existing hub/realtime suite): emitPrintJob delivers to a print.station socket, delivers to the requesting print.send socket, and withholds from a non-requesting print.send socket, from a socket with neither key and from another tenant.
- CHANGED master/tests/credential-invariants.test.ts: add 'guards every Printroom route'. It counts handlers in print.routes.ts against needs() lines plus an explicit EXEMPT list (GET /print-jobs, GET /print-jobs/:id, POST /:id/cancel, GET /print-stations — service-gated, with reasons). The existing Reports block still passes, because the new /pdf route carries needs('reports.export').
- CHANGED master/tests/migration-registry.test.ts: append '20261008000000_printroom' to DELIBERATELY_LAST (required by the tail-equality test).
- CHANGED master/tests/helpers/fixtures.ts: DATA_TABLES gains print_jobs and print_stations, otherwise rows leak between suites.
- UNCHANGED but must pass: master/tests/migration-data-safety.test.ts (additive only); master/tests/socket-contract.test.ts ('print:changed' is quoted in master/src hub.ts and in office/src master-connection.ts); master/tests/change-ring.test.ts (no new ChangedEntity); shared/tests/wire-optionality.test.ts; office/tests/snapshot-for-user.test.ts (no SyncSnapshot change); master/tests/i18n-tokens.test.ts (no new recordActivity calls); master/tests/no-duplicate-ui.test.ts (barrel exports); ui/tests/no-transport-dep.test.ts.
- CHANGED master/tests/web-reachability.test.ts: no allow-list entries needed if both printroomTransport.ts files call every new api member. reportPdfUrl must have a call site on both panels (the Reports domain's Preview PDF button), or a temporary ALLOWED_UNCALLED entry with a reason until that lands.
- CHANGED master/tests/screen-reachability.test.ts: register 'printroom' as present on both panels, so there is no PANEL_ONLY entry, if the test enumerates screens.
- NEW office/tests/module-forwarding.test.ts block 'printroom and report PDF':
- each /api/print-* route forwards the right command and payload;
- an unreachable Master gives a 503 with error.unavailable;
- 'forbidden' gives a 403 with details.permission;
- POST /api/print-jobs calls sync.flush before forwarding;
- GET /api/reports/dispatches/pdf answers application/pdf inline, with format 'pdf' in the forwarded query;
- master-connection re-emits print:changed as 'print', and the SSE broadcast carries it.
- CHANGED electron/tests/print-options.test.ts: add cases where copies 3 yields 3; 0, 51, 2.5, '4' and missing all yield 1; collate is true; pdfFileName sanitises 'PO/2026-27/00001 dispatch' to 'PO-2026-27-00001 dispatch.pdf', caps the length and handles a non-string. Existing assertions stay green (toMatchObject).
- CHANGED electron/tests/lead-pdf.test.ts: import isPdfWindowUrl. Keep every existing allow and refuse case. Add allows for /api/reports/dispatches/pdf and /api/reports/top-parties/pdf?period=month&columns=a,b&from=2026-04-01. Add refusals for /api/reports/dispatches/export?format=pdf, /api/reports/x/pdf#page=2, /api/reports/x/pdf?a=<script>, /api/reports/X_Y/pdf, /api/reports/a/b/pdf, another origin and a look-alike host.
- CHANGED shared/tests/order-note.test.ts: add a Lead-shaped source to buildOrderNote, plus noteDocument and cleanVehicleNumber cases. The existing Order cases are unchanged.
- CHANGED ui/tests/master-shell.test.tsx:620 and ui/tests/office-shell.test.tsx:941/945: printPage is now called with {deviceName: ..., copies: 1}, because OrderNoteScreen always sends copies (a deliberate update). Add new cases: the pending-order detail shows Filling note and Dispatch note with leads.export and hides them without it; Send to Printroom is absent without print.send; the Printroom nav item shows only with print.send or print.station; a 'print' SSE event (Office) or 'print:changed' (Master) bumps the badge count.
- NEW ui/tests/printroom-screen.test.tsx (mock transport):
- the queued list is grouped by sender, and a Server Master badge shows for tier server_master;
- the filters call listJobs with the right status;
- the Print row action calls printPage {deviceName, copies: job.copies} and then markJob(true);
- Mark not printed calls markJob(false);
- Cancel is absent for a send-only user on another's job;
- the station strip renders only with desktop.printPage and print.station;
- a 503 shows the offline state with retry;
- printOnly toggles the classes so that only the active portal has ob-note-print-portal--active during the print.
- NEW ui/tests/print-station-runner.test.tsx (fake timers):
- jobs are processed sequentially, each claimed before being fetched;
- a null claim is skipped;
- a failed print is not retried in the same session and calls onNotify;
- the heartbeat calls saveStation every 60 s;
- the runner unmounts its portal after each job;
- nothing runs without a printer or without autoPrint.
- i18n: shared/tests/i18n-coverage.test.ts and master/tests/i18n-call-sites.test.ts must pass with every new key (no 3+ digit runs; copies limits use placeholders). master/tests/tooling-config.test.ts must pass with the new swept ESLint paths.
- If the UI-shell domain changes MASTER_NAV/OFFICE_NAV for printroom, shared/tests/keys-nav-order.test.ts and the Alt-digit assertions in the shell tests change in that coordinated nav commit, not here.

## docs

- docs/ORDER_NOTES_PLAN.md: pending-order notes (gate, label, print-only vehicle), the copies field, Save PDF, the single-active-portal rule, and the Printroom (send, station, auto-print claim lease, online-only send, 30-day payload strip). Also fix the stale LeadsOrdersScreen references.
- docs/STRUCTURE.md: §5 new files (print.service/repository/routes, ui Printroom files, printPortal); §6 the print_jobs/print_stations tables and corrected migration counts; §11 a new printroom flow (send → push → runner claim → print → mark); §15 'where a change goes' rows for print and the PDF window; correct §5.4 to say pdf/ serves reports and the lead PDF; §11.8a paginateOrderNote(model, kind).
- docs/schema (matching file + 00-overview.md): the two tables, their constraints and indexes, and the retention note.
- docs/backend-modules/04-API-CONTRACT.md: the print REST routes, socket commands and the print:changed push, the Office SSE 'print' event, and GET /api/reports/:report/pdf; fix the stale csv-only report:export ack.
- docs/backend-modules/08-PERMISSIONS.md and docs/ROLES_AND_USERS.md: print.send and print.station (tiers, grant migration, the advice to grant print.station to the printer PC's panel role).
- docs/catalogue/CATALOGUE_MODEL.md §8: the PDF window allowlist now covers report PDFs (exact regex, query character set).
- HANDOFF.md: add a dated session entry. Record as owed manual verification in real Electron (33 and legacy 22): the PDF window, silent printing with copies, savePdf, and auto-print while the window is minimised. Note that the batch must ship as a coordinated Master+Office release, because an old Master times out on print:* commands.
- docs/AI_COLLABORATION.md: change-log entry (areas touched, decisions, Verified line).

## risks

- The shared print stylesheet shows every .ob-note-print-portal. Without printOnly(), a hidden OrderNoteScreen kept alive by ScreenHost/Activity plus the Printroom or runner portal would both print. Every print and savePdf path must go through printOnly; the new ui test covers it.
- Auto-print in a minimised or background window: requestAnimationFrame is paused and timers are throttled to about 1 s. The runner uses setTimeout plus document.fonts.ready and must be verified in packaged Electron. If silent print of a minimised window renders blank, set backgroundThrottling:false on the main window when station mode is on (one webPreferences flag).
- Some printer drivers ignore Electron's copies option. Verify it on the owner's printers. The fallback, if needed, is calling print N times sequentially (no DOM duplication, which would cost RAM on a 4 GB PC).
- Two auto-print stations with untargeted jobs depend on the claim lease. A station that crashes mid-print leaves the job claimed for 2 min, after which another station may print it again. That is acceptable, and documented.
- Version skew: an Office that calls print:* on an old Master waits 15 s and then gets a 503 'unavailable'. Ship Master and Office together (see the critic's handshake gap).
- The PDF window has never been verified in real Electron (HANDOFF:77). The allowlist widening is regex-tested, but the viewer still needs a manual check, including how a 503 JSON error displays when the Office is offline (today's lead-PDF behaviour, shown as text).
- Station operators see sheets for parties they may lack access to. This is intended, because the sender addressed the printroom; record it in the permissions doc so admins grant print.station knowingly.
- Payload stripping after 30 days makes old jobs unprintable from the Printroom (the sub-screen shows payloadExpired). The record itself remains printable from its own screen.
- Copies ranges and numbers in strings: the i18n test bans 3+ digit runs, so use placeholders.
- Windows 7 legacy (Electron 22 / Chromium 108 / Node 16 Office): avoid crypto.randomUUID (getRandomValues is used), AbortSignal.any (the Platform domain owns the polyfill) and any API newer than Chromium 108 in the new ui files. printToPDF uses the Electron 21+ API shape only.

## dependsOn

- Pending-order numbering domain: optional poNumber?: string|null on the Lead and Order wire types (noteDocument reads it; print_jobs.source_number stores it). Until it lands, the note shows the record id.
- Server Master / roles domain: the RoleTier value 'server_master' (the grant migration already names it in a frozen whereIn); a ServerMasterBadge component (or tier → badge rule) reused in the Printroom sender column; tier exposed in user joins.
- Notifications/bell domain: an App-level notify(entry) API in both panels for 'print job printed' (sender) and 'auto-print failed' (station).
- UI shells / Basic Home domain: the Printroom nav entry position in the Work group of both sidebars (no Alt digit), the MASTER_NAV/OFFICE_NAV and keys-nav-order changes in one coordinated nav commit, the Basic Home tile, the shared loading bar used by PrintroomScreen, and Server-Master row highlighting.
- Reports domain: places the 'Preview PDF' button (api.reportPdfUrl) on the ui/ ReportsScreen for every report kind, including new user-, party- and product-wise kinds. Any list that needs a PDF becomes a report kind and so gets preview for free. Coordinates exportReport/ExportedReport changes (an xlsx arm) with the new /pdf route.
- Chatroom domain: may add record deep links (#/lead/<id>, #/order/<id>); PrintroomScreen's optional onOpenRecord would use them. It also likely adds a CAPABILITY group, which these print keys deliberately do not need.
- Platform / Win7 domain: the AbortSignal.any polyfill in both web api.ts files (the Printroom uses the same request helpers), and the legacy Electron 22 build that compiles electron/lib/print-options.ts and the shell IPC unchanged.
- Migration ordering across the batch: 20261008000000_printroom must be appended to index.ts and DELIBERATELY_LAST after the Server Master tier migration (so the frozen grant hits server_master roles on existing installs). If the tier migration lands later, it must itself union print.send and print.station into the Server Master role it seeds.
- Audit-log domain: confirms the decision that print jobs are excluded from the hash-chained activity_log (print_jobs is its own audit).

## openQuestions

- Should an unattended printer PC keep auto-printing with nobody signed in? If yes, the owner grants print.station to that Office panel's own role (office tier allows it). If no, auto-print runs only while an operator is signed in. The design supports both; only the owner's grant decides.
- Retention: is stripping the printable copy of printed or cancelled jobs after 30 days acceptable, with who, what and when kept forever, or should printable copies be kept longer?

## effort

About 34 files touched: 12 new and 22 modified. New: migration, repository, service, routes, shared printroom.ts, 3 ui components, printPortal.ts, 2 transports, 3-4 test files. Roughly 2,300 new LOC, of which about 900 are tests and about 350 are i18n lines. Budget 2 to 3 focused sessions, plus one manual verification pass in packaged Electron on a PC with a real printer: copies, silent auto-print while minimised, the PDF window and savePdf.
