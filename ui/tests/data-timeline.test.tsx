/**
 * The Data artboard's timeline: who and when on the meta line over the message, and the
 * software's own entries (stage changes) marked system so people's remarks stand out.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TimelineEntry as RecordTimelineEntry } from '@orderbook/shared';

import { Timeline, recordTimelineEntries } from '../src/DataDisplay.js';

afterEach(cleanup);

const entry = (over: Partial<RecordTimelineEntry>): RecordTimelineEntry => ({
  id: 'TL1',
  tenantId: 't',
  parentType: 'lead',
  parentId: 'LD1',
  kind: 'remark',
  message: 'Party wants ivory first',
  fromStageId: null,
  toStageId: null,
  actorUserId: 'US1',
  actorName: 'Ramesh P.',
  createdAt: '2026-10-07T10:42:00.000Z',
  ...over,
});

describe('recordTimelineEntries', () => {
  it('puts the actor on the meta line and marks the software’s entries as system', () => {
    const entries = recordTimelineEntries(
      [
        entry({}),
        entry({ id: 'TL2', kind: 'system', actorName: null, message: 'Status changed New → In progress' }),
      ],
      () => '10:42',
    );
    expect(entries).toEqual([
      { id: 'TL1', label: 'Party wants ivory first', when: 'Ramesh P. · 10:42', system: false },
      { id: 'TL2', label: 'Status changed New → In progress', when: '10:42', system: true },
    ]);
  });
});

describe('Timeline', () => {
  it('renders the meta line above the text and flags system entries for the italic style', () => {
    const { container } = render(
      <Timeline
        entries={[
          { id: 'a', label: 'A note', when: 'Ramesh P. · 10:42' },
          { id: 'b', label: 'Status changed', when: '10:40', system: true, tone: 'ok' },
        ]}
      />,
    );
    const items = container.querySelectorAll('.ob-timeline li');
    expect([...items[0].children].map((child) => child.className)).toEqual(['when', 'what']);
    expect(items[0].getAttribute('data-system')).toBeNull();
    expect(items[1].getAttribute('data-system')).toBe('true');
    expect(items[1].getAttribute('data-tone')).toBe('ok');
  });
});
