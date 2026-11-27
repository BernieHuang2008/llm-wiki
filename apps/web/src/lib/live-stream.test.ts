import { beforeEach, describe, expect, it } from "vitest";

import {
  appendLiveText,
  appendLiveThinking,
  beginLiveStream,
  finishLiveStream,
  readLiveStream,
  requestLiveWriteApproval,
  resetLiveStreams,
  resolveLiveWriteApproval,
  setLiveStreamProgress,
  subscribeLiveStream,
  upsertLiveTool,
  type LiveStreamEvent,
  type WriteApprovalRequest,
} from "./live-stream";

/**
 * The registry is the seam between the executor (which streams) and the SSE
 * route (which forwards). These tests pin the two properties the UI depends on:
 * nothing a viewer needs is lost between subscribing and reading the snapshot,
 * and a retried task never appends its answer to the failed attempt's text.
 */
beforeEach(() => {
  resetLiveStreams();
});

describe("live stream buffer", () => {
  it("replays what happened before a viewer attached, then keeps delivering", () => {
    beginLiveStream("t1", "正在生成回复…");
    appendLiveText("t1", "Hello");

    const events: LiveStreamEvent[] = [];
    const unsubscribe = subscribeLiveStream("t1", (event) => events.push(event));

    // The route reads the snapshot in the same synchronous block as the
    // subscribe, so this is what a late viewer starts from.
    expect(readLiveStream("t1")?.text).toBe("Hello");

    appendLiveText("t1", ", wiki");
    unsubscribe();

    expect(events).toEqual([{ type: "delta", text: ", wiki" }]);
    expect(readLiveStream("t1")?.text).toBe("Hello, wiki");
  });

  it("forwards progress updates so watchers see phases without polling", () => {
    beginLiveStream("t2");
    const events: LiveStreamEvent[] = [];
    const unsubscribe = subscribeLiveStream("t2", (event) => events.push(event));

    setLiveStreamProgress("t2", "正在检索 wiki…");

    expect(events).toEqual([{ type: "progress", progress: "正在检索 wiki…" }]);
    expect(readLiveStream("t2")?.progress).toBe("正在检索 wiki…");
    unsubscribe();
  });

  it("resets the buffer on a retry and keeps the existing watcher attached", () => {
    beginLiveStream("t3");
    const events: LiveStreamEvent[] = [];
    const unsubscribe = subscribeLiveStream("t3", (event) => events.push(event));

    appendLiveText("t3", "stale partial");
    finishLiveStream("t3", "failed", "boom");
    beginLiveStream("t3", "正在生成回复…");
    appendLiveText("t3", "fresh");
    unsubscribe();

    expect(events).toEqual([
      { type: "delta", text: "stale partial" },
      { type: "end", status: "failed", error: "boom" },
      { type: "reset" },
      { type: "delta", text: "fresh" },
    ]);
    expect(readLiveStream("t3")?.text).toBe("fresh");
    expect(readLiveStream("t3")?.status).toBe("running");
  });

  it("keeps a finished answer readable for a viewer that arrives late", () => {
    beginLiveStream("t4");
    appendLiveText("t4", "done answer");
    finishLiveStream("t4", "succeeded");

    const snapshot = readLiveStream("t4");
    expect(snapshot?.finished).toBe(true);
    expect(snapshot?.status).toBe("succeeded");
    expect(snapshot?.text).toBe("done answer");

    // Subscribing after the fact is legal but silent: the route renders the
    // snapshot and closes instead of waiting for events that cannot come.
    const events: LiveStreamEvent[] = [];
    subscribeLiveStream("t4", (event) => events.push(event))();
    expect(events).toEqual([]);
  });

  it("accepts a viewer before the task is claimed, and cleans up after it", () => {
    const events: LiveStreamEvent[] = [];
    const unsubscribe = subscribeLiveStream("t5", (event) => events.push(event));
    expect(readLiveStream("t5")?.text).toBe("");

    beginLiveStream("t5", "开始");
    appendLiveText("t5", "late start");
    unsubscribe();

    expect(events).toEqual([{ type: "reset" }, { type: "delta", text: "late start" }]);

    // A waiting room nobody watches any more must not linger.
    const idle = subscribeLiveStream("t6", () => {});
    idle();
    expect(readLiveStream("t6")).toBeNull();
  });

  it("freezes a settled buffer so late writes cannot resurrect it", () => {
    beginLiveStream("t7");
    appendLiveText("t7", "answer");
    finishLiveStream("t7", "succeeded");

    appendLiveText("t7", " should be ignored");
    setLiveStreamProgress("t7", "nope");

    expect(readLiveStream("t7")?.text).toBe("answer");
    expect(readLiveStream("t7")?.progress).toBeNull();
  });

  it("streams thinking and tool calls and keeps them in the snapshot", () => {
    beginLiveStream("t8");
    const events: LiveStreamEvent[] = [];
    const unsubscribe = subscribeLiveStream("t8", (event) => events.push(event));

    appendLiveThinking("t8", "thinking about it");
    upsertLiveTool("t8", {
      id: "call_1",
      name: "raw_read",
      arguments: '{"source":"note.md"}',
      status: "running",
      summary: "执行中…",
      durationMs: null,
    });
    upsertLiveTool("t8", {
      id: "call_1",
      name: "raw_read",
      arguments: '{"source":"note.md"}',
      status: "ok",
      summary: "读取原始文件 note.md",
      durationMs: 12,
    });
    finishLiveStream("t8", "canceled", "用户已停止生成");
    unsubscribe();

    expect(events.map((e) => e.type)).toEqual(["thinking", "tool_call", "tool_result", "end"]);
    const snapshot = readLiveStream("t8");
    expect(snapshot?.status).toBe("canceled");
    expect(snapshot?.trace.thinking).toBe("thinking about it");
    expect(snapshot?.trace.tools[0]).toMatchObject({ name: "raw_read", status: "ok" });
  });

  it("ignores text for a task that never opened a buffer", () => {
    appendLiveText("unknown", "nothing to attach to");
    expect(readLiveStream("unknown")).toBeNull();
  });

  it("blocks a write until the user answers and records it in the snapshot", async () => {
    beginLiveStream("a1");
    const events: LiveStreamEvent[] = [];
    const unsubscribe = subscribeLiveStream("a1", (event) => events.push(event));
    const request: WriteApprovalRequest = {
      id: "call_1",
      toolName: "wiki_update_page",
      summary: "更新 wiki 页面 [[foo]]",
      arguments: '{"slug":"foo","content":"bar"}',
    };

    const decision = requestLiveWriteApproval("a1", request);
    expect(readLiveStream("a1")?.approval).toEqual(request);
    expect(events).toContainEqual({ type: "approval_request", request });

    expect(resolveLiveWriteApproval("a1", true)).toBe(true);
    await expect(decision).resolves.toBe(true);
    expect(readLiveStream("a1")?.approval).toBeNull();
    expect(events).toContainEqual({ type: "approval_resolved", id: "call_1", approved: true });

    // A second answer for the same request is stale, not a second approval.
    expect(resolveLiveWriteApproval("a1", true)).toBe(false);
    unsubscribe();
  });

  it("resolves a pending write as denied when the task is aborted", async () => {
    beginLiveStream("a2");
    const controller = new AbortController();
    const decision = requestLiveWriteApproval(
      "a2",
      { id: "call_2", toolName: "wiki_create_page", summary: "create", arguments: "{}" },
      controller.signal,
    );

    controller.abort();
    await expect(decision).resolves.toBe(false);
    expect(readLiveStream("a2")?.approval).toBeNull();
  });

  it("drops a pending write when the task retries", async () => {
    beginLiveStream("a3");
    const decision = requestLiveWriteApproval("a3", {
      id: "call_3",
      toolName: "wiki_create_page",
      summary: "create",
      arguments: "{}",
    });

    beginLiveStream("a3", "正在重试…");
    await expect(decision).resolves.toBe(false);
    expect(readLiveStream("a3")?.approval).toBeNull();
  });
});
