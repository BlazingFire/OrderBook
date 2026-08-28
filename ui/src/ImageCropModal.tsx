import { rem } from './rem.js';
/**
 * The crop/rotate editor (`7-IMAGE-PIPELINE.md` §3), ported from the source
 * spec's Electron `BrowserWindow` onto a web `Modal` — this app has no
 * Electron process anywhere, so a dedicated undecorated window isn't
 * available; a focus-trapped, Esc-closes modal gives the same "dedicated
 * editing surface, not an inline control" feel with the primitive this repo
 * actually has.
 *
 * Non-destructive per §3.2: nothing here re-encodes anything. The canvas only
 * ever redraws from the original decoded `<img>`, and Save sends the *original
 * file bytes* plus the crop rect + rotation as plain numbers — the server
 * (`master/src/services/image.service.ts`) does the one real decode/crop/resize,
 * once, so repeated adjustments in this session never compound quality loss.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

export interface CropResult {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  rotationDeg: number;
}

type AspectPreset = 'free' | '1:1' | '4:3' | 'original';
type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_DISPLAY = 520;
const HANDLE_HIT = 10;

function rotatedBounds(width: number, height: number, deg: number): { w: number; h: number } {
  const rad = (deg * Math.PI) / 180;
  const w = Math.abs(width * Math.cos(rad)) + Math.abs(height * Math.sin(rad));
  const h = Math.abs(width * Math.sin(rad)) + Math.abs(height * Math.cos(rad));
  return { w, h };
}

function clampRect(rect: Rect, boundsW: number, boundsH: number): Rect {
  const w = Math.min(Math.max(rect.w, 20), boundsW);
  const h = Math.min(Math.max(rect.h, 20), boundsH);
  const x = Math.min(Math.max(rect.x, 0), boundsW - w);
  const y = Math.min(Math.max(rect.y, 0), boundsH - h);
  return { x, y, w, h };
}

function centeredRect(
  boundsW: number,
  boundsH: number,
  aspect: AspectPreset,
  sourceAspect: number,
): Rect {
  const ratio =
    aspect === '1:1'
      ? 1
      : aspect === '4:3'
        ? 4 / 3
        : aspect === 'original'
          ? sourceAspect
          : boundsW / boundsH;
  let w = boundsW * 0.86;
  let h = w / ratio;
  if (h > boundsH * 0.86) {
    h = boundsH * 0.86;
    w = h * ratio;
  }
  return { x: (boundsW - w) / 2, y: (boundsH - h) / 2, w, h };
}

export function ImageCropModal({
  open,
  file,
  busy,
  onCancel,
  onSave,
}: {
  open: boolean;
  file: File | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (result: CropResult) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
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
      return;
    }
    const url = URL.createObjectURL(file);
    const el = new Image();
    el.onload = () => setImg(el);
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

  // Rotation reshapes the canvas, so the crop rect resets to a fresh centered
  // suggestion rather than trying to remap a rectangle across a changed frame.
  useEffect(() => {
    if (!img || boundsPx.w === 0) return;
    setCrop(centeredRect(boundsPx.w, boundsPx.h, aspect, img.naturalWidth / img.naturalHeight));
  }, [img, rotationStep, fineRotation, aspect]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img || !crop) return;
    canvas.width = boundsPx.w;
    canvas.height = boundsPx.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
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

    ctx.fillStyle = '#ffffff';
    const handles: Array<[number, number]> = [
      [crop.x, crop.y],
      [crop.x + crop.w, crop.y],
      [crop.x, crop.y + crop.h],
      [crop.x + crop.w, crop.y + crop.h],
    ];
    for (const [hx, hy] of handles) {
      ctx.fillRect(hx - 4, hy - 4, 8, 8);
    }
  }, [img, crop, totalDeg, displayScale, boundsPx]);

  function hitTest(x: number, y: number, rect: Rect): Handle | null {
    const near = (px: number, py: number) =>
      Math.abs(x - px) <= HANDLE_HIT && Math.abs(y - py) <= HANDLE_HIT;
    if (near(rect.x, rect.y)) return 'nw';
    if (near(rect.x + rect.w, rect.y)) return 'ne';
    if (near(rect.x, rect.y + rect.h)) return 'sw';
    if (near(rect.x + rect.w, rect.y + rect.h)) return 'se';
    if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) return 'move';
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
    let next: Rect = r;

    if (drag.handle === 'move') {
      next = { ...r, x: r.x + dx, y: r.y + dy };
    } else {
      let { x, y, w, h } = r;
      if (drag.handle.includes('e')) w = r.w + dx;
      if (drag.handle.includes('s')) h = r.h + dy;
      if (drag.handle.includes('w')) {
        x = r.x + dx;
        w = r.w - dx;
      }
      if (drag.handle.includes('n')) {
        y = r.y + dy;
        h = r.h - dy;
      }
      if (aspect !== 'free') {
        const ratio = r.w / r.h;
        h = w / ratio;
      }
      next = { x, y, w, h };
    }

    setCrop(clampRect(next, boundsPx.w, boundsPx.h));
  }

  function onPointerUp(): void {
    dragRef.current = null;
  }

  function save(): void {
    if (!img || !crop) return;
    // Canvas/display coordinates → rotated-source pixel coordinates, which is
    // the space `master/src/domain/images.ts#assertCropRect` validates against.
    onSave({
      cropX: crop.x / displayScale,
      cropY: crop.y / displayScale,
      cropWidth: crop.w / displayScale,
      cropHeight: crop.h / displayScale,
      rotationDeg: totalDeg,
    });
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Edit image"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} busy={busy} disabled={!img || !crop}>
            Save
          </Button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-12)',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            width: boundsPx.w || MAX_DISPLAY,
            height: boundsPx.h || 300,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-canvas, #111)',
            borderRadius: 'var(--r-sm, 4px)',
          }}
        >
          {img ? (
            <canvas
              ref={canvasRef}
              style={{ touchAction: 'none', cursor: dragRef.current ? 'grabbing' : 'default' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          ) : (
            <span className="ob-small" style={{ color: 'var(--fg-tertiary, #999)' }}>
              Loading…
            </span>
          )}
        </div>

        <div
          style={{ display: 'flex', gap: 'var(--s-8)', flexWrap: 'wrap', justifyContent: 'center' }}
        >
          {(['free', '1:1', '4:3', 'original'] as const).map((preset) => (
            <Button
              key={preset}
              size="sm"
              variant={aspect === preset ? 'primary' : 'secondary'}
              onClick={() => setAspect(preset)}
            >
              {preset === 'free' ? 'Free crop' : preset === 'original' ? 'Original' : preset}
            </Button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
          <Button
            size="sm"
            onClick={() => setRotationStep(((rotationStep + 270) % 360) as 0 | 90 | 180 | 270)}
          >
            ↺ Rotate left
          </Button>
          <Button
            size="sm"
            onClick={() => setRotationStep(((rotationStep + 90) % 360) as 0 | 90 | 180 | 270)}
          >
            ↻ Rotate right
          </Button>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)', width: '100%' }}>
          <span className="ob-small" style={{ whiteSpace: 'nowrap' }}>
            Straighten
          </span>
          <input
            type="range"
            min={-15}
            max={15}
            step={0.5}
            value={fineRotation}
            onChange={(event) => setFineRotation(Number(event.target.value))}
            style={{ flex: 1 }}
          />
          <span className="ob-small ob-mono" style={{ width: rem(40), textAlign: 'right' }}>
            {fineRotation.toFixed(1)}°
          </span>
        </label>
      </div>
    </Modal>
  );
}
