/**
 * The reorderable thumbnail strip inside the product edit drawer
 * (`7-IMAGE-PIPELINE.md` §3.3) — "Set as primary" and reordering are plain
 * list operations that never reopen the editor; only adding a new photo does.
 *
 * Reordering is up/down buttons rather than drag-and-drop. Dropping *files* on
 * the strip is native (`dragover`/`drop` on a div, no library); reordering by
 * drag is not, because it needs pointer-level keyboard parity to stay
 * reachable and the two buttons already give that for free.
 *
 * Adding is a queue, not a single file. People photograph a tile from four
 * angles and pick all four at once; walking them through the editor one at a
 * time is the only part of that which needs a person.
 */

import { useRef, useState } from 'react';
import type { Product, ProductImage } from '@orderbook/shared';
import { MAX_IMAGE_SOURCE_BYTES } from '@orderbook/shared';

import { api } from '../api';
import {
  Button,
  IconButton,
  ImageCropModal,
  Modal,
  ProgressiveImage,
  rem,
  t,
  type CropResult,
} from '@orderbook/ui';

const MAX_MB = Math.round(MAX_IMAGE_SOURCE_BYTES / (1024 * 1024));

export function ProductImages({
  product,
  onChanged,
  onError,
}: {
  product: Product;
  onChanged: (product: Product) => void;
  onError: (message: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  // The arrows swap only among the non-primary photos, so the first movable one
  // is not gallery index 0 whenever a primary is pinned ahead of it. The down
  // arrow needs no equivalent: the primary sorts to the front, so the last
  // gallery entry is always the last non-primary one.
  const firstMovable = images.findIndex((entry) => !entry.isPrimary);

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
      if (!file.type.startsWith('image/')) {
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
      onChanged(await api.uploadProductImage(product.id, file, result));
      advance();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('photo.error.uploadFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function setPrimary(image: ProductImage): Promise<void> {
    setBusy(true);
    try {
      onChanged(await api.updateProductImage(product.id, image.id, { isPrimary: true }));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('photo.error.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function saveCaption(image: ProductImage, caption: string): Promise<void> {
    setEditingCaption(null);
    try {
      onChanged(
        await api.updateProductImage(product.id, image.id, {
          caption: caption.trim() === '' ? null : caption.trim(),
        }),
      );
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('photo.error.updateFailed'));
    }
  }

  async function remove(image: ProductImage): Promise<void> {
    setConfirmRemove(null);
    setBusy(true);
    try {
      onChanged(await api.deleteProductImage(product.id, image.id));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('photo.error.removeFailed'));
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
    [reordered[index], reordered[index + direction]] = [
      reordered[index + direction],
      reordered[index],
    ];

    // The server validates the id list as a *complete* permutation of every
    // image on the product (`imageRepo.imageIdsForProduct`), primary included
    // — it just always displays first regardless of where it sits here.
    const ids = (primary ? [primary, ...reordered] : reordered).map((entry) => entry.id);

    setBusy(true);
    try {
      onChanged(await api.reorderProductImages(product.id, ids));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('photo.error.reorderFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}
      onDragOver={(event) => {
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--s-12)',
          padding: 'var(--s-4)',
          borderRadius: 'var(--r-sm)',
          outline: dropping ? '2px dashed var(--accent)' : 'none',
        }}
      >
        {images.map((image, index) => (
          <div
            key={image.id}
            style={{ width: rem(96), display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}
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
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 2,
              }}
            >
              {image.isPrimary ? (
                <span className="ob-small" style={{ color: 'var(--fg-secondary)' }}>
                  {t('photo.primary')}
                </span>
              ) : (
                <button
                  type="button"
                  className="ob-small"
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                  disabled={busy}
                  onClick={() => void setPrimary(image)}
                >
                  {t('photo.setPrimary')}
                </button>
              )}
              <div style={{ display: 'flex' }}>
                {!image.isPrimary && (
                  <>
                    <IconButton
                      icon="chevron-up"
                      label={t('photo.moveEarlier')}
                      size={14}
                      disabled={busy || index === firstMovable}
                      onClick={() => void move(image, -1)}
                    />
                    <IconButton
                      icon="chevron-down"
                      label={t('photo.moveLater')}
                      size={14}
                      disabled={busy || index === images.length - 1}
                      onClick={() => void move(image, 1)}
                    />
                  </>
                )}
                {/* The caption is the alt text every one of these thumbnails
                    falls back to the product name for. The endpoint has always
                    existed; until now nothing could reach it. */}
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
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          style={{
            width: rem(96),
            aspectRatio: '1 / 1',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px dashed var(--border-default, #ccc)',
            borderRadius: 'var(--r-sm, 4px)',
            background: 'none',
            cursor: 'pointer',
            color: 'var(--fg-secondary)',
          }}
        >
          {dropping ? t('photo.dropHint') : t('photo.add')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={onFilePicked}
        />
      </div>

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
            <Button
              variant="danger"
              onClick={() => confirmRemove && void remove(confirmRemove)}
            >
              {t('photo.remove')}
            </Button>
          </>
        }
      >
        <p className="ob-small">{t('photo.removeConfirm.body')}</p>
      </Modal>
    </div>
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
  return (
    <CaptionForm key={image.id} image={image} onClose={onClose} onSave={onSave} />
  );
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
