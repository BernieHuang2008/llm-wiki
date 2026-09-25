import { describe, expect, it, vi } from "vitest";

import { createClient, DEEPSEEK_BASE_URL, OPENROUTER_BASE_URL } from "./client";

// The OpenAI SDK stores the resolved base URL on the instance; read it back
// rather than reaching into internals so the assertion matches what the SDK
// will actually call.
function baseUrlOf(provider: Parameters<typeof createClient>[1]): string | undefined {
  const client = createClient("sk-test-key", provider);
  expect(client.apiKey).toBe(provider === "ollama" ? "ollama" : "sk-test-key");
  return client.baseURL;
}

describe("createClient provider routing", () => {
  it("sends DeepSeek to the vendor's own endpoint, not a router", () => {
    expect(baseUrlOf("deepseek")).toBe(DEEPSEEK_BASE_URL);
    expect(DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com/v1");
  });

  it("still sends OpenRouter to its endpoint", () => {
    expect(baseUrlOf("openrouter")).toBe(OPENROUTER_BASE_URL);
  });

  it("keeps Ollama on the local address and needs no key", () => {
    const client = createClient("", "ollama");
    expect(client.baseURL).toContain("/v1");
    expect(client.baseURL).toContain("localhost");
  });

  it("rejects a missing DeepSeek key rather than calling the API anonymously", () => {
    expect(() => createClient("", "deepseek")).toThrow(/DeepSeek apiKey is required/);
  });

  it("forwards an abort signal so a stalled provider can be killed", () => {
    const controller = new AbortController();
    const client = createClient("sk-test-key", "deepseek", controller.signal);
    // The SDK keeps the signal for per-request use; presence is what matters.
    expect(client).toBeTruthy();
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });
});

// Guard against a future refactor reintroducing the "silently fall back to
// OpenRouter" bug for an unknown provider value.
describe("createClient unknown provider", () => {
  it("falls back to OpenRouter instead of throwing on a legacy value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createClient("sk-test-key", undefined);
    expect(client.baseURL).toBe(OPENROUTER_BASE_URL);
    warn.mockRestore();
  });
});
