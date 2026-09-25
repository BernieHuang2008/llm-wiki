"use client";

import { useState } from "react";

import {
  cancelTask,
  isActive,
  TASK_KIND_LABEL,
  taskStatusTone,
  useTaskPoll,
  type PublicTask,
} from "@/lib/task-client";
import { cn } from "@/lib/utils";

/**
 * Header badge for background work.
 *
 * The executor runs tasks in the server process, so this is purely an
 * observation window: closing the tab, navigating, or ignoring the badge never
 * affects a running task. It exists so "did my upload actually start?" has an
 * answer from any page.
 */
export function TasksPanel() {
  const [open, setOpen] = useState(false);
  const { tasks, error } = useTaskPoll({ params: "?active=1" });

  const active = (tasks ?? []).filter(isActive);
  const running = active.filter((t) => t.status === "running").length;
  const queued = active.length - running;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium",
          active.length > 0
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-border bg-muted/60 text-muted-foreground hover:text-foreground",
        )}
        title="后台任务：由服务端执行器运行，关闭页面也不会中断"
        aria-label="后台任务"
      >
        <span aria-hidden className={active.length > 0 ? "animate-pulse" : undefined}>
          ◍
        </span>
        <span>任务</span>
        {active.length > 0 ? <span className="tabular-nums">{active.length}</span> : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-40 mt-2 w-80 rounded-md border border-border bg-popover p-3 text-ui shadow-lg">
          <div className="mb-2 flex items-baseline justify-between">
            <p className="font-medium">后台任务</p>
            <p className="text-[11px] text-muted-foreground">
              {running} 执行中 · {queued} 排队中
            </p>
          </div>

          {error ? (
            <p className="rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              无法读取任务队列：{error}
            </p>
          ) : null}

          {active.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              没有正在执行的任务。提交入库、查询、对话或链接修复后，进度会显示在这里。
            </p>
          ) : (
            <ul className="max-h-72 space-y-1.5 overflow-y-auto">
              {active.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </ul>
          )}

          <p className="mt-2 border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
            任务在服务端持续执行，关闭页面或刷新都不会中断。
          </p>
        </div>
      ) : null}
    </div>
  );
}

function TaskRow({ task }: { task: PublicTask }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCancel() {
    setBusy(true);
    setError(null);
    try {
      await cancelTask(task.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded border border-border/70 px-2 py-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-medium">{task.label}</p>
          <p className="text-[10px] text-muted-foreground">
            {TASK_KIND_LABEL[task.kind]} ·{" "}
            {task.progress ?? (task.status === "pending" ? "排队等待执行…" : "执行中…")}
          </p>
        </div>
        <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px]", taskStatusTone(task.status))}>
          {task.status === "pending" ? "排队中" : "执行中"}
        </span>
      </div>
      {error ? <p className="mt-1 text-[10px] text-destructive">{error}</p> : null}
      <div className="mt-1 text-right">
        <button
          type="button"
          onClick={() => void onCancel()}
          disabled={busy}
          className="text-[10px] text-muted-foreground underline hover:text-foreground"
        >
          {busy ? "取消中…" : "取消"}
        </button>
      </div>
    </li>
  );
}
