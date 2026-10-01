/**
 * The columns the offline merge may write on the Master.
 *
 * `@orderbook/shared`'s `MERGEABLE_COLUMNS` leaves `categoryId` off a product
 * because a merge has no service in front of it to resolve a category. The
 * Master closes that gap itself — `mergeUpdate` checks the id names a live
 * category before writing it — so the field clock can decide a category move
 * like any other field. Shared stays as it is: the Office never reads this map.
 */

import { MERGEABLE_COLUMNS, PRODUCT_COLUMNS } from '@orderbook/shared';

export const MASTER_MERGE_COLUMNS = { ...MERGEABLE_COLUMNS, product: PRODUCT_COLUMNS } as const;
