/**
 * The reorderable thumbnail strip inside the product edit drawer
 * (`7-IMAGE-PIPELINE.md` §3.3) — "Set as primary" and reordering are plain
 * list operations that never reopen the editor; only adding a new photo does.
 *
 * Reordering is up/down buttons rather than drag-and-drop: this app has no
 * drag-and-drop anywhere yet and pulling in a library for one screen would be
 * exactly the "runtime dependency for one thing" this codebase avoids
 * elsewhere (§10 of the spec makes the same call for the editor itself).
 * Worth revisiting once a design pass exists to react against — see the
 * frontend summary handed to Claude Design.
 */

import { useRef, useState } from 'react';
import type { Product, ProductImage } from '@orderbook/shared';

import { api } from '../api';
import { ImageCropModal, type CropResult } from '../ui/ImageCropModal';
import { ProgressiveImage } from '../ui/ProgressiveImage';
import { IconButton } from '../ui/Button';

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
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const images = [...product.images].sort((a, b) => (a.isPrimary === b.isPrimary ? a.sequence - b.sequence : a.isPrimary ? -1 : 1));

  // The arrows swap only among the non-primary photos, so the first movable one
  // is not gallery index 0 whenever a primary is pinned ahead of it. The down
  // arrow needs no equivalent: the primary sorts to the front, so the last
  // gallery entry is always the last non-primary one.
  const firstMovable = images.findIndex((entry) => !entry.isPrimary);

  function onFilePicked(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      onError('Choose an image file');
      return;
    }
    setPendingFile(file);
  }

  async function onCropSave(result: CropResult): Promise<void> {
    if (!pendingFile) return;
    setBusy(true);
    try {
      const updated = await api.uploadProductImage(product.id, pendingFile, result);
      onChanged(updated);
      setPendingFile(null);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not save the image');
    } finally {
      setBusy(false);
    }
  }

  async function setPrimary(image: ProductImage): Promise<void> {
    try {
      onChanged(await api.updateProductImage(product.id, image.id, { isPrimary: true }));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not update the image');
    }
  }

  async function remove(image: ProductImage): Promise<void> {
    try {
      onChanged(await api.deleteProductImage(product.id, image.id));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not remove the image');
    }
  }

  async function move(image: ProductImage, direction: -1 | 1): Promise<void> {
    const primary = images.find((entry) => entry.isPrimary) ?? null;
    const nonPrimary = images.filter((entry) => !entry.isPrimary);
    const index = nonPrimary.findIndex((entry) => entry.id === image.id);
    const swapWith = nonPrimary[index + direction];
    if (!swapWith) return;

    const reordered = [...nonPrimary];
    [reordered[index], reordered[index + direction]] = [reordered[index + direction], reordered[index]];

    // The server validates the id list as a *complete* permutation of every
    // image on the product (`imageRepo.imageIdsForProduct`), primary included
    // — it just always displays first regardless of where it sits here.
    const ids = (primary ? [primary, ...reordered] : reordered).map((entry) => entry.id);

    try {
      onChanged(await api.reorderProductImages(product.id, ids));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not reorder the images');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-12)' }}>
        {images.map((image, index) => (
          <div key={image.id} style={{ width: 96, display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
            <ProgressiveImage
              imageId={image.id}
              variant="thumb"
              blurhash={image.blurhash}
              width={image.width}
              height={image.height}
              alt={image.caption ?? product.name}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
              {image.isPrimary ? (
                <span className="ob-small" style={{ color: 'var(--fg-secondary)' }}>
                  Primary
                </span>
              ) : (
                <button
                  type="button"
                  className="ob-small"
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={() => void setPrimary(image)}
                >
                  Set primary
                </button>
              )}
              <div style={{ display: 'flex' }}>
                {!image.isPrimary && (
                  <>
                    <IconButton
                      icon="chevron-up"
                      label="Move earlier"
                      size={14}
                      disabled={index === firstMovable}
                      onClick={() => void move(image, -1)}
                    />
                    <IconButton
                      icon="chevron-down"
                      label="Move later"
                      size={14}
                      disabled={index === images.length - 1}
                      onClick={() => void move(image, 1)}
                    />
                  </>
                )}
                <IconButton icon="trash" label="Remove image" size={14} onClick={() => void remove(image)} />
              </div>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          style={{
            width: 96,
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
          + Add photo
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onFilePicked} />
      </div>

      <ImageCropModal
        open={pendingFile !== null}
        file={pendingFile}
        busy={busy}
        onCancel={() => setPendingFile(null)}
        onSave={(result) => void onCropSave(result)}
      />
    </div>
  );
}
