/**
 * The product's photos
 *
 * Port of `office/web/src/components/ProductImages.tsx`; keep in step (until
 * the Office switches to this copy the code exists twice). Deliberate
 * differences: it writes through the `CatalogueTransport`, held in a ref; every
 * control that changes a photo - add, change, remove, caption, reorder, set
 * primary, dropping files - is absent without `canEdit` (`products.edit`),
 * which the Office leaves ungated; and a failed write shows the server's
 * translated message (`apiErrorText`). Original header follows.
 *
 * The product's photos (`7-IMAGE-PIPELINE.md` §3.3) — the Photo card on the
 * product detail screen.
 *
 * It used to be a flat thumbnail strip inside the edit drawer, which buried the
 * one thing anyone opens a ceramic product to look at two clicks deep, behind a
 * form. The card leads with the cover photo at the size a photo is worth
 * showing, and keeps the rest of the gallery as the strip underneath: "Change
 * photo" and "Remove photo" act on the cover, the strip's own controls act on
 * the photo they sit under.
 *
 * "Set as primary" and reordering are plain list operations that never reopen
 * the editor; only adding a new photo does. Reordering is up/down buttons
 * rather than drag-and-drop. Dropping *files* on the card is native
 * (`dragover`/`drop` on a div, no library); reordering by drag is not, because
 * it needs pointer-level keyboard parity to stay reachable and the two buttons
 * already give that for free.
 *
 * Adding is a queue, not a single file. People photograph a tile from four
 * angles and pick all four at once; walking them through the editor one at a
 * time is the only part of that which needs a person.
 */

import { useRef, useState } from 'react';
import type { Product, ProductImage } from '@orderbook/shared';
import { MAX_IMAGE_SOURCE_BYTES } from '@orderbook/shared';

import { Button, IconButton } from './Button.js';
import type { CatalogueTransport } from './catalogueSummary.js';
import { Card } from './Card.js';
import { StatusPill } from './DataDisplay.js';
import { apiErrorText } from './errorText.js';
import { t } from './i18n.js';
import { ImageCropModal, type CropResult } from './ImageCropModal.js';
import { Modal } from './Modal.js';
import { ProgressiveImage } from './ProgressiveImage.js';
import { rem } from './rem.js';

const MAX_MB = Math.round(MAX_IMAGE_SOURCE_BYTES / (1024 * 1024));

/**
 * Every image extension the picker offers and the check below lets through.
 *
 * `accept="image/*"` alone was hiding files in the OS dialog and then the MIME
 * check was rejecting the ones that got past it: a browser reports `file.type`
 * as an empty string for anything it does not itself recognise, and `.heic`,
 * `.jfif`, `.tif` and `.avif` routinely arrive that way. Both gates now read
 * the extension as well, so what somebody has is what they can pick.
 *
 * Whether a given file can then be *cropped* is a separate question the editor
 * answers — it says so plainly when the browser cannot decode one (see
 * `photo.editor.failed`) instead of sitting on a spinner.
 */
const IMAGE_EXTENSIONS = [
  'apng',
  'avif',
  'bmp',
  'dib',
  'gif',
  'heic',
  'heif',
  'hif',
  'ico',
  'cur',
  'jfif',
  'jpe',
  'jpeg',
  'jpg',
  'jxl',
  'pjp',
  'pjpeg',
  'png',
  'svg',
  'svgz',
  'tif',
  'tiff',
  'webp',
];

/** The `accept` attribute: the broad type, plus every extension by name. */
const FILE_ACCEPT = ['image/*', ...IMAGE_EXTENSIONS.map((ext) => `.${ext}`)].join(',');

function looksLikeImage(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.includes(ext);
}

export function ProductImages({
  product,
  transport,
  canEdit,
  onChanged,
  onError,
}: {
  product: Product;
  transport: CatalogueTransport;
  /** Holds `products.edit`: without it the card shows the photos and changes none. */
  canEdit: boolean;
  onChanged: (product: Product) => void;
  onError: (message: string) => void;
}) {
  // Held in a ref so a host that builds the object inline cannot re-run a
  // hook (`ui/tests/no-transport-dep.test.ts`).
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * The picker was opened by "Change photo", so the photo that comes out of the
   * editor is meant to *be* the cover — not to join the gallery behind the one
   * already there. The server only auto-primaries the first image on an empty
   * product (`image.service.ts`), so anything else has to say so itself.
   *
   * A ref, not state: it is read inside the crop save that the editor triggers
   * long after the click, and re-rendering on it would reopen nothing.
   */
  const promoteNext = useRef(false);
  /** Files still to be walked through the editor. The head is the one open. */
  const [queue, setQueue] = useState<File[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<ProductImage | null>(null);
  const [editingCaption, setEditingCaption] = useState<ProductImage | null>(null);

  const images = [...product.images].sort((a, b) =>
    a.isPrimary === b.isPrimary ? a.sequence - b.sequence : a.isPrimary ? -1 : 1,
  );

  /**
   * Validate a batch and open the editor on the first survivor.
   *
   * Rejections are reported once and the rest still go through — dropping four
   * photos where one is a PDF should not cost the other three.
   */
  function accept(files: File[]): void {
    const usable: File[] = [];
    let rejectedType = false;
    let rejectedSize = false;

    for (const file of files) {
      if (!looksLikeImage(file)) {
        rejectedType = true;
        continue;
      }
      // Caught here, before the crop editor ever opens on it — the server would
      // refuse the same file too, but only after a full decode/crop/rotate pass
      // and an upload, with a generic 500 rather than a reason.
      if (file.size > MAX_IMAGE_SOURCE_BYTES) {
        rejectedSize = true;
        continue;
      }
      usable.push(file);
    }

    if (rejectedType) onError(t('photo.error.notAnImage'));
    else if (rejectedSize) onError(t('photo.error.tooLarge', { maxMb: MAX_MB }));

    if (usable.length === 0) return;
    setQueue(usable);
    setQueueTotal(usable.length);
  }

  function onFilePicked(event: React.ChangeEvent<HTMLInputElement>): void {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    accept(files);
  }

  function onDrop(event: React.DragEvent): void {
    event.preventDefault();
    setDropping(false);
    // A drop is never a "change the cover" gesture, whatever the last click
    // was — a picker the user opened and then dismissed must not colour it.
    promoteNext.current = false;
    accept([...event.dataTransfer.files]);
  }

  /** Drop the head of the queue and close the editor once it is empty. */
  function advance(): void {
    setQueue((rest) => {
      const next = rest.slice(1);
      if (next.length === 0) setQueueTotal(0);
      return next;
    });
  }

  async function onCropSave(result: CropResult): Promise<void> {
    const file = queue[0];
    if (!file) return;
    setBusy(true);
    try {
      const before = new Set(product.images.map((image) => image.id));
      let next = await transportRef.current.uploadProductImage(product.id, file, result);
      if (promoteNext.current) {
        // Only the first photo out of a "Change photo" pick takes the cover;
        // the rest of a dropped batch join the gallery as usual.
        promoteNext.current = false;
        const added = next.images.find((image) => !before.has(image.id));
        if (added && !added.isPrimary) {
          next = await transportRef.current.updateProductImage(product.id, added.id, {
            isPrimary: true,
          });
        }
      }
      onChanged(next);
      advance();
    } catch (caught) {
      onError(apiErrorText(caught, 'photo.error.uploadFailed'));
    } finally {
      setBusy(false);
    }
  }

  /** Open the picker; `promote` marks the result as the new cover photo. */
  function pick(promote: boolean): void {
    promoteNext.current = promote;
    fileInputRef.current?.click();
  }

  async function setPrimary(image: ProductImage): Promise<void> {
    setBusy(true);
    try {
      onChanged(
        await transportRef.current.updateProductImage(product.id, image.id, { isPrimary: true }),
      );
    } catch (caught) {
      onError(apiErrorText(caught, 'photo.error.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function saveCaption(image: ProductImage, caption: string): Promise<void> {
    setEditingCaption(null);
    try {
      onChanged(
        await transportRef.current.updateProductImage(product.id, image.id, {
          caption: caption.trim() === '' ? null : caption.trim(),
        }),
      );
    } catch (caught) {
      onError(apiErrorText(caught, 'photo.error.updateFailed'));
    }
  }

  async function remove(image: ProductImage): Promise<void> {
    setConfirmRemove(null);
    setBusy(true);
    try {
      onChanged(await transportRef.current.deleteProductImage(product.id, image.id));
    } catch (caught) {
      onError(apiErrorText(caught, 'photo.error.removeFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function move(image: ProductImage, direction: -1 | 1): Promise<void> {
    if (busy) return;
    const primary = images.find((entry) => entry.isPrimary) ?? null;
    const nonPrimary = images.filter((entry) => !entry.isPrimary);
    const index = nonPrimary.findIndex((entry) => entry.id === image.id);
    const swapWith = nonPrimary[index + direction];
    if (!swapWith) return;

    const reordered = [...nonPrimary];
    [reordered[index], reordered[index + direction]] = [swapWith, image];

    // The server validates the id list as a *complete* permutation of every
    // image on the product (`imageRepo.imageIdsForProduct`), primary included
    // — it just always displays first regardless of where it sits here.
    const ids = (primary ? [primary, ...reordered] : reordered).map((entry) => entry.id);

    setBusy(true);
    try {
      onChanged(await transportRef.current.reorderProductImages(product.id, ids));
    } catch (caught) {
      onError(apiErrorText(caught, 'photo.error.reorderFailed'));
    } finally {
      setBusy(false);
    }
  }

  const primary = images.find((image) => image.isPrimary) ?? null;
  /** Everything behind the cover, in gallery order — what the strip shows. */
  const rest = images.filter((image) => !image.isPrimary);

  return (
    <Card
      padded={false}
      style={{ outline: dropping ? '2px dashed var(--accent)' : undefined }}
      onDragOver={
        canEdit
          ? (event) => {
              event.preventDefault();
              setDropping(true);
            }
          : undefined
      }
      onDragLeave={canEdit ? () => setDropping(false) : undefined}
      onDrop={canEdit ? onDrop : undefined}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--s-8)',
          padding: 'var(--s-12) var(--s-16)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <span className="ob-eyebrow" style={{ color: 'var(--fg-tertiary)' }}>
          {t('product.detail.photoTitle')}
        </span>
        {primary && <StatusPill tone="accent">{t('photo.primary')}</StatusPill>}
      </div>

      <div
        style={{
          padding: 'var(--s-16)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-12)',
        }}
      >
        {primary ? (
          <>
            {/* The well is square and clips: a photo of a basin and a photo of
                a tile stack line up down the column whatever shape they were
                shot in. `slotPx` picks the variant; `large` is the fallback
                for a browser that cannot measure. */}
            <div
              style={{
                position: 'relative',
                width: '100%',
                aspectRatio: '1 / 1',
                overflow: 'hidden',
                borderRadius: 'var(--r-sm)',
                background: 'var(--bg-sunken)',
              }}
            >
              <ProgressiveImage
                imageId={primary.id}
                variant="large"
                slotPx={288}
                blurhash={primary.blurhash}
                width={primary.width}
                height={primary.height}
                alt={primary.caption ?? product.name}
              />
            </div>
            {canEdit && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--s-8)',
                  flexWrap: 'wrap',
                }}
              >
                <Button
                  variant="secondary"
                  size="sm"
                  icon="sync"
                  disabled={busy}
                  onClick={() => pick(true)}
                >
                  {t('photo.change')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="trash"
                  disabled={busy}
                  onClick={() => setConfirmRemove(primary)}
                >
                  {t('photo.remove')}
                </Button>
                <IconButton
                  icon="edit"
                  label={t('photo.caption.edit')}
                  size={14}
                  disabled={busy}
                  onClick={() => setEditingCaption(primary)}
                />
              </div>
            )}
          </>
        ) : !canEdit ? (
          // Nothing to show and nothing the person may add: an empty well, not a button.
          <div
            style={{
              width: '100%',
              aspectRatio: '1 / 1',
              border: '1px dashed var(--line-strong)',
              borderRadius: 'var(--r-sm)',
              background: 'var(--bg-sunken)',
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => pick(true)}
            style={{
              width: '100%',
              aspectRatio: '1 / 1',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 'var(--s-8)',
              border: '1px dashed var(--line-strong)',
              borderRadius: 'var(--r-sm)',
              background: 'none',
              cursor: 'pointer',
              color: 'var(--fg-secondary)',
              font: 'inherit',
            }}
          >
            {/* Inline rather than an `Icon`: the shared set is one `<path>` per
                glyph, and a camera is a body, a lens and a hump. */}
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="2.5" y="5.5" width="19" height="14" rx="2" />
              <circle cx="12" cy="12.5" r="3.5" />
              <path d="M8.5 5.5l1.3-2h4.4l1.3 2" />
            </svg>
            <span>{dropping ? t('photo.dropHint') : t('photo.add')}</span>
            <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
              {t('photo.addBrowseHint')}
            </span>
          </button>
        )}

        {primary && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--s-8)',
              paddingTop: 'var(--s-12)',
              borderTop: '1px solid var(--line)',
            }}
          >
            <span className="ob-eyebrow" style={{ color: 'var(--fg-tertiary)' }}>
              {t('photo.gallery')}
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-12)' }}>
              {rest.map((image, index) => (
                <div
                  key={image.id}
                  style={{
                    width: rem(96),
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--s-4)',
                  }}
                >
                  <ProgressiveImage
                    imageId={image.id}
                    variant="thumb"
                    slotPx={96}
                    blurhash={image.blurhash}
                    width={image.width}
                    height={image.height}
                    alt={image.caption ?? product.name}
                  />
                  {/* Four icon buttons and a text button do not fit across a
                      96px tile on one line — side by side they wrapped into
                      each other. One row each. */}
                  {canEdit && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 2,
                      }}
                    >
                      <IconButton
                        icon="chevron-up"
                        label={t('photo.moveEarlier')}
                        size={14}
                        disabled={busy || index === 0}
                        onClick={() => void move(image, -1)}
                      />
                      <IconButton
                        icon="chevron-down"
                        label={t('photo.moveLater')}
                        size={14}
                        disabled={busy || index === rest.length - 1}
                        onClick={() => void move(image, 1)}
                      />
                      {/* The caption is the alt text every one of these
                        thumbnails falls back to the product name for. */}
                      <IconButton
                        icon="edit"
                        label={t('photo.caption.edit')}
                        size={14}
                        disabled={busy}
                        onClick={() => setEditingCaption(image)}
                      />
                      <IconButton
                        icon="trash"
                        label={t('photo.remove')}
                        size={14}
                        disabled={busy}
                        onClick={() => setConfirmRemove(image)}
                      />
                    </div>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      className="ob-small"
                      style={{
                        width: '100%',
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        textDecoration: 'underline',
                        color: 'var(--fg-secondary)',
                        font: 'inherit',
                      }}
                      disabled={busy}
                      onClick={() => void setPrimary(image)}
                    >
                      {t('photo.setPrimary')}
                    </button>
                  )}
                </div>
              ))}

              {canEdit && (
                <button
                  type="button"
                  onClick={() => pick(false)}
                  style={{
                    width: rem(96),
                    aspectRatio: '1 / 1',
                    alignSelf: 'flex-start',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '1px dashed var(--line-strong)',
                    borderRadius: 'var(--r-sm)',
                    background: 'none',
                    cursor: 'pointer',
                    color: 'var(--fg-secondary)',
                    font: 'inherit',
                  }}
                >
                  {dropping ? t('photo.dropHint') : t('photo.add')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {canEdit && (
        <input
          ref={fileInputRef}
          type="file"
          accept={FILE_ACCEPT}
          multiple
          hidden
          onChange={onFilePicked}
        />
      )}

      <ImageCropModal
        open={queue.length > 0}
        file={queue[0] ?? null}
        busy={busy}
        queueIndex={queueTotal - queue.length + 1}
        queueTotal={queueTotal}
        onCancel={advance}
        onSave={(result) => void onCropSave(result)}
      />

      <CaptionModal
        image={editingCaption}
        onClose={() => setEditingCaption(null)}
        onSave={(caption) => editingCaption && void saveCaption(editingCaption, caption)}
      />

      <Modal
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title={t('photo.removeConfirm.title')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemove(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => confirmRemove && void remove(confirmRemove)}>
              {t('photo.remove')}
            </Button>
          </>
        }
      >
        <p className="ob-small">{t('photo.removeConfirm.body')}</p>
      </Modal>
    </Card>
  );
}

/**
 * Keyed on the image id so the field resets when a different photo is picked —
 * without the key it keeps the previous photo's caption in local state.
 */
function CaptionModal({
  image,
  onClose,
  onSave,
}: {
  image: ProductImage | null;
  onClose: () => void;
  onSave: (caption: string) => void;
}) {
  if (!image) return null;
  return <CaptionForm key={image.id} image={image} onClose={onClose} onSave={onSave} />;
}

function CaptionForm({
  image,
  onClose,
  onSave,
}: {
  image: ProductImage;
  onClose: () => void;
  onSave: (caption: string) => void;
}) {
  const [caption, setCaption] = useState(image.caption ?? '');

  return (
    <Modal
      open
      onClose={onClose}
      title={t('photo.caption.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => onSave(caption)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        <input
          className="ob-input"
          value={caption}
          placeholder={t('photo.caption.placeholder')}
          onChange={(event) => setCaption(event.target.value)}
        />
        <p className="ob-small" style={{ color: 'var(--fg-secondary)' }}>
          {t('photo.caption.help')}
        </p>
      </div>
    </Modal>
  );
}
