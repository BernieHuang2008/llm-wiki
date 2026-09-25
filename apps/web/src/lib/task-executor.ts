// Background task executor.
//
// The HTTP routes only *record* a task; this module is what actually runs it.
// It lives in the server process (not in a request), so closing the browser,
// navigating away, or reloading the page cannot interrupt an ingest, a query,
// a chat turn, or a link fix.
//
// Durability: every task is a row in the wiki's `tasks` table before it is
// queued, so a restart replays whatever is still `pending`. A row left in
// `running` can only mean the previous process died mid-flight — those are
// marked `interrupted` (never silently re-run, since a half-finished ingest
// must not be applied twice).

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  applyLintSuggestedFix,
  claimNextTask,
  createStubPage,
  failTask,
  findBacklinks,
  finishTask,
  getApiKey,
  getSource,
  ingestSource,
  ingestVisionSource,
  markSourceFailed,
  markSourceIngested,
  pruneFinishedTasks,
  queryWiki,
  rebuildIndexFromPages,
  recoverInterruptedTasks,
  removeBrokenLink,
  requeueTask,
  sendChatMessage,
  setTaskProgress,
  WIKI_PATHS,
  type ChatTaskInput,
  type Db,
  type IngestFileTaskInput,
  type IngestResponse,
  type IngestTextTaskInput,
  type IngestUrlTaskInput,
  type LinkFixTaskInput,
  type QueryTaskInput,
  type TaskKind,
  type TaskRow,
} from "@llm-wiki/core";
import { fetchAndExtractUrl } from "@llm-wiki/ingestion";
import {
  ContextLengthError,
  createClient,
  RateLimitError,
  UnknownModelError,
  type LlmClient,
} from "@llm-wiki/llm";

import { detectSourceFormat, extractBuffer, readStoredSource } from "@/lib/server-ingestion";
import {
  openWikiContext,
  openWikiContextSync,
  registerWikiContextHook,
  type WikiContext,
} from "@/lib/server-wiki";

// ---- tuning ---------------------------------------------------------------

/** Ingest is serialized: each pass reads the index the previous pass wrote. */
const INGEST_LANES = 1;
/** Query/chat/link lanes; kept small so a local provider is not swamped. */
const SIDE_LANES = 2;
const POLL_INTERVAL_MS = 700;
const LANE_IDLE_RETRY_MS = 1_500;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [2_000, 8_000];
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const INGEST_KINDS: readonly TaskKind[] = ["ingest_file", "ingest_url", "ingest_text"];
const SIDE_KINDS: readonly TaskKind[] = ["query", "chat", "link_fix"];

type State = {
  started: boolean;
  lanes: number;
  housekeepingDone: boolean;
};

// `globalThis` keeps the executor singular across Next.js dev-server module
// reloads, which would otherwise start a second lane pool on every edit.
const globalKey = "__llmWikiTaskExecutor";
type GlobalWithExecutor = typeof globalThis & { [globalKey]?: State };
const g = globalThis as GlobalWithExecutor;

export function startTaskExecutor(): void {
  if (!isNodeRuntime()) return;
  const state = (g[globalKey] ??= {
    started: false,
    lanes: INGEST_LANES + SIDE_LANES,
    housekeepingDone: false,
  });
  if (state.started) return;
  state.started = true;
  for (let lane = 0; lane < state.lanes; lane++) {
    void runLane(lane);
  }
}

// Starting the executor is what lets a task outlive its request, so it is
// hooked into every wiki-context open (see registerWikiContextHook).
registerWikiContextHook(startTaskExecutor);

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}

/** Number of worker lanes currently running. Diagnostics only. */
export function taskExecutorLaneCount(): number {
  return INGEST_LANES + SIDE_LANES;
}

// ---- lanes ----------------------------------------------------------------

async function runLane(lane: number): Promise<void> {
  // Ingest lanes only take ingest work (so an ingest never runs beside another
  // ingest rewriting index.md); the remaining lanes take everything else.
  const kinds = lane < INGEST_LANES ? INGEST_KINDS : SIDE_KINDS;

  for (;;) {
    let claimed: TaskRow | null = null;
    try {
      claimed = withDb((db) => {
        recoverOnce(db);
        return claimNextTask(db, kinds);
      });
    } catch {
      // Wiki unreadable right now (folder being switched, transient lock).
      // Back off and keep the lane alive.
      await sleep(LANE_IDLE_RETRY_MS);
      continue;
    }

    if (!claimed) {
      await sleep(LANE_IDLE_RETRY_MS);
      continue;
    }

    await executeTask(claimed);
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Startup sweep + retention pruning, once per process. */
function recoverOnce(db: Db): void {
  const state = g[globalKey];
  if (!state || state.housekeepingDone) return;
  state.housekeepingDone = true;
  try {
    recoverInterruptedTasks(db);
    pruneFinishedTasks(db, PRUNE_AFTER_MS);
  } catch {
    // Non-fatal housekeeping.
  }
}

/**
 * Opens the DB just long enough to claim work. Cheaper than a full context and
 * it never blocks on the disk→DB sync that each request already performs.
 */
function withDb<T>(fn: (db: Db) => T): T {
  const ctx = openWikiContextSync();
  try {
    return fn(ctx.db);
  } finally {
    ctx.db.close();
  }
}

// ---- execution ------------------------------------------------------------

async function executeTask(task: TaskRow): Promise<void> {
  const opened = await openWikiContext();
  // The user may have switched wikis between submitting and running; the task
  // belongs to the wiki it was created in, not the one selected now.
  const ctx = opened.wikiPath === task.wiki_path ? opened : openWikiContextSync();
  if (ctx !== opened) opened.db.close();

  try {
    await dispatch(task, ctx);
  } catch (err) {
    const message = errorMessage(err);
    // Surface the reason on the source row so the sources list can explain why
    // the item is still waiting instead of showing a bare "pending".
    if (task.source_id) {
      try {
        markSourceFailed(ctx.db, task.source_id, message);
      } catch {
        // Source may have been deleted while the task ran.
      }
    }
    if (task.attempts < MAX_ATTEMPTS && isRetryable(err)) {
      const backoff = RETRY_BACKOFF_MS[Math.max(0, task.attempts - 1)] ?? 8_000;
      requeueTask(
        ctx.db,
        task.id,
        `第 ${task.attempts} 次尝试失败，${Math.round(backoff / 1000)} 秒后重试`,
      );
      bumpAttempts(ctx.db, task.id);
      await sleep(backoff);
    } else {
      failTask(ctx.db, task.id, message);
    }
  } finally {
    ctx.db.close();
  }
}

function bumpAttempts(db: Db, id: string): void {
  db.prepare(`UPDATE tasks SET attempts = attempts + 1 WHERE id = ?`).run(id);
}

async function dispatch(task: TaskRow, ctx: WikiContext): Promise<void> {
  switch (task.kind) {
    case "ingest_file":
      return runIngestFile(task, ctx);
    case "ingest_url":
      return runIngestUrl(task, ctx);
    case "ingest_text":
      return runIngestText(task, ctx);
    case "query":
      return runQuery(task, ctx);
    case "chat":
      return runChat(task, ctx);
    case "link_fix":
      return runLinkFix(task, ctx);
    default: {
      const _exhaustive: never = task.kind;
      throw new Error(`未知任务类型：${String(_exhaustive)}`);
    }
  }
}

// ---- ingest ---------------------------------------------------------------

async function runIngestFile(task: TaskRow, ctx: WikiContext): Promise<void> {
  const { db, wikiPath, settings } = ctx;
  const input = task.input as IngestFileTaskInput;
  const source = requireSource(db, input.sourceId);

  progress(db, task.id, "正在读取原始文件…");
  const stored = await readStoredSource({
    wikiPath,
    filename: source.filename,
    format: source.format,
    preferOriginal: true,
  });
  if (stored.kind !== "buffer") throw new Error("内部错误：未能读取原始文件");

  const format = detectSourceFormat(input.filename, stored.buffer);
  progress(db, task.id, "正在解析文件内容…");
  const extracted = await extractBuffer(format, stored.buffer, input.filename);
  extracted.title = input.title;

  const provider =
    extracted.kind === "vision"
      ? settings.defaultModels.vision.provider
      : settings.defaultModels.ingest.provider;
  const client = createClient(await requireApiKey(provider), provider);
  const model =
    input.model ??
    (extracted.kind === "vision"
      ? settings.defaultModels.vision.model
      : settings.defaultModels.ingest.model);
  const dryRun = settings.requireApprovalForIngest;

  progress(db, task.id, dryRun ? "正在生成入库提案…" : "正在调用模型生成 wiki 页面…");
  const onProgress = taskProgress(db, task.id);

  const response =
    extracted.kind === "vision"
      ? await ingestVisionSource({
          source: extracted,
          wikiPath,
          db,
          client,
          model,
          sourceId: source.id,
          dryRun,
          onProgress,
        })
      : await ingestSource({
          source: { content: extracted.content, title: extracted.title, format },
          wikiPath,
          db,
          client,
          model,
          sourceId: source.id,
          dryRun,
          onProgress,
        });

  await finishIngest(db, task.id, source.id, response, model, dryRun);
}

async function runIngestUrl(task: TaskRow, ctx: WikiContext): Promise<void> {
  const { db, wikiPath, settings } = ctx;
  const input = task.input as IngestUrlTaskInput;
  const source = requireSource(db, input.sourceId);

  progress(db, task.id, "正在抓取并解析网页…");
  const extracted = await fetchAndExtractUrl(input.url);

  const provider = settings.defaultModels.ingest.provider;
  const client = createClient(await requireApiKey(provider), provider);
  const model = input.model ?? settings.defaultModels.ingest.model;
  const dryRun = settings.requireApprovalForIngest;

  progress(db, task.id, dryRun ? "正在生成入库提案…" : "正在调用模型生成 wiki 页面…");
  const response = await ingestSource({
    source: { content: extracted.content, title: input.title, format: "url" },
    wikiPath,
    db,
    client,
    model,
    sourceId: source.id,
    dryRun,
    onProgress: taskProgress(db, task.id),
  });

  await finishIngest(db, task.id, source.id, response, model, dryRun);
}

async function runIngestText(task: TaskRow, ctx: WikiContext): Promise<void> {
  const { db, wikiPath, settings } = ctx;
  const input = task.input as IngestTextTaskInput;
  const source = requireSource(db, input.sourceId);

  // The raw file is the source of truth (it survives restarts), so a retry
  // reads it back instead of trusting the payload.
  const body =
    input.text ??
    stripLeadingTitle(await readFile(join(wikiPath, WIKI_PATHS.raw, source.filename), "utf8"));

  const provider = settings.defaultModels.ingest.provider;
  const client = createClient(await requireApiKey(provider), provider);
  const model = input.model ?? settings.defaultModels.ingest.model;
  const dryRun = settings.requireApprovalForIngest;

  progress(db, task.id, dryRun ? "正在生成入库提案…" : "正在调用模型生成 wiki 页面…");
  const response = await ingestSource({
    source: { content: body, title: input.title, format: "md" },
    wikiPath,
    db,
    client,
    model,
    sourceId: source.id,
    dryRun,
    onProgress: taskProgress(db, task.id),
  });

  await finishIngest(db, task.id, source.id, response, model, dryRun);
}

async function finishIngest(
  db: Db,
  taskId: string,
  sourceId: string,
  response: IngestResponse,
  model: string,
  dryRun: boolean,
): Promise<void> {
  if (!dryRun) markSourceIngested(db, sourceId);
  finishTask(db, taskId, {
    sourceId,
    model,
    kind: dryRun ? "preview" : "applied",
    summary: response.summary,
    newPages: response.newPages.map((p) => ({ slug: p.slug, title: p.title, type: p.type })),
    pageUpdates: response.pageUpdates.map((p) => ({
      slug: p.slug,
      updateReason: p.updateReason,
    })),
    contradictions: response.contradictions,
    // Kept so the approval gate can re-submit the exact proposal on Apply.
    fullResponse: dryRun ? response : null,
  });
}

/** Removes the `# Title` line that pasted-text saves prepend. */
function stripLeadingTitle(raw: string): string {
  const match = raw.match(/^#\s+.*\n+([\s\S]*)$/);
  return match?.[1] ?? raw;
}

// ---- query / chat ---------------------------------------------------------

async function runQuery(task: TaskRow, ctx: WikiContext): Promise<void> {
  const { db, wikiPath, settings } = ctx;
  const input = task.input as QueryTaskInput;
  const provider = settings.defaultModels.query.provider;
  const model = input.model ?? settings.defaultModels.query.model;
  const capture = captureClientModel(createClient(await requireApiKey(provider), provider));

  progress(db, task.id, "正在检索 wiki 并生成回答…");
  const response = await queryWiki({
    question: input.question,
    wikiPath,
    db,
    client: capture.client,
    model,
    onProgress: taskProgress(db, task.id),
  });

  finishTask(db, task.id, {
    model: capture.model() ?? model,
    provider,
    question: input.question,
    response,
  });
}

async function runChat(task: TaskRow, ctx: WikiContext): Promise<void> {
  const { db, wikiPath, settings } = ctx;
  const input = task.input as ChatTaskInput;
  const provider = settings.defaultModels.chat.provider;
  const capture = captureClientModel(createClient(await requireApiKey(provider), provider));

  progress(db, task.id, "正在生成回复…");
  const result = await sendChatMessage({
    wikiPath,
    db,
    chatId: input.chatId,
    userMessage: input.message,
    client: capture.client,
    skipUserAppend: input.userMessageSaved === true,
    ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
  });

  finishTask(db, task.id, {
    chatId: input.chatId,
    modelUsed: result.modelUsed,
    provider,
    assistant: result.assistant,
  });
}

// ---- link fixes -----------------------------------------------------------

async function runLinkFix(task: TaskRow, ctx: WikiContext): Promise<void> {
  const { db, wikiPath, settings } = ctx;
  const input = task.input as LinkFixTaskInput;

  switch (input.op) {
    case "remove-broken-link": {
      const pageSlug = required(input.pageSlug, "pageSlug");
      const brokenSlug = required(input.brokenSlug, "brokenSlug");
      const result = await removeBrokenLink(wikiPath, db, pageSlug, brokenSlug);
      finishTask(db, task.id, {
        op: input.op,
        pageSlug,
        brokenSlug,
        page: { slug: result.page.slug, content: result.page.content },
      });
      return;
    }
    case "rebuild-index": {
      const result = await rebuildIndexFromPages(wikiPath, db);
      finishTask(db, task.id, { op: input.op, ...result });
      return;
    }
    case "fix-all-broken-links": {
      const items = input.items ?? [];
      if (items.length === 0) throw new NonRetryableError("items 不能为空");
      const fixed: Array<{ pageSlug: string; brokenSlug: string }> = [];
      const failed: Array<{ pageSlug: string; brokenSlug: string; error: string }> = [];
      for (const item of items) {
        try {
          await removeBrokenLink(wikiPath, db, item.pageSlug, item.brokenSlug);
          fixed.push(item);
        } catch (err) {
          failed.push({ ...item, error: errorMessage(err) });
        }
      }
      finishTask(db, task.id, { op: input.op, fixed, failed });
      return;
    }
    case "create-stub-page": {
      const missingSlug = required(input.missingSlug, "missingSlug");
      const provider = settings.defaultModels.ingest.provider;
      const client = createClient(await requireApiKey(provider), provider);
      const model = settings.defaultModels.ingest.model;
      // Context from the pages that reference the missing slug, so the draft
      // fits the wiki's voice.
      const backlinks = await findBacklinks(db, wikiPath, missingSlug);
      progress(db, task.id, "正在起草新页面…");
      const result = await createStubPage({
        wikiPath,
        db,
        client,
        model,
        missingSlug,
        referencingPages: backlinks.map((b) => ({
          slug: b.slug,
          title: b.title,
          excerpt: b.excerpt,
        })),
      });
      finishTask(db, task.id, {
        op: input.op,
        kind: "stub-created",
        slug: result.page.slug,
        title: result.page.frontmatter.title,
        type: result.page.frontmatter.type,
        model: result.modelUsed,
      });
      return;
    }
    case "apply-suggested-fix": {
      const pageSlug = required(input.pageSlug, "pageSlug");
      const issueDescription = required(input.issueDescription, "issueDescription");
      const fixInstruction = required(input.fixInstruction, "fixInstruction");
      const provider = settings.defaultModels.lint.provider;
      const client = createClient(await requireApiKey(provider), provider);
      const model = settings.defaultModels.lint.model;
      progress(db, task.id, "正在应用修复建议…");
      const result = await applyLintSuggestedFix({
        wikiPath,
        db,
        client,
        model,
        pageSlug,
        issueDescription,
        fixInstruction,
      });
      finishTask(db, task.id, {
        op: input.op,
        kind: result.noop ? "fix-noop" : "fix-applied",
        slug: pageSlug,
        changeSummary: result.changeSummary,
        model: result.modelUsed,
      });
      return;
    }
    default: {
      const _exhaustive: never = input.op;
      throw new NonRetryableError(`未知修复类型：${String(_exhaustive)}`);
    }
  }
}

// ---- helpers --------------------------------------------------------------

/**
 * Progress callback for the core pipelines: every phase carries a `message`
 * except the final `done` event, which carries the parsed result.
 */
function taskProgress(db: Db, taskId: string) {
  return (event: unknown): void => {
    const message = progressMessageOf(event);
    if (message) progress(db, taskId, message);
  };
}

function progressMessageOf(event: unknown): string | null {
  if (event && typeof event === "object" && "message" in event) {
    const message = (event as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return null;
}

function progress(db: Db, taskId: string, message: string): void {
  try {
    setTaskProgress(db, taskId, message);
  } catch {
    // Progress is best-effort; never fail a task over it.
  }
}

function requireSource(db: Db, sourceId: string) {
  const source = getSource(db, sourceId);
  if (!source) {
    throw new NonRetryableError(`源文件已不存在（${sourceId}），可能已被删除。`);
  }
  return source;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === "") {
    throw new NonRetryableError(`缺少参数：${name}`);
  }
  return value;
}

async function requireApiKey(provider: string): Promise<string> {
  const { key } = await getApiKey();
  if (provider === "openrouter" && !key) {
    throw new NonRetryableError("未配置 OpenRouter API Key，请在“设置 → API”中填写。");
  }
  return key || "";
}

class NonRetryableError extends Error {}

type CapturingClient = { client: LlmClient; model: () => string | null };

/**
 * Wraps a client so the model the provider actually answered with can be
 * reported back to the UI (the request/response routes used to return it).
 */
function captureClientModel(client: LlmClient): CapturingClient {
  let seen: string | null = null;
  const wrapped = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "chat") {
        return {
          completions: {
            create: async (args: unknown) => {
              const res = (await (
                target.chat.completions.create as unknown as (a: unknown) => Promise<unknown>
              )(args)) as { model?: string };
              if (typeof res?.model === "string") seen = res.model;
              return res;
            },
          },
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as LlmClient;
  return { client: wrapped, model: () => seen };
}

function isRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableError) return false;
  if (err instanceof ContextLengthError || err instanceof UnknownModelError) return false;
  if (err instanceof RateLimitError) return true;
  const message = errorMessage(err);
  // Schema drift on a weak model is usually transient; a deleted source or a
  // missing API key never is.
  if (/schema validation|not valid JSON|Unexpected token/i.test(message)) return true;
  if (
    /timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|fetch failed|\b(429|502|503|504)\b/i.test(
      message,
    )
  ) {
    return true;
  }
  return !/未配置 OpenRouter API Key|已不存在|缺少参数|不能为空/u.test(message);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
