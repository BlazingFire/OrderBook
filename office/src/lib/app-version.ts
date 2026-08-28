/**
 * This build's version, from the package that ships it.
 *
 * The Master has had `master/src/lib/app-version.ts` since the Updates screen
 * was added; this side grew two private copies of the same seven lines instead
 * — one in `panel-report.service.ts`, one in `backup-export.service.ts`. Two
 * copies of a version reader is the shape of defect the Master's own header
 * warns about: the version a panel *reports* and the version it *stamps on a
 * backup* could drift, and a version that lies is worse than no version at all
 * on a screen whose whole job is telling an administrator which machines are
 * behind.
 *
 * Read once and cached: it cannot change while the process is alive, and the
 * panel reports it every five minutes.
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
