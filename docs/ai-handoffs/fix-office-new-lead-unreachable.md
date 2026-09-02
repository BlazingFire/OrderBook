# BLOCKING: the Office panel cannot create a lead at all — two bugs that must ship together

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** M. **Priority: highest in the queue.** The owner reported this as
"Can't create new lead" during manual QA of the Office panel.

Two independent confirmed defects sit on this one path. **Fix both in the same
change.** Fixing only the first converts a visible failure ("the button does
nothing") into a silent one ("the lead saved, then vanished with no trace"),
which is strictly worse for the person using it.

---

## Bug 1 — the New Lead screen is unreachable: `activeId` sends `addLead` to the Dashboard

**File:** `office/web/src/App.tsx:586-591` (and `:548-561`, `:915`)

Verified directly, not taken on trust:

```
office/web/src/App.tsx:549-561  idToTab has 11 keys — assistant, dashboard, leads,
                                orders, parties, partyAccess, products, conflicts,
                                documents, settings, updates. There is no addLead.

office/web/src/App.tsx:586-591  const activeId =
                                  route === 'gallery' ? 'gallery'
                                  : groups.some((g) => g.items.some((item) => item.id === idToTab[tab]))
                                    ? tab
                                    : (groups.flatMap((g) => g.items)[0]?.id ?? '');
```

`idToTab['addLead']` is `undefined`. No nav item has id `undefined`, so the
`.some()` is false and the fallback returns the first nav item — the Dashboard,
which `App.tsx:488` documents as unconditionally present. `App.tsx:915` then
computes `activeScreenId = idToTab[activeId] ?? activeId` = `'dashboard'`, so
the `addLead` screen spec registered at `:898-910` never becomes visible;
`ui/src/ScreenHost.tsx:57` never even adds it to `visited`.

**What the user sees:** they press **+ New Lead** in the topbar (`:613-621`).
`setTab('addLead')` runs. The pane switches to the Dashboard, the topbar title
changes to "Dashboard", and the New Lead button itself disappears — its own
guard is `tab !== 'addLead'` (`:613`) and `tab` is now exactly that. Identical
outcome from the lead board's empty-state button (`:866`) and the `record.new`
command-palette entry (`:949`); all three call the same setter. The only
recovery is clicking a sidebar item.

**Regression source:** `git show a3411c5`. Before it, `App.tsx` had
`if (addingLead && view) { return <AddLeadScreen … /> }` as an early return
*ahead of* the tab switch. That commit converted Add Lead into a tab
(`App.tsx:87` adds `| 'addLead'`) but left the sidebar-membership fallback
untouched. Nothing is type-visible — `tsc` is clean — and no test covers it.
The Master panel has a different shape (`master/web/src/App.tsx:501`, and `:768`
passes the raw `tab` to `ScreenHost`), so it does not have this trap.

### Fix — two edits, one file

```ts
// office/web/src/App.tsx:586-591 — let a screen with no nav entry stay active
const activeId =
  route === 'gallery'
    ? 'gallery'
    : tab === 'addLead' ||
        groups.some((group) => group.items.some((item) => item.id === idToTab[tab]))
      ? tab
      : (groups.flatMap((group) => group.items)[0]?.id ?? '');
```

```ts
// office/web/src/App.tsx:593-597 — give the topbar a title, or it falls through to t('app.panel')
const activeLabel =
  route === 'gallery'
    ? t('footer.designSystem')
    : activeId === 'addLead'
      ? t('lead.add.title')
      : (groups.flatMap((group) => group.items).find((item) => item.id === activeId)?.label ??
        t('app.panel'));
```

`lead.add.title` already exists mirrored in both catalogues — **no new i18n
keys needed**. No sidebar item highlights while adding a lead, which is correct;
there is no such item.

This also repairs `resetActiveScreen` (`App.tsx:570-575`), which today bumps the
Dashboard's nonce instead of the Add Lead screen's — so the Reset button and
`useResetGuard`'s discard confirm (`AddLeadScreen.tsx:471-475`) are currently
dead too.

---

## Bug 2 — a lead raised against a panel-created party is permanently rejected and silently lost

**Files:** `master/src/services/sync.service.ts:283-294`,
`office/src/sync/outbox.store.ts:92-101`

`route()` treats `mutation.entityId` as the only id that can be temporary.
Every `identityRepo.resolveId` call site (`sync.service.ts:318, 324, 330, 339,
345, 393`) passes `mutation.entityId`; **none touches the payload**. But
`lead.create` is dispatched with a bare cast:

```ts
// master/src/services/sync.service.ts:290
const lead = await leadService.createLead(payloadAs<LeadInput>(mutation), actor);
// :283-285  payloadAs = (mutation) => mutation.payload as T   ← no id resolution
```

so `payload.partyId` arrives as the 15-char temporary id the Office panel minted
(`office/src/http/app.ts:1339` `entityId = request.entityId ?? await nextTemporaryId()`,
queued for `party.create` at `:448-450`, handed back to the UI at `:1355-1357`,
passed through `PartyDrawer.tsx:160-161`, stored by `AddLeadScreen.tsx:456-458`
and submitted verbatim at `:438-439`). `lead.service.ts:84-86` then does an
exact-match `partyRepo.findPartyById` (`party.repository.ts:62-72` — no `id_map`
fallback) and throws `validation.lead.partyMissing`.

**What the user sees:** they open Add Lead, use the inline party drawer to add a
new customer — the drawer exists for exactly this flow — pick products, save.
The screen reports success and the lead appears on the board with a pending
badge, because `office/src/http/app.ts:1355` answered 202. On the next flush the
Master rejects it, `sync.service.ts:236` records the refusal as **permanent** in
`applied_mutations` (so a replay returns the same answer), and
`office/src/sync/sync.service.ts:96` settles it out of the outbox — taking the
optimistic overlay with it. **The lead is gone with no trace.** The identical
failure fires as `validation.lead.productMissing` (`lead.service.ts:383-385`)
for a product created on the same panel.

No existing test covers this: every `lead.create` test in
`master/tests/sync.integration.test.ts` (`:94, 129, 158, 198, 224, 396, 437,
462`) uses a permanent `party.id`.

### Fix — one resolution pass in `route()`, where every mutation kind passes through

In `master/src/services/sync.service.ts`, before the switch at `:289`:

```ts
async function resolvePayloadIds(mutation: Mutation, actor: ActorContext): Promise<Mutation> {
  const payload = { ...mutation.payload };
  const map = async (v: unknown) =>
    typeof v === 'string' && isTemporaryId(v)
      ? await identityRepo.resolveId(actor.tenantId, v)
      : v;

  payload.partyId = await map(payload.partyId);
  payload.ownerId = await map(payload.ownerId);
  payload.productId = await map(payload.productId);
  if (Array.isArray(payload.items)) {
    payload.items = await Promise.all(
      payload.items.map(async (item) => {
        const line = item as Record<string, unknown>;
        return { ...line, productId: await map(line.productId) };
      }),
    );
  }
  return { ...mutation, payload };
}
```

and start `route()` with `mutation = await resolvePayloadIds(mutation, actor)`.
`isTemporaryId` is already imported for `mapTemporaryId`.

Ordering is safe: the outbox preserves enqueue order, `party.create` precedes
`lead.create` in the batch, and `mapTemporaryId` commits in its own transaction
(`sync.service.ts:664-676`) before `route()` returns, so the `id_map` row is
visible to the next mutation.

This one change also covers `lead.update`/`order.update` (which reach the column
write through `mergeUpdate` with **no** party validation at all — a temporary
`party_id` there hits the `leads_party_fk` constraint from
`20260302000000_lead_order_rebuild.ts:555` and is recorded as another permanent
rejection), plus `partyVariant.upsert` and the `stock.*` kinds.

**Second half:** widen `office/src/sync/outbox.store.ts:92-101` so `remapIds`
rewrites payload references as well as `entityId` — today a still-queued lead
keeps pointing at the dead temporary id even after the party settles.

---

## Done looks like

- `npx tsc -p office/web/tsconfig.json --noEmit` and `npx tsc -p master/tsconfig.json --noEmit` clean.
- **New test (bug 2):** in `master/tests/sync.integration.test.ts`, push
  `[party.create(tempId), lead.create({partyId: tempId})]` in one batch; assert
  both come back `applied` and the lead's `party_id` equals the party's
  permanent id. No test covers a temporary id in a payload today.
- **New test (bug 1):** extract the `activeId` expression (`:586-591`) plus
  `:915` into a pure function and assert `setTab('addLead')` yields
  `activeScreenId === 'addLead'`. No React render needed. See the companion
  brief `web-reachability-and-dead-api-tests.md` — a generic version of this
  test catches the whole class.
- `npm run verify` green.
- **Manually verified in the running Office panel:** create a NEW party from
  inside Add Lead, then save a lead against it, then force a sync flush and
  confirm the lead is still there afterwards. Bug 2 only shows itself after the
  flush round-trips.

## Constraints

- **Ship both bugs in one change.** Bug 1 alone makes bug 2 reachable for the
  first time, and bug 2's failure mode is silent data loss.
- Rebuild the web bundle before retesting: `npm run build --workspace
  @orderbook/office-web`. The panel server only ever serves `office/web/dist`
  (`office/src/http/app.ts:1246-1247`), and the dist in this checkout is dated
  2026-09-01 while `PartyDrawer.tsx`, `ProductDrawer.tsx` and `ProductImages.tsx`
  are newer. `npm run dev:office` runs `tsx watch src/index.ts` against a bundle
  `predev:office` built once — editing `App.tsx` rebuilds nothing.
- Don't fix the refusal-invisibility problem here — it is real and it is what
  made bug 2 silent, but it is cross-cutting and has its own brief
  (`office-write-refusal-visibility.md`). Land this first.

---
*Implementer: append what changed and what you verified below this line.*
