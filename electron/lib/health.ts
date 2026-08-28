/**
 * Reading a panel's `/api/health` and deciding what the window should show.
 *
 * Pure, and deliberately separate from the shell: this is the decision that
 * kept both panels broken, so it is the one that most needs a test. The Office
 * server had no health route at all, so its shell polled a 401 for sixty
 * seconds and then declared a running server dead; the Master's live app
 * answered without a `boot` key, so the shell's failure branch never fired.
 *
 * The rule that matters: **anything we cannot positively read as healthy is
 * "not listening yet"**, never "ready". A shell that guesses optimistically
 * navigates to an error page; one that guesses pessimistically waits, which is
 * what the splash is for.
 */

import type { PanelHealth } from '@orderbook/shared';

export type HealthOutcome =
  | { kind: 'ready'; health: PanelHealth }
  /** Listening and honest about not being finished. Show `step`. */
  | { kind: 'starting'; step: string }
  /** Boot failed and the panel is serving its own explanation. Hand it the window. */
  | { kind: 'failed'; message: string }
  /** No answer, an error status, or a body we cannot parse. Keep waiting. */
  | { kind: 'not-listening' }
  /** Something is on our port, and it is the other panel. Never navigate to it. */
  | { kind: 'wrong-app'; panel: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * @param body   the parsed JSON body, or `null` if the request failed or the
 *               response was not JSON at all (an HTML 404, an empty 401).
 * @param expect which panel this shell is hosting.
 */
export function interpretHealth(body: unknown, expect: 'master' | 'office'): HealthOutcome {
  const root = asRecord(body);
  if (!root) return { kind: 'not-listening' };

  // An error body — `{error:'not_signed_in'}`, `{error:'starting'}` — is not a
  // health report. Before the Office route existed this is exactly what the
  // shell received, and reading it as anything but "keep waiting" is how a
  // 401 became a sixty-second hang.
  if (typeof root.status !== 'string') return { kind: 'not-listening' };

  if (typeof root.panel === 'string' && root.panel !== expect) {
    return { kind: 'wrong-app', panel: root.panel };
  }

  const boot = asRecord(root.boot);
  const state = boot && typeof boot.state === 'string' ? boot.state : null;

  if (state === 'failed') {
    const message = boot && typeof boot.message === 'string' ? boot.message : 'Startup failed.';
    return { kind: 'failed', message };
  }

  if (root.status === 'ok') return { kind: 'ready', health: root as unknown as PanelHealth };

  const step = boot && typeof boot.step === 'string' ? boot.step : 'Starting…';
  return { kind: 'starting', step };
}
