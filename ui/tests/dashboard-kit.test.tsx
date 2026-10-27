/**
 * The colourful animated dashboard kit: tiles, animated bars, donut,
 * sparkline and drill-down cards. Click-through everywhere; reduced-motion
 * branches on every animation.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardTile, Donut, DrillCard, Sparkline, StageBars } from '../src/Dashboard.js';

afterEach(cleanup);

describe('DashboardTile', () => {
  it('renders the figure and navigates on click', () => {
    const onClick = vi.fn();
    render(
      <DashboardTile icon="leads" accent="blue" label="Pending" value="42" note="3 due" onClick={onClick} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pending: 42' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders as text when it has nowhere to go', () => {
    render(<DashboardTile icon="sync" label="Sync" value="All synced" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('All synced')).toBeTruthy();
  });
});

describe('Sparkline', () => {
  it('draws one point per value', () => {
    const { container } = render(<Sparkline values={[1, 4, 2, 8]} />);
    const points = container.querySelector('polyline')?.getAttribute('points')?.trim().split(' ') ?? [];
    expect(points).toHaveLength(4);
  });
});

describe('StageBars', () => {
  it('opens the board and selects a stage', () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    render(
      <StageBars
        title="Pipeline"
        stages={[
          { id: 'new', label: 'New', count: 12 },
          { id: 'done', label: 'Done', count: 3 },
        ]}
        onOpen={onOpen}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open board' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'New: 12' }));
    expect(onSelect).toHaveBeenCalledWith('new');
  });
});

describe('Donut', () => {
  it('totals the slices and filters on click', () => {
    const onSelect = vi.fn();
    render(
      <Donut
        title="Today"
        total="10"
        slices={[
          { id: 'a', label: 'Pending', value: 6, color: 'red' },
          { id: 'b', label: 'Done', value: 4, color: 'green' },
        ]}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText('10')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Pending/ }));
    expect(onSelect).toHaveBeenCalledWith('a');
  });
});

describe('DrillCard', () => {
  it('opens the row that was clicked', () => {
    const onOpen = vi.fn();
    render(
      <DrillCard
        title="Follow-ups"
        rows={[{ id: 'L1', title: 'Sharma Tiles', meta: 'New' }]}
        empty={{ title: 'Nothing', description: 'Clear' }}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Sharma Tiles/ }));
    expect(onOpen).toHaveBeenCalledWith('L1');
  });

  it('shows the empty state when there is nothing to drill into', () => {
    render(
      <DrillCard title="Follow-ups" rows={[]} empty={{ title: 'Nothing due', description: 'Clear' }} onOpen={() => undefined} />,
    );
    expect(screen.getByText('Nothing due — Clear')).toBeTruthy();
  });
});
