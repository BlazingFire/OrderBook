/**
 * Local AI support screen — hardware detection, software options, model
 * recommendations, and setup instructions.
 *
 * Shows only on the Master panel, where AI runs. The Office panel has no
 * database and no AI subsystem, so this screen has nothing to show there.
 */

import { useEffect, useState } from 'react';
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

  useEffect(() => {
    void transport.status().then(setStatus).catch(() => setStatus(null));
  }, [transport]);

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
        <Row label={t('ai.support.totalRam')} value={`${hardware.totalMemoryGb} GB`} />
        <Row label={t('ai.support.availableRam')} value={`${hardware.availableMemoryGb} GB`} />
        <Row label={t('ai.support.cpus')} value={String(hardware.cpus)} />
        <Row
          label={t('ai.support.platform')}
          value={PLATFORM_LABELS[hardware.platform] ?? hardware.platform}
        />
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
          <code className="ob-mono ob-small" style={{ display: 'block', marginTop: 'var(--s-4)' }}>
            {t('ai.support.ollama.install')}
          </code>
          <a
            className="ob-small"
            href="https://ollama.com"
            target="_blank"
            rel="noreferrer"
          >
            {t('ai.support.ollama.download')}
          </a>
        </div>
        <div>
          <div className="ob-body-strong">{t('ai.support.lmstudio.title')}</div>
          <p className="ob-small">{t('ai.support.lmstudio.desc')}</p>
          <a
            className="ob-small"
            href="https://lmstudio.ai"
            target="_blank"
            rel="noreferrer"
          >
            {t('ai.support.lmstudio.download')}
          </a>
        </div>
      </div>
    </Card>
  );
}

function ModelsCard({ hardware }: { hardware: AiHardware }) {
  if (hardware.recommendedModels.length === 0) return null;

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
              <th className="ob-small" style={{ textAlign: 'left', padding: 'var(--s-4)' }}>
                {t('ai.support.model.install')}
              </th>
              <th className="ob-small" style={{ textAlign: 'left', padding: 'var(--s-4)' }} />
            </tr>
          </thead>
          <tbody>
            {hardware.recommendedModels.map((model) => (
              <tr key={model.name} style={{ borderTop: '1px solid var(--line)' }}>
                <td className="ob-small" style={{ padding: 'var(--s-4)' }}>{model.name}</td>
                <td className="ob-small" style={{ padding: 'var(--s-4)' }}>{model.sizeLabel}</td>
                <td className="ob-small" style={{ padding: 'var(--s-4)' }}>{model.ramRequiredGb} GB</td>
                <td className="ob-small" style={{ padding: 'var(--s-4)' }}>{model.provider}</td>
                <td className="ob-mono ob-small" style={{ padding: 'var(--s-4)' }}>
                  {model.command ?? '—'}
                </td>
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
        <li>
          {t('ai.support.setup.step2', { command: 'ollama run llama3.1:8b' })}
        </li>
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
