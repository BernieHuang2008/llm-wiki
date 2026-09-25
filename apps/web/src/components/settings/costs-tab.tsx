"use client";

import { useEffect, useState } from "react";

type BreakdownRow = {
  model: string;
  operation: "ingest" | "query" | "lint" | "chat";
  call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_cents: number;
};

type UsageResponse = {
  breakdown: BreakdownRow[];
  totals: {
    cost_cents: number;
    calls: number;
    input_tokens: number;
    output_tokens: number;
  };
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function fmtCost(cents: number): string {
  if (cents === 0) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export function CostsTab() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const res = await fetch("/api/usage", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as UsageResponse;
      setData(json);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (error) {
    return (
      <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (!data) return <p className="text-sm text-muted-foreground">加载中…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">累计用量</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          统计这个 wiki 发起的每一次大语言模型调用。数据保存在{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            .llm-wiki/meta.sqlite
          </code>
          ；删除该文件即可重置这些数字。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="调用次数" value={data.totals.calls.toString()} />
        <Metric label="输入 token" value={fmtTokens(data.totals.input_tokens)} />
        <Metric label="输出 token" value={fmtTokens(data.totals.output_tokens)} />
        <Metric label="已记录成本" value={fmtCost(data.totals.cost_cents)} />
      </div>

      {data.breakdown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          尚未记录任何大语言模型调用。Ingest一个Source或执行一次查询即可开始统计。
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-secondary/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">模型</th>
                <th className="px-3 py-2 font-medium">操作</th>
                <th className="px-3 py-2 text-right font-medium">调用次数</th>
                <th className="px-3 py-2 text-right font-medium">输入</th>
                <th className="px-3 py-2 text-right font-medium">输出</th>
                <th className="px-3 py-2 text-right font-medium">成本</th>
              </tr>
            </thead>
            <tbody>
              {data.breakdown.map((r, i) => (
                <tr key={`${r.model}-${r.operation}-${i}`} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-[12px]">{r.model}</td>
                  <td className="px-3 py-2 capitalize">{r.operation}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.call_count}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtTokens(r.total_input_tokens)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtTokens(r.total_output_tokens)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtCost(r.total_cost_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        只有当本地价格表认识该模型时才会记录成本。未知模型在成本列中显示 <code>—</code>
        ；token 数量始终是准确的。价格表是代码里写死的常量（OpenRouter 为美元，
        DeepSeek 为官方人民币价并按 ¥7.2≈$1 折算），不联网查询。
      </p>
      <p className="text-xs text-muted-foreground">
        DeepSeek 分高峰／空闲两档计费（北京时间周一至周五 9:00–12:00、14:00–18:00
        为高峰，其余时间折半）。此表按<strong>峰值价</strong>计入，所以 DeepSeek
        的实际花费通常低于这里显示的金额。
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
