/**
 * The only code in this product that talks to a language model.
 *
 * One transport, because every provider anybody would point this at speaks the
 * OpenAI chat-completions shape — Ollama, LM Studio and the cloud gateways all
 * do. Node 22's `fetch` and `AbortSignal`, no dependency: this is a POST that
 * reads a stream of `data:` lines.
 *
 * Three things about that stream are easy to get wrong and expensive to
 * discover later, so each is handled explicitly here:
 *
 *  · **Frames split anywhere.** A chunk boundary lands mid-line as often as
 *    not, so the parser buffers to a blank line rather than assuming a chunk is
 *    a frame.
 *  · **Tool call arguments arrive in fragments.** `delta.tool_calls[].function
 *    .arguments` is a *string* delivered a few characters at a time and
 *    accumulated by index until the model stops. Parsing each fragment as JSON
 *    fails on every one but the last.
 *  · **Usage is opt-in.** Without `stream_options: { include_usage: true }` no
 *    OpenAI-compatible stream reports token counts, and the cost display, the
 *    budget and the run record all silently read zero.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<Record<string, unknown>>;
  /** Set on a `tool` message: which call this answers. */
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface ChatToolDeclaration {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolDeclaration[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatToolCall {
  id: string;
  name: string;
  /** Reassembled from every fragment. Still a string — the tool parses it. */
  arguments: string;
}

export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'toolCalls'; calls: ChatToolCall[] }
  | { type: 'usage'; promptTokens: number; completionTokens: number };

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** A single non-streaming call, for the Test button. */
export async function probe(
  request: Omit<ChatRequest, 'messages'> & { messages?: ChatMessage[] },
): Promise<{ ok: boolean; supportsTools: boolean; model: string; error?: string }> {
  const messages: ChatMessage[] = request.messages ?? [
    { role: 'user', content: 'Call the ping tool.' },
  ];

  /*
   * A trivial tool, declared on purpose.
   *
   * Tool calling is a property of the *model's template*, not of the server:
   * Ollama exposes `tool_calls` only for models whose template declares tools.
   * Asking is the only way to know, and the answer decides whether ask-your-data
   * can loop or has to fall back to a single shot.
   */
  const tools: ChatToolDeclaration[] = [
    {
      type: 'function',
      function: {
        name: 'ping',
        description: 'Answer that you are here.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
  ];

  try {
    let supportsTools = false;
    for await (const chunk of chat({ ...request, messages, tools, maxTokens: 40 })) {
      if (chunk.type === 'toolCalls') supportsTools = true;
    }
    return { ok: true, supportsTools, model: request.model };
  } catch (error) {
    return {
      ok: false,
      supportsTools: false,
      model: request.model,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function* chat(request: ChatRequest): AsyncGenerator<ChatChunk> {
  const url = new URL('/v1/chat/completions', request.baseUrl);

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (request.apiKey) headers.authorization = `Bearer ${request.apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    signal: request.signal,
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      temperature: request.temperature ?? 0.2,
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      stream: true,
      // Without this the stream carries no usage at all, and every token count
      // in the product reads zero.
      stream_options: { include_usage: true },
    }),
  });

  if (!response.ok || !response.body) {
    throw new ProviderError(
      response.status === 401 ? 'error.ai.unauthorized' : 'error.ai.unreachable',
      `The model answered ${response.status}`,
    );
  }

  for await (const chunk of parseStream(response.body)) yield chunk;
}

/**
 * The SSE half, exported so it can be tested against pathological framing
 * without a network.
 */
export async function* parseStream(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<ChatChunk> {
  const decoder = new TextDecoder();
  let buffer = '';

  /** Tool calls under construction, by the index the provider assigns them. */
  const pending = new Map<number, ChatToolCall>();

  for await (const bytes of iterate(body)) {
    buffer += decoder.decode(bytes, { stream: true });

    // Frames end at a blank line, and a chunk boundary lands mid-line as often
    // as not — so the buffer is drained frame by frame, never chunk by chunk.
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf('\n\n');

      for (const chunk of readFrame(frame, pending)) yield chunk;
      if (frame.includes('[DONE]')) {
        if (pending.size > 0) yield { type: 'toolCalls', calls: [...pending.values()] };
        return;
      }
    }
  }

  // A stream that ended without `[DONE]` still has whatever it accumulated.
  if (pending.size > 0) yield { type: 'toolCalls', calls: [...pending.values()] };
}

function* readFrame(frame: string, pending: Map<number, ChatToolCall>): Generator<ChatChunk> {
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;

    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A malformed frame is skipped rather than thrown: one bad line must not
      // lose an answer that is otherwise arriving fine.
      continue;
    }

    const frameData = parsed as {
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    if (frameData.usage) {
      yield {
        type: 'usage',
        promptTokens: frameData.usage.prompt_tokens ?? 0,
        completionTokens: frameData.usage.completion_tokens ?? 0,
      };
    }

    const choice = frameData.choices?.[0];
    if (!choice) continue;

    if (choice.delta?.content) yield { type: 'text', text: choice.delta.content };

    for (const call of choice.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const existing = pending.get(index) ?? { id: '', name: '', arguments: '' };

      pending.set(index, {
        id: call.id ?? existing.id,
        name: call.function?.name ?? existing.name,
        // Concatenated, never parsed here: this is a fragment of a JSON string
        // and only the whole of it is valid JSON.
        arguments: existing.arguments + (call.function?.arguments ?? ''),
      });
    }

    if (choice.finish_reason === 'tool_calls' && pending.size > 0) {
      yield { type: 'toolCalls', calls: [...pending.values()] };
      pending.clear();
    }
  }
}

async function* iterate(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }

  // Node's `fetch` gives a web stream, which is async-iterable on 22 — but a
  // test hands in a plain async generator, and a reader works for both shapes.
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) yield value;
  }
}
