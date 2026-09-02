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
 * Recommend models based on total RAM and whether the machine has unified
 * memory (Apple Silicon). Each tier assumes ~40% of RAM is available for the
 * model after the OS, PostgreSQL and the Node process take their share.
 */
function recommendModels(totalMemoryGb: number, hasUnifiedMemory: boolean): RecommendedModel[] {
  const models: RecommendedModel[] = [];

  if (totalMemoryGb >= 8) {
    models.push({
      name: 'llama-3.2-3b',
      sizeLabel: '3B Q4_K_M (~2.4 GB)',
      ramRequiredGb: 4,
      provider: 'ollama',
      command: 'ollama run llama3.2:3b',
    });
  }

  if (totalMemoryGb >= 16) {
    models.push(
      {
        name: 'llama-3.1-8b',
        sizeLabel: '8B Q4_K_M (~4.7 GB)',
        ramRequiredGb: 8,
        provider: 'ollama',
        command: 'ollama run llama3.1:8b',
      },
      {
        name: 'qwen-2.5-7b',
        sizeLabel: '7B Q4_K_M (~4.4 GB)',
        ramRequiredGb: 7,
        provider: 'ollama',
        command: 'ollama run qwen2.5:7b',
      },
    );
  }

  if (totalMemoryGb >= 24) {
    models.push({
      name: 'llama-3.1-13b',
      sizeLabel: '13B Q4_K_M (~7.4 GB)',
      ramRequiredGb: 12,
      provider: 'ollama',
      command: 'ollama run llama3.1:13b',
    });
  }

  if (totalMemoryGb >= 32) {
    models.push({
      name: 'llama-3.1-34b',
      sizeLabel: '34B Q4_K_M (~19 GB)',
      ramRequiredGb: 24,
      provider: 'ollama',
      command: 'ollama run llama3.1:34b',
    });
  }

  // On Apple Silicon, note that Metal acceleration is available — models run
  // faster because the GPU shares the same RAM pool.
  if (hasUnifiedMemory && totalMemoryGb >= 16) {
    models.push({
      name: 'qwen-2.5-14b',
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
