# Party Access shows 50 parties and calls it the total; the CSV export stops at 200 and calls itself complete

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** S–M. Two silent-truncation bugs plus the navigation gap behind the
owner's "no option for assign party".

The owner asked to have the assign-party flow explained; that explanation lives
in the reply and in `docs/AI_COLLABORATION.md`'s working notes, not here. This
brief is the defects found while tracing it. **The feature itself works** — the
scoping is enforced in SQL, not in JS, so a restricted party is genuinely absent
from both the list and the count. The problems are all UI-side.

## 1. The screen shows the first 50 parties and reports that page size as the company total

`office/web/src/screens/PartyAccessScreen.tsx:88-92` calls
`api.partyAccess({ search, restriction })` with **no `limit`/`offset`**, so the
Master clamps to its default: `PAGING = { defaultLimit: 50, maxLimit: 200 }`
(`master/src/services/party-access.service.ts:41`).

The repository *does* return a real count — `total: firstCount(countRows)`
(`master/src/repositories/party.repository.ts:329, 345`) — and the screen throws
it away: `setRows(page.items)` (`:92`) keeps only the items, and the summary
renders `t('partyAccess.summary', { …, total: rows.length })` — **the page
length presented as the company's party count.**

**Fix:** keep the whole `Paginated<PartyAccessRow>` in state; send `limit`/`offset`
and add a pager (or Load more) below the `DataTable`, resetting the offset when
`search` or `restriction` changes; feed the summary `page.total`. The token needs
no change. Both clients already accept `limit`/`offset`
(`office/web/src/api.ts:571-579`, `master/web/src/api.ts:407-415`) and both
server paths already honour them.

**Important:** the two copies of this screen are held **byte-identical** by
`master/tests/party-access-screen-parity.test.ts`. Make the edit once and copy
the file over the other panel, or the test fails.

## 2. The CSV export silently truncates at 200 rows while documenting itself as the whole book

`master/src/services/party-access.service.ts:202` —
`const page = await listAssignments({ limit: PAGING.maxLimit, offset: 0 }, actor)`
with `maxLimit: 200`, run through `clampPaging`. There is no loop over offsets.
Its own doc comment (`:186-196`) claims the export is *"the whole book rather
than only its restricted half"*. `rowCount` (`:223`) counts the truncated rows,
so nothing downstream can notice.

**Fix:** loop in `exportRows` (`:197-224`), requesting pages of `PAGING.maxLimit`
at increasing offsets until `rows.length >= page.total`, guarding the loop with
the returned `total` so it terminates. Or give the repository a dedicated
unpaginated export query. Keep returning `{ csv, rowCount }` so the Office
`forwardCsv` path is untouched.

Related, small: the export is gated by `parties.export` on the Master's route but
**not** on the path the Office panel uses. Close that.

## 3. The owner's actual complaint — there is no route from a party to its access editor

Assigning is only reachable from a separate admin-tier nav entry. Someone
looking at a party record has no way to get to "who can see this", which is why
it reads as missing. **Add the route:** an action on the party detail modal that
opens the access editor for that party, gated on the same permission the Party
Access screen uses. That is the smallest change that answers the report.

## 4. Also confirmed, same area

- A party restricted to somebody **else** is labelled *"open to everyone"* to any
  `party.accessAll` holder — the label is computed from what the viewer can see
  rather than from the party's actual grant state. Misleading on the one screen
  whose whole job is to show who can see what.
- Every party edit claims **all eleven fields**, so a field changed elsewhere is
  silently reverted and reported as a conflict. Send only the fields the form
  actually touched.
- The new-party modal cannot record party **custom fields**, while its own
  comment claims it covers every column.
- Nothing prevents creating a **duplicate party** from the new-party modal.
- **Lead ownership** (`record.reassignOwner`) has no UI on either panel — worth
  noting because it is the other reasonable reading of "assign party", and it is
  genuinely absent.
- Party Access and half the new-party modal render **in English on a Hindi
  panel**, and the TODO markers in those files are stale.
- Stale comments describe the party detail and party form as **drawers**; both
  are modals.

## Done looks like

- `npx tsc` clean on both web configs and master.
- `npx vitest run master/tests/party-access-screen-parity.test.ts master/tests/i18n-tokens.test.ts` pass.
- **New test:** export with more than 200 assignment rows returns all of them.
- `npm run verify` green.
- **Manually verified** with more than 50 parties: the list pages, the summary
  reports the true total, and the CSV contains every row.

---
*Implementer: append what changed and what you verified below this line.*

---

## Landed 2026-09-17 (Claude) — items 1 and 2, plus the export permission gap

- **§1 truncation** — the screen keeps the whole `Paginated<PartyAccessRow>`,
  sends `limit`/`offset`, pages with a Load more, and resets the offset when the
  search or restriction changes. The summary reads `page.total`. The *restricted*
  figure is its own `limit: 1` count query rather than `rows.filter(...)`: with
  paging, filtering the loaded rows answers a question about the page while
  looking like an answer about the company — the same mistake one layer down.
  Both copies of the screen changed together; the parity test passes.
- **§2 CSV export** — `exportRows` loops to `page.total` now. Also closed the
  permission gap the brief noted at the end: `parties.export` was enforced on the
  Master's HTTP route and **not** on the `partyAccess:export` socket command an
  Office panel uses, so a whole-company map of who can see which customer was one
  transport away from ungated. Enforced in the service, where both paths meet.
- Tests PA-14 and PA-15 added to `master/tests/party-access.integration.test.ts`.
  **Not run** — the integration suites need PostgreSQL, which will not start as
  root, and the container had no other user. Run them on a normal checkout.

### Still open — everything in §3 and §4

§3 (a route from a party's detail to its access editor) and all of §4 are
untouched: the "open to everyone" label computed from the viewer rather than the
grant, the every-edit-claims-eleven-fields problem, party custom fields in the
new-party modal, duplicate-party prevention, `record.reassignOwner` having no UI,
the untranslated strings, and the stale "drawer" comments.
