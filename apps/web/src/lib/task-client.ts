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
  ingest_file: "文件Ingest",
  ingest_url: "网址Ingest",
  ingest_text: "文本Ingest",
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
  ingest_file: "正在Ingest…",
  ingest_url: "正在Ingest…",
  ingest_text: "正在Ingest…",
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

/**
 * The in-flight chat task for one chat, if there is one.
 *
 * This is how a view re-attaches after a reload: the task outlives the page, so
 * it is found by looking for queued/running work rather than by remembering an
 * id in the browser.
 */
export async function findActiveChatTask(chatId: string): Promise<PublicTask | null> {
  const tasks = await fetchTasks("?active=1");
  return (
    tasks.find(
      (task) => task.kind === "chat" && (task.input as { chatId?: unknown }).chatId === chatId,
    ) ?? null
  );
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

// ---- live output ----------------------------------------------------------

export type LiveTaskSnapshot = {
  text: string;
  progress: string | null;
};

export type LiveTaskHandlers = {
  /** Authoritative replay, sent on connect and after every reconnect. */
  onSnapshot?: (snapshot: LiveTaskSnapshot) => void;
  /** A retry restarted the answer — drop whatever was rendered. */
  onReset?: () => void;
  /** A newly generated chunk of the answer. */
  onDelta?: (text: string) => void;
  /** Phase label ("正在生成回复…") for the stretches with no text yet. */
  onProgress?: (progress: string | null) => void;
  /** The last attempt failed but the task is queued again. */
  onRetrying?: (error: string | null) => void;
};

export type LiveTaskWatch = {
  /** Resolves with the terminal task row, or null when the outcome is unknown. */
  promise: Promise<PublicTask | null>;
  /** Stops watching. The task keeps running — this is a viewer, not a job. */
  close: () => void;
};

/**
 * Watches a background task's live output and resolves when it settles.
 *
 * SSE is the fast path (deltas arrive as the model writes them); polling is the
 * safety net for environments where the stream cannot be established at all.
 * Either way this is only a viewer: closing it, navigating away, or losing the
 * connection never interrupts the task itself.
 */
export function watchTaskLive(id: string, handlers: LiveTaskHandlers = {}): LiveTaskWatch {
  let settled = false;
  let stop: () => void = () => {};
  let settle: (task: PublicTask | null) => void = () => {};

  const promise = new Promise<PublicTask | null>((resolve) => {
    settle = resolve;
    const finish = (task: PublicTask | null): void => {
      if (settled) return;
      settled = true;
      stop();
      resolve(task);
    };

    if (typeof EventSource === "undefined") {
      stop = pollUntilSettled(id, handlers, finish);
      return;
    }

    const source = new EventSource(`/api/tasks/${id}/stream`);
    let connected = false;
    let errorsAfterConnect = 0;
    stop = () => source.close();

    const on = <T>(event: string, fn: (data: T) => void): void => {
      source.addEventListener(event, (e) => {
        const raw = (e as MessageEvent<string>).data;
        try {
          fn(JSON.parse(raw) as T);
        } catch {
          // A malformed frame is not worth tearing the stream down for.
        }
      });
    };

    on<{ text: string; progress: string | null }>("snapshot", (data) => {
      connected = true;
      errorsAfterConnect = 0;
      handlers.onSnapshot?.({ text: data.text, progress: data.progress });
    });
    on<Record<string, never>>("reset", () => handlers.onReset?.());
    on<{ text: string }>("delta", (data) => handlers.onDelta?.(data.text));
    on<{ progress: string | null }>("progress", (data) => handlers.onProgress?.(data.progress));
    on<{ error: string | null }>("retrying", (data) => handlers.onRetrying?.(data.error));
    on<{ task: PublicTask | null }>("done", (data) => finish(data.task));

    source.onerror = () => {
      // Never connected: the route is missing or the server is down. Polling
      // still works, so degrade instead of showing a dead "generating…".
      if (!connected) {
        stop();
        stop = pollUntilSettled(id, handlers, finish);
        return;
      }
      // EventSource reconnects on its own and the server replays a snapshot,
      // which makes a dropped connection invisible. Give up only if it keeps
      // failing — then fall back to polling for the terminal row.
      errorsAfterConnect += 1;
      if (errorsAfterConnect > 5) {
        stop();
        stop = pollUntilSettled(id, handlers, finish);
      }
    };
  });

  return {
    promise,
    close: () => {
      if (settled) return;
      settled = true;
      stop();
      // Resolve rather than leave the caller awaiting forever: stopping the
      // watch is a normal outcome (unmount, navigation), not a hung task.
      settle(null);
    },
  };
}

/** Fallback path: the same polling that predates streaming, plus progress. */
function pollUntilSettled(
  id: string,
  handlers: LiveTaskHandlers,
  finish: (task: PublicTask | null) => void,
): () => void {
  let stopped = false;
  void (async () => {
    try {
      for (;;) {
        const task = await fetchTask(id);
        if (stopped) return;
        handlers.onProgress?.(task.progress);
        if (!isActive(task)) {
          finish(task);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch {
      // Unknown outcome; the caller decides whether to re-read or report.
      if (!stopped) finish(null);
    }
  })();
  return () => {
    stopped = true;
  };
}

type PollOptions = {
  /** Query string appended to /api/tasks, e.g. "?active=1". */
  params: string;
  intervalMs?: number;
  enabled?: boolean;
};/**
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
