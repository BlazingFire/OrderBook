# Swisware+ 2026 master catalogue

The product data OrderBook loads with `npm run reload:catalog --workspace @orderbook/master`.
Transcribed from the image-only PDF "SWISWARE 2026" (28 pages, Smruti Ceramics). Every caption was
read twice independently and the two readings agreed on all 24 product pages.

This file is data. The loader (`master/src/domain/catalogue-markdown.ts`) reads the `## Brands`,
`## Colour range` and `## Products` sections exactly as laid out below, so keep the headings,
the table columns and the `### CODE — Name` product headings when editing.

## How to read it

- **Brand** — the maker line. A product belongs to one brand.
- **Product** (main product) — `### CODE — Name`. The code is the software code staff can type in
  the product bar instead of the name. Codes are always alphanumeric and unique.
- **Sub product** — the model inside a product, as printed under its photo: a number (`1111`, `41`)
  or alphanumeric (`DAMRU`, `MAGENTA`, `E-01`). Unique inside its product.
- **Colours** — the colours a sub product is offered in, comma-separated.
  - One colour — made in that colour only. No colour choice at entry.
  - Empty — the design is its own colour (numbered and designer pieces, accessories). No colour
    choice and no colour is printed.
  - `All` — any colour of the colour range; lead entry picks one or more colours with a quantity
    each.
- **Print side** — `Default`, `Left` or `Right`: which half of a printed note the sub product belongs
  on. `Default` keeps the original rule — an alphanumeric sub product prints in the **Model** column
  (left) and a numeric one in the **Code** column (right). Every row below is `Default`, as loaded
  on 2026-11-16 when the setting was introduced.

## Transcription decisions

- Page 4 prints each toilet as a model and its trap size, e.g. `102 (9")`. The model is the number
  (`102`, a coded sub product); the trap size goes in the Size column first (`9", L-27, B-15, H-26`).
  `SYPHONIC (9")` is recorded the same way as `SYPHONIC`.
- Page 4 and pages 6–7 are both headed "ONE PIECE TOILET"; they are one product (`OPT`) with the white
  models and the numbered designer models as its sub products.
- The "* ALSO AVAILABLE IN IVORY" footers carry no asterisk on any caption; per the owner, page 4
  toilets are white only. No product was given an ivory option from the footer.
- Sofiya Vitrosa Double Colour prints BLACK and MAGENTA twice: once as the floral basin, once as the
  solid-colour pedestal. The solid ones are `BLACK PLAIN` and `MAGENTA PLAIN`.
- `13x9 SQUQRE` is printed with a typo; recorded as `13x9 SQUARE`.
- `14x14 NEW CORNER` sits in the table-top grid on page 14; per the owner (2026-10-07) it is a Table
  Top Wash Basin, listed last there with that product's rule.
- Under Counter and Lab Sink models are named by their size; the stray spaces in the printed lab-sink
  captions (`24 x18x10`) and in `SILVER SET (18x14 )` are dropped.
- The ten coloured pans under Orissa Pan (Marble, Double Colour, Rustic) illustrate the colour offer;
  they are not models (owner, 2026-10-07: colour examples). Orissa Pan carries `All` colours.
- Page 13's "all items available in all colours" covers only the trap closets, per the owner
  (2026-10-07): the E.W.C and Anglo Indian S and P traps carry `All` colours; the Eco Concealed,
  Eco Concealed Slim, Modern and Concealed closets are white only (one colour, White).
- Eco Concealed Designer has no E-04 or E-05; per the owner that is intentional.
- Page 25's "all colours available in all items" adds no colour choice: per the owner, Silver,
  18"x14", Micra and the Rustic Set come in just the colours printed, one sub product per caption.
- Page 18's `18x14 SET` is the white Plain Set; page 25's 18"x14" Vitrosa Double Colour is a different
  product (`D1814`) with its own sub products, per the owner.
- Urinal channel and the three traps are photographed in cream, so they carry no colour (empty Colours)
  rather than a guessed one.
- Sizes are copied only where the catalogue prints them. Vitrosa ranges print no size.
- Colour hex values were sampled from the swatches on page 2.

## Brands

| Brand |
|---|
| Swisware+ |

## Colour range

| Colour | Hex | Group |
|---|---|---|
| White | #FEFEFE | Standard |
| Light Blue | #C7EAFD | Standard |
| Mint Green | #D1E5B0 | Standard |
| Pink | #F8C4DA | Standard |
| Ivory | #FFF4DE | Standard |
| Grey | #BCC0C3 | Standard |
| Red Brown | #A4643C | Standard |
| Coffee Brown | #683E2F | Standard |
| Magenta | #C37986 | Standard |
| Alpine Blue | #94ABD7 | Standard |
| Oasis Green | #226F4E | Standard |
| Royal Black | #24252B | Standard |
| Burgundy | #84444D | Standard |
| Pacific Blue | #3C4A6F | Standard |
| Orange | #F58634 | Standard |
| Blood Red | #EC3237 | Standard |
| Rustic Red Brown | #BB8562 | Rustic |
| Rustic Coffee Brown | #8E6B58 | Rustic |
| Rustic Magenta | #C3A1A3 | Rustic |
| Rustic Royal Black | #6F6F6E | Rustic |
| Rustic Alpine Blue | #BBC6E4 | Rustic |

## Products

41 products, 549 sub products.

### OPT — One Piece Toilet

- Brand: Swisware+
- Catalogue pages: 4, 6, 7

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 102 | 9", L-27, B-15, H-26 | White | Default |
| 2 | 111 | 9", L-27, B-14, H-25 | White | Default |
| 3 | 103 | 9", L-27, B-14, H-27 | White | Default |
| 4 | 105 | 9", L-26, B-14, H-27 | White | Default |
| 5 | 107 | 9", L-26, B-14, H-30 | White | Default |
| 6 | 108 | 9", L-25, B-14, H-27 | White | Default |
| 7 | 109 | 9", L-26, B-14, H-29 | White | Default |
| 8 | 110 | 9", L-25, B-14, H-27 | White | Default |
| 9 | 112 | 9", L-26, B-14, H-28 | White | Default |
| 10 | 113 | 9", L-25, B-14, H-28 | White | Default |
| 11 | 115 | 9", L-26, B-14, H-29 | White | Default |
| 12 | 116 | 9", L-26, B-14, H-29 | White | Default |
| 13 | 118 | 9", L-26, B-14, H-30 | White | Default |
| 14 | 204 | 4", L-27, B-14, H-27 | White | Default |
| 15 | SYPHONIC | 9", L-26, B-14, H-30 | White | Default |
| 16 | 1111 |  |  | Default |
| 17 | 1113 |  |  | Default |
| 18 | 1115 |  |  | Default |
| 19 | 1123 |  |  | Default |
| 20 | 1127 |  |  | Default |
| 21 | 1133 |  |  | Default |
| 22 | 1141 |  |  | Default |
| 23 | 1143 |  |  | Default |
| 24 | 1144 |  |  | Default |
| 25 | 1151 |  |  | Default |
| 26 | 1152 |  |  | Default |
| 27 | 1153 |  |  | Default |
| 28 | 1155 |  |  | Default |
| 29 | 1156 |  |  | Default |
| 30 | 1171 |  |  | Default |
| 31 | 1181 |  |  | Default |
| 32 | 1183 |  |  | Default |
| 33 | 1184 |  |  | Default |
| 34 | 1185 |  |  | Default |
| 35 | 1190 |  |  | Default |
| 36 | 1191 |  |  | Default |
| 37 | 1192 |  |  | Default |
| 38 | 1193 |  |  | Default |
| 39 | 1194 |  |  | Default |
| 40 | 1195 |  |  | Default |
| 41 | 1196 |  |  | Default |
| 42 | 1197 |  |  | Default |
| 43 | 1198 |  |  | Default |
| 44 | 1199 |  |  | Default |
| 45 | 1158 |  |  | Default |
| 46 | 1159 |  |  | Default |
| 47 | 1160 |  |  | Default |
| 48 | 1161 |  |  | Default |
| 49 | 1162 |  |  | Default |
| 50 | 1163 |  |  | Default |
| 51 | 1164 |  |  | Default |
| 52 | 1165 |  |  | Default |
| 53 | 1166 |  |  | Default |
| 54 | 1167 |  |  | Default |
| 55 | 1168 |  |  | Default |
| 56 | 1169 |  |  | Default |

### OPB — One Piece Basin

- Brand: Swisware+
- Catalogue pages: 5

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | DAMRU | L-16, H-31 | White | Default |
| 2 | NOVA | L-15, H-31 | White | Default |
| 3 | DAMRU PLUS | L-16, H-32 | White | Default |
| 4 | RUBY | L-16, H-33 | White | Default |
| 5 | ROYAL | L-16, H-34 | White | Default |
| 6 | RAINBOW | L-18, B-14, H-31 | White | Default |
| 7 | DIAMOND | L-18, H-32 | White | Default |
| 8 | VOLVO | L-18, H-31 | White | Default |
| 9 | CROWNIE | L-16, H-33 | White | Default |
| 10 | SAPPHIRE | L-16, B-14, H-32 | White | Default |
| 11 | EAGLE | L-17, B-13, H-32 | White | Default |
| 12 | LAVA | L-19, B-15, H-32 | White | Default |
| 13 | SCORPIO | L-18, H-32 | White | Default |
| 14 | WUDU BASIN - WHITE |  | White | Default |
| 15 | WUDU BASIN - BLACK |  | Black | Default |

### DMV — One Piece Basin Damru Vitrosa

- Brand: Swisware+
- Catalogue pages: 8, 9

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 41 |  |  | Default |
| 2 | 42 |  |  | Default |
| 3 | 46 |  |  | Default |
| 4 | 47 |  |  | Default |
| 5 | 48 |  |  | Default |
| 6 | 49 |  |  | Default |
| 7 | 50 |  |  | Default |
| 8 | 51 |  |  | Default |
| 9 | 53 |  |  | Default |
| 10 | 55 |  |  | Default |
| 11 | 57 |  |  | Default |
| 12 | 58 |  |  | Default |
| 13 | 59 |  |  | Default |
| 14 | 60 |  |  | Default |
| 15 | 61 |  |  | Default |
| 16 | 64 |  |  | Default |
| 17 | 65 |  |  | Default |
| 18 | 66 |  |  | Default |
| 19 | 67 |  |  | Default |
| 20 | 69 |  |  | Default |
| 21 | 70 |  |  | Default |
| 22 | 72 |  |  | Default |
| 23 | 76 |  |  | Default |
| 24 | 81 |  |  | Default |
| 25 | 82 |  |  | Default |
| 26 | 83 |  |  | Default |
| 27 | 84 |  |  | Default |
| 28 | 85 |  |  | Default |
| 29 | 87 |  |  | Default |
| 30 | 88 |  |  | Default |
| 31 | 89 |  |  | Default |
| 32 | 91 |  |  | Default |
| 33 | 92 |  |  | Default |
| 34 | 95 |  |  | Default |
| 35 | 97 |  |  | Default |
| 36 | 100 |  |  | Default |

### DPV — One Piece Basin Damru Plus Vitrosa

- Brand: Swisware+
- Catalogue pages: 9

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 29 |  |  | Default |
| 2 | 30 |  |  | Default |
| 3 | 31 |  |  | Default |
| 4 | 32 |  |  | Default |
| 5 | 33 |  |  | Default |
| 6 | 34 |  |  | Default |
| 7 | 35 |  |  | Default |
| 8 | 36 |  |  | Default |
| 9 | 37 |  |  | Default |
| 10 | 38 |  |  | Default |
| 11 | 39 |  |  | Default |
| 12 | 40 |  |  | Default |

### NVV — One Piece Basin Nova Vitrosa

- Brand: Swisware+
- Catalogue pages: 10

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 150 |  |  | Default |
| 2 | 151 |  |  | Default |
| 3 | 152 |  |  | Default |
| 4 | 153 |  |  | Default |
| 5 | 157 |  |  | Default |
| 6 | 158 |  |  | Default |
| 7 | 161 |  |  | Default |

### RYV — One Piece Basin Royal Vitrosa

- Brand: Swisware+
- Catalogue pages: 10

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 350 |  |  | Default |
| 2 | 351 |  |  | Default |
| 3 | 352 |  |  | Default |
| 4 | 353 |  |  | Default |
| 5 | 354 |  |  | Default |

### RBV — One Piece Basin Rainbow Vitrosa

- Brand: Swisware+
- Catalogue pages: 10

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 570 |  |  | Default |
| 2 | 571 |  |  | Default |
| 3 | 572 |  |  | Default |
| 4 | 575 |  |  | Default |
| 5 | 577 |  |  | Default |
| 6 | 580 |  |  | Default |
| 7 | 581 |  |  | Default |
| 8 | 582 |  |  | Default |
| 9 | 583 |  |  | Default |
| 10 | 585 |  |  | Default |

### DIV — One Piece Basin Diamond Vitrosa

- Brand: Swisware+
- Catalogue pages: 11

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 271 |  |  | Default |
| 2 | 272 |  |  | Default |
| 3 | 275 |  |  | Default |
| 4 | 276 |  |  | Default |
| 5 | 277 |  |  | Default |
| 6 | 278 |  |  | Default |
| 7 | 282 |  |  | Default |
| 8 | 283 |  |  | Default |
| 9 | 285 |  |  | Default |

### CRV — One Piece Basin Crownie Vitrosa

- Brand: Swisware+
- Catalogue pages: 11

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 171 |  |  | Default |
| 2 | 172 |  |  | Default |
| 3 | 173 |  |  | Default |
| 4 | 174 |  |  | Default |
| 5 | 175 |  |  | Default |
| 6 | 179 |  |  | Default |
| 7 | 180 |  |  | Default |

### EGV — One Piece Basin Eagle Vitrosa

- Brand: Swisware+
- Catalogue pages: 11

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 381 |  |  | Default |
| 2 | 382 |  |  | Default |
| 3 | 384 |  |  | Default |
| 4 | 385 |  |  | Default |
| 5 | 386 |  |  | Default |
| 6 | 387 |  |  | Default |

### SPV — One Piece Basin Sapphire Vitrosa

- Brand: Swisware+
- Catalogue pages: 12

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 367 |  |  | Default |
| 2 | 369 |  |  | Default |
| 3 | 371 |  |  | Default |
| 4 | 372 |  |  | Default |
| 5 | 373 |  |  | Default |
| 6 | 376 |  |  | Default |
| 7 | 378 |  |  | Default |
| 8 | 379 |  |  | Default |

### VLV — One Piece Basin Volvo Vitrosa

- Brand: Swisware+
- Catalogue pages: 12

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 330 |  |  | Default |
| 2 | 331 |  |  | Default |
| 3 | 332 |  |  | Default |
| 4 | 334 |  |  | Default |
| 5 | 335 |  |  | Default |

### LVV — One Piece Basin Lava Vitrosa

- Brand: Swisware+
- Catalogue pages: 12

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 192 |  |  | Default |
| 2 | 193 |  |  | Default |
| 3 | 194 |  |  | Default |
| 4 | 195 |  |  | Default |

### SCV — One Piece Basin Scorpio Vitrosa

- Brand: Swisware+
- Catalogue pages: 12

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 551 |  |  | Default |
| 2 | 555 |  |  | Default |
| 3 | 556 |  |  | Default |
| 4 | 557 |  |  | Default |

### WC — Water Closet

- Brand: Swisware+
- Catalogue pages: 13

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | E.W.C - ECO CONCEALED |  | White | Default |
| 2 | E.W.C - ECO CONCEALED SLIM |  | White | Default |
| 3 | E.W.C - MODERN |  | White | Default |
| 4 | E.W.C - CONCEALED |  | White | Default |
| 5 | E.W.C - S TRAP |  | All | Default |
| 6 | E.W.C - P TRAP |  | All | Default |
| 7 | ANGLO INDIAN - S TRAP |  | All | Default |
| 8 | ANGLO INDIAN - P TRAP |  | All | Default |

### ECD — Eco Concealed Designer

- Brand: Swisware+
- Catalogue pages: 13

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | E-01 |  |  | Default |
| 2 | E-02 |  |  | Default |
| 3 | E-03 |  |  | Default |
| 4 | E-06 |  |  | Default |
| 5 | E-07 |  |  | Default |
| 6 | E-08 |  |  | Default |
| 7 | E-09 |  |  | Default |

### UC — Under Counter

- Brand: Swisware+
- Catalogue pages: 13

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 18x18 | 18x18 | White | Default |
| 2 | 22x16 | 22x16 | White | Default |

### LS — Lab Sink

- Brand: Swisware+
- Catalogue pages: 13

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 24x18x10 | 24x18x10 | White | Default |
| 2 | 20x16x7 | 20x16x7 | White | Default |
| 3 | 18x12x6 | 18x12x6 | White | Default |

### WB — Wash Basin

- Brand: Swisware+
- Catalogue pages: 14

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 12x9 | 12x9 | White | Default |
| 2 | 13x9 SQUARE | 13x9 | White | Default |
| 3 | 14x11 ROUND | 14x11 | White | Default |
| 4 | 16x16 CORNER | 16x16 | White | Default |
| 5 | 17x11 | 17x11 | White | Default |
| 6 | 18x12 | 18x12 | White | Default |
| 7 | 18x12 SQUARE | 18x12 | White | Default |
| 8 | 18x13 | 18x13 | White | Default |
| 9 | 16x12 | 16x12 | White | Default |
| 10 | 18x14 | 18x14 | White | Default |
| 11 | 18x14 GOLDEN | 18x14 | White | Default |
| 12 | 18x14 POLO | 18x14 | White | Default |
| 13 | 18x14 SILVER | 18x14 | White | Default |
| 14 | 18x16 MICRA | 18x16 | White | Default |
| 15 | 20x16 | 20x16 | White | Default |
| 16 | 22x16 | 22x16 | White | Default |

### TTW — Table Top Wash Basin

- Brand: Swisware+
- Catalogue pages: 14

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 7501 | 23x14 |  | Default |
| 2 | 7505 | 17x11 |  | Default |
| 3 | 7507 | 17x13 |  | Default |
| 4 | 7601 | 16x12 |  | Default |
| 5 | 7702 | 20x13 |  | Default |
| 6 | 7704 | 20x16 |  | Default |
| 7 | 7706 | 17x17 |  | Default |
| 8 | 7708 | 19x15 |  | Default |
| 9 | 7801 | 22x17 |  | Default |
| 10 | 7803 | 18x14 |  | Default |
| 11 | 7805 | 18x14 |  | Default |
| 12 | 7807 | 16x16 |  | Default |
| 13 | 7901 | 28x14 |  | Default |
| 14 | 7902 | 23x14 |  | Default |
| 15 | 7903 | 25x15 |  | Default |
| 16 | 14x14 NEW CORNER | 14x14 |  | Default |

### TTV — Table Top Vitrosa Basin

- Brand: Swisware+
- Catalogue pages: 15, 16, 17

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 7511 |  |  | Default |
| 2 | 7512 |  |  | Default |
| 3 | 7513 |  |  | Default |
| 4 | 7662 |  |  | Default |
| 5 | 7663 |  |  | Default |
| 6 | 7664 |  |  | Default |
| 7 | 7665 |  |  | Default |
| 8 | 7667 |  |  | Default |
| 9 | 7668 |  |  | Default |
| 10 | 7641 |  |  | Default |
| 11 | 7643 |  |  | Default |
| 12 | 7644 |  |  | Default |
| 13 | 7646 |  |  | Default |
| 14 | 7647 |  |  | Default |
| 15 | 7721 |  |  | Default |
| 16 | 7722 |  |  | Default |
| 17 | 7726 |  |  | Default |
| 18 | 7741 |  |  | Default |
| 19 | 7742 |  |  | Default |
| 20 | 7743 |  |  | Default |
| 21 | 7744 |  |  | Default |
| 22 | 7745 |  |  | Default |
| 23 | 7781 |  |  | Default |
| 24 | 7782 |  |  | Default |
| 25 | 7783 |  |  | Default |
| 26 | 7784 |  |  | Default |
| 27 | 7785 |  |  | Default |
| 28 | 7786 |  |  | Default |
| 29 | 7788 |  |  | Default |
| 30 | 7851 |  |  | Default |
| 31 | 7852 |  |  | Default |
| 32 | 7853 |  |  | Default |
| 33 | 7854 |  |  | Default |
| 34 | 7855 |  |  | Default |
| 35 | 7857 |  |  | Default |
| 36 | 7858 |  |  | Default |
| 37 | 7859 |  |  | Default |
| 38 | 7514 |  |  | Default |
| 39 | 7516 |  |  | Default |
| 40 | 7517 |  |  | Default |
| 41 | 7525 |  |  | Default |
| 42 | 7760 |  |  | Default |
| 43 | 7761 |  |  | Default |
| 44 | 7762 |  |  | Default |
| 45 | 7767 |  |  | Default |
| 46 | 7768 |  |  | Default |
| 47 | 7769 |  |  | Default |
| 48 | 7840 |  |  | Default |
| 49 | 7842 |  |  | Default |
| 50 | 7843 |  |  | Default |
| 51 | 7844 |  |  | Default |
| 52 | 7845 |  |  | Default |
| 53 | 7847 |  |  | Default |
| 54 | 7848 |  |  | Default |
| 55 | 7914 |  |  | Default |
| 56 | 7915 |  |  | Default |
| 57 | 7916 |  |  | Default |
| 58 | 7917 |  |  | Default |
| 59 | 7918 |  |  | Default |
| 60 | 7920 |  |  | Default |
| 61 | 7953 |  |  | Default |
| 62 | 7941 |  |  | Default |
| 63 | 7943 |  |  | Default |
| 64 | 7945 |  |  | Default |
| 65 | 7946 |  |  | Default |
| 66 | 7931 |  |  | Default |
| 67 | 7933 |  |  | Default |
| 68 | 7934 |  |  | Default |
| 69 | 7935 |  |  | Default |

### TTH — Table Top Hydrographic

- Brand: Swisware+
- Catalogue pages: 17

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | A |  |  | Default |
| 2 | B |  |  | Default |
| 3 | C |  |  | Default |
| 4 | D |  |  | Default |
| 5 | E |  |  | Default |
| 6 | F |  |  | Default |
| 7 | G |  |  | Default |
| 8 | H |  |  | Default |
| 9 | I |  |  | Default |
| 10 | J |  |  | Default |
| 11 | K |  |  | Default |

### V1812 — 18x12 Vitrosa

- Brand: Swisware+
- Catalogue pages: 17

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | BLACK | 18x12 | Black | Default |
| 2 | MINT GREEN | 18x12 | Mint Green | Default |
| 3 | MAGENTA | 18x12 | Magenta | Default |

### R1812 — 18x12 Rustic

- Brand: Swisware+
- Catalogue pages: 17

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | BLACK | 18x12 | Rustic Royal Black | Default |
| 2 | COFFEE BROWN | 18x12 | Rustic Coffee Brown | Default |
| 3 | ALPINE BLUE | 18x12 | Rustic Alpine Blue | Default |

### PS — Plain Set

- Brand: Swisware+
- Catalogue pages: 18

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | GOLDEN SET (18X14) | 18x14 | White | Default |
| 2 | POLO SET (18X14) | 18x14 | White | Default |
| 3 | SILVER SET (18x14) | 18x14 | White | Default |
| 4 | 18x14 SET | 18x14 | White | Default |
| 5 | MICRA SET (18X16) | 18x16 | White | Default |
| 6 | 20x16 SET | 20x16 | White | Default |
| 7 | REPOSE SET (22X16) | 22x16 | White | Default |
| 8 | FABIA SET (20X17) | 20x17 | White | Default |
| 9 | SOFIYA SET (22X17) | 22x17 | White | Default |
| 10 | STERLING SET (22X17) | 22x17 | White | Default |
| 11 | AMAZON SET (22x17) | 22x17 | White | Default |
| 12 | SUPREME SET (23X17) | 23x17 | White | Default |
| 13 | SERENA SET (23X17) | 23x17 | White | Default |
| 14 | CRETA SET (23x17) | 23x17 | White | Default |
| 15 | CRYSTA SET (24X18) | 24x18 | White | Default |
| 16 | LAURET SET (24X18) | 24x18 | White | Default |
| 17 | LEXO SET (24X18) | 24x18 | White | Default |
| 18 | EURO SET (24X19) | 24x19 | White | Default |
| 19 | DIAMOND SET (23X20) | 23x20 | White | Default |
| 20 | INNOVA SET (23X18) | 23x18 | White | Default |
| 21 | BIG STERLING SET (25X21) | 25x21 | White | Default |
| 22 | DOLPHIN SET (18X20) | 18x20 | White | Default |

### BSD — Big Sterling Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 19

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 3001 |  |  | Default |
| 2 | 3002 |  |  | Default |
| 3 | 5001 |  |  | Default |
| 4 | 5002 |  |  | Default |
| 5 | 5003 |  |  | Default |
| 6 | 5004 |  |  | Default |
| 7 | 5005 |  |  | Default |
| 8 | 5011 |  |  | Default |
| 9 | 5012 |  |  | Default |
| 10 | 5014 |  |  | Default |
| 11 | 6001 |  |  | Default |
| 12 | 6002 |  |  | Default |
| 13 | 6003 |  |  | Default |
| 14 | 6004 |  |  | Default |
| 15 | 6005 |  |  | Default |
| 16 | 6006 |  |  | Default |
| 17 | 6007 |  |  | Default |
| 18 | 6008 |  |  | Default |
| 19 | 6010 |  |  | Default |
| 20 | 6011 |  |  | Default |
| 21 | 6012 |  |  | Default |
| 22 | 6015 |  |  | Default |
| 23 | 6016 |  |  | Default |
| 24 | WOODEN |  | Wooden | Default |

### EUD — Euro Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 20

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 6501 |  |  | Default |
| 2 | 6502 |  |  | Default |
| 3 | 6503 |  |  | Default |
| 4 | 6504 |  |  | Default |
| 5 | 6505 |  |  | Default |
| 6 | 6506 |  |  | Default |
| 7 | 6507 |  |  | Default |
| 8 | 6508 |  |  | Default |
| 9 | 6509 |  |  | Default |
| 10 | 6510 |  |  | Default |
| 11 | 6511 |  |  | Default |
| 12 | 6512 |  |  | Default |
| 13 | 6513 |  |  | Default |
| 14 | 6514 |  |  | Default |

### SFD — Sofiya Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 20

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | MAGENTA |  | Magenta | Default |
| 2 | MINT GREEN |  | Mint Green | Default |
| 3 | ALPINE BLUE |  | Alpine Blue | Default |
| 4 | BLACK |  | Black | Default |
| 5 | RED |  | Red | Default |
| 6 | RED BROWN |  | Red Brown | Default |
| 7 | ORANGE |  | Orange | Default |
| 8 | BLACK PLAIN |  | Black | Default |
| 9 | MAGENTA PLAIN |  | Magenta | Default |

### AMD — Amazon Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 21

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 5501 |  |  | Default |
| 2 | 5502 |  |  | Default |
| 3 | 5503 |  |  | Default |
| 4 | 5504 |  |  | Default |
| 5 | 5505 |  |  | Default |
| 6 | 5506 |  |  | Default |
| 7 | 5507 |  |  | Default |
| 8 | 5508 |  |  | Default |
| 9 | 5509 |  |  | Default |
| 10 | 5511 |  |  | Default |
| 11 | 5512 |  |  | Default |
| 12 | 5513 |  |  | Default |
| 13 | 5514 |  |  | Default |
| 14 | 5515 |  |  | Default |
| 15 | 5516 |  |  | Default |
| 16 | 5517 |  |  | Default |
| 17 | 5518 |  |  | Default |
| 18 | 5521 |  |  | Default |
| 19 | 5522 |  |  | Default |
| 20 | 5523 |  |  | Default |
| 21 | 5524 |  |  | Default |
| 22 | 5525 |  |  | Default |
| 23 | 5526 |  |  | Default |
| 24 | 5527 |  |  | Default |

### SRD — Serena Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 22, 23, 24

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 605 |  |  | Default |
| 2 | 1001 |  |  | Default |
| 3 | 1016 |  |  | Default |
| 4 | 1019 |  |  | Default |
| 5 | 1036 |  |  | Default |
| 6 | 1037 |  |  | Default |
| 7 | 1050 |  |  | Default |
| 8 | 1051 |  |  | Default |
| 9 | 1052 |  |  | Default |
| 10 | 1061 |  |  | Default |
| 11 | 1062 |  |  | Default |
| 12 | 1063 |  |  | Default |
| 13 | 1064 |  |  | Default |
| 14 | 1065 |  |  | Default |
| 15 | 1066 |  |  | Default |
| 16 | 1067 |  |  | Default |
| 17 | 1068 |  |  | Default |
| 18 | 2001 |  |  | Default |
| 19 | 2002 |  |  | Default |
| 20 | 2003 |  |  | Default |
| 21 | 2006 |  |  | Default |
| 22 | 2501 |  |  | Default |
| 23 | 2502 |  |  | Default |
| 24 | 2503 |  |  | Default |
| 25 | 2504 |  |  | Default |
| 26 | 2505 |  |  | Default |
| 27 | 2506 |  |  | Default |
| 28 | 2507 |  |  | Default |
| 29 | 2508 |  |  | Default |
| 30 | 2509 |  |  | Default |
| 31 | 2510 |  |  | Default |
| 32 | 2511 |  |  | Default |
| 33 | 2512 |  |  | Default |
| 34 | 2513 |  |  | Default |
| 35 | 2514 |  |  | Default |
| 36 | 2515 |  |  | Default |
| 37 | 2516 |  |  | Default |
| 38 | 2517 |  |  | Default |
| 39 | 4001 |  |  | Default |
| 40 | 4002 |  |  | Default |
| 41 | 4005 |  |  | Default |
| 42 | 4011 |  |  | Default |
| 43 | 4012 |  |  | Default |
| 44 | 4016 |  |  | Default |
| 45 | 4017 |  |  | Default |
| 46 | 4018 |  |  | Default |
| 47 | 4019 |  |  | Default |
| 48 | 4020 |  |  | Default |
| 49 | 4021 |  |  | Default |
| 50 | 4022 |  |  | Default |
| 51 | 4031 |  |  | Default |
| 52 | 4032 |  |  | Default |
| 53 | 4033 |  |  | Default |
| 54 | 4034 |  |  | Default |

### LRD — Lauret Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 24

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | MAGENTA |  | Magenta | Default |
| 2 | MINT GREEN |  | Mint Green | Default |
| 3 | RED BROWN |  | Red Brown | Default |
| 4 | BLACK |  | Black | Default |
| 5 | ALPINE BLUE |  | Alpine Blue | Default |
| 6 | WOODEN |  | Wooden | Default |

### DID — Diamond Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 24

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | MAGENTA |  | Magenta | Default |
| 2 | ORANGE |  | Orange | Default |
| 3 | RED |  | Red | Default |
| 4 | BLACK |  | Black | Default |
| 5 | ALPINE BLUE |  | Alpine Blue | Default |

### SH — Set Hydrographic

- Brand: Swisware+
- Catalogue pages: 24

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | B |  |  | Default |
| 2 | C |  |  | Default |
| 3 | G |  |  | Default |
| 4 | H |  |  | Default |
| 5 | I |  |  | Default |
| 6 | L |  |  | Default |

### SLD — Silver Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 25

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | BLACK |  | Black | Default |
| 2 | MAGENTA |  | Magenta | Default |
| 3 | RED BROWN |  | Red Brown | Default |
| 4 | MINT GREEN |  | Mint Green | Default |
| 5 | PUNCH BLACK |  | Punch Black | Default |
| 6 | WOODEN |  | Wooden | Default |

### D1814 — 18"x14" Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 25

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | RED BROWN | 18x14 | Red Brown | Default |
| 2 | BLACK | 18x14 | Black | Default |

### MCD — Micra Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 25

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | MAGENTA |  | Magenta | Default |
| 2 | ALPINE BLUE |  | Alpine Blue | Default |
| 3 | MINT GREEN |  | Mint Green | Default |
| 4 | BLACK |  | Black | Default |

### RS — Rustic Set

- Brand: Swisware+
- Catalogue pages: 25

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | SOFIYA SET COFFEE BROWN |  | Rustic Coffee Brown | Default |
| 2 | 18x14 SET BLACK |  | Rustic Royal Black | Default |
| 3 | 18x14 SET COFFEE BROWN |  | Rustic Coffee Brown | Default |
| 4 | SERENA SET ALPINE BLUE |  | Rustic Alpine Blue | Default |
| 5 | SERENA SET COFFEE BROWN |  | Rustic Coffee Brown | Default |
| 6 | SERENA SET BLACK |  | Rustic Royal Black | Default |
| 7 | BIG STERLING SET MAGENTA |  | Rustic Magenta | Default |
| 8 | BIG STERLING SET ALPINE BLUE |  | Rustic Alpine Blue | Default |
| 9 | BIG STERLING SET RED BROWN |  | Rustic Red Brown | Default |

### UR — Urinal

- Brand: Swisware+
- Catalogue pages: 26

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | HEXA URINAL |  | White | Default |
| 2 | HALF STALL URINAL |  | White | Default |
| 3 | GENTS WALL URINAL |  | White | Default |
| 4 | NANO URINAL |  | White | Default |
| 5 | NEW CORNER URINAL |  | White | Default |
| 6 | LADIES URINAL |  | White | Default |
| 7 | URINAL PARTITION |  | White | Default |
| 8 | URINAL CHANNEL |  |  | Default |
| 9 | BIG P-TRAP |  |  | Default |
| 10 | S-TRAP |  |  | Default |
| 11 | P-TRAP |  |  | Default |

### OP — Orissa Pan

- Brand: Swisware+
- Catalogue pages: 26

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | 20" O.P |  | All | Default |
| 2 | 20" O.P CROSS |  | All | Default |
| 3 | M.D PAN |  | All | Default |
| 4 | EASTERN PAN |  | All | Default |
| 5 | ACUPRESSURE PAN |  | All | Default |
| 6 | CITY PAN |  | All | Default |
| 7 | 21" (Stand) O.P |  | All | Default |
| 8 | 23" O.P |  | All | Default |
| 9 | 23" (Stand) O.P |  | All | Default |

### ACC — Accessories

- Brand: Swisware+
- Catalogue pages: 27

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | EWC SEAT COVER |  |  | Default |
| 2 | 710 SOFT CLOSE SEAT COVER |  |  | Default |
| 3 | 735 SOFT CLOSE SEAT COVER |  |  | Default |
| 4 | 740 SOFT CLOSE SEAT COVER |  |  | Default |
| 5 | 743 SOFT CLOSE SEAT COVER |  |  | Default |
| 6 | 784 SOFT CLOSE SEAT COVER |  |  | Default |
| 7 | GASKET |  |  | Default |
| 8 | SINGLE FLUSH TANK CISTERN |  |  | Default |
| 9 | DUAL FLUSH TANK CISTERN |  |  | Default |
| 10 | 8" FITTING |  |  | Default |
| 11 | 10" FITTING |  |  | Default |
| 12 | WASTE PIPE |  |  | Default |
| 13 | WASTE COUPLING |  |  | Default |
| 14 | HEALTH FAUCET |  |  | Default |
| 15 | SINK OVERFLOW HOLE COVER |  |  | Default |

### MER — Merchandise

- Brand: Swisware+
- Catalogue pages: 27

| # | Sub product | Size | Colours | Print side |
|---|---|---|---|---|
| 1 | CUP |  |  | Default |
| 2 | CAP |  |  | Default |
| 3 | PEN |  |  | Default |
| 4 | WATCH |  |  | Default |
| 5 | BAG |  |  | Default |
| 6 | NOTE PAD |  |  | Default |
| 7 | CATALOGUE |  |  | Default |
