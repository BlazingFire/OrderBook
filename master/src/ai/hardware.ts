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
import type { AiHardware, AiHardwareTier, RecommendedModel } from '@orderbook/shared';

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

/**
 * Which local models are worth listing on a machine with this much RAM.
 *
 * **The gate is not the fit.** A tier here decides whether a model is worth
 * *showing*; whether it will actually run well on the machine in front of you is
 * `modelFit` in `ui/src/AiSupportScreen.tsx`, which compares `ramRequiredGb`
 * against 40% and 60% of total RAM and badges each row accordingly. Keeping the
 * two apart is deliberate: an 8 GB shop PC should see the 3B model marked
 * honestly as marginal, not be shown an empty table.
 *
 * The previous version of this comment claimed each tier "assumes ~40% of RAM is
 * available for the model", which was true of none of them — the 8 GB tier
 * listed a model wanting 4 GB (50%), the 24 GB tier one wanting 12 GB (50%), and
 * the 32 GB tier one wanting 24 GB (75%).
 *
 * **No install commands.** Every entry used to carry `ollama run <model>`, which
 * is a download. This product runs offline on a LAN with no internet route, so
 * an instruction that only works on a machine that has one is worse than no
 * instruction: it reads as the supported path and fails in the shop. Getting a
 * model onto a Master is a job for whoever set the machine up, and it happens
 * before the software is ever opened.
 *
 * **Real models only.** `llama-3.1-13b` and `llama-3.1-34b` were listed with
 * pull commands. Neither exists — Llama 3.1 shipped 8B, 70B and 405B — so both
 * commands failed for anyone who tried them.
 */
function recommendModels(totalMemoryGb: number, hasUnifiedMemory: boolean): RecommendedModel[] {
  const models: RecommendedModel[] = [];

  if (totalMemoryGb >= 8) {
    models.push({
      name: 'llama-3.2-3b',
      sizeLabel: '3B Q4_K_M (~2.4 GB)',
      ramRequiredGb: 4,
      provider: 'ollama',
    });
  }

  if (totalMemoryGb >= 16) {
    models.push(
      {
        name: 'llama-3.1-8b',
        sizeLabel: '8B Q4_K_M (~4.7 GB)',
        ramRequiredGb: 8,
        provider: 'ollama',
      },
      {
        name: 'qwen-2.5-7b',
        sizeLabel: '7B Q4_K_M (~4.4 GB)',
        ramRequiredGb: 7,
        provider: 'ollama',
      },
    );
  }

  if (totalMemoryGb >= 24) {
    models.push({
      name: 'qwen-2.5-14b',
      sizeLabel: '14B Q4_K_M (~8.5 GB)',
      ramRequiredGb: 10,
      provider: 'ollama',
    });
  }

  if (totalMemoryGb >= 48) {
    models.push({
      name: 'qwen-2.5-32b',
      sizeLabel: '32B Q4_K_M (~19 GB)',
      ramRequiredGb: 24,
      provider: 'ollama',
    });
  }

  // On Apple Silicon the GPU shares the same RAM pool, so a model of a given
  // size is usable on less total memory than it would be elsewhere.
  if (hasUnifiedMemory && totalMemoryGb >= 16) {
    models.push({
      name: 'qwen-2.5-14b-metal',
      sizeLabel: '14B Q4_K_M (~8.5 GB, Metal accelerated)',
      ramRequiredGb: 10,
      provider: 'lm-studio',
    });
  }

  return models;
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
  const availableMemoryGb = Math.round((os.freemem() / GB) * 10) / 10;
  const isDarwin = process.platform === 'darwin';
  const hasUnifiedMemory = isDarwin && process.arch === 'arm64';

  cached = {
    totalMemoryGb,
    availableMemoryGb,
    cpus: os.availableParallelism?.() ?? os.cpus().length,
    tier: tierFor(totalMemoryGb),
    platform: process.platform,
    hasUnifiedMemory,
    recommendedModels: recommendModels(totalMemoryGb, hasUnifiedMemory),
  };

  return cached;
}

/** Test seam. */
export function resetHardwareFacts(): void {
  cached = null;
}
