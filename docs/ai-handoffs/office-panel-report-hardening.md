# Validate panel device reports, fix duplicate auto-names, retire the dead MAC field

**Owner:** Command Code. **Reviewer:** Claude (design check) + `npm run verify`.
**Size:** M — three related fixes in the same two files, worth landing together
since they touch overlapping code and one implementer reviewing all three at
once is cheaper than three separate diffs against the same file.

Found by a read-only audit of `master/src/repositories/office-panel.repository.ts`
(a file the previous 27-agent audit never got to). All three are verified —
traced end to end, not just pattern-matched — details below.

## 1. `updateDeviceReport` writes an unvalidated wire payload straight into typed DB columns — the real bug here, fix first

**File:** `master/src/repositories/office-panel.repository.ts:75-99`

A paired Office Panel posts a `panel:report` every 5 minutes
(`office/src/realtime/master-connection.ts` — `REPORT_INTERVAL_MS`). The
handler chain has **no validation anywhere**:

- `master/src/realtime/hub.ts:419-425` — `socket.on('panel:report', ...)`
  passes the payload through verbatim (the comment there says it "needs no
  actor and no permission", which is about auth, not about the payload
  shape — don't read that comment as "this is fine as-is").
- `master/src/services/panel.service.ts` `recordPanelReport` (~331-348) and
  `refreshPanelReport` (~357-368) — both route into the same repository
  function with no checks.
- `office-panel.repository.ts:75-99` `updateDeviceReport` writes
  `report.storageBytes`/`diskFreeBytes`/`diskTotalBytes` straight into BIGINT
  columns and `report.startedAt ? new Date(report.startedAt) : null` straight
  into a timestamp column.

**Failure scenario:** a malformed or malicious `startedAt` (not a parseable
date) makes `new Date(...)` produce `Invalid Date`; Postgres's date
serializer throws `RangeError: Invalid time value`. Since `refreshPanelReport`
routes through the same function, this doesn't just silently drop one
periodic report — an admin **opening that panel's detail card** hits the same
throw and the panel administration screen 500s until someone fixes the row by
hand. A non-integer or absurd `storageBytes` (`1.5`, `1e30`) hits the BIGINT
column the same way.

**Fix:** one guard at the actual choke point — `recordPanelReport` in
`master/src/services/panel.service.ts` (not `hub.ts`; both callers,
`recordPanelReport` and `refreshPanelReport`, must go through it). Add a
`normalisePanelReport(report: unknown): OfficePanelReportInput` (same file,
or `master/src/domain/` if you prefer, matching the existing hand-written
`assert*` style used elsewhere — e.g. `master/src/domain/access.ts`,
`field-values.ts` — this codebase has no schema-validation library, don't
add one for this):

- strings: clamp length (`hostname`/`platform`/`osVersion`/`appVersion`/
  `nodeVersion` → 255 chars; `dataDir`/`imagesDir` → 1024 — both are
  unbounded `TEXT` today, so a panel could otherwise post a multi-MB
  hostname every 5 minutes).
- byte counts: `Number.isSafeInteger(v) && v >= 0 ? v : null`.
- `localPort`: `Number.isInteger(v) && v > 0 && v < 65536 ? v : null`.
- `startedAt` / `lastSnapshotAt`: parse, and use `null` on an invalid date
  rather than letting `new Date(garbage)` reach Postgres.

`updateDeviceReport` itself doesn't need to change once its input is always
valid.

## 2. `office_panels.mac_address` is never written by anything

**File:** `master/src/repositories/office-panel.repository.ts:28-40` (`insertPanel`)
and `:75-99` (`updateDeviceReport`)

Neither function sets `mac_address`. Confirmed no other writer exists
(`grep -rn mac_address` → only the schema migration and the mapper). The
column is read (`mappers.ts:216`), typed (`shared/src/domain/entities.ts:148`),
and **rendered** on the Panels screen
(`master/web/src/screens/PanelsScreen.tsx:223-226`,
`<dd className="ob-mono">{panel.macAddress ?? '—'}</dd>`) — so an admin
opening a panel's detail card sees a permanent `—`, forever, with no signal
that this was never implemented rather than "not reported yet."

**Pick one — check with whoever owns this brief before doing the bigger
option, since it's a judgment call about a feature nobody has asked for:**

- **Cheap and honest (default unless told otherwise):** delete the dead
  field entirely — `panels.detail.mac` row from `PanelsScreen.tsx:223-226`,
  the `panels.detail.mac` key from `shared/src/i18n/en.ts` / `hi.ts`,
  `macAddress` from `shared/src/domain/entities.ts:148` and from the mapper
  at `mappers.ts:216`. Leave the DB column — dropping a column is a
  migration, out of scope here.
- **If it's actually wanted:** add `macAddress: string | null` to
  `OfficePanelReportInput` (`shared/src/domain/inputs.ts:587`), populate it
  in `office/src/services/panel-report.service.ts`'s `buildReport()` from
  `os.networkInterfaces()` (first non-internal interface's `.mac`), and add
  `mac_address: report.macAddress` to `updateDeviceReport`'s update object.

## 3. `defaultPanelName` can mint a panel name that already exists

**File:** `master/src/repositories/office-panel.repository.ts:161-167`
(`countPanelsNamed`) and `master/src/services/panel.service.ts:504-507`
(`defaultPanelName`)

`countPanelsNamed` counts rows matching `Office Panel%`; `defaultPanelName`
does `Office Panel ${count + 1}`. There's no unique constraint on
`office_panels.name` (only `(tenant_id, device_code)` is unique — see
`20260301000000_tenancy_access_and_sync.ts:227`), and nothing checks name
uniqueness on rename either (`updatePanel`, `panel.service.ts:201-209`).

**Failure scenario:** pair two panels → "Office Panel 1", "Office Panel 2".
Rename the first to "Reception". The count of `Office Panel%` is now 1, so
the *next* auto-paired panel is also named "Office Panel 2" — a duplicate
name on the exact screen an admin uses to decide which panel to revoke or
which PC to walk to.

**Fix:** replace the count with a suffix scan. In
`office-panel.repository.ts`, add:
```ts
export async function panelNamesMatching(tenantId: string, prefix: string): Promise<string[]> {
  const rows = await db()(TABLE).select('name').where({ tenant_id: tenantId }).whereILike('name', `${prefix}%`);
  return rows.map((r) => String(r.name));
}
```
In `panel.service.ts`'s `defaultPanelName`, take the max numeric suffix
across the returned names (parse `name.slice(prefix.length).trim()` as a
number, ignore non-numeric matches) and use `max + 1`. Delete
`countPanelsNamed` — confirmed it has no other caller.

## Done looks like

- `npx tsc -p master/tsconfig.json --noEmit` clean.
- `npm run lint` clean.
- New/updated tests: this file has no dedicated test today
  (`office-panel.repository.ts` isn't covered by any `master/tests/*.test.ts`
  per a grep — confirm before assuming coverage exists). Add at minimum:
  a unit test for the suffix-scan naming fix (two panels named "Office
  Panel 1"/"Office Panel 2", rename #1, confirm the next default name is
  "Office Panel 3" not a repeat of "Office Panel 2"), and an integration
  test for `recordPanelReport` rejecting/clamping a malformed report instead
  of throwing.
- `npm run verify` green end to end.

## Constraints

- Fix #1 before the others — it's the one with a real production failure
  mode (a 500 on the panel detail screen); #2 and #3 are correctness/UX,
  not availability.
- Don't touch `hub.ts`'s `panel:report` handler itself — the fix belongs in
  the service layer both callers share.

---
*Implementer: append what changed and what you verified below this line.*
