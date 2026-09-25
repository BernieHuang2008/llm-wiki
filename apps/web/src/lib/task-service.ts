// Task submission + UI-shaped reads.
//
// Routes stay thin: they parse a request, hand the payload to `submitTask`,
// and return 202 with the recorded task. Everything that touches the LLM runs
// later in the executor (see `@/lib/task-executor`), so nothing here awaits
// generation.

import { extname } from "node:path";

import {
  appendUserTurn,
  createTask,
  getChat,
  getSource,
  getTask,
  isActiveTaskStatus,
  listTaskRowList,
  listSourceRows,
  markStuckIngestTasksAsFailed,
  saveRawSource,
  type Db,
  type LinkFixTaskInput,
  type SourceRow,
  type TaskInput,
  type TaskKind,
  type TaskRow,
  type TaskStatus,
} from "@llm-wiki/core";
import { fetchAndExtractUrl } from "@llm-wiki/ingestion";

import { detectSourceFormat, extractBuffer } from "@/lib/server-ingestion";
import {
  openWikiContext,
  warnIfExecutorMissing,
  type WikiContext,
} from "@/lib/server-wiki";
// Side-effect import: `task-executor` registers the wiki-context hook that
// starts the worker lanes, and importing it here guarantees the module is in
// the server bundle. Without a real import nothing referenced it and the
// bundler dropped it, so every submitted task sat in the queue forever.
import { startTaskExecutor } from "@/lib/task-executor";

// Belt-and-braces: the module-level hook covers the normal path, but starting
// the lanes outright as soon as a route that touches tasks is loaded removes
// any dependency on hook ordering.
startTaskExecutor();
// Loud if the import above is ever removed — otherwise this failure mode looks
// like a very slow model rather than a wiring bug.
warnIfExecutorMissing();

export type SubmitSuccess = {
  ok: true;
  task: PublicTask;
  tasks?: PublicTask[];
  taskIds?: string[];
  sourceId?: string;
};

export type SubmitFailure = {
  ok: false;
  error: string;
  status: number;
  type?: string;
};

export type SubmitResult = SubmitSuccess | SubmitFailure;

/** A task row with the payload trimmed of anything the browser need not see. */
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
  /** Raw payload — kept for ingest text tasks so the UI can retry them. */
  input: TaskInput;
  output: unknown;
};

export function toPublicTask(task: TaskRow): PublicTask {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    label: taskLabel(task),
    progress: task.progress,
    error: task.error,
    attempts: task.attempts,
    sourceId: task.source_id,
    createdAt: task.created_at,
    startedAt: task.started_at,
    finishedAt: task.finished_at,
    input: task.input,
    output: task.output,
  };
}

function taskLabel(task: TaskRow): string {
  const input = task.input as Record<string, unknown>;
  if (typeof input["title"] === "string" && input["title"].trim()) return input["title"];
  if (typeof input["url"] === "string") return input["url"];
  if (typeof input["question"] === "string") return input["question"];
  if (typeof input["message"] === "string") return input["message"];
  if (typeof input["sourceId"] === "string") return input["sourceId"];
  return task.kind;
}

export function listTaskRowsForUi(
  db: Db,
  opts: { statuses?: readonly TaskStatus[]; limit?: number; sourceId?: string } = {},
): PublicTask[] {
  if (opts.sourceId) {
    return db
      .prepare(`SELECT * FROM tasks WHERE source_id = ? ORDER BY created_at ASC`)
      .all(opts.sourceId)
      .map((row) => toPublicTask(row as TaskRow));
  }
  return listTaskRowList(db, {
    ...(opts.statuses ? { statuses: opts.statuses } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
  }).map(toPublicTask);
}

export function listActiveTasksForUi(db: Db): PublicTask[] {
  return listTaskRowList(db, { statuses: ["pending", "running"], limit: 200 }).map(toPublicTask);
}

export function getTaskForUi(db: Db, id: string): PublicTask | null {
  const row = getTask(db, id);
  return row ? toPublicTask(row) : null;
}

// ---- submission -----------------------------------------------------------

export async function submitTask(
  type: string,
  body: Record<string, unknown>,
): Promise<SubmitResult> {
  const ctx = await openWikiContext();
  try {
    switch (type) {
      case "ingest":
        return await submitIngest(ctx, body);
      case "query":
        return submitQuery(ctx, body);
      case "chat":
        return await submitChat(ctx, body);
      case "lint_fix":
        return submitLintFix(ctx, body);
      default:
        return {
          ok: false,
          status: 400,
          error: `未知任务类型：${type}`,
          type: "UnknownTaskType",
        };
    }
  } finally {
    ctx.db.close();
  }
}

async function submitIngest(
  ctx: WikiContext,
  body: Record<string, unknown>,
): Promise<SubmitResult> {
  const form = body["form"];
  if (form instanceof FormData) return submitIngestFiles(ctx, form);

  const title = str(body["title"]);
  const model = str(body["model"]);
  const url = str(body["url"]);
  const text = str(body["text"]);

  if (url) return submitIngestUrl(ctx, { url, title, model });
  if (text) return submitIngestText(ctx, { text, title, model });

  return {
    ok: false,
    status: 400,
    error: "请求需包含 text、url，或 multipart 形式的 file 字段",
  };
}

/**
 * One upload → one source row → one task. Dropping five files in the picker
 * therefore produces five independent tasks, each with its own status, so one
 * failure cannot hold up the rest.
 */
async function submitIngestFiles(ctx: WikiContext, form: FormData): Promise<SubmitResult> {
  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    return { ok: false, status: 400, error: "multipart 请求中缺少 file 字段" };
  }

  const titleOverride = str(form.get("title"));
  const model = str(form.get("model"));
  const tasks: PublicTask[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const filename = file.name || "upload";
    const buffer = Buffer.from(await file.arrayBuffer());
    const format = detectSourceFormat(filename, buffer);

    // Fail fast on a file we cannot parse at all — better to reject it at
    // upload time than to create a task that is guaranteed to fail.
    let resolvedTitle = titleOverride;
    try {
      const extracted = await extractBuffer(format, buffer, filename);
      if (!resolvedTitle) resolvedTitle = extracted.title;
      if ("title" in extracted && resolvedTitle) extracted.title = resolvedTitle;
      if (!resolvedTitle) resolvedTitle = filename;
    } catch (err) {
      skipped.push(`${filename}（${(err as Error).message}）`);
      continue;
    }

    const saved = await saveRawSource({
      wikiPath: ctx.wikiPath,
      db: ctx.db,
      buffer,
      ext: extname(filename) || `.${format}`,
      format,
      title: resolvedTitle,
      originalName: filename,
    });

    const task = createTask(ctx.db, ctx.wikiPath, "ingest_file", {
      sourceId: saved.sourceId,
      filename,
      title: resolvedTitle,
      sizeBytes: buffer.length,
      ...(model ? { model } : {}),
    });
    tasks.push(toPublicTask(task));
  }

  if (tasks.length === 0) {
    return {
      ok: false,
      status: 400,
      error: `所有文件都无法解析：${skipped.join("；")}`,
      type: "ExtractionError",
    };
  }

  const first = tasks[0];
  return {
    ok: true,
    task: first!,
    tasks,
    taskIds: tasks.map((t) => t.id),
    sourceId: first!.sourceId ?? undefined,
  };
}

async function submitIngestUrl(
  ctx: WikiContext,
  args: { url: string; title?: string; model?: string },
): Promise<SubmitResult> {
  // Fetch once up front so a bad URL fails immediately and the raw copy lands
  // on disk before the task exists (retries then have a file to work from).
  let extracted;
  try {
    extracted = await fetchAndExtractUrl(args.url);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: (err as Error).message ?? "网页抓取失败",
      type: "FetchError",
    };
  }

  const title = args.title?.trim() || extracted.title;
  const saved = await saveRawSource({
    wikiPath: ctx.wikiPath,
    db: ctx.db,
    buffer: Buffer.from(extracted.content, "utf8"),
    ext: ".md",
    format: "url",
    title,
    url: args.url,
  });

  const task = createTask(ctx.db, ctx.wikiPath, "ingest_url", {
    sourceId: saved.sourceId,
    url: args.url,
    title,
    ...(args.model ? { model: args.model } : {}),
  });

  return { ok: true, task: toPublicTask(task), sourceId: saved.sourceId };
}

async function submitIngestText(
  ctx: WikiContext,
  args: { text: string; title?: string; model?: string },
): Promise<SubmitResult> {
  const title = args.title?.trim() || deriveTitle(args.text);
  const body = Buffer.from(`# ${title}\n\n${args.text.trim()}\n`, "utf8");
  const saved = await saveRawSource({
    wikiPath: ctx.wikiPath,
    db: ctx.db,
    buffer: body,
    ext: ".md",
    format: "md",
    title,
  });

  const task = createTask(ctx.db, ctx.wikiPath, "ingest_text", {
    sourceId: saved.sourceId,
    title,
    text: args.text,
    ...(args.model ? { model: args.model } : {}),
  });

  return { ok: true, task: toPublicTask(task), sourceId: saved.sourceId };
}

function submitQuery(ctx: WikiContext, body: Record<string, unknown>): SubmitResult {
  const question = str(body["question"]);
  if (!question) {
    return { ok: false, status: 400, error: "question 不能为空" };
  }
  const model = str(body["model"]);
  const task = createTask(ctx.db, ctx.wikiPath, "query", {
    question,
    ...(model ? { model } : {}),
  });
  return { ok: true, task: toPublicTask(task) };
}

async function submitChat(ctx: WikiContext, body: Record<string, unknown>): Promise<SubmitResult> {
  const chatId = str(body["chatId"]);
  const message = str(body["message"]);
  if (!chatId) return { ok: false, status: 400, error: "chatId 不能为空" };
  if (!message) return { ok: false, status: 400, error: "message 不能为空" };
  if (!getChat(ctx.db, chatId)) {
    return { ok: false, status: 404, error: `对话不存在：${chatId}` };
  }

  // Record the user's turn now so the thread shows it immediately; the
  // executor only has to append the assistant reply.
  await appendUserTurn(ctx.wikiPath, ctx.db, chatId, message);

  const modelOverride = str(body["modelOverride"]);
  const task = createTask(ctx.db, ctx.wikiPath, "chat", {
    chatId,
    message,
    userMessageSaved: true,
    ...(modelOverride ? { modelOverride } : {}),
  });
  return { ok: true, task: toPublicTask(task) };
}

function submitLintFix(ctx: WikiContext, body: Record<string, unknown>): SubmitResult {
  const op = str(body["op"]) ?? str(body["type"]);
  const allowed: ReadonlyArray<LinkFixTaskInput["op"]> = [
    "remove-broken-link",
    "rebuild-index",
    "fix-all-broken-links",
    "create-stub-page",
    "apply-suggested-fix",
  ];
  if (!op || !allowed.includes(op as LinkFixTaskInput["op"])) {
    return { ok: false, status: 400, error: `未知修复类型：${String(op)}` };
  }

  const input: LinkFixTaskInput = { op: op as LinkFixTaskInput["op"] };
  for (const key of [
    "pageSlug",
    "brokenSlug",
    "missingSlug",
    "issueDescription",
    "fixInstruction",
  ] as const) {
    const value = str(body[key]);
    if (value) input[key] = value;
  }
  if (Array.isArray(body["items"])) {
    input.items = (body["items"] as Array<{ pageSlug?: unknown; brokenSlug?: unknown }>)
      .map((item) => ({
        pageSlug: String(item?.pageSlug ?? ""),
        brokenSlug: String(item?.brokenSlug ?? ""),
      }))
      .filter((item) => item.pageSlug && item.brokenSlug);
  }

  const task = createTask(ctx.db, ctx.wikiPath, "link_fix", input);
  return { ok: true, task: toPublicTask(task) };
}

// ---- source retry ---------------------------------------------------------

/**
 * Re-queues an ingest for an existing source. The raw file is still on disk,
 * so the task reads it back; nothing about the original upload is needed.
 */
export async function submitSourceRetry(
  sourceId: string,
  modelOverride?: string,
): Promise<SubmitResult> {
  const ctx = await openWikiContext();
  try {
    const source = getSource(ctx.db, sourceId);
    if (!source) {
      return { ok: false, status: 404, error: `源文件不存在：${sourceId}` };
    }
    // A previous attempt may have finished without marking the source ingested
    // (crash, kill). Close those rows out so the queue stays truthful.
    markStuckIngestTasksAsFailed(
      ctx.db,
      sourceId,
      "上一次任务未完成就被中断，已由重试取代。",
    );

    const title = sourceTitle(source);
    const kind: TaskKind = source.format === "url" ? "ingest_url" : "ingest_file";

    const input: TaskInput =
      kind === "ingest_url"
        ? {
            sourceId,
            url: source.url ?? "",
            title,
            ...(modelOverride ? { model: modelOverride } : {}),
          }
        : {
            sourceId,
            filename: source.original_name ?? source.filename,
            title,
            sizeBytes: source.size_bytes,
            ...(modelOverride ? { model: modelOverride } : {}),
          };

    const task = createTask(ctx.db, ctx.wikiPath, kind, input);
    return { ok: true, task: toPublicTask(task), sourceId };
  } finally {
    ctx.db.close();
  }
}

export function sourceTitle(source: SourceRow): string {
  return source.title?.trim() || source.original_name?.trim() || source.filename;
}

// ---- unfinished sources (the "ingested sources" list) ---------------------

export type UnfinishedSource = {
  id: string;
  title: string;
  filename: string;
  originalName: string | null;
  format: string;
  sizeBytes: number;
  addedAt: string;
  url: string | null;
  error: string | null;
  /** True when a queued/running task is already handling this source. */
  inFlight: boolean;
};

/**
 * Only waits and failures are listed: anything that ingested successfully is
 * noise once it is in the wiki, and the point of this list is "what still
 * needs me?".
 */
export function listUnfinishedSourcesForUi(db: Db): UnfinishedSource[] {
  const sources = listSourceRows(db).filter((s) => s.ingested_at === null);
  if (sources.length === 0) return [];

  const active = listTaskRowList(db, { statuses: ["pending", "running"], limit: 500 });
  const activeSources = new Set(
    active.map((t) => t.source_id).filter((id): id is string => typeof id === "string"),
  );

  return sources.map((s) => ({
    id: s.id,
    title: sourceTitle(s),
    filename: s.filename,
    originalName: s.original_name,
    format: s.format,
    sizeBytes: s.size_bytes,
    addedAt: s.added_at,
    url: s.url,
    error: s.ingest_error,
    inFlight: activeSources.has(s.id),
  }));
}

export function isTaskActive(task: PublicTask): boolean {
  return isActiveTaskStatus(task.status);
}

// ---- small helpers --------------------------------------------------------

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

/** Same heuristic the pasted-text ingest uses: first non-empty line, trimmed. */
function deriveTitle(text: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0);
  return (firstLine ?? "未命名笔记").slice(0, 80);
}
