"use client";

import {
  estimateCost,
  formatCostCents,
  formatTokens,
  getDeepSeekCnyPricing,
} from "@/lib/cost-estimate";

type Props = {
  text: string;
  model: string;
  /** Extra input tokens from system + index + relevant pages. */
  contextOverhead?: number;
  /** Typical response size for this operation. */
  expectedOutputTokens?: number;
};

export function CostPreview({ text, model, contextOverhead, expectedOutputTokens }: Props) {
  if (!text.trim()) {
    return (
      <p className="text-xs text-muted-foreground">
        输入内容后，这里会显示费用估算。
      </p>
    );
  }
  const est = estimateCost(text, model, contextOverhead, expectedOutputTokens);
  const cny = getDeepSeekCnyPricing(model);
  return (
    <p className="text-xs text-muted-foreground">
      预计：{" "}
      <strong className="text-foreground">{formatCostCents(est.costCents)}</strong>{" "}
      <span className="tabular-nums">
        （输入 {formatTokens(est.inputTokens)} / 输出 {formatTokens(est.outputTokens)} 令牌）
      </span>{" "}
      · <code>{est.model}</code>
      {est.unknownPricing ? (
        <span className="ml-1 italic">该模型的价格未知</span>
      ) : null}
      {/* DeepSeek publishes CNY rates that halve outside Beijing peak hours;
          showing them verbatim avoids an unexplained exchange-rate gap. */}
      {cny ? (
        <span className="ml-1">
          · 官方价：输入 ¥{cny.peak.input}/¥{cny.offPeak.input}、输出 ¥{cny.peak.output}/
          {cny.offPeak.output} 每百万令牌（高峰/空闲，按 ¥7.2≈$1 折算）
        </span>
      ) : null}
    </p>
  );
}
