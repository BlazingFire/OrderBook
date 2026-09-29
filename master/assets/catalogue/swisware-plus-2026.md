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
  or alphanumeric (`102 (9")`, `DAMRU`, `MAGENTA`). Unique inside its product.
- **Colour rule**
  - `fixed` — made in one colour only, named in the Colour column. No colour choice at entry.
  - `dedicated` — the design is its own colour (numbered and designer pieces, accessories). No colour
    choice and no colour is printed.
  - `multicolour` — any colour of the colour range; lead entry picks one or more colours with a
    quantity each.
- On documents an alphanumeric sub product prints in the **Model** column (left) and a numeric one in
  the **Code** column (right).

## Transcription decisions

- Page 4 and pages 6–7 are both headed "ONE PIECE TOILET"; they are one product (`OPT`) with the white
  models and the numbered designer models as its sub products.
- The "* ALSO AVAILABLE IN IVORY" footers carry no asterisk on any caption; per the owner, page 4
  toilets are white only. No product was given an ivory option from the footer.
- Sofiya Vitrosa Double Colour prints BLACK and MAGENTA twice: once as the floral basin, once as the
  solid-colour pedestal. The solid ones are `BLACK PLAIN` and `MAGENTA PLAIN`.
- `13x9 SQUQRE` is printed with a typo; recorded as `13x9 SQUARE`.
- `14x14 NEW CORNER` sits in the table-top grid on page 14 but is a wall-hung corner basin; it is
  listed under Wash Basin.
- Under Counter and Lab Sink models are named by their size; the stray spaces in the printed lab-sink
  captions (`24 x18x10`) and in `SILVER SET (18x14 )` are dropped.
- The ten coloured pans under Orissa Pan (Marble, Double Colour, Rustic) illustrate the colour offer;
  they are not models. Orissa Pan and Water Closet ("all items available in all colours") are
  `multicolour`.
- Urinal channel and the three traps are photographed in cream, so they carry no colour (`dedicated`)
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

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 102 (9") | L-27, B-15, H-26 | fixed | White |
| 2 | 111 (9") | L-27, B-14, H-25 | fixed | White |
| 3 | 103 (9") | L-27, B-14, H-27 | fixed | White |
| 4 | 105 (9") | L-26, B-14, H-27 | fixed | White |
| 5 | 107 (9") | L-26, B-14, H-30 | fixed | White |
| 6 | 108 (9") | L-25, B-14, H-27 | fixed | White |
| 7 | 109 (9") | L-26, B-14, H-29 | fixed | White |
| 8 | 110 (9") | L-25, B-14, H-27 | fixed | White |
| 9 | 112 (9") | L-26, B-14, H-28 | fixed | White |
| 10 | 113 (9") | L-25, B-14, H-28 | fixed | White |
| 11 | 115 (9") | L-26, B-14, H-29 | fixed | White |
| 12 | 116 (9") | L-26, B-14, H-29 | fixed | White |
| 13 | 118 (9") | L-26, B-14, H-30 | fixed | White |
| 14 | 204 (4") | L-27, B-14, H-27 | fixed | White |
| 15 | SYPHONIC (9") | L-26, B-14, H-30 | fixed | White |
| 16 | 1111 |  | dedicated |  |
| 17 | 1113 |  | dedicated |  |
| 18 | 1115 |  | dedicated |  |
| 19 | 1123 |  | dedicated |  |
| 20 | 1127 |  | dedicated |  |
| 21 | 1133 |  | dedicated |  |
| 22 | 1141 |  | dedicated |  |
| 23 | 1143 |  | dedicated |  |
| 24 | 1144 |  | dedicated |  |
| 25 | 1151 |  | dedicated |  |
| 26 | 1152 |  | dedicated |  |
| 27 | 1153 |  | dedicated |  |
| 28 | 1155 |  | dedicated |  |
| 29 | 1156 |  | dedicated |  |
| 30 | 1171 |  | dedicated |  |
| 31 | 1181 |  | dedicated |  |
| 32 | 1183 |  | dedicated |  |
| 33 | 1184 |  | dedicated |  |
| 34 | 1185 |  | dedicated |  |
| 35 | 1190 |  | dedicated |  |
| 36 | 1191 |  | dedicated |  |
| 37 | 1192 |  | dedicated |  |
| 38 | 1193 |  | dedicated |  |
| 39 | 1194 |  | dedicated |  |
| 40 | 1195 |  | dedicated |  |
| 41 | 1196 |  | dedicated |  |
| 42 | 1197 |  | dedicated |  |
| 43 | 1198 |  | dedicated |  |
| 44 | 1199 |  | dedicated |  |
| 45 | 1158 |  | dedicated |  |
| 46 | 1159 |  | dedicated |  |
| 47 | 1160 |  | dedicated |  |
| 48 | 1161 |  | dedicated |  |
| 49 | 1162 |  | dedicated |  |
| 50 | 1163 |  | dedicated |  |
| 51 | 1164 |  | dedicated |  |
| 52 | 1165 |  | dedicated |  |
| 53 | 1166 |  | dedicated |  |
| 54 | 1167 |  | dedicated |  |
| 55 | 1168 |  | dedicated |  |
| 56 | 1169 |  | dedicated |  |

### OPB — One Piece Basin

- Brand: Swisware+
- Catalogue pages: 5

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | DAMRU | L-16, H-31 | fixed | White |
| 2 | NOVA | L-15, H-31 | fixed | White |
| 3 | DAMRU PLUS | L-16, H-32 | fixed | White |
| 4 | RUBY | L-16, H-33 | fixed | White |
| 5 | ROYAL | L-16, H-34 | fixed | White |
| 6 | RAINBOW | L-18, B-14, H-31 | fixed | White |
| 7 | DIAMOND | L-18, H-32 | fixed | White |
| 8 | VOLVO | L-18, H-31 | fixed | White |
| 9 | CROWNIE | L-16, H-33 | fixed | White |
| 10 | SAPPHIRE | L-16, B-14, H-32 | fixed | White |
| 11 | EAGLE | L-17, B-13, H-32 | fixed | White |
| 12 | LAVA | L-19, B-15, H-32 | fixed | White |
| 13 | SCORPIO | L-18, H-32 | fixed | White |
| 14 | WUDU BASIN - WHITE |  | fixed | White |
| 15 | WUDU BASIN - BLACK |  | fixed | Black |

### DMV — One Piece Basin Damru Vitrosa

- Brand: Swisware+
- Catalogue pages: 8, 9

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 41 |  | dedicated |  |
| 2 | 42 |  | dedicated |  |
| 3 | 46 |  | dedicated |  |
| 4 | 47 |  | dedicated |  |
| 5 | 48 |  | dedicated |  |
| 6 | 49 |  | dedicated |  |
| 7 | 50 |  | dedicated |  |
| 8 | 51 |  | dedicated |  |
| 9 | 53 |  | dedicated |  |
| 10 | 55 |  | dedicated |  |
| 11 | 57 |  | dedicated |  |
| 12 | 58 |  | dedicated |  |
| 13 | 59 |  | dedicated |  |
| 14 | 60 |  | dedicated |  |
| 15 | 61 |  | dedicated |  |
| 16 | 64 |  | dedicated |  |
| 17 | 65 |  | dedicated |  |
| 18 | 66 |  | dedicated |  |
| 19 | 67 |  | dedicated |  |
| 20 | 69 |  | dedicated |  |
| 21 | 70 |  | dedicated |  |
| 22 | 72 |  | dedicated |  |
| 23 | 76 |  | dedicated |  |
| 24 | 81 |  | dedicated |  |
| 25 | 82 |  | dedicated |  |
| 26 | 83 |  | dedicated |  |
| 27 | 84 |  | dedicated |  |
| 28 | 85 |  | dedicated |  |
| 29 | 87 |  | dedicated |  |
| 30 | 88 |  | dedicated |  |
| 31 | 89 |  | dedicated |  |
| 32 | 91 |  | dedicated |  |
| 33 | 92 |  | dedicated |  |
| 34 | 95 |  | dedicated |  |
| 35 | 97 |  | dedicated |  |
| 36 | 100 |  | dedicated |  |

### DPV — One Piece Basin Damru Plus Vitrosa

- Brand: Swisware+
- Catalogue pages: 9

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 29 |  | dedicated |  |
| 2 | 30 |  | dedicated |  |
| 3 | 31 |  | dedicated |  |
| 4 | 32 |  | dedicated |  |
| 5 | 33 |  | dedicated |  |
| 6 | 34 |  | dedicated |  |
| 7 | 35 |  | dedicated |  |
| 8 | 36 |  | dedicated |  |
| 9 | 37 |  | dedicated |  |
| 10 | 38 |  | dedicated |  |
| 11 | 39 |  | dedicated |  |
| 12 | 40 |  | dedicated |  |

### NVV — One Piece Basin Nova Vitrosa

- Brand: Swisware+
- Catalogue pages: 10

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 150 |  | dedicated |  |
| 2 | 151 |  | dedicated |  |
| 3 | 152 |  | dedicated |  |
| 4 | 153 |  | dedicated |  |
| 5 | 157 |  | dedicated |  |
| 6 | 158 |  | dedicated |  |
| 7 | 161 |  | dedicated |  |

### RYV — One Piece Basin Royal Vitrosa

- Brand: Swisware+
- Catalogue pages: 10

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 350 |  | dedicated |  |
| 2 | 351 |  | dedicated |  |
| 3 | 352 |  | dedicated |  |
| 4 | 353 |  | dedicated |  |
| 5 | 354 |  | dedicated |  |

### RBV — One Piece Basin Rainbow Vitrosa

- Brand: Swisware+
- Catalogue pages: 10

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 570 |  | dedicated |  |
| 2 | 571 |  | dedicated |  |
| 3 | 572 |  | dedicated |  |
| 4 | 575 |  | dedicated |  |
| 5 | 577 |  | dedicated |  |
| 6 | 580 |  | dedicated |  |
| 7 | 581 |  | dedicated |  |
| 8 | 582 |  | dedicated |  |
| 9 | 583 |  | dedicated |  |
| 10 | 585 |  | dedicated |  |

### DIV — One Piece Basin Diamond Vitrosa

- Brand: Swisware+
- Catalogue pages: 11

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 271 |  | dedicated |  |
| 2 | 272 |  | dedicated |  |
| 3 | 275 |  | dedicated |  |
| 4 | 276 |  | dedicated |  |
| 5 | 277 |  | dedicated |  |
| 6 | 278 |  | dedicated |  |
| 7 | 282 |  | dedicated |  |
| 8 | 283 |  | dedicated |  |
| 9 | 285 |  | dedicated |  |

### CRV — One Piece Basin Crownie Vitrosa

- Brand: Swisware+
- Catalogue pages: 11

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 171 |  | dedicated |  |
| 2 | 172 |  | dedicated |  |
| 3 | 173 |  | dedicated |  |
| 4 | 174 |  | dedicated |  |
| 5 | 175 |  | dedicated |  |
| 6 | 179 |  | dedicated |  |
| 7 | 180 |  | dedicated |  |

### EGV — One Piece Basin Eagle Vitrosa

- Brand: Swisware+
- Catalogue pages: 11

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 381 |  | dedicated |  |
| 2 | 382 |  | dedicated |  |
| 3 | 384 |  | dedicated |  |
| 4 | 385 |  | dedicated |  |
| 5 | 386 |  | dedicated |  |
| 6 | 387 |  | dedicated |  |

### SPV — One Piece Basin Sapphire Vitrosa

- Brand: Swisware+
- Catalogue pages: 12

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 367 |  | dedicated |  |
| 2 | 369 |  | dedicated |  |
| 3 | 371 |  | dedicated |  |
| 4 | 372 |  | dedicated |  |
| 5 | 373 |  | dedicated |  |
| 6 | 376 |  | dedicated |  |
| 7 | 378 |  | dedicated |  |
| 8 | 379 |  | dedicated |  |

### VLV — One Piece Basin Volvo Vitrosa

- Brand: Swisware+
- Catalogue pages: 12

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 330 |  | dedicated |  |
| 2 | 331 |  | dedicated |  |
| 3 | 332 |  | dedicated |  |
| 4 | 334 |  | dedicated |  |
| 5 | 335 |  | dedicated |  |

### LVV — One Piece Basin Lava Vitrosa

- Brand: Swisware+
- Catalogue pages: 12

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 192 |  | dedicated |  |
| 2 | 193 |  | dedicated |  |
| 3 | 194 |  | dedicated |  |
| 4 | 195 |  | dedicated |  |

### SCV — One Piece Basin Scorpio Vitrosa

- Brand: Swisware+
- Catalogue pages: 12

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 551 |  | dedicated |  |
| 2 | 555 |  | dedicated |  |
| 3 | 556 |  | dedicated |  |
| 4 | 557 |  | dedicated |  |

### WC — Water Closet

- Brand: Swisware+
- Catalogue pages: 13

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | E.W.C - ECO CONCEALED |  | multicolour |  |
| 2 | E.W.C - ECO CONCEALED SLIM |  | multicolour |  |
| 3 | E.W.C - MODERN |  | multicolour |  |
| 4 | E.W.C - CONCEALED |  | multicolour |  |
| 5 | E.W.C - S TRAP |  | multicolour |  |
| 6 | E.W.C - P TRAP |  | multicolour |  |
| 7 | ANGLO INDIAN - S TRAP |  | multicolour |  |
| 8 | ANGLO INDIAN - P TRAP |  | multicolour |  |

### ECD — Eco Concealed Designer

- Brand: Swisware+
- Catalogue pages: 13

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | E-01 |  | dedicated |  |
| 2 | E-02 |  | dedicated |  |
| 3 | E-03 |  | dedicated |  |
| 4 | E-06 |  | dedicated |  |
| 5 | E-07 |  | dedicated |  |
| 6 | E-08 |  | dedicated |  |
| 7 | E-09 |  | dedicated |  |

### UC — Under Counter

- Brand: Swisware+
- Catalogue pages: 13

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 18x18 | 18x18 | fixed | White |
| 2 | 22x16 | 22x16 | fixed | White |

### LS — Lab Sink

- Brand: Swisware+
- Catalogue pages: 13

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 24x18x10 | 24x18x10 | fixed | White |
| 2 | 20x16x7 | 20x16x7 | fixed | White |
| 3 | 18x12x6 | 18x12x6 | fixed | White |

### WB — Wash Basin

- Brand: Swisware+
- Catalogue pages: 14

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 12x9 | 12x9 | fixed | White |
| 2 | 13x9 SQUARE | 13x9 | fixed | White |
| 3 | 14x11 ROUND | 14x11 | fixed | White |
| 4 | 16x16 CORNER | 16x16 | fixed | White |
| 5 | 17x11 | 17x11 | fixed | White |
| 6 | 18x12 | 18x12 | fixed | White |
| 7 | 18x12 SQUARE | 18x12 | fixed | White |
| 8 | 18x13 | 18x13 | fixed | White |
| 9 | 16x12 | 16x12 | fixed | White |
| 10 | 18x14 | 18x14 | fixed | White |
| 11 | 18x14 GOLDEN | 18x14 | fixed | White |
| 12 | 18x14 POLO | 18x14 | fixed | White |
| 13 | 18x14 SILVER | 18x14 | fixed | White |
| 14 | 18x16 MICRA | 18x16 | fixed | White |
| 15 | 20x16 | 20x16 | fixed | White |
| 16 | 22x16 | 22x16 | fixed | White |
| 17 | 14x14 NEW CORNER | 14x14 | fixed | White |

### TTW — Table Top Wash Basin

- Brand: Swisware+
- Catalogue pages: 14

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 7501 | 23x14 | dedicated |  |
| 2 | 7505 | 17x11 | dedicated |  |
| 3 | 7507 | 17x13 | dedicated |  |
| 4 | 7601 | 16x12 | dedicated |  |
| 5 | 7702 | 20x13 | dedicated |  |
| 6 | 7704 | 20x16 | dedicated |  |
| 7 | 7706 | 17x17 | dedicated |  |
| 8 | 7708 | 19x15 | dedicated |  |
| 9 | 7801 | 22x17 | dedicated |  |
| 10 | 7803 | 18x14 | dedicated |  |
| 11 | 7805 | 18x14 | dedicated |  |
| 12 | 7807 | 16x16 | dedicated |  |
| 13 | 7901 | 28x14 | dedicated |  |
| 14 | 7902 | 23x14 | dedicated |  |
| 15 | 7903 | 25x15 | dedicated |  |

### TTV — Table Top Vitrosa Basin

- Brand: Swisware+
- Catalogue pages: 15, 16, 17

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 7511 |  | dedicated |  |
| 2 | 7512 |  | dedicated |  |
| 3 | 7513 |  | dedicated |  |
| 4 | 7662 |  | dedicated |  |
| 5 | 7663 |  | dedicated |  |
| 6 | 7664 |  | dedicated |  |
| 7 | 7665 |  | dedicated |  |
| 8 | 7667 |  | dedicated |  |
| 9 | 7668 |  | dedicated |  |
| 10 | 7641 |  | dedicated |  |
| 11 | 7643 |  | dedicated |  |
| 12 | 7644 |  | dedicated |  |
| 13 | 7646 |  | dedicated |  |
| 14 | 7647 |  | dedicated |  |
| 15 | 7721 |  | dedicated |  |
| 16 | 7722 |  | dedicated |  |
| 17 | 7726 |  | dedicated |  |
| 18 | 7741 |  | dedicated |  |
| 19 | 7742 |  | dedicated |  |
| 20 | 7743 |  | dedicated |  |
| 21 | 7744 |  | dedicated |  |
| 22 | 7745 |  | dedicated |  |
| 23 | 7781 |  | dedicated |  |
| 24 | 7782 |  | dedicated |  |
| 25 | 7783 |  | dedicated |  |
| 26 | 7784 |  | dedicated |  |
| 27 | 7785 |  | dedicated |  |
| 28 | 7786 |  | dedicated |  |
| 29 | 7788 |  | dedicated |  |
| 30 | 7851 |  | dedicated |  |
| 31 | 7852 |  | dedicated |  |
| 32 | 7853 |  | dedicated |  |
| 33 | 7854 |  | dedicated |  |
| 34 | 7855 |  | dedicated |  |
| 35 | 7857 |  | dedicated |  |
| 36 | 7858 |  | dedicated |  |
| 37 | 7859 |  | dedicated |  |
| 38 | 7514 |  | dedicated |  |
| 39 | 7516 |  | dedicated |  |
| 40 | 7517 |  | dedicated |  |
| 41 | 7525 |  | dedicated |  |
| 42 | 7760 |  | dedicated |  |
| 43 | 7761 |  | dedicated |  |
| 44 | 7762 |  | dedicated |  |
| 45 | 7767 |  | dedicated |  |
| 46 | 7768 |  | dedicated |  |
| 47 | 7769 |  | dedicated |  |
| 48 | 7840 |  | dedicated |  |
| 49 | 7842 |  | dedicated |  |
| 50 | 7843 |  | dedicated |  |
| 51 | 7844 |  | dedicated |  |
| 52 | 7845 |  | dedicated |  |
| 53 | 7847 |  | dedicated |  |
| 54 | 7848 |  | dedicated |  |
| 55 | 7914 |  | dedicated |  |
| 56 | 7915 |  | dedicated |  |
| 57 | 7916 |  | dedicated |  |
| 58 | 7917 |  | dedicated |  |
| 59 | 7918 |  | dedicated |  |
| 60 | 7920 |  | dedicated |  |
| 61 | 7953 |  | dedicated |  |
| 62 | 7941 |  | dedicated |  |
| 63 | 7943 |  | dedicated |  |
| 64 | 7945 |  | dedicated |  |
| 65 | 7946 |  | dedicated |  |
| 66 | 7931 |  | dedicated |  |
| 67 | 7933 |  | dedicated |  |
| 68 | 7934 |  | dedicated |  |
| 69 | 7935 |  | dedicated |  |

### TTH — Table Top Hydrographic

- Brand: Swisware+
- Catalogue pages: 17

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | A |  | dedicated |  |
| 2 | B |  | dedicated |  |
| 3 | C |  | dedicated |  |
| 4 | D |  | dedicated |  |
| 5 | E |  | dedicated |  |
| 6 | F |  | dedicated |  |
| 7 | G |  | dedicated |  |
| 8 | H |  | dedicated |  |
| 9 | I |  | dedicated |  |
| 10 | J |  | dedicated |  |
| 11 | K |  | dedicated |  |

### V1812 — 18x12 Vitrosa

- Brand: Swisware+
- Catalogue pages: 17

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | BLACK | 18x12 | fixed | Black |
| 2 | MINT GREEN | 18x12 | fixed | Mint Green |
| 3 | MAGENTA | 18x12 | fixed | Magenta |

### R1812 — 18x12 Rustic

- Brand: Swisware+
- Catalogue pages: 17

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | BLACK | 18x12 | fixed | Rustic Royal Black |
| 2 | COFFEE BROWN | 18x12 | fixed | Rustic Coffee Brown |
| 3 | ALPINE BLUE | 18x12 | fixed | Rustic Alpine Blue |

### PS — Plain Set

- Brand: Swisware+
- Catalogue pages: 18

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | GOLDEN SET (18X14) | 18x14 | fixed | White |
| 2 | POLO SET (18X14) | 18x14 | fixed | White |
| 3 | SILVER SET (18x14) | 18x14 | fixed | White |
| 4 | 18x14 SET | 18x14 | fixed | White |
| 5 | MICRA SET (18X16) | 18x16 | fixed | White |
| 6 | 20x16 SET | 20x16 | fixed | White |
| 7 | REPOSE SET (22X16) | 22x16 | fixed | White |
| 8 | FABIA SET (20X17) | 20x17 | fixed | White |
| 9 | SOFIYA SET (22X17) | 22x17 | fixed | White |
| 10 | STERLING SET (22X17) | 22x17 | fixed | White |
| 11 | AMAZON SET (22x17) | 22x17 | fixed | White |
| 12 | SUPREME SET (23X17) | 23x17 | fixed | White |
| 13 | SERENA SET (23X17) | 23x17 | fixed | White |
| 14 | CRETA SET (23x17) | 23x17 | fixed | White |
| 15 | CRYSTA SET (24X18) | 24x18 | fixed | White |
| 16 | LAURET SET (24X18) | 24x18 | fixed | White |
| 17 | LEXO SET (24X18) | 24x18 | fixed | White |
| 18 | EURO SET (24X19) | 24x19 | fixed | White |
| 19 | DIAMOND SET (23X20) | 23x20 | fixed | White |
| 20 | INNOVA SET (23X18) | 23x18 | fixed | White |
| 21 | BIG STERLING SET (25X21) | 25x21 | fixed | White |
| 22 | DOLPHIN SET (18X20) | 18x20 | fixed | White |

### BSD — Big Sterling Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 19

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 3001 |  | dedicated |  |
| 2 | 3002 |  | dedicated |  |
| 3 | 5001 |  | dedicated |  |
| 4 | 5002 |  | dedicated |  |
| 5 | 5003 |  | dedicated |  |
| 6 | 5004 |  | dedicated |  |
| 7 | 5005 |  | dedicated |  |
| 8 | 5011 |  | dedicated |  |
| 9 | 5012 |  | dedicated |  |
| 10 | 5014 |  | dedicated |  |
| 11 | 6001 |  | dedicated |  |
| 12 | 6002 |  | dedicated |  |
| 13 | 6003 |  | dedicated |  |
| 14 | 6004 |  | dedicated |  |
| 15 | 6005 |  | dedicated |  |
| 16 | 6006 |  | dedicated |  |
| 17 | 6007 |  | dedicated |  |
| 18 | 6008 |  | dedicated |  |
| 19 | 6010 |  | dedicated |  |
| 20 | 6011 |  | dedicated |  |
| 21 | 6012 |  | dedicated |  |
| 22 | 6015 |  | dedicated |  |
| 23 | 6016 |  | dedicated |  |
| 24 | WOODEN |  | fixed | Wooden |

### EUD — Euro Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 20

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 6501 |  | dedicated |  |
| 2 | 6502 |  | dedicated |  |
| 3 | 6503 |  | dedicated |  |
| 4 | 6504 |  | dedicated |  |
| 5 | 6505 |  | dedicated |  |
| 6 | 6506 |  | dedicated |  |
| 7 | 6507 |  | dedicated |  |
| 8 | 6508 |  | dedicated |  |
| 9 | 6509 |  | dedicated |  |
| 10 | 6510 |  | dedicated |  |
| 11 | 6511 |  | dedicated |  |
| 12 | 6512 |  | dedicated |  |
| 13 | 6513 |  | dedicated |  |
| 14 | 6514 |  | dedicated |  |

### SFD — Sofiya Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 20

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | MAGENTA |  | fixed | Magenta |
| 2 | MINT GREEN |  | fixed | Mint Green |
| 3 | ALPINE BLUE |  | fixed | Alpine Blue |
| 4 | BLACK |  | fixed | Black |
| 5 | RED |  | fixed | Red |
| 6 | RED BROWN |  | fixed | Red Brown |
| 7 | ORANGE |  | fixed | Orange |
| 8 | BLACK PLAIN |  | fixed | Black |
| 9 | MAGENTA PLAIN |  | fixed | Magenta |

### AMD — Amazon Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 21

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 5501 |  | dedicated |  |
| 2 | 5502 |  | dedicated |  |
| 3 | 5503 |  | dedicated |  |
| 4 | 5504 |  | dedicated |  |
| 5 | 5505 |  | dedicated |  |
| 6 | 5506 |  | dedicated |  |
| 7 | 5507 |  | dedicated |  |
| 8 | 5508 |  | dedicated |  |
| 9 | 5509 |  | dedicated |  |
| 10 | 5511 |  | dedicated |  |
| 11 | 5512 |  | dedicated |  |
| 12 | 5513 |  | dedicated |  |
| 13 | 5514 |  | dedicated |  |
| 14 | 5515 |  | dedicated |  |
| 15 | 5516 |  | dedicated |  |
| 16 | 5517 |  | dedicated |  |
| 17 | 5518 |  | dedicated |  |
| 18 | 5521 |  | dedicated |  |
| 19 | 5522 |  | dedicated |  |
| 20 | 5523 |  | dedicated |  |
| 21 | 5524 |  | dedicated |  |
| 22 | 5525 |  | dedicated |  |
| 23 | 5526 |  | dedicated |  |
| 24 | 5527 |  | dedicated |  |

### SRD — Serena Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 22, 23, 24

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 605 |  | dedicated |  |
| 2 | 1001 |  | dedicated |  |
| 3 | 1016 |  | dedicated |  |
| 4 | 1019 |  | dedicated |  |
| 5 | 1036 |  | dedicated |  |
| 6 | 1037 |  | dedicated |  |
| 7 | 1050 |  | dedicated |  |
| 8 | 1051 |  | dedicated |  |
| 9 | 1052 |  | dedicated |  |
| 10 | 1061 |  | dedicated |  |
| 11 | 1062 |  | dedicated |  |
| 12 | 1063 |  | dedicated |  |
| 13 | 1064 |  | dedicated |  |
| 14 | 1065 |  | dedicated |  |
| 15 | 1066 |  | dedicated |  |
| 16 | 1067 |  | dedicated |  |
| 17 | 1068 |  | dedicated |  |
| 18 | 2001 |  | dedicated |  |
| 19 | 2002 |  | dedicated |  |
| 20 | 2003 |  | dedicated |  |
| 21 | 2006 |  | dedicated |  |
| 22 | 2501 |  | dedicated |  |
| 23 | 2502 |  | dedicated |  |
| 24 | 2503 |  | dedicated |  |
| 25 | 2504 |  | dedicated |  |
| 26 | 2505 |  | dedicated |  |
| 27 | 2506 |  | dedicated |  |
| 28 | 2507 |  | dedicated |  |
| 29 | 2508 |  | dedicated |  |
| 30 | 2509 |  | dedicated |  |
| 31 | 2510 |  | dedicated |  |
| 32 | 2511 |  | dedicated |  |
| 33 | 2512 |  | dedicated |  |
| 34 | 2513 |  | dedicated |  |
| 35 | 2514 |  | dedicated |  |
| 36 | 2515 |  | dedicated |  |
| 37 | 2516 |  | dedicated |  |
| 38 | 2517 |  | dedicated |  |
| 39 | 4001 |  | dedicated |  |
| 40 | 4002 |  | dedicated |  |
| 41 | 4005 |  | dedicated |  |
| 42 | 4011 |  | dedicated |  |
| 43 | 4012 |  | dedicated |  |
| 44 | 4016 |  | dedicated |  |
| 45 | 4017 |  | dedicated |  |
| 46 | 4018 |  | dedicated |  |
| 47 | 4019 |  | dedicated |  |
| 48 | 4020 |  | dedicated |  |
| 49 | 4021 |  | dedicated |  |
| 50 | 4022 |  | dedicated |  |
| 51 | 4031 |  | dedicated |  |
| 52 | 4032 |  | dedicated |  |
| 53 | 4033 |  | dedicated |  |
| 54 | 4034 |  | dedicated |  |

### LRD — Lauret Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 24

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | MAGENTA |  | fixed | Magenta |
| 2 | MINT GREEN |  | fixed | Mint Green |
| 3 | RED BROWN |  | fixed | Red Brown |
| 4 | BLACK |  | fixed | Black |
| 5 | ALPINE BLUE |  | fixed | Alpine Blue |
| 6 | WOODEN |  | fixed | Wooden |

### DID — Diamond Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 24

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | MAGENTA |  | fixed | Magenta |
| 2 | ORANGE |  | fixed | Orange |
| 3 | RED |  | fixed | Red |
| 4 | BLACK |  | fixed | Black |
| 5 | ALPINE BLUE |  | fixed | Alpine Blue |

### SH — Set Hydrographic

- Brand: Swisware+
- Catalogue pages: 24

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | B |  | dedicated |  |
| 2 | C |  | dedicated |  |
| 3 | G |  | dedicated |  |
| 4 | H |  | dedicated |  |
| 5 | I |  | dedicated |  |
| 6 | L |  | dedicated |  |

### SLD — Silver Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 25

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | BLACK |  | fixed | Black |
| 2 | MAGENTA |  | fixed | Magenta |
| 3 | RED BROWN |  | fixed | Red Brown |
| 4 | MINT GREEN |  | fixed | Mint Green |
| 5 | PUNCH BLACK |  | fixed | Punch Black |
| 6 | WOODEN |  | fixed | Wooden |

### D1814 — 18"x14" Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 25

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | RED BROWN | 18x14 | fixed | Red Brown |
| 2 | BLACK | 18x14 | fixed | Black |

### MCD — Micra Vitrosa Double Colour

- Brand: Swisware+
- Catalogue pages: 25

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | MAGENTA |  | fixed | Magenta |
| 2 | ALPINE BLUE |  | fixed | Alpine Blue |
| 3 | MINT GREEN |  | fixed | Mint Green |
| 4 | BLACK |  | fixed | Black |

### RS — Rustic Set

- Brand: Swisware+
- Catalogue pages: 25

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | SOFIYA SET COFFEE BROWN |  | fixed | Rustic Coffee Brown |
| 2 | 18x14 SET BLACK |  | fixed | Rustic Royal Black |
| 3 | 18x14 SET COFFEE BROWN |  | fixed | Rustic Coffee Brown |
| 4 | SERENA SET ALPINE BLUE |  | fixed | Rustic Alpine Blue |
| 5 | SERENA SET COFFEE BROWN |  | fixed | Rustic Coffee Brown |
| 6 | SERENA SET BLACK |  | fixed | Rustic Royal Black |
| 7 | BIG STERLING SET MAGENTA |  | fixed | Rustic Magenta |
| 8 | BIG STERLING SET ALPINE BLUE |  | fixed | Rustic Alpine Blue |
| 9 | BIG STERLING SET RED BROWN |  | fixed | Rustic Red Brown |

### UR — Urinal

- Brand: Swisware+
- Catalogue pages: 26

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | HEXA URINAL |  | fixed | White |
| 2 | HALF STALL URINAL |  | fixed | White |
| 3 | GENTS WALL URINAL |  | fixed | White |
| 4 | NANO URINAL |  | fixed | White |
| 5 | NEW CORNER URINAL |  | fixed | White |
| 6 | LADIES URINAL |  | fixed | White |
| 7 | URINAL PARTITION |  | fixed | White |
| 8 | URINAL CHANNEL |  | dedicated |  |
| 9 | BIG P-TRAP |  | dedicated |  |
| 10 | S-TRAP |  | dedicated |  |
| 11 | P-TRAP |  | dedicated |  |

### OP — Orissa Pan

- Brand: Swisware+
- Catalogue pages: 26

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | 20" O.P |  | multicolour |  |
| 2 | 20" O.P CROSS |  | multicolour |  |
| 3 | M.D PAN |  | multicolour |  |
| 4 | EASTERN PAN |  | multicolour |  |
| 5 | ACUPRESSURE PAN |  | multicolour |  |
| 6 | CITY PAN |  | multicolour |  |
| 7 | 21" (Stand) O.P |  | multicolour |  |
| 8 | 23" O.P |  | multicolour |  |
| 9 | 23" (Stand) O.P |  | multicolour |  |

### ACC — Accessories

- Brand: Swisware+
- Catalogue pages: 27

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | EWC SEAT COVER |  | dedicated |  |
| 2 | 710 SOFT CLOSE SEAT COVER |  | dedicated |  |
| 3 | 735 SOFT CLOSE SEAT COVER |  | dedicated |  |
| 4 | 740 SOFT CLOSE SEAT COVER |  | dedicated |  |
| 5 | 743 SOFT CLOSE SEAT COVER |  | dedicated |  |
| 6 | 784 SOFT CLOSE SEAT COVER |  | dedicated |  |
| 7 | GASKET |  | dedicated |  |
| 8 | SINGLE FLUSH TANK CISTERN |  | dedicated |  |
| 9 | DUAL FLUSH TANK CISTERN |  | dedicated |  |
| 10 | 8" FITTING |  | dedicated |  |
| 11 | 10" FITTING |  | dedicated |  |
| 12 | WASTE PIPE |  | dedicated |  |
| 13 | WASTE COUPLING |  | dedicated |  |
| 14 | HEALTH FAUCET |  | dedicated |  |
| 15 | SINK OVERFLOW HOLE COVER |  | dedicated |  |

### MER — Merchandise

- Brand: Swisware+
- Catalogue pages: 27

| # | Sub product | Size | Colour rule | Colour |
|---|---|---|---|---|
| 1 | CUP |  | dedicated |  |
| 2 | CAP |  | dedicated |  |
| 3 | PEN |  | dedicated |  |
| 4 | WATCH |  | dedicated |  |
| 5 | BAG |  | dedicated |  |
| 6 | NOTE PAD |  | dedicated |  |
| 7 | CATALOGUE |  | dedicated |  |
