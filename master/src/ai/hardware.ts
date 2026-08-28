/**
 * What this machine can honestly run.
 *
 * A shop PC is not a workstation. A 7B model quantised to Q4_K_M is about
 * 4.7 GB of weights before any context, so a machine with 8 GB total is going
 * to swap, and swapping looks to the person using it like the app has hung.
 * Saying so beforehand — with the real number — is the whole point of this
 * file.
 *
 * Warned, not blocked. The tier gates nothing except the advice: a cloud
 * provider works fine on any of these machines, and somebody who knows their
 * hardware better than this heuristic does should not be argued with.
 *
 * `tierFor` is pure so it can be tested at every boundary; the probe around it
 * is cached at boot and never blocks a request.
 */

import os from 'node:os';
import type { AiHardware, AiHardwareTier } from '@orderbook/shared';

const GB = 1024 ** 3;

/** Below this a local model certainly swaps. */
const UNSUPPORTED_GB = 8;
/** Below this it fits, slowly, with nothing else running. */
const MARGINAL_GB = 16;

export function tierFor(totalMemoryGb: number): AiHardwareTier {
  if (totalMemoryGb < UNSUPPORTED_GB) return 'unsupported';
  if (totalMemoryGb < MARGINAL_GB) return 'marginal';
  return 'supported';
}

let cached: AiHardware | null = null;

/**
 * Read once, at first ask.
 *
 * `os.totalmem()` reports Apple Silicon's unified memory correctly, which is
 * the case that would otherwise need a special path — there the same pool is
 * the GPU's, so the plain number is the true one.
 */
export function hardwareFacts(): AiHardware {
  if (cached) return cached;

  const totalMemoryGb = Math.round((os.totalmem() / GB) * 10) / 10;
  cached = {
    totalMemoryGb,
    cpus: os.availableParallelism?.() ?? os.cpus().length,
    tier: tierFor(totalMemoryGb),
  };

  return cached;
}

/** Test seam. */
export function resetHardwareFacts(): void {
  cached = null;
}
