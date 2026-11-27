// Live output buffer for tasks that are still running.
//
// The chat executor streams a reply token by token, but the *only* durable
// record stays the finished message in the chat `.md` file (see docs/07). This
// module is the ephemeral transport state in between: a bounded, in-memory
// ring of "what the model has said so far", fanned out to whoever is watching.
//
// Two consequences matter for the design:
//
//  - A viewer is never required. Deltas are dropped when nobody is subscribed,
//    and a viewer that connects late (page reload, second tab) gets the whole
//    buffer as a snapshot first, so it renders the answer from the beginning
//    instead of from wherever it happened to attach.
//  - Nothing here is authoritative. If the process restarts, the buffer is
//    gone and the task row in SQLite is still the source of truth.

import type { ChatAgentToolTrace, ChatAgentTrace } from "@llm-wiki/core";

export type LiveStreamStatus = "running" | "succeeded" | "failed" | "canceled";

export type AgentTrace = ChatAgentTrace;

/**
 * A wiki write the agent wants to perform, paused until the user answers.
 * Mirrors the core agent's request; kept local so the client can import it
 * without pulling core into a browser bundle.
 */
export type WriteApprovalRequest = {
  id: string;
  toolName: string;
  summary: string;
  arguments: string;
};

export type LiveStreamSnapshot = {
  taskId: string;
  text: string;
  progress: string | null;
  status: LiveStreamStatus;
  error: string | null;
  trace: AgentTrace;
  /** The write awaiting approval, or null when nothing is blocked. */
  approval: WriteApprovalRequest | null;
  /** True once no further delta can arrive for this task. */
  finished: boolean;
};

export type LiveStreamEvent =
  /** A new attempt replaced the buffer (task retry) — drop what you rendered. */
  | { type: "reset" }
  | { type: "round"; round: number }
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; tool: ChatAgentToolTrace }
  | { type: "tool_result"; tool: ChatAgentToolTrace }
  | { type: "approval_request"; request: WriteApprovalRequest }
  | { type: "approval_resolved"; id: string; approved: boolean }
  | { type: "progress"; progress: string | null }
  | { type: "end"; status: "succeeded" | "failed" | "canceled"; error: string | null };

export type LiveStreamListener = (event: LiveStreamEvent) => void;

type PendingApproval = {
  request: WriteApprovalRequest;
  resolve: (approved: boolean) => void;
};

type LiveStream = {
  taskId: string;
  text: string;
  progress: string | null;
  status: LiveStreamStatus;
  error: string | null;
  trace: AgentTrace;
  /** A write is blocked on the user's answer; null when nothing is pending. */
  pendingApproval: PendingApproval | null;
  createdAt: number;
  finishedAt: number | null;
  subscribers: Set<LiveStreamListener>;
};

/**
 * Longest reply we keep in memory. A model that somehow streams past this is
 * still persisted in full — the viewer just stops growing, which is the honest
 * signal that the preview is truncated rather than the generation hanging.
 */
const MAX_TEXT_CHARS = 400_000;

/** How long a finished buffer stays readable so a late viewer still sees it. */
const FINISHED_TTL_MS = 5 * 60 * 1000;

/** Cap on retained buffers; only ever needs to cover in-flight tasks + TTL. */
const MAX_BUFFERS = 64;

// `globalThis` keeps the registry singular across Next.js dev-server module
// reloads — otherwise the executor and an SSE route could end up talking to
// two different maps and the stream would look permanently empty.
const globalKey = "__llmWikiLiveStreams";
type GlobalWithStreams = typeof globalThis & { [globalKey]?: Map<string, LiveStream> };
const g = globalThis as GlobalWithStreams;

function registry(): Map<string, LiveStream> {
  return (g[globalKey] ??= new Map<string, LiveStream>());
}

/** Test seam: lets a suite start from a clean registry. */
export function resetLiveStreams(): void {
  registry().clear();
}

/**
 * Starts (or restarts) the buffer for a task. Called at the top of every
 * attempt, so a requeued task does not append its new answer to the old one.
 */
export function beginLiveStream(taskId: string, progress: string | null = null): void {
  const streams = registry();
  const existing = streams.get(taskId);
  if (existing) {
    // A retry must not keep an earlier attempt's pending approval alive.
    settlePendingApproval(existing, false);
    // Reuse the entry so watchers stay attached across a retry — a requeued
    // task must not append its new answer to the failed attempt's text.
    existing.text = "";
    existing.progress = progress;
    existing.status = "running";
    existing.error = null;
    existing.trace = emptyTrace();
    existing.pendingApproval = null;
    existing.createdAt = Date.now();
    existing.finishedAt = null;
    emit(existing, { type: "reset" });
  } else {
    streams.set(taskId, {
      taskId,
      text: "",
      progress,
      status: "running",
      error: null,
      trace: emptyTrace(),
      pendingApproval: null,
      createdAt: Date.now(),
      finishedAt: null,
      subscribers: new Set(),
    });
  }
  prune(streams);
}

/** Appends a streamed chunk. No-op once the task settled. */
export function appendLiveText(taskId: string, delta: string): void {
  const stream = registry().get(taskId);
  if (!stream || stream.status !== "running" || delta.length === 0) return;
  if (stream.text.length >= MAX_TEXT_CHARS) return;
  stream.text += delta;
  emit(stream, { type: "delta", text: delta });
}

/** Marks the agent's current round so viewers can show a live counter. */
export function setLiveRound(taskId: string, round: number): void {
  const stream = registry().get(taskId);
  if (!stream || stream.status !== "running") return;
  stream.trace.round = round;
  emit(stream, { type: "round", round });
}

/** Streams reasoning tokens into the trace. */
export function appendLiveThinking(taskId: string, delta: string): void {
  const stream = registry().get(taskId);
  if (!stream || stream.status !== "running" || delta.length === 0) return;
  if (stream.trace.thinking.length >= MAX_TEXT_CHARS) return;
  stream.trace.thinking += delta;
  emit(stream, { type: "thinking", text: delta });
}

/** Adds or replaces one tool card in the trace. */
export function upsertLiveTool(taskId: string, tool: ChatAgentToolTrace): void {
  const stream = registry().get(taskId);
  if (!stream || stream.status !== "running") return;
  const index = stream.trace.tools.findIndex((entry) => entry.id === tool.id);
  if (index === -1) stream.trace.tools.push(tool);
  else stream.trace.tools[index] = tool;
  emit(stream, { type: tool.status === "running" ? "tool_call" : "tool_result", tool });
}

/** Updates the phase label ("正在生成回复…") shown before any text arrives. */
export function setLiveStreamProgress(taskId: string, progress: string | null): void {
  const stream = registry().get(taskId);
  if (!stream || stream.status !== "running") return;
  stream.progress = progress;
  emit(stream, { type: "progress", progress });
}

/**
 * Blocks a write until the user approves or denies it. The returned promise is
 * the agent loop's gate for the first write of a turn; `resolveLiveWriteApproval`
 * (called by the approval API route) settles it. An abort resolves it `false`
 * so a Stop or the task deadline can never leave the loop hanging.
 */
export function requestLiveWriteApproval(
  taskId: string,
  request: WriteApprovalRequest,
  signal?: AbortSignal,
): Promise<boolean> {
  const streams = registry();
  let stream = streams.get(taskId);
  if (!stream) {
    // A trimmed buffer must never turn a pending write into an implicit yes.
    beginLiveStream(taskId);
    stream = streams.get(taskId);
  }
  if (!stream || stream.status !== "running") return Promise.resolve(false);
  const activeStream: LiveStream = stream;

  // A stale request is settled "no" rather than lingering forever.
  settlePendingApproval(activeStream, false);
  setLiveStreamProgress(taskId, "等待你确认是否允许写入 wiki…");

  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (approved: boolean): void => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(approved);
    };
    const onAbort = (): void => {
      if (done) return;
      if (activeStream.pendingApproval?.request.id === request.id) {
        activeStream.pendingApproval = null;
        emit(activeStream, { type: "approval_resolved", id: request.id, approved: false });
      }
      finish(false);
    };

    if (signal?.aborted) {
      finish(false);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    activeStream.pendingApproval = { request, resolve: finish };
    emit(activeStream, { type: "approval_request", request });
  });
}

/**
 * Answers a pending write request. Returns false when no request is waiting, so
 * the route can report a stale/late click instead of silently doing nothing.
 */
export function resolveLiveWriteApproval(taskId: string, approved: boolean): boolean {
  const stream = registry().get(taskId);
  const pending = stream?.pendingApproval;
  if (!stream || !pending) return false;
  stream.pendingApproval = null;
  emit(stream, { type: "approval_resolved", id: pending.request.id, approved });
  setLiveStreamProgress(
    taskId,
    approved ? "已允许写入，正在更新 wiki…" : "已拒绝写入，继续生成回答…",
  );
  pending.resolve(approved);
  return true;
}

/**
 * Marks the buffer terminal. Subscribers stay attached on purpose: a task that
 * fails and is requeued emits `reset` on its next attempt, and a viewer that is
 * already watching should follow it there rather than reconnect.
 */
export function finishLiveStream(
  taskId: string,
  status: "succeeded" | "failed" | "canceled",
  error: string | null = null,
): void {
  const stream = registry().get(taskId);
  if (!stream || stream.status !== "running") return;
  settlePendingApproval(stream, false);
  stream.status = status;
  stream.error = error;
  stream.finishedAt = Date.now();
  emit(stream, { type: "end", status, error });
  prune(registry());
}

function settlePendingApproval(stream: LiveStream, approved: boolean): void {
  const pending = stream.pendingApproval;
  if (!pending) return;
  stream.pendingApproval = null;
  emit(stream, { type: "approval_resolved", id: pending.request.id, approved });
  pending.resolve(approved);
}

/**
 * Reads the buffer. Null means "nothing live here" — either the task never
 * streamed (a non-chat task) or the process has moved on, in which case the
 * caller should fall back to the task row.
 */
export function readLiveStream(taskId: string): LiveStreamSnapshot | null {
  const stream = registry().get(taskId);
  if (!stream) return null;
  return snapshot(stream);
}

/**
 * Watches a task. Delivery starts with the caller's own snapshot read (see the
 * SSE route): subscribe first, then read, and because both happen in one
 * synchronous block no delta can slip between them and be lost.
 *
 * Subscribing to a task that has not been claimed by a lane yet is fine and
 * expected — the common case is "the user just hit send". It opens an empty
 * waiting buffer that the first delta fills in; if the task never runs, the
 * empty buffer is pruned once the subscription goes away.
 */
export function subscribeLiveStream(taskId: string, listener: LiveStreamListener): () => void {
  const streams = registry();
  const existing = streams.get(taskId);
  const stream: LiveStream =
    existing ??
    ({
      taskId,
      text: "",
      progress: null,
      status: "running",
      error: null,
      trace: emptyTrace(),
      pendingApproval: null,
      createdAt: Date.now(),
      finishedAt: null,
      subscribers: new Set(),
    } satisfies LiveStream);
  if (!existing) streams.set(taskId, stream);
  stream.subscribers.add(listener);
  return () => {
    const current = streams.get(taskId);
    if (!current) return;
    current.subscribers.delete(listener);
    if (
      current.status === "running" &&
      current.text.length === 0 &&
      current.trace.thinking.length === 0 &&
      current.trace.tools.length === 0 &&
      current.pendingApproval === null
    ) {
      // Waiting buffer nobody is waiting on any more.
      streams.delete(taskId);
    }
  };
}

function emptyTrace(): AgentTrace {
  return { thinking: "", tools: [] };
}

function snapshot(stream: LiveStream): LiveStreamSnapshot {
  return {
    taskId: stream.taskId,
    text: stream.text,
    progress: stream.progress,
    status: stream.status,
    error: stream.error,
    trace: {
      thinking: stream.trace.thinking,
      tools: stream.trace.tools.map((tool) => ({ ...tool })),
      ...(stream.trace.round !== undefined ? { round: stream.trace.round } : {}),
    },
    approval: stream.pendingApproval?.request ?? null,
    finished: stream.status !== "running",
  };
}

function emit(stream: LiveStream, event: LiveStreamEvent): void {
  for (const listener of stream.subscribers) {
    try {
      listener(event);
    } catch {
      // A dead connection must never take the generation down with it.
    }
  }
}

/** Drops terminal buffers past their TTL, then the oldest ones past the cap. */
function prune(streams: Map<string, LiveStream>): void {
  const now = Date.now();
  for (const [taskId, stream] of streams) {
    const age = now - (stream.finishedAt ?? stream.createdAt);
    // Unwatched buffers are only ever a viewer's waiting room or a finished
    // answer, so anything old and unwatched can go regardless of status.
    if (stream.subscribers.size === 0 && age > FINISHED_TTL_MS) {
      streams.delete(taskId);
    }
  }
  if (streams.size <= MAX_BUFFERS) return;
  const droppable = [...streams.values()]
    .filter((s) => s.subscribers.size === 0)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const stream of droppable) {
    if (streams.size <= MAX_BUFFERS) break;
    streams.delete(stream.taskId);
  }
}
