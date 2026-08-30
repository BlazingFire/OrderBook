/**
 * The page, drawn to scale.
 *
 * Absolutely-positioned `<div>`s rather than a `<canvas>`, deliberately. Text
 * elements have to show real text in the real face at the real size — that is
 * most of what a designer is looking at — and a selected element needs
 * something a keyboard can focus. `ImageCropModal` uses a canvas because it
 * composites an image; this is a layout tool.
 *
 * **On the pixel rule.** `ui-conventions.test.ts` forbids bare numeric or
 * quoted-px lengths in a JSX style object, because a raw px silently stops
 * scaling with `--root-size`. Every length here is computed from `pxPerMm`,
 * which is derived from the width this component is given, so it is already
 * relative to whatever space it was handed — that is the same property `rem()`
 * buys elsewhere, arrived at differently. Chrome *around* the canvas still uses
 * `rem()`.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import type { DocumentElement, PageGeometry } from '@orderbook/shared';

import { pageFrame, scaleFor, type Guide } from './pageDesignerGeometry.js';

export interface PageDesignerCanvasProps {
  geometry: PageGeometry;
  elements: readonly DocumentElement[];
  /** Ids drawn with a selection ring. Empty in the read-only view. */
  selected?: readonly string[];
  /** Snap lines to draw while something is being dragged. */
  guides?: readonly Guide[];
  /** Absent in the read-only view, which is what makes it read-only. */
  onPointerDownElement?: (id: string | null, event: React.PointerEvent) => void;
  children?: ReactNode;
}

/**
 * What an element looks like on the canvas.
 *
 * Not a preview of the PDF — the PDF is one click away and is the truth. This
 * is a diagram: enough to recognise a block and drag it, without pretending to
 * be a renderer. A field shows its binding name rather than a value, because
 * there is no record in scope and inventing one would teach the operator the
 * wrong thing about what fits.
 */
function elementFace(element: DocumentElement): { label: string; mono: boolean } {
  switch (element.kind) {
    case 'text':
      return { label: element.text || '—', mono: false };
    case 'field':
      return {
        label:
          element.binding.source === 'catalogue'
            ? element.binding.binding
            : `${element.binding.entity}.${element.binding.key}`,
        mono: true,
      };
    case 'image':
      return { label: element.slot, mono: true };
    case 'table':
      return { label: 'table', mono: true };
    case 'rule':
      return { label: '', mono: false };
    case 'box':
      return { label: '', mono: false };
  }
}

export function PageDesignerCanvas({
  geometry,
  elements,
  selected = [],
  guides = [],
  onPointerDownElement,
  children,
}: PageDesignerCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [widthPx, setWidthPx] = useState(0);

  // Measured rather than assumed: the same canvas serves a narrow preview pane
  // and a full-width editor, and the scale is the only thing that differs.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setWidthPx(width);
    });

    observer.observe(host);
    setWidthPx(host.clientWidth);

    return () => observer.disconnect();
  }, []);

  const { page, margins } = pageFrame(geometry);
  const pxPerMm = scaleFor(widthPx, page.w);
  const px = (mm: number): string => `${(mm * pxPerMm).toFixed(2)}px`;

  const ordered = [...elements].sort((a, b) => a.z - b.z);
  const interactive = Boolean(onPointerDownElement);

  return (
    <div ref={hostRef} className="ob-designer-host">
      <div
        className="ob-designer-page"
        style={{ width: px(page.w), height: px(page.h) }}
        onPointerDown={interactive ? (event) => onPointerDownElement?.(null, event) : undefined}
      >
        {/* The printable area, as a guide only — elements anchor to the page. */}
        <div
          className="ob-designer-margins"
          style={{
            left: px(margins.x),
            top: px(margins.y),
            width: px(margins.w),
            height: px(margins.h),
          }}
        />

        {ordered.map((element) => {
          const face = elementFace(element);
          const isSelected = selected.includes(element.id);

          const style: CSSProperties = {
            left: px(element.x),
            top: px(element.y),
            width: px(element.w),
            height: px(Math.max(element.h, element.kind === 'rule' ? 0.4 : element.h)),
          };

          if (element.kind === 'text' || element.kind === 'field') {
            // The real point size, scaled the same way everything else is, so a
            // 15pt heading looks like a heading rather than like body text.
            style.fontSize = `${(element.style.size * (pxPerMm / 2.8346)).toFixed(2)}px`;
            style.textAlign = element.style.align === 'centre' ? 'center' : element.style.align;
            style.fontWeight = element.style.bold ? 600 : 400;
          }

          if (element.kind === 'box') {
            style.background = element.fill ?? 'transparent';
            style.borderColor = element.stroke ?? 'transparent';
          }

          if (element.kind === 'rule') {
            style.background = element.colour ?? 'currentColor';
          }

          return (
            <div
              key={element.id}
              data-kind={element.kind}
              data-selected={isSelected ? 'true' : undefined}
              data-mono={face.mono ? 'true' : undefined}
              className="ob-designer-element"
              style={style}
              onPointerDown={
                interactive
                  ? (event) => {
                      event.stopPropagation();
                      onPointerDownElement?.(element.id, event);
                    }
                  : undefined
              }
            >
              {face.label}
            </div>
          );
        })}

        {guides.map((guide, index) => (
          <div
            key={`${guide.axis}-${guide.at}-${index}`}
            className="ob-designer-guide"
            data-axis={guide.axis}
            style={
              guide.axis === 'x'
                ? { left: px(guide.at), top: 0, height: px(page.h) }
                : { top: px(guide.at), left: 0, width: px(page.w) }
            }
          />
        ))}

        {children}
      </div>
    </div>
  );
}
