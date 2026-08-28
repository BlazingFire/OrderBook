/**
 * The SSE parser, against the framing a real provider actually produces.
 *
 * Every case here is a shape that arrives from a live model and that a naive
 * parser gets wrong: a frame split across two network chunks, a tool call whose
 * arguments come a few characters at a time, a usage frame that only appears
 * because the request asked for one, and a malformed line in the middle of a
 * good answer.
 *
 * No network. That is the point — these are the failures that would otherwise
 * only be found against somebody's Ollama at the wrong moment.
 */

import { describe, expect, it } from 'vitest';

import { parseStream, type ChatChunk } from '../src/ai/openai-compatible.js';

/** A stream that hands the parser exactly the chunks it is given. */
async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const part of parts) yield encoder.encode(part);
}

async function collect(...parts: string[]): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const chunk of parseStream(chunks(...parts))) out.push(chunk);
  return out;
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function text(content: string): string {
  return frame({ choices: [{ delta: { content } }] });
}

describe('reading a stream', () => {
  it('reassembles a frame split across two chunks', async () => {
    // A chunk boundary lands mid-line as often as not. A parser that treated a
    // chunk as a frame would drop this token entirely.
    const whole = text('Hello');
    const cut = Math.floor(whole.length / 2);

    expect(await collect(whole.slice(0, cut), whole.slice(cut))).toEqual([
      { type: 'text', text: 'Hello' },
    ]);
  });

  it('stops at [DONE] and ignores anything after it', async () => {
    const events = await collect(text('one'), 'data: [DONE]\n\n', text('two'));
    expect(events).toEqual([{ type: 'text', text: 'one' }]);
  });

  it('skips a malformed frame rather than losing the answer around it', async () => {
    const events = await collect(text('before'), 'data: {not json\n\n', text('after'));
    expect(events).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'after' },
    ]);
  });

  it('reports usage, which only arrives because the request asked for it', async () => {
    const events = await collect(frame({ usage: { prompt_tokens: 12, completion_tokens: 34 } }));
    expect(events).toEqual([{ type: 'usage', promptTokens: 12, completionTokens: 34 }]);
  });

  it('ignores an empty data line', async () => {
    expect(await collect('data:\n\n', text('kept'))).toEqual([{ type: 'text', text: 'kept' }]);
  });
});

describe('tool calls', () => {
  it('accumulates arguments split across three frames into one JSON object', async () => {
    // This is the case that makes a naive parser fail every time: each fragment
    // on its own is invalid JSON, and only their concatenation parses.
    const events = await collect(
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'list_parties', arguments: '{"sea' } },
              ],
            },
          },
        ],
      }),
      frame({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'rch":"Sh' } }] } }],
      }),
      frame({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: 'ree"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );

    expect(events).toEqual([
      {
        type: 'toolCalls',
        calls: [{ id: 'call_1', name: 'list_parties', arguments: '{"search":"Shree"}' }],
      },
    ]);
    expect(
      JSON.parse((events[0] as { calls: Array<{ arguments: string }> }).calls[0]!.arguments),
    ).toEqual({
      search: 'Shree',
    });
  });

  it('keeps two concurrent calls apart by their index', async () => {
    const events = await collect(
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'a', function: { name: 'list_parties', arguments: '{}' } },
                { index: 1, id: 'b', function: { name: 'list_products', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );

    expect((events[0] as { calls: unknown[] }).calls).toHaveLength(2);
  });

  it('still yields what it accumulated when the stream ends without [DONE]', async () => {
    // A dropped connection mid-answer. Losing the tool call would leave the run
    // waiting for a step that had in fact been asked for.
    const events = await collect(
      frame({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'x', function: { name: 'ping', arguments: '{}' } }],
            },
          },
        ],
      }),
    );

    expect(events).toEqual([
      { type: 'toolCalls', calls: [{ id: 'x', name: 'ping', arguments: '{}' }] },
    ]);
  });
});
