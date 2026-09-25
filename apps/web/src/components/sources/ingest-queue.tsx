"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  cancelTask,
  isActive,
  TASK_KIND_LABEL,
  taskStatusTone,
  useTaskPoll,
  type PublicTask,
} from "@/lib/task-client";

type IngestOutput = {
  kind?: "preview" | "applied";
  summary?: string;
  model?: string;
  newPages?: Array<{ slug: string; title: string; type: string }>;
  pageUpdates?: Array<{ slug: string; updateReason: string }>;
  contradictions?: Array<{ description: string; pages: string[] }>;
  fullResponse?: unknown;
};

const INGEST_KINDS = ["ingest_file", "ingest_url", "ingest_text"];

function isIngest(task: PublicTask): boolean {
  return INGEST_KINDS.includes(task.kind);
}

function outputOf(task: PublicTask): IngestOutput {
  return (task.output ?? {}) as IngestOutput;
}

/**
 * Live view of the ingest queue plus the approval gate.
 *
 * Rendered next to the upload form because that is where the user just acted;
 * the global header panel covers the rest of the app. Every row here reflects
 * a task that lives in the server's queue, so nothing on this page is what
 * keeps the work alive.
 */
export function IngestQueue({ refreshNonce }: { refreshNonce: number }) {
  const { tasks, error, refresh } = useTaskPoll({ params: "?limit=50" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { active, previews } = useMemo(() => {
    const list = (tasks ?? []).filter(isIngest);
    return {
      active: list.filter(isActive),
      previews: list.filter((t) => t.status === "succeeded" && outputOf(t).kind === "preview"),
    };
  }, [tasks]);

  // A submission bumps the nonce; refresh immediately instead of waiting for
  // the next poll tick.
  useEffect(() => {
    if (refreshNonce > 0) void refresh();
  }, [refreshNonce, refresh]);

  async function onCancel(task: PublicTask) {
    setBusyId(task.id);
    setActionError(null);
    try {
      await cancelTask(task.id);
      setFlash("已取消排队中的任务。");
      await refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function onApply(task: PublicTask) {
    setBusyId(task.id);
    setActionError(null);
    try {
      const res = await fetch("/api/ingest/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId: task.sourceId,
          response: outputOf(task).fullResponse,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setFlash("已写入 wiki。");
      await refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function onDiscard(task: PublicTask) {
    if (
      !confirm(
        "放弃这份提案？原始文件会移动到 .llm-wiki/trash/raw/，该条目将从列表中移除，30 天内可恢复。",
      )
    ) {
      return;
    }
    setBusyId(task.id);
    setActionError(null);
    try {
      const res = await fetch(`/api/sources/${task.sourceId}/delete`, { method: "POST" });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setFlash("已放弃该提案。");
      await refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (tasks === null && !error) {
    return <p className="text-sm text-muted-foreground">正在载入任务队列…</p>;
  }

  if (active.length === 0 && previews.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {error ? `无法读取任务队列：${error}` : "当前没有排队或执行中的入库任务。"}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {active.length > 0 ? (
        <ul className="space-y-2">
          {active.map((task) => (
            <li
              key={task.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-background px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{task.label}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {TASK_KIND_LABEL[task.kind]}
                  {" · "}
                  {task.progress ?? (task.status === "pending" ? "排队等待执行…" : "执行中…")}
                  {task.attempts > 1 ? ` · 第 ${task.attempts} 次尝试` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] ${taskStatusTone(task.status)}`}
                >
                  {task.status === "pending" ? "排队中" : "执行中"}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void onCancel(task)}
                  disabled={busyId !== null}
                >
                  {busyId === task.id ? "取消中…" : "取消"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {previews.map((task) => {
        const out = outputOf(task);
        return (
          <div
            key={task.id}
            className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100"
          >
            <div>
              <strong>提案已生成，等待确认。</strong>
              <span className="ml-1">
                审批开关已开启（设置 → 通用），尚未写入 wiki。来源：
                <span className="font-medium"> {task.label}</span>
              </span>
            </div>
            {out.summary ? (
              <p className="text-xs">
                <strong>摘要：</strong>
                {out.summary}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 border-t border-amber-500/30 pt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onApply(task)}
                disabled={busyId !== null}
              >
                {busyId === task.id ? "写入中…" : "应用更改"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void onDiscard(task)}
                disabled={busyId !== null}
              >
                放弃
              </Button>
              <span className="text-[11px] text-amber-800/70 dark:text-amber-200/70">
                应用等同于一次正常的入库写入。
              </span>
            </div>

            {out.newPages && out.newPages.length > 0 ? (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  新页面
                </h3>
                <ul className="mt-1 space-y-0.5">
                  {out.newPages.map((p) => (
                    <li key={p.slug}>
                      <Link href={`/wiki/${p.slug}`} className="underline underline-offset-2">
                        {p.slug}
                      </Link>{" "}
                      — {p.title} <span className="text-muted-foreground">（{p.type}）</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {out.pageUpdates && out.pageUpdates.length > 0 ? (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  更新的页面
                </h3>
                <ul className="mt-1 space-y-0.5">
                  {out.pageUpdates.map((p) => (
                    <li key={p.slug}>
                      <Link href={`/wiki/${p.slug}`} className="underline underline-offset-2">
                        {p.slug}
                      </Link>{" "}
                      — {p.updateReason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {out.contradictions && out.contradictions.length > 0 ? (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  标记的矛盾
                </h3>
                <ul className="mt-1 space-y-0.5">
                  {out.contradictions.map((c, i) => (
                    <li key={i}>
                      {c.description}{" "}
                      <span className="text-muted-foreground">[{c.pages.join(", ")}]</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        );
      })}

      {flash ? (
        <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          {flash}
        </p>
      ) : null}
      {actionError ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
