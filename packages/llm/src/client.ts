import OpenAI from "openai";
import type { z } from "zod";

import {
  ContextLengthError,
  InvalidJsonError,
  LlmError,
  NetworkError,
  RateLimitError,
  SchemaValidationError,
  UnknownModelError,
} from "./errors";
import { estimateTokens } from "./models";

export type LlmClient = OpenAI;

/**
 * Inference providers the app can talk to. Kept in sync with core's
 * `ModelProvider`; declared here too so this package stays dependency-free.
 */
export type ModelProvider = "openrouter" | "ollama" | "deepseek";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * DeepSeek's official OpenAI-compatible endpoint. Using the vendor's own base
 * URL (not a router) is deliberate: DeepSeek keys only work there, and it
 * keeps prompt/completion traffic off third-party infrastructure.
 */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

export function createClient(
  apiKey: string,
  provider?: ModelProvider,
  signal?: AbortSignal,
): LlmClient {
  if (provider === "deepseek") {
    if (!apiKey) throw new Error("createClient: DeepSeek apiKey is required");
    return new OpenAI({
      apiKey,
      baseURL: DEEPSEEK_BASE_URL,
      // The background executor's watchdog aborts through this signal, so a
      // provider that accepts a connection and never answers cannot hold a
      // worker lane open indefinitely.
      ...(signal ? { signal } : {}),
    });
  }

  if (provider === "ollama") {
    const rawBaseUrl = process.env["OLLAMA_BASE_URL"] || "http://localhost:11434";
    const baseURL = rawBaseUrl.endsWith("/v1") ? rawBaseUrl : `${rawBaseUrl.replace(/\/$/, "")}/v1`;
    return new OpenAI({
      apiKey: "ollama",
      baseURL,
      ...(signal ? { signal } : {}),
    });
  }

  if (!apiKey) throw new Error("createClient: apiKey is required");
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    ...(signal ? { signal } : {}),
    defaultHeaders: {
      // OpenRouter attribution headers — visible to OpenRouter analytics
      // only; never include user content.
      "HTTP-Referer": "https://github.com/ddsyasas/llm-wiki",
      "X-Title": "LLM Wiki",
    },
  });
}

/**
 * Multimodal user content part. Matches OpenAI/OpenRouter content-block shape
 * so we can pass it through unchanged.
 *
 * - `image_url` is for images (PNG, JPEG, WebP) as data URLs.
 * - `file` is OpenRouter's PDF contract — `file_data` is a data URL with
 *   `application/pdf`. OpenRouter's server runs OCR/extraction itself and
 *   passes the result to the provider. Sending PDFs via `image_url` returns
 *   a generic "Provider returned error" from the upstream model.
 */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export type CallLlmOptions<T> = {
  client: LlmClient;
  model: string;
  system: string;
  user: string;
  /** Optional multimodal content for the user message. When set, takes
   * precedence over `user`. We still take `user` for back-compat and to
   * give callers a plain-text fallback when `userParts` is empty. */
  userParts?: UserContentPart[];
  schema: z.ZodType<T>;
  /** Total request attempts before giving up. Default 3. */
  maxRetries?: number;
  /** Hook called between retries with the upcoming attempt number and delay. */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
  /** Aborts the entire call (including retries). */
  signal?: AbortSignal;
};

export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type CallLlmResult<T> = {
  data: T;
  usage: LlmUsage;
  rawResponse: string;
  model: string;
};

const JSON_REPAIR_NUDGE =
  "Your previous response was not valid JSON. Output ONLY a valid JSON object that matches the schema. No prose, no markdown fences.";

export async function callLLM<T>(opts: CallLlmOptions<T>): Promise<CallLlmResult<T>> {
  const maxRetries = opts.maxRetries ?? 3;
  let lastError: unknown = null;
  let jsonRepairUsed = false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      return await attemptOnce(opts, jsonRepairUsed);
    } catch (err) {
      lastError = err;

      // Non-retriable failures bail immediately.
      if (err instanceof ContextLengthError || err instanceof UnknownModelError) {
        throw err;
      }
      if (err instanceof SchemaValidationError) {
        throw err; // valid JSON, just doesn't match — don't waste tokens
      }

      // One repair attempt for invalid JSON, then surface.
      if (err instanceof InvalidJsonError) {
        if (jsonRepairUsed) throw err;
        jsonRepairUsed = true;
        opts.onRetry?.(attempt + 1, 0, "invalid-json repair");
        continue;
      }

      if (attempt === maxRetries) break;

      let delayMs: number;
      let reason: string;
      if (err instanceof RateLimitError) {
        delayMs = err.retryAfterMs ?? backoffMs(attempt);
        reason = "rate-limit";
      } else if (err instanceof NetworkError) {
        delayMs = backoffMs(attempt);
        reason = "network";
      } else {
        // Unknown error class — retry conservatively but log via onRetry.
        delayMs = backoffMs(attempt);
        reason = "unknown";
      }
      opts.onRetry?.(attempt + 1, delayMs, reason);
      await sleep(delayMs, opts.signal);
    }
  }

  throw lastError ?? new LlmError("callLLM exhausted retries with no error captured");
}

// Anthropic models (and others routed through OpenRouter) don't always honor
// response_format: json_object — they sometimes wrap output in a ```json …
// ``` fence even though the system prompt says not to. Strip the fence and
// any leading/trailing prose before handing off to JSON.parse so a benign
// formatting tic doesn't cost the user a retry + a final error.
function extractJsonBody(raw: string): string {
  let s = raw.trim();

  // 1) Strip a single surrounding code fence if present. Tolerate an
  // optional language tag (```json, ```JSON, ```) and stray whitespace.
  const fenceMatch = s.match(/^```(?:[a-zA-Z]+)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch?.[1] !== undefined) {
    s = fenceMatch[1].trim();
  }

  // 2) If there's still prose around a JSON object, slice from the first
  // brace to the matching last brace. We trust the LLM to emit a single
  // top-level object — that's what every schema in the project expects.
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace > 0 || (firstBrace === 0 && lastBrace < s.length - 1)) {
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      s = s.slice(firstBrace, lastBrace + 1);
    }
  }

  return s;
}

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s, capped at 30s. attempt is 1-based.
  return Math.min(30_000, 2 ** (attempt - 1) * 1000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function attemptOnce<T>(
  opts: CallLlmOptions<T>,
  isRepairAttempt: boolean,
): Promise<CallLlmResult<T>> {
  const system = isRepairAttempt ? `${opts.system}\n\n${JSON_REPAIR_NUDGE}` : opts.system;

  const userContent: string | UserContentPart[] =
    opts.userParts && opts.userParts.length > 0 ? opts.userParts : opts.user;

  let response;
  try {
    response = await opts.client.chat.completions.create(
      {
        model: opts.model,
        response_format: { type: "json_object" },
        // OpenAI's typed messages accept either string or content-block array
        // for user/assistant roles, but TS unions get awkward; cast at the
        // SDK boundary since we've validated the shape above.
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent as never },
        ],
      },
      opts.signal ? { signal: opts.signal } : undefined,
    );
  } catch (err) {
    throw mapSdkError(err, opts.model);
  }

  // OpenRouter sometimes returns 200 OK with an error body (no `choices`,
  // a top-level `error` field instead) — typically when an upstream provider
  // rejects the request. The OpenAI SDK doesn't surface this as an exception,
  // so guard the access and translate to a real error including any provider
  // metadata OpenRouter passes through.
  const respWithError = response as unknown as {
    error?: {
      message?: string;
      code?: string | number;
      metadata?: { raw?: string; provider_name?: string };
    };
  };
  if (!response.choices || response.choices.length === 0) {
    const apiErr = respWithError.error;
    const base = apiErr?.message ?? "no choices in response";
    const meta = apiErr?.metadata;
    const extras: string[] = [];
    if (meta?.provider_name) extras.push(`provider=${meta.provider_name}`);
    if (meta?.raw) extras.push(`raw=${meta.raw.slice(0, 400)}`);
    const detail = extras.length > 0 ? `${base} (${extras.join(", ")})` : base;
    throw new LlmError(`provider returned no completion: ${detail}`);
  }
  const choice = response.choices[0];
  const raw = choice?.message?.content ?? "";
  if (!raw.trim()) {
    throw new InvalidJsonError(raw, "empty response");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonBody(raw));
  } catch (err) {
    throw new InvalidJsonError(raw, (err as Error).message);
  }

  const result = opts.schema.safeParse(parsed);
  if (!result.success) {
    throw new SchemaValidationError(raw, result.error.issues);
  }

  return {
    data: result.data,
    rawResponse: raw,
    model: response.model ?? opts.model,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

// ---- chatComplete: plain-text streaming-friendly call --------------------
// Per docs/05: chat responses skip the JSON schema and return free-form
// markdown. We still want retry + typed-error handling, so most of the
// logic mirrors callLLM minus the JSON parsing + zod validation.

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatCompleteOptions = {
  client: LlmClient;
  model: string;
  messages: ChatMessage[];
  maxRetries?: number;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
  signal?: AbortSignal;
  /**
   * Called with every streamed chunk as it arrives. Passing it switches the
   * request to SSE streaming so a viewer can render the answer while it is
   * still being written; the returned result is byte-identical either way, so
   * callers that don't care about liveness can leave it out.
   */
  onDelta?: (delta: string) => void;
};

export type ChatCompleteResult = {
  text: string;
  usage: LlmUsage;
  model: string;
};

export async function chatComplete(opts: ChatCompleteOptions): Promise<ChatCompleteResult> {
  const maxRetries = opts.maxRetries ?? 3;
  let lastError: unknown = null;
  /**
   * How many characters the viewer has already been shown. Once anything has
   * been streamed a retry would re-emit the same opening text, so the failure
   * is surfaced instead of silently duplicating output.
   */
  let emittedChars = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      const onDelta = opts.onDelta;
      if (!onDelta) return await chatCompleteOnce(opts);
      return await chatStreamOnce(opts, (delta) => {
        emittedChars += delta.length;
        onDelta(delta);
      });
    } catch (err) {
      const mapped = mapSdkError(err, opts.model, opts.client.baseURL);
      lastError = mapped;

      if (mapped instanceof ContextLengthError || mapped instanceof UnknownModelError) {
        throw mapped;
      }
      if (emittedChars > 0) throw mapped;
      if (attempt === maxRetries) break;

      const delayMs =
        mapped instanceof RateLimitError
          ? (mapped.retryAfterMs ?? backoffMs(attempt))
          : backoffMs(attempt);
      const reason = mapped instanceof RateLimitError ? "rate-limit" : "network";
      opts.onRetry?.(attempt + 1, delayMs, reason);
      await sleep(delayMs, opts.signal);
    }
  }

  throw lastError ?? new LlmError("chatComplete exhausted retries with no error captured");
}

/** One non-streaming attempt. Kept separate so retry bookkeeping stays in one place. */
async function chatCompleteOnce(opts: ChatCompleteOptions): Promise<ChatCompleteResult> {
  const response = await opts.client.chat.completions.create(
    {
      model: opts.model,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    },
    opts.signal ? { signal: opts.signal } : undefined,
  );
  const text = response.choices[0]?.message?.content ?? "";
  return {
    text,
    model: response.model ?? opts.model,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * One streaming attempt.
 *
 * The accumulator is the source of truth: the reply is only returned (and only
 * persisted, by the caller) once the stream ends cleanly, so a half-received
 * answer can never be written to the chat file. `onDelta` is for liveness only.
 */
async function chatStreamOnce(
  opts: ChatCompleteOptions,
  onDelta: (delta: string) => void,
): Promise<ChatCompleteResult> {
  const stream = await opts.client.chat.completions.create(
    {
      model: opts.model,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      // Asked for explicitly because providers otherwise omit usage on the
      // final chunk. Ollama's OpenAI-compatible endpoint is the exception we
      // know about, so we don't send it there and estimate instead.
      ...(wantsStreamUsage(opts.client) ? { stream_options: { include_usage: true } } : {}),
    },
    opts.signal ? { signal: opts.signal } : undefined,
  );

  let text = "";
  let model = opts.model;
  let usage: LlmUsage | null = null;

  for await (const chunk of stream) {
    if (typeof chunk.model === "string" && chunk.model.length > 0) model = chunk.model;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      text += delta;
      onDelta(delta);
    }
    // Present only on the trailing usage chunk (see `stream_options` above).
    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      };
    }
  }

  if (!text.trim()) {
    // Mirrors the non-streaming path, which returns the empty string rather
    // than inventing a failure: an empty answer stays valid, just useless.
    return { text, model, usage: usage ?? { inputTokens: 0, outputTokens: 0 } };
  }

  return {
    text,
    model,
    // Falling back to an estimate keeps the usage ledger honest rather than
    // recording a free call just because the provider skipped usage reporting.
    usage: usage ?? { inputTokens: 0, outputTokens: estimateTokens(text) },
  };
}

/** Local servers ignore `stream_options` at best; skipping it keeps them happy. */
function wantsStreamUsage(client: LlmClient): boolean {
  const baseURL = (client as { baseURL?: string }).baseURL ?? "";
  return !/localhost|127\.0\.0\.1|11434/i.test(baseURL);
}

// Maps OpenAI SDK errors into our typed surface so callers never need to
// reach into the SDK's error shape. Anything we don't recognize bubbles up
// as a generic LlmError to keep error handling exhaustive.
function mapSdkError(err: unknown, model: string, baseURL?: string): LlmError {
  if (err instanceof LlmError) return err;

  // The OpenAI SDK throws APIError subclasses with status, message, type,
  // and code. We check duck-typed because instanceof against bundled-vs-
  // workspace copies of openai can be brittle.
  const e = err as {
    status?: number;
    message?: string;
    type?: string;
    code?: string;
    headers?: Record<string, string>;
  };

  const isOllama = baseURL && (baseURL.includes("localhost") || baseURL.includes("11434"));
  const provider = isOllama ? "ollama" : "openrouter";
  const msg = (e.message ?? String(err)).toLowerCase();

  if (e.status === 429) {
    const retryAfter = parseRetryAfter(e.headers?.["retry-after"]);
    return new RateLimitError(retryAfter, err, provider);
  }

  if (msg.includes("context length") || msg.includes("maximum context") || msg.includes("too long")) {
    return new ContextLengthError(`source too large for model ${model}`, err);
  }

  if (
    e.status === 404 ||
    msg.includes("model not found") ||
    msg.includes("not available") ||
    msg.includes("unknown model")
  ) {
    return new UnknownModelError(model, err, provider);
  }

  if (e.status && e.status >= 500) {
    const serviceName = isOllama ? "Ollama" : "OpenRouter";
    return new NetworkError(`server error from ${serviceName} (${e.status})`, err);
  }

  if (
    e.code === "ECONNRESET" ||
    e.code === "ETIMEDOUT" ||
    e.code === "ENOTFOUND" ||
    msg.includes("network") ||
    msg.includes("fetch failed")
  ) {
    return new NetworkError(`network error: ${e.message ?? String(err)}`, err);
  }

  return new LlmError(e.message ?? String(err), err);
}

function parseRetryAfter(header: string | undefined): number | null {
  if (!header) return null;
  const seconds = Number.parseInt(header, 10);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  // HTTP date form is rare in practice; ignore for V1.
  return null;
}
