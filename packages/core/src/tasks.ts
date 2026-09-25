// Background task layer.
//
// Every LLM-touching operation (ingest, query, chat, link fixes) is submitted
// as a row in the `tasks` table and executed by a long-lived executor in the
// server process. The HTTP request only records the task, so closing the
// browser, navigating away, or a page reload can no longer interrupt the work.
//
// The table lives in the wiki's own meta.sqlite, so tasks survive an app
// restart and are recovered by the executor's startup sweep.

import { randomUUID } from "node:crypto";

import type { Db } from "./db";

export type TaskKind =
  | "ingest_file"
  | "ingest_url"
  | "ingest_text"
  | "query"
  | "chat"
  | "lint_run"
  | "link_fix";

export const TASK_KINDS: readonly TaskKind[] = [
  "ingest_file",
  "ingest_url",
  "ingest_text",
  "query",
  "chat",
  "lint_run",
  "link_fix",
] as const;

export type TaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "interrupted",
] as const;

/** Finished tasks: nothing will change them again without an explicit retry. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "succeeded",
  "failed",
  "canceled",
  "interrupted",
] as const;

/** Tasks that are not finished — the UI's "后台任务" list is exactly this set. */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ["pending", "running"] as const;

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return status === "pending" || status === "running";
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return !isActiveTaskStatus(status);
}

export function isIngestKind(kind: TaskKind): boolean {
  return kind === "ingest_file" || kind === "ingest_url" || kind === "ingest_text";
}

/** Human-readable Chinese label for a task kind; used by the UI and the log. */
export function taskKindLabel(kind: TaskKind): string {
  switch (kind) {
    case "ingest_file":
      return "文件Ingest";
    case "ingest_url":
      return "网址Ingest";
    case "ingest_text":
      return "文本Ingest";
    case "query":
      return "查询";
    case "chat":
      return "对话";
    case "lint_run":
      return "体检";
    case "link_fix":
      return "链接修复";
  }
}

export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "pending":
      return "排队中";
    case "running":
      return "执行中";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "canceled":
      return "已取消";
    case "interrupted":
      return "已中断";
  }
}

// ---- payloads -------------------------------------------------------------

export type IngestFileTaskInput = {
  sourceId: string;
  /** Raw filename as uploaded (drives format detection + file extension). */
  filename: string;
  title: string;
  sizeBytes: number;
  /** Explicit model override; falls back to the wiki's ingest/vision model. */
  model?: string;
};

export type IngestUrlTaskInput = {
  sourceId: string;
  url: string;
  title: string;
  model?: string;
};

export type IngestTextTaskInput = {
  sourceId: string;
  title: string;
  /** Absent for retries — the raw file on disk is the source of truth then. */
  text?: string;
  model?: string;
};

export type QueryTaskInput = {
  question: string;
  model?: string;
};

export type LintRunTaskInput = {
  /** Optional model override; defaults to the wiki's lint slot. */
  model?: string;
};

export type ChatTaskInput = {
  chatId: string;
  message: string;
  modelOverride?: string;
  /** True when the route already appended the user turn before enqueueing. */
  userMessageSaved?: boolean;
};

export type LinkFixTaskInput = {
  op: "remove-broken-link" | "rebuild-index" | "fix-all-broken-links" | "create-stub-page" | "apply-suggested-fix";
  pageSlug?: string;
  brokenSlug?: string;
  items?: Array<{ pageSlug: string; brokenSlug: string }>;
  missingSlug?: string;
  issueDescription?: string;
  fixInstruction?: string;
};

export type TaskInput =
  | IngestFileTaskInput
  | IngestUrlTaskInput
  | IngestTextTaskInput
  | QueryTaskInput
  | ChatTaskInput
  | LintRunTaskInput
  | LinkFixTaskInput;

export type TaskRow = {
  id: string;
  wiki_path: string;
  kind: TaskKind;
  status: TaskStatus;
  input: TaskInput;
  output: unknown;
  error: string | null;
  progress: string | null;
  attempts: number;
  source_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

// ---- row <-> db -----------------------------------------------------------

type TaskDbRow = {
  id: string;
  wiki_path: string;
  kind: string;
  status: string;
  input: string;
  output: string | null;
  error: string | null;
  progress: string | null;
  attempts: number;
  source_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A malformed payload means a hand-edited DB or a partial write. Surface
    // the fallback rather than throwing inside a list query for every row.
    return fallback;
  }
}

function rowFromDb(r: TaskDbRow): TaskRow {
  if (!TASK_KINDS.includes(r.kind as TaskKind)) {
    throw new Error(`tasks.${r.id}: unknown kind in DB: ${r.kind}`);
  }
  if (!TASK_STATUSES.includes(r.status as TaskStatus)) {
    throw new Error(`tasks.${r.id}: unknown status in DB: ${r.status}`);
  }
  return {
    id: r.id,
    wiki_path: r.wiki_path,
    kind: r.kind as TaskKind,
    status: r.status as TaskStatus,
    input: parseJson<TaskInput>(r.input, {} as TaskInput),
    output: parseJson<unknown>(r.output, null),
    error: r.error,
    progress: r.progress,
    attempts: r.attempts,
    source_id: r.source_id,
    created_at: r.created_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    updated_at: r.updated_at,
  };
}

// ---- low-level CRUD (internal; the public wrappers below own the lifecycle) -

export function insertTaskRow(db: Db, task: TaskRow): void {
  db.prepare(
    `INSERT INTO tasks (id, wiki_path, kind, status, input, output, error, progress, attempts,
                        source_id, created_at, started_at, finished_at, updated_at)
     VALUES (@id, @wiki_path, @kind, @status, @input, @output, @error, @progress, @attempts,
             @source_id, @created_at, @started_at, @finished_at, @updated_at)`,
  ).run({
    ...task,
    input: JSON.stringify(task.input),
    output: task.output === null || task.output === undefined ? null : JSON.stringify(task.output),
  });
}

export function getTaskRow(db: Db, id: string): TaskRow | null {
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskDbRow | undefined;
  return row ? rowFromDb(row) : null;
}

export function listTaskRowList(db: Db, opts: { statuses?: readonly TaskStatus[]; limit?: number } = {}): TaskRow[] {
  const limit = opts.limit ?? 100;
  if (opts.statuses && opts.statuses.length > 0) {
    const placeholders = opts.statuses.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at ASC LIMIT ?`)
      .all(...opts.statuses, limit) as TaskDbRow[];
    return rows.map(rowFromDb);
  }
  const rows = db
    .prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as TaskDbRow[];
  return rows.map(rowFromDb);
}

export function listTaskRowsForSource(db: Db, sourceId: string): TaskRow[] {
  const rows = db
    .prepare(`SELECT * FROM tasks WHERE source_id = ? ORDER BY created_at DESC`)
    .all(sourceId) as TaskDbRow[];
  return rows.map(rowFromDb);
}

export function deleteTaskRow(db: Db, id: string): void {
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
}

export function pruneFinishedTasks(db: Db, olderThanMs: number): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = db
    .prepare(
      `DELETE FROM tasks
        WHERE status IN ('succeeded', 'failed', 'canceled', 'interrupted')
          AND finished_at IS NOT NULL
          AND finished_at < ?`,
    )
    .run(cutoff);
  return info.changes;
}

// ---- public lifecycle API -------------------------------------------------

export type CreateTaskOptions = {
  /** Defaults to the executor's lane budget; ingest defaults to serial. */
  maxAttempts?: number;
};

/**
 * Records a new pending task. Returns the stored row so the caller can echo the
 * id (and status) straight back to the browser without a second read.
 */
export function createTask(
  db: Db,
  wikiPath: string,
  kind: TaskKind,
  input: TaskInput,
  opts: CreateTaskOptions = {},
): TaskRow {
  const now = new Date().toISOString();
  const row: TaskRow = {
    id: randomUUID(),
    wiki_path: wikiPath,
    kind,
    status: "pending",
    input,
    output: null,
    error: null,
    progress: null,
    attempts: opts.maxAttempts ?? 1,
    source_id: sourceIdFor(input),
    created_at: now,
    started_at: null,
    finished_at: null,
    updated_at: now,
  };
  insertTaskRow(db, row);
  return row;
}

function sourceIdFor(input: TaskInput): string | null {
  return typeof (input as { sourceId?: unknown }).sourceId === "string"
    ? (input as { sourceId: string }).sourceId
    : null;
}

/**
 * Atomically claims the oldest pending task, moving it to `running`.
 *
 * The transaction is what makes this safe with more than one worker: SQLite
 * serializes the write, so two workers racing for the same row cannot both win.
 * Returns null when the queue is empty.
 */
export function claimNextTask(db: Db, kinds?: readonly TaskKind[]): TaskRow | null {
  const claim = db.transaction((): TaskRow | null => {
    const filter =
      kinds && kinds.length > 0
        ? `AND kind IN (${kinds.map(() => "?").join(", ")})`
        : "";
    const row = db
      .prepare(
        `SELECT * FROM tasks WHERE status = 'pending' ${filter} ORDER BY created_at ASC LIMIT 1`,
      )
      .get(...(kinds ?? [])) as TaskDbRow | undefined;
    if (!row) return null;
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `UPDATE tasks SET status = 'running', started_at = ?, updated_at = ?, progress = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(now, now, "已开始执行", row.id);
    if (info.changes === 0) return null;
    return { ...rowFromDb(row), status: "running", started_at: now, updated_at: now, progress: "已开始执行" };
  });
  return claim();
}

/** Moves a running task back to pending — used for retryable LLM failures. */
export function requeueTask(db: Db, id: string, note: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tasks SET status = 'pending', started_at = NULL, progress = ?, updated_at = ?
      WHERE id = ?`,
  ).run(note, now, id);
}

export function setTaskProgress(db: Db, id: string, progress: string): void {
  db.prepare(`UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?`).run(
    progress,
    new Date().toISOString(),
    id,
  );
}

export function finishTask(db: Db, id: string, output: unknown): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tasks SET status = 'succeeded', output = ?, error = NULL, progress = ?, finished_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    output === undefined ? null : JSON.stringify(output),
    "已完成",
    now,
    now,
    id,
  );
}

export function failTask(
  db: Db,
  id: string,
  error: string,
  status: Extract<TaskStatus, "failed" | "interrupted"> = "failed",
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tasks SET status = ?, error = ?, progress = NULL, finished_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(status, error, now, now, id);
}

export function cancelTask(db: Db, id: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tasks SET status = 'canceled', progress = NULL, finished_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'running')`,
  ).run(now, now, id);
}

/**
 * Executor startup sweep. A `running` row can only mean the previous process
 * died mid-task (nothing else sets that status), so it is marked interrupted
 * rather than silently re-run — re-running an ingest could double-write pages.
 */
export function recoverInterruptedTasks(db: Db): number {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE tasks
          SET status = 'interrupted',
              error = '任务在上一进程中被中断（可能是应用重启或崩溃），请重试。',
              finished_at = ?,
              updated_at = ?
        WHERE status = 'running'`,
    )
    .run(now, now);
  return info.changes;
}

/**
 * Finished ingest tasks that never marked their source ingested are stuck:
 * the wiki has a source row nobody will ever process again.
 */
export function markStuckIngestTasksAsFailed(db: Db, sourceId: string, reason: string): number {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE tasks
          SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
        WHERE source_id = ?
          AND status IN ('pending', 'running')`,
    )
    .run(reason, now, now, sourceId);
  return info.changes;
}

/** Active tasks across every kind — drives the header badge + sources queue. */
export function listActiveTasks(db: Db): TaskRow[] {
  return listTaskRowList(db, { statuses: ACTIVE_TASK_STATUSES, limit: 200 });
}

export function listTasksForSource(db: Db, sourceId: string): TaskRow[] {
  return listTaskRowsForSource(db, sourceId);
}

export function getTask(db: Db, id: string): TaskRow | null {
  return getTaskRow(db, id);
}

export function deleteTask(db: Db, id: string): void {
  deleteTaskRow(db, id);
}

