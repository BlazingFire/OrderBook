import { api } from '../api';

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
