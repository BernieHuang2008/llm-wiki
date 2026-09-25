// Client-side cost estimator. Mirrors packages/llm/src/models.ts pricing
// (kept duplicated so the UI doesn't need a server roundtrip).
//
// DeepSeek bills in CNY at peak/off-peak rates, so its rows here are converted
// with the same fixed rate the server uses. Keep CNY_PER_USD in sync with
// packages/llm/src/models.ts.

export type ModelPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
};

const CNY_PER_USD = 7.2;
const cny = (v: number) => v / CNY_PER_USD;

/** DeepSeek peak = Beijing time Mon–Fri 09:00–12:00 and 14:00–18:00. */
function isDeepSeekPeak(date: Date): boolean {
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const day = beijing.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  return (
    (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
  );
}

/** CNY per million tokens, as published by DeepSeek. */
const DEEPSEEK_CNY: Record<
  string,
  { peak: ModelPricing; offPeak: ModelPricing }
> = {
  "deepseek-flash": {
    peak: { inputPerMillion: 2.0, outputPerMillion: 8.0 },
    offPeak: { inputPerMillion: 1.0, outputPerMillion: 4.0 },
  },
  "deepseek-v4-pro": {
    peak: { inputPerMillion: 9.0, outputPerMillion: 27.0 },
    offPeak: { inputPerMillion: 4.5, outputPerMillion: 13.5 },
  },
};

const PRICING: Record<string, ModelPricing> = {
  "anthropic/claude-haiku-4.5": { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  "anthropic/claude-sonnet-4.6": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  "anthropic/claude-opus-4.7": { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  "openai/gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "openai/gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  "google/gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10.0 },
  "google/gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  "meta-llama/llama-3.3-70b-instruct": { inputPerMillion: 0.1, outputPerMillion: 0.3 },
  // OpenRouter free-tier routes — zero per-call cost. Rate limits / privacy
  // tradeoffs are surfaced as a banner in Settings, not in cost preview.
  "meta-llama/llama-3.3-70b-instruct:free": { inputPerMillion: 0, outputPerMillion: 0 },
  "nvidia/nemotron-3-super-120b-a12b:free": { inputPerMillion: 0, outputPerMillion: 0 },
  "deepseek/deepseek-v4-flash:free": { inputPerMillion: 0, outputPerMillion: 0 },
  "google/gemma-4-31b-it:free": { inputPerMillion: 0, outputPerMillion: 0 },
};

export function getPricing(model: string, at: Date = new Date()): ModelPricing | null {
  const ds = DEEPSEEK_CNY[model];
  if (ds) {
    const rate = isDeepSeekPeak(at) ? ds.peak : ds.offPeak;
    return {
      inputPerMillion: cny(rate.inputPerMillion),
      outputPerMillion: cny(rate.outputPerMillion),
    };
  }
  return PRICING[model] ?? null;
}

/** CNY card for the UI, so DeepSeek can be shown in its native currency. */
export function getDeepSeekCnyPricing(
  model: string,
): { peak: { input: number; output: number }; offPeak: { input: number; output: number } } | null {
  const ds = DEEPSEEK_CNY[model];
  if (!ds) return null;
  return {
    peak: { input: ds.peak.inputPerMillion, output: ds.peak.outputPerMillion },
    offPeak: { input: ds.offPeak.inputPerMillion, output: ds.offPeak.outputPerMillion },
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type CostEstimate = {
  inputTokens: number;
  outputTokens: number;
  costCents: number | null;
  model: string;
  unknownPricing: boolean;
};

export function estimateCost(
  sourceText: string,
  model: string,
  contextOverhead = 5000,
  expectedOutputTokens = 800,
): CostEstimate {
  const inputTokens = estimateTokens(sourceText) + contextOverhead;
  const pricing = getPricing(model);
  if (!pricing) {
    return {
      inputTokens,
      outputTokens: expectedOutputTokens,
      costCents: null,
      model,
      unknownPricing: true,
    };
  }
  const usd =
    (pricing.inputPerMillion * inputTokens + pricing.outputPerMillion * expectedOutputTokens) /
    1_000_000;
  return {
    inputTokens,
    outputTokens: expectedOutputTokens,
    costCents: usd * 100,
    model,
    unknownPricing: false,
  };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export function formatCostCents(cents: number | null): string {
  if (cents === null) return "未知";
  if (cents < 0.1) return "<$0.001";
  if (cents < 1) return `~$${(cents / 100).toFixed(4)}`;
  if (cents < 100) return `~$${(cents / 100).toFixed(3)}`;
  return `~$${(cents / 100).toFixed(2)}`;
}
