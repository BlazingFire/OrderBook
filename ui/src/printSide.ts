/**
 * The three print-side settings, as a control offers them and as a cell reads
 * one back (`docs/catalogue/CATALOGUE_MODEL.md` §2).
 *
 * One definition because four places draw the same control — the product form,
 * the product drawer, and the sub-product lists on both panels — and a fourth
 * spelling of "Default / Left / Right" is how the panels start to differ.
 */

import type { PrintSideSetting } from '@orderbook/shared';

import { t } from './i18n.js';

/** The segments of the control, in the order it shows them. */
export function printSideOptions(): Array<{ value: PrintSideSetting; label: string }> {
  return [
    { value: 'default', label: t('product.printSide.default') },
    { value: 'left', label: t('product.printSide.left') },
    { value: 'right', label: t('product.printSide.right') },
  ];
}

/** The one setting as its label, for a reader who may not edit. */
export function printSideLabel(setting: PrintSideSetting): string {
  return t(
    setting === 'left'
      ? 'product.printSide.left'
      : setting === 'right'
        ? 'product.printSide.right'
        : 'product.printSide.default',
  );
}
