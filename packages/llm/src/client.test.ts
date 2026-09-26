import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { callLLM, chatComplete, type LlmClient } from "./client";
import {
  ContextLengthError,
  InvalidJsonError,
  NetworkError,
  RateLimitError,
  SchemaValidationError,
  UnknownModelError,
} from "./errors";
import { estimateCostCents, estimateTokens, getPricing } from "./models";

const schema = z.object({ message: z.string() });

type CreateFn = LlmClient["chat"]["completions"]["create"];

function mockClient(impl: (...args: Parameters<CreateFn>) => unknown): LlmClient {
  return {
    chat: { completions: { create: vi.fn(impl as never) } },
  } as unknown as LlmClient;
}

function jsonResponse(body: unknown, opts: { model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } } = {}) {
  return {
    id: "chatcmpl-test",
    model: opts.model ?? "anthropic/claude-haiku-4.5",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(body) }, finish_reason: "stop" }],
    usage: { prompt_tokens: opts.usage?.prompt_tokens ?? 10, completion_tokens: opts.usage?.completion_tokens ?? 5 },
  };
}

class FakeApiError extends Error {
  status: number;
  code?: string;
  headers?: Record<string, string>;
  constructor(
    message: string,
    opts: { status?: number; code?: string; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "APIError";
    this.status = opts.status ?? 0;
    if (opts.code) this.code = opts.code;
    if (opts.headers) this.headers = opts.headers;
  }
}

describe("callLLM happy path", () => {
  it("parses valid JSON, validates against the schema, and returns usage", async () => {
    const client = mockClient(() => jsonResponse({ message: "hello" }));
    const result = await callLLM({
      client,
      model: "anthropic/claude-haiku-4.5",
      system: "json only",
      user: "say hi",
      schema,
    });
    expect(result.data).toEqual({ message: "hello" });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.model).toBe("anthropic/claude-haiku-4.5");
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("requests json_object response format and uses the configured messages", async () => {
    const create = vi.fn(() => jsonResponse({ message: "ok" }));
    const client = { chat: { completions: { create } } } as unknown as LlmClient;
    await callLLM({ client, model: "m", system: "sys", user: "usr", schema });
    const params = (create.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as {
      model: string;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(params.model).toBe("m");
    expect(params.response_format).toEqual({ type: "json_object" });
    expect(params.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
  });
});

describe("callLLM defensive JSON parsing", () => {
  it("strips a ```json …``` markdown fence before parsing", async () => {
    const fenced = "```json\n" + JSON.stringify({ message: "ok" }) + "\n```";
    const client = mockClient(() => ({
      id: "x",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: fenced }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const result = await callLLM({ client, model: "m", system: "s", user: "u", schema });
    expect(result.data).toEqual({ message: "ok" });
  });

  it("strips a bare ``` fence (no language tag) before parsing", async () => {
    const fenced = "```\n" + JSON.stringify({ message: "ok" }) + "\n```";
    const client = mockClient(() => ({
      id: "x",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: fenced }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const result = await callLLM({ client, model: "m", system: "s", user: "u", schema });
    expect(result.data).toEqual({ message: "ok" });
  });

  it("slices to the {…} body when the model prepends prose", async () => {
    const withPreamble =
      "Here's the JSON you asked for:\n" + JSON.stringify({ message: "ok" });
    const client = mockClient(() => ({
      id: "x",
      model: "m",
      choices: [
        { index: 0, message: { role: "assistant", content: withPreamble }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const result = await callLLM({ client, model: "m", system: "s", user: "u", schema });
    expect(result.data).toEqual({ message: "ok" });
  });
});

describe("callLLM error mapping", () => {
  it("throws SchemaValidationError when JSON parses but fails the zod schema", async () => {
    const client = mockClient(() => jsonResponse({ message: 42 }));
    await expect(
      callLLM({ client, model: "m", system: "s", user: "u", schema }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("throws InvalidJsonError after one repair attempt fails", async () => {
    const create = vi.fn(() => Promise.resolve({
      id: "x",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "not json" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const client = { chat: { completions: { create } } } as unknown as LlmClient;
    await expect(
      callLLM({ client, model: "m", system: "s", user: "u", schema }),
    ).rejects.toBeInstanceOf(InvalidJsonError);
    // First attempt + one repair attempt = 2 calls
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("repairs successfully if the second attempt returns valid JSON", async () => {
    let call = 0;
    const create = vi.fn(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          id: "x",
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "garbage" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      }
      return Promise.resolve(jsonResponse({ message: "recovered" }));
    });
    const client = { chat: { completions: { create } } } as unknown as LlmClient;
    const result = await callLLM({ client, model: "m", system: "s", user: "u", schema });
    expect(result.data).toEqual({ message: "recovered" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("surfaces context-length failures as ContextLengthError without retrying", async () => {
    const create = vi.fn(() =>
      Promise.reject(new FakeApiError("context length exceeded", { status: 400 })),
    );
    const client = { chat: { completions: { create } } } as unknown as LlmClient;
    await expect(
      callLLM({ client, model: "m", system: "s", user: "u", schema }),
    ).rejects.toBeInstanceOf(ContextLengthError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("surfaces unknown-model failures as UnknownModelError without retrying", async () => {
    const create = vi.fn(() =>
      Promise.reject(new FakeApiError("model not found", { status: 404 })),
    );
    const client = { chat: { completions: { create } } } as unknown as LlmClient;
    await expect(
      callLLM({ client, model: "weird/model", system: "s", user: "u", schema }),
    ).rejects.toBeInstanceOf(UnknownModelError);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("callLLM retry behavior", () => {
  it("retries 5xx with backoff and eventually succeeds", async () => {
    let call = 0;
    const create = vi.fn(() => {
      call++;
      if (call < 3) return Promise.reject(new FakeApiError("server boom", { status: 503 }));
      return Promise.resolve(jsonResponse({ message: "finally" }));
    });
    const client = { chat: { completions: { create } } } as unknown as LlmClient;
    const onRetry = vi.fn();
    const result = await callLLM({
      client,
      model: "m",
      system: "s",
      user: "u",
      schema,
      maxRetries: 3,
      onRetry,
    });
    expect(result.data).toEqual({ message: "finally" });
    expect(create).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect((onRetry.mock.calls as unknown as Array<[number, number, string]>)[0]?.[2]).toBe(
      "network",
    );
  });

  it("honors Retry-After on 429 and surfaces RateLimitError when retries exhaust", async () => {
    const create = vi.fn(() =>
      Promise.reject(
        new FakeApiError("rate limit", { status: 429, headers: { "retry-after": "0" } }),
      ),
    );
    const client = { chat: { completions: { create } } } as unknown as LlmClient;
    const onRetry = vi.fn();
    await expect(
      callLLM({ client, model: "m", system: "s", user: "u", schema, maxRetries: 2, onRetry }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(create).toHaveBeenCalledTimes(2);
    expect((onRetry.mock.calls as unknown as Array<[number, number, string]>)[0]?.[2]).toBe(
      "rate-limit",
    );
  });

  it("maps network errors (ECONNRESET) to NetworkError and retries", async () => {
    let call = 0;
    const create = vi.fn(() => {
      call++;
      if (call === 1)
        return Promise.reject(new FakeApiError("socket hang up", { code: "ECONNRESET" }));
      return Promise.resolve(jsonResponse({ message: "ok" }));
    });
    const client = { chat: { completions: { create } } } as unknown as LlmClient;
    const result = await callLLM({ client, model: "m", system: "s", user: "u", schema });
    expect(result.data).toEqual({ message: "ok" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("propagates an AbortSignal that fires mid-wait", async () => {
    const create = vi.fn(() => Promise.reject(new FakeApiError("server boom", { status: 503 })));
    const client = { chat: { completions: { create } } } as unknown as LlmClient;
    const controller = new AbortController();
    const p = callLLM({
      client,
      model: "m",
      system: "s",
      user: "u",
      schema,
      maxRetries: 5,
      signal: controller.signal,
    });
    queueMicrotask(() => controller.abort(new Error("user cancelled")));
    await expect(p).rejects.toThrow(/cancelled|aborted/);
  });
});

describe("chatComplete streaming", () => {
  /** Minimal async-iterable stand-in for the SDK's `Stream<ChatCompletionChunk>`. */
  function streamOf(chunks: unknown[]): AsyncIterable<unknown> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    };
  }

  function deltaChunk(text: string): unknown {
    return {
      id: "chatcmpl-test",
      model: "anthropic/claude-haiku-4.5",
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    };
  }

  it("emits every delta in order and returns the joined text", async () => {
    const create = vi.fn(() =>
      Promise.resolve(streamOf([deltaChunk("Hello"), deltaChunk(", "), deltaChunk("wiki")])),
    );
    const client = { chat: { completions: { create } } } as unknown as LlmClient;
    const deltas: string[] = [];

    const result = await chatComplete({
      client,
      model: "anthropic/claude-haiku-4.5",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (d) => deltas.push(d),
    });

    expect(deltas).toEqual(["Hello", ", ", "wiki"]);
    expect(result.text).toBe("Hello, wiki");
    expect(result.model).toBe("anthropic/claude-haiku-4.5");
  });

  it("asks for streaming and requests usage on the final chunk", async () => {
    const create = vi.fn((..._args: unknown[]) =>
      Promise.resolve(
        streamOf([
          deltaChunk("answer"),
          {
            id: "chatcmpl-test",
            model: "m",
            choices: [],
            usage: { prompt_tokens: 42, completion_tokens: 7 },
          },
        ]),
      ),
    );
    // baseURL is what decides whether `stream_options` is sent (Ollama skips it).
    const client = {
      baseURL: "https://openrouter.ai/api/v1",
      chat: { completions: { create } },
    } as unknown as LlmClient;

    const result = await chatComplete({
      client,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => {},
    });

    const params = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(params?.["stream"]).toBe(true);
    expect(params?.["stream_options"]).toEqual({ include_usage: true });
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  it("omits stream_options for a local (Ollama) endpoint and estimates usage instead", async () => {
    const create = vi.fn((..._args: unknown[]) =>
      Promise.resolve(streamOf([deltaChunk("abcdefgh")])),
    );
    const client = {
      baseURL: "http://localhost:11434/v1",
      chat: { completions: { create } },
    } as unknown as LlmClient;

    const result = await chatComplete({
      client,
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => {},
    });

    const params = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(params?.["stream_options"]).toBeUndefined();
    expect(result.usage.outputTokens).toBe(2); // ceil(8 / 4)
  });

  it("does not retry after text has already been shown to the viewer", async () => {
    let call = 0;
    const create = vi.fn(() => {
      call++;
      // First attempt streams a little, then the connection dies.
      if (call === 1) {
        return Promise.resolve({
          async *[Symbol.asyncIterator]() {
            yield deltaChunk("half an ans");
            throw new FakeApiError("socket hang up", { code: "ECONNRESET" });
          },
        });
      }
      return Promise.resolve(streamOf([deltaChunk("duplicate")]));
    });
    const client = { chat: { completions: { create } } } as unknown as LlmClient;

    await expect(
      chatComplete({
        client,
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        maxRetries: 3,
        onDelta: () => {},
      }),
    ).rejects.toBeInstanceOf(NetworkError);
    // One attempt only: a retry would re-stream the opening text.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not touch streaming when no onDelta is given", async () => {
    const create = vi.fn(() =>
      Promise.resolve({
        id: "x",
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "plain" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    );
    const client = { chat: { completions: { create } } } as unknown as LlmClient;
    const result = await chatComplete({
      client,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe("plain");
    const params = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(params?.["stream"]).toBeUndefined();
  });
});

describe("models helpers", () => {
  it("estimateTokens approximates 4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello world")).toBe(Math.ceil(11 / 4));
  });

  it("getPricing returns null for unknown models", () => {
    expect(getPricing("anthropic/claude-haiku-4.5")).not.toBeNull();
    expect(getPricing("made-up/model")).toBeNull();
  });

  it("estimateCostCents computes cost when pricing is known and null otherwise", () => {
    const cost = estimateCostCents("anthropic/claude-haiku-4.5", 1_000_000, 1_000_000);
    // Haiku 4.5: $1.00 input + $5.00 output per million = $6.00 = 600 cents
    expect(cost).toBeCloseTo((1.0 + 5.0) * 100);
    expect(estimateCostCents("made-up/model", 100, 100)).toBeNull();
  });
});
