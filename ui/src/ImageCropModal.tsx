/**
 * The crop/rotate editor (`7-IMAGE-PIPELINE.md` §3), ported from the source
 * spec's Electron `BrowserWindow` onto a web `Modal` — the panel is a web page
 * that the Electron shell hosts in a single window and that also runs in a
 * plain browser tab, so a dedicated undecorated window isn't available to it;
 * a focus-trapped, Esc-closes modal gives the same "dedicated editing surface,
 * not an inline control" feel with the primitive this repo actually has.
 *
 * Non-destructive per §3.2: nothing here re-encodes anything. The canvas only
 * ever redraws from the original decoded `<img>`, and Save sends the *original
 * file bytes* plus the crop rect + rotation as plain numbers — the server
 * (`master/src/services/image.service.ts`) does the one real decode/crop/resize,
 * once, so repeated adjustments in this session never compound quality loss.
 *
 * The eight grips, not four. `handleAt`'s vocabulary always had all eight and
 * the hit test only answered with corners, which meant the one adjustment
 * people actually make — trim a strip off the bottom — required dragging a
 * corner and fighting the other axis back into place.
 */

import { rem } from './rem.js';

import { useEffect, useMemo, useRef, useState } from 'react';
import { IMAGE_VARIANT_LONG_EDGES } from '@orderbook/shared';

import { BusyMark } from './BusyMark';
import { Button } from './Button';
import { Modal } from './Modal';
import { t } from './i18n';

export interface CropResult {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  rotationDeg: number;
}

type AspectPreset = 'free' | 'original' | '1:1' | '4:3' | '3:2' | '4:5';
type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_DISPLAY = 520;
const HANDLE_HIT = 10;

/** Stage height before a photo has decoded, so the dialog does not resize under
 *  the pointer the moment it arrives. */
const MIN_STAGE = 320;

/** The long edge the biggest stored variant wants. A crop below it is not an
 *  error — the pipeline never upscales — but it is worth saying out loud. */
const MASTER_LONG_EDGE = IMAGE_VARIANT_LONG_EDGES.master;

const ASPECTS: ReadonlyArray<{ preset: AspectPreset; label: string }> = [
  { preset: 'free', label: t('photo.editor.aspect.free') },
  { preset: 'original', label: t('photo.editor.aspect.original') },
  { preset: '1:1', label: t('photo.editor.aspect.square') },
  { preset: '4:3', label: t('photo.editor.aspect.landscape43') },
  { preset: '3:2', label: t('photo.editor.aspect.landscape32') },
  { preset: '4:5', label: t('photo.editor.aspect.portrait45') },
];

function rotatedBounds(width: number, height: number, deg: number): { w: number; h: number } {
  const rad = (deg * Math.PI) / 180;
  const w = Math.abs(width * Math.cos(rad)) + Math.abs(height * Math.sin(rad));
  const h = Math.abs(width * Math.sin(rad)) + Math.abs(height * Math.cos(rad));
  return { w, h };
}

/**
 * The largest upright rectangle of the source's own shape that fits *inside* the
 * rotated image — the region with no background wedge in it.
 *
 * Straightening rotates the photo and fills the four corners it opens up. The
 * server fills them `#ffffff` (`image.service.ts`); the preview canvas left them
 * transparent over a container painted `--bg-canvas`, which is near-black in
 * dark mode — so the operator straightened against black corners and got white
 * ones. And the default crop was 86% of the rotated *bounding box*, which always
 * exceeds this: a 1000×750 photo at 10° has a 1115×912 bounding box, an 86%
 * default of 959×784, and an inscribed region of about 869×622. Every straighten
 * therefore shipped wedges unless the operator noticed and shrank the crop.
 *
 * The standard largest-inscribed-rectangle result. The crop is still *allowed*
 * out to the full frame — somebody may want the wedges — but it no longer starts
 * there, and the canvas now paints them the colour they will actually be.
 */
function inscribedBounds(width: number, height: number, deg: number): { w: number; h: number } {
  const angle = Math.abs((deg * Math.PI) / 180) % Math.PI;
  const a = angle > Math.PI / 2 ? Math.PI - angle : angle;
  if (a < 1e-9) return { w: width, h: height };

  const sin = Math.sin(a);
  const cos = Math.cos(a);
  const widthIsLonger = width >= height;
  const longSide = widthIsLonger ? width : height;
  const shortSide = widthIsLonger ? height : width;

  // Past this angle the inscribed rectangle is limited by the short side alone.
  if (shortSide <= 2 * sin * cos * longSide || Math.abs(sin - cos) < 1e-9) {
    const half = 0.5 * shortSide;
    return widthIsLonger ? { w: half / sin, h: half / cos } : { w: half / cos, h: half / sin };
  }

  const cos2a = cos * cos - sin * sin;
  return { w: (width * cos - height * sin) / cos2a, h: (height * cos - width * sin) / cos2a };
}

function clampRect(rect: Rect, boundsW: number, boundsH: number): Rect {
  const w = Math.min(Math.max(rect.w, 20), boundsW);
  const h = Math.min(Math.max(rect.h, 20), boundsH);
  const x = Math.min(Math.max(rect.x, 0), boundsW - w);
  const y = Math.min(Math.max(rect.y, 0), boundsH - h);
  return { x, y, w, h };
}

/** The width/height ratio a preset locks to, or null for a free crop. */
function ratioFor(aspect: AspectPreset, sourceAspect: number): number | null {
  switch (aspect) {
    case 'free':
      return null;
    case 'original':
      return sourceAspect;
    case '1:1':
      return 1;
    case '4:3':
      return 4 / 3;
    case '3:2':
      return 3 / 2;
    case '4:5':
      return 4 / 5;
  }
}

function centeredRect(
  boundsW: number,
  boundsH: number,
  aspect: AspectPreset,
  sourceAspect: number,
  safeW = boundsW,
  safeH = boundsH,
): Rect {
  // Sized against the wedge-free region, centred on the whole frame — the two
  // share a centre, so the rect lands inside the safe area either way.
  const ratio = ratioFor(aspect, sourceAspect) ?? safeW / safeH;
  let w = safeW * 0.98;
  let h = w / ratio;
  if (h > safeH * 0.98) {
    h = safeH * 0.98;
    w = h * ratio;
  }
  return { x: (boundsW - w) / 2, y: (boundsH - h) / 2, w, h };
}

/**
 * Resize `r` by the grip being held, keeping the opposite edge nailed down.
 *
 * The ratio lock is applied *before* the anchor is restored, which is the half
 * the first version missed: it recomputed the height and left `y` where the
 * pointer had put it, so dragging a north grip on a locked ratio grew the box
 * downwards out from under the cursor.
 */
function resize(r: Rect, handle: Handle, dx: number, dy: number, ratio: number | null): Rect {
  let { x, y, w, h } = r;

  if (handle.includes('e')) w = r.w + dx;
  if (handle.includes('w')) w = r.w - dx;
  if (handle.includes('s')) h = r.h + dy;
  if (handle.includes('n')) h = r.h - dy;

  if (ratio !== null) {
    // A pure-vertical grip drives the width; everything else drives the height.
    if (handle === 'n' || handle === 's') w = h * ratio;
    else h = w / ratio;
  }

  w = Math.max(w, 20);
  h = Math.max(h, 20);

  // Re-anchor: a west grip keeps the east edge, a north grip keeps the south.
  if (handle.includes('w')) x = r.x + r.w - w;
  if (handle.includes('n')) y = r.y + r.h - h;

  // A locked ratio can change the axis the grip did not touch, so a corner that
  // anchors on one side still has to keep the other side's edge where it was.
  if (ratio !== null) {
    if (handle === 'ne' || handle === 'nw') y = r.y + r.h - h;
    if (handle === 'sw' || handle === 'nw') x = r.x + r.w - w;
    if (handle === 'n' || handle === 's') x = r.x + (r.w - w) / 2;
    if (handle === 'e' || handle === 'w') y = r.y + (r.h - h) / 2;
  }

  return { x, y, w, h };
}

export function ImageCropModal({
  open,
  file,
  busy,
  queueIndex,
  queueTotal,
  onCancel,
  onSave,
}: {
  open: boolean;
  file: File | null;
  busy: boolean;
  /** 1-based position when several files were picked at once, for the title. */
  queueIndex?: number;
  queueTotal?: number;
  onCancel: () => void;
  onSave: (result: CropResult) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  /**
   * Decoding is not instant and it is not guaranteed.
   *
   * A phone photo is several megabytes and takes a visible moment to decode,
   * and the stage used to sit blank behind one static word for all of it. And
   * `onload` had no `onerror` beside it, so a format the browser cannot read —
   * HEIC off an iPhone, most TIFFs — left `img` null and the editor showing
   * "Loading…" for ever, with no way to tell a slow decode from a dead one.
   */
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [rotationStep, setRotationStep] = useState<0 | 90 | 180 | 270>(0);
  const [fineRotation, setFineRotation] = useState(0);
  const [aspect, setAspect] = useState<AspectPreset>('free');
  const [crop, setCrop] = useState<Rect | null>(null);
  const dragRef = useRef<{ handle: Handle; startX: number; startY: number; rect: Rect } | null>(
    null,
  );

  const totalDeg = rotationStep + fineRotation;

  useEffect(() => {
    if (!open || !file) {
      setImg(null);
      setStatus('loading');
      return;
    }
    setImg(null);
    setStatus('loading');
    const url = URL.createObjectURL(file);
    const el = new Image();
    el.onload = () => {
      setImg(el);
      setStatus('ready');
    };
    el.onerror = () => {
      setImg(null);
      setStatus('failed');
    };
    el.src = url;
    return () => URL.revokeObjectURL(url);
  }, [open, file]);

  useEffect(() => {
    setRotationStep(0);
    setFineRotation(0);
    setAspect('free');
    setCrop(null);
  }, [file]);

  const displayScale = useMemo(() => {
    if (!img) return 1;
    const { w, h } = rotatedBounds(img.naturalWidth, img.naturalHeight, totalDeg);
    return Math.min(MAX_DISPLAY / w, MAX_DISPLAY / h, 1);
  }, [img, totalDeg]);

  const boundsPx = useMemo(() => {
    if (!img) return { w: 0, h: 0 };
    const { w, h } = rotatedBounds(img.naturalWidth, img.naturalHeight, totalDeg);
    return { w: w * displayScale, h: h * displayScale };
  }, [img, totalDeg, displayScale]);

  const sourceAspect = img ? img.naturalWidth / img.naturalHeight : 1;
  const ratio = ratioFor(aspect, sourceAspect);

  /** The wedge-free region, in the same display pixels as `boundsPx`. */
  const safePx = useMemo(() => {
    if (!img) return { w: 0, h: 0 };
    const { w, h } = inscribedBounds(img.naturalWidth, img.naturalHeight, totalDeg);
    return { w: w * displayScale, h: h * displayScale };
  }, [img, totalDeg, displayScale]);

  // Rotation reshapes the canvas, so the crop rect resets to a fresh centered
  // suggestion rather than trying to remap a rectangle across a changed frame.
  useEffect(() => {
    if (!img || boundsPx.w === 0) return;
    setCrop(
      centeredRect(
        boundsPx.w,
        boundsPx.h,
        aspect,
        img.naturalWidth / img.naturalHeight,
        safePx.w,
        safePx.h,
      ),
    );
    // `rotationStep` and `fineRotation` stay: a 180° flip changes them without
    // changing the bounds, and the rect still has to be re-centred.
  }, [img, rotationStep, fineRotation, aspect, boundsPx.w, boundsPx.h, safePx.w, safePx.h]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img || !crop) return;
    canvas.width = boundsPx.w;
    canvas.height = boundsPx.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // White, not transparent. The server rotates with a `#ffffff` background
    // (`master/src/services/image.service.ts`), and leaving these corners clear
    // over `--bg-canvas` showed the operator near-black wedges in dark mode for
    // an output that would have white ones.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((totalDeg * Math.PI) / 180);
    const w = img.naturalWidth * displayScale;
    const h = img.naturalHeight * displayScale;
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();

    // Dim everything outside the crop rect (four bands, cheaper than a
    // full-canvas overlay plus a cut-out).
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, canvas.width, crop.y);
    ctx.fillRect(0, crop.y + crop.h, canvas.width, canvas.height - crop.y - crop.h);
    ctx.fillRect(0, crop.y, crop.x, crop.h);
    ctx.fillRect(crop.x + crop.w, crop.y, canvas.width - crop.x - crop.w, crop.h);

    // Rule-of-thirds grid.
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 2; i += 1) {
      const gx = crop.x + (crop.w * i) / 3;
      ctx.beginPath();
      ctx.moveTo(gx, crop.y);
      ctx.lineTo(gx, crop.y + crop.h);
      ctx.stroke();
      const gy = crop.y + (crop.h * i) / 3;
      ctx.beginPath();
      ctx.moveTo(crop.x, gy);
      ctx.lineTo(crop.x + crop.w, gy);
      ctx.stroke();
    }

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(crop.x + 0.75, crop.y + 0.75, crop.w - 1.5, crop.h - 1.5);

    // Eight grips: four corners drawn square, four edge midpoints drawn as short
    // bars so the two kinds are told apart without a legend.
    ctx.fillStyle = '#ffffff';
    const midX = crop.x + crop.w / 2;
    const midY = crop.y + crop.h / 2;
    for (const [hx, hy] of [
      [crop.x, crop.y],
      [crop.x + crop.w, crop.y],
      [crop.x, crop.y + crop.h],
      [crop.x + crop.w, crop.y + crop.h],
    ] as Array<[number, number]>) {
      ctx.fillRect(hx - 4, hy - 4, 8, 8);
    }
    ctx.fillRect(midX - 8, crop.y - 2, 16, 4);
    ctx.fillRect(midX - 8, crop.y + crop.h - 2, 16, 4);
    ctx.fillRect(crop.x - 2, midY - 8, 4, 16);
    ctx.fillRect(crop.x + crop.w - 2, midY - 8, 4, 16);
  }, [img, crop, totalDeg, displayScale, boundsPx]);

  function hitTest(x: number, y: number, rect: Rect): Handle | null {
    const near = (px: number, py: number) =>
      Math.abs(x - px) <= HANDLE_HIT && Math.abs(y - py) <= HANDLE_HIT;
    if (near(rect.x, rect.y)) return 'nw';
    if (near(rect.x + rect.w, rect.y)) return 'ne';
    if (near(rect.x, rect.y + rect.h)) return 'sw';
    if (near(rect.x + rect.w, rect.y + rect.h)) return 'se';

    // Edges, after the corners: a corner is also "on" two edges, and the corner
    // is the one somebody aiming at it means.
    const withinX = x >= rect.x && x <= rect.x + rect.w;
    const withinY = y >= rect.y && y <= rect.y + rect.h;
    if (withinX && Math.abs(y - rect.y) <= HANDLE_HIT) return 'n';
    if (withinX && Math.abs(y - (rect.y + rect.h)) <= HANDLE_HIT) return 's';
    if (withinY && Math.abs(x - rect.x) <= HANDLE_HIT) return 'w';
    if (withinY && Math.abs(x - (rect.x + rect.w)) <= HANDLE_HIT) return 'e';

    if (withinX && withinY) return 'move';
    return null;
  }

  function pointerPos(event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!crop) return;
    const pos = pointerPos(event);
    const handle = hitTest(pos.x, pos.y, crop);
    if (!handle) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { handle, startX: pos.x, startY: pos.y, rect: crop };
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current;
    if (!drag) return;
    const pos = pointerPos(event);
    const dx = pos.x - drag.startX;
    const dy = pos.y - drag.startY;
    const r = drag.rect;

    const next =
      drag.handle === 'move'
        ? { ...r, x: r.x + dx, y: r.y + dy }
        : resize(r, drag.handle, dx, dy, ratio);

    setCrop(clampRect(next, boundsPx.w, boundsPx.h));
  }

  function onPointerUp(event: React.PointerEvent<HTMLCanvasElement>): void {
    // Released explicitly: a capture left standing keeps sending this canvas
    // moves after the pointer has gone somewhere else entirely.
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  }

  function reset(): void {
    setRotationStep(0);
    setFineRotation(0);
    setAspect('free');
    if (img && boundsPx.w > 0) {
      setCrop(centeredRect(boundsPx.w, boundsPx.h, 'free', sourceAspect, boundsPx.w, boundsPx.h));
    }
  }

  // What the server will actually store, in source pixels — the number that
  // decides whether this photo can fill the largest variant.
  const output = useMemo(() => {
    if (!crop || displayScale <= 0) return null;
    return {
      width: Math.round(crop.w / displayScale),
      height: Math.round(crop.h / displayScale),
    };
  }, [crop, displayScale]);

  const outputIsSmall = output !== null && Math.max(output.width, output.height) < MASTER_LONG_EDGE;

  function save(): void {
    if (!img || !crop) return;
    // Canvas/display coordinates → rotated-source pixel coordinates, which is
    // the space `master/src/domain/images.ts#assertCropRect` validates against.
    //
    // Clamped to the rotated bounds before it leaves: `rotatedBounds` is
    // trigonometry and sharp's own rotate rounds to whole pixels, so a rect
    // dragged flush against the far edge can land a fraction outside the
    // buffer the server measures and come back as `crop.outOfBounds`.
    const bounds = rotatedBounds(img.naturalWidth, img.naturalHeight, totalDeg);
    const cropX = Math.max(0, crop.x / displayScale);
    const cropY = Math.max(0, crop.y / displayScale);

    onSave({
      cropX,
      cropY,
      cropWidth: Math.max(1, Math.min(crop.w / displayScale, bounds.w - cropX - 1)),
      cropHeight: Math.max(1, Math.min(crop.h / displayScale, bounds.h - cropY - 1)),
      rotationDeg: totalDeg,
    });
  }

  const title =
    queueTotal && queueTotal > 1 && queueIndex
      ? t('photo.editor.titleQueued', { index: queueIndex, total: queueTotal })
      : t('photo.editor.title');

  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="lg"
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={reset} disabled={busy || !img}>
            {t('photo.editor.reset')}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={save} busy={busy} disabled={!img || !crop}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {/* Photo left, its adjustments right. Stacked, the controls sat below
          the fold on a laptop and the straighten slider — the one control you
          use while watching the picture — could not be seen at the same time
          as the picture. `flex-wrap` still stacks them when the window (or the
          scale) leaves no room for the column. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 'var(--s-20)' }}>
        <div
          style={{
            flex: 'none',
            width: boundsPx.w || MAX_DISPLAY,
            height: boundsPx.h || MIN_STAGE,
            maxWidth: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-canvas)',
            borderRadius: 'var(--r-sm)',
          }}
        >
          {img ? (
            <canvas
              ref={canvasRef}
              style={{ touchAction: 'none', cursor: dragRef.current ? 'grabbing' : 'default' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          ) : status === 'failed' ? (
            <p
              className="ob-small"
              style={{
                margin: 0,
                padding: 'var(--s-16)',
                maxWidth: rem(320),
                textAlign: 'center',
                color: 'var(--state-offline)',
              }}
            >
              {t('photo.editor.failed')}
            </p>
          ) : (
            <span
              style={{
                display: 'inline-flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 'var(--s-8)',
                color: 'var(--fg-tertiary)',
              }}
            >
              <BusyMark size={28} label="" />
              <span className="ob-small">{t('photo.editor.loading')}</span>
            </span>
          )}
        </div>

        {/* The adjustments. Disabled rather than hidden while the photo is
            still decoding: the panel keeps its width, so nothing jumps when
            the picture arrives. */}
        <div
          style={{
            flex: `1 1 ${rem(220)}`,
            minWidth: rem(200),
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-16)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
            <span className="ob-eyebrow" style={{ color: 'var(--fg-tertiary)' }}>
              {t('photo.editor.aspect')}
            </span>
            <div style={{ display: 'flex', gap: 'var(--s-8)', flexWrap: 'wrap' }}>
              {ASPECTS.map(({ preset, label }) => (
                <Button
                  key={preset}
                  size="sm"
                  variant={aspect === preset ? 'primary' : 'secondary'}
                  disabled={!img}
                  onClick={() => setAspect(preset)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
            <span className="ob-eyebrow" style={{ color: 'var(--fg-tertiary)' }}>
              {t('photo.editor.rotate')}
            </span>
            <div style={{ display: 'flex', gap: 'var(--s-8)', flexWrap: 'wrap' }}>
              <Button
                size="sm"
                disabled={!img}
                onClick={() => setRotationStep(((rotationStep + 270) % 360) as 0 | 90 | 180 | 270)}
              >
                {t('photo.editor.rotateLeft')}
              </Button>
              <Button
                size="sm"
                disabled={!img}
                onClick={() => setRotationStep(((rotationStep + 90) % 360) as 0 | 90 | 180 | 270)}
              >
                {t('photo.editor.rotateRight')}
              </Button>
            </div>
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
            <span className="ob-eyebrow" style={{ color: 'var(--fg-tertiary)' }}>
              {t('photo.editor.straighten')}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
              <input
                type="range"
                min={-15}
                max={15}
                step={0.5}
                value={fineRotation}
                disabled={!img}
                onChange={(event) => setFineRotation(Number(event.target.value))}
                style={{ flex: 1, minWidth: 0 }}
              />
              <span className="ob-small ob-mono" style={{ width: rem(40), textAlign: 'right' }}>
                {fineRotation.toFixed(1)}°
              </span>
            </span>
          </label>

          {output && (
            <p
              className="ob-small"
              style={{
                margin: 0,
                color: outputIsSmall ? 'var(--state-offline)' : 'var(--fg-secondary)',
              }}
            >
              {outputIsSmall
                ? t('photo.editor.outputSmall', {
                    width: output.width,
                    height: output.height,
                    longEdge: MASTER_LONG_EDGE,
                  })
                : t('photo.editor.output', { width: output.width, height: output.height })}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
