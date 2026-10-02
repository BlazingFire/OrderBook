/**
 * A board column draws at most 60 cards until somebody asks for the rest, and
 * its header still counts the whole column.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { KanbanBoard } from '../src/KanbanBoard.js';
import { t } from '../src/i18n.js';

afterEach(cleanup);

const items = Array.from({ length: 75 }, (_, index) => ({ id: `L${index}`, stageId: 'new' }));

describe('KanbanBoard column cap', () => {
  it('shows sixty cards, then the rest on request', () => {
    render(
      <KanbanBoard
        stages={[{ id: 'new', name: 'New', sequence: 1 }]}
        items={items}
        renderCard={(item) => item.id}
        onMove={() => undefined}
        onOpen={() => undefined}
      />,
    );
    const column = within(screen.getByRole('region', { name: 'New' }));
    expect(column.getAllByText(/^L\d+$/)).toHaveLength(60);
    expect(column.getByText('75')).toBeTruthy();

    fireEvent.click(column.getByRole('button', { name: t('kanban.showMore', { count: 15 }) }));
    expect(column.getAllByText(/^L\d+$/)).toHaveLength(75);
    expect(column.queryByRole('button', { name: t('kanban.showMore', { count: 15 }) })).toBeNull();
  });
});
