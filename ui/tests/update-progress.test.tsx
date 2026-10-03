/**
 * The update download bar (`UpdateProgress.tsx`, 1.4 R7a): bytes done, total
 * size, speed and time left while downloading, and nothing when idle.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { UpdateDownloadProgress } from '@orderbook/shared';

import { t, UpdateProgress } from '../src/index.js';

afterEach(cleanup);

const base: UpdateDownloadProgress = {
  phase: 'downloading',
  version: '1.3.0',
  receivedBytes: 30 * 1024 * 1024,
  totalBytes: 150 * 1024 * 1024,
  percent: 20,
  bytesPerSecond: 3 * 1024 * 1024,
  etaSeconds: 40,
  error: null,
};

describe('UpdateProgress', () => {
  it('shows size done of total, speed and time left, with a bar at the percentage', () => {
    render(<UpdateProgress progress={base} />);

    expect(screen.getByText(t('updates.progress.downloading', { version: '1.3.0' }))).toBeTruthy();
    expect(screen.getByTestId('update-progress-figures').textContent).toBe(
      '30.0 MB of 150 MB · 3.00 MB/s · 40 s left',
    );
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('20');
  });

  it('shows nothing while idle', () => {
    const { container } = render(<UpdateProgress progress={{ ...base, phase: 'idle' }} />);
    expect(container.textContent).toBe('');
  });

  it('says the file is being checked, without speed figures', () => {
    render(<UpdateProgress progress={{ ...base, phase: 'verifying', receivedBytes: base.totalBytes, percent: 100 }} />);
    expect(screen.getByText(t('updates.progress.verifying'))).toBeTruthy();
    expect(screen.queryByTestId('update-progress-figures')).toBeNull();
  });

  it('says why a download failed', () => {
    render(<UpdateProgress progress={{ ...base, phase: 'failed', error: 'nothing arrived for 60 s' }} />);
    expect(screen.getByRole('alert').textContent).toBe(
      t('updates.progress.failed', { error: 'nothing arrived for 60 s' }),
    );
  });
});
