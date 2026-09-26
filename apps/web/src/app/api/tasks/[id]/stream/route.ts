import { NextResponse } from "next/server";

import { isActiveTaskStatus } from "@llm-wiki/core";

import { readLiveStream, subscribeLiveStream, type LiveStreamEvent } from "@/lib/live-stream";
import { getTaskForUi, type PublicTask } from "@/lib/task-service";
import { openWikiContextSync } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/tasks/[id]/stream — Server-Sent Events view of a running task.
 *
 * This is a *viewer*, never a participant: the work already lives in the
 * executor's queue (see `task-executor.ts`), so disconnecting, reloading, or
 * closing the browser changes nothing about whether the task finishes. Opening
 * the stream twice (two tabs, a reload) is fine and yields the same answer.
 *
 * Wire format:
 *   snapshot  { text, progress, status, finished }  — sent once on connect,
 *                                                     authoritative replay
 *   reset     {}                                    — a retry restarted the answer
 *   delta     { text }                              — newly generated chunk
 *   progress  { progress }                          — phase label changed
 *   retrying  { error }                             — attempt failed, task requeued
 *   done      { task }                              — terminal; stream closes
 */

/** Proxies and browsers drop idle connections; a comment frame keeps it warm. */
const PING_INTERVAL_MS = 15_000;

/**
 * How often to re-read the task row while waiting for the first token. Only
 * used when there is no live text yet, so a normal generation never pays for it.
 */
const ROW_POLL_INTERVAL_MS = 3_000;

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const taskId = params.id;

  // Resolve the task before opening a stream so an unknown id is a normal 404
  // instead of an event stream that closes immediately.
  const initial = await readTaskRow(taskId);
  if (!initial) {
    return NextResponse.json({ error: `任务不存在：${taskId}` }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: () => void = () => {};
  let ping: ReturnType<typeof setInterval> | null = null;
  let rowWatch: ReturnType<typeof setInterval> | null = null;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The consumer vanished between the check and the write.
          close();
        }
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        if (ping) clearInterval(ping);
        if (rowWatch) clearInterval(rowWatch);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed/cancelled.
        }
      };

      /**
       * The live buffer lives in this process, so an empty one cannot say
       * whether the model is still thinking or the worker that owned the task
       * died with the previous process. While nothing has been streamed, the
       * task row is the only honest answer — without this a viewer whose task
       * was orphaned would spin forever instead of being told it ended.
       */
      const watchRowUntilFirstToken = (): void => {
        if (rowWatch) return;
        rowWatch = setInterval(() => {
          void (async () => {
            if (closed) return;
            const row = await readTaskRow(taskId);
            if (closed) return;
            if (!row) {
              send("done", { task: null });
              close();
              return;
            }
            send("progress", { progress: row.progress });
            if (!isActiveTaskStatus(row.status)) {
              send("done", { task: row });
              close();
            }
          })().catch(() => close());
        }, ROW_POLL_INTERVAL_MS);
      };

      const stopRowWatch = (): void => {
        if (!rowWatch) return;
        clearInterval(rowWatch);
        rowWatch = null;
      };

      const watchBuffer = (task: PublicTask): void => {
        // Subscribe BEFORE reading the snapshot. Both run synchronously here,
        // so no delta can land in between and be dropped on the floor.
        unsubscribe = subscribeLiveStream(taskId, (event) => {
          // The registry emits synchronously, so the async tail (which needs a
          // DB read) is detached; failing to read it only ends this viewer.
          void onBufferEvent(event).catch(() => close());
        });
        const snap = readLiveStream(taskId);
        send(
          "snapshot",
          snap ?? {
            taskId,
            text: assistantTextOf(task),
            progress: task.progress,
            status: isActiveTaskStatus(task.status) ? "running" : "failed",
            error: task.error,
            finished: !isActiveTaskStatus(task.status),
          },
        );
        if (!isActiveTaskStatus(task.status)) {
          send("done", { task });
          close();
          return;
        }
        if (!snap || snap.text.length === 0) watchRowUntilFirstToken();
      };

      const onBufferEvent = async (event: LiveStreamEvent): Promise<void> => {
        if (closed) return;
        if (event.type === "delta") {
          // Tokens are flowing: the worker is alive, so the row no longer
          // needs to be polled as a liveness signal.
          stopRowWatch();
          send("delta", { text: event.text });
          return;
        }
        if (event.type === "progress") {
          send("progress", { progress: event.progress });
          return;
        }
        if (event.type === "reset") {
          send("reset", {});
          return;
        }
        // "end" is ambiguous on its own: the attempt finished, but the task may
        // have been requeued for another try. Only the task row knows.
        const row = await readTaskRow(taskId);
        if (!row) {
          send("done", { task: null });
          close();
          return;
        }
        if (isActiveTaskStatus(row.status)) {
          send("retrying", { error: event.error });
          watchRowUntilFirstToken();
          return; // stay attached for the next attempt's `reset`
        }
        send("done", { task: row });
        close();
      };

      // Client hang-ups (navigation, reload, tab close) must release the
      // subscription; the task itself is untouched either way.
      req.signal.addEventListener("abort", close, { once: true });

      watchBuffer(initial);
      if (!closed) {
        ping = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            close();
          }
        }, PING_INTERVAL_MS);
      }
    },
    cancel() {
      closed = true;
      unsubscribe();
      if (ping) clearInterval(ping);
      if (rowWatch) clearInterval(rowWatch);
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // `no-transform` matters: a compressing proxy would buffer the whole
      // answer and defeat the point of streaming.
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/**
 * Task rows live only in SQLite, so none of the disk→DB sync a full request
 * context performs is needed here — and this route re-reads the row while it
 * waits for the first token, which must stay cheap.
 */
async function readTaskRow(taskId: string): Promise<PublicTask | null> {
  const ctx = openWikiContextSync();
  try {
    return getTaskForUi(ctx.db, taskId);
  } finally {
    ctx.db.close();
  }
}

/**
 * Fallback text for a viewer that attached after the fact (a stream buffer
 * only lives in memory). Chat tasks keep the finished reply in their output,
 * so a late viewer still renders the answer instead of an empty message.
 */
function assistantTextOf(task: PublicTask): string {
  const output = task.output as { assistant?: { content?: unknown } } | null;
  const content = output?.assistant?.content;
  return typeof content === "string" ? content : "";
}
