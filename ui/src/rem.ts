/**
 * A pixel measurement, expressed relative to the scale.
 *
 * The whole interface resizes from `--root-size`, which only works while
 * lengths are rem. A raw number in a JSX `style` object is a px that silently
 * stops scaling — it does not fail a build or a render, it just looks wrong on
 * a 4K screen and nobody knows why. `master/tests/ui-conventions.test.ts`
 * fails on one.
 *
 * 14 is the design's base root size, so `rem(32)` is the same 32px it always
 * was at 100% and grows from there.
 */
export const rem = (px: number): string => `${+(px / 14).toFixed(4)}rem`;
