# `mrp` is documented as permission-gated and enforced nowhere; `pricePerSqft` is gated on one path out of three

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** S — a targeted permission-gating gap, not a redesign. Touches three
files that all already implement the same pattern for `rate`/`purchaseRate`.

Found by the adversarial self-check of commit `10ddc68` (this session's own
concurrency/sync fix), while it verified the new sync-merge money gate at
`master/src/services/sync.service.ts:421-428`. That gate is correct and, if
anything, stricter than every other path — this is a pre-existing gap the
check surfaced, not something the commit introduced or regressed.

## What's documented vs. what's enforced

`shared/src/domain/entities.ts:421-427` and
`shared/src/domain/visibility.ts:55-56` both state the rule: `mrp` is
"writable only under `field.saleRate.edit`", same as `rate`. Checked every
write path for both fields:

| Path | `rate` | `pricePerSqft` | `mrp` |
|---|---|---|---|
| `sync.service.ts` merge gate (`:421-428`) | dropped ✓ | dropped ✓ | **not dropped** |
| `catalog.service.ts` `withPermittedRate` (via `visibility.ts:93-101`) | dropped ✓ | **not dropped** | **not dropped** |
| `public-api.routes.ts:68` `WRITE_GUARDS` | — | dropped ✓ | **not dropped** |

So a role with `products.edit` but not `field.saleRate.edit` can change a
product's MRP through every write path in the product, and can change
`pricePerSqft` through the ordinary catalogue screen and an offline sync
push (only the public API blocks it).

## Fix

Extend the existing pattern rather than inventing a new one — all three
call sites already special-case `rate`/`purchaseRate` on the same
`canEditRates`/`canEditCost` checks:

1. **`shared/src/domain/visibility.ts`**, `withPermittedRate` (`:93-101`):
   add `mrp` and `pricePerSqft` to whatever it currently strips when the
   actor lacks `field.saleRate.edit`. Check the function's exact field list
   before editing — name the sibling fields it already drops so `mrp`/
   `pricePerSqft` join the same branch rather than a new one.
2. **`master/src/services/sync.service.ts:421-428`**: add `mrp` alongside
   `rate`/`pricePerSqft` in the `!canEditRates(actor)` branch.
3. **`master/src/http/routes/public-api.routes.ts:68`**: add `mrp` to
   `WRITE_GUARDS` alongside `pricePerSqft`'s existing guard.

## Constraints

- Don't touch `rate`'s or `purchaseRate`'s existing gating — only add the
  two missing fields to the branches that already exist for their siblings.
- This is a permission-enforcement gap on a money field — treat it with the
  same rigor as the commit's own sync-merge money gate: add a test per path
  (mirror whatever test already exists for `rate` being dropped under
  `!canEditRates`, one for `mrp`/`pricePerSqft` on each of the three paths).

## Done looks like

- `npx tsc -p shared/tsconfig.json --noEmit` (rebuild `shared` before the
  other workspaces see it) and `npx tsc -p master/tsconfig.json --noEmit`
  clean.
- New/updated tests covering all three paths for both fields.
- `npm run verify` green end to end.

---
*Implementer: append what changed and what you verified below this line.*
