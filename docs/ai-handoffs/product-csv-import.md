# Product CSV import — and the 500-product ceiling that has to be lifted with it

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** **L. Be honest about this one** — the import parser is the small half.
Do not start it before the two blocking bugs and
`office-write-refusal-visibility.md` have landed; it depends on both.

Owner's item 6: *"Import option for product through csv file"*.

## What exists today

There is **no import of anything, anywhere**. There is one CSV **export** — the
Party Access assignment table (`master/src/services/party-access.service.ts:197-224`,
reached from both panels, with `forwardCsv` on the Office side). That is the
existing precedent for CSV handling in this codebase; match its shape.

## The blocker that has to be scoped with the feature, not after it

**The Office catalogue cannot display more than 500 products.**

```
master/src/services/snapshot.service.ts:35   SNAPSHOT_LIMIT = 500
master/src/services/catalog.service.ts:53    PAGING = { defaultLimit: 100, maxLimit: 500 }   ← hard ceiling
office/web/src/screens/CatalogScreen.tsx:103-114   view.products.filter(...)   ← client-side, no paging, no server search
```

The Office panel's catalogue **is** the sync snapshot: one unpaginated page,
capped at 500 rows. Every product write to date is one product typed by a
person, so the cap has never been reached. **A CSV import is the first feature
whose entire purpose is to exceed it.**

Import 600 rows and all 600 validate, queue, push, and are created correctly in
PostgreSQL. The next snapshot returns the first 500; the other 100 exist in the
database and appear nowhere in the Office panel — not in the catalogue, not in
search, not in the product picker when adding a lead line. Because the Office
panel is the only place products are managed today (the Master has no catalog
screen — see `add-master-party-screen.md`), those 100 products are unreachable
from any UI. Separately, `productsComplete` flips false and the panel silently
stops pruning its cached product images (`office/src/http/app.ts:1873`).

**So there are two honest scopes. Pick one and write it here:**

- **Full:** give the Office catalogue a server-backed, paged list — go through
  `masterConnection.command('product:list', …)` (already declared,
  `shared/src/protocol/socket.ts:477`) when online, snapshot as the offline
  fallback, and page it; `CatalogScreen` already has the search and filter state
  to drive it. Raise or remove `PAGING.maxLimit` for the paged path.
- **Truthful small:** hard-cap the importer at 500 rows total (file rows +
  existing `view.products.length`) and refuse with a token that says exactly
  why. A small feature that tells the truth beats a large one with a silent data
  black hole.

## The importer itself

**Where to parse.** The Office panel is a thin client with no database. Follow
the path product images and avatars already use for panel-originated files
(upload to the Office local server, forward to the Master) rather than inventing
a third pattern — read those routes before deciding. If parsing lands in the
browser instead, the file never leaves the machine and each row becomes an
ordinary queued mutation, which composes with the existing offline story; say
which you chose and why.

**Column mapping.** Derive it from `shared/src/domain/entities.ts` `Product`
and the backend's `validateProductInput` — required versus optional must come
from the validator and the NOT NULL columns, not from taste.

**Permission.** Note that `products.export` and `products.bulk` are already
declared in the frozen permission catalogue and enforced **nowhere**. Use
`products.bulk` rather than minting a new key, and make it actually enforced.

**Per-row error reporting.** A 500-row file with 3 bad rows must say which 3.
Do **not** depend on the global rejection buffer for this: `lastRejections` is
replaced, not accumulated, on every flush
(`office/src/sync/sync.service.ts:99`), and with a batch size of 100
(`office/src/config/index.ts:110`) a 500-row import loses four batches out of
five. The importer should keep its own `mutationId → source row number` map from
the 202 responses (`office/src/http/app.ts:1358` already returns `mutationId`)
and match `MutationResult.error` / `missingPermission`
(`shared/src/sync/mutations.ts:120-129`) back to row numbers itself.

**Offline.** Decide whether a bulk import may queue at all. Two things argue
against it: the outbox rewrites its **entire file on every single mutation**, so
a bulk import is quadratic in disk writes; and a large import floods the
Master's 2000-entry change ring, which can force every *other* panel into a full
snapshot rebuild. Refusing to import while offline is a legitimate, defensible
answer — write down whichever you pick.

**Limits.** Check the multer limits already configured before adding another.

## Done looks like

- Scope decision recorded at the top of this file before implementation starts.
- `npm run verify` green.
- **New tests:** a valid file imports; a file with 3 bad rows reports exactly
  those 3 row numbers; the row cap (or the paged catalogue) behaves as chosen.
- **Manually verified** with a real supplier file of at least 600 rows, and
  confirm every imported product is findable in the catalogue *and* in the Add
  Lead product picker.

---
*Implementer: append what changed and what you verified below this line.*
