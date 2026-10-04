# Recycle Bin: four entity types have no delete button at all, and nothing ever leaves the bin

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** M for part 1, L and a product decision for part 2.

Owner's item 4 was a **question**: *"Want to know if there is any action of
permanent delete if an item is soft deleted, or does it always stay in the
recycle bin?"*

**Answer: there is no permanent delete anywhere in the product. A soft-deleted
row stays in the database forever.** Audited across `master/src` for purge,
hardDelete, permanent, retention, sweep, cleanup — no scheduled sweep, no
retention setting, no admin "delete forever" route, and no permission in the
catalogue for one. The audit's verdict on this was "works as designed", so it
is an accepted design today, not a broken feature. What follows is what is
genuinely wrong around it.

## Part 1 — four of the nine entity types can never be deleted from any UI

```
master/web/src/api.ts:673-680   deleteParty / deleteProduct / deleteLead / deleteOrder
office/web/src/api.ts:518-525   the same four
grep "api.deleteParty|api.deleteProduct|api.deleteLead|api.deleteOrder"
   across master/web/src, office/web/src, ui/src  →  ZERO callers
```

`master/web/src/screens/LeadsOrdersScreen.tsx` and `InventoryScreen.tsx` do not
contain the string "delete" at all, case-insensitive. The server side is fully
built — `docs/BACKEND_MODULES.md:602` calls it *"the first delete path the
product has ever had for leads/orders/parties/products"* — the routes exist,
the permissions exist, and no screen ever called them.

So an item can only reach the Recycle Bin for five of the nine types. For leads,
orders, parties and products, the bin is unreachable in the first place.

**Fix:** add the row/detail delete action in
`master/web/src/screens/LeadsOrdersScreen.tsx` (lead, order) and
`InventoryScreen.tsx` (product), plus the party surface — which, note, depends
on `add-master-party-screen.md` landing first, since the Master has no party
screen to put it on. Gate each on its own permission (`leads.delete` etc.).
Each opens a confirm **Modal** — use the shared `ConfirmDialog` from
`design-audit-high-priority.md` item 4 if that has landed, never
`window.confirm` — and calls the existing client function, then refreshes.

Handle the documented 409: catch `ApiError.isConflict` and render
`caught.blockedBy` (reasons `live_reference` | `stock_on_hand` | `dispatched`)
in the same shape `RecycleBinScreen.tsx:483` already uses.

New i18n keys per entity on the existing pattern, in `en.ts`: e.g. `leads.deleteConfirmTitle`, `leads.deleteConfirmBody`
("It goes to the Recycle Bin and can be restored."), `leads.deleteFailed`,
`leads.deleted`.

**Decide explicitly:** does the Office panel get the same buttons? Its client
already has all four wrappers, and it ships a **complete Recycle Bin API
surface with no screen to use it**. Answer it in this file rather than letting
the two panels drift.

## Part 2 — nothing ever leaves the bin (the owner's actual question)

Consequences worth the owner knowing, all confirmed:

- **Tombstoned rows accumulate forever** with no bounded exit. For an
  install that runs for years on one PC, that is unbounded growth in every
  soft-deleted table.
- **A soft-deleted user's sealed password stays in the vault indefinitely** —
  `deleteVaultEntry` has no caller anywhere.
- **Image files of soft-deleted products are never reclaimed**, because the
  reclamation is keyed on the row being gone and the row never goes.
- `cascadeParents` is accepted end to end and honoured by nothing; the UI works
  around it non-atomically.

**This is a product decision, not a code decision.** Do not implement a purge
without the owner choosing. The three coherent options:

1. **Leave it.** State it in `docs/` so it is a documented choice, and fix the
   vault-entry and image-file leaks separately, since those are storage waste
   rather than a policy question.
2. **Retention sweep.** A configurable "delete forever after N days in the bin",
   run on the Master's existing scheduled-work path.
3. **Manual "Delete forever"** in the Recycle Bin screen, behind a new
   admin-tier permission.

Any of them has to answer the same four questions, which is where the real work
is: what happens to **foreign keys** pointing at the row; what happens to the
**sync tombstone** (an Office panel that has the row cached must learn it is
gone, or it reappears); what happens to **uploaded files** on disk; and what an
**offline panel** does when it reconnects after a purge it never saw.

## Done looks like

- Part 1: the four delete actions exist and are permission-gated; `npm run verify`
  green; manually verified that deleting a lead puts it in the bin and restoring
  it brings it back, and that a blocked delete shows the reason.
- Part 2: **do not start until the owner picks an option.** Record the choice at
  the top of this file when it is made.

---
*Implementer: append what changed and what you verified below this line.*
