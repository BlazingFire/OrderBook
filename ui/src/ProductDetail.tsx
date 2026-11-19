/**
 * ProductDetail — the sub product screen in its read-only state.
 *
 * A thin name over `ProductRecordScreen`: opening a row shows the record, and
 * the Edit action switches that same screen into its form rather than opening
 * a second layout. Photos, print side, default packaging, the facts and the
 * Danger zone all come from the shared screen, so the view and the form cannot
 * drift apart.
 *
 * Every figure reads straight off the already-flowing `Product`, through
 * `catalogueSummary.ts`, so a code or a weight reads the same here as it does
 * in the list row.
 *
 * **There is no stock on this screen**, and none anywhere in OrderBook.
 */

import type { Product } from '@orderbook/shared';

import type { CatalogueTransport } from './catalogueSummary.js';
import { ProductColours, ProductRecordScreen } from './ProductRecordScreen.js';

/** A sub product's colour for a list cell — the record's rule, in one line. */
export function SubProductColour({
  product,
  colourHex,
}: {
  product: Product;
  colourHex: (colour: string) => string | undefined;
}) {
  return <ProductColours product={product} colourHex={colourHex} />;
}

export function ProductDetail({
  product,
  colourHex,
  transport,
  canEdit,
  onEdit,
  onDelete,
  onPhotosChanged,
  onError,
}: {
  product: Product;
  transport: CatalogueTransport;
  /** Holds `products.edit`: the Edit button and the photo controls. */
  canEdit: boolean;
  /** The `stock.colour` swatches (`useColourHex`), for the Colour field. */
  colourHex: (colour: string) => string | undefined;
  onEdit: () => void;
  /** `products.delete`: the Danger zone card; absent without it. */
  onDelete?: () => void;
  /**
   * A photo write came back with the whole product. The snapshot catches up on
   * its own, but not before the next frame, and a cover photo that keeps the
   * old thumbnail for a second reads as a failed upload.
   */
  onPhotosChanged: (product: Product) => void;
  onError: (message: string) => void;
}) {
  return (
    <ProductRecordScreen
      product={product}
      transport={transport}
      colourHex={colourHex}
      canEdit={canEdit}
      mode="view"
      onEdit={onEdit}
      onDelete={onDelete}
      onPhotosChanged={onPhotosChanged}
      onError={onError}
    />
  );
}
