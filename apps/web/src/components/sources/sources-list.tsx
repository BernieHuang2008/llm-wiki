"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

export type SourceItem = {
  id: string;
  title: string;
  filename: string;
  originalName: string | null;
  format: string;
  sizeBytes: number;
  addedAt: string;
  url: string | null;
  error: string | null;
  /** A queued/running task is already handling this source. */
  inFlight: boolean;
};

// Format labels stay plain text — easier on the eye than emoji for a
// reading-first product, and they match the rest of the app's chrome.
const FORMAT_LABEL: Record<string, string> = {
  markdown: "MD",
  md: "MD",
  text: "TXT",
  txt: "TXT",
  html: "HTML",
  url: "URL",
  pdf: "PDF",
  docx: "DOCX",
  pptx: "PPTX",
  xlsx: "XLSX",
  image: "IMG",
};

export function relativeDate(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return d.toISOString().slice(0, 10);
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

type Props = {
  // Bumping this from the parent forces a re-fetch after a successful submit.
  refreshNonce: number;
  /** Called after retry/delete so the parent can refresh its task queue too. */
  onChanged?: () => void;
};

/**
 * The "still needs me" list: uploads that are queued or running, ingest
 * failures waiting for a retry, and approval-gate proposals waiting for a
 * decision. Successfully ingested sources are intentionally absent — they are
 * already part of the wiki and listing them buried the actionable rows.
 */
export function SourcesList({ refreshNonce, onChanged }: Props) {
  const [sources, setSources] = useState<SourceItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionFlash, setActionFlash] = useState<string | null>(null);

  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch("/api/sources", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { sources: SourceItem[] };
      setSources(data.sources);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void fetchSources();
  }, [fetchSources, refreshNonce]);

  async function onRetry(s: SourceItem) {
    setBusyId(s.id);
    setActionFlash(null);
    setError(null);
    console.log(`%c[入库重试] 重新提交来源："${s.title}"`, "color: #3b82f6; font-weight: bold;");
    try {
      const res = await fetch(`/api/sources/${s.id}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setActionFlash("已重新加入后台任务队列，可关闭页面，任务会继续执行。");
      await fetchSources();
      onChanged?.();
    } catch (err) {
      console.error(`[入库重试失败] "${s.title}"：${(err as Error).message}`);
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(s: SourceItem) {
    const msg = s.inFlight
      ? `移除"${s.title}"？正在执行的入库任务会被取消，原始文件会移动到 .llm-wiki/trash/raw/（30 天内可恢复）。`
      : `移除"${s.title}"（尚未成功入库）？原始文件会移动到 .llm-wiki/trash/raw/（30 天内可恢复）。`;
    if (!confirm(msg)) return;

    setBusyId(s.id);
    setActionFlash(null);
    setError(null);
    try {
      const res = await fetch(`/api/sources/${s.id}/delete`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setActionFlash("已移除。");
      await fetchSources();
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (error && sources === null) {
    return (
      <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
        无法读取来源列表：{error}
      </p>
    );
  }

  if (sources === null) {
    return <p className="text-sm text-muted-foreground">正在载入来源…</p>;
  }

  if (sources.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        暂无需处理的来源。已成功入库的条目已从列表中隐去，可在
        <Link href="/wiki" className="mx-1 underline underline-offset-2">
          Wiki
        </Link>
        中查看它们的成果。
      </p>
    );
  }

  const failedCount = sources.filter((s) => !s.inFlight && s.error).length;
  const waitingCount = sources.filter((s) => s.inFlight || !s.error).length;

  return (
    <div className="space-y-3">
      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
        {failedCount > 0
          ? `${failedCount} 个来源入库失败，可点击"重试"重新排队。`
          : `${waitingCount} 个来源正在后台排队或执行，可随时关闭页面。`}
      </p>

      {actionFlash ? (
        <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          {actionFlash}
        </p>
      ) : null}
      {error && sources !== null ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <ul className="divide-y divide-border">
        {sources.map((s) => {
          const formatBadge = FORMAT_LABEL[s.format] ?? s.format.toUpperCase();
          const isBusy = busyId === s.id;
          return (
            <li
              key={s.id}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2.5"
            >
              <div className="min-w-0 flex-1">
                {/* Title links to /sources/[id]; buttons sit outside the link
                    so clicks don't bubble. */}
                <Link
                  href={`/sources/${s.id}`}
                  prefetch
                  className="block min-w-0 hover:text-primary"
                >
                  <p className="truncate text-sm font-medium">{s.title}</p>
                </Link>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  <span className="font-mono">{formatBadge}</span>
                  {" · "}
                  {formatSize(s.sizeBytes)}
                  {" · 添加于 "}
                  {relativeDate(s.addedAt)}
                </p>
                {s.error ? (
                  <p className="mt-1 text-[11px] text-destructive">
                    上次失败：{s.error.slice(0, 160)}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2 text-[11px]">
                <span
                  className={
                    s.inFlight
                      ? "rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-300"
                      : s.error
                        ? "rounded-full bg-destructive/10 px-2 py-0.5 text-destructive"
                        : "rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground"
                  }
                >
                  {s.inFlight ? "处理中" : s.error ? "失败" : "待处理"}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void onRetry(s)}
                  disabled={busyId !== null}
                >
                  {isBusy ? "提交中…" : "重试"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void onDelete(s)}
                  disabled={busyId !== null}
                  title="从列表移除，原始文件进入 .llm-wiki/trash/raw/"
                >
                  {isBusy ? "移除中…" : "删除"}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
