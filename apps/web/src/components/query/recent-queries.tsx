"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type StoredRun = {
  id: string;
  kind: "query" | "lint";
  label: string;
  model: string | null;
  created_at: string;
};

function relativeFromIso(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffMin = Math.floor((Date.now() - t) / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  return iso.slice(0, 10);
}

/**
 * Recent queries.
 *
 * The list is bounded by both a count and a time window (whichever is
 * smaller) — the server owns those bounds, so this panel and the API can never
 * disagree about what "recent" means.
 *
 * `refreshNonce` lets the parent force a refetch right after a new query
 * finishes; polling would be wasted work here because queries only appear when
 * the user asks one.
 */
export function RecentQueries({ refreshNonce = 0 }: { refreshNonce?: number }) {
  const [runs, setRuns] = useState<StoredRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/runs?kind=query", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { runs: StoredRun[]; windowDays?: number };
      setRuns(data.runs);
      setWindowDays(data.windowDays ?? null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshNonce]);

  if (error) {
    return (
      <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
        无法读取查询记录：{error}
      </p>
    );
  }

  if (runs === null) {
    return <p className="text-sm text-muted-foreground">正在载入查询记录…</p>;
  }

  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        还没有查询记录。提问后，结果会保存下来，可随时点开复查。
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border/60 text-sm">
        {runs.map((run) => (
          <li key={run.id}>
            <Link
              href={`/query/${run.id}`}
              className="flex flex-wrap items-baseline gap-2 rounded px-1 py-1.5 hover:bg-accent/60"
            >
              <span className="min-w-0 flex-1 truncate text-foreground">{run.label}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground/70">
                {relativeFromIso(run.created_at)}
              </span>
              <span className="shrink-0 text-[11px] text-primary">查看详情 →</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        显示最近 {windowDays ?? 14} 天内、最多 50 条记录（取更少的一种）。
      </p>
    </div>
  );
}
