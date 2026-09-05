/**
 * Drawing one placed element.
 *
 * The counterpart of `drawRow`: it receives something the model already
 * decided to build and puts it on the page. There is no branch here that can
 * withhold anything, because withholding happened upstream — an element the
 * reader may not see is not in `model.elements` at all.
 *
 * Everything arrives in millimetres and is converted once, at the boundary.
 * Type sizes are already points, because that is the unit a font size is in.
 */

import type PDFDocument from 'pdfkit';

import type { ElementTextStyle } from '@orderbook/shared';

import type { ResolvedElement } from '../domain/document-model.js';
import {
  filledBox,
  horizontalRule,
  measureRuns,
  mm,
  runText,
  runTextCentre,
  runTextRight,
  shrinkToFit,
  truncateToWidth,
  wrapLines,
  type TextStyle,
} from './primitives.js';

type Doc = typeof PDFDocument.prototype;

export interface ElementContext {
  /** Points added to every y, so a block can ride the table's growth. */
  offsetY: number;
  /** `#RRGGBB` a style may defer to by leaving its own colour null. */
  accentColour: string | null;
  logo: Buffer | null;
  signature: Buffer | null;
}

/** The element's own colour, or the template's accent, or the default ink. */
const inkOf = (style: ElementTextStyle, accent: string | null): string =>
  style.colour ?? accent ?? '#111111';

/**
 * An element's style as the primitives want it.
 *
 * `script` carries the *face family*, not the writing system: `splitByScript`
 * decides per run which physical font a stretch of text needs, so a mono
 * element containing Devanagari still gets the Devanagari face for that run.
 */
const toTextStyle = (
  style: ElementTextStyle,
  accent: string | null,
  size = style.size,
): TextStyle => ({
  size,
  bold: style.bold,
  colour: inkOf(style, accent),
  script: style.face === 'mono' ? 'mono' : 'body',
});

/**
 * Draw one element and report the y it finished at, in points.
 *
 * The return value only differs from the element's own bottom when the text
 * wrapped past it, which is the one fit mode allowed to grow.
 */
export function drawElement(doc: Doc, element: ResolvedElement, context: ElementContext): number {
  const x = mm(element.x);
  const y = mm(element.y) + context.offsetY;
  const width = mm(element.w);
  const height = mm(element.h);

  switch (element.kind) {
    case 'box':
      filledBox(doc, x, y, width, height, element.fill, element.stroke, mm(element.radius));
      return y + height;

    case 'rule':
      horizontalRule(
        doc,
        x,
        y,
        width,
        element.colour ?? context.accentColour ?? '#DDDDDD',
        mm(element.thickness),
      );
      return y;

    case 'image': {
      const bytes = element.slot === 'logo' ? context.logo : context.signature;
      if (!bytes) return y + height;

      try {
        doc.image(bytes, x, y, { fit: [width, height] });
      } catch {
        // An image PDFKit cannot decode costs the picture, never the document.
        // The alternative is a customer's quotation blocked by a bad upload
        // from months ago, which is the trade the header and signature blocks
        // have always made.
      }
      return y + height;
    }

    case 'text':
      return drawText(doc, element, { x, y, width, height }, context);

    case 'table':
      // Drawn by the renderer, which owns the row cursor and the page breaks.
      return y + height;
  }
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function drawText(
  doc: Doc,
  element: Extract<ResolvedElement, { kind: 'text' }>,
  box: Box,
  context: ElementContext,
): number {
  const { style } = element;
  const padding = mm(style.padding);

  const left = box.x + padding;
  const top = box.y + padding;
  const width = Math.max(box.width - padding * 2, 1);
  const height = Math.max(box.height - padding * 2, 1);

  // A label sits on the same baseline as its value and is measured with it, so
  // a right-aligned pair moves as one. This is what `keyValueBlock` and the
  // totals block have always done, and modelling them as two free elements
  // could not reproduce it.
  if (element.labelPlacement === 'before' && element.label) {
    return drawLabelledLine(doc, element, { ...box, x: left, y: top, width }, context);
  }

  let cursor = top;

  if (element.labelPlacement === 'above' && element.label) {
    const labelStyle = toTextStyle(
      { ...style, bold: false },
      context.accentColour,
      style.size * 0.8,
    );
    runText(doc, element.label, left, cursor, { ...labelStyle, colour: '#777777' });
    cursor += style.size * 0.8 * 1.45;
  }

  return drawFitted(doc, element.text, { x: left, y: cursor, width, height }, style, context);
}

/** `Ref  LD0001` — label and value on one baseline, right-aligned as a unit. */
function drawLabelledLine(
  doc: Doc,
  element: Extract<ResolvedElement, { kind: 'text' }>,
  box: Box,
  context: ElementContext,
): number {
  const { style } = element;
  const label = `${element.label} `;

  const valueStyle = toTextStyle(style, context.accentColour);
  const labelStyle: TextStyle = {
    size: style.size * 0.8,
    colour: '#777777',
    script: 'body',
  };

  if (style.align === 'right') {
    const valueWidth = measureRuns(doc, element.text, valueStyle);
    const right = box.x + box.width;

    runTextRight(doc, label, right - valueWidth, box.y + 1, labelStyle);
    runTextRight(doc, element.text, right, box.y, valueStyle);
  } else {
    const labelEnd = runText(doc, label, box.x, box.y, labelStyle);
    runText(doc, element.text, labelEnd, box.y, valueStyle);
  }

  return box.y + style.size * style.lineHeight;
}

/**
 * Put text in a box the way the element asked for.
 *
 * `wrap` is the only mode allowed past the bottom of the box; the other three
 * each give something up to stay inside it. All four wrap through `wrapLines`,
 * the same function `shrinkToFit` searches with — a fitter that measured
 * differently from the drawer is how a paragraph loses its last line.
 */
function drawFitted(
  doc: Doc,
  text: string,
  box: Box,
  style: ElementTextStyle,
  context: ElementContext,
): number {
  const drawStyle = toTextStyle(style, context.accentColour);

  if (style.fit === 'truncate') {
    const single = truncateToWidth(doc, text.replace(/\s+/g, ' '), box.width, drawStyle);
    drawAligned(doc, single, box, style, drawStyle);
    return box.y + style.size * style.lineHeight;
  }

  const size =
    style.fit === 'shrink'
      ? shrinkToFit(doc, text, box.width, box.height, drawStyle, style.lineHeight)
      : style.size;

  const sized = toTextStyle(style, context.accentColour, size);
  const lineHeight = size * style.lineHeight;
  const lines = wrapLines(doc, text, box.width, sized);

  // `clip` keeps only what fits; `wrap` and `shrink` draw everything they have.
  const limit =
    style.fit === 'clip' ? Math.max(Math.floor(box.height / lineHeight), 1) : lines.length;

  let cursor = box.y;
  for (const line of lines.slice(0, limit)) {
    if (line.length > 0) drawAligned(doc, line, { ...box, y: cursor }, style, sized);
    cursor += lineHeight;
  }

  return cursor;
}

function drawAligned(
  doc: Doc,
  line: string,
  box: Box,
  style: ElementTextStyle,
  drawStyle: TextStyle,
): void {
  if (style.align === 'right') {
    runTextRight(doc, line, box.x + box.width, box.y, drawStyle);
  } else if (style.align === 'centre') {
    runTextCentre(doc, line, box.x + box.width / 2, box.y, drawStyle);
  } else {
    runText(doc, line, box.x, box.y, drawStyle);
  }
}
