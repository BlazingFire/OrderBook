# Product conflict possibilities

Every way two product records (or a record and the catalogue) can disagree,
whether the software catches it today or must. Status: **caught** (in the
tree), **new** (added by this change), or **out of scope** (owner decision).

## A. Identity conflicts — is this the same product twice?

| # | Possibility | Status | Where |
|---|---|---|---|
| A1 | Same brand + same normalized name (Product) | caught | duplicate-products.ts |
| A2 | Same brand + same normalized code (Product) | caught | duplicate-products.ts |
| A3 | Same Product + same normalized name (sub product) | caught | duplicate-products.ts |
| A4 | Same brand + shared variant code (sub product) | caught | duplicate-products.ts |
| A5 | Transitive group (A~B name, B~C code) | caught | duplicate-products.ts |
| A6 | Cross-brand same name (`OPT` vs `KAJ` "One Piece Toilet") — **not** a conflict: two brands may sell the same product name by design | out of scope | catalogue v2 rule |
| A7 | Same normalized name under different case/punctuation/accents (`DAMRU` vs `Damru ` vs `DÁMRU`) | caught (folded by duplicateKey) | shared duplicate-products.ts |
| A8 | **NEW: near-name suspect** — same brand + same Product + Levenshtein ≤ 2 on normalized name (`DAMRU` vs `DAMRUU`, `1111` vs `1112`): likely typo, needs human verdict | new | this change |
| A9 | **NEW: code-variant suspect** — same brand + codes differing only by separator/case/padding (`OPT-0001` vs `OPT0001` vs `opt-001`): likely same product, needs human verdict | new | this change |
| A10 | Same size, different product (`600x600` everywhere) — never a conflict | out of scope | size is free text |

## B. Code conflicts — the unique business key

| # | Possibility | Status | Where |
|---|---|---|---|
| B1 | Variant code taken anywhere in catalogue (create/update/import) | caught | assertCodesFree + partial unique index |
| B2 | Duplicate code inside one input set (case-insensitive) | caught | validateProductVariants |
| B3 | Duplicate code inside one import file | caught | findDuplicatesInFile |
| B4 | Category code taken per tenant | caught | pre-check + unique index |
| B5 | Category (brand, name) taken | caught | pre-check + unique index |
| B6 | Restore collides with live codes | caught | restoreCodesTaken / restoreCollision |
| B7 | Code moved onto another live product's code (update path) | caught | assertCodesFree with ownProductId |
| B8 | Brand moved into a (brand, name) collision | caught | assertCategoryFree on update |

## C. Reference conflicts — deleting or changing what lines quote

| # | Possibility | Status | Where |
|---|---|---|---|
| C1 | Delete blocked: Product still holds live sub products | caught | DuplicatesInline blockedBy |
| C2 | Delete blocked: sub product quoted by live lead/order lines | caught | DuplicatesInline blockedBy |
| C3 | Delete blocked: category with live products, party with live lines | caught | blockedByLiveReferences |
| C4 | Alteration: pending lines patched, dispatched/converted frozen | caught | product-alteration.service.ts |
| C5 | **NEW: variant retired while lines quote it** — variant set to inactive while pending lines reference it: lines keep quoting a hidden variant (pickers hide it, old lines keep it) | new | this change |
| C6 | **NEW: colour removed while lines quote it** — sub product colour changed/removed while pending lines hold the old colour label | new | this change |
| C7 | **NEW: category retired while products live in it** — category deactivated with live sub products still assigned | new | this change |

## D. Data-quality conflicts — valid but suspicious

| # | Possibility | Status | Where |
|---|---|---|---|
| D1 | Blank size on a sized product family | caught (warning only) | import review |
| D2 | Missing weight (null weightKg) | caught (shown as "weight missing", excluded from totals) | catalogue rules |
| D3 | **NEW: weight changed > 50%** — variant weight edited from 20 kg to 2 kg: likely decimal slip, needs confirm | new | this change |
| D4 | **NEW: orphan variant label** — label names a colour not on the `stock.colour` list | new | this change |
| D5 | **NEW: size format drift** — same Product mixes `600x600`, `600X600`, `600 x 600`: harmless but splits filters | new | this change |
| D6 | **NEW: alias collides** — alias equals another product's name or code in the same brand (counter confusion) | new | this change |
| D7 | **NEW: fixed-rule without colour** — colourRule=fixed but no variant colour named | new | this change |
| D8 | **NEW: dedicated-rule with colour** — colourRule=dedicated but a colour is named (contradiction) | new | this change |

## E. Sync / concurrency conflicts

| # | Possibility | Status | Where |
|---|---|---|---|
| E1 | Stale edit (baseFieldHlc moved) | caught | 409 staleEdit |
| E2 | Offline field clash (HLC loser) | caught | sync_conflicts |
| E3 | Resolve race (lines arrived since list read) | caught | resolveDuplicates refused |
| E4 | Restore busy (single restore at a time) | caught | productRestoreBusy |
| E5 | Concurrent code grab (two panels create the same code, online or offline) | caught | createProduct → assertCodesFree → named productCodeTaken rejection |

## F. Import conflicts

| # | Possibility | Status | Where |
|---|---|---|---|
| F1 | In-file duplicate rows | caught | findDuplicatesInFile |
| F2 | Row clashes with catalogue (create/update/skip decisions) | caught | smart review |
| F3 | Invalid colour rule / fixed-without-colour | caught | import validation |
| F4 | **NEW: import renames a live product** — file's (brand, name) matches but code differs from the stored code: rename or new product? Needs human verdict | new | this change |
| F5 | **NEW: import moves a sub product** — same sub product name under a different Product than stored: move or new? Needs human verdict | new | this change |

Out of scope by owner decision: money fields (removed 2026-09-21), cross-brand
name equality (A6), size as identity (A10), auto-merging anything (every resolve
is explicit, human-confirmed, logged).
