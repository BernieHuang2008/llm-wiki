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

export type LiveStreamStatus = "running" | "succeeded" | "failed";

export type LiveStreamSnapshot = {
  taskId: string;
  text: string;
  progress: string | null;
  status: LiveStreamStatus;
  error: string | null;
  /** True once no further delta can arrive for this task. */
  finished: boolean;
};

export type LiveStreamEvent =
  /** A new attempt replaced the buffer (task retry) — drop what you rendered. */
  | { type: "reset" }
  | { type: "delta"; text: string }
  | { type: "progress"; progress: string | null }
  | { type: "end"; status: "succeeded" | "failed"; error: string | null };

export type LiveStreamListener = (event: LiveStreamEvent) => void;

type LiveStream = {
  taskId: string;
  text: string;
  progress: string | null;
  status: LiveStreamStatus;
  error: string | null;
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
    // Reuse the entry so watchers stay attached across a retry — a requeued
    // task must not append its new answer to the failed attempt's text.
    existing.text = "";
    existing.progress = progress;
    existing.status = "running";
    existing.error = null;
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

/** Updates the phase label ("正在生成回复…") shown before any text arrives. */
export function setLiveStreamProgress(taskId: string, progress: string | null): void {
  const stream = registry().get(taskId);
  if (!stream || stream.status !== "running") return;
  stream.progress = progress;
  emit(stream, { type: "progress", progress });
}

/**
 * Marks the buffer terminal. Subscribers stay attached on purpose: a task that
 * fails and is requeued emits `reset` on its next attempt, and a viewer that is
 * already watching should follow it there rather than reconnect.
 */
export function finishLiveStream(
  taskId: string,
  status: "succeeded" | "failed",
  error: string | null = null,
): void {
  const stream = registry().get(taskId);
  if (!stream || stream.status !== "running") return;
  stream.status = status;
  stream.error = error;
  stream.finishedAt = Date.now();
  emit(stream, { type: "end", status, error });
  prune(registry());
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
    if (current.status === "running" && current.text.length === 0) {
      // Waiting buffer nobody is waiting on any more.
      streams.delete(taskId);
    }
  };
}

function snapshot(stream: LiveStream): LiveStreamSnapshot {
  return {
    taskId: stream.taskId,
    text: stream.text,
    progress: stream.progress,
    status: stream.status,
    error: stream.error,
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
