/**
 * Local AI support screen — hardware detection, software options, model
 * recommendations, and setup instructions.
 *
 * Shows only on the Master panel, where AI runs. The Office panel has no
 * database and no AI subsystem, so this screen has nothing to show there.
 */

import { useEffect, useRef, useState } from 'react';
import type { AiHardware, AiStatus, RecommendedModel } from '@orderbook/shared';

import { Card } from './Card';
import { t } from './i18n';

const PLATFORM_LABELS: Record<string, string> = {
  darwin: t('ai.support.platform.darwin'),
  win32: t('ai.support.platform.win32'),
  linux: t('ai.support.platform.linux'),
};

function modelFit(model: RecommendedModel, totalMemoryGb: number): 'fits' | 'marginal' | 'tooLarge' {
  if (model.ramRequiredGb <= totalMemoryGb * 0.4) return 'fits';
  if (model.ramRequiredGb <= totalMemoryGb * 0.6) return 'marginal';
  return 'tooLarge';
}

function FitBadge({ fit }: { fit: 'fits' | 'marginal' | 'tooLarge' }) {
  const colors = {
    fits: 'var(--state-ok)',
    marginal: 'var(--state-offline)',
    tooLarge: 'var(--state-conflict)',
  };
  const labels = {
    fits: t('ai.support.model.fits'),
    marginal: t('ai.support.model.marginal'),
    tooLarge: t('ai.support.model.tooLarge'),
  };

  return (
    <span
      className="ob-micro"
      style={{ color: colors[fit], fontWeight: 550 }}
    >
      {labels[fit]}
    </span>
  );
}

export interface AiSupportTransport {
  status: () => Promise<AiStatus>;
}

export function AiSupportScreen({ transport }: { transport: AiSupportTransport }) {
  const [status, setStatus] = useState<AiStatus | null>(null);

  // The transport is held in a ref and loaded exactly once.
  // Every call site passes an object literal, so depending on its identity made
  // this effect run on every render — and each run set state, which caused the
  // next render, which built another literal. That is an unbounded loop that
  // hammers the status endpoint for as long as the screen is open.
  const transportRef = useRef(transport);
  transportRef.current = transport;

  useEffect(() => {
    void transportRef.current.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  const hw = status?.hardware;

  return (
    <div className="ob-pane" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <Card>
        <div className="ob-eyebrow">{t('ai.support.title')}</div>
        <p className="ob-small">{t('ai.support.subtitle')}</p>
      </Card>

      {hw && <HardwareCard hardware={hw} />}

      <SoftwareCard />

      {hw && <ModelsCard hardware={hw} />}

      <SetupCard />

      {status && <StatusCard status={status} />}
    </div>
  );
}

function HardwareCard({ hardware }: { hardware: AiHardware }) {
  return (
    <Card>
      <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
        {t('ai.support.hardware')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        {/* Four of these fields arrive only from a 1.0.3-or-newer Master. A
            panel talking to an older one gets `undefined`, and a row reading
            "undefined GB" is worse than no row — so an absent field is an
            absent row, the same rule the document model applies to a value the
            reader may not see. */}
        <Row
          label={t('ai.support.totalRam')}
          value={t('ai.support.gb', { gb: hardware.totalMemoryGb })}
        />
        {hardware.availableMemoryGb !== undefined && (
          <Row
            label={t('ai.support.availableRam')}
            value={t('ai.support.gb', { gb: hardware.availableMemoryGb })}
          />
        )}
        <Row label={t('ai.support.cpus')} value={String(hardware.cpus)} />
        {hardware.platform !== undefined && (
          <Row
            label={t('ai.support.platform')}
            value={PLATFORM_LABELS[hardware.platform] ?? hardware.platform}
          />
        )}
        {hardware.hasUnifiedMemory && (
          <div
            className="ob-micro"
            style={{
              marginTop: 'var(--s-4)',
              padding: 'var(--s-4) var(--s-8)',
              borderRadius: 'var(--r-sm)',
              background: 'var(--state-ok-tint)',
              color: 'var(--state-ok)',
            }}
          >
            {t('ai.support.unifiedMemory')}
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * The two local runners, named — not linked.
 *
 * This card used to carry `https://ollama.com` and `https://lmstudio.ai` as
 * `target="_blank"` links, plus a `curl -fsSL … | sh` install line. The product
 * runs offline on a LAN with no internet route, so all three were dead on the
 * machine they were shown on. A link that cannot resolve is worse than a plain
 * name: it tells the reader the software is one click away.
 */
function SoftwareCard() {
  return (
    <Card>
      <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
        {t('ai.support.software')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
        <div>
          <div className="ob-body-strong">{t('ai.support.ollama.title')}</div>
          <p className="ob-small">{t('ai.support.ollama.desc')}</p>
          <p className="ob-small" style={{ color: 'var(--fg-secondary)' }}>
            {t('ai.support.ollama.download')}
          </p>
        </div>
        <div>
          <div className="ob-body-strong">{t('ai.support.lmstudio.title')}</div>
          <p className="ob-small">{t('ai.support.lmstudio.desc')}</p>
          <p className="ob-small" style={{ color: 'var(--fg-secondary)' }}>
            {t('ai.support.lmstudio.download')}
          </p>
        </div>
      </div>
    </Card>
  );
}

function ModelsCard({ hardware }: { hardware: AiHardware }) {
  // Narrowed once, so the table below reads a plain array rather than repeating
  // a `?.` the next edit can drop. An older Master sends no list at all.
  const models = hardware.recommendedModels ?? [];
  if (models.length === 0) return null;

  return (
    <Card>
      <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-4)' }}>
        {t('ai.support.models')}
      </div>
      <p className="ob-small" style={{ marginBottom: 'var(--s-8)' }}>
        {t('ai.support.models.note')}
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th className="ob-small" style={{ textAlign: 'left', padding: 'var(--s-4)' }}>
                {t('ai.support.model.name')}
              </th>
              <th className="ob-small" style={{ textAlign: 'left', padding: 'var(--s-4)' }}>
                {t('ai.support.model.size')}
              </th>
              <th className="ob-small" style={{ textAlign: 'left', padding: 'var(--s-4)' }}>
                {t('ai.support.model.ram')}
              </th>
              <th className="ob-small" style={{ textAlign: 'left', padding: 'var(--s-4)' }}>
                {t('ai.support.model.provider')}
              </th>
              <th className="ob-small" style={{ textAlign: 'left', padding: 'var(--s-4)' }} />
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <tr key={model.name} style={{ borderTop: '1px solid var(--line)' }}>
                <td className="ob-small" style={{ padding: 'var(--s-4)' }}>{model.name}</td>
                <td className="ob-small" style={{ padding: 'var(--s-4)' }}>{model.sizeLabel}</td>
                <td className="ob-small" style={{ padding: 'var(--s-4)' }}>
                  {t('ai.support.gb', { gb: model.ramRequiredGb })}
                </td>
                <td className="ob-small" style={{ padding: 'var(--s-4)' }}>{model.provider}</td>
                <td style={{ padding: 'var(--s-4)' }}>
                  <FitBadge fit={modelFit(model, hardware.totalMemoryGb)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SetupCard() {
  return (
    <Card>
      <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
        {t('ai.support.setup')}
      </div>
      <ol className="ob-small" style={{ paddingLeft: 'var(--s-16)', display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        <li>{t('ai.support.setup.step1')}</li>
        <li>{t('ai.support.setup.step2')}</li>
        <li>{t('ai.support.setup.step3')}</li>
      </ol>
    </Card>
  );
}

function StatusCard({ status }: { status: AiStatus }) {
  const reachable = status.enabled && status.local;

  return (
    <Card>
      <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
        {t('ai.support.status')}
      </div>
      <div
        className="ob-small"
        style={{
          padding: 'var(--s-4) var(--s-8)',
          borderRadius: 'var(--r-sm)',
          background: reachable ? 'var(--state-ok-tint)' : 'var(--state-conflict-tint)',
          color: reachable ? 'var(--state-ok)' : 'var(--state-conflict)',
        }}
      >
        {reachable
          ? t('ai.support.status.reachable')
          : t('ai.support.status.unreachable')}
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span className="ob-small">{label}</span>
      <span className="ob-mono ob-small">{value}</span>
    </div>
  );
}
