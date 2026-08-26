/**
 * This build's version, from the package that ships it.
 *
 * One source of truth on purpose. The version used to be read here for a backup
 * manifest and typed out again as a literal in the web bundle's footer, which
 * is a pair that drifts the first time one of them is bumped — and a version
 * that lies is worse than no version at all on a screen whose whole job is
 * telling an administrator which machines are behind.
 *
 * Read once and cached: it cannot change while the process is alive, and the
 * update screen asks for it on every poll.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { config } from '../config/index.js';

let cached: string | null = null;

export function appVersion(): string {
  if (cached !== null) return cached;

  try {
    const raw = readFileSync(path.join(config.packageRoot, 'package.json'), 'utf8');
    cached = (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    // A missing or unreadable package.json is a packaging fault, not a reason
    // to refuse to start. `0.0.0` is visibly wrong, which is the point.
    cached = '0.0.0';
  }
  return cached;
}
