/**
 * The page designer: a palette, a sheet of paper, and an inspector.
 *
 * Drag and resize copy `ImageCropModal`'s idiom rather than adding a library —
 * `setPointerCapture` on the way down, dx/dy per grip on the way move, nothing
 * on the way up. Forty lines, already the house pattern, and it works with a
 * pen and a finger as well as a mouse.
 *
 * **Everything is arithmetic on millimetres**, done by `pageDesignerGeometry`,
 * which has no React in it and is unit-tested. This file owns state and events
 * and nothing else; when a drag lands in the wrong place the bug is in a pure
 * function with a test beside it rather than in a pointer handler.
 *
 * Drag is mouse-only, so every action reachable by dragging is also reachable
 * from the inspector's number boxes and the keyboard — the rule
 * `KanbanBoard.tsx` states for the same reason.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentElement, DocumentLayoutV2, PageGeometry } from '@orderbook/shared';
import { textStyle } from '@orderbook/shared';

import { Button } from './Button.js';
import { PageDesignerCanvas } from './PageDesignerCanvas.js';
import { PageDesignerInspector, type BindingChoice } from './PageDesignerInspector.js';
import {
  align,
  applyHandle,
  clampToPage,
  distribute,
  handleAt,
  pageFrame,
  rectOf,
  reorder,
  scaleFor,
  snap,
  tidy,
  tidyRect,
  type AlignEdge,
  type Guide,
  type Handle,
  type Rect,
} from './pageDesignerGeometry.js';
import { t } from './i18n.js';

export interface PageDesignerProps {
  geometry: PageGeometry;
  layout: DocumentLayoutV2;
  bindings: readonly BindingChoice[];
  onChange: (layout: DocumentLayoutV2) => void;
  /** Rendered beside the canvas — the live PDF preview, when there is one. */
  aside?: React.ReactNode;
  /**
   * A block the palette asked to place. Consumed once (see `onInsertConsumed`)
   * so a re-render never inserts it twice — the shell owns the request, this
   * owns the undo entry.
   */
  pendingInsert?: { kind: string; atMm: { x: number; y: number } | null; nonce: number } | null;
  insertElements?: (atMm: { x: number; y: number } | null) => DocumentElement[] | null;
  onInsertConsumed?: () => void;
}

interface Drag {
  handle: Handle;
  startX: number;
  startY: number;
  rect: Rect;
  id: string;
  /** Whether this drag has already taken its single undo snapshot. */
  pushed: boolean;
  /*
   * The page's own box and scale, captured once as the drag begins.
   *
   * `onPointerMove` is bound on the outer surface so a fast drag that leaves
   * the paper still tracks, which means its `currentTarget` is the *surface*,
   * not the page — measuring against it would compute the move in one
   * coordinate frame and the start in another. Capturing here also means a
   * layout shift mid-drag cannot move the origin under the pointer.
   */
  originX: number;
  originY: number;
  scale: number;
}

/** How many *pixels* of grab area a resize grip has, converted to millimetres
 *  at the current zoom so it stays the same size on screen. */
const GRIP_PX = 7;

/** Undo depth. A layout is small JSON, so whole snapshots are cheaper to reason
 *  about than a command log, and fifty is more than anybody backs out of. */
const UNDO_DEPTH = 50;

export function PageDesigner({
  geometry,
  layout,
  bindings,
  onChange,
  aside,
  pendingInsert = null,
  insertElements,
  onInsertConsumed,
}: PageDesignerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);

  const dragRef = useRef<Drag | null>(null);
  const undoRef = useRef<DocumentLayoutV2[]>([]);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const consumedNonce = useRef<number | null>(null);

  const { page, margins } = pageFrame(geometry);
  const elements = layout.elements;
  const selected = elements.find((element) => element.id === selectedId) ?? null;

  /** Commit a new element list, remembering the old one so it can be undone. */
  const commit = useCallback(
    (next: DocumentElement[], remember = true) => {
      if (remember) {
        undoRef.current = [layout, ...undoRef.current].slice(0, UNDO_DEPTH);
      }
      onChange({ version: 2, elements: next });
    },
    [layout, onChange],
  );

  const patch = useCallback(
    (id: string, changes: Partial<DocumentElement>, remember = true) => {
      commit(
        elements.map((element) =>
          element.id === id ? ({ ...element, ...changes } as DocumentElement) : element,
        ),
        remember,
      );
    },
    [commit, elements],
  );

  const undo = useCallback(() => {
    const [previous, ...rest] = undoRef.current;
    if (!previous) return;
    undoRef.current = rest;
    onChange(previous);
  }, [onChange]);

  // A palette block, placed once. The shell builds the bundle (it knows the
  // block kind and the drop point); this takes the single undo snapshot and
  // the selection, like any other add.
  useEffect(() => {
    if (!pendingInsert || !insertElements) return;
    if (consumedNonce.current === pendingInsert.nonce) return;
    consumedNonce.current = pendingInsert.nonce;
    const created = insertElements(pendingInsert.atMm);
    if (created && created.length > 0) {
      undoRef.current = [layout, ...undoRef.current].slice(0, UNDO_DEPTH);
      onChange({ version: 2, elements: [...elements, ...created] });
      setSelectedId(created[0]!.id);
    }
    onInsertConsumed?.();
  }, [pendingInsert, insertElements, onInsertConsumed, elements, layout, onChange]);

  // --- pointer ---------------------------------------------------------

  const onPointerDown = (id: string | null, event: React.PointerEvent): void => {
    const box = (event.currentTarget as HTMLElement)
      .closest('.ob-designer-page')
      ?.getBoundingClientRect();
    const scale = box ? scaleFor(box.width, page.w) : 1;

    if (!id || !box) {
      setSelectedId(null);
      return;
    }

    const element = elements.find((candidate) => candidate.id === id);
    if (!element) return;

    setSelectedId(id);

    const point = {
      x: (event.clientX - box.left) / scale,
      y: (event.clientY - box.top) / scale,
    };

    const handle = handleAt(rectOf(element), point.x, point.y, GRIP_PX / scale) ?? 'move';

    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragRef.current = {
      handle,
      startX: point.x,
      startY: point.y,
      rect: rectOf(element),
      id,
      pushed: false,
      originX: box.left,
      originY: box.top,
      scale,
    };
  };

  const onPointerMove = (event: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;

    // Measured against the page captured at pointer-down, never against this
    // handler's own element.
    const point = {
      x: (event.clientX - drag.originX) / drag.scale,
      y: (event.clientY - drag.originY) / drag.scale,
    };
    const moved = applyHandle(drag.rect, drag.handle, point.x - drag.startX, point.y - drag.startY);

    // Alt suspends snapping, which is the only way to place something one
    // millimetre from an edge it wants to latch onto.
    const others = elements.filter((element) => element.id !== drag.id).map(rectOf);
    const pageRect = page;

    const snapped = event.altKey
      ? { rect: moved, guides: [] as Guide[] }
      : snap(moved, others, pageRect, margins);

    setGuides(snapped.guides);

    // The undo entry is pushed on the first *movement*, not on pointer-down:
    // clicking five elements to look at them used to fill the history with five
    // identical snapshots, and Ctrl+Z then appeared to do nothing five times.
    if (!drag.pushed) {
      undoRef.current = [layout, ...undoRef.current].slice(0, UNDO_DEPTH);
      drag.pushed = true;
    }

    // Clamped to the printable box, which is what the server validates against.
    patch(drag.id, tidyRect(clampToPage(snapped.rect, margins)), false);
  };

  const onPointerUp = (): void => {
    dragRef.current = null;
    setGuides([]);
  };

  // One undo entry per drag, taken on the first move — see `onPointerMove`. A
  // click that only selects leaves the history alone.
  const beginDrag = (id: string | null, event: React.PointerEvent): void => {
    onPointerDown(id, event);
  };

  // --- keyboard --------------------------------------------------------

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      // A number box inside the inspector owns its own arrows.
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo();
        return;
      }

      if (!selected) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        const copy: DocumentElement = {
          ...selected,
          id: `${selected.kind}-${Date.now().toString(36)}`,
          x: tidy(selected.x + 3),
          y: tidy(selected.y + 3),
          z: elements.length,
        };
        commit([...elements, copy]);
        setSelectedId(copy.id);
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selected.kind === 'table') return;
        event.preventDefault();
        commit(elements.filter((element) => element.id !== selected.id));
        setSelectedId(null);
        return;
      }

      const step = event.shiftKey ? 5 : 1;
      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };

      const delta = nudge[event.key];
      if (!delta) return;

      event.preventDefault();
      const moved = clampToPage(
        { ...rectOf(selected), x: selected.x + delta[0], y: selected.y + delta[1] },
        margins,
      );
      patch(selected.id, tidyRect(moved));
    };

    surface.addEventListener('keydown', onKeyDown);
    return () => surface.removeEventListener('keydown', onKeyDown);
  }, [commit, elements, margins, patch, selected, undo]);

  // --- palette ---------------------------------------------------------

  const add = (kind: DocumentElement['kind']): void => {
    const id = `${kind}-${Date.now().toString(36)}`;
    const base = {
      id,
      x: tidy(geometry.margins.left + 5),
      y: tidy(geometry.margins.top + 5),
      w: 50,
      h: 10,
      z: elements.length,
      band: 'body' as const,
      flow: 'fixed' as const,
    };

    const created: DocumentElement =
      kind === 'text'
        ? { ...base, kind: 'text', text: t('designer.newText'), style: textStyle() }
        : kind === 'field'
          ? {
              ...base,
              kind: 'field',
              binding: bindings[0]?.ref ?? { source: 'catalogue', binding: 'document.title' },
              label: null,
              labelPlacement: 'none',
              style: textStyle(),
            }
          : kind === 'rule'
            ? { ...base, kind: 'rule', h: 0, colour: null, thickness: 0.5 }
            : kind === 'box'
              ? { ...base, kind: 'box', h: 20, fill: null, stroke: '#DDDDDD', radius: 0 }
              : { ...base, kind: 'image', slot: 'logo', h: 20 };

    commit([...elements, created]);
    setSelectedId(id);
  };

  /**
   * Align against the printable box, not the sheet.
   *
   * `align` uses its reference rect directly, so passing the page meant "align
   * left" put the element at x=0 — on the paper's cut edge, outside the box
   * `assertLayoutValid` accepts, and refused at save. Nobody laying out a
   * quotation means the sheet edge by "left" anyway; they mean the margin.
   */
  const alignSelected = (edge: AlignEdge): void => {
    if (!selected) return;
    const [rect] = align([rectOf(selected)], edge, margins);
    if (rect) patch(selected.id, tidyRect(clampToPage(rect, margins)));
  };

  const spread = (axis: 'x' | 'y'): void => {
    const body = elements.filter((element) => element.band === 'body');
    if (body.length < 3) return;

    const spreadRects = distribute(body.map(rectOf), axis);
    const byIndex = new Map(
      body
        .map(rectOf)
        .sort((a, b) => a[axis] - b[axis])
        .map((rect, index) => [`${rect.x},${rect.y}`, spreadRects[index]] as const),
    );

    commit(
      elements.map((element) => {
        const moved = byIndex.get(`${element.x},${element.y}`);
        return moved ? ({ ...element, ...tidyRect(moved) } as DocumentElement) : element;
      }),
    );
  };

  /**
   * Pull every element back inside the printable box.
   *
   * `validation.documents.layout.elementOffPage` reads "Move it, or use Fit to
   * page." — and until now there was no such control anywhere in the product.
   * An operator who narrowed the paper or widened a margin was simply stuck:
   * the save was refused, the message named a remedy that did not exist, and
   * nothing said which element was at fault.
   *
   * It is one pass of the same clamp a drag already goes through, so it cannot
   * put an element anywhere a drag could not.
   */
  const fitToPage = (): void => {
    commit(
      elements.map(
        (element) =>
          ({ ...element, ...tidyRect(clampToPage(rectOf(element), margins)) }) as DocumentElement,
      ),
    );
  };

  const paletteKinds: DocumentElement['kind'][] = ['text', 'field', 'image', 'rule', 'box'];

  const canUndo = undoRef.current.length > 0;

  return (
    <div
      ref={surfaceRef}
      tabIndex={-1}
      className="ob-designer"
      style={{ outline: 'none' }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="ob-designer-toolbar">
        {paletteKinds.map((kind) => (
          <Button key={kind} variant="secondary" onClick={() => add(kind)}>
            {t(`designer.add.${kind}`)}
          </Button>
        ))}

        <span style={{ flex: 1 }} />

        <Button variant="ghost" disabled={!selected} onClick={() => alignSelected('left')}>
          {t('designer.align.left')}
        </Button>
        <Button variant="ghost" disabled={!selected} onClick={() => alignSelected('centre')}>
          {t('designer.align.centre')}
        </Button>
        <Button variant="ghost" disabled={!selected} onClick={() => alignSelected('right')}>
          {t('designer.align.right')}
        </Button>
        <Button variant="ghost" onClick={() => spread('y')}>
          {t('designer.distribute')}
        </Button>
        <Button variant="ghost" onClick={fitToPage}>
          {t('designer.fitToPage')}
        </Button>
        <Button variant="ghost" disabled={!canUndo} onClick={undo}>
          {t('designer.undo')}
        </Button>
      </div>

      <div className="ob-designer-body">
        <div className="ob-designer-stage">
          <PageDesignerCanvas
            geometry={geometry}
            elements={elements}
            selected={selectedId ? [selectedId] : []}
            guides={guides}
            onPointerDownElement={beginDrag}
          />
          <p className="ob-small">{t('designer.hint')}</p>
        </div>

        <aside className="ob-designer-side">
          <PageDesignerInspector
            element={selected}
            bindings={bindings}
            onChange={(changes) => selected && patch(selected.id, changes)}
            onDelete={() => {
              if (!selected) return;
              commit(elements.filter((element) => element.id !== selected.id));
              setSelectedId(null);
            }}
            onOrder={(move) => selected && commit(reorder(elements, selected.id, move))}
          />
          {aside}
        </aside>
      </div>
    </div>
  );
}

/** The bindings a palette offers, built from whatever the caller knows. */
export function bindingChoices(
  catalogue: ReadonlyArray<{ binding: string; label: string; group: string }>,
  custom: ReadonlyArray<{ entity: 'lead' | 'order' | 'party'; key: string; label: string }>,
): BindingChoice[] {
  return [
    ...catalogue.map((entry) => ({
      value: `catalogue:${entry.binding}`,
      label: entry.label,
      group: entry.group,
      ref: { source: 'catalogue' as const, binding: entry.binding },
    })),
    ...custom.map((entry) => ({
      value: `custom:${entry.entity}:${entry.key}`,
      label: entry.label,
      group: t('designer.group.custom'),
      ref: { source: 'custom' as const, entity: entry.entity, key: entry.key },
    })),
  ];
}

/** Re-exported so a caller needs one import for the whole designer. */
export type { BindingChoice };
