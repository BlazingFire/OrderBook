# An Office write that the Master refuses is invisible to the person who wrote it

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** S. **Several other briefs depend on this** — land it early.

Found independently by four different audit agents, in four different lanes,
which is the signal that it is one cause rather than four symptoms.

## The defect

```ts
// office/web/src/App.tsx:373-379
if (outcome.rejections.length > 0 && can('sync.resolveConflicts')) {
  toast.push(`${outcome.rejections.length} change(s) were refused`, { … });
}
```

`shared/src/domain/permissions.ts:261` puts `sync.resolveConflicts` at the
**admin** tier. The Office panel's users are shop-floor sales staff, who do not
hold it. So the one notification that a write was thrown away is gated on a
permission the people whose writes get refused do not have.

Meanwhile the refused mutation is gone: `office/src/sync/sync.service.ts:96`
settles on every returned id without filtering by status, and
`office/src/sync/outbox.store.ts:76-81` removes them outright — its own doc
comment at `:75` is explicit: *"Drop mutations the Master has acknowledged —
applied, merged or refused."* Since the optimistic view is rebuilt from the
outbox (`office/src/sync/local-store.ts:202-205`), the provisional record
vanishes with the queue entry.

**Net effect: a salesperson types a lead, it saves, and later it is simply not
there. Nothing ever told them.** That is the failure mode that makes the
temporary-id bug in `fix-office-new-lead-unreachable.md` silent, and it is what
would make a 500-row CSV import unusable.

Two more problems in the same six lines:

- `App.tsx:374` and `:383` are **hard-coded English literals**
  (`'…change(s) were refused'`, `'Could not sync'`), against the one-catalogue
  rule.
- The toast's action navigates to the conflicts tab, but
  `office/web/src/screens/ConflictsScreen.tsx` renders *field-level merge
  conflicts* only — it takes `conflicts: SyncConflict[]` and contains no
  reference to `MutationResult`, `rejected`, or `error`. Even an admin who
  follows the toast lands on a screen that cannot show them the refusal.

Rejections and merge conflicts were conflated. A merge conflict is an
admin-adjudicated event; a rejection is "your write was refused and the reason
is X", which every writer needs.

## Fix

1. **Ungate the notification** at `office/web/src/App.tsx:373`: always toast when
   `outcome.rejections.length > 0`. Keep `can('sync.resolveConflicts')` on the
   `action: { label: t('action.reviewConflicts'), … }` only — so everyone learns
   their work was refused, and only an admin is offered the resolution route.
2. **Tokenise both literals** into `shared/src/i18n/en.ts` and `hi.ts`:
   `sync.changesRefused` taking `{count}`, and `sync.couldNotSync`. Mirror both.
   `MutationResult` already carries `error` and `missingPermission`
   (`shared/src/sync/mutations.ts:118-129`), so the message can name the real
   reason without any protocol change.
3. **Keep the evidence.** In `office/src/sync/sync.service.ts:96`, settle only
   `applied`/`merged`/`duplicate` ids, and move rejections to a separate durable
   "refused" list in `office/src/sync/outbox.store.ts`, so they survive a restart
   and the next flush. Today `lastRejections = rejections` at `:99` is a plain
   assignment executed on **every** successful flush including empty ones, so
   with a batch size of 100 (`office/src/config/index.ts:110`) a 500-row import
   loses four batches out of five.
4. **Give the refusals somewhere to be read.** Either extend `ConflictsScreen`
   with a second section for rejections — it already receives everything it
   needs — or, if the CSV importer lands first, keep that feature's error report
   inside the importer where the row numbers live. Decide and note which.

## Done looks like

- `npx tsc -p office/tsconfig.json --noEmit` and `-p office/web/tsconfig.json` clean.
- `npx vitest run master/tests/i18n-tokens.test.ts master/tests/i18n-call-sites.test.ts` pass.
- `npm run verify` green.
- **Manually verified as a non-admin Office user:** cause a refusal (e.g. attempt
  a write the role lacks permission for), confirm a toast appears naming the
  reason, and confirm the refusal is still discoverable after restarting the
  panel.

---
*Implementer: append what changed and what you verified below this line.*
