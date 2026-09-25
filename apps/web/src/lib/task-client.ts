"use client";

import { useCallback, useEffect, useState } from "react";

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "canceled" | "interrupted";

export type TaskKind =
  | "ingest_file"
  | "ingest_url"
  | "ingest_text"
  | "query"
  | "chat"
  | "link_fix";

export type PublicTask = {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  label: string;
  progress: string | null;
  error: string | null;
  attempts: number;
  sourceId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  input: Record<string, unknown>;
  output: unknown;
};

export function isActive(task: PublicTask): boolean {
  return task.status === "pending" || task.status === "running";
}

export const TASK_KIND_LABEL: Record<TaskKind, string> = {
  ingest_file: "文件入库",
  ingest_url: "网址入库",
  ingest_text: "文本入库",
  query: "查询",
  chat: "对话",
  link_fix: "链接修复",
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "排队中",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
  interrupted: "已中断",
};

/** "正在查询…" style label for an in-flight task of a given kind. */
export const TASK_BUSY_LABEL: Record<TaskKind, string> = {
  ingest_file: "正在入库…",
  ingest_url: "正在入库…",
  ingest_text: "正在入库…",
  query: "正在查询…",
  chat: "正在生成回复…",
  link_fix: "正在处理…",
};

export function taskStatusTone(status: TaskStatus): string {
  switch (status) {
    case "succeeded":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "failed":
    case "interrupted":
      return "bg-destructive/10 text-destructive";
    case "canceled":
      return "bg-secondary text-secondary-foreground";
    default:
      return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
}

export async function fetchTasks(
  params = "",
  init?: RequestInit,
): Promise<PublicTask[]> {
  const res = await fetch(`/api/tasks${params}`, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { tasks?: PublicTask[] };
  return data.tasks ?? [];
}

export async function fetchTask(id: string): Promise<PublicTask> {
  const res = await fetch(`/api/tasks/${id}`, { cache: "no-store" });
  const data = (await res.json()) as { task?: PublicTask; error?: string };
  if (!res.ok || !data.task) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.task;
}

export async function cancelTask(id: string): Promise<void> {
  const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
}

/**
 * Polls a task until it finishes, then resolves with the terminal row.
 *
 * Polling (not a hanging request) is the point of the background executor: the
 * work is already in the server's queue, so it does not matter whether this
 * component is alive to watch it.
 */
export async function waitForTask(
  id: string,
  opts: { intervalMs?: number; onTick?: (task: PublicTask) => void } = {},
): Promise<PublicTask> {
  const interval = opts.intervalMs ?? 1500;
  for (;;) {
    const task = await fetchTask(id);
    opts.onTick?.(task);
    if (!isActive(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

type PollOptions = {
  /** Query string appended to /api/tasks, e.g. "?active=1". */
  params: string;
  intervalMs?: number;
  enabled?: boolean;
};

/**
 * Shared polling loop. Pauses while the tab is hidden so a backgrounded
 * window is not hammering the API, and resumes (with an immediate refresh)
 * when the user comes back.
 */
export function useTaskPoll(options: PollOptions) {
  const { params, intervalMs = 2500, enabled = true } = options;
  const [tasks, setTasks] = useState<PublicTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchTasks(params);
      setTasks(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [params]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (stopped) return;
      if (typeof document === "undefined" || !document.hidden) await refresh();
      if (stopped) return;
      timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();

    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, intervalMs, refresh]);

  return { tasks, error, refresh };
}
