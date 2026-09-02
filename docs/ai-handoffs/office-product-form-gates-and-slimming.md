# The New Product form: 29 fields, three money fields with no permission gate, and Enter saves the lot

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** M. Contains **permission-enforcement** defects — treat those with more
rigor than the field-count work.

Owner's item 6: *"Too much field in New Product modal"*. The audit confirmed it
and found that the more serious problems in the same component are about
permissions, not field count.

**Naming:** the component is `office/web/src/components/ProductDrawer.tsx`, but
it renders a centred **Modal**. The file, its props and two neighbouring doc
comments all still call it a drawer. Rename or at minimum fix the comments while
you are in there — the house rule is modals, and the stale name is what makes a
reader assume a house-rule violation that is not actually there.

## The permission defects — fix these first

### 1. Purchase rate renders on every New Product regardless of permission

```ts
// office/web/src/components/ProductDrawer.tsx:139
const canSeeCost = !editing || 'purchaseRate' in editing;   // editing is null on create → always true
```

The module comment at `:14-17` claims the Master masks the field by *absence*,
so "the key is not there" and "the person may not see cost" are the same test.
That test only exists on the edit branch. On create there is no record to infer
from, so it defaults **permissive**: the field renders at `:371-376`, is sent at
`:246`, and the Master silently discards it
(`catalog.service.ts:396-398` → `withPermittedPurchaseRate`).

A clerk without `field.purchaseRate.edit` types a cost price, saves, and is
never told it was dropped.

**Fix:** thread `view.permissions` from `CatalogScreen` into the form
(`CatalogScreen.tsx:489-501` already holds `view`; `SyncSnapshot.permissions`
exists at `shared/src/protocol/socket.ts:394` and `DashboardScreen.tsx:93-95`
already reads it this way). Then `:139` becomes
`const canSeeCost = permissions.includes('field.purchaseRate.edit')`, which
correctly governs both the render and the payload spread.

### 2. Sale rate is rendered to everyone, and its hint leaks a permission slug to the shop floor

`:369` renders `rate` unconditionally and `:226` always sends it. The module
comment at `:19-21` justifies this by saying the screen "is not handed a
`can()`" — **that is false**, per the same prop thread as above.

Worse, the hint beside the field (`product.field.rateHint`) reads *"Entered in
rupees; the Master ignores this without field.saleRate.edit"* — a raw permission
key shown to a salesperson, in both catalogues.

**Fix:** render the field only under `field.saleRate.edit`, omit `rate` from the
payload when not rendered (mirroring the `...(canSeeCost ? {…} : {})` pattern
already at `:246`), and **delete** `product.field.rateHint` from `en.ts:2124`
and `hi.ts:3352`. With the field gated, the hint has nothing left to explain.

### 3. MRP is documented as gated and enforced nowhere

`shared/src/domain/entities.ts:419-427` and `visibility.ts:55-56` both say `mrp`
is "writable only under `field.saleRate.edit`". No code implements it:
`withPermittedRate` (`visibility.ts:93-101`) destructures only `rate`.

**Fix once, in `shared/src/domain/visibility.ts:93-101`:** widen
`withPermittedRate` to strip `mrp` and `pricePerSqft` alongside `rate`. That
repairs all three panel call sites at once (`catalog.service.ts:397`, `:454`,
and the merge filter at `sync.service.ts`). Add `'mrp'` to the
`field.saleRate.edit` entry of `WRITE_GUARDS` (`public-api.routes.ts:68`) for the
API path, and gate the MRP control in the form on the same permission.

**Note:** this overlaps `docs/ai-handoffs/close-money-field-gate-gaps.md`, which
already covers the same three-path gap. **Do that brief, not this section** —
and delete this section once it lands, so the two do not drift.

### 4. "New product" is not gated on `products.create`

`office/web/src/screens/CatalogScreen.tsx:200` and the empty-state action at
`:447-454` have no permission check; `grep "products.create" office/web/src
master/web/src` matches nothing but a toast token. The screen already receives
`view.permissions`. The same applies to **"New party"** at `:169` and
`PartyDetail.tsx:218`'s Edit button (`parties.edit` is never checked, and Edit
is offered on view-only parties).

**Fix:** pass the action permissions in and hide the controls — *absent*, not
greyed, per the convention at `PartyAccessScreen.tsx:17-18`.

The refusal a user earns by pressing an ungated button is itself invisible —
that half is `office-write-refusal-visibility.md`.

## The usability defects

### 5. Enter in the Name field saves the whole 29-field form

`:355-357` puts `onKeyDown={… if (event.key === 'Enter') void save() …}` on the
Name input — field **2 of 29**. The container already has `useEnterToAdvance`
(`:192`), whose handler is a *native* listener that calls `preventDefault()` but
not `stopPropagation()`; React 18 dispatches synthetic handlers from the root and
does not skip a defaultPrevented event, so the input's `save()` still runs. No
other editor in the panel does this.

**Fix: delete `:355-357`.** One-line deletion, no replacement —
`useEnterToAdvance` already provides advance-and-save-on-last, and
`useCommand('record.save', …)` at `:193` keeps Ctrl+S.

### 6. Product code is a required, autofocused first field the Master generates for free

The person is made to invent an identifier the system would have assigned. Make
it optional with a "leave blank to auto-generate" affordance, or drop it from
create entirely.

### 7. Four range-constrained numeric fields have no client-side bound

A typo is accepted, queued, and rejected out of sight (see the refusal brief).
Add `min`/`max` matching the server's validator.

## The field count itself

Produce the reorganisation as a **separate commit** after the gates land, so a
permission fix is not buried in a layout diff. Ground every decision in what the
backend actually requires — read `validateProductInput` in `master/src` and the
NOT NULL columns before deciding anything is optional:

- **Primary form:** the fields a salesperson genuinely needs to create a
  sellable product.
- **A collapsed "More details" disclosure:** everything optional at both the
  validator and the DB.
- **Dropped from the Office panel:** catalogue-management concerns that belong
  to the Master.

Note the module comment justifies the form's size with a field count **seven
short** of what it actually renders — fix that comment too.

## Done looks like

- `npx tsc` clean on office, office/web, shared.
- **New test:** an actor without `field.purchaseRate.edit` creating a product
  through the panel path must not have `purchaseRate` accepted, and the form
  must not render it. Add the server half beside the existing catalog tests.
- `npx vitest run master/tests/i18n-tokens.test.ts` passes after the `rateHint`
  deletion.
- `npm run verify` green.
- **Manually verified** with a role that lacks each money permission in turn:
  the field is absent, not greyed; and Enter in the Name field advances instead
  of saving.

---
*Implementer: append what changed and what you verified below this line.*
