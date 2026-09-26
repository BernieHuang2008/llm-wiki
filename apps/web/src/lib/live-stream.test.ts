import { beforeEach, describe, expect, it } from "vitest";

import {
  appendLiveText,
  beginLiveStream,
  finishLiveStream,
  readLiveStream,
  resetLiveStreams,
  setLiveStreamProgress,
  subscribeLiveStream,
  type LiveStreamEvent,
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

  it("ignores text for a task that never opened a buffer", () => {
    appendLiveText("unknown", "nothing to attach to");
    expect(readLiveStream("unknown")).toBeNull();
  });
});
