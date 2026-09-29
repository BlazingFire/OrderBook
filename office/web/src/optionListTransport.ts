/**
 * What the shared `OptionListEditor` is allowed to reach on this panel: the
 * Fields endpoints, which this panel forwards to the Master under the Master's
 * own names, plus `conflictOf`, which reads the stored version and diff off
 * `details` — where this panel's `ApiError` keeps them.
 *
 * One adapter for every Office host of the editor (Products → Brands, and
 * Settings → Leads' sources), in the shape of `partyFormTransport.ts`.
 */

import type { FieldDifference, OptionListTransport } from '@orderbook/ui';

import { ApiError, api } from './api';

export const optionListTransport: OptionListTransport = {
  fieldValues: (listKey) => api.fieldValues(listKey),
  fieldUsage: api.fieldUsage,
  createFieldValue: api.createFieldValue,
  updateFieldValue: api.updateFieldValue,
  deleteFieldValue: api.deleteFieldValue,
  reorderFieldValues: api.reorderFieldValues,
  conflictOf: (error) => {
    if (!(error instanceof ApiError) || !error.isConflict) return null;
    const storedVersion = error.details.storedVersion;
    if (typeof storedVersion !== 'number') return null;
    return {
      message: error.message,
      storedVersion,
      diff: (error.details.diff ?? {}) as Record<string, FieldDifference>,
    };
  },
};
