# Fields/AI domain: one wrong label, two stale comments, one broken vision-run field, dead code

**Owner:** Qwen 3 (via OpenCode). **Reviewer:** Command Code.
**Size:** S — five small, independent edits across `shared/src/domain/fields.ts`
and `shared/src/domain/ai.ts` (plus one call site each). Land as separate
commits per item if that's cleaner for review; they don't depend on each other.

Found by a read-only audit of files the previous 27-agent audit never read.
All verified by tracing actual call sites, not just reading the comment.

## 1. `product.productType`'s `usedBy` is wrong — tells an admin the wrong blast radius before they delete an option

**File:** `shared/src/domain/fields.ts:55-60`

```ts
{
  listKey: 'product.productType',
  labelToken: 'fieldSet.product.productType',
  hasHex: false,
  usedBy: ['products'],
},
```

`usedBy` is rendered verbatim as "Used by products" on the Fields screen
(`master/web/src/screens/FieldsScreen.tsx:474-476`) and is meant to list
every table that references the set (per its own doc comment at line 39).
But the real usage query (`master/src/repositories/field-usage.repository.ts:66-88`)
counts **three** sources for this key: `products`, `line_items`, and
`party_product_variants`. Every other entry in this file's `usedBy` list
matches its real sources except this one.

**Failure scenario:** an admin wants to retire a product type option. The
card says "Used by products". They confirm no *current* product uses it and
delete the option — but historical `line_items` on past leads/orders and
`party_product_variants` still reference that string. Those rows now render
a value that no longer exists in the option list.

**Fix:** `shared/src/domain/fields.ts:59` →
`usedBy: ['products', 'leads', 'orders']` (`line_items` rows belong to leads
and orders; the `fields.usedBy.leads`/`fields.usedBy.orders` label tokens
already exist in `en.ts`/`hi.ts` — reuse them, don't invent new ones).

## 2. Two stale count comments (four → eight, three → seven)

**File:** `shared/src/domain/fields.ts:12-14` and `:36`

Both comments say "four" ("the four managed option-list sets" / "the other
three have no colour to render") — the array (`FIELD_LIST_KEYS`) has **eight**
entries. (The "four ceramic vocabularies" comment near line 61 is a
*different*, correct claim about a 4-item subset — leave that one alone.)

**Fix:** line 13 → "The eight managed option-list sets."; line 36 → "the
other seven have no colour to render."

## 3. `AiStartInput.imageId` is documented for vision runs and read by nothing

**File:** `shared/src/domain/ai.ts:94-95`

```ts
/** For a vision run: an image already in a product's gallery. */
imageId?: Uuid | null;
```

Nothing in `master/src/services/ai.service.ts`, `ai-run.repository.ts`, or
`master/src/ai/` reads `input.imageId`. But `master/src/ai/prompt.ts` *does*
ship a `vision` system prompt ("Read what is printed on the item in the
photograph") in its `BY_KIND` map, and `ai.service.ts` builds every run's
message list as `{ role: 'system', content: systemPrompt(input.kind) }` with
no image attached, ever.

**Failure scenario:** if anything ever starts a `kind: 'vision'` run (nothing
does today — see the dead-code note below), the model gets told to read a
photograph it was never sent, and will confidently hallucinate an answer —
on a feature whose whole point is transcribing a code off a tile.

**Fix — pick one, this is a design call:**
- **Wire it** (bigger): in `ai.service.ts`, when `input.kind === 'vision'`,
  resolve `input.imageId` through the product-image repository under the
  caller's tenant and attach it as an image content part to the first user
  message.
- **Delete it** (matches reality — nothing produces a `'vision'` run today):
  remove `imageId` from `AiStartInput` and the `'vision'` entry from
  `BY_KIND` in `master/src/ai/prompt.ts`. Consider bundling this with the
  dead-`AiRunKind`-members cleanup below, since they're the same underlying
  question (is vision actually shipping soon, or should the unused surface
  come out).

**Don't decide this alone if you're not sure** — leave a note in this file
saying which you picked and why; this is a product-scope call (does OrderBook
ship a vision feature soon), not a pure code-correctness one.

## Dead code (delete, no behavior change)

- **`INSIGHT_CODES`** — `shared/src/domain/ai.ts:148-153`. Confirmed by grep:
  the array itself has zero readers anywhere in the repo (the `InsightCode`
  *type* is used, by `ai-insight.service.ts`; the runtime array is not).
  Delete lines 148-153.
- **`AiRunKind` members `'summarise' | 'vision' | 'narrate'`** —
  `shared/src/domain/ai.ts:21`. Only `'ask'` and `'draft'` are ever
  constructed anywhere (checked every route, service, and UI call site).
  The three unused members exist only in the DB CHECK constraint
  (`master/src/db/migrations/20260317000000_ai_assistant.ts:69`) and in
  `prompt.ts`'s `BY_KIND` map. If you're also deciding item 3 above, decide
  both together — pruning `'vision'` from the type but leaving `'summarise'`/
  `'narrate'` (which have no prompt-map entry issue at all) is fine to do
  separately. Removing a DB CHECK constraint value needs a migration —
  that's optional/out of scope here; leaving the CHECK slightly wider than
  the TypeScript union is harmless.
- **`as const` on `STARTER_DESIGNS`** (`shared/src/domain/document-starters.ts:138`)
  and on a similar array in `fields.ts:96` — a no-op given the explicit
  `readonly StarterDesign[]` type annotation already widens it. Harmless;
  fix only if you're already touching the surrounding lines for something
  else, not worth its own diff.

## Done looks like

- `npx tsc -p shared/tsconfig.json --noEmit` clean (this is a `shared/`
  change — remember to `npm run build:shared` before other workspaces'
  typechecks will see it).
- `npm run lint` clean.
- `npx vitest run shared/tests master/tests/i18n-tokens.test.ts` — confirm
  nothing that reads `FIELD_LIST_KEYS` or `AiRunKind` by exact shape breaks
  (check `master/tests/field-values-domain.test.ts` and anything under
  `master/tests/ai-*.test.ts` in particular).
- `npm run verify` green end to end.

---
*Implementer: append what changed and what you verified below this line.*
