/**
 * The older names for the mark, kept so existing callers compile: `Logo` is
 * `Mark` (`Mark.tsx`), and `LogoLockup` the compact in-app lockup — mark 24,
 * gap 8 (the Main artboard).
 */

import { Mark } from './Mark.js';

export function Logo({ size = 24, color }: { size?: number; color?: string }) {
  return <Mark size={size} {...(color ? { ink: color } : {})} />;
}

/** Mark + wordmark lockup; the mark sits 8 px left of the wordmark. */
export function LogoLockup({ markSize = 24 }: { markSize?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-8)' }}>
      <Mark size={markSize} />
      <span className="ob-sidebar-wordmark">OrderBook</span>
    </span>
  );
}
