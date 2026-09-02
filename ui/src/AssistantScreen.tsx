/**
 * The assistant, written once for both panels.
 *
 * The two panels differ only in how a token reaches the browser — the Master
 * has a Socket.IO connection open, an Office browser has an SSE stream — so
 * that difference is a function each panel passes in, and everything else here
 * is shared. Before Stage 3 this would have been two files that drifted.
 *
 * **Untrusted output renders as plain text.** No markdown, no HTML, no
 * auto-linkification: the answer is partly composed from a party's notes, which
 * are attacker-controllable, and a link somebody else's text talked the model
 * into producing is the one thing a text node cannot become.
 *
 * Every answer says what it looked at. The provenance footer is not decoration:
 * a generated sentence that cannot be checked is one people either over-trust
 * or stop reading, and both are worse than a short answer with its working
 * shown.
 */

import { useEffect, useRef, useState } from 'react';
import type { AiRun, AiStartInput, AiStatus, AiStreamEvent, AiToolCall } from '@orderbook/shared';

import { Button } from './Button';
import { Card } from './Card';
import { EmptyState } from './States';
import { Textarea } from './Form';
import { t } from './i18n';

/** Where a panel's live channel delivers its assistant events. */
type Handler = (event: AiStreamEvent & { runId: string }) => void;

const handlers = new Set<Handler>();

/** Called by each panel's own channel — the socket on the Master, SSE on Office. */
export function publishAiEvent(event: AiStreamEvent & { runId: string }): void {
  for (const handler of handlers) handler(event);
}

export function subscribeAiEvents(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export interface AssistantTransport {
  status: () => Promise<AiStatus>;
  listRuns: () => Promise<AiRun[]>;
  ask: (input: AiStartInput) => Promise<{ runId: string }>;
  cancel: (runId: string) => Promise<void>;
}

export function AssistantScreen({ transport }: { transport: AssistantTransport }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [runs, setRuns] = useState<AiRun[]>([]);
  const [prompt, setPrompt] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  /** What has streamed in so far. Replaced by the stored run when it finishes. */
  const [streaming, setStreaming] = useState('');
  const [steps, setSteps] = useState<AiToolCall[]>([]);
  const [error, setError] = useState<string | null>(null);

  /*
   * The transport is held in a ref and loaded exactly once.
   *
   * Every call site passes an object literal, so depending on its identity made
   * this effect run on every render — and each run set state, which caused the
   * next render, which built another literal. That is an unbounded loop that
   * hammers `/api/ai/status` and `/api/ai/runs` for as long as the screen is
   * open. The ref is the same shape `useOverlay` and `useEnterToAdvance` use
   * for a rebuilt-every-render callback, and for the same reason.
   */
  const transportRef = useRef(transport);
  transportRef.current = transport;

  useEffect(() => {
    void transportRef.current
      .status()
      .then(setStatus)
      .catch(() => setStatus({ enabled: false }));
    void transportRef.current
      .listRuns()
      .then(setRuns)
      .catch(() => setRuns([]));
  }, []);

  /*
   * The live channel, held in a ref so the subscription is not re-made on every
   * token. Re-subscribing per render would tear down and rebuild a listener
   * hundreds of times during one answer.
   */
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeRunId;

  useEffect(
    () =>
      subscribeAiEvents((event) => {
        if (event.runId !== activeRef.current) return;

        if (event.type === 'token') setStreaming((current) => current + event.text);
        else if (event.type === 'tool') setSteps((current) => [...current, event.call]);
        else if (event.type === 'error') {
          setError(event.code);
          setActiveRunId(null);
        } else {
          setRuns((current) => [event.run, ...current.filter((run) => run.id !== event.run.id)]);
          setActiveRunId(null);
          setStreaming('');
          setSteps([]);
        }
      }),
    [],
  );

  async function ask(): Promise<void> {
    const question = prompt.trim();
    if (!question) return;

    setError(null);
    setStreaming('');
    setSteps([]);

    try {
      const { runId } = await transportRef.current.ask({ kind: 'ask', prompt: question });
      setActiveRunId(runId);
      setPrompt('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error.ai.failed'));
    }
  }

  if (status && !status.enabled) {
    return (
      <div className="ob-pane">
        <EmptyState title={t('ai.off.title')} description={t('ai.off.hint')} />
      </div>
    );
  }

  return (
    <div className="ob-pane">
      <Card>
        <div className="ob-eyebrow">{t('ai.title')}</div>
        <p className="ob-small">{t('ai.help')}</p>

        {status?.hardware && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)', marginTop: 'var(--s-8)' }}>
            <HardwareInfo hardware={status.hardware} />
          </div>
        )}

        {status?.budget !== undefined && (
          <p className="ob-small">
            {t('ai.budget', { spent: status.spentToday ?? 0, budget: status.budget })}
          </p>
        )}

        <Textarea
          rows={3}
          value={prompt}
          placeholder={t('ai.placeholder')}
          onChange={(event) => setPrompt(event.target.value)}
        />

        <div style={{ display: 'flex', gap: 'var(--s-8)', marginTop: 'var(--s-8)' }}>
          <span style={{ flex: 1 }} />
          {activeRunId && (
            <Button
              variant="secondary"
              onClick={() => {
                void transportRef.current.cancel(activeRunId).catch(() => undefined);
                setActiveRunId(null);
              }}
            >
              {t('ai.stop')}
            </Button>
          )}
          <Button variant="primary" disabled={Boolean(activeRunId)} onClick={() => void ask()}>
            {t('ai.ask')}
          </Button>
        </div>

        {error && <p className="ob-small">{t(error)}</p>}
      </Card>

      {(activeRunId || streaming) && (
        <Card>
          {/* One text node, appended to. `aria-live="polite"` so a screen
              reader hears the answer once it settles rather than per token. */}
          <p className="ob-ai-stream" aria-live="polite">
            {streaming || t('ai.thinking')}
          </p>
          <Provenance steps={steps} />
        </Card>
      )}

      {runs.length === 0 && !activeRunId ? (
        <EmptyState title={t('ai.empty')} />
      ) : (
        runs.map((run) => (
          <Card key={run.id}>
            <div className="ob-eyebrow">{run.prompt}</div>
            {/* Plain text, deliberately: this sentence is partly composed from
                text somebody outside this company could have written. */}
            <p className="ob-ai-stream">{run.answer ?? t(run.errorCode ?? 'ai.noAnswer')}</p>
            <Provenance steps={run.toolTrace} />
          </Card>
        ))
      )}
    </div>
  );
}

type AiHardwareInfo = AiStatus['hardware'];

/** Compact hardware summary for the assistant card. */
function HardwareInfo({ hardware }: { hardware: NonNullable<AiHardwareInfo> }) {
  const tierColors: Record<string, string> = {
    supported: 'var(--state-ok)',
    marginal: 'var(--state-offline)',
    unsupported: 'var(--state-conflict)',
  };
  const tierColor = tierColors[hardware.tier] ?? 'var(--fg-tertiary)';

  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--s-12)', alignItems: 'center' }}>
        <span className="ob-mono ob-small">{hardware.totalMemoryGb} GB RAM</span>
        <span className="ob-mono ob-small">{hardware.cpus} CPUs</span>
        {hardware.platform && (
          <span className="ob-small">
            {hardware.platform === 'darwin' ? 'macOS' : hardware.platform === 'win32' ? 'Windows' : hardware.platform}
          </span>
        )}
        {hardware.hasUnifiedMemory && (
          <span className="ob-micro" style={{ color: 'var(--state-ok)' }}>
            Apple Silicon
          </span>
        )}
      </div>

      {hardware.tier === 'marginal' && (
        <p className="ob-small" style={{ color: tierColor }}>
          {t('ai.hardware.marginal', { gb: hardware.totalMemoryGb })}
        </p>
      )}
      {hardware.tier === 'unsupported' && (
        <p className="ob-small" style={{ color: tierColor }}>
          {t('ai.hardware.unsupported', { gb: hardware.totalMemoryGb })}
        </p>
      )}

      {hardware.recommendedModels.length > 0 && (
        <div style={{ marginTop: 'var(--s-4)' }}>
          <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
            Recommended: {hardware.recommendedModels.slice(0, 3).map((m) => m.name).join(', ')}
          </span>
        </div>
      )}
    </>
  );
}

/** What the answer was built from — names and row counts, never the rows. */
function Provenance({ steps }: { steps: AiToolCall[] }) {
  if (steps.length === 0) return null;

  return (
    <details className="ob-ai-provenance">
      <summary className="ob-small">{t('ai.provenance', { count: steps.length })}</summary>
      <ul className="ob-small">
        {steps.map((step, index) => (
          <li key={`${step.tool}-${index}`}>
            {t('ai.provenance.step', { tool: step.tool, rows: step.resultCount })}
          </li>
        ))}
      </ul>
    </details>
  );
}
