/**
 * ProductEditScreen — the sub product edit route's body.
 *
 * The same screen as `ProductDetail`, in its form state: `ProductRecordScreen`
 * renders the rail (photos, print side, default packaging) and the record
 * fields, and owns the draft, validation and the `updateProduct` write. Editing
 * from the record screen itself does not come through here — that screen
 * switches modes in place — but a host that routes to an edit URL (the Master's
 * Products page, the Office's) mounts this inside its `EditorScreen`.
 */

import type {
  OptionListItem,
  Product,
  ProductCategory,
} from '@orderbook/shared';

import type { CatalogueTransport } from './catalogueSummary.js';
import { useColourHex } from './DataDisplay.js';
import { ProductRecordScreen } from './ProductRecordScreen.js';

export interface ProductEditScreenProps {
  product: Product;
  categories: ProductCategory[];
  optionLists: OptionListItem[];
  transport: CatalogueTransport;
  /** The snapshot clocks for an offline-capable panel, so the merge can tell a sequential edit from a clash. */
  baseFieldHlc?: Record<string, string>;
  onSaved: (name: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
  /** `products.delete`: the Danger zone card, when the host also allows deleting. */
  onDelete?: () => void;
}

export function ProductEditScreen({
  product,
  categories,
  optionLists,
  transport,
  baseFieldHlc,
  onSaved,
  onCancel,
  onError,
  onDelete,
}: ProductEditScreenProps) {
  const colourHex = useColourHex(optionLists);
  return (
    <ProductRecordScreen
      product={product}
      categories={categories}
      optionLists={optionLists}
      transport={transport}
      colourHex={colourHex}
      canEdit
      mode="edit"
      baseFieldHlc={baseFieldHlc}
      onSaved={onSaved}
      onCancel={onCancel}
      onError={onError}
      onDelete={onDelete}
      onPhotosChanged={() => undefined}
    />
  );
}
