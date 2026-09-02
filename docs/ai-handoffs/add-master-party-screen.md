# BLOCKING: the Master Panel has no way to add a party — the screen was never built

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** M–L. **Priority: second in the queue**, behind
`fix-office-new-lead-unreachable.md`.

The owner reported "Not able to add party (master panel)". This is not a bug in
a broken flow — **there is no flow**. Two independent audit agents (one frontend
lens, one backend lens) reached the same conclusion, and both survived
adversarial verification. I re-confirmed it myself.

## The evidence

```
master/web/src/api.ts:515   createParty: (input: PartyInput) => post<Party>('/api/parties', input)
                            → grep "createParty" master/web/src returns THIS LINE ONLY. Zero callers.

master/web/src/App.tsx:79-95  type Tab = dashboard | panels | orders | inventory | reports |
                              documents | access | partyAccess | assistant | fields |
                              integrations | logs | recycleBin | conflicts | settings | updates
                              → no 'parties', no 'catalog'.

master/web/src/screens/       17 files, none is a Parties or Catalog screen.
shared/src/i18n/en.ts:1689-1705  every nav.master.* token — there is no nav.master.parties.
```

`git log -S"createParty" -- master/web/src/api.ts` yields one commit (the repo
restructure), so the helper has **never** had a caller. The backend is fine and
proven: `master/tests/http-api.integration.test.ts:186-199` runs real first-run
setup, signs in as the seeded admin and POSTs `/api/parties` for a 201 with
`partyCode P-0001`; that suite passes 50/50 against a real embedded PostgreSQL.

The nearest screen states the omission as deliberate —
`master/web/src/screens/PartyAccessScreen.tsx:20-22`: *"parties are created and
edited on the Office Panel's Catalog screen, and this screen deliberately does
not duplicate that — it edits access, not the party."* `HANDOFF.md:2188` already
records it in passing too.

**So the admin's only route to creating a customer is to walk to an Office Panel
machine — or, if none is paired, there is none.** On the panel that owns the
database.

## Mundane causes ruled out, so nobody re-investigates them

- **Not a regression or a stale bundle.** `git log --all --diff-filter=A --
  "master/web/src/**Part*" "master/web/src/**Catalog*"` returns exactly one file
  ever added: `PartyAccessScreen.tsx`. No party-creation screen has existed at
  any commit on any branch.
- **Not seed data, migration, or permission.** The integration test above signs
  in as the seeded admin and gets a 201.

## Fix

**Take the shared-component route, not the copy-paste route.** The obvious
implementation — copying `office/web/src/components/PartyDrawer.tsx` into
`master/web/src/components/` — is permitted by `master/tests/no-duplicate-ui.test.ts`
(which only forbids re-creating `master/web/src/ui/` and importing `'../ui/…'`)
and the repo has already been burned by exactly that pattern:
`PartyAccessScreen.tsx` drifted in four places within a day and needed a
byte-parity test to hold it (`master/tests/party-access-screen-parity.test.ts`,
`HANDOFF.md:2031-2036`). Do not create a second one.

`office/web/src/components/PartyDrawer.tsx:29-42` imports only `../api` and
`@orderbook/ui`. Its sole panel-specific dependency is two `api` calls — the
same shape `AssistantScreen` already solves with an injected `transport` prop
(`office/web/src/App.tsx:818-826`).

1. **Move `PartyDrawer.tsx` into `ui/src/`**, with the two `api` calls injected
   as props. Export it from the `ui/src/index.ts` barrel —
   `no-duplicate-ui.test.ts:53-66` already enforces that barrel. Update the
   Office panel to pass its own `api` functions in. The two clients differ in
   return shape: the Office's `createParty` resolves to a `QueuedResult`, the
   Master's to a full `Party`, so the injected callback's contract must absorb
   that (the Office's `onCreated?.({ id: result.id, name, phone, city })` at
   `:160-161` becomes `onCreated?.(party)` with each panel adapting its own
   result). **This also answers the owner's "modify new party modal" item** —
   once the form is shared, changing it changes it once.
2. **Add `master/web/src/screens/PartiesScreen.tsx`** — `api.parties(search)`
   (`api.ts:511`) into a `DataTable` with `openOn="click"`; a row's Open shows
   the record in a **centred `Modal`**, per the house rule (never a drawer,
   never an inline expanding row); a `<Button icon="plus">` rendered only when
   `permissions.includes('parties.create')` — *absent*, not greyed, which is the
   convention stated at `PartyAccessScreen.tsx:17-18`.
3. **Wire it in `master/web/src/App.tsx`:** add `'parties'` to the `Tab` union
   (`:79-95`); add `canViewParties` beside `:386-395`; add the `workItems` entry
   (`:434-455`) as `canViewParties ? { id: 'parties', label: t('nav.master.parties'), icon: 'parties' } : null`;
   register the screen near `:753`; and add `parties: ['party']` to
   `SCREEN_ENTITIES` (`:104-114`) so a socket party event refetches the list.
4. **i18n:** add `nav.master.parties` to **both** `shared/src/i18n/en.ts` and
   `hi.ts` — `master/tests/i18n-tokens.test.ts` fails on a missing token, so
   confirm the key exists before writing the `t()` call. Do **not** reuse
   `catalog.parties.created` (`en.ts:771`) for the created toast: its text says
   "syncs when the Master is reachable", which is false on the Master itself.
   Every other token the form needs is already mirrored (`party.new.title`,
   `party.field.*`, `party.save`, `party.nameRequired`, `party.createFailed`).
5. **Update the now-false comment** at `master/web/src/screens/PartyAccessScreen.tsx:20-22`.
   That file is byte-identical to the Office copy and
   `master/tests/party-access-screen-parity.test.ts` fails unless **both**
   copies change together.

## The wider question this raises — decide it explicitly, don't drift

`master/web/src` has **no** catalog surface at all: `api.parties` (`:511`),
`createParty` (`:515`), `partyVariants` (`:516`), `createProduct` (`:525`) and
six other helpers are all dead code, and `docs/TESTING_PLAN.md` §5 (lines 85-97)
instructs the tester to create parties, categories, products **and** upload
product images on the Master. None of those screens exists.

So either the Master gains a catalog surface (this brief is step one of that),
or `docs/TESTING_PLAN.md` is wrong and the dead API helpers should go. **Say
which in this file before you start** — see the companion brief
`testing-plan-reconciliation.md`, which is where that decision belongs.

## Done looks like

- `npx tsc -p master/web/tsconfig.json --noEmit`, `npx tsc -p office/web/tsconfig.json --noEmit`,
  `npx tsc -p ui/tsconfig.json --noEmit` clean.
- `npx vitest run master/tests/no-duplicate-ui.test.ts master/tests/party-access-screen-parity.test.ts master/tests/i18n-tokens.test.ts master/tests/i18n-call-sites.test.ts` pass.
- `npm run verify` green.
- **Manually verified on the running Master:** create a party, see it in the
  list, open the row into a centred modal, edit it. Then confirm the same
  PartyDrawer still works unchanged on the Office panel — the move must not
  regress the panel that already had it.
- Rebuild both web bundles before manual testing (`npm run build --workspace
  @orderbook/master-web`, same for office-web) — the dists in this checkout are
  dated 2026-09-01 and are behind HEAD.

---
*Implementer: append what changed and what you verified below this line.*
