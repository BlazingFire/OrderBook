# Product images: rates leak to the browser, there is nowhere to actually look at a photo, and the whole UI is untranslated

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** M. Item 1 is a **data-leak fix that should land on its own, first.**

Owner's item 6: *"there is no product image flow"*. Partly confirmed — uploading
and editing exist; **viewing does not**, which for a ceramics catalogue is the
primary use of a photo.

## 0. Check this before anything else — it may be the owner's entire report

`office/web/vite.config.ts:26-29` proxies **only** `/api` to `localhost:4200`.
Cached product images are served from `/uploads/images/…`
(`office/src/http/app.ts:539`), which is **not** proxied — so every product image
404s for anyone evaluating the panel through the Vite dev server at
`http://localhost:5200`. The Master has the same hole:
`master/web/vite.config.ts:27-32` proxies `/api` and `/socket.io` only, while
avatars are mounted at `/uploads/avatars`.

**Fix regardless** (one line per config, add `/uploads`), and ask the owner
whether they were testing a dev server or the packaged panel. If it was the dev
server, this is the whole item and the rest below is still worth doing but is
not what they hit.

## 1. SECURITY — all four image mutations return the unmasked Product

```
master/src/services/image.service.ts:238-240  return updated;   // uploadImage
                                    :280-282  return updated;   // updateImageCaption
                                    :315-317  return updated;   // reorderImages
                                    :369-371  return updated;   // deleteImage
```

`reloadProduct` (`:90-94`) calls `productRepo.findProductById`, which applies no
masking. Every *other* product write ends
`return maskProduct(product, productVisibility(actor));`
(`catalog.service.ts:423`, `:484`). The panel route ships it verbatim
(`panel-image.routes.ts:62`), the Office server relays the body byte-for-byte
(`office/src/http/app.ts:511-512`), and the socket commands do the same.

**A clerk with `products.edit` but not `field.purchaseRate.view` adds a photo and
the 201 body contains `purchaseRate` and `rate`** — plainly visible in the
browser's network tab, and set into React state via `ProductImages.tsx:66-67`.
The panel's own `/api/snapshot` went to the trouble of stripping exactly these
keys for that person.

**Fix:** make `reloadProduct(tenantId, productId, actor)` return the masked
record, so all four sites are fixed at once and a fifth mutation added later
cannot forget. `publishChange` must keep the **raw** product — the Office
re-masks change events per signed-in user at `office/src/http/app.ts:1575`.
Add a case to `master/tests/panel-image-route.integration.test.ts` asserting the
201 body has no `purchaseRate` key for an actor lacking `field.purchaseRate.view`.

## 2. There is no way to look at a product photo

`office/web/src/screens/ProductDetail.tsx:125-213` is the entire record-detail
modal: a `KeyValueList`, a stock table, three buttons. **No image, no reference
to `product.images` at all.** The only two render sites in the repo are
`CatalogScreen.tsx:354-363` (`slotPx={28}`) and `ProductImages.tsx:125-133`
(`slotPx={96}`), both inside the edit form or a table row. `variantForSlot`
(`shared/src/domain/entities.ts:514-522`) maps 28 and 96 to `micro` (64px) and
`thumb` (240px) — so `large` (800px) and `master` (2048px), encoded on **every**
upload (`image.service.ts:141-154`), are never requested by anything.

**Fix:** add a photo block at the top of `ProductDetail.tsx` — primary image via
`<ProgressiveImage slotPx={320}>` plus a row of remaining thumbnails, click to
enlarge into a nested `<Modal size="lg">` at `variant="large"`. Sort with the
primary-first comparator already in `ProductImages.tsx:34-36` — extract it to one
exported helper rather than writing it twice. Guard on
`product.images.length > 0`. New mirrored tokens: `product.detail.photos`,
`product.detail.photos.none`, `product.detail.photo.viewLarge`.

## 3. Every string in the image UI is a hardcoded English literal

`office/web/src/components/ProductImages.tsx` imports no `t` at all: 'Choose an
image file' (`:50`), 'Could not save the image' (`:70`), 'Primary' (`:144`),
'Set primary' (`:159`), 'Move earlier' (`:167`), 'Move later' (`:173`), 'Remove
image' (`:184`), '+ Add photo' (`:208`), and more. `ui/src/ImageCropModal.tsx` is
the same: 'Edit image' (`:281`), 'Cancel'/'Save', 'Loading…', 'Free crop',
'Rotate left', 'Straighten'.

**Fix:** add a `product.image.*` block to `en.ts` and mirror it in `hi.ts`
(setPrimary, primary, moveEarlier, moveLater, remove, add, notAnImage,
tooLarge `{max}`, saveFailed, updateFailed, removeFailed, reorderFailed) plus
`image.crop.*` (title, save, cancel, loading, aspect.free, aspect.original,
rotateLeft, rotateRight, straighten). `ImageCropModal` sits in `ui/`, which
already imports `t` from `./i18n.js`. While there, fix `hi.ts:3346`
`'product.field.images': 'Photos'` — an untranslated English value the parity
test cannot catch.

**Root cause worth knowing:** `eslint.config.js:63-67` registers
`orderbook-i18n/no-untranslated-jsx-text` over both panels' and `ui/`'s `.tsx`
and sets it to `'off'` — the comment at `:57-62` says ~4,000 lines of JSX are
unswept and it will be promoted screen by screen. **Promoting it for these two
files as part of this change** is the way to stop it regressing. Note the rule
only sees JSX text in `.tsx`, so it would never catch the server-side literals
in `office/src/services/user-session.service.ts:86-96` — those need a different
guard and are out of scope here.

## 4. Offline upload fails with a raw Node error, and the browser client drops the key

`office/src/http/app.ts:513-518` answers the upload route's catch with
`{error:'unavailable', message: …}` and **no `messageKey`** — unlike the socket
path's `failForward` at `:1651-1657`, which does send
`messageKey: 'error.unavailable'`. The message the user sees is whatever undici
threw ('fetch failed') or `master-fetch.ts:24`.

Independently, `office/web/src/api.ts:323-339` `postFile` destructures only
`error`, `message` and `details` — never `messageKey`/`params`, unlike `send()`
at `:247-264`. So even correctly-keyed refusals (an oversized file, for
instance) are downgraded.

**Fix, best value for effort:** (a) add `messageKey: 'error.unavailable'` to the
503 at `:513-518`; (b) widen `postFile`'s `detail` type to pass
`messageKey`/`params` into the `ApiError`, and wrap the fetch in
`AbortSignal.timeout` with its own upload budget — 60 MB over LAN needs more
than the 15 s `send()` uses, so a separate `UPLOAD_TIMEOUT_MS`. Both fix every
multipart caller, not just images.

## Also confirmed, lower priority

- A cache-miss image while the Master is offline degrades to a **permanently
  blurred placeholder with no message** — for an offline-first product, say
  something instead.
- The image controls (upload/delete/reorder) are offered to users who lack
  `products.edit` — same prop-threading fix as
  `office-product-form-gates-and-slimming.md`.
- **Captions** are supported end to end on the Master and unreachable from the
  Office panel.
- A snapshot arriving mid-fetch can delete the directory a cache fill is writing
  into, surfacing to the user as a generic failure.

## Done looks like

- `npx tsc` clean across master, office, both web configs, ui.
- New integration-test case for item 1 (no `purchaseRate` in the 201 body).
- `npx vitest run master/tests/i18n-tokens.test.ts shared/tests/i18n-coverage.test.ts` pass.
- `npm run verify` green.
- **Manually verified:** images render in the packaged panel *and* through the
  dev server; a photo can be viewed large from the product detail modal; the UI
  is Hindi on a Hindi panel; an upload attempted while the Master is unreachable
  gives a translated message.

## Constraints

- Land item 1 alone first. It is a masking hole in an otherwise consistent wall
  and does not need the rest of the feature to be worth shipping.

---
*Implementer: append what changed and what you verified below this line.*
