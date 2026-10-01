import { ApiError, api } from '../api';
import { t } from '@orderbook/ui';

/** Why a catalogue export failed, in the reader's language - Master off is not a bare error. */
export function exportFailureText(caught: unknown): string {
  return caught instanceof ApiError && caught.code === 'unavailable'
    ? t('import.offline')
    : t('catalog.export.failed');
}

/** Download the catalogue as a CSV: `sub` = every sub product, `main` = the main products. */
export async function exportCatalogueCsv(level: 'sub' | 'main'): Promise<void> {
  const { blob, fileName } = await api.exportProducts('csv', level);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
