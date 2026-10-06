/**
 * Where a popover with no `anchorStyle` opens (D7, U10): under its trigger,
 * above it when there is no room below, never past the right edge. It used to
 * open on top of the trigger with no offsets at all.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { placeBeside } from '../src/Popover.js';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function pair(trigger: DOMRect, surface: DOMRect): HTMLElement {
  const parent = document.createElement('div');
  const button = document.createElement('button');
  const popover = document.createElement('div');
  button.getBoundingClientRect = () => trigger;
  popover.getBoundingClientRect = () => surface;
  parent.append(button, popover);
  document.body.append(parent);
  return popover;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('placeBeside', () => {
  it('opens under the trigger, aligned to its left edge', () => {
    window.innerWidth = 1280;
    window.innerHeight = 720;
    expect(placeBeside(pair(rect(100, 50, 40, 30), rect(0, 0, 200, 150)))).toEqual({
      position: 'fixed',
      top: 84,
      left: 100,
    });
  });

  it('opens above when it would leave the bottom, and pulls in from the right edge', () => {
    window.innerWidth = 1280;
    window.innerHeight = 720;
    const placed = placeBeside(pair(rect(1200, 650, 40, 30), rect(0, 0, 300, 200)));
    expect(placed.top).toBe(650 - 4 - 200);
    expect(placed.left).toBe(1280 - 8 - 300);
  });

  it('leaves a popover with no trigger where it is', () => {
    const lone = document.createElement('div');
    document.body.append(lone);
    expect(placeBeside(lone)).toEqual({});
  });
});
