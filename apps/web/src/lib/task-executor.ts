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
  clampIngestConcurrency,
  createStubPage,
  failTask,
  findBacklinks,
  finishTask,
  getApiKey,
  getSource,
  ingestSource,
  ingestVisionSource,
  lintWiki,
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
  type LintRunTaskInput,
  type ModelProvider,
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
import { ConcurrencyGate } from "@/lib/concurrency-gate";
import { appendLiveText, beginLiveStream, finishLiveStream, setLiveStreamProgress } from "@/lib/live-stream";
import {
  openWikiContext,
  openWikiContextSync,
  registerWikiContextHook,
  type WikiContext,
} from "@/lib/server-wiki";

// ---- tuning ---------------------------------------------------------------

/**
 * Ingest lanes. This is a *ceiling*, not the concurrency actually used: each
 * lane re-reads `settings.ingestConcurrency` before claiming work, so lowering
 * the setting takes effect without a restart and raising it never needs more
 * lanes than the maximum the settings allow.
 *
 * The literal is deliberate — `MAX_INGEST_CONCURRENCY` is re-exported from
 * another package, and reading it here would evaluate that package while this
 * module is still initialising. Under webpack's chunked server bundle that
 * produces "Cannot access '…' before initialization" the moment a route
 * imports this file. `taskExecutorMaxIngestLanes()` exists so a test can keep
 * this value pinned to the core constant.
 */
const MAX_INGEST_LANES = 10;
/** Query/chat/link lanes; kept small so a local provider is not swamped. */
const SIDE_LANES = 2;
/** Ceiling for the non-ingest lanes, matching their lane count. */
const SIDE_CONCURRENCY = SIDE_LANES;
const POLL_INTERVAL_MS = 700;
const LANE_IDLE_RETRY_MS = 1_500;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [2_000, 8_000];
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hard ceiling on one task's model work. Without it a provider that accepts a
 * connection and then never answers holds the lane open forever — and since
 * ingest has a single serial lane, one such request would stall every later
 * upload behind it. Eight minutes is generous for a large PDF vision pass.
 */
const TASK_BUDGET_MS = 8 * 60 * 1000;

/**
 * How often a running task rewrites `updated_at`. The lane is single-threaded
 * and a pending network call does not starve the event loop, so this keeps
 * ticking during a long model call — a stale heartbeat therefore means the
 * worker died rather than that the model is slow.
 */
const HEARTBEAT_MS = 15_000;

/** A running row untouched for this long is treated as abandoned. */
const STALE_RUNNING_MS = 5 * 60 * 1000;

const INGEST_KINDS: readonly TaskKind[] = ["ingest_file", "ingest_url", "ingest_text"];
const SIDE_KINDS: readonly TaskKind[] = ["query", "chat", "lint_run", "link_fix"];

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

/**
 * Starts the worker lanes.
 *
 * Deliberately a plain exported function with **no module-scope side effect**:
 * this file and `task-service` import each other, webpack puts the whole cycle
 * in one chunk, and calling an imported binding while that chunk is still
 * evaluating throws "Cannot access '…' before initialization". Callers invoke
 * this after their own module body has finished (see `ensureTaskExecutor`).
 */
export function startTaskExecutor(): void {
  if (!isNodeRuntime()) return;
  const state = (g[globalKey] ??= {
    started: false,
    lanes: MAX_INGEST_LANES + SIDE_LANES,
    housekeepingDone: false,
  });
  if (state.started) return;
  state.started = true;
  for (let lane = 0; lane < state.lanes; lane++) {
    void runLane(lane);
  }
}

/**
 * Registers the "first wiki context open starts the executor" hook and starts
 * the lanes immediately. Safe to call any number of times.
 *
 * `startTaskExecutor` is referenced lazily inside the closure rather than
 * passed directly, so nothing here touches an imported binding at module scope.
 */
export function ensureTaskExecutor(): void {
  registerWikiContextHook(() => startTaskExecutor());
  startTaskExecutor();
}

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}

/** Total worker lanes currently running. Diagnostics only. */
export function taskExecutorLaneCount(): number {
  return MAX_INGEST_LANES + SIDE_LANES;
}

/**
 * The ingest lane ceiling. Exported so a test can assert it still matches
 * core's `MAX_INGEST_CONCURRENCY` — the two must agree, but this module cannot
 * import the constant (see the note on MAX_INGEST_LANES).
 */
export function taskExecutorMaxIngestLanes(): number {
  return MAX_INGEST_LANES;
}

/**
 * Live concurrency state, for diagnostics.
 *
 * `activeIngest` is the number of ingest tasks running right now and can never
 * exceed `ingestLimit` — that invariant is the whole point of the shared gate,
 * and this is how the UI (and a test) can check it.
 */
export function taskExecutorConcurrencySnapshot(): {
  ingestLimit: number;
  activeIngest: number;
  sideLimit: number;
  activeSide: number;
  lanes: number;
} {
  return {
    ingestLimit: ingestGate.limit(),
    activeIngest: ingestGate.activeCount(),
    sideLimit: sideGate.limit(),
    activeSide: sideGate.activeCount(),
    lanes: MAX_INGEST_LANES + SIDE_LANES,
  };
}

// ---- lanes ----------------------------------------------------------------

/**
 * The one ingest gate, shared by every ingest lane. Limits are read live so a
 * settings change applies to the next acquisition without a restart.
 *
 * It MUST be a single shared instance: with a per-lane counter, ten ingest
 * lanes each allowed one task, so a setting of 1 still ran ten jobs at once.
 */
const ingestGate = new ConcurrencyGate("ingest", () => currentIngestConcurrency());
/** Non-ingest work (query/chat/link) shares its own small budget. */
const sideGate = new ConcurrencyGate("side", () => SIDE_CONCURRENCY);

async function runLane(lane: number): Promise<void> {
  const isIngestLane = lane < MAX_INGEST_LANES;
  const kinds = isIngestLane ? INGEST_KINDS : SIDE_KINDS;
  const gate = isIngestLane ? ingestGate : sideGate;

  for (;;) {
    // Take a slot BEFORE claiming: claiming first would mark a task `running`
    // in the database and leave it there while this lane waits its turn, so the
    // UI would report far more concurrency than the setting allows.
    await gate.acquire();

    let claimed: TaskRow | null = null;
    try {
      claimed = withDb((db) => {
        recoverOnce(db);
        return claimNextTask(db, kinds);
      });
    } catch {
      // Wiki unreadable right now (folder being switched, transient lock).
      // Back off and keep the lane alive.
      gate.release();
      await sleep(LANE_IDLE_RETRY_MS);
      continue;
    }

    if (!claimed) {
      // Nothing to do — hand the slot back rather than idling while holding it.
      gate.release();
      await sleep(LANE_IDLE_RETRY_MS);
      continue;
    }

    try {
      await executeTask(claimed);
    } finally {
      // `executeTask` is contracted to always settle, so this always runs —
      // a slot can never leak.
      gate.release();
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Settings-cached concurrency, refreshed cheaply once per second. */
let cachedConcurrency = 1;
let concurrencyReadAt = 0;
const CONCURRENCY_CACHE_MS = 1_000;

function currentIngestConcurrency(): number {
  const now = Date.now();
  if (now - concurrencyReadAt < CONCURRENCY_CACHE_MS) return cachedConcurrency;
  concurrencyReadAt = now;
  try {
    const ctx = openWikiContextSync();
    try {
      cachedConcurrency = clampIngestConcurrency(ctx.settings.ingestConcurrency);
    } finally {
      ctx.db.close();
    }
  } catch {
    // Keep the last known value — a transient DB problem must not stall lanes.
  }
  return cachedConcurrency;
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

/**
 * Runs one claimed task with a watchdog.
 *
 * Two failure modes are handled here because either one would otherwise park
 * the lane permanently: an exception thrown outside the try block of a task
 * runner, and a model call that simply never returns. A lane that dies takes
 * the whole queue with it, so the contract is that this function always
 * settles the task in the database and always returns.
 */
async function executeTask(task: TaskRow): Promise<void> {
  const opened = await openWikiContext();
  // The user may have switched wikis between submitting and running; the task
  // belongs to the wiki it was created in, not the one selected now.
  const ctx = opened.wikiPath === task.wiki_path ? opened : openWikiContextSync();
  if (ctx !== opened) opened.db.close();

  // Cancelling this aborts in-flight model requests at the SDK boundary; it
  // doubles as the per-task deadline. Progress writes keep the heartbeat fresh
  // so a slow-but-alive task is never mistaken for an abandoned one.
  const watchdog = new AbortController();
  let deadlineHit = false;
  const deadline = setTimeout(() => {
    deadlineHit = true;
    watchdog.abort(new Error(`任务超过 ${Math.round(TASK_BUDGET_MS / 60_000)} 分钟上限，已中止`));
  }, TASK_BUDGET_MS);
  const heartbeat = setInterval(() => {
    try {
      setTaskProgress(ctx.db, task.id, lastProgress.get(task.id) ?? "正在调用模型…");
    } catch {
      // Best-effort; the DB may be momentarily busy.
    }
  }, HEARTBEAT_MS);

  lastProgress.set(task.id, "已开始执行");

  try {
    await Promise.race([
      dispatch(task, ctx, watchdog.signal),
      // Guarantees the race settles even if the task ignores the signal.
      sleep(TASK_BUDGET_MS + 5_000).then(() => {
        deadlineHit = true;
      }),
    ]);
    // Safety net: a live buffer left open would hang every viewer, so close it
    // here even though the chat runner normally does this itself (no-op then).
    finishLiveStream(task.id, "succeeded");
  } catch (err) {
    const message = deadlineHit
      ? `任务超过 ${Math.round(TASK_BUDGET_MS / 60_000)} 分钟仍未完成，已中止。`
      : errorMessage(err);
    // Surface the reason on the source row so the sources list can explain why
    // the item is still waiting instead of showing a bare "pending".
    if (task.source_id) {
      try {
        markSourceFailed(ctx.db, task.source_id, message);
      } catch {
        // Source may have been deleted while the task ran.
      }
    }
    if (!deadlineHit && task.attempts < MAX_ATTEMPTS && isRetryable(err)) {
      const backoff = RETRY_BACKOFF_MS[Math.max(0, task.attempts - 1)] ?? 8_000;
      requeueTask(
        ctx.db,
        task.id,
        `第 ${task.attempts} 次尝试失败，${Math.round(backoff / 1000)} 秒后重试`,
      );
      bumpAttempts(ctx.db, task.id);
      // The attempt is over even though the task is not; the next attempt
      // starts a fresh buffer (and tells viewers to drop the dead one).
      finishLiveStream(task.id, "failed", message);
      await sleep(backoff);
    } else {
      failTask(ctx.db, task.id, message);
      finishLiveStream(task.id, "failed", message);
    }
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    lastProgress.delete(task.id);
    ctx.db.close();
  }
}

/** Last progress message per running task, so the heartbeat can rewrite it. */
const lastProgress = new Map<string, string>();

function bumpAttempts(db: Db, id: string): void {
  db.prepare(`UPDATE tasks SET attempts = attempts + 1 WHERE id = ?`).run(id);
}

async function dispatch(task: TaskRow, ctx: WikiContext, signal: AbortSignal): Promise<void> {
  switch (task.kind) {
    case "ingest_file":
      return runIngestFile(task, ctx, signal);
    case "ingest_url":
      return runIngestUrl(task, ctx, signal);
    case "ingest_text":
      return runIngestText(task, ctx, signal);
    case "query":
      return runQuery(task, ctx, signal);
    case "chat":
      return runChat(task, ctx, signal);
    case "lint_run":
      return runLint(task, ctx, signal);
    case "link_fix":
      return runLinkFix(task, ctx, signal);
    default: {
      const _exhaustive: never = task.kind;
      throw new Error(`未知任务类型：${String(_exhaustive)}`);
    }
  }
}

// ---- ingest ---------------------------------------------------------------

async function runIngestFile(task: TaskRow, ctx: WikiContext, signal: AbortSignal): Promise<void> {
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
  const client = createClient(await requireApiKey(provider), provider, signal);
  const model =
    input.model ??
    (extracted.kind === "vision"
      ? settings.defaultModels.vision.model
      : settings.defaultModels.ingest.model);
  const dryRun = settings.requireApprovalForIngest;

  progress(db, task.id, dryRun ? "正在生成Ingest提案…" : "正在调用模型生成 wiki 页面…");
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

async function runIngestUrl(task: TaskRow, ctx: WikiContext, signal: AbortSignal): Promise<void> {
  const { db, wikiPath, settings } = ctx;
  const input = task.input as IngestUrlTaskInput;
  const source = requireSource(db, input.sourceId);

  progress(db, task.id, "正在抓取并解析网页…");
  const extracted = await fetchAndExtractUrl(input.url);

  const provider = settings.defaultModels.ingest.provider;
  const client = createClient(await requireApiKey(provider), provider, signal);
  const model = input.model ?? settings.defaultModels.ingest.model;
  const dryRun = settings.requireApprovalForIngest;

  progress(db, task.id, dryRun ? "正在生成Ingest提案…" : "正在调用模型生成 wiki 页面…");
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

async function runIngestText(task: TaskRow, ctx: WikiContext, signal: AbortSignal): Promise<void> {
  const { db, wikiPath, settings } = ctx;
  const input = task.input as IngestTextTaskInput;
  const source = requireSource(db, input.sourceId);

  // The raw file is the source of truth (it survives restarts), so a retry
  // reads it back instead of trusting the payload.
  const body =
    input.text ??
    stripLeadingTitle(await readFile(join(wikiPath, WIKI_PATHS.raw, source.filename), "utf8"));

  const provider = settings.defaultModels.ingest.provider;
  const client = createClient(await requireApiKey(provider), provider, signal);
  const model = input.model ?? settings.defaultModels.ingest.model;
  const dryRun = settings.requireApprovalForIngest;

  progress(db, task.id, dryRun ? "正在生成Ingest提案…" : "正在调用模型生成 wiki 页面…");
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

// ---- query / chat / lint --------------------------------------------------

/**
 * Whole-wiki health check.
 *
 * Runs in the background like every other model operation: a large wiki can
 * take minutes, and holding an HTTP request open for that means the user
 * stares at a dead button and loses the result if the request is cut off.
 * `lintWiki` writes its history line to log.md itself, so the outcome is
 * durable even if this task is interrupted.
 */
async function runLint(task: TaskRow, ctx: WikiContext, signal: AbortSignal): Promise<void> {
  const { db, wikiPath, settings } = ctx;
  const input = task.input as LintRunTaskInput;
  const provider = settings.defaultModels.lint.provider;
  const model = input.model ?? settings.defaultModels.lint.model;
  const capture = captureClientModel(createClient(await requireApiKey(provider), provider, signal));

  progress(db, task.id, "正在扫描知识库…");
  const result = await lintWiki({
    wikiPath,
    db,
    client: capture.client,
    model,
    onProgress: taskProgress(db, task.id),
  });

  finishTask(db, task.id, {
    model: capture.model() ?? model,
    provider,
    // `runId` lets the UI link straight to the stored run instead of
    // re-deriving it from log.md.
    runId: result.runId,
    result,
  });
}

async function runQuery(task: TaskRow, ctx: WikiContext, signal: AbortSignal): Promise<void> {
  const { db, wikiPath, settings } = ctx;
  const input = task.input as QueryTaskInput;
  const provider = settings.defaultModels.query.provider;
  const model = input.model ?? settings.defaultModels.query.model;
  const capture = captureClientModel(createClient(await requireApiKey(provider), provider, signal));

  progress(db, task.id, "正在检索 wiki 并生成回答…");
  const outcome = await queryWiki({
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
    runId: outcome.runId,
    response: outcome.response,
  });
}

async function runChat(task: TaskRow, ctx: WikiContext, signal: AbortSignal): Promise<void> {
  const { db, wikiPath, settings } = ctx;
  const input = task.input as ChatTaskInput;
  const provider = settings.defaultModels.chat.provider;
  const capture = captureClientModel(createClient(await requireApiKey(provider), provider, signal));

  progress(db, task.id, "正在生成回复…");
  // Open the live buffer before the first token so a viewer that connects while
  // the model is still thinking gets progress updates instead of silence.
  beginLiveStream(task.id, "正在生成回复…");
  const result = await sendChatMessage({
    wikiPath,
    db,
    chatId: input.chatId,
    userMessage: input.message,
    client: capture.client,
    skipUserAppend: input.userMessageSaved === true,
    onDelta: (delta) => appendLiveText(task.id, delta),
    ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
  });
  // Row first, then the live buffer: a viewer that reacts to "end" by
  // re-reading the task must find it already terminal, otherwise it would sit
  // waiting for an attempt that never comes.
  finishTask(db, task.id, {
    chatId: input.chatId,
    modelUsed: result.modelUsed,
    provider,
    assistant: result.assistant,
  });
  finishLiveStream(task.id, "succeeded");
}

// ---- link fixes -----------------------------------------------------------

async function runLinkFix(task: TaskRow, ctx: WikiContext, signal: AbortSignal): Promise<void> {
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
      const client = createClient(await requireApiKey(provider), provider, signal);
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
      const client = createClient(await requireApiKey(provider), provider, signal);
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
  // Remembered so the heartbeat interval can rewrite it and keep `updated_at`
  // moving while a long model call is in flight.
  lastProgress.set(taskId, message);
  // Mirrored into the live buffer so SSE viewers see the phase change without
  // polling for it.
  setLiveStreamProgress(taskId, message);
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

async function requireApiKey(provider: ModelProvider): Promise<string> {
  // Ollama is local and takes a placeholder; the hosted providers need a real
  // key from the matching keychain/settings entry.
  if (provider === "ollama") return "ollama";
  const { key } = await getApiKey(provider);
  if (!key) {
    throw new NonRetryableError(
      provider === "deepseek"
        ? "未配置 DeepSeek API Key，请在“设置 → API”中填写。"
        : "未配置 OpenRouter API Key，请在“设置 → API”中填写。",
    );
  }
  return key;
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
