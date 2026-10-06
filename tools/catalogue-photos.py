#!/usr/bin/env python3
"""Extract the product photos from the Swisware+ 2026 catalogue PDF and name each one by the
code of the sub product it shows.

The PDF is image-only (no text layer, captions are outlined shapes), so a photo cannot be read
to a name. It is matched by layout instead: on every product page the photos are taken in
reading order (rows top to bottom, left to right) and handed, in the order
`master/assets/catalogue/swisware-plus-2026.md` lists them, to the sub products of the products
that sit on that page. The code is the one the Master gives the sub product
(`productRepo.subProductCode(productCode, position)`, e.g. OPT-0011).

    python tools/catalogue-photos.py [--pdf PATH] [--out DIR]

The PDF is opened read-only and never changed. Output (default .tmp/catalogue-photos/):
  <CODE>.jpg      one photo per sub product (jpg; transparent photos are put on white)
  mapping.csv     page, image, code, product, name, how it matched, confidence
  unmatched/      photos with no sub product to take them
  captions/       the caption strip printed under each photo, so a person can check the match by eye
  contact.html    thumbnail grid (photo, printed caption, catalogue name) for a person to check by eye
Needs PyMuPDF (`pymupdf`), Pillow, numpy and scipy. Offline.
"""

import argparse
import csv
import html
import io
import re
import sys
from collections import OrderedDict
from pathlib import Path

import numpy as np
import pymupdf
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PDF = Path(r'C:\Users\Z\Desktop\SWISWARE 2026.pdf')  # the full-quality catalogue
CATALOGUE = ROOT / 'master' / 'assets' / 'catalogue' / 'swisware-plus-2026.md'

DPI = 300
WHITE_BELOW = 240  # a pixel with any channel under this is ink; the page is 255
JOIN_PX = 3  # grow ink this much so a tile and its thin edge are one block
MIN_FILL = 0.42  # a photo tile is mostly solid (a white product leaves gaps); lettering and logos are not
CAPTION_ROW_FILL = 0.6  # rows at the foot of a block thinner than this are lettering, not photo
MIN_SIDE_PT = 35  # smaller is lettering or a swatch (the small trap tiles are about 40 pt tall)
MAX_WIDTH_FRACTION = 0.9  # as wide as the page is a background
ROW_OVERLAP = 0.4  # two photos are in one row when they share this much of their height
CAPTION_PT = 22  # height of the caption strip kept under a tile for the contact sheet
# Where the catalogue's list order differs from the page's reading order (see "Transcription
# decisions" in swisware-plus-2026.md). 0-based tile numbers in reading order, in list order.
# Page 14: tile 32, "14x14 NEW CORNER", prints in the table-top grid but is Wash Basin's 17th.
REORDER = {14: [*range(16), 31, *range(16, 31)]}


def parse_catalogue(path):
    """[{code, name, pages, subs: [name]}] in the order the catalogue lists them."""
    products, current = [], None
    for line in path.read_text(encoding='utf-8').splitlines():
        heading = re.match(r'^### (\S+) — (.+)$', line)
        if heading:
            current = {'code': heading.group(1), 'name': heading.group(2).strip(), 'pages': [], 'subs': []}
            products.append(current)
        elif current is not None:
            pages = re.match(r'^- Catalogue pages: (.+)$', line)
            row = re.match(r'^\|\s*(\d+)\s*\|\s*(.*?)\s*\|', line)
            if pages:
                current['pages'] = [int(n) for n in re.findall(r'\d+', pages.group(1))]
            elif row:
                current['subs'].append(row.group(2))
    return [p for p in products if p['pages'] and p['subs']]


def sub_code(product_code, position):
    return f'{product_code}-{position:04d}'


def reading_order(rects):
    """Rows top to bottom, each row left to right. rects are (x0, y0, x1, y1, payload)."""
    rows = []
    for item in sorted(rects, key=lambda r: r[1]):
        for row in rows:
            top, bottom = row['span']
            overlap = min(bottom, item[3]) - max(top, item[1])
            if overlap > ROW_OVERLAP * min(item[3] - item[1], bottom - top):
                row['items'].append(item)
                row['span'] = (min(top, item[1]), max(bottom, item[3]))
                break
        else:
            rows.append({'span': (item[1], item[3]), 'items': [item]})
    rows.sort(key=lambda r: r['span'][0])
    return [item for row in rows for item in sorted(row['items'], key=lambda i: i[0])]


def page_photos(doc, page_number, overlay_dir=None):
    """The product photos on one page, in list order, as (photo, caption strip).

    A tile is not always one embedded picture: many are a gradient, a cut-out product and a tap
    laid over each other. So the page is drawn and the tiles are found in the drawing: solid
    blocks of non-white that are product sized (not text, not the logo, not the page frame).
    """
    page = doc[page_number - 1]
    scale = DPI / 72
    pix = page.get_pixmap(dpi=DPI, colorspace=pymupdf.csRGB, alpha=False)
    image = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    pixels = np.asarray(image)
    ink = (pixels < WHITE_BELOW).any(axis=2)
    blobs, count = ndimage.label(ndimage.binary_dilation(ink, iterations=JOIN_PX))
    found = []
    for index, box in enumerate(ndimage.find_objects(blobs), 1):
        y, x = box
        width, height = (x.stop - x.start) / scale, (y.stop - y.start) / scale
        if min(width, height) < MIN_SIDE_PT or width > MAX_WIDTH_FRACTION * page.rect.width:
            continue
        fill = ink[box].mean()
        if fill < MIN_FILL:  # lettering, a logo, a table frame
            continue
        # The caption sits right under the tile and joins it; its rows are mostly white.
        bottom = y.stop
        while bottom > y.start and ink[bottom - 1, x.start : x.stop].mean() < CAPTION_ROW_FILL:
            bottom -= 1
        caption = image.crop((x.start, bottom, x.stop, min(bottom + int(CAPTION_PT * scale), image.height)))
        found.append((x.start, y.start, x.stop, bottom, (image.crop((x.start, y.start, x.stop, bottom)), caption)))
    # A tile inside another tile is a picture within a picture (the bag's print on page 27), not a product.
    found = [
        a
        for a in found
        if not any(b is not a and b[0] <= a[0] and b[1] <= a[1] and b[2] >= a[2] and b[3] >= a[3] for b in found)
    ]
    ordered = reading_order(found)
    if overlay_dir:
        sheet = image.copy()
        draw = ImageDraw.Draw(sheet)
        for number, item in enumerate(ordered, 1):
            draw.rectangle(item[:4], outline='lime', width=4)
            draw.text((item[0] + 8, item[1] + 8), str(number), fill='red', font=ImageFont.load_default(size=40))
        sheet.resize((sheet.width // 2, sheet.height // 2)).save(Path(overlay_dir) / f'page-{page_number:02d}.png')
    tiles = [item[4] for item in ordered]
    if page_number in REORDER:
        tiles = [tiles[i] for i in REORDER[page_number]] + [t for i, t in enumerate(tiles) if i not in REORDER[page_number]]
    return tiles  # (photo, caption strip)


def assign(products, photos_by_page):
    """Hand each page's photos, in order, to the sub products of the products on that page.

    A product that continues on a later page takes all it can get up to what the products that end
    on this page still need; a product ending here takes what it still lacks. Returns
    {page: [(photo index, product, position) | (photo index, None, None)]}.
    """
    taken = {p['code']: 0 for p in products}
    result = {}
    for page in sorted(photos_by_page):
        on_page = [p for p in products if page in p['pages']]
        count = len(photos_by_page[page])
        cursor, plan = 0, []
        for position_in_page, product in enumerate(on_page):
            remaining = len(product['subs']) - taken[product['code']]
            ends_here = page == product['pages'][-1]
            later_need = sum(
                len(q['subs']) - taken[q['code']] for q in on_page[position_in_page + 1:] if page == q['pages'][-1]
            )
            want = remaining if ends_here else max(count - cursor - later_need, 0)
            give = max(min(want, remaining, count - cursor), 0)
            for _ in range(give):
                taken[product['code']] += 1
                plan.append((cursor, product, taken[product['code']]))
                cursor += 1
        plan += [(index, None, None) for index in range(cursor, count)]
        result[page] = plan
    return result, taken


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--pdf', default=str(DEFAULT_PDF))
    ap.add_argument('--out', default=str(ROOT / '.tmp' / 'catalogue-photos'))
    ap.add_argument('--overlay', help='folder for page-NN.png: each page with its numbered tiles, to check the order by eye')
    args = ap.parse_args()

    products = parse_catalogue(CATALOGUE)
    out = Path(args.out)
    (out / 'unmatched').mkdir(parents=True, exist_ok=True)
    (out / 'captions').mkdir(exist_ok=True)
    for old in [*out.glob('*.jpg'), *(out / 'unmatched').glob('*.jpg'), *(out / 'captions').glob('*.png')]:  # a rerun starts clean
        old.unlink()
    if args.overlay:
        Path(args.overlay).mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(args.pdf)  # read-only: nothing below saves or modifies it

    photos_by_page = OrderedDict((n, page_photos(doc, n, args.overlay)) for n in range(1, doc.page_count + 1))

    product_pages = {n for p in products for n in p['pages']}
    plan, taken = assign(products, {n: ph for n, ph in photos_by_page.items() if n in product_pages})

    rows, matched = [], {}
    for page, entries in plan.items():
        expected_here = sum(1 for _, product, _ in entries if product)
        # Every product on the page got all its sub products. A photo left over at the end (a teddy
        # bear, a bathroom scene) does not shift the others; a page that came up short does.
        exact = all(taken[p['code']] == len(p['subs']) for p in products if page in p['pages'])
        for index, product, position in entries:
            image, caption = photos_by_page[page][index]
            if product is None:
                name = f'p{page:02d}_{index + 1:02d}.jpg'
                image.save(out / 'unmatched' / name, quality=92)
                rows.append([page, f'unmatched/{name}', '', '', '', 'no sub product left on this page', 'none'])
                continue
            code = sub_code(product['code'], position)
            image.save(out / f'{code}.jpg', quality=92)
            caption.save(out / 'captions' / f'{code}.png')
            confidence = 'high' if exact else 'low'
            how = f'reading order on page {page}, #{position} of {len(product["subs"])} for {product["code"]}'
            rows.append([page, f'{code}.jpg', code, product['code'], product['subs'][position - 1], how, confidence])
            matched[code] = (product, position, confidence)
    for number, photos in photos_by_page.items():
        if number in product_pages:
            continue
        for index, (image, _caption) in enumerate(photos):
            name = f'p{number:02d}_{index + 1:02d}.jpg'
            image.save(out / 'unmatched' / name, quality=92)
            rows.append([number, f'unmatched/{name}', '', '', '', 'page has no products in the catalogue', 'none'])

    with open(out / 'mapping.csv', 'w', newline='', encoding='utf-8') as handle:
        writer = csv.writer(handle)
        writer.writerow(['page', 'image', 'code', 'product', 'name', 'matched by', 'confidence'])
        writer.writerows(rows)

    write_contact(out, products, matched, rows)

    subs_total = sum(len(p['subs']) for p in products)
    with_photo = [p for p in products if any(sub_code(p['code'], i + 1) in matched for i in range(len(p['subs'])))]
    unmatched = sum(1 for r in rows if r[2] == '')
    low = sum(1 for _, _, c in matched.values() if c == 'low')
    print(f'sub products with a photo: {len(matched)} of {subs_total} ({low} low confidence)')
    print(f'sub products without one:  {subs_total - len(matched)}')
    print(f'products (main) with at least one photo: {len(with_photo)} of {len(products)}')
    print(f'unmatched images: {unmatched}')
    short = [(p['code'], len(p['subs']) - sum(1 for i in range(len(p['subs'])) if sub_code(p['code'], i + 1) in matched)) for p in products]
    for code, missing in short:
        if missing:
            print(f'  {code}: {missing} sub product(s) without a photo')
    print(f'written to {out}')


def write_contact(out, products, matched, rows):
    colour = {'high': '#1a7f37', 'low': '#b45309', 'none': '#b91c1c'}
    cells = []
    for product in products:
        for position, name in enumerate(product['subs'], 1):
            code = sub_code(product['code'], position)
            if code in matched:
                confidence = matched[code][2]
                picture = f'<img src="{html.escape(code)}.jpg" loading="lazy"><img class="cap" src="captions/{html.escape(code)}.png" loading="lazy">'
            else:
                confidence, picture = 'none', '<div class="blank">no photo</div>'
            cells.append(
                f'<figure style="border-color:{colour[confidence]}">{picture}'
                f'<figcaption><b>{html.escape(code)}</b><br>{html.escape(name)}'
                f'<br><span style="color:{colour[confidence]}">{confidence}</span></figcaption></figure>'
            )
    stray = [
        f'<figure style="border-color:{colour["none"]}"><img src="{html.escape(r[1])}" loading="lazy">'
        f'<figcaption>{html.escape(r[1])}<br>page {r[0]}</figcaption></figure>'
        for r in rows
        if r[2] == ''
    ]
    page = (
        '<!doctype html><meta charset="utf-8"><title>Catalogue photos</title>'
        '<style>body{font:13px system-ui;margin:16px}h2{margin:24px 0 8px}'
        '.grid{display:grid;grid-template-columns:repeat(auto-fill,150px);gap:10px}'
        'figure{margin:0;border:2px solid;border-radius:6px;padding:4px;background:#fff}'
        'img,.blank{width:140px;height:140px;object-fit:contain;background:#eee;display:flex;align-items:center;justify-content:center}img.cap{height:22px;background:#fff}'
        'figcaption{margin-top:4px;word-break:break-word}</style>'
        f'<h2>Sub products ({len(cells)}) — green high, orange low, red none</h2><div class="grid">{"".join(cells)}</div>'
        f'<h2>Unmatched images ({len(stray)})</h2><div class="grid">{"".join(stray)}</div>'
    )
    (out / 'contact.html').write_text(page, encoding='utf-8')


if __name__ == '__main__':
    sys.exit(main())
