import { describe, expect, it } from "vitest";

import {
  CNY_PER_USD,
  cnyToUsd,
  estimateCostCents,
  getDeepSeekPricing,
  getPricing,
  isDeepSeekPeak,
  normalizeModelSlug,
} from "./models";

// Beijing time helper: the peak rule is defined in UTC+8, so build instants
// from a Beijing wall-clock time to keep the tests timezone-independent.
function beijing(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
}

describe("normalizeModelSlug", () => {
  it("strips Anthropic's 8-digit date suffix", () => {
    expect(normalizeModelSlug("anthropic/claude-4.6-sonnet-20260217")).toBe(
      "anthropic/claude-4.6-sonnet",
    );
  });

  it("strips OpenAI's hyphenated date suffix", () => {
    expect(normalizeModelSlug("openai/gpt-4o-2024-08-06")).toBe("openai/gpt-4o");
  });

  it("leaves slugs without a date suffix alone", () => {
    expect(normalizeModelSlug("google/gemini-2.5-pro")).toBe("google/gemini-2.5-pro");
    expect(normalizeModelSlug("anthropic/claude-sonnet-4.6")).toBe("anthropic/claude-sonnet-4.6");
  });
});

describe("getPricing", () => {
  it("resolves OpenRouter's reordered Anthropic slug", () => {
    // Our canonical: anthropic/claude-sonnet-4.6
    // OpenRouter returns: anthropic/claude-4.6-sonnet (sometimes dated)
    expect(getPricing("anthropic/claude-4.6-sonnet")).not.toBeNull();
    expect(getPricing("anthropic/claude-4.6-sonnet-20260217")).not.toBeNull();
  });

  it("resolves the legacy Claude 3.5 family", () => {
    expect(getPricing("anthropic/claude-3-5-haiku")).not.toBeNull();
    expect(getPricing("anthropic/claude-3-5-sonnet")).not.toBeNull();
  });

  it("returns null for unknown models rather than guessing", () => {
    expect(getPricing("fictitious/model-1.0")).toBeNull();
  });
});

describe("estimateCostCents", () => {
  it("multiplies tokens by the per-million price and converts USD → cents", () => {
    // gpt-4o-mini: $0.15 in / $0.60 out per million
    // 1M in + 1M out = $0.15 + $0.60 = $0.75 = 75 cents
    expect(estimateCostCents("openai/gpt-4o-mini", 1_000_000, 1_000_000)).toBeCloseTo(75, 5);
  });

  it("returns null for unknown models", () => {
    expect(estimateCostCents("fictitious/model-1.0", 1000, 1000)).toBeNull();
  });
});

describe("DeepSeek peak / off-peak pricing", () => {
  // 2026-09-25 is a Friday; 2026-09-26 a Saturday.
  it("treats weekday working hours in Beijing as peak", () => {
    expect(isDeepSeekPeak(beijing(2026, 9, 25, 9, 0))).toBe(true);
    expect(isDeepSeekPeak(beijing(2026, 9, 25, 11, 59))).toBe(true);
    expect(isDeepSeekPeak(beijing(2026, 9, 25, 14, 0))).toBe(true);
    expect(isDeepSeekPeak(beijing(2026, 9, 25, 17, 59))).toBe(true);
  });

  it("treats the lunch break, night and weekends as off-peak", () => {
    expect(isDeepSeekPeak(beijing(2026, 9, 25, 12, 0))).toBe(false);
    expect(isDeepSeekPeak(beijing(2026, 9, 25, 13, 59))).toBe(false);
    expect(isDeepSeekPeak(beijing(2026, 9, 25, 18, 0))).toBe(false);
    expect(isDeepSeekPeak(beijing(2026, 9, 25, 3, 0))).toBe(false);
    expect(isDeepSeekPeak(beijing(2026, 9, 26, 10, 0))).toBe(false);
    expect(isDeepSeekPeak(beijing(2026, 9, 27, 10, 0))).toBe(false);
  });

  it("halves the CNY rate off-peak", () => {
    const peak = getDeepSeekPricing("deepseek-v4-pro", beijing(2026, 9, 25, 10, 0));
    const off = getDeepSeekPricing("deepseek-v4-pro", beijing(2026, 9, 25, 20, 0));
    expect(peak).toEqual({ inputPerMillion: 9.0, outputPerMillion: 27.0 });
    expect(off).toEqual({ inputPerMillion: 4.5, outputPerMillion: 13.5 });
  });

  it("matches DeepSeek's published Flash card", () => {
    expect(getDeepSeekPricing("deepseek-flash", beijing(2026, 9, 25, 10, 0))).toEqual({
      inputPerMillion: 2.0,
      outputPerMillion: 8.0,
    });
  });

  it("converts CNY to USD in the cost figure", () => {
    // 1M in + 1M out of Flash at peak = ¥2 + ¥8 = ¥10 → $10/7.2 → 138.9 cents
    const cents = estimateCostCents(
      "deepseek-flash",
      1_000_000,
      1_000_000,
      beijing(2026, 9, 25, 10, 0),
    );
    expect(cents).not.toBeNull();
    expect(cents!).toBeCloseTo((10 / CNY_PER_USD) * 100, 4);
    expect(cnyToUsd(7.2)).toBeCloseTo(1, 10);
  });
});
