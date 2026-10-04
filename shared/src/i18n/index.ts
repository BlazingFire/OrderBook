/**
 * The i18n subsystem's own barrel, nested rather than flattened into
 * `shared/src/index.ts`, where its files would otherwise bury the lines that
 * describe the rest of the product's public surface.
 */

export * from './activity.js';
export * from './en.js';
export * from './errors.js';
export * from './keys.js';
export * from './locales.js';
export * from './panel-scoped.js';
export * from './translate.js';
