# Product photos — frontend brief for a design pass

The product-image feature (upload, crop/rotate, gallery) is built and working end to end on the
Office Panel, styled with the existing token/component system only (`office/web/src/ui/` —
Inter + IBM Plex Mono, the light/dark ramps, the spacing scale, `Modal`/`Drawer`/`Button`/
`DataTable`). Nothing here has had a visual design pass — it's built the way
`docs/UI_REDESIGN.md` calls "Phase 1, working not polished." This document is a precise account
of what exists today, so a mockup can be produced against the real thing instead of a guess.

Backend: `7-IMAGE-PIPELINE.md` (ported for this repo's plain Express/React stack — see
`HANDOFF.md`'s 2026-08-25 "Product image pipeline" entry for the full porting-decision log).
This document covers the frontend only.

---

## Contents

1. [Catalog table — new thumbnail column](#1-catalog-table--new-thumbnail-column)
2. [Product drawer — edit mode + Photos section](#2-product-drawer--edit-mode--photos-section)
3. [Photo strip — reorder, primary, delete](#3-photo-strip--reorder-primary-delete)
4. [Crop/rotate editor — the new surface](#4-croprotate-editor--the-new-surface)
5. [How an image actually paints on screen](#5-how-an-image-actually-paints-on-screen)
6. [Constraints a design has to respect](#6-constraints-a-design-has-to-respect)
7. [Deliberately not built — don't design for it](#7-deliberately-not-built--dont-design-for-it)

---

## 1. Catalog table — new thumbnail column

`office/web/src/screens/CatalogScreen.tsx` — the Products table (`DataTable`) gained one new
leading column and a new interaction: a row is now clickable, opening the product in edit mode.

```
 ┌────┬──────────┬───────────────────────────┬────────┬─────────┬───────┬───────────┐
 │    │ Code     │ Product                   │ Type   │ Size    │ Grade │ Rate/box  │
 ├────┼──────────┼───────────────────────────┼────────┼─────────┼───────┼───────────┤
 │[img│ PRD-0042 │ Carrara Gloss 600×600      │ Floor  │ 600×600 │ A     │ ₹412.00   │
 │ ]  │          │  — Carrara                │        │         │       │           │
 ├────┼──────────┼───────────────────────────┼────────┼─────────┼───────┼───────────┤
 │[   │ PRD-0043 │ Rustic Beige Wall Tile     │ Wall   │ 300×450 │ A     │ ₹268.00   │
 │ ]  │          │                            │        │         │       │           │
 └────┴──────────┴───────────────────────────┴────────┴─────────┴───────┴───────────┘
   ^ has a photo (micro variant)   ^ no photo yet — empty cell, no dedicated empty state
```

- Row 1 has a photo (the product's primary image, `micro` variant, 64px source); row 2 has none
  yet — that empty state is currently just a blank cell and needs a real design.
- Clicking anywhere on a row opens [the product drawer in edit mode](#2-product-drawer--edit-mode--photos-section).
  This click target is new — the table was previously inert except for the "+ New product" button.
- The thumbnail is a small square today (~28px), no border treatment, no hover affordance beyond
  the row's own hover state.

## 2. Product drawer — edit mode + Photos section

`office/web/src/components/ProductDrawer.tsx` was create-only before this feature (there was no
product edit surface anywhere in the panel). It now opens in edit mode from a catalog row click,
prefilled with the product's fields, with one new field group — **Photos** — appended after Rate,
appearing only when editing an existing product (a product needs to exist before anything can be
attached to it).

**Worth deciding explicitly:** right now Photos is one more field in a long single-column form
inside a 520px-wide right-hand drawer. Whether a photo gallery belongs inside that form at all —
versus its own tab, its own section with a real heading treatment, or a wider drawer for this one
case — is open. The component boundary (`ProductImages`, below) doesn't assume where it's mounted.

## 3. Photo strip — reorder, primary, delete

`office/web/src/components/ProductImages.tsx` — the gallery manager embedded in the drawer above.
Each thumbnail renders the `thumb` variant (240px long edge, generated once at upload), shown at
84px on screen today.

```
 ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌ ─ ─ ─ ─ ┐
 │          │  │          │  │          │  ¦          ¦
 │  photo 1 │  │  photo 2 │  │  photo 3 │  ¦  + Add    ¦
 │ [primary]│  │          │  │          │  ¦  photo    ¦
 └──────────┘  └──────────┘  └──────────┘  └ ─ ─ ─ ─ ┘
 Primary  🗑    Set primary   Set primary
                ▲ ▼ 🗑         ▲ ▼ 🗑
```

| State | What triggers it | What happens |
|---|---|---|
| Primary badge | One photo is always primary | Small label under the thumbnail; no reorder arrows shown on the primary tile (it's pinned first regardless of stored order) |
| "Set primary" | Click, on any non-primary tile | One API round trip; that tile becomes primary, badge moves |
| Reorder | ▲ / ▼ icon buttons | Swaps this tile with its neighbor among the non-primary photos. **No drag-and-drop exists** — see §7 |
| Delete | Trash icon | Immediate — no confirmation dialog today. Deleting the primary photo auto-promotes the oldest remaining one |
| Add photo | Dashed "+" tile | Opens the OS file picker, then [the crop/rotate editor](#4-croprotate-editor--the-new-surface) for the chosen file |
| Empty gallery | Last photo deleted | Only the "+ Add photo" tile remains — no empty-state illustration or copy exists yet |

## 4. Crop/rotate editor — the new surface

`office/web/src/ui/ImageCropModal.tsx` — opens the moment a file is picked. This is the one
genuinely new interaction surface in the whole feature; everything else is a variation on an
existing table/drawer/thumbnail pattern. It's a `<canvas>` inside the existing `Modal`, built with
plain pointer events — no cropping library.

```
 ┌───────────────────────────────────┐   ASPECT
 │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│   [Free] [1:1] [4:3] [Original]
 │▓▓▓▓┌───────────────────┐▓▓▓▓▓▓▓▓▓│
 │▓▓▓▓│ ·         ·       │▓▓▓▓▓▓▓▓▓│   ROTATE
 │▓▓▓▓│                   │▓▓▓▓▓▓▓▓▓│   [↺ Left] [↻ Right]
 │▓▓▓▓│ ·         ·       │▓▓▓▓▓▓▓▓▓│
 │▓▓▓▓│  (rule-of-thirds) │▓▓▓▓▓▓▓▓▓│   STRAIGHTEN · +6.5°
 │▓▓▓▓└───────────────────┘▓▓▓▓▓▓▓▓▓│   ──────●───────────
 │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
 └───────────────────────────────────┘
              [ Cancel ]  [ Save ]
```

- **Darkened surround, bright crop window** — everything outside the crop rectangle is dimmed;
  four corner handles resize it, dragging inside moves it.
- **Rule-of-thirds grid** is drawn inside the crop rectangle at all times (thin white lines).
- **Aspect presets** — Free, 1:1, 4:3, Original — each recenters a fresh suggested crop; there is
  no "keep my current crop while changing the ratio" behavior.
- **Rotation** is two controls doing one job: 90° step buttons and a ±15° fine slider; the
  displayed degree value is their sum. Any rotation change also resets the crop rectangle to a
  fresh centered suggestion — cropping and then rotating starts the crop over, deliberately,
  rather than trying to remap a rectangle across a resized canvas.
- Footer is the modal's standard **Cancel / Save** pair. Save is disabled until the image has
  finished decoding into the canvas.

**Where the real design opportunity is:** this modal is functionally complete but visually the
least resolved thing in the feature — plain buttons, a system range input for the slider, no
visual language tying "rotate" and "straighten" together, no indication of the source image's true
aspect ratio versus the crop's. It's the one piece here that would most reward dedicated attention
rather than a token-only pass.

## 5. How an image actually paints on screen

`office/web/src/ui/ProgressiveImage.tsx` is what every thumbnail described above actually renders
through. It matters for design because it defines what a design can assume about loading states:

1. A **blurhash placeholder** — a soft, colour-accurate blur derived from the photo itself —
   paints instantly, before any real pixel has arrived over the network.
2. The real image swaps in with **no fade, no skeleton shimmer, no spinner**, ever, by design — a
   loading animation on what is meant to feel instant would itself read as latency.

Practical effect for a designer: there is no "loading" visual state to design for a photo that has
a `blurhash` (every photo does, from the moment it's uploaded) — only the blurred placeholder and
the resolved photo. The only true empty state is *no photo at all* (§1 and §3's empty tiles above).

## 6. Constraints a design has to respect

| Constraint | Why |
|---|---|
| 1366×768 floor, no mobile layout | Matches the rest of the product — this runs on fixed shop-PC hardware, per the existing design system's own floor |
| Four fixed sizes per photo: `2048 / 800 / 240 / 64`px | Generated once at upload; nothing is ever resized on screen. A design cannot introduce a fifth size without a backend change |
| WebP only, no other raster format at render time | Every uploaded format (JPEG/PNG/HEIC/etc.) is normalized to WebP at import — a design only ever needs to style WebP output |
| No CSS transition longer than one frame on an image swap | Deliberate — see §5. A design that adds a fade-in would be undoing a real performance decision, not a cosmetic one |
| Plain `<canvas>`, no cropping/imaging library | Matches the existing "no runtime style/animation library" rule extended to imaging — a redesign of the editor should stay canvas-based |

## 7. Deliberately not built — don't design for it

Each of these was a conscious scope call, not an oversight — flagging them so a design pass
doesn't spend effort on a capability that doesn't exist yet:

- **Drag-and-drop reordering** — up/down buttons only (§3).
- **Re-opening the editor on an already-saved photo** to re-crop it — the editor only ever runs
  against a freshly picked file.
- **Any product-photo surface on the Master Panel's own UI** — this entire feature is Office Panel
  only, since Master has no product-catalogue screen at all.
- **Delete confirmation** — removing a photo is immediate today.
- **Background prefetch / offline photo caching** — done, but it's a backend behavior with no
  on-screen state to design around.
