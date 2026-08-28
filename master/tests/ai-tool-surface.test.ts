/**
 * The shape of what the assistant is allowed to do.
 *
 * `Record<AiToolName, AiTool>` catches a *missing* tool at compile time and
 * nothing else: `Permission` is `string`, so a typo in a `permission` field
 * type-checks perfectly. This file is what catches that, and the reason it
 * matters is that a tool whose permission does not exist is a tool nobody
 * holds — `hasPermission` simply answers false — so it would fail silently and
 * for ever rather than loudly and once.
 *
 * The second half is the invariant that keeps the whole design honest: no tool
 * takes a free-form string that reaches SQL, a path, or a URL. That is not a
 * filter on the model's output, it is the absence of anything for a poisoned
 * prompt to reach.
 */

import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@orderbook/shared';

import { AI_TOOLS, AI_TOOL_NAMES, isAiToolName } from '../src/ai/tools.js';

describe('the tool registry', () => {
  it('names every permission from the frozen catalogue', () => {
    for (const [name, tool] of Object.entries(AI_TOOLS)) {
      expect(PERMISSIONS, `${name} names a permission that does not exist`).toContain(
        tool.permission,
      );
    }
  });

  it('declares a closed schema for every tool', () => {
    // `additionalProperties: false` is what stops a model inventing an argument
    // and a future `run` quietly reading it.
    for (const [name, tool] of Object.entries(AI_TOOLS)) {
      expect(tool.schema.type, name).toBe('object');
      expect(tool.schema.additionalProperties, name).toBe(false);
    }
  });

  it('accepts no argument that could reach SQL, a path or a network', () => {
    const forbidden = ['sql', 'query_sql', 'where', 'orderBy', 'path', 'file', 'url', 'tenantId'];

    for (const [name, tool] of Object.entries(AI_TOOLS)) {
      const properties = Object.keys(
        (tool.schema.properties as Record<string, unknown> | undefined) ?? {},
      );
      for (const key of properties) {
        expect(forbidden, `${name} accepts "${key}"`).not.toContain(key);
      }
    }
  });

  it('recognises its own names and nothing else', () => {
    for (const name of AI_TOOL_NAMES) expect(isAiToolName(name)).toBe(true);
    expect(isAiToolName('delete_everything')).toBe(false);
    // A prototype key is a string too, and `hasOwnProperty` is why this is false.
    expect(isAiToolName('toString')).toBe(false);
  });

  it('has no tool whose name suggests it writes', () => {
    // Not a guarantee — a `run` could do anything — but a create/update/delete
    // *name* is the thing a reviewer would miss, and this makes it loud.
    for (const name of AI_TOOL_NAMES) {
      expect(name).not.toMatch(/^(create|update|delete|set|apply|send)_/);
    }
  });
});
